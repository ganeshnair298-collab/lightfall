
const {
  contextBridge,
  ipcRenderer
} = require("electron");

contextBridge.exposeInMainWorld("lightfall", {
  onDesktopFrame(callback) {
    const listener = (_, frame) => callback(frame);

    ipcRenderer.on("desktop:frame", listener);

    return () => {
      ipcRenderer.removeListener("desktop:frame", listener);
    };
  },
  onBatteryStatus(callback) {
    const listener = (_, status) => callback(status);

    ipcRenderer.on("battery:status", listener);

    return () => {
      ipcRenderer.removeListener("battery:status", listener);
    };
  },
  onChargerConnected(callback) {
    const listener = () => callback();

    ipcRenderer.on("battery:charger-connected", listener);

    return () => {
      ipcRenderer.removeListener("battery:charger-connected", listener);
    };
  },
  onChargerDisconnected(callback) {
    const listener = () => callback();

    ipcRenderer.on("battery:charger-disconnected", listener);

    return () => {
      ipcRenderer.removeListener("battery:charger-disconnected", listener);
    };
  },
  requestBatteryStatus() {
    ipcRenderer.send("battery:refresh");
  },
  setIslandInputRegion(region) {
    ipcRenderer.send("island:set-input-region", region);
  },
  chooseMusicFiles() {
    return ipcRenderer.invoke("music:choose-files");
  }
});
