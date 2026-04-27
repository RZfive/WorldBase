/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

interface StreamEvent {
  type: 'token' | 'thinking' | 'tool_start' | 'tool_end' | 'progress' | 'todo_update' | 'file_preview_start' | 'file_preview_chunk' | 'file_preview_end' | 'group_progress' | 'group_transcript' | 'agent_sidechat' | 'web_search_result' | 'web_fetch_result' | 'reset' | 'done' | 'error' | 'stopped'
  content?: string
  name?: string
  message?: { role: string; content: MessageContent }
  thinking?: string
  error?: string
  stage?: string
  detail?: string
  items?: TodoItem[]
  filePath?: string
  truncated?: boolean
  groupProgress?: AgentGroupProgressSnapshot
  transcript?: AgentGroupTranscript
  sidechat?: AgentSidechatSession
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
  reasoningStrength?: 'low' | 'medium' | 'high' | 'max'
  targetProjectId?: string
  agentId?: string
  groupId?: string
  channelBindingId?: string
}

type AgentReasoningStrength = 'low' | 'medium' | 'high' | 'max'
type AgentMemoryScope = 'user' | 'agent' | 'project' | 'group' | 'channel'
type MemoryType = 'user_trait' | 'agent_skill' | 'step' | 'knowledge'
type ConnectorType = 'feishu' | 'wecom' | 'slack' | 'discord' | 'telegram' | 'custom'

interface AgentMemoryWritePolicy {
  allowUserTraits: boolean
  allowAgentSkills: boolean
  allowSteps: boolean
  allowKnowledge: boolean
}

interface AgentAutoReplyPolicy {
  enabled: boolean
  requireMention: boolean
}

interface AgentDefinition {
  id: string
  name: string
  icon?: string
  description: string
  systemPrompt: string
  providerId?: string
  modelId?: string
  reasoningStrength?: AgentReasoningStrength
  skillIds: string[]
  allowedTools?: string[]
  deniedTools?: string[]
  memoryScopes: AgentMemoryScope[]
  memoryWritePolicy: AgentMemoryWritePolicy
  autoReplyPolicy?: AgentAutoReplyPolicy
  createdAt: string
  updatedAt: string
}

interface AgentGroupDefinition {
  id: string
  name: string
  icon?: string
  description?: string
  coordinatorAgentId: string
  memberAgentIds: string[]
  maxRounds: number
  maxParallelWorkers: number
  sharedMemoryScopes: Array<'group' | 'project' | 'channel'>
  visibility: 'summary_only' | 'expandable_internal_transcript'
  createdAt: string
  updatedAt: string
}

interface AgentGroupTranscriptEntry {
  id: string
  round: number
  agentId: string
  agentName: string
  content: string
}

interface AgentGroupTranscript {
  groupId: string
  groupName: string
  visibility: AgentGroupDefinition['visibility']
  roundCount: number
  entryCount: number
  summary: string
  entries: AgentGroupTranscriptEntry[]
}

interface AgentGroupProgressStep {
  at: string
  stage: string
  detail?: string
}

interface AgentGroupProgressItem {
  id: string
  agentId: string
  agentName: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  currentRound: number
  completedRounds: number
  totalRounds: number
  stage: string
  detail?: string
  summary?: string
  updatedAt: string
  progress: AgentGroupProgressStep[]
}

interface AgentGroupProgressSnapshot {
  groupId: string
  groupName: string
  status: 'running' | 'completed' | 'failed'
  activeRound: number
  totalRounds: number
  maxParallelWorkers: number
  queuedCount: number
  runningCount: number
  completedCount: number
  failedCount: number
  items: AgentGroupProgressItem[]
}

interface AgentSidechatSession {
  id: string
  groupId: string
  groupName: string
  agentId: string
  agentName: string
  mode: 'user_targeted' | 'coordinator_assigned' | 'group_deliberation'
  initiatedByName: string
  reportToName: string
  request: string
  response: string
  status: 'running' | 'completed' | 'failed'
  round: number
  updatedAt: string
  error?: string
  progress: AgentGroupProgressStep[]
}

interface MemorySearchScope {
  scopeType: AgentMemoryScope
  scopeId: string
}

interface MemoryEntry {
  id: string
  scopeType: AgentMemoryScope
  scopeId: string
  memoryType: MemoryType
  title: string
  summary: string
  details?: string
  tags: string[]
  sourceConversationId?: string
  sourceSessionId?: string
  sourceMessageIds?: string[]
  importance: number
  confidence: number
  pinned: boolean
  lastUsedAt?: string
  createdAt: string
  updatedAt: string
}

interface ConnectorDefinition {
  id: ConnectorType
  name: string
  description: string
  supportsThreads: boolean
  supportsMentions: boolean
  supportsAttachments: boolean
}

interface ChannelBinding {
  id: string
  connectorType: ConnectorType
  externalChannelId: string
  externalThreadId?: string
  boundConversationId?: string
  boundGroupId?: string
  defaultAgentId?: string
  targetProjectId?: string | null
  autoReply: boolean
  requireApprovalForRiskyTools: boolean
  createdAt: string
  updatedAt: string
}

interface ToolProgressEntry {
  stage: string
  detail?: string
}

type TodoStatus = 'not-started' | 'in-progress' | 'completed'

interface TodoItem {
  id: number
  title: string
  status: TodoStatus
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
  | { id: string; kind: 'todo'; items: TodoItem[] }
  | { id: string; kind: 'file_preview'; filePath: string; previewContent: string; truncated: boolean; active: boolean }
  | { id: string; kind: 'agent_sidechat'; session: AgentSidechatSession }
  | { id: string; kind: 'group_progress'; snapshot: AgentGroupProgressSnapshot }
  | { id: string; kind: 'group_transcript'; transcript: AgentGroupTranscript }
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

interface CostSettings {
  modelPricing: Array<{
    model: string
    inputPerMillion: number
    outputPerMillion: number
    cacheReadPerMillion: number
  }>
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
  arguments: Array<{
    name: string
    description?: string
    required?: boolean
  }>
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

type ScheduledTaskStatus = 'idle' | 'running' | 'retrying' | 'completed' | 'failed'
type ScheduledTaskRunStatus = 'running' | 'retrying' | 'completed' | 'failed'
type ScheduledTaskTrigger = 'manual' | 'schedule'

interface ScheduledTaskProgressEntry {
  at: string
  stage: string
  detail?: string
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
    kind: 'dates'
    dates: string[]
  }

interface ScheduledTaskDefinition {
  id: string
  title: string
  enabled: boolean
  createdBy: 'manual' | 'ai'
  prompt: string
  schedule: ScheduledTaskSchedule
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
  error?: string
  progress: ScheduledTaskProgressEntry[]
  selectedSkillIds: string[]
  selectedMcpServerIds: string[]
  retryScheduledAt?: string | null
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
  chat: (messages: Array<{ role: string; content: MessageContent }>, providerId?: string, modelId?: string, reasoningStrength?: 'low' | 'medium' | 'high' | 'max', agentId?: string, groupId?: string, channelBindingId?: string, targetProjectId?: string) => Promise<{ role: string; content: MessageContent }>
  chatStream: (messages: Array<{ role: string; content: MessageContent }>, sessionId: string, conversationId?: string, providerId?: string, modelId?: string, targetProjectId?: string, authMode?: AIExecutionAuthMode, reasoningStrength?: 'low' | 'medium' | 'high' | 'max', agentId?: string, groupId?: string, channelBindingId?: string) => Promise<{ ok: boolean }>
  updateChatSessionAuthMode: (sessionId: string, authMode: AIExecutionAuthMode) => Promise<{ ok: boolean; updated: boolean }>
  stopChatStream: (sessionId: string) => Promise<{ ok: boolean; stopped: boolean }>
  onStreamEvent: (sessionId: string, callback: (event: StreamEvent) => void) => () => void
  setPlanMode: (active: boolean) => Promise<{ success: boolean }>

  // Conversations
  listConversations: () => Promise<ConversationSummary[]>
  getConversation: (id: string) => Promise<ConversationData | null>
  saveConversation: (conversation: ConversationData) => Promise<{ success: boolean }>
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
  listMemory: (options?: { query?: string; scopes?: MemorySearchScope[]; memoryTypes?: MemoryType[]; limit?: number; scopeType?: AgentMemoryScope; scopeId?: string }) => Promise<MemoryEntry[]>
  pinMemory: (id: string, pinned: boolean) => Promise<boolean>
  deleteMemory: (id: string) => Promise<boolean>
  saveImageToFile: (imageUrl: string, defaultName?: string) => Promise<{ success?: boolean; canceled?: boolean; filePath?: string }>
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
  getMcpServers: () => Promise<MCPServerConfig[]>
  saveMcpServers: (servers: MCPServerConfig[]) => Promise<{ success: boolean }>
  getMcpState: () => Promise<MCPStateSnapshot>
  refreshMcpServer: (serverId?: string) => Promise<MCPStateSnapshot | MCPServerSnapshot>
  disconnectMcpServer: (serverId: string) => Promise<MCPServerSnapshot>
  onMcpStateChanged: (callback: (state: MCPStateSnapshot) => void) => () => void
  listAILogConversations: () => Promise<AILogConversationSummary[]>
  getAILogConversation: (conversationId: string) => Promise<AILogConversation | null>
  deleteAILogConversation: (conversationId: string) => Promise<boolean>
  getCostSettings: () => Promise<CostSettings>
  saveCostSettings: (settings: CostSettings) => Promise<{ success: boolean }>
  exportAppConfig: () => Promise<{ success: boolean; canceled?: boolean; filePath?: string }>
  importAppConfig: () => Promise<{ success: boolean; canceled?: boolean; filePath?: string; importedAt?: string; requiresReload?: boolean }>
  getLaunchMode: (projectId: string) => Promise<'embed' | 'window'>
  saveLaunchMode: (projectId: string, mode: 'embed' | 'window') => Promise<{ success: boolean }>
  getLaunchpadLayout: () => Promise<LaunchpadLayout>
  saveLaunchpadLayout: (layout: LaunchpadLayout) => Promise<{ success: boolean }>
  getWebApps: () => Promise<WebAppShortcut[]>
  saveWebApps: (webApps: WebAppShortcut[]) => Promise<{ success: boolean }>
  listScheduledTasks: () => Promise<ScheduledTaskDefinition[]>
  saveScheduledTask: (task: ScheduledTaskDefinition) => Promise<ScheduledTaskDefinition>
  deleteScheduledTask: (taskId: string) => Promise<boolean>
  runScheduledTaskNow: (taskId: string) => Promise<ScheduledTaskRunReport>
  listScheduledTaskReports: (taskId?: string) => Promise<ScheduledTaskRunReport[]>
  getScheduledTaskReport: (reportId: string) => Promise<ScheduledTaskRunReport | null>
  onScheduledTasksChanged: (callback: (tasks: ScheduledTaskDefinition[]) => void) => () => void
  onScheduledTaskReportsChanged: (callback: (reports: ScheduledTaskRunReport[]) => void) => () => void
  onScheduledTaskReportRequested: (callback: (report: ScheduledTaskRunReport) => void) => () => void

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
  onAuthRequest: (callback: (request: { requestId: string; conversationId?: string; sessionId?: string; title: string; detail: string }) => void) => () => void
  onAuthResolved: (callback: (payload: { requestId: string; approved: boolean }) => void) => () => void
  respondAuth: (requestId: string, approved: boolean) => void

  // Document import / preview / selection
  pickDocumentFiles: () => Promise<{ canceled: boolean; filePaths: string[] }>
  pickOfficeFiles: () => Promise<{ canceled: boolean; filePaths: string[] }>
  importDocument: (filePath: string) => Promise<{ artifact: DocumentArtifactDTO }>
  listDocuments: () => Promise<DocumentSummaryDTO[]>
  getDocument: (artifactId: string) => Promise<DocumentArtifactDTO | null>
  ensureDocumentRenderPreview: (artifactId: string) => Promise<DocumentArtifactDTO | null>
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
