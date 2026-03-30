import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('electronAPI', {
    // AI
    chat: (messages) => ipcRenderer.invoke('ai:chat', messages),
    // Projects
    listProjects: () => ipcRenderer.invoke('projects:list'),
    getProject: (projectId) => ipcRenderer.invoke('projects:get', projectId),
    getFileTree: (projectId) => ipcRenderer.invoke('projects:getFileTree', projectId),
    readFile: (projectId, filePath) => ipcRenderer.invoke('projects:readFile', projectId, filePath),
    // Runtime
    startProject: (projectId) => ipcRenderer.invoke('runtime:start', projectId),
    stopProject: (projectId) => ipcRenderer.invoke('runtime:stop', projectId),
    getProjectStatus: (projectId) => ipcRenderer.invoke('runtime:status', projectId),
    // Data
    queryData: (projectId, sql) => ipcRenderer.invoke('data:query', projectId, sql),
    getDataSummary: (projectId) => ipcRenderer.invoke('data:summary', projectId),
    // Settings
    getAISettings: () => ipcRenderer.invoke('settings:getAI'),
    saveAISettings: (config) => ipcRenderer.invoke('settings:saveAI', config)
});
