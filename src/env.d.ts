/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

interface StreamEvent {
  type: 'token' | 'thinking' | 'tool_start' | 'tool_end' | 'progress' | 'file_preview_start' | 'file_preview_chunk' | 'file_preview_end' | 'reset' | 'done' | 'error' | 'stopped'
  content?: string
  name?: string
  message?: { role: string; content: MessageContent }
  thinking?: string
  error?: string
  stage?: string
  detail?: string
  filePath?: string
  truncated?: boolean
}

interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  authMode?: AIExecutionAuthMode
  providerId?: string
  selectedModel?: string
  targetProjectId?: string
}

interface ToolProgressEntry {
  stage: string
  detail?: string
}

interface ToolRun {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
  progress: ToolProgressEntry[]
}

type ChatMessageBlock =
  | { id: string; kind: 'content'; content: MessageContent }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tool'; toolRun: ToolRun }
  | { id: string; kind: 'file_preview'; filePath: string; previewContent: string; truncated: boolean; active: boolean }
  | { id: string; kind: 'attachment'; fileName: string; fileType: string; fileSizeLabel: string; previewText: string }
  | { id: string; kind: 'auth_request'; requestId: string; title: string; detail: string; status: 'pending' | 'approved' | 'denied' }

interface ConversationData extends ConversationSummary {
  messages: Array<{
    role: string
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
    thinking?: string
    modelLabel?: string
    toolRuns?: ToolRun[]
    blocks?: ChatMessageBlock[]
  }>
}

interface AIProviderConfig {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: string[]
  modelContextWindows?: Record<string, number>
  activeModel: string
  enableThinking?: boolean
}

interface AIProvidersConfig {
  providers: AIProviderConfig[]
  activeProviderId: string
  enabledProviderIds: string[]
}

interface LaunchpadFolderLayout {
  id: string
  name: string
  projectIds: string[]
}

interface LaunchpadLayout {
  folders: LaunchpadFolderLayout[]
  topLevelOrder: string[]
}

interface WebAppShortcut {
  id: string
  kind: 'web'
  type: 'browser'
  name: string
  url: string
  icon?: string
  createdAt: string
  updatedAt: string
}

type ThemePreference = 'system' | 'light' | 'dark'
type AIExecutionAuthMode = 'strict' | 'auto'

interface AIExecutionPreferences {
  notifyOnTaskComplete: boolean
}

interface ServiceEntry {
  projectId: string
  name: string
  port: number
  status: string
  pid?: number
  startedAt?: string
  framework?: string
  restartPolicy: 'always' | 'on-failure' | 'never'
  restartCount: number
}

interface SystemStatusSnapshot {
  fetchedAt: string
  refreshIntervalMs: number
  cacheAgeMs: number
  host: {
    platform: string
    release: string
    arch: string
    uptimeSeconds: number
    nodeVersion: string
    electronVersion: string | null
  }
  summary: {
    status: 'ok' | 'busy' | 'degraded'
    hostUptimeSeconds: number
    runningProjectCount: number
    trackedProjectProcessCount: number
    totalServiceCount: number
    crashedServiceCount: number
    cpuUsagePercent: number | null
    memoryUsagePercent: number
  }
  cpu: {
    model: string
    cores: number
    architecture: string
    loadAverage: number[]
    usagePercent: number | null
    sampleWindowMs: number | null
  }
  memory: {
    totalBytes: number
    freeBytes: number
    usedBytes: number
    usagePercent: number
    processRssBytes: number
    processHeapUsedBytes: number
    processHeapTotalBytes: number
    processExternalBytes: number
  }
  currentProcess: {
    pid: number
    uptimeSeconds: number
    platform: string
    arch: string
    memory: {
      rssBytes: number
      heapUsedBytes: number
      heapTotalBytes: number
      externalBytes: number
    }
  }
  projectProcesses: Array<{
    projectId: string
    status: string
    port?: number
    pid?: number
    startedAt?: string
    uptimeSeconds?: number
    exitCode?: number | null
    error?: string
  }>
  services: {
    services: ServiceEntry[]
    totalRunning: number
    totalStopped: number
    totalCrashed: number
  }
}

interface ProjectLanUrlInfo {
  projectPort: number | null
  lanUrl: string | null
  proxyUrl: string
  localProxyUrl: string
  lanIp: string
}

type MessageContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>

interface SkillInfo {
  id: string
  name: string
  description: string
  content: string
  createdAt: string
  updatedAt: string
}

interface ElectronAPI {
  // AI
  chat: (messages: Array<{ role: string; content: MessageContent }>) => Promise<{ role: string; content: MessageContent }>
  chatStream: (messages: Array<{ role: string; content: MessageContent }>, sessionId: string, providerId?: string, modelId?: string, targetProjectId?: string, authMode?: AIExecutionAuthMode) => Promise<{ ok: boolean }>
  stopChatStream: (sessionId: string) => Promise<{ ok: boolean; stopped: boolean }>
  onStreamEvent: (sessionId: string, callback: (event: StreamEvent) => void) => () => void

  // Conversations
  listConversations: () => Promise<ConversationSummary[]>
  getConversation: (id: string) => Promise<ConversationData | null>
  saveConversation: (conversation: ConversationData) => Promise<{ success: boolean }>
  deleteConversation: (id: string) => Promise<boolean>
  saveImageToFile: (imageUrl: string, defaultName?: string) => Promise<{ success?: boolean; canceled?: boolean; filePath?: string }>
  readUploadedOfficeFile: (filePath: string) => Promise<{ filePath: string; fileName: string; size: number; fileType: string; content: string }>

  // Projects
  listProjects: () => Promise<Array<Record<string, unknown>>>
  getProject: (projectId: string) => Promise<Record<string, unknown>>
  getFileTree: (projectId: string) => Promise<Array<Record<string, unknown>>>
  readFile: (projectId: string, filePath: string) => Promise<string>
  writeFile: (projectId: string, filePath: string, content: string) => Promise<{ success: boolean }>
  updateProjectAppearance: (projectId: string, updates: { name?: string; icon?: string }) => Promise<Record<string, unknown>>
  openProjectFolder: (projectId: string) => Promise<{ success: boolean }>
  deleteProject: (projectId: string) => Promise<{ success: boolean }>
  onProjectChanged: (callback: (event: { action: string; projectId: string; port?: number }) => void) => () => void

  // Runtime
  startProject: (projectId: string) => Promise<Record<string, unknown>>
  stopProject: (projectId: string) => Promise<Record<string, unknown>>
  getProjectStatus: (projectId: string) => Promise<Record<string, unknown>>
  openProjectWindow: (projectId: string) => Promise<{ success: boolean; reused?: boolean; error?: string }>
  getOpenWindows: () => Promise<string[]>
  focusProjectWindow: (projectId: string) => Promise<{ success: boolean }>
  onProjectWindowClosed: (callback: (event: { projectId: string }) => void) => () => void
  getSystemStatus: () => Promise<SystemStatusSnapshot>

  // LAN
  getLanInfo: () => Promise<{ port: number; addresses: string[]; baseUrl: string }>
  getProjectLanUrl: (projectId: string) => Promise<ProjectLanUrlInfo>

  // Data
  queryData: (projectId: string, sql: string) => Promise<Record<string, unknown>>
  getDataSummary: (projectId: string) => Promise<Record<string, unknown>>
  listAllDatabases: () => Promise<Array<Record<string, unknown>>>
  queryTable: (projectId: string, tableName: string, page: number, pageSize: number) => Promise<{ rows: Record<string, unknown>[]; total: number }>
  getTableSchema: (projectId: string) => Promise<unknown[] | null>

  // Settings
  getAISettings: () => Promise<{ apiKey: string; baseUrl: string; model: string }>
  saveAISettings: (config: { apiKey: string; baseUrl: string; model: string }) => Promise<{ success: boolean }>
  getProviders: () => Promise<AIProvidersConfig>
  saveProviders: (config: AIProvidersConfig) => Promise<{ success: boolean }>
  onProvidersChanged: (callback: (config: AIProvidersConfig) => void) => () => void
  getThemePreference: () => Promise<ThemePreference>
  saveThemePreference: (preference: ThemePreference) => Promise<{ success: boolean }>
  getAIExecutionPreferences: () => Promise<AIExecutionPreferences>
  saveAIExecutionPreferences: (preferences: AIExecutionPreferences) => Promise<{ success: boolean }>
  getLaunchMode: (projectId: string) => Promise<'embed' | 'window'>
  saveLaunchMode: (projectId: string, mode: 'embed' | 'window') => Promise<{ success: boolean }>
  getLaunchpadLayout: () => Promise<LaunchpadLayout>
  saveLaunchpadLayout: (layout: LaunchpadLayout) => Promise<{ success: boolean }>
  getWebApps: () => Promise<WebAppShortcut[]>
  saveWebApps: (webApps: WebAppShortcut[]) => Promise<{ success: boolean }>

  // Skills
  listSkills: () => Promise<SkillInfo[]>
  importSkills: () => Promise<Array<{ id: string; name: string; description: string }>>
  importSkillContent: (name: string, content: string, description?: string) => Promise<{ id: string; name: string }>
  deleteSkill: (id: string) => Promise<boolean>
  setActiveSkills: (skillIds: string[]) => Promise<{ success: boolean; count: number }>
  onSkillsChanged: (callback: (event: { action: string; count?: number; id?: string }) => void) => () => void

  // Window controls
  minimizeWindow: () => Promise<void>
  maximizeWindow: () => Promise<void>
  closeWindow: () => Promise<void>
  isMaximized: () => Promise<boolean>

  // Auth (in-app authorization dialogs)
  onAuthRequest: (callback: (request: { requestId: string; title: string; detail: string }) => void) => () => void
  onAuthResolved: (callback: (payload: { requestId: string; approved: boolean }) => void) => () => void
  respondAuth: (requestId: string, approved: boolean) => void
}

interface Window {
  electronAPI?: ElectronAPI
}
