// Name: March3D Sync
// Description: Syncs OpenMarch playback to the local March3D viewer.
// Version: 0.3.32
// Author: March3D
//
// OpenMarch's AudioPlayer starts both its music and metronome AudioBufferSourceNodes
// at the same AudioContext time and offset. We treat the first source as the
// transport clock and reconstruct OpenMarch's own live playback position from
// that Web Audio clock. This avoids using elapsed wall-clock time, which can drift
// or run ahead during scheduled starts.

async function March3DSync() {
  let socket = null;
  let reconnectTimer = null;
  let playing = false;
  let patched = false;
  let positionTimer = null;
  let playback = null;
  let primarySource = null;
  const sourceContexts = new WeakMap();
  let lastDrillCandidate = null;

  function extractDotsStrings(value) {
    if (typeof value !== "string") return [];
    const out = [];
    const windows = value.match(/[A-Za-z]:[\\/][^"'<>|\r\n]*?\.dots/gi) || [];
    const unix = value.match(/\/(?:[^"'<>|\r\n/]+\/)*[^"'<>|\r\n/]+\.dots/gi) || [];
    const names = value.match(/[^"'<>|\r\n\/\\]+\.dots/gi) || [];
    for (const item of [...windows, ...unix, ...names]) {
      const clean = item.trim();
      if (clean && !out.includes(clean)) out.push(clean);
    }
    return out;
  }

  function discoverActiveDrillCandidate() {
    const candidates = [];
    const add = (value, weight = 0) => {
      for (const path of extractDotsStrings(value)) {
        candidates.push({ path, weight: weight + (/[A-Za-z]:[\\/]|^\//.test(path) ? 100 : 0) });
      }
    };

    add(document.title || "", 40);
    add(location.href || "", 10);

    // OpenMarch 0.1.x renders the current project path in its top toolbar, but
    // that path is not necessarily copied into document.title/localStorage.
    // Walk text nodes only (not innerHTML/React state) so we can pick up that
    // visible `C:\\...\\show.dots` label without serializing the drill UI.
    // The walk is capped to keep this cheap even for very large bands.
    try {
      const root = document.body;
      if (root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        let visited = 0;
        while ((node = walker.nextNode()) && visited++ < 2500) {
          const text = node.nodeValue?.trim();
          if (!text || !/\.dots/i.test(text)) continue;
          // Visible toolbar text is stronger evidence than recent-file storage.
          add(text, 90);
        }
      }
    } catch {}

    for (const storage of [window.localStorage, window.sessionStorage]) {
      try {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (!key) continue;
          const value = storage.getItem(key);
          const keyBonus = /file|path|database|recent|workspace|show|project/i.test(key) ? 35 : 0;
          add(value || "", keyBonus);
        }
      } catch {}
    }

    // Local/session storage is enough to catch OpenMarch recent/current-file state
    // without walking large application stores every polling interval.


    candidates.sort((a, b) => b.weight - a.weight || b.path.length - a.path.length);
    return candidates[0]?.path || null;
  }

  function sendActiveDrill(force = false) {
    const candidate = discoverActiveDrillCandidate();
    if (!candidate) return;
    if (!force && candidate === lastDrillCandidate) return;
    lastDrillCandidate = candidate;
    send({ type: "drill-file", path: candidate, name: candidate.split(/[\\/]/).pop() });
  }

  function connect() {
    try {
      socket = new WebSocket("ws://127.0.0.1:27831");
      socket.onopen = () => {
        // Electron already emits the connection state when the WebSocket
        // handshake completes; avoid a duplicate renderer reset here.
        send({ type: "playback", playing });
        sendActiveDrill(true);
        if (playing && playback) sendPosition();
      };
      socket.onclose = () => {
        socket = null;
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 1000);
      };
      socket.onerror = () => {};
    } catch {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 1000);
    }
  }

  function send(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  // This mirrors OpenMarch's getLivePlaybackPosition():
  // startTimestamp + pageDuration + (currentTime - playStartTime)
  // + PLAYBACK_DELAY + 0.01.
  // The AudioBufferSourceNode's offset is startTimestamp + pageDuration.
  function currentPosition() {
    if (!playback) return 0;
    const elapsed = Math.max(0, playback.context.currentTime - playback.startAt);
    return playback.offset + elapsed + 0.11;
  }

  function sendPosition() {
    if (!playback) return;
    // This is OpenMarch's own live drill/playback position. March3D must use
    // it directly and must NOT apply workspace audioOffsetSeconds a second time.
    send({ type: "position", position: currentPosition() });
  }

  function startPositionTimer() {
    if (positionTimer) return;
    // March3D extrapolates smoothly between clock samples, so 10 Hz is plenty
    // for sync accuracy; 8 Hz keeps OpenMarch overhead negligible on large shows.
    positionTimer = setInterval(sendPosition, 125);
  }

  function stopPositionTimer() {
    if (!positionTimer) return;
    clearInterval(positionTimer);
    positionTimer = null;
  }

  function setPlaying(next) {
    if (playing === next) return;
    playing = next;
    send({ type: "playback", playing });
    if (!next) {
      sendPosition();
      playback = null;
      primarySource = null;
      stopPositionTimer();
    }
  }

  function sourceStarted(source, when, offset) {
    // OpenMarch creates music first and metronome second. Both have the same
    // transport start time/offset, so only the first source should establish
    // the clock. Ignoring later sources prevents duplicate clocks and jumps.
    if (primarySource) return;

    const context = sourceContexts.get(source);
    if (!context) return;

    const startAt = Number.isFinite(when) && when > context.currentTime
      ? when
      : context.currentTime;
    const startOffset = Number.isFinite(offset) ? Math.max(0, offset) : 0;

    primarySource = source;
    playback = { context, startAt, offset: startOffset };
    send({ type: "position", position: startOffset });
    setPlaying(true);
    startPositionTimer();
  }

  function sourceStopped(source) {
    if (source !== primarySource) return;
    primarySource = null;
    setPlaying(false);
  }

  function patchWebAudio() {
    if (patched) return true;
    if (!window.AudioContext || !window.AudioBufferSourceNode) return false;

    const originalCreateBufferSource = AudioContext.prototype.createBufferSource;
    const originalStart = AudioBufferSourceNode.prototype.start;
    const originalStop = AudioBufferSourceNode.prototype.stop;

    AudioContext.prototype.createBufferSource = function (...args) {
      const source = originalCreateBufferSource.apply(this, args);
      sourceContexts.set(source, this);
      source.addEventListener("ended", () => sourceStopped(source), { once: true });
      return source;
    };

    AudioBufferSourceNode.prototype.start = function (...args) {
      const when = args[0] === undefined ? 0 : Number(args[0]);
      const offset = args[1] === undefined ? 0 : Number(args[1]);
      const result = originalStart.apply(this, args);
      sourceStarted(this, when, offset);
      return result;
    };

    AudioBufferSourceNode.prototype.stop = function (...args) {
      sourceStopped(this);
      return originalStop.apply(this, args);
    };

    patched = true;
    console.log("March3D Sync: exact OpenMarch Web Audio clock installed");
    return true;
  }

  if (!patchWebAudio()) {
    const timer = setInterval(() => {
      if (patchWebAudio()) clearInterval(timer);
    }, 250);
    setTimeout(() => clearInterval(timer), 10000);
  }

  // File changes are rare. A 2.5 second probe still notices show switches quickly
  // while reducing DOM scanning work in very large OpenMarch projects.
  const drillFileTimer = setInterval(() => sendActiveDrill(false), 2500);
  window.addEventListener("beforeunload", () => clearInterval(drillFileTimer), { once: true });

  connect();
}

March3DSync();
