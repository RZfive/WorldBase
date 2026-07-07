import { contextBridge, ipcRenderer } from 'electron'
import type { AgentDefinition, AgentGroupDefinition, AgentGroupProgressSnapshot, AgentGroupTranscript, AgentMemoryScope, AgentSidechatSession, ChannelBinding, ConnectorDefinition, MemoryCompactionResult, MemoryCompactionStatus, MemoryEntry, MemorySearchScope, MemoryType } from '../src/shared/agent-workspace-types.js'
import type { AppAboutInfo, AppUpdateChannel, AppUpdateConfig, AppUpdateState, AppUpdateWebsiteKind } from '../src/shared/app-update-types.js'
import type { ActivePageAutomationContext, PageAutomationRequestEnvelope, PageAutomationResponseEnvelope } from '../src/shared/page-automation-types.js'
import type { ImageLibraryItem, ImageLibraryPage, ImageLibraryQuery, ImageLibraryData, ImageLibraryFolderCard, ImageStudioGenerateRequest, ImageStudioGenerateResponse, ImageStudioTask } from '../src/shared/image-studio-types.js'
import type { UsageRecord, UsageSummary } from '../src/main/settings/usage-store.js'
import type { ConversationFolderWorkspaceState, FolderWorkspaceChangeEvent, FolderWorkspaceListResult, FolderWorkspacePickResult, FolderWorkspaceReadResult } from '../src/shared/folder-workspace-types.js'
import type { LongTermGoalChangeSet, LongTermGoalDefinition, LongTermGoalIntervention, LongTermGoalMessageResult, LongTermGoalRun, LongTermGoalSaveInput, LongTermGoalSnapshot, LongTermGoalStreamEvent } from '../src/shared/long-term-goal-types.js'

interface ChatMessage {
  role: string
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
}

interface AISettings {
  apiKey: string
  baseUrl: string
  model: string
}

interface StreamEvent {
  type: 'token' | 'thinking' | 'tool_start' | 'tool_end' | 'progress' | 'todo_update' | 'file_preview_start' | 'file_preview_end' | 'group_progress' | 'group_transcript' | 'agent_sidechat' | 'web_search_result' | 'web_fetch_result' | 'reset' | 'done' | 'error' | 'stopped'
  content?: string
  name?: string
  message?: ChatMessage
  thinking?: string
  error?: string
  stage?: string
  detail?: string
  items?: TodoItem[]
  filePath?: string
  truncated?: boolean
  lineCount?: number
  added?: number
  removed?: number
  groupProgress?: AgentGroupProgressSnapshot
  transcript?: AgentGroupTranscript
  sidechat?: AgentSidechatSession
  query?: string
  engine?: string
  results?: Array<{ rank: number; title: string; url: string; snippet: string; source: string; published_at?: string }>
  result?: { url: string; final_url?: string; ok: boolean; status?: number; status_text?: string; content_type?: string; title?: string; description?: string; content: string; excerpt_strategy?: 'query_snippets' | 'leading_text'; query_snippets?: string[]; query_match_count?: number; truncated: boolean; fetched_at: string; error?: string }
}

type TodoStatus = 'not-started' | 'in-progress' | 'completed'

interface TodoItem {
  id: number
  title: string
  status: TodoStatus
}

interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  manualTitle?: boolean
  previewText?: string
  searchText?: string
  authMode?: AIExecutionAuthMode
  providerId?: string
  selectedModel?: string
  reasoningStrength?: 'low' | 'medium' | 'high' | 'max'
  temperature?: number
  targetProjectId?: string
  agentId?: string
  groupId?: string
  channelBindingId?: string
  folderWorkspace?: ConversationFolderWorkspaceState
}

interface ConversationDocumentReference {
  filePath: string
  fileName: string
}

interface ConversationDocumentWorkspaceState {
  documents?: ConversationDocumentReference[]
  activeFilePath?: string
  width?: number
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

interface Conversation extends ConversationSummary {
  messages: Array<ChatMessage & { thinking?: string; modelLabel?: string; toolRuns?: ToolRun[] }>
  documentWorkspace?: ConversationDocumentWorkspaceState
  folderWorkspace?: ConversationFolderWorkspaceState
}

interface AIProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: string[]
  modelContextWindows?: Record<string, number>
  modelCapabilities?: Record<string, { imageGeneration?: boolean; imageEditing?: boolean }>
  activeModel: string
  enableThinking?: boolean
  temperature?: number
}

interface AIProvidersConfig {
  providers: AIProvider[]
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

interface PinnedDockApp {
  id: string
  kind: 'project' | 'browser'
  name: string
  type?: string
  icon?: string
  url?: string
  addedAt: string
}

type ThemePreference = 'system' | 'light' | 'dark'
type LanguagePreference = 'zh-CN' | 'en-US' | 'system'
type AIExecutionAuthMode = 'strict' | 'auto'

interface CostModelPricingEntry {
  model: string
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
}

interface CostSettings {
  modelPricing: CostModelPricingEntry[]
  budgetLimit: number | null
}

type MCPTransportType = 'stdio' | 'streamable-http' | 'sse'

interface MCPServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: MCPTransportType
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  url: string
  headers: Record<string, string>
  timeoutMs: number
}


type ScheduledTaskStatus = 'idle' | 'running' | 'retrying' | 'completed' | 'failed'
type ScheduledTaskRunStatus = 'running' | 'retrying' | 'completed' | 'failed'
type ScheduledTaskTrigger = 'manual' | 'schedule'

interface ScheduledTaskProgressEntry {
  at: string
  stage: string
  detail?: string
  kind?: 'progress' | 'thinking' | 'tool_start' | 'tool_end' | 'todo' | 'file' | 'web'
  toolName?: string
}

interface ScheduledTaskRetryPolicy {
  maxRetries: number
  retryDelayMinutes: number
}

type ScheduledTaskSchedule =
  | {
    kind: 'once'
    runAt: string
  }
  | {
    kind: 'interval'
    everyMinutes: number
    startAt?: string
  }
  | {
    kind: 'daily'
    timeOfDay: string
  }
  | {
    kind: 'weekly'
    weekdays: number[]
    timeOfDay: string
  }
  | {
    kind: 'dates'
    dates: string[]
  }

interface ScheduledTaskDefinition {
  id: string
  title: string
  enabled: boolean
  hidden?: boolean
  createdBy: 'manual' | 'ai'
  prompt: string
  schedule: ScheduledTaskSchedule
  providerId?: string | null
  modelId?: string | null
  selectedSkillIds: string[]
  selectedMcpServerIds: string[]
  retryPolicy: ScheduledTaskRetryPolicy
  createdAt: string
  updatedAt: string
  nextRunAt?: string | null
  retryScheduledAt?: string | null
  lastRunAt?: string | null
  lastStatus?: ScheduledTaskStatus
  lastReportId?: string | null
}

interface ScheduledTaskRunReport {
  id: string
  taskId: string
  taskTitle: string
  trigger: ScheduledTaskTrigger
  status: ScheduledTaskRunStatus
  scheduledFor?: string | null
  startedAt: string
  finishedAt?: string | null
  attempt: number
  prompt: string
  summary: string
  resultText?: string
  thinkingText?: string
  error?: string
  progress: ScheduledTaskProgressEntry[]
  providerId?: string | null
  modelId?: string | null
  selectedSkillIds: string[]
  selectedMcpServerIds: string[]
  retryScheduledAt?: string | null
  createdAt: string
  updatedAt: string
}
interface MCPToolSummary {
  name: string
  localName: string
  description: string
  inputSchema: Record<string, unknown>
}

interface MCPResourceSummary {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

interface MCPPromptSummary {
  name: string
  description: string
  arguments: Array<{ name: string; description?: string; required?: boolean }>
}

interface MCPServerSnapshot {
  id: string
  name: string
  enabled: boolean
  transport: MCPTransportType
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  error?: string
  updatedAt: string | null
  tools: MCPToolSummary[]
  resources: MCPResourceSummary[]
  prompts: MCPPromptSummary[]
  capabilities: {
    tools: boolean
    resources: boolean
    prompts: boolean
  }
}

interface MCPStateSnapshot {
  servers: MCPServerSnapshot[]
  updatedAt: string
}

interface AIExecutionPreferences {
  notifyOnTaskComplete: boolean
  enableAiLogging: boolean
}

interface ChatFontPreferences {
  fontFamily: string
  fontSize: number
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
    uploadedMessages: Array<{ role: string; content: MessageContent; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; tool_call_id?: string; reasoning_content?: string }>
    providerCalls: unknown[]
    toolExecutions: unknown[]
    errors: unknown[]
    finalAssistantMessage?: { role: string; content: MessageContent; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; tool_call_id?: string; reasoning_content?: string }
  }>
}

interface ProjectLanUrlInfo {
  projectPort: number | null
  lanUrl: string | null
  proxyUrl: string
  localProxyUrl: string
  lanIp: string
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
  gpu: {
    status: 'hardware' | 'software' | 'disabled' | 'unavailable'
    primaryDevice: string
    secondaryDevices: string[]
    featureStatus: Record<string, string>
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

/**
 * API shape exposed to the renderer via contextBridge.
 * Must stay in sync with the ElectronAPI declaration in src/env.d.ts.
 */
export interface ElectronAPI {
  // AI
  chat: (messages: ChatMessage[], providerId?: string, modelId?: string, reasoningStrength?: 'low' | 'medium' | 'high' | 'max', agentId?: string, groupId?: string, channelBindingId?: string, targetProjectId?: string, activePageContext?: ActivePageAutomationContext) => Promise<ChatMessage>
  chatStream: (messages: ChatMessage[], sessionId: string, conversationId?: string, providerId?: string, modelId?: string, targetProjectId?: string, authMode?: AIExecutionAuthMode, reasoningStrength?: 'low' | 'medium' | 'high' | 'max', agentId?: string, groupId?: string, channelBindingId?: string, activePageContext?: ActivePageAutomationContext, temperature?: number, folderWorkspaceRoot?: string) => Promise<{ ok: boolean }>
  updateChatSessionAuthMode: (sessionId: string, authMode: AIExecutionAuthMode) => Promise<{ ok: boolean; updated: boolean }>
  stopChatStream: (sessionId: string) => Promise<{ ok: boolean; stopped: boolean }>
  onStreamEvent: (sessionId: string, callback: (event: StreamEvent) => void) => () => void
  onPageAutomationRequest: (callback: (payload: PageAutomationRequestEnvelope) => void) => () => void
  respondPageAutomationRequest: (payload: PageAutomationResponseEnvelope) => void
  getAboutInfo: () => Promise<AppAboutInfo>
  getAppUpdateState: () => Promise<AppUpdateState>
  getAppUpdateConfig: () => Promise<AppUpdateConfig>
  checkAppUpdate: (options?: { channel?: AppUpdateChannel }) => Promise<AppUpdateState>
  saveAppUpdateConfig: (config: AppUpdateConfig) => Promise<{ success: boolean; config: AppUpdateConfig }>
  downloadAppUpdate: () => Promise<AppUpdateState>
  installAppUpdate: () => Promise<{ success: boolean; state: AppUpdateState; error?: string }>
  openAppUpdateWebsite: (kind: AppUpdateWebsiteKind) => Promise<{ success: boolean; error?: string }>
  onAppUpdateStateChanged: (callback: (state: AppUpdateState) => void) => () => void

  // Conversations
  listConversations: () => Promise<ConversationSummary[]>
  getConversation: (id: string) => Promise<Conversation | null>
  saveConversation: (conversation: Conversation) => Promise<{ success: boolean }>
  renameConversation: (id: string, title: string) => Promise<{ success: boolean }>
  deleteConversation: (id: string) => Promise<boolean>
  listAgents: () => Promise<AgentDefinition[]>
  listAgentToolDefinitions: () => Promise<Array<{ name: string; description: string }>>
  getAgent: (id: string) => Promise<AgentDefinition | null>
  saveAgent: (agent: Partial<AgentDefinition>) => Promise<AgentDefinition>
  deleteAgent: (id: string) => Promise<boolean>
  listAgentGroups: () => Promise<AgentGroupDefinition[]>
  getAgentGroup: (id: string) => Promise<AgentGroupDefinition | null>
  saveAgentGroup: (group: Partial<AgentGroupDefinition>) => Promise<AgentGroupDefinition>
  deleteAgentGroup: (id: string) => Promise<boolean>
  onAgentWorkspaceChanged: (callback: (event: { entity: 'agent' | 'group' | 'binding'; action: string; id?: string }) => void) => () => void
  listImConnectors: () => Promise<ConnectorDefinition[]>
  listChannelBindings: () => Promise<ChannelBinding[]>
  getChannelBinding: (id: string) => Promise<ChannelBinding | null>
  saveChannelBinding: (binding: Partial<ChannelBinding>) => Promise<ChannelBinding>
  deleteChannelBinding: (id: string) => Promise<boolean>
  testChannelBinding: (id: string, text?: string) => Promise<{ ok: boolean; reply: string | null }>
  listMemory: (options?: { query?: string; scopes?: MemorySearchScope[]; memoryTypes?: MemoryType[]; limit?: number; scopeType?: AgentMemoryScope; scopeId?: string }) => Promise<MemoryEntry[]>
  saveMemory: (entry: Partial<MemoryEntry>) => Promise<MemoryEntry>
  pinMemory: (id: string, pinned: boolean) => Promise<boolean>
  deleteMemory: (id: string) => Promise<boolean>
  compactMemory: () => Promise<MemoryCompactionResult>
  getMemoryCompactionStatus: () => Promise<MemoryCompactionStatus>
  onMemoryCompactionStatusChanged: (callback: (status: MemoryCompactionStatus) => void) => () => void
  saveImageToFile: (imageUrl: string, defaultName?: string) => Promise<{ success?: boolean; canceled?: boolean; filePath?: string }>
  saveMarkdownToFile: (markdown: string, defaultName?: string) => Promise<{ success?: boolean; canceled?: boolean; filePath?: string }>
  generateStudioImage: (req: ImageStudioGenerateRequest) => Promise<ImageStudioGenerateResponse>
  queryImageLibrary: (opts: ImageLibraryQuery) => Promise<ImageLibraryPage>
  getImageLibraryData: (id: string) => Promise<ImageLibraryData | null>
  deleteImageLibrary: (ids: string[]) => Promise<{ removed: number }>
  setImageLibraryFolder: (ids: string[], folder: string | undefined) => Promise<{ updated: number }>
  setImageLibraryTags: (id: string, tags: string[]) => Promise<{ ok: boolean }>
  listImageLibraryFolders: () => Promise<ImageLibraryFolderCard[]>
  createImageLibraryFolder: (name: string) => Promise<ImageLibraryFolderCard[]>
  exportImageLibraryFolder: (folderName: string) => Promise<{ success?: boolean; canceled?: boolean; filePath?: string; count?: number; error?: string }>
  listImageLibraryTags: () => Promise<string[]>
  renameImageLibraryFolder: (oldName: string, newName: string) => Promise<{ updated: number }>
  deleteImageLibraryFolder: (folderName: string) => Promise<{ updated: number }>
  optimizeImagePrompt: (req: { providerId: string; model: string; prompt: string; isNegative?: boolean }) => Promise<{ ok: boolean; optimizedPrompt?: string; error?: string }>
  drainPendingStudioImageTasks: () => Promise<ImageStudioGenerateRequest[]>
  loadStudioImageTasks: () => Promise<ImageStudioTask[]>
  saveStudioImageTasks: (tasks: ImageStudioTask[]) => Promise<void>
  getUsageDaily: (from?: string, to?: string) => Promise<UsageRecord[]>
  getUsageSummary: (from?: string, to?: string) => Promise<UsageSummary[]>
  clearUsage: (beforeDate?: string) => Promise<{ removed: number }>
  onStudioImageTasksAdded: (callback: (payload: { count: number }) => void) => () => void
  readUploadedAttachmentFile: (filePath: string) => Promise<{ filePath: string; fileName: string; size: number; fileType: string; content: string }>
  readUploadedAttachmentBuffer: (payload: { fileName: string; fileType?: string; bytes: Uint8Array }) => Promise<{ filePath: string; fileName: string; size: number; fileType: string; content: string }>
  readUploadedOfficeFile: (filePath: string) => Promise<{ filePath: string; fileName: string; size: number; fileType: string; content: string }>

  // Projects
  listProjects: () => Promise<Array<Record<string, unknown>>>
  getProject: (projectId: string) => Promise<Record<string, unknown>>
  getFileTree: (projectId: string) => Promise<Array<Record<string, unknown>>>
  readFile: (projectId: string, filePath: string) => Promise<string>
  writeFile: (projectId: string, filePath: string, content: string) => Promise<{ success: boolean }>
  updateProjectAppearance: (projectId: string, updates: { name?: string; icon?: string }) => Promise<Record<string, unknown>>
  exportProjectPackage: (projectId: string) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; projectId?: string; projectName?: string; includedBuildArtifacts?: string[] }>
  importProjectPackage: () => Promise<{ success: boolean; canceled?: boolean; filePaths?: string[]; importedProjects?: Array<{ projectId: string; name: string; filePath: string }> }>
  importProjectPackageFromFile: (filePath: string) => Promise<{ success: boolean; filePath?: string; importedProject?: { projectId: string; name: string } }>
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

  // Plan Mode
  setPlanMode: (active: boolean) => Promise<{ success: boolean }>

  // Cost Settings
  getCostSettings: () => Promise<CostSettings>
  saveCostSettings: (settings: CostSettings) => Promise<{ success: boolean }>

  // Settings
  getAISettings: () => Promise<AISettings>
  saveAISettings: (config: AISettings) => Promise<{ success: boolean }>
  getProviders: () => Promise<AIProvidersConfig>
  saveProviders: (config: AIProvidersConfig) => Promise<{ success: boolean }>
  onProvidersChanged: (callback: (config: AIProvidersConfig) => void) => () => void
  getThemePreference: () => Promise<ThemePreference>
  saveThemePreference: (preference: ThemePreference) => Promise<{ success: boolean }>
  getLocalePreference: () => Promise<LanguagePreference>
  saveLocalePreference: (preference: LanguagePreference) => Promise<{ success: boolean }>
  getAIExecutionPreferences: () => Promise<AIExecutionPreferences>
  saveAIExecutionPreferences: (preferences: AIExecutionPreferences) => Promise<{ success: boolean }>
  getChatFontPreferences: () => Promise<ChatFontPreferences>
  saveChatFontPreferences: (preferences: ChatFontPreferences) => Promise<{ success: boolean }>
  getMcpServers: () => Promise<MCPServerConfig[]>
  saveMcpServers: (servers: MCPServerConfig[]) => Promise<{ success: boolean }>
  getMcpState: () => Promise<MCPStateSnapshot>
  refreshMcpServer: (serverId?: string) => Promise<MCPStateSnapshot | MCPServerSnapshot>
  disconnectMcpServer: (serverId: string) => Promise<MCPServerSnapshot>
  onMcpStateChanged: (callback: (state: MCPStateSnapshot) => void) => () => void
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
  getPinnedDockApps: () => Promise<PinnedDockApp[]>
  savePinnedDockApps: (apps: PinnedDockApp[]) => Promise<{ success: boolean }>
  listScheduledTasks: () => Promise<ScheduledTaskDefinition[]>
  saveScheduledTask: (task: ScheduledTaskDefinition) => Promise<ScheduledTaskDefinition>
  deleteScheduledTask: (taskId: string) => Promise<boolean>
  runScheduledTaskNow: (taskId: string) => Promise<ScheduledTaskRunReport>
  listScheduledTaskReports: (taskId?: string) => Promise<ScheduledTaskRunReport[]>
  getScheduledTaskReport: (reportId: string) => Promise<ScheduledTaskRunReport | null>
  onScheduledTasksChanged: (callback: (tasks: ScheduledTaskDefinition[]) => void) => () => void
  onScheduledTaskReportsChanged: (callback: (reports: ScheduledTaskRunReport[]) => void) => () => void
  onScheduledTaskReportRequested: (callback: (report: ScheduledTaskRunReport) => void) => () => void
  listLongTermGoals: () => Promise<LongTermGoalDefinition[]>
  getLongTermGoalSnapshot: (goalId?: string) => Promise<LongTermGoalSnapshot>
  saveLongTermGoal: (goal: LongTermGoalSaveInput) => Promise<LongTermGoalDefinition>
  renameLongTermGoal: (goalId: string, title: string) => Promise<LongTermGoalDefinition>
  setLongTermGoalStatus: (goalId: string, status: LongTermGoalDefinition['status']) => Promise<LongTermGoalDefinition>
  deleteLongTermGoal: (goalId: string) => Promise<boolean>
  runLongTermGoalNow: (goalId: string) => Promise<ScheduledTaskRunReport>
  sendLongTermGoalMessage: (goalId: string, content: string) => Promise<LongTermGoalMessageResult>
  streamLongTermGoalMessage: (goalId: string, content: string, streamId: string) => Promise<LongTermGoalMessageResult>
  streamLongTermGoalCreate: (content: string, options: { providerId?: string | null; modelId?: string | null; selectedMcpServerIds?: string[] } | undefined, streamId: string) => Promise<LongTermGoalMessageResult>
  applyLongTermGoalChangeSet: (changeSetId: string) => Promise<LongTermGoalChangeSet>
  cancelLongTermGoalChangeSet: (changeSetId: string) => Promise<LongTermGoalChangeSet>
  applyLongTermGoalCreation: (changeSetId: string) => Promise<LongTermGoalDefinition>
  cancelLongTermGoalCreation: (changeSetId: string) => Promise<boolean>
  answerLongTermGoalIntervention: (goalId: string, interventionId: string, answers: Array<{ questionId: string; selectedOption?: string | null; customAnswer?: string | null }>, streamId?: string) => Promise<LongTermGoalDefinition>
  onLongTermGoalsChanged: (callback: (goals: LongTermGoalDefinition[]) => void) => () => void
  onLongTermGoalSnapshotChanged: (callback: (snapshot: LongTermGoalSnapshot) => void) => () => void
  onLongTermGoalInterventionRequested: (callback: (intervention: LongTermGoalIntervention) => void) => () => void
  onLongTermGoalStreamEvent: (streamId: string, callback: (event: LongTermGoalStreamEvent) => void) => () => void
  onLongTermGoalRunProgress: (callback: (payload: { goalId: string; run: LongTermGoalRun }) => void) => () => void

  // Skills
  listSkills: () => Promise<Array<{ id: string; name: string; description: string; fileCount: number; files: Array<{ relativePath: string; type: string; size: number }>; scripts: Array<{ relativePath: string; language: string }>; tools: string[]; createdAt: string; updatedAt: string }>>
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
  getWindowBounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>
  ensureWindowWidth: (minimumWidth: number, options?: { animate?: boolean; durationMs?: number; allowShrink?: boolean }) => Promise<{ applied: boolean; width: number }>
  setMinimumWindowWidth: (minimumWidth: number) => Promise<{ success: boolean; width: number }>

  // Auth (in-app authorization dialogs)
  onAuthRequest: (callback: (request: { requestId: string; conversationId?: string; sessionId?: string; title: string; detail: string }) => void) => () => void
  onAuthResolved: (callback: (payload: { requestId: string; approved: boolean }) => void) => () => void
  respondAuth: (requestId: string, approved: boolean) => void
  onSudoPasswordRequest: (callback: (req: { requestId: string; conversationId?: string; sessionId?: string; command: string }) => void) => () => void
  respondSudoPassword: (requestId: string, password: string | null) => void

  // Ask-user (in-app clarification questions surfaced above the chat input)
  onAskUserRequest: (callback: (request: { requestId: string; conversationId?: string; sessionId?: string; questions: Array<{ id: string; question: string; options: string[] }> }) => void) => () => void
  respondAskUser: (requestId: string, answers: Array<{ questionId: string; selectedOption: string | null; customAnswer: string | null }> | null) => void

  // Document import / preview / selection
  pickDocumentFiles: () => Promise<{ canceled: boolean; filePaths: string[] }>
  pickOfficeFiles: () => Promise<{ canceled: boolean; filePaths: string[] }>
  importDocument: (filePath: string) => Promise<{ artifact: unknown }>
  listDocuments: () => Promise<unknown[]>
  getDocument: (artifactId: string) => Promise<unknown | null>
  ensureDocumentRenderPreview: (artifactId: string) => Promise<unknown | null>
  getDocumentRenderData: (artifactId: string) => Promise<{ mimeType: string; bytes: Uint8Array } | null>
  openDocumentOriginal: (artifactId: string) => Promise<{ success: boolean; error?: string }>
  removeDocument: (artifactId: string) => Promise<boolean>
  createDocumentSelection: (payload: { artifactId: string; nodeIds: string[]; label: string; color: string; excerpt?: string }) => Promise<unknown>
  removeDocumentSelection: (regionId: string) => Promise<boolean>
  updateDocumentSelectionLabel: (regionId: string, label: string) => Promise<unknown | null>
  getDocumentSelections: (artifactId: string) => Promise<unknown[]>
  buildDocumentSelectionsPrompt: (regionIds?: string[]) => Promise<string>

  // Folder workspace preview
  pickFolderWorkspace: () => Promise<FolderWorkspacePickResult>
  listFolderWorkspaceFiles: (rootPath: string) => Promise<FolderWorkspaceListResult>
  readFolderWorkspaceFile: (rootPath: string, filePath: string) => Promise<FolderWorkspaceReadResult>
  onFolderWorkspaceChanged: (callback: (event: FolderWorkspaceChangeEvent) => void) => () => void
}

contextBridge.exposeInMainWorld('electronAPI', {
  // AI
  chat: (messages: ChatMessage[], providerId?: string, modelId?: string, reasoningStrength?: 'low' | 'medium' | 'high' | 'max', agentId?: string, groupId?: string, channelBindingId?: string, targetProjectId?: string, activePageContext?: ActivePageAutomationContext) => ipcRenderer.invoke('ai:chat', messages, providerId, modelId, reasoningStrength, agentId, groupId, channelBindingId, targetProjectId, activePageContext),
  chatStream: (messages: ChatMessage[], sessionId: string, conversationId?: string, providerId?: string, modelId?: string, targetProjectId?: string, authMode?: AIExecutionAuthMode, reasoningStrength?: 'low' | 'medium' | 'high' | 'max', agentId?: string, groupId?: string, channelBindingId?: string, activePageContext?: ActivePageAutomationContext, temperature?: number, folderWorkspaceRoot?: string) => ipcRenderer.invoke('ai:chatStream', messages, sessionId, conversationId, providerId, modelId, targetProjectId, authMode, reasoningStrength, agentId, groupId, channelBindingId, activePageContext, temperature, folderWorkspaceRoot),
  updateChatSessionAuthMode: (sessionId: string, authMode: AIExecutionAuthMode) => ipcRenderer.invoke('ai:updateSessionAuthMode', sessionId, authMode),
  stopChatStream: (sessionId: string) => ipcRenderer.invoke('ai:stopStream', sessionId),
  onStreamEvent: (sessionId: string, callback: (event: StreamEvent) => void) => {
    const channel = `ai:stream-event:${sessionId}`
    const handler = (_e: Electron.IpcRendererEvent, event: StreamEvent) => callback(event)
    ipcRenderer.on(channel, handler)
    // Return cleanup function
    return () => { ipcRenderer.removeListener(channel, handler) }
  },
  onPageAutomationRequest: (callback: (payload: PageAutomationRequestEnvelope) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: PageAutomationRequestEnvelope) => callback(payload)
    ipcRenderer.on('pageAutomation:request', handler)
    return () => { ipcRenderer.removeListener('pageAutomation:request', handler) }
  },
  respondPageAutomationRequest: (payload: PageAutomationResponseEnvelope) => {
    ipcRenderer.send('pageAutomation:response', payload)
  },
  getAboutInfo: () => ipcRenderer.invoke('app:getAboutInfo'),
  getAppUpdateState: () => ipcRenderer.invoke('appUpdate:getState'),
  getAppUpdateConfig: () => ipcRenderer.invoke('appUpdate:getConfig'),
  checkAppUpdate: (options?: { channel?: AppUpdateChannel }) => ipcRenderer.invoke('appUpdate:check', options),
  saveAppUpdateConfig: (config: AppUpdateConfig) => ipcRenderer.invoke('appUpdate:saveConfig', config),
  downloadAppUpdate: () => ipcRenderer.invoke('appUpdate:download'),
  installAppUpdate: () => ipcRenderer.invoke('appUpdate:install'),
  openAppUpdateWebsite: (kind: AppUpdateWebsiteKind) => ipcRenderer.invoke('appUpdate:openWebsite', kind),
  onAppUpdateStateChanged: (callback: (state: AppUpdateState) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: AppUpdateState) => callback(state)
    ipcRenderer.on('appUpdate:stateChanged', handler)
    return () => { ipcRenderer.removeListener('appUpdate:stateChanged', handler) }
  },

  // Conversations
  listConversations: () => ipcRenderer.invoke('conversations:list'),
  getConversation: (id: string) => ipcRenderer.invoke('conversations:get', id),
  saveConversation: (conversation: Conversation) => ipcRenderer.invoke('conversations:save', conversation),
  renameConversation: (id: string, title: string): Promise<{ success: boolean }> => ipcRenderer.invoke('conversations:rename', id, title),
  deleteConversation: (id: string) => ipcRenderer.invoke('conversations:delete', id),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  listAgentToolDefinitions: () => ipcRenderer.invoke('agentWorkspace:listToolDefinitions'),
  getAgent: (id: string) => ipcRenderer.invoke('agents:get', id),
  saveAgent: (agent: Partial<AgentDefinition>) => ipcRenderer.invoke('agents:save', agent),
  deleteAgent: (id: string) => ipcRenderer.invoke('agents:delete', id),
  listAgentGroups: () => ipcRenderer.invoke('agentGroups:list'),
  getAgentGroup: (id: string) => ipcRenderer.invoke('agentGroups:get', id),
  saveAgentGroup: (group: Partial<AgentGroupDefinition>) => ipcRenderer.invoke('agentGroups:save', group),
  deleteAgentGroup: (id: string) => ipcRenderer.invoke('agentGroups:delete', id),
  onAgentWorkspaceChanged: (callback: (event: { entity: 'agent' | 'group' | 'binding'; action: string; id?: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: { entity: 'agent' | 'group' | 'binding'; action: string; id?: string }) => callback(event)
    ipcRenderer.on('agentWorkspace:changed', handler)
    return () => { ipcRenderer.removeListener('agentWorkspace:changed', handler) }
  },
  listImConnectors: () => ipcRenderer.invoke('im:listConnectors'),
  listChannelBindings: () => ipcRenderer.invoke('im:listBindings'),
  getChannelBinding: (id: string) => ipcRenderer.invoke('im:getBinding', id),
  saveChannelBinding: (binding: Partial<ChannelBinding>) => ipcRenderer.invoke('im:saveBinding', binding),
  deleteChannelBinding: (id: string) => ipcRenderer.invoke('im:deleteBinding', id),
  testChannelBinding: (id: string, text?: string) => ipcRenderer.invoke('im:testBinding', id, text),
  listMemory: (options?: { query?: string; scopes?: MemorySearchScope[]; memoryTypes?: MemoryType[]; limit?: number; scopeType?: AgentMemoryScope; scopeId?: string }) => ipcRenderer.invoke('memory:list', options),
  saveMemory: (entry: Partial<MemoryEntry>) => ipcRenderer.invoke('memory:save', entry),
  pinMemory: (id: string, pinned: boolean) => ipcRenderer.invoke('memory:pin', id, pinned),
  deleteMemory: (id: string) => ipcRenderer.invoke('memory:delete', id),
  compactMemory: () => ipcRenderer.invoke('memory:compact'),
  getMemoryCompactionStatus: () => ipcRenderer.invoke('memory:compactStatus'),
  onMemoryCompactionStatusChanged: (callback: (status: MemoryCompactionStatus) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, status: MemoryCompactionStatus) => callback(status)
    ipcRenderer.on('memory:compactionStatusChanged', handler)
    return () => { ipcRenderer.removeListener('memory:compactionStatusChanged', handler) }
  },
  saveImageToFile: (imageUrl: string, defaultName?: string) => ipcRenderer.invoke('media:saveImage', imageUrl, defaultName),
  saveMarkdownToFile: (markdown: string, defaultName?: string) => ipcRenderer.invoke('media:saveMarkdown', markdown, defaultName),
  generateStudioImage: (req: ImageStudioGenerateRequest): Promise<ImageStudioGenerateResponse> => ipcRenderer.invoke('image:generate', req),
  queryImageLibrary: (opts: ImageLibraryQuery): Promise<ImageLibraryPage> => ipcRenderer.invoke('image:library:query', opts),
  getImageLibraryData: (id: string): Promise<ImageLibraryData | null> => ipcRenderer.invoke('image:library:getData', id),
  deleteImageLibrary: (ids: string[]): Promise<{ removed: number }> => ipcRenderer.invoke('image:library:delete', ids),
  setImageLibraryFolder: (ids: string[], folder: string | undefined): Promise<{ updated: number }> => ipcRenderer.invoke('image:library:setFolder', ids, folder),
  setImageLibraryTags: (id: string, tags: string[]): Promise<{ ok: boolean }> => ipcRenderer.invoke('image:library:setTags', id, tags),
  listImageLibraryFolders: (): Promise<ImageLibraryFolderCard[]> => ipcRenderer.invoke('image:library:listFolders'),
  createImageLibraryFolder: (name: string): Promise<ImageLibraryFolderCard[]> => ipcRenderer.invoke('image:library:createFolder', name),
  exportImageLibraryFolder: (folderName: string): Promise<{ success?: boolean; canceled?: boolean; filePath?: string; count?: number; error?: string }> => ipcRenderer.invoke('image:library:exportFolder', folderName),
  listImageLibraryTags: (): Promise<string[]> => ipcRenderer.invoke('image:library:listTags'),
  renameImageLibraryFolder: (oldName: string, newName: string): Promise<{ updated: number }> => ipcRenderer.invoke('image:library:renameFolder', oldName, newName),
  deleteImageLibraryFolder: (folderName: string): Promise<{ updated: number }> => ipcRenderer.invoke('image:library:deleteFolder', folderName),
  optimizeImagePrompt: (req: { providerId: string; model: string; prompt: string; isNegative?: boolean }): Promise<{ ok: boolean; optimizedPrompt?: string; error?: string }> => ipcRenderer.invoke('image:prompt:optimize', req),
  drainPendingStudioImageTasks: (): Promise<ImageStudioGenerateRequest[]> => ipcRenderer.invoke('image:studio:drainPendingTasks'),
  loadStudioImageTasks: (): Promise<ImageStudioTask[]> => ipcRenderer.invoke('image:studio:loadTasks'),
  saveStudioImageTasks: (tasks: ImageStudioTask[]) => ipcRenderer.invoke('image:studio:saveTasks', tasks),
  getUsageDaily: (from?: string, to?: string) => ipcRenderer.invoke('usage:getDaily', from, to),
  getUsageSummary: (from?: string, to?: string) => ipcRenderer.invoke('usage:getSummary', from, to),
  clearUsage: (beforeDate?: string) => ipcRenderer.invoke('usage:clear', beforeDate),
  onStudioImageTasksAdded: (callback: (payload: { count: number }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { count: number }) => callback(payload)
    ipcRenderer.on('image:studio:tasksAdded', handler)
    return () => { ipcRenderer.removeListener('image:studio:tasksAdded', handler) }
  },
  readUploadedAttachmentFile: (filePath: string) => ipcRenderer.invoke('chat:readUploadedAttachmentFile', filePath),
  readUploadedAttachmentBuffer: (payload: { fileName: string; fileType?: string; bytes: Uint8Array }) => ipcRenderer.invoke('chat:readUploadedAttachmentBuffer', payload),
  readUploadedOfficeFile: (filePath: string) => ipcRenderer.invoke('chat:readUploadedOfficeFile', filePath),

  // Projects
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getProject: (projectId: string) => ipcRenderer.invoke('projects:get', projectId),
  getFileTree: (projectId: string) => ipcRenderer.invoke('projects:getFileTree', projectId),
  readFile: (projectId: string, filePath: string) => ipcRenderer.invoke('projects:readFile', projectId, filePath),
  writeFile: (projectId: string, filePath: string, content: string) => ipcRenderer.invoke('projects:writeFile', projectId, filePath, content),
  updateProjectAppearance: (projectId: string, updates: { name?: string; icon?: string }) => ipcRenderer.invoke('projects:updateAppearance', projectId, updates),
  exportProjectPackage: (projectId: string) => ipcRenderer.invoke('projects:exportPackage', projectId),
  importProjectPackage: () => ipcRenderer.invoke('projects:importPackage'),
  importProjectPackageFromFile: (filePath: string) => ipcRenderer.invoke('projects:importPackageFromFile', filePath),
  openProjectFolder: (projectId: string) => ipcRenderer.invoke('projects:openFolder', projectId),
  deleteProject: (projectId: string) => ipcRenderer.invoke('projects:delete', projectId),
  onProjectChanged: (callback: (event: { action: string; projectId: string; port?: number }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: { action: string; projectId: string; port?: number }) => callback(event)
    ipcRenderer.on('projects:changed', handler)
    return () => { ipcRenderer.removeListener('projects:changed', handler) }
  },

  // Runtime
  startProject: (projectId: string) => ipcRenderer.invoke('runtime:start', projectId),
  stopProject: (projectId: string) => ipcRenderer.invoke('runtime:stop', projectId),
  getProjectStatus: (projectId: string) => ipcRenderer.invoke('runtime:status', projectId),
  openProjectWindow: (projectId: string) => ipcRenderer.invoke('runtime:openWindow', projectId),
  getOpenWindows: () => ipcRenderer.invoke('runtime:getOpenWindows'),
  focusProjectWindow: (projectId: string) => ipcRenderer.invoke('runtime:focusWindow', projectId),
  onProjectWindowClosed: (callback: (event: { projectId: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: { projectId: string }) => callback(event)
    ipcRenderer.on('project:windowClosed', handler)
    return () => { ipcRenderer.removeListener('project:windowClosed', handler) }
  },
  onProjectOpenInShell: (callback: (event: { projectId: string; mode?: 'embed' | 'window' }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: { projectId: string; mode?: 'embed' | 'window' }) => callback(event)
    ipcRenderer.on('project:openInShell', handler)
    return () => { ipcRenderer.removeListener('project:openInShell', handler) }
  },
  onBrowserOpenUrlInDock: (callback: (event: { url: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: { url: string }) => callback(event)
    ipcRenderer.on('browser:openUrlInDock', handler)
    return () => { ipcRenderer.removeListener('browser:openUrlInDock', handler) }
  },
  getSystemStatus: () => ipcRenderer.invoke('system:getStatus'),

  // Process management
  getProcessSnapshot: () => ipcRenderer.invoke('process:getSnapshot'),
  restartManagedProcess: (projectId: string) => ipcRenderer.invoke('process:restart', projectId),
  stopManagedProcess: (projectId: string) => ipcRenderer.invoke('process:stop', projectId),
  forceKillManagedProcess: (projectId: string) => ipcRenderer.invoke('process:forceKill', projectId),
  killOrphanProcess: (pid: number) => ipcRenderer.invoke('process:killOrphan', pid),

  // LAN
  getLanInfo: () => ipcRenderer.invoke('lan:getInfo'),
  getProjectLanUrl: (projectId: string) => ipcRenderer.invoke('projects:getLanUrl', projectId),

  // Data
  queryData: (projectId: string, sql: string) => ipcRenderer.invoke('data:query', projectId, sql),
  getDataSummary: (projectId: string) => ipcRenderer.invoke('data:summary', projectId),
  listAllDatabases: () => ipcRenderer.invoke('data:listAll'),
  queryTable: (projectId: string, tableName: string, page: number, pageSize: number) => ipcRenderer.invoke('data:queryTable', projectId, tableName, page, pageSize),
  getTableSchema: (projectId: string) => ipcRenderer.invoke('data:getSchema', projectId),

  // Settings
  getAISettings: () => ipcRenderer.invoke('settings:getAI'),
  saveAISettings: (config: AISettings) => ipcRenderer.invoke('settings:saveAI', config),
  getProviders: () => ipcRenderer.invoke('settings:getProviders'),
  saveProviders: (config: AIProvidersConfig) => ipcRenderer.invoke('settings:saveProviders', config),
  onProvidersChanged: (callback: (config: AIProvidersConfig) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, config: AIProvidersConfig) => callback(config)
    ipcRenderer.on('settings:providersChanged', handler)
    return () => { ipcRenderer.removeListener('settings:providersChanged', handler) }
  },
  getThemePreference: () => ipcRenderer.invoke('settings:getThemePreference'),
  saveThemePreference: (preference: ThemePreference) => ipcRenderer.invoke('settings:saveThemePreference', preference),
  getLocalePreference: () => ipcRenderer.invoke('settings:getLanguagePreference'),
  saveLocalePreference: (preference: LanguagePreference) => ipcRenderer.invoke('settings:saveLanguagePreference', preference),
  getAIExecutionPreferences: () => ipcRenderer.invoke('settings:getAIExecutionPreferences'),
  saveAIExecutionPreferences: (preferences: AIExecutionPreferences) => ipcRenderer.invoke('settings:saveAIExecutionPreferences', preferences),
  getChatFontPreferences: () => ipcRenderer.invoke('settings:getChatFontPreferences'),
  saveChatFontPreferences: (preferences: ChatFontPreferences) => ipcRenderer.invoke('settings:saveChatFontPreferences', preferences),
  getMcpServers: () => ipcRenderer.invoke('settings:getMcpServers'),
  saveMcpServers: (servers: MCPServerConfig[]) => ipcRenderer.invoke('settings:saveMcpServers', servers),
  getMcpState: () => ipcRenderer.invoke('settings:getMcpState'),
  refreshMcpServer: (serverId?: string) => ipcRenderer.invoke('settings:refreshMcpServer', serverId),
  disconnectMcpServer: (serverId: string) => ipcRenderer.invoke('settings:disconnectMcpServer', serverId),
  onMcpStateChanged: (callback: (state: MCPStateSnapshot) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: MCPStateSnapshot) => callback(state)
    ipcRenderer.on('settings:mcpStateChanged', handler)
    return () => { ipcRenderer.removeListener('settings:mcpStateChanged', handler) }
  },
  listAILogConversations: () => ipcRenderer.invoke('settings:listAILogConversations'),
  getAILogConversation: (conversationId: string) => ipcRenderer.invoke('settings:getAILogConversation', conversationId),
  deleteAILogConversation: (conversationId: string) => ipcRenderer.invoke('settings:deleteAILogConversation', conversationId),
  exportAppConfig: () => ipcRenderer.invoke('settings:exportConfig'),
  importAppConfig: () => ipcRenderer.invoke('settings:importConfig'),
  getLaunchMode: (projectId: string) => ipcRenderer.invoke('settings:getLaunchMode', projectId),
  saveLaunchMode: (projectId: string, mode: 'embed' | 'window') => ipcRenderer.invoke('settings:saveLaunchMode', projectId, mode),
  getLaunchpadLayout: () => ipcRenderer.invoke('settings:getLaunchpadLayout'),
  saveLaunchpadLayout: (layout: LaunchpadLayout) => ipcRenderer.invoke('settings:saveLaunchpadLayout', layout),
  getWebApps: () => ipcRenderer.invoke('settings:getWebApps'),
  saveWebApps: (webApps: WebAppShortcut[]) => ipcRenderer.invoke('settings:saveWebApps', webApps),
  getPinnedDockApps: () => ipcRenderer.invoke('settings:getPinnedDockApps'),
  savePinnedDockApps: (apps: PinnedDockApp[]) => ipcRenderer.invoke('settings:savePinnedDockApps', apps),
  listScheduledTasks: () => ipcRenderer.invoke('scheduler:listTasks'),
  saveScheduledTask: (task: ScheduledTaskDefinition) => ipcRenderer.invoke('scheduler:saveTask', task),
  deleteScheduledTask: (taskId: string) => ipcRenderer.invoke('scheduler:deleteTask', taskId),
  runScheduledTaskNow: (taskId: string) => ipcRenderer.invoke('scheduler:runNow', taskId),
  listScheduledTaskReports: (taskId?: string) => ipcRenderer.invoke('scheduler:listReports', taskId),
  getScheduledTaskReport: (reportId: string) => ipcRenderer.invoke('scheduler:getReport', reportId),
  onScheduledTasksChanged: (callback: (tasks: ScheduledTaskDefinition[]) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, tasks: ScheduledTaskDefinition[]) => callback(tasks)
    ipcRenderer.on('scheduler:tasksChanged', handler)
    return () => { ipcRenderer.removeListener('scheduler:tasksChanged', handler) }
  },
  onScheduledTaskReportsChanged: (callback: (reports: ScheduledTaskRunReport[]) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, reports: ScheduledTaskRunReport[]) => callback(reports)
    ipcRenderer.on('scheduler:reportsChanged', handler)
    return () => { ipcRenderer.removeListener('scheduler:reportsChanged', handler) }
  },
  onScheduledTaskReportRequested: (callback: (report: ScheduledTaskRunReport) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, report: ScheduledTaskRunReport) => callback(report)
    ipcRenderer.on('scheduler:reportRequested', handler)
    return () => { ipcRenderer.removeListener('scheduler:reportRequested', handler) }
  },
  listLongTermGoals: () => ipcRenderer.invoke('longTermGoals:list'),
  getLongTermGoalSnapshot: (goalId?: string) => ipcRenderer.invoke('longTermGoals:getSnapshot', goalId),
  saveLongTermGoal: (goal: LongTermGoalSaveInput) => ipcRenderer.invoke('longTermGoals:save', goal),
  renameLongTermGoal: (goalId: string, title: string) => ipcRenderer.invoke('longTermGoals:rename', goalId, title),
  setLongTermGoalStatus: (goalId: string, status: LongTermGoalDefinition['status']) => ipcRenderer.invoke('longTermGoals:setStatus', goalId, status),
  deleteLongTermGoal: (goalId: string) => ipcRenderer.invoke('longTermGoals:delete', goalId),
  runLongTermGoalNow: (goalId: string) => ipcRenderer.invoke('longTermGoals:runNow', goalId),
  sendLongTermGoalMessage: (goalId: string, content: string) => ipcRenderer.invoke('longTermGoals:message', goalId, content),
  streamLongTermGoalMessage: (goalId: string, content: string, streamId: string) => ipcRenderer.invoke('longTermGoals:streamMessage', goalId, content, streamId),
  streamLongTermGoalCreate: (content: string, options: { providerId?: string | null; modelId?: string | null; selectedMcpServerIds?: string[] } | undefined, streamId: string) => ipcRenderer.invoke('longTermGoals:streamCreate', content, options, streamId),
  applyLongTermGoalChangeSet: (changeSetId: string) => ipcRenderer.invoke('longTermGoals:applyChangeSet', changeSetId),
  cancelLongTermGoalChangeSet: (changeSetId: string) => ipcRenderer.invoke('longTermGoals:cancelChangeSet', changeSetId),
  applyLongTermGoalCreation: (changeSetId: string) => ipcRenderer.invoke('longTermGoals:applyCreation', changeSetId),
  cancelLongTermGoalCreation: (changeSetId: string) => ipcRenderer.invoke('longTermGoals:cancelCreation', changeSetId),
  answerLongTermGoalIntervention: (goalId: string, interventionId: string, answers: Array<{ questionId: string; selectedOption?: string | null; customAnswer?: string | null }>, streamId?: string) => ipcRenderer.invoke('longTermGoals:answerIntervention', goalId, interventionId, answers, streamId),
  onLongTermGoalsChanged: (callback: (goals: LongTermGoalDefinition[]) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, goals: LongTermGoalDefinition[]) => callback(goals)
    ipcRenderer.on('longTermGoals:goalsChanged', handler)
    return () => { ipcRenderer.removeListener('longTermGoals:goalsChanged', handler) }
  },
  onLongTermGoalSnapshotChanged: (callback: (snapshot: LongTermGoalSnapshot) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, snapshot: LongTermGoalSnapshot) => callback(snapshot)
    ipcRenderer.on('longTermGoals:snapshotChanged', handler)
    return () => { ipcRenderer.removeListener('longTermGoals:snapshotChanged', handler) }
  },
  onLongTermGoalInterventionRequested: (callback: (intervention: LongTermGoalIntervention) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, intervention: LongTermGoalIntervention) => callback(intervention)
    ipcRenderer.on('longTermGoals:interventionRequested', handler)
    return () => { ipcRenderer.removeListener('longTermGoals:interventionRequested', handler) }
  },
  onLongTermGoalStreamEvent: (streamId: string, callback: (event: LongTermGoalStreamEvent) => void) => {
    const channel = `longTermGoals:stream-event:${streamId}`
    const handler = (_e: Electron.IpcRendererEvent, event: LongTermGoalStreamEvent) => callback(event)
    ipcRenderer.on(channel, handler)
    return () => { ipcRenderer.removeListener(channel, handler) }
  },
  onLongTermGoalRunProgress: (callback: (payload: { goalId: string; run: LongTermGoalRun }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { goalId: string; run: LongTermGoalRun }) => callback(payload)
    ipcRenderer.on('longTermGoals:runProgress', handler)
    return () => { ipcRenderer.removeListener('longTermGoals:runProgress', handler) }
  },

  // Plan Mode
  setPlanMode: (active: boolean) => ipcRenderer.invoke('ai:setPlanMode', active),

  // Cost Settings
  getCostSettings: () => ipcRenderer.invoke('settings:getCostSettings'),
  saveCostSettings: (settings: CostSettings) => ipcRenderer.invoke('settings:saveCostSettings', settings),

  // Skills
  listSkills: () => ipcRenderer.invoke('skills:list'),
  importSkills: () => ipcRenderer.invoke('skills:import'),
  importSkillContent: (name: string, content: string, description?: string) => ipcRenderer.invoke('skills:importContent', name, content, description),
  deleteSkill: (id: string) => ipcRenderer.invoke('skills:delete', id),
  setActiveSkills: (skillIds: string[]) => ipcRenderer.invoke('skills:setActive', skillIds),
  onSkillsChanged: (callback: (event: { action: string; count?: number; id?: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: { action: string; count?: number; id?: string }) => callback(event)
    ipcRenderer.on('skills:changed', handler)
    return () => { ipcRenderer.removeListener('skills:changed', handler) }
  },

  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  getWindowBounds: () => ipcRenderer.invoke('window:getBounds'),
  ensureWindowWidth: (minimumWidth: number, options?: { animate?: boolean; durationMs?: number; allowShrink?: boolean }) => ipcRenderer.invoke('window:ensureWidth', minimumWidth, options),
  setMinimumWindowWidth: (minimumWidth: number) => ipcRenderer.invoke('window:setMinimumWidth', minimumWidth),

  // Auth (in-app authorization dialogs)
  onAuthRequest: (callback: (request: { requestId: string; conversationId?: string; sessionId?: string; title: string; detail: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, request: { requestId: string; conversationId?: string; sessionId?: string; title: string; detail: string }) => callback(request)
    ipcRenderer.on('auth:request', handler)
    return () => { ipcRenderer.removeListener('auth:request', handler) }
  },
  onAuthResolved: (callback: (payload: { requestId: string; approved: boolean }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { requestId: string; approved: boolean }) => callback(payload)
    ipcRenderer.on('auth:resolved', handler)
    return () => { ipcRenderer.removeListener('auth:resolved', handler) }
  },
  respondAuth: (requestId: string, approved: boolean) => {
    ipcRenderer.send('auth:response', { requestId, approved })
  },
  onSudoPasswordRequest: (callback: (req: { requestId: string; conversationId?: string; sessionId?: string; command: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, req: { requestId: string; conversationId?: string; sessionId?: string; command: string }) => callback(req)
    ipcRenderer.on('auth:sudo-request', handler)
    return () => { ipcRenderer.removeListener('auth:sudo-request', handler) }
  },
  respondSudoPassword: (requestId: string, password: string | null) => {
    ipcRenderer.send('auth:sudo-response', { requestId, password })
  },
  onAskUserRequest: (callback: (request: { requestId: string; conversationId?: string; sessionId?: string; questions: Array<{ id: string; question: string; options: string[] }> }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, request: { requestId: string; conversationId?: string; sessionId?: string; questions: Array<{ id: string; question: string; options: string[] }> }) => callback(request)
    ipcRenderer.on('askUser:request', handler)
    return () => { ipcRenderer.removeListener('askUser:request', handler) }
  },
  respondAskUser: (requestId: string, answers: Array<{ questionId: string; selectedOption: string | null; customAnswer: string | null }> | null) => {
    ipcRenderer.send('askUser:response', { requestId, answers })
  },

  // Document import / preview / selection
  pickDocumentFiles: () => ipcRenderer.invoke('document:pickFiles'),
  pickOfficeFiles: () => ipcRenderer.invoke('office:pickFiles'),
  importDocument: (filePath: string) => ipcRenderer.invoke('document:import', filePath),
  listDocuments: () => ipcRenderer.invoke('document:list'),
  getDocument: (artifactId: string) => ipcRenderer.invoke('document:get', artifactId),
  ensureDocumentRenderPreview: (artifactId: string) => ipcRenderer.invoke('document:ensureRenderPreview', artifactId),
  getDocumentRenderData: (artifactId: string) => ipcRenderer.invoke('document:getRenderData', artifactId),
  openDocumentOriginal: (artifactId: string) => ipcRenderer.invoke('document:openOriginal', artifactId),
  removeDocument: (artifactId: string) => ipcRenderer.invoke('document:remove', artifactId),
  createDocumentSelection: (payload: { artifactId: string; nodeIds: string[]; label: string; color: string; excerpt?: string }) => ipcRenderer.invoke('document:createSelection', payload),
  removeDocumentSelection: (regionId: string) => ipcRenderer.invoke('document:removeSelection', regionId),
  updateDocumentSelectionLabel: (regionId: string, label: string) => ipcRenderer.invoke('document:updateSelectionLabel', regionId, label),
  getDocumentSelections: (artifactId: string) => ipcRenderer.invoke('document:getSelections', artifactId),
  buildDocumentSelectionsPrompt: (regionIds?: string[]) => ipcRenderer.invoke('document:buildSelectionsPrompt', regionIds),

  // Folder workspace preview
  pickFolderWorkspace: () => ipcRenderer.invoke('folderWorkspace:pickFolder'),
  listFolderWorkspaceFiles: (rootPath: string) => ipcRenderer.invoke('folderWorkspace:listFiles', rootPath),
  readFolderWorkspaceFile: (rootPath: string, filePath: string) => ipcRenderer.invoke('folderWorkspace:readFile', rootPath, filePath),
  onFolderWorkspaceChanged: (callback: (event: FolderWorkspaceChangeEvent) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: FolderWorkspaceChangeEvent) => callback(event)
    ipcRenderer.on('folderWorkspace:changed', handler)
    return () => { ipcRenderer.removeListener('folderWorkspace:changed', handler) }
  }
} satisfies ElectronAPI)
