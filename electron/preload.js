const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFile: (options) => ipcRenderer.invoke('select-file', options),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  getClipboardImage: () => ipcRenderer.invoke('get-clipboard-image'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openYuketangWindow: (url) => ipcRenderer.invoke('open-yuketang-window', url),
  onScreenshotSlide: (callback) => ipcRenderer.on('screenshot-slide', () => callback()),
  onBrowserStatus: (callback) => ipcRenderer.on('browser-status', (_e, data) => callback(data)),
  startYuketang: (url) => ipcRenderer.invoke('start-yuketang', url),
  stopYuketang: () => ipcRenderer.invoke('stop-yuketang'),
  navigateYuketang: (url) => ipcRenderer.invoke('navigate-yuketang', url),
  reloginYuketang: () => ipcRenderer.invoke('relogin-yuketang'),
  manualScan: () => ipcRenderer.invoke('manual-scan-yuketang'),
  setViewBounds: (bounds) => ipcRenderer.invoke('set-view-bounds', bounds),
  showYuketangView: () => ipcRenderer.invoke('show-yuketang-view'),
  hideYuketangView: () => ipcRenderer.invoke('hide-yuketang-view'),
  getYuketangUrl: () => ipcRenderer.invoke('get-yuketang-url'),
  captureYuketangScreenshot: () => ipcRenderer.invoke('capture-yuketang-screenshot'),
  isElectron: true
});
