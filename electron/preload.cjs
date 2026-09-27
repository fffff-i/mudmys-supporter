const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('makua', {
  getInfo: () => ipcRenderer.invoke('app:get-info'),
  showDataFolder: () => ipcRenderer.invoke('app:show-data-folder'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (value) => ipcRenderer.invoke('settings:save', value),
  testAi: (value) => ipcRenderer.invoke('settings:test-ai', value),
  startCodexLogin: (path) => ipcRenderer.invoke('settings:codex-login-start', { path }),
  cancelCodexLogin: () => ipcRenderer.invoke('settings:codex-login-cancel'),
  chooseCodexCli: () => ipcRenderer.invoke('settings:choose-codex-cli'),
  listScenarios: () => ipcRenderer.invoke('scenario:list'),
  getScenario: (id) => ipcRenderer.invoke('scenario:get', id),
  createScenario: (title) => ipcRenderer.invoke('scenario:create', title),
  createDemo: () => ipcRenderer.invoke('scenario:create-demo'),
  saveProfile: (value) => ipcRenderer.invoke('scenario:save-profile', value),
  deleteScenario: (id) => ipcRenderer.invoke('scenario:delete', id),
  exportScenario: (id) => ipcRenderer.invoke('scenario:export', id),
  addText: (value) => ipcRenderer.invoke('scenario:add-text', value),
  addFiles: (id) => ipcRenderer.invoke('scenario:add-files', id),
  addPastedImage: (value) => ipcRenderer.invoke('scenario:add-pasted-image', value),
  setVisibility: (value) => ipcRenderer.invoke('scenario:set-visibility', value),
  previewImage: (value) => ipcRenderer.invoke('scenario:preview-image', value),
  completeAction: (value) => ipcRenderer.invoke('scenario:complete-action', value),
  discardAction: (value) => ipcRenderer.invoke('scenario:discard-action', value),
  restoreAction: (value) => ipcRenderer.invoke('scenario:restore-action', value),
  analyze: (value) => ipcRenderer.invoke('scenario:analyze', value),
  cancelAnalysis: (value) => ipcRenderer.invoke('scenario:cancel-analysis', value)
});
