const { contextBridge, ipcRenderer } = require("electron");

const desktopApi = Object.freeze({
  openDiagram: () => ipcRenderer.invoke("atri:diagram:open"),
  restoreActiveDiagram: () => ipcRenderer.invoke("atri:diagram:restore"),
  saveActiveDiagram: (input = {}) => ipcRenderer.invoke("atri:diagram:save", {
    xml: String(input.xml || ""),
  }),
  clearActiveDiagram: () => ipcRenderer.invoke("atri:diagram:clear"),
  loadModelSettings: () => ipcRenderer.invoke("atri:settings:load"),
  saveModelSettings: (input = {}) => ipcRenderer.invoke("atri:settings:save", {
    endpoint: String(input.endpoint || ""),
    model: String(input.model || ""),
    apiKey: String(input.apiKey || ""),
    temperature: Number(input.temperature),
  }),
  getUpdateState: () => ipcRenderer.invoke("atri:update:get-state"),
  checkForUpdates: () => ipcRenderer.invoke("atri:update:check"),
  openUpdateDownloads: () => ipcRenderer.invoke("atri:update:open-downloads"),
  onUpdateState: (callback) => {
    if (typeof callback !== "function") {
      return;
    }

    ipcRenderer.on("atri:update:state", (_event, state) => callback(state));
  },
});

contextBridge.exposeInMainWorld("atriDesktop", desktopApi);
