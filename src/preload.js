
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
  onMediaActivity(callback) {
    const listener = (_, activity) => callback(activity);

    ipcRenderer.on("media:activity", listener);

    return () => {
      ipcRenderer.removeListener("media:activity", listener);
    };
  },
  onSystemMetrics(callback) {
    const listener = (_, metrics) => callback(metrics);

    ipcRenderer.on("system:metrics", listener);

    return () => {
      ipcRenderer.removeListener("system:metrics", listener);
    };
  },
  onSystemTemperatures(callback) {
    const listener = (_, temperatures) => callback(temperatures);

    ipcRenderer.on("system:temperatures", listener);

    return () => {
      ipcRenderer.removeListener("system:temperatures", listener);
    };
  },
  onGlassShaderEnabled(callback) {
    const listener = (_, enabled) => callback(enabled === true);

    ipcRenderer.on("glass-shader:set-enabled", listener);

    return () => {
      ipcRenderer.removeListener("glass-shader:set-enabled", listener);
    };
  },
  onLightfallStarted(callback) {
    const listener = () => callback();

    ipcRenderer.on("lightfall:started", listener);

    return () => {
      ipcRenderer.removeListener("lightfall:started", listener);
    };
  },
  setSystemMonitorActive(active) {
    ipcRenderer.send("system-monitor:set-active", active === true);
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
