/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

interface StreamEvent {
  type: 'token' | 'thinking' | 'tool_start' | 'tool_end' | 'done' | 'error'
  content?: string
  name?: string
  result?: unknown
  message?: { role: string; content: string }
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

interface ConversationData extends ConversationSummary {
  messages: Array<{ role: string; content: string }>
}

interface AIProviderConfig {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: string[]
  activeModel: string
  enableThinking?: boolean
}

interface AIProvidersConfig {
  providers: AIProviderConfig[]
  activeProviderId: string
}

interface ElectronAPI {
  // AI
  chat: (messages: Array<{ role: string; content: string }>) => Promise<{ role: string; content: string }>
  chatStream: (messages: Array<{ role: string; content: string }>) => Promise<{ ok: boolean }>
  onStreamEvent: (callback: (event: StreamEvent) => void) => () => void

  // Conversations
  listConversations: () => Promise<ConversationSummary[]>
  getConversation: (id: string) => Promise<ConversationData | null>
  saveConversation: (conversation: ConversationData) => Promise<{ success: boolean }>
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
  getAISettings: () => Promise<{ apiKey: string; baseUrl: string; model: string }>
  saveAISettings: (config: { apiKey: string; baseUrl: string; model: string }) => Promise<{ success: boolean }>
  getProviders: () => Promise<AIProvidersConfig>
  saveProviders: (config: AIProvidersConfig) => Promise<{ success: boolean }>
}

interface Window {
  electronAPI?: ElectronAPI
}
