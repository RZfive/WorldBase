import { contextBridge, ipcRenderer } from 'electron'

interface ChatMessage {
  role: string
  content: string
}

interface AISettings {
  apiKey: string
  baseUrl: string
  model: string
}

interface StreamEvent {
  type: 'token' | 'thinking' | 'tool_start' | 'tool_end' | 'done' | 'error'
  content?: string
  name?: string
  result?: unknown
  message?: ChatMessage
  thinking?: string
  error?: string
}

interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  providerId?: string
}

interface Conversation extends ConversationSummary {
  messages: ChatMessage[]
}

interface AIProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: string[]
  activeModel: string
  enableThinking?: boolean
}

interface AIProvidersConfig {
  providers: AIProvider[]
  activeProviderId: string
}

/**
 * API shape exposed to the renderer via contextBridge.
 * Must stay in sync with the ElectronAPI declaration in src/env.d.ts.
 */
export interface ElectronAPI {
  // AI
  chat: (messages: ChatMessage[]) => Promise<ChatMessage>
  chatStream: (messages: ChatMessage[]) => Promise<{ ok: boolean }>
  onStreamEvent: (callback: (event: StreamEvent) => void) => () => void

  // Conversations
  listConversations: () => Promise<ConversationSummary[]>
  getConversation: (id: string) => Promise<Conversation | null>
  saveConversation: (conversation: Conversation) => Promise<{ success: boolean }>
  deleteConversation: (id: string) => Promise<boolean>

  // Projects
  listProjects: () => Promise<Array<Record<string, unknown>>>
  getProject: (projectId: string) => Promise<Record<string, unknown>>
  getFileTree: (projectId: string) => Promise<Array<Record<string, unknown>>>
  readFile: (projectId: string, filePath: string) => Promise<string>

  // Runtime
  startProject: (projectId: string) => Promise<Record<string, unknown>>
  stopProject: (projectId: string) => Promise<Record<string, unknown>>
  getProjectStatus: (projectId: string) => Promise<Record<string, unknown>>

  // Data
  queryData: (projectId: string, sql: string) => Promise<Record<string, unknown>>
  getDataSummary: (projectId: string) => Promise<Record<string, unknown>>

  // Settings
  getAISettings: () => Promise<AISettings>
  saveAISettings: (config: AISettings) => Promise<{ success: boolean }>
  getProviders: () => Promise<AIProvidersConfig>
  saveProviders: (config: AIProvidersConfig) => Promise<{ success: boolean }>
}

contextBridge.exposeInMainWorld('electronAPI', {
  // AI
  chat: (messages: ChatMessage[]) => ipcRenderer.invoke('ai:chat', messages),
  chatStream: (messages: ChatMessage[]) => ipcRenderer.invoke('ai:chatStream', messages),
  onStreamEvent: (callback: (event: StreamEvent) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: StreamEvent) => callback(event)
    ipcRenderer.on('ai:stream-event', handler)
    // Return cleanup function
    return () => { ipcRenderer.removeListener('ai:stream-event', handler) }
  },

  // Conversations
  listConversations: () => ipcRenderer.invoke('conversations:list'),
  getConversation: (id: string) => ipcRenderer.invoke('conversations:get', id),
  saveConversation: (conversation: Conversation) => ipcRenderer.invoke('conversations:save', conversation),
  deleteConversation: (id: string) => ipcRenderer.invoke('conversations:delete', id),

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
  saveAISettings: (config: AISettings) => ipcRenderer.invoke('settings:saveAI', config),
  getProviders: () => ipcRenderer.invoke('settings:getProviders'),
  saveProviders: (config: AIProvidersConfig) => ipcRenderer.invoke('settings:saveProviders', config)
} satisfies ElectronAPI)
