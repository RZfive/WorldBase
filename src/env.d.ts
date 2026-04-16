/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

interface StreamEvent {
  type: 'token' | 'thinking' | 'tool_start' | 'tool_end' | 'progress' | 'file_preview_start' | 'file_preview_chunk' | 'file_preview_end' | 'web_search_result' | 'web_fetch_result' | 'reset' | 'done' | 'error' | 'stopped'
  content?: string
  name?: string
  message?: { role: string; content: MessageContent }
  thinking?: string
  error?: string
  stage?: string
  detail?: string
  filePath?: string
  truncated?: boolean
  query?: string
  engine?: string
  results?: WebSearchResultItem[]
  result?: WebFetchResultEntry
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

interface WebSearchResultItem {
  rank: number
  title: string
  url: string
  snippet: string
  source: string
  published_at?: string
}

interface WebFetchResultEntry {
  url: string
  final_url?: string
  ok: boolean
  status?: number
  status_text?: string
  content_type?: string
  title?: string
  description?: string
  content: string
  excerpt_strategy?: 'query_snippets' | 'leading_text'
  query_snippets?: string[]
  query_match_count?: number
  truncated: boolean
  fetched_at: string
  error?: string
}

type ChatMessageBlock =
  | { id: string; kind: 'content'; content: MessageContent }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tool'; toolRun: ToolRun }
  | { id: string; kind: 'file_preview'; filePath: string; previewContent: string; truncated: boolean; active: boolean }
  | { id: string; kind: 'web_search'; query: string; engine: string; results: WebSearchResultItem[] }
  | { id: string; kind: 'web_fetch'; query?: string; result: WebFetchResultEntry }
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
  enableAiLogging: boolean
}

interface AILogConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  sessionCount: number
  lastStatus?: 'running' | 'completed' | 'failed' | 'stopped'
  errorCount: number
}

interface AILogConversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  sessions: Array<{
    id: string
    startedAt: string
    updatedAt: string
    finishedAt?: string
    status: 'running' | 'completed' | 'failed' | 'stopped'
    providerId?: string
    modelId?: string
    authMode?: AIExecutionAuthMode
    targetProjectId?: string | null
    uploadedMessages: Array<{
      role: string
      content: MessageContent
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
      tool_call_id?: string
      reasoning_content?: string
    }>
    providerCalls: unknown[]
    toolExecutions: unknown[]
    errors: unknown[]
    finalAssistantMessage?: {
      role: string
      content: MessageContent
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
      tool_call_id?: string
      reasoning_content?: string
    }
  }>
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

interface ManagedProcessInfo {
  projectId: string
  projectName: string
  status: string
  pid?: number
  port?: number
  startedAt?: string
  uptimeSeconds?: number
  memoryRssBytes?: number
  exitCode?: number | null
  error?: string
}

interface OrphanProcessInfo {
  pid: number
  name: string
  memoryRssBytes: number
  commandLine: string
  listeningPort?: number
}

interface ProcessManagerSnapshot {
  managed: ManagedProcessInfo[]
  orphans: OrphanProcessInfo[]
  fetchedAt: string
}

interface SkillInfo {
  id: string
  name: string
  description: string
  content: string
  createdAt: string
  updatedAt: string
}

// Document types (renderer-side DTOs)
type DocumentFileType = 'pdf' | 'xlsx' | 'docx' | 'pptx' | 'unknown'

interface DocumentRenderPreviewDTO {
  kind: 'pdf' | 'html' | 'structured'
  source: 'original' | 'generated' | 'fallback'
  status: 'ready' | 'unavailable'
  mimeType?: string
  assetPath?: string
  error?: string
  generatedAt: string
}

interface DocumentNodeDTO {
  id: string
  type: 'heading' | 'paragraph' | 'table' | 'table_row' | 'slide' | 'page' | 'sheet' | 'image_placeholder' | 'list_item'
  text: string
  level: number
  pageIndex: number
  children?: DocumentNodeDTO[]
  meta?: Record<string, unknown>
}

interface DocumentArtifactDTO {
  id: string
  filePath: string
  fileName: string
  fileSize: number
  fileType: DocumentFileType
  plainText: string
  nodes: DocumentNodeDTO[]
  render?: DocumentRenderPreviewDTO
  importedAt: string
}

interface DocumentSelectionDTO {
  id: string
  artifactId: string
  nodeIds: string[]
  label: string
  color: string
  excerpt?: string
  createdAt: string
}

interface DocumentSummaryDTO {
  id: string
  fileName: string
  fileType: DocumentFileType
  fileSize: number
  nodeCount: number
  selectionCount: number
  importedAt: string
}

interface ElectronAPI {
  // AI
  chat: (messages: Array<{ role: string; content: MessageContent }>) => Promise<{ role: string; content: MessageContent }>
  chatStream: (messages: Array<{ role: string; content: MessageContent }>, sessionId: string, conversationId?: string, providerId?: string, modelId?: string, targetProjectId?: string, authMode?: AIExecutionAuthMode) => Promise<{ ok: boolean }>
  stopChatStream: (sessionId: string) => Promise<{ ok: boolean; stopped: boolean }>
  onStreamEvent: (sessionId: string, callback: (event: StreamEvent) => void) => () => void
  setPlanMode: (active: boolean) => Promise<{ success: boolean }>

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
  onProjectOpenInShell: (callback: (event: { projectId: string; mode?: 'embed' | 'window' }) => void) => () => void
  onBrowserOpenUrlInDock: (callback: (event: { url: string }) => void) => () => void
  getSystemStatus: () => Promise<SystemStatusSnapshot>

  // Process management
  getProcessSnapshot: () => Promise<ProcessManagerSnapshot>
  restartManagedProcess: (projectId: string) => Promise<{ success: boolean; error?: string }>
  stopManagedProcess: (projectId: string) => Promise<{ success: boolean; error?: string }>
  forceKillManagedProcess: (projectId: string) => Promise<{ success: boolean; error?: string }>
  killOrphanProcess: (pid: number) => Promise<{ success: boolean; error?: string }>

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
  listAILogConversations: () => Promise<AILogConversationSummary[]>
  getAILogConversation: (conversationId: string) => Promise<AILogConversation | null>
  deleteAILogConversation: (conversationId: string) => Promise<boolean>
  exportAppConfig: () => Promise<{ success: boolean; canceled?: boolean; filePath?: string }>
  importAppConfig: () => Promise<{ success: boolean; canceled?: boolean; filePath?: string; importedAt?: string; requiresReload?: boolean }>
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

  // Document import / preview / selection
  pickDocumentFiles: () => Promise<{ canceled: boolean; filePaths: string[] }>
  pickOfficeFiles: () => Promise<{ canceled: boolean; filePaths: string[] }>
  importDocument: (filePath: string) => Promise<{ artifact: DocumentArtifactDTO }>
  listDocuments: () => Promise<DocumentSummaryDTO[]>
  getDocument: (artifactId: string) => Promise<DocumentArtifactDTO | null>
  getDocumentRenderData: (artifactId: string) => Promise<{ mimeType: string; bytes: Uint8Array } | null>
  openDocumentOriginal: (artifactId: string) => Promise<{ success: boolean; error?: string }>
  removeDocument: (artifactId: string) => Promise<boolean>
  createDocumentSelection: (payload: { artifactId: string; nodeIds: string[]; label: string; color: string; excerpt?: string }) => Promise<DocumentSelectionDTO>
  removeDocumentSelection: (regionId: string) => Promise<boolean>
  updateDocumentSelectionLabel: (regionId: string, label: string) => Promise<DocumentSelectionDTO | null>
  getDocumentSelections: (artifactId: string) => Promise<DocumentSelectionDTO[]>
  buildDocumentSelectionsPrompt: (regionIds?: string[]) => Promise<string>
}

interface Window {
  electronAPI?: ElectronAPI
}
