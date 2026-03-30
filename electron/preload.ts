import { contextBridge, ipcRenderer } from 'electron'

interface ChatMessage {
  role: string
  content: string
}

interface AISettings {
  apiKey?: string
  baseUrl?: string
  model?: string
}

export interface ElectronAPI {
  // AI
  chat: (messages: ChatMessage[]) => Promise<ChatMessage>

  // Projects
  listProjects: () => Promise<unknown[]>
  getProject: (projectId: string) => Promise<unknown>
  getFileTree: (projectId: string) => Promise<unknown[]>
  readFile: (projectId: string, filePath: string) => Promise<string>

  // Runtime
  startProject: (projectId: string) => Promise<unknown>
  stopProject: (projectId: string) => Promise<unknown>
  getProjectStatus: (projectId: string) => Promise<unknown>

  // Data
  queryData: (projectId: string, sql: string) => Promise<unknown[]>
  getDataSummary: (projectId: string) => Promise<unknown>

  // Settings
  getAISettings: () => Promise<AISettings>
  saveAISettings: (config: AISettings) => Promise<{ success: boolean }>
}

contextBridge.exposeInMainWorld('electronAPI', {
  // AI
  chat: (messages: ChatMessage[]) => ipcRenderer.invoke('ai:chat', messages),

  // Projects
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getProject: (projectId: string) => ipcRenderer.invoke('projects:get', projectId),
  getFileTree: (projectId: string) => ipcRenderer.invoke('projects:getFileTree', projectId),
  readFile: (projectId: string, filePath: string) => ipcRenderer.invoke('projects:readFile', projectId, filePath),

  // Runtime
  startProject: (projectId: string) => ipcRenderer.invoke('runtime:start', projectId),
  stopProject: (projectId: string) => ipcRenderer.invoke('runtime:stop', projectId),
  getProjectStatus: (projectId: string) => ipcRenderer.invoke('runtime:status', projectId),

  // Data
  queryData: (projectId: string, sql: string) => ipcRenderer.invoke('data:query', projectId, sql),
  getDataSummary: (projectId: string) => ipcRenderer.invoke('data:summary', projectId),

  // Settings
  getAISettings: () => ipcRenderer.invoke('settings:getAI'),
  saveAISettings: (config: AISettings) => ipcRenderer.invoke('settings:saveAI', config)
} satisfies ElectronAPI)
