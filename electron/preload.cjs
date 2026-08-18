const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("march3d", {
  isElectron: true,
  openDotsFile: () => ipcRenderer.invoke("dots:open"),
  openSyncedDotsFile: () => ipcRenderer.invoke("dots:open-synced"),
  readFile: (filePath) => ipcRenderer.invoke("file:read", filePath),
  watchFile: (filePath) => ipcRenderer.invoke("dots:watch", filePath),
  stopWatching: () => ipcRenderer.invoke("dots:stop-watch"),
  onDotsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("dots-file-changed", listener);
    return () => ipcRenderer.removeListener("dots-file-changed", listener);
  },
  openAudioFile: () => ipcRenderer.invoke("audio:open"),
  onOpenMarchSync: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("openmarch-sync", listener);
    return () => ipcRenderer.removeListener("openmarch-sync", listener);
  },
});
