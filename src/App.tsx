import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import Scene from "./viewer/Scene";
import { parseDots, type Drill } from "./lib/dots";
import logoUrl from "./assets/March3D-clear.png";
import * as THREE from "three";

function audioMime(path: string) {
  const ext = path.toLowerCase().split(".").pop();
  return ({ mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac", flac: "audio/flac" } as Record<string, string>)[ext ?? ""] ?? "audio/mpeg";
}


function formatClock(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  return `${Math.floor(safe / 60)}:${String(Math.floor(safe % 60)).padStart(2, "0")}`;
}

function countAtExactBeatTime(
  drill: Drill,
  startBeatIndex: number,
  total: number,
  elapsedInMove: number,
) {
  if (total <= 0) return 0;
  if (elapsedInMove <= 0) return 1;

  let elapsed = 0;
  for (let i = 0; i < total; i++) {
    const beat = drill.beats[startBeatIndex + i];
    const duration = Math.max(0, Number(beat?.duration) || 0);
    elapsed += duration;
    // The next written count begins exactly at the next beat boundary.
    if (elapsedInMove < elapsed - 1e-6) return i + 1;
  }
  return total;
}

function PlaybackBanner({
  drill,
  pageTimes,
  playheadRef,
  duration,
}: {
  drill: Drill;
  pageTimes: number[];
  playheadRef: MutableRefObject<number>;
  duration: number;
}) {
  const setRef = useRef<HTMLSpanElement | null>(null);
  const countRef = useRef<HTMLSpanElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let frame = 0;
    let previousSet = "";
    let previousCount = "";
    let previousTime = "";

    const renderBanner = () => {
      const last = drill.pages.length - 1;
      if (last < 1 || pageTimes.length < 2) {
        frame = requestAnimationFrame(renderBanner);
        return;
      }

      const time = THREE.MathUtils.clamp(playheadRef.current, 0, Math.max(duration, 0));

      // Determine the active transition directly from the render-clock ref.
      // Do not use React's sidebar pageIndex here: that state is deliberately
      // throttled for large-band performance and made the count banner pause,
      // then jump two counts at once at faster tempos.
      let interval = 0;
      for (let i = 1; i < pageTimes.length; i++) {
        if (time >= pageTimes[i] - 1e-6) interval = i;
        else break;
      }
      interval = Math.min(interval, last - 1);

      const isFinalInterval = interval === last - 1 && drill.lastPageCounts > 0;
      let fromIndex = interval;
      let toIndex = Math.min(interval + 1, last);
      let total = 0;
      let startBeatIndex = drill.pages[toIndex]?.startBeatIndex ?? 0;

      if (isFinalInterval) {
        // OpenMarch's final-page count span is "Last Set -> End".
        fromIndex = last;
        toIndex = last;
        total = Math.max(1, drill.lastPageCounts);
        startBeatIndex = drill.pages[last]?.startBeatIndex ?? 0;
      } else {
        const nextBoundary = drill.pages[toIndex + 1]?.startBeatIndex;
        total = nextBoundary != null
          ? Math.max(1, nextBoundary - startBeatIndex)
          : Math.max(1, startBeatIndex - (drill.pages[toIndex - 1]?.startBeatIndex ?? 0));
      }

      const moveStartTime = pageTimes[interval] ?? 0;
      const elapsedInMove = Math.max(0, time - moveStartTime);
      const count = countAtExactBeatTime(drill, startBeatIndex, total, elapsedInMove);

      const fromLabel = drill.pages[fromIndex]?.displayNumber ?? fromIndex;
      const toLabel = isFinalInterval
        ? "End"
        : String(drill.pages[toIndex]?.displayNumber ?? toIndex);
      const setText = `Set ${fromLabel} → ${toLabel}`;
      const countText = `Count ${String(count).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;
      const timeText = `${formatClock(time)} / ${formatClock(duration)}`;

      // Touch the DOM only when visible text actually changes. This keeps the
      // banner sample-accurate to the render clock without causing React/Canvas
      // reconciliation every animation frame.
      if (setText !== previousSet && setRef.current) {
        setRef.current.textContent = setText;
        previousSet = setText;
      }
      if (countText !== previousCount && countRef.current) {
        countRef.current.textContent = countText;
        previousCount = countText;
      }
      if (timeText !== previousTime && timeRef.current) {
        timeRef.current.textContent = timeText;
        previousTime = timeText;
      }

      frame = requestAnimationFrame(renderBanner);
    };

    frame = requestAnimationFrame(renderBanner);
    return () => cancelAnimationFrame(frame);
  }, [drill, pageTimes, playheadRef, duration]);

  return <div className="playback-banner">
    <span ref={setRef} />
    <span ref={countRef} />
    <span ref={timeRef} />
  </div>;
}

export default function App() {
  const [drill, setDrill] = useState<Drill | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [labels, setLabels] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [error, setError] = useState("");
  const [syncConnected, setSyncConnected] = useState(false);
  const [externalAudio, setExternalAudio] = useState<{ name: string; url: string } | null>(null);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const syncConnectedRef = useRef(false);
  const playingRef = useRef(false);
  const playheadRef = useRef(0);
  const syncAnchorRef = useRef({ position: 0, receivedAt: performance.now() });
  const standaloneAnchorRef = useRef({ position: 0, startedAt: performance.now() });
  const standaloneAudioStartedRef = useRef(false);
  const pendingDotsRef = useRef<{ path: string; changedAt: number } | null>(null);
  const refreshingDotsRef = useRef(false);
  const autoOpeningPathRef = useRef<string | null>(null);
  // playheadRef is the *visual* timeline used by the 3D scene.  We keep it
  // continuous and gently steer it toward the authoritative audio/OpenMarch
  // clock instead of replacing it every time a clock sample arrives.  That
  // removes the tiny corrections that showed up as occasional marcher jumps.
  const clockFrameRef = useRef(performance.now());

  // OpenMarch's page start beat marks the beginning of the move INTO that
  // page/set, not the instant its dots should already be fully reached.
  // Therefore Set 0 is anchored at t=0, and Set N (N > 0) is reached at the
  // following page boundary. This is especially important for files that use
  // OpenMarch's zero-duration sentinel beat: without this offset, Set 0 and
  // Set 1 both land at t=0 and playback appears to start on Set 1.
  const pageTimes = useMemo(() => {
    if (!drill || drill.pages.length === 0 || drill.beats.length === 0) return [];

    const beatStartTimes = new Array(drill.beats.length).fill(0);
    let elapsed = 0;
    for (let i = 0; i < drill.beats.length; i++) {
      beatStartTimes[i] = elapsed;
      elapsed += Math.max(0, Number(drill.beats[i]?.duration) || 0);
    }

    const movementStarts = drill.pages.map((page) => {
      const index = page.startBeatIndex;
      return index >= 0 && index < beatStartTimes.length ? beatStartTimes[index] : 0;
    });

    if (movementStarts.length === 1) return [0];

    const arrivals = new Array(movementStarts.length).fill(0);
    arrivals[0] = 0;

    // The move from Set i-1 to Set i occupies the interval that starts on
    // page i and ends when page i+1 begins.
    for (let i = 1; i < movementStarts.length - 1; i++) {
      arrivals[i] = Math.max(arrivals[i - 1], movementStarts[i + 1]);
    }

    // The final written page has no following page boundary, so OpenMarch
    // stores its count length separately in utility.last_page_counts. Use those
    // exact written counts and the real per-beat durations (including tempo
    // changes) for the move into the last set. Falling back to the previous
    // interval is only for older files that do not have last_page_counts.
    const last = movementStarts.length - 1;
    const previousStart = movementStarts[last - 1] ?? 0;
    const lastStart = movementStarts[last] ?? previousStart;
    const lastBeatIndex = drill.pages[last]?.startBeatIndex ?? -1;

    let finalMoveDuration = 0;
    if (drill.lastPageCounts > 0 && lastBeatIndex >= 0) {
      const endBeatIndex = Math.min(drill.beats.length, lastBeatIndex + drill.lastPageCounts);
      for (let i = lastBeatIndex; i < endBeatIndex; i++) {
        finalMoveDuration += Math.max(0, Number(drill.beats[i]?.duration) || 0);
      }
    }

    if (finalMoveDuration <= 0) {
      finalMoveDuration = Math.max(0, lastStart - previousStart);
      if (last >= 2 && finalMoveDuration <= 0) {
        finalMoveDuration = Math.max(0, previousStart - (movementStarts[last - 2] ?? 0));
      }
    }

    arrivals[last] = Math.max(arrivals[last - 1], lastStart + finalMoveDuration);

    return arrivals;
  }, [drill]);



  const page = drill?.pages[Math.min(pageIndex, (drill?.pages.length ?? 1) - 1)];
  const sections = useMemo(() => drill ? [...new Set(drill.marchers.map((m) => m.section))] : [], [drill]);
  const embeddedAudioUrl = useMemo(() => {
    if (!drill?.audio?.data) return null;
    const blob = new Blob([drill.audio.data.buffer.slice(drill.audio.data.byteOffset, drill.audio.data.byteOffset + drill.audio.data.byteLength) as ArrayBuffer], { type: audioMime(drill.audio.path) });
    return URL.createObjectURL(blob);
  }, [drill]);
  const audioUrl = externalAudio?.url ?? embeddedAudioUrl;
  const pageIndexForTime = useCallback((time: number) => {
    if (!pageTimes.length) return 0;
    let index = 0;
    for (let i = 1; i < pageTimes.length; i++) {
      if (time >= pageTimes[i]) index = i;
      else break;
    }
    return index;
  }, [pageTimes]);

  useEffect(() => () => {
    if (embeddedAudioUrl) URL.revokeObjectURL(embeddedAudioUrl);
    if (externalAudio?.url) URL.revokeObjectURL(externalAudio.url);
  }, [embeddedAudioUrl, externalAudio]);

  const loadBuffer = useCallback(async (buffer: ArrayBuffer | Uint8Array, sourceName: string, path?: string, preservePosition = false, includeAudioData = true, reuseExistingAudio = !includeAudioData) => {
    setError("");
    const preservedTime = playheadRef.current;
    try {
      const parsed = await parseDots(buffer instanceof Uint8Array ? (buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer) : buffer, sourceName, includeAudioData);
      setDrill((current) => includeAudioData || parsed.audio || !reuseExistingAudio
        ? parsed
        : { ...parsed, audio: current?.audio ?? null });
      // Hundreds of DOM-backed labels can overwhelm Chromium before the 3D
      // renderer even starts. Keep labels automatic for normal ensembles and
      // start large files in the fast instanced-rendering path.
      setLabels(parsed.marchers.length <= 180);
      if (preservePosition) {
        playheadRef.current = preservedTime;
        setPlayhead(preservedTime);
      } else {
        setPageIndex(0);
        playheadRef.current = 0;
        setPlayhead(0);
        playingRef.current = false;
        setPlaying(false);
        standaloneAnchorRef.current = { position: 0, startedAt: performance.now() };
        standaloneAudioStartedRef.current = false;
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.currentTime = Math.max(0, -(parsed.audioOffsetSeconds || 0));
        }
        setLoadVersion((v) => v + 1);
      }
      setSourcePath(path ?? null);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : "Could not read .dots file.");
    }
  }, []);

  async function openFile(file?: File) {
    if (!file) return;
    await loadBuffer(await file.arrayBuffer(), file.name);
  }

  async function openDots() {
    if (window.march3d?.isElectron) {
      // While OpenMarch is synced, "Open .dots" means "open the drill OM
      // currently has open". Never show the operating-system file picker in
      // this mode; OM is the authoritative project selection.
      const result = syncConnectedRef.current
        ? await window.march3d.openSyncedDotsFile()
        : await window.march3d.openDotsFile();

      if (!result) {
        if (syncConnectedRef.current) {
          setError("OpenMarch is synced, but it has not reported an open .dots file yet. Switch/open a drill in OpenMarch and try again.");
        }
        return;
      }

      const bytes = await window.march3d.readFile(result.path);
      setExternalAudio((current) => {
        if (current?.url) URL.revokeObjectURL(current.url);
        return null;
      });
      await loadBuffer(bytes, result.name, result.path);
      await window.march3d.watchFile(result.path);
      return;
    }
    document.getElementById("dots-input")?.click();
  }

  async function chooseAudio() {
    if (window.march3d?.isElectron) {
      const result = await window.march3d.openAudioFile();
      if (!result) return;
      const bytes = result.data;
      const url = URL.createObjectURL(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: audioMime(result.path) }));
      setExternalAudio({ name: result.name, url });
      return;
    }
    document.getElementById("audio-input")?.click();
  }

  async function togglePlayback(force?: boolean) {
    if (syncConnected) return;
    const next = force ?? !playingRef.current;
    const audio = audioRef.current;

    if (!next) {
      playingRef.current = false;
      setPlaying(false);
      standaloneAnchorRef.current = { position: playheadRef.current, startedAt: performance.now() };
      standaloneAudioStartedRef.current = false;
      audio?.pause();
      return;
    }

    if (duration > 0 && playheadRef.current >= duration - 0.001) {
      playheadRef.current = 0;
      setPlayhead(0);
      setPageIndex(pageIndexForTime(0));
    }

    standaloneAnchorRef.current = { position: playheadRef.current, startedAt: performance.now() };
    playingRef.current = true;
    setPlaying(true);

    if (!audio || !audioUrl) return;
    const sourceTime = playheadRef.current - (drill?.audioOffsetSeconds ?? 0);
    if (sourceTime >= 0) {
      audio.currentTime = sourceTime;
      standaloneAudioStartedRef.current = true;
      try {
        await audio.play();
      } catch (e) {
        playingRef.current = false;
        setPlaying(false);
        standaloneAudioStartedRef.current = false;
        setError(`Audio could not start: ${e instanceof Error ? e.message : "browser blocked playback"}`);
      }
    } else {
      // Positive OpenMarch offsets pad the audio with silence. The render clock
      // starts immediately and the real audio begins when the padded time ends.
      audio.pause();
      audio.currentTime = 0;
      standaloneAudioStartedRef.current = false;
    }
  }

  function seekToPage(index: number) {
    const safe = Math.max(0, Math.min(index, (drill?.pages.length ?? 1) - 1));
    setPageIndex(safe);
    const time = pageTimes[safe] ?? 0;
    playheadRef.current = time;
    setPlayhead(time);
    standaloneAnchorRef.current = { position: time, startedAt: performance.now() };
    if (audioRef.current && !syncConnectedRef.current) {
      audioRef.current.currentTime = Math.max(0, time - (drill?.audioOffsetSeconds ?? 0));
    }
  }

  // OpenMarch can touch a .dots SQLite database many times during a single UI
  // operation. Only queue a lightweight path notification here. The file is
  // read once after it has been quiet for a while, and never while OM playback
  // is running. This prevents large embedded-audio databases from flooding IPC.
  useEffect(() => {
    if (!window.march3d) return;
    return window.march3d.onDotsChanged(({ path }) => {
      if (!sourcePath || path !== sourcePath) return;
      pendingDotsRef.current = { path, changedAt: performance.now() };
    });
  }, [sourcePath]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const pending = pendingDotsRef.current;
      if (!pending || playingRef.current || refreshingDotsRef.current) return;
      // Wait until OpenMarch has stopped writing for two seconds. A slider drag
      // or multi-step edit may generate dozens of SQLite writes.
      if (performance.now() - pending.changedAt < 2000) return;

      pendingDotsRef.current = null;
      refreshingDotsRef.current = true;
      void (async () => {
        try {
          const bytes = await window.march3d!.readFile(pending.path);
          // Keep the already-loaded audio blob. Re-reading an 18+ MB embedded
          // track just to update dots/sets is unnecessary and caused long stalls.
          await loadBuffer(bytes, pending.path.split(/[\\/]/).pop() ?? "OpenMarch drill", pending.path, true, false, true);
        } finally {
          refreshingDotsRef.current = false;
        }
      })();
    }, 250);
    return () => window.clearInterval(timer);
  }, [loadBuffer]);

  useEffect(() => {
    if (!window.march3d) return;
    return window.march3d.onOpenMarchSync((message) => {
      if (message.type === "drill-file") {
        const path = message.path;
        if (!path || path === sourcePath || autoOpeningPathRef.current === path) return;
        autoOpeningPathRef.current = path;
        void (async () => {
          try {
            // Let the current frame paint before starting a show switch. More
            // importantly, OpenMarch owns audio while synced, so do not pull a
            // 10-50 MB embedded audio blob through sql.js just to render drill.
            // This makes switching OM files much less likely to hitch/freeze.
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const bytes = await window.march3d!.readFile(path);
            setExternalAudio((current) => {
              if (current?.url) URL.revokeObjectURL(current.url);
              return null;
            });
            await loadBuffer(bytes, message.name || path.split(/[\\/]/).pop() || "OpenMarch drill", path, false, false, false);
            await window.march3d!.watchFile(path);
          } catch (e) {
            console.error("Could not auto-open OpenMarch drill", e);
            setError(`OpenMarch is synced, but March3D could not open its drill: ${e instanceof Error ? e.message : "unknown error"}`);
          } finally {
            autoOpeningPathRef.current = null;
          }
        })();
        return;
      }

      if (message.type === "connection") {
        syncConnectedRef.current = message.connected;
        setSyncConnected(message.connected);
        if (message.connected) {
          // OpenMarch is the sole audio player while connected. Connecting must
          // not rebuild/reset the 3D scene; wait for OM's first transport
          // position instead. This keeps large-band connection effectively free.
          audioRef.current?.pause();
          playingRef.current = false;
          setPlaying(false);
          syncAnchorRef.current = { position: playheadRef.current, receivedAt: performance.now() };
        }
        return;
      }

      if (message.type === "position") {
        const time = Number(message.position);
        if (!Number.isFinite(time)) return;
        // The sync plugin sends OpenMarch's LIVE DRILL PLAYBACK POSITION,
        // not raw audio-file time. OpenMarch has already accounted for the
        // workspace audio offset before this value reaches us. Applying
        // audioOffsetSeconds again made negative-offset shows (for example
        // -6.5 s) render that many seconds BEHIND OpenMarch.
        const safeTime = Math.max(0, time);
        // Never let the local audio element drive the synced timeline.
        // OpenMarch's Web Audio clock is authoritative.
        if (syncConnectedRef.current) {
          // Do not seek the paused HTMLAudioElement for every OpenMarch clock
          // packet. currentTime writes are expensive media seeks and were a
          // major source of renderer stalls on large drills.
          const receivedAt = performance.now();
          syncAnchorRef.current = { position: safeTime, receivedAt };

          // While OpenMarch is playing, do not hard-snap the 3D playhead to
          // every incoming packet. The render clock below slews toward this
          // new authoritative position over a few frames. When paused, a
          // position packet represents a seek/scrub and should be immediate.
          if (!playingRef.current) {
            // Store the seek in refs only. The RAF loop below owns React UI
            // updates, avoiding bursts of App/Canvas reconciliation while OM
            // scrubs or changes pages.
            playheadRef.current = safeTime;
          }
        }
        return;
      }

      if (message.type === "playback") {
        // No local audio playback in connected mode. The OpenMarch audio is
        // already the audible source; the plugin's position messages drive
        // the 3D timeline.
        playingRef.current = !!message.playing;
        setPlaying(!!message.playing);
        if (!message.playing) {
          syncAnchorRef.current = { position: playheadRef.current, receivedAt: performance.now() };
          return;
        }
        syncAnchorRef.current = { position: playheadRef.current, receivedAt: performance.now() };
        return;
      }

    });
  }, [pageIndexForTime, drill?.audioOffsetSeconds, sourcePath, loadBuffer]);

  const duration = pageTimes.length ? Math.max(pageTimes[pageTimes.length - 1], 0) : 0;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onEnded = () => {
      // The drill timeline, not the raw audio-file length, decides where the
      // animation ends. If the audio ends first, continue the drill silently.
      standaloneAudioStartedRef.current = false;
      if (!syncConnectedRef.current && duration > 0 && playheadRef.current >= duration - 0.02) {
        playingRef.current = false;
        setPlaying(false);
        playheadRef.current = duration;
        setPlayhead(duration);
        setPageIndex(Math.max(0, (drill?.pages.length ?? 1) - 1));
      }
    };

    audio.addEventListener("ended", onEnded);
    return () => audio.removeEventListener("ended", onEnded);
  }, [audioUrl, drill?.pages.length, duration]);

  // Render-time transport clock. The 3D scene follows a continuous visual
  // clock rather than directly copying audio.currentTime or each OpenMarch
  // packet. Audio/OpenMarch remains authoritative, but small timing errors are
  // corrected gradually (clock slewing). Large errors still snap immediately
  // because those are real seeks, stops, or transport discontinuities.
  useEffect(() => {
    let frame = 0;
    let lastUiUpdate = 0;
    clockFrameRef.current = performance.now();

    const tick = (now: number) => {
      const rawDt = Math.max(0, (now - clockFrameRef.current) / 1000);
      clockFrameRef.current = now;
      // Do not let a temporarily blocked renderer create a huge animation leap
      // on the first frame after it recovers.
      const dt = Math.min(rawDt, 0.1);

      let visualTime = playheadRef.current;
      let desiredTime = visualTime;
      let advancing = false;

      if (syncConnectedRef.current) {
        const anchor = syncAnchorRef.current;
        desiredTime = anchor.position;
        if (playingRef.current) {
          desiredTime += Math.max(0, now - anchor.receivedAt) / 1000;
          advancing = true;
        }
      } else if (playingRef.current) {
        const anchor = standaloneAnchorRef.current;
        desiredTime = anchor.position + Math.max(0, now - anchor.startedAt) / 1000;
        advancing = true;

        const audio = audioRef.current;
        if (audio && audioUrl && !standaloneAudioStartedRef.current) {
          const sourceTime = desiredTime - (drill?.audioOffsetSeconds ?? 0);
          if (sourceTime >= 0) {
            standaloneAudioStartedRef.current = true;
            audio.currentTime = sourceTime;
            void audio.play().catch(() => { standaloneAudioStartedRef.current = false; });
          }
        }
      }

      if (advancing) {
        // Advance locally at normal speed every render frame. Then gently
        // correct drift toward the source clock. This avoids visible 20-50 ms
        // corrections while still keeping audio/drill synchronization tight.
        let predicted = visualTime + dt;
        const error = desiredTime - predicted;

        // A difference this large is almost certainly a real seek, a resumed
        // suspended tab, or a transport discontinuity rather than normal jitter.
        if (Math.abs(error) > 0.35) {
          predicted = desiredTime;
        } else {
          // Exponential smoothing is frame-rate independent. About 95% of a
          // small error is removed in roughly half a second without a jump.
          const correction = 1 - Math.exp(-6 * dt);
          predicted += error * correction;
        }
        visualTime = predicted;
      } else {
        // When stopped/paused, follow explicit seeks exactly.
        visualTime = desiredTime;
      }

      if (duration > 0) visualTime = THREE.MathUtils.clamp(visualTime, 0, duration);
      else visualTime = Math.max(0, visualTime);

      if (!syncConnectedRef.current && playingRef.current && duration > 0 && visualTime >= duration - 0.0005) {
        visualTime = duration;
        playingRef.current = false;
        standaloneAudioStartedRef.current = false;
        standaloneAnchorRef.current = { position: duration, startedAt: now };
        audioRef.current?.pause();
        setPlaying(false);
      }
      playheadRef.current = visualTime;

      // Keep React/UI work out of the 3D render path. Large or OM-synced drills
      // only need a 5 Hz sidebar refresh; the marcher animation still reads the
      // ref every display frame and stays smooth.
      const uiInterval = syncConnectedRef.current || (drill?.marchers.length ?? 0) > 160 ? 200 : 100;
      if (now - lastUiUpdate >= uiInterval) {
        lastUiUpdate = now;
        setPlayhead((current) => Math.abs(current - visualTime) < 0.015 ? current : visualTime);
        const nextPageIndex = pageIndexForTime(visualTime);
        setPageIndex((current) => current === nextPageIndex ? current : nextPageIndex);
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration, pageIndexForTime, audioUrl, drill?.audioOffsetSeconds, drill?.marchers.length]);



  return <div className="app">
    <header>
      <div className="brand"><img src={logoUrl} alt="March3D" className="brand-logo" /><div><strong>March3D</strong><span className="subtitle">OpenMarch 3D Viewer · v0.3.32</span></div></div>
      <button className="button" onClick={openDots}>Open .dots</button>
      <input id="dots-input" type="file" accept=".dots,.sqlite" hidden onChange={e => openFile(e.target.files?.[0])} />
      <button className="button secondary" onClick={chooseAudio}>Audio</button>
      <input id="audio-input" type="file" accept="audio/*" hidden onChange={e => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (externalAudio?.url) URL.revokeObjectURL(externalAudio.url);
        setExternalAudio({ name: file.name, url: URL.createObjectURL(file) });
      }} />
      <button className="play-button" disabled={!audioUrl || syncConnected} onClick={() => void togglePlayback()}>{syncConnected ? "OM Sync" : (playing ? "Pause" : "Play")}</button>
      {drill && <div className="source">{drill.sourceName}</div>}
    </header>
    <main>
      <section className="viewer">
        {drill && drill.pages.length >= 2 && <PlaybackBanner drill={drill} pageTimes={pageTimes} playheadRef={playheadRef} duration={duration} />}
        {drill && page ? <Scene key={drill.sourceName} drill={drill} labels={labels} pageTimes={pageTimes} playheadRef={playheadRef} resetToken={`${sourcePath ?? drill.sourceName}:${loadVersion}`} /> :
          <div className="empty"><h1>Open an OpenMarch drill</h1><p>Choose a <b>.dots</b> file to load its field, marchers, sections, sets, and embedded audio.</p><button className="button" onClick={openDots}>Choose .dots</button></div>}
      </section>
      <aside>
        <h2>Drill</h2>
        {drill ? <>
          <div className="stat"><span>Field</span><b>{drill.field.name}</b></div>
          <div className="stat"><span>Marchers</span><b>{drill.marchers.length}</b></div>
          <div className="stat"><span>Sets</span><b>{drill.pages.length}</b></div>
          <div className="stat"><span>Sections</span><b>{sections.length}</b></div>
          <div className="sync-status"><span className={syncConnected ? "dot online" : "dot"}></span>{syncConnected ? "OpenMarch connected" : "Standalone mode"}</div>
          <hr/>
          <label className="check"><input type="checkbox" checked={labels} onChange={e => setLabels(e.target.checked)} /> Labels</label>
          <h3>Playback</h3>
          <div className="play-row"><button onClick={() => seekToPage(pageIndex - 1)} disabled={pageIndex === 0}>◀</button><button className="big-play" disabled={!audioUrl || syncConnected} onClick={() => void togglePlayback()}>{syncConnected ? "OM" : (playing ? "❚❚" : "▶")}</button><button onClick={() => seekToPage(pageIndex + 1)} disabled={pageIndex === drill.pages.length - 1}>▶</button></div>
          <input className="range" type="range" min="0" max={Math.max(0, duration)} step="0.01" value={Math.min(playhead, duration || 0)} onChange={e => { const time = +e.target.value; playheadRef.current = time; syncAnchorRef.current = { position: time, receivedAt: performance.now() }; setPlayhead(time); setPageIndex(pageIndexForTime(time)); standaloneAnchorRef.current = { position: time, startedAt: performance.now() }; if (audioRef.current && !syncConnected) audioRef.current.currentTime = Math.max(0, time - (drill?.audioOffsetSeconds ?? 0)); }} />
          <div className="time"><span>Set {drill.pages[pageIndex]?.displayNumber ?? pageIndex}</span><span>{Math.floor(playhead / 60)}:{String(Math.floor(playhead % 60)).padStart(2, "0")}</span></div>
          <h3>Set {drill.pages[pageIndex]?.displayNumber ?? pageIndex}</h3>
          <input className="range" type="range" min="0" max={Math.max(0, drill.pages.length - 1)} value={pageIndex} onChange={e => seekToPage(+e.target.value)} />
          <div className="setnav"><button disabled={pageIndex === 0} onClick={() => seekToPage(pageIndex - 1)}>Previous</button><button disabled={pageIndex === drill.pages.length - 1} onClick={() => seekToPage(pageIndex + 1)}>Next</button></div>
          <p className="hint">Mouse: orbit · Wheel: zoom · Right mouse: pan</p>
          <div className="audio-info"><b>Audio</b><span>{externalAudio?.name ?? drill.audio?.nickname ?? drill.audio?.path?.split(/[\\/]/).pop() ?? "No audio loaded"}</span></div>
          <h3>Sections</h3>
          <div className="sections">{sections.map(s => <span key={s}>{s}</span>)}</div>
        </> : <p className="hint">No drill loaded.</p>}
        {error && <div className="error">{error}</div>}
      </aside>
    </main>
    {audioUrl && <audio ref={audioRef} src={audioUrl} preload="auto" />}
  </div>;
}
