/// <reference types="vite/client" />

type ConversationMetadataPatch = import('./shared/conversation-metadata.js').ConversationMetadataPatch

type ActivePageAutomationContext = import('./shared/page-automation-types.js').ActivePageAutomationContext
type AppAboutInfo = import('./shared/app-update-types.js').AppAboutInfo
type AppUpdateChannel = import('./shared/app-update-types.js').AppUpdateChannel
type AppUpdateConfig = import('./shared/app-update-types.js').AppUpdateConfig
type AppUpdateState = import('./shared/app-update-types.js').AppUpdateState
type AppUpdateWebsiteKind = import('./shared/app-update-types.js').AppUpdateWebsiteKind
type PageAutomationRequestEnvelope = import('./shared/page-automation-types.js').PageAutomationRequestEnvelope
type PageAutomationResponseEnvelope = import('./shared/page-automation-types.js').PageAutomationResponseEnvelope
type ImageStudioGenerateRequest = import('./shared/image-studio-types.js').ImageStudioGenerateRequest
type ImageStudioGenerateResponse = import('./shared/image-studio-types.js').ImageStudioGenerateResponse
type ImageStudioTask = import('./shared/image-studio-types.js').ImageStudioTask
type UsageRecord = import('./main/settings/usage-store.js').UsageRecord
type UsageSummary = import('./main/settings/usage-store.js').UsageSummary
type ImageLibraryEntry = import('./shared/image-studio-types.js').ImageLibraryEntry
type ImageLibraryItem = import('./shared/image-studio-types.js').ImageLibraryItem
type ImageLibraryPage = import('./shared/image-studio-types.js').ImageLibraryPage
type ImageLibraryQuery = import('./shared/image-studio-types.js').ImageLibraryQuery
type ImageLibraryData = import('./shared/image-studio-types.js').ImageLibraryData
type ImageLibraryFolderCard = import('./shared/image-studio-types.js').ImageLibraryFolderCard
type MemoryCompactionResult = import('./shared/agent-workspace-types.js').MemoryCompactionResult
type MemoryCompactionStatus = import('./shared/agent-workspace-types.js').MemoryCompactionStatus
type ConversationFolderWorkspaceState = import('./shared/folder-workspace-types.js').ConversationFolderWorkspaceState
type FolderWorkspaceChangeEvent = import('./shared/folder-workspace-types.js').FolderWorkspaceChangeEvent
type FolderWorkspaceFileEntry = import('./shared/folder-workspace-types.js').FolderWorkspaceFileEntry
type FolderWorkspaceListResult = import('./shared/folder-workspace-types.js').FolderWorkspaceListResult
type FolderWorkspacePickResult = import('./shared/folder-workspace-types.js').FolderWorkspacePickResult
type FolderWorkspaceReadResult = import('./shared/folder-workspace-types.js').FolderWorkspaceReadResult
type DocumentEditOperation = import('./shared/document-edit-types.js').DocumentEditOperation
type DocumentEditExportRequest = import('./shared/document-edit-types.js').DocumentEditExportRequest
type DocumentEditExportResult = import('./shared/document-edit-types.js').DocumentEditExportResult
type DocumentEditImagePickResult = import('./shared/document-edit-types.js').DocumentEditImagePickResult
type DocumentEditSourceState = import('./shared/document-edit-types.js').DocumentEditSourceState
type LongTermGoalDefinition = import('./shared/long-term-goal-types.js').LongTermGoalDefinition
type LongTermGoalSaveInput = import('./shared/long-term-goal-types.js').LongTermGoalSaveInput
type LongTermGoalSnapshot = import('./shared/long-term-goal-types.js').LongTermGoalSnapshot
type LongTermGoalChangeSet = import('./shared/long-term-goal-types.js').LongTermGoalChangeSet
type LongTermGoalIntervention = import('./shared/long-term-goal-types.js').LongTermGoalIntervention
type LongTermGoalMessageResult = import('./shared/long-term-goal-types.js').LongTermGoalMessageResult
type LongTermGoalRun = import('./shared/long-term-goal-types.js').LongTermGoalRun
type LongTermGoalActivityEvent = import('./shared/long-term-goal-types.js').LongTermGoalActivityEvent
type LongTermGoalStreamEvent = import('./shared/long-term-goal-types.js').LongTermGoalStreamEvent

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

interface StreamEvent {
  type: 'token' | 'thinking' | 'tool_start' | 'tool_end' | 'progress' | 'todo_update' | 'file_preview_start' | 'file_preview_end' | 'group_collaboration_plan' | 'group_session_state' | 'group_progress' | 'group_transcript' | 'agent_sidechat' | 'group_board' | 'group_direct_reply' | 'group_user_injection' | 'group_peer_message' | 'web_search_result' | 'web_fetch_result' | 'reset' | 'done' | 'error' | 'stopped'
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
  lineCount?: number
  added?: number
  removed?: number
  groupId?: string
  active?: boolean
  plan?: AgentGroupCollaborationPlan
  groupProgress?: AgentGroupProgressSnapshot
  transcript?: AgentGroupTranscript
  sidechat?: AgentSidechatSession
  board?: SharedBoardSnapshot
  directReply?: AgentGroupDirectReply
  injection?: AgentGroupUserInjection
  peerMessage?: AgentGroupMessage
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
  forkedFromConversationId?: string
  forkedFromMessageId?: string
  rootConversationId?: string
  forkDepth?: number
  forkedAt?: string
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

type AgentReasoningStrength = 'low' | 'medium' | 'high' | 'max'
type AgentMemoryScope = 'user' | 'agent' | 'project' | 'group' | 'channel'
type MemoryType = 'user_trait' | 'agent_skill' | 'step' | 'knowledge'
type ConnectorType = 'feishu' | 'wechat' | 'wecom' | 'slack' | 'discord' | 'telegram' | 'custom'

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

type AgentGroupCollaborationMode = 'coordinator_only' | 'targeted' | 'discussion' | 'coordinator_decides' | 'mentioned_agent_decides'
type AgentGroupCollaborationPhase = 'planning' | 'executing' | 'completed'

interface AgentGroupParticipant {
  agentId: string
  agentName: string
}

interface AgentGroupCollaborationPlan {
  groupId: string
  groupName: string
  mode: AgentGroupCollaborationMode
  phase: AgentGroupCollaborationPhase
  planner: AgentGroupParticipant
  reportToName: string
  originalRequest: string
  normalizedRequest: string
  reason: string
  round?: number
  mentionedParticipants: AgentGroupParticipant[]
  candidateParticipants: AgentGroupParticipant[]
  invitedParticipants: AgentGroupParticipant[]
  updatedAt: string
}

interface AgentGroupTranscriptToolCall {
  name: string
  summary: string
  status: 'completed' | 'failed'
}

interface AgentGroupTranscriptEntry {
  id: string
  round: number
  agentId: string
  agentName: string
  content: string
  toolCalls?: AgentGroupTranscriptToolCall[]
  peerMessages?: Array<{ toAgentName: string; request: string; response: string }>
  directReply?: boolean
  boardFields?: SharedBoardUpdate['field'][]
}

interface AgentGroupTranscript {
  groupId: string
  groupName: string
  request: string
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
  request: string
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
  mode: 'user_targeted' | 'coordinator_assigned' | 'group_deliberation' | 'peer_message' | 'direct_reply'
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

interface AgentGroupMessage {
  id: string
  groupId: string
  fromAgentId: string
  fromAgentName: string
  toAgentId: string
  toAgentName: string
  request: string
  response: string
  status: 'pending' | 'completed' | 'failed' | 'timeout' | 'rejected'
  round: number
  createdAt: string
  resolvedAt?: string
  error?: string
}

interface SharedBoardTask {
  id: string
  title: string
  ownerAgentId?: string
  status: 'todo' | 'running' | 'blocked' | 'done'
  summary?: string
}

interface SharedBoard {
  goal: string
  assumptions: string[]
  tasks: SharedBoardTask[]
  decisions: string[]
  evidenceRefs: string[]
  openQuestions: string[]
}

interface SharedBoardUpdate {
  id: string
  groupId: string
  agentId: string
  agentName: string
  field: 'goal' | 'assumptions' | 'tasks' | 'decisions' | 'evidenceRefs' | 'openQuestions'
  op: 'set' | 'add' | 'update' | 'remove'
  payload: unknown
  reason?: string
  at: string
}

interface SharedBoardSnapshot {
  groupId: string
  groupName: string
  board: SharedBoard
  recentUpdates: SharedBoardUpdate[]
  updatedAt: string
}

interface AgentGroupDirectReply {
  id: string
  groupId: string
  groupName: string
  agentId: string
  agentName: string
  content: string
  round: number
  endorsed: boolean
  at: string
}

interface AgentGroupUserInjection {
  id: string
  groupId: string
  groupName: string
  content: string
  targetAgentIds: string[]
  round: number
  at: string
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
  incomingWebhookPath: string
  credentialFields: Array<{
    key: keyof Pick<ChannelBinding, 'incomingSecret' | 'outgoingWebhookUrl' | 'appId' | 'appSecret' | 'verificationToken' | 'encryptKey' | 'botUserId'>
    label: string
    secret?: boolean
    placeholder?: string
  }>
}

interface ChannelBinding {
  id: string
  connectorType: ConnectorType
  name?: string
  externalChannelId: string
  externalThreadId?: string
  boundConversationId?: string
  boundGroupId?: string
  defaultAgentId?: string
  targetProjectId?: string | null
  incomingSecret?: string
  outgoingWebhookUrl?: string
  appId?: string
  appSecret?: string
  verificationToken?: string
  encryptKey?: string
  botUserId?: string
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
  | { id: string; kind: 'file_preview'; filePath: string; lineCount: number; added: number; removed: number; active: boolean }
  | { id: string; kind: 'group_collaboration_plan'; plan: AgentGroupCollaborationPlan }
  | { id: string; kind: 'agent_sidechat'; session: AgentSidechatSession }
  | { id: string; kind: 'group_progress'; snapshot: AgentGroupProgressSnapshot }
  | { id: string; kind: 'group_transcript'; transcript: AgentGroupTranscript }
  | { id: string; kind: 'group_board'; board: SharedBoardSnapshot }
  | { id: string; kind: 'group_direct_reply'; directReply: AgentGroupDirectReply }
  | { id: string; kind: 'group_user_injection'; injection: AgentGroupUserInjection }
  | { id: string; kind: 'group_peer_message'; peerMessage: AgentGroupMessage }
  | { id: string; kind: 'web_search'; query: string; engine: string; results: WebSearchResultItem[] }
  | { id: string; kind: 'web_fetch'; query?: string; result: WebFetchResultEntry }
  | { id: string; kind: 'attachment'; fileName: string; fileType: string; fileSizeLabel: string; previewText: string }
  | { id: string; kind: 'auth_request'; requestId: string; title: string; detail: string; status: 'pending' | 'approved' | 'denied' }
  | { id: string; kind: 'sudo_password_request'; requestId: string; command: string; status: 'pending' | 'submitted' | 'canceled' }

interface ConversationData extends ConversationSummary {
  messages: Array<{
    role: string
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
    id?: string
    thinking?: string
    speakerName?: string
    modelLabel?: string
    toolRuns?: ToolRun[]
    blocks?: ChatMessageBlock[]
  }>
  documentWorkspace?: ConversationDocumentWorkspaceState
  folderWorkspace?: ConversationFolderWorkspaceState
}

interface AIProviderConfig {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  apiProtocol?: '' | 'openai-chat' | 'openai-responses' | 'anthropic'
  detectedApiProtocol?: 'openai-chat' | 'openai-responses' | 'anthropic'
  models: string[]
  modelContextWindows?: Record<string, number>
  modelCapabilities?: Record<string, { imageGeneration?: boolean; imageEditing?: boolean }>
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

interface AIExecutionPreferences {
  notifyOnTaskComplete: boolean
  enableAiLogging: boolean
  harnessBackend: 'ts' | 'rust'
}

interface ChatFontPreferences {
  fontFamily: string
  fontSize: number
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

type MessageContent = string | Array<{
  type: string
  text?: string
  image_url?: { url: string }
  thinking?: string
  signature?: string
  data?: string
}>

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
  /** Number of files in the skill package */
  fileCount: number
  /** File type breakdown */
  files: Array<{ relativePath: string; type: string; size: number }>
  /** Executable scripts detected */
  scripts: Array<{ relativePath: string; language: string }>
  /** Tools/capabilities provided by this skill */
  tools: string[]
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
  filePath: string
  fileName: string
  fileType: DocumentFileType
  fileSize: number
  nodeCount: number
  selectionCount: number
  importedAt: string
}

interface ElectronAPI {
  // AI
  chat: (messages: Array<{ role: string; content: MessageContent }>, providerId?: string, modelId?: string, reasoningStrength?: 'low' | 'medium' | 'high' | 'max', agentId?: string, groupId?: string, channelBindingId?: string, targetProjectId?: string, activePageContext?: ActivePageAutomationContext, folderWorkspaceRoot?: string) => Promise<{ role: string; content: MessageContent }>
  chatStream: (messages: Array<{ role: string; content: MessageContent }>, sessionId: string, conversationId?: string, providerId?: string, modelId?: string, targetProjectId?: string, authMode?: AIExecutionAuthMode, reasoningStrength?: 'low' | 'medium' | 'high' | 'max', agentId?: string, groupId?: string, channelBindingId?: string, activePageContext?: ActivePageAutomationContext, temperature?: number, folderWorkspaceRoot?: string, computerUseEnabled?: boolean) => Promise<{ ok: boolean }>
  updateChatSessionAuthMode: (sessionId: string, authMode: AIExecutionAuthMode) => Promise<{ ok: boolean; updated: boolean }>
  stopChatStream: (sessionId: string) => Promise<{ ok: boolean; stopped: boolean }>
  injectGroupClarification: (sessionId: string, groupId: string, content: string, targetAgentIds?: string[]) => Promise<{ ok: boolean; injected: boolean; injection?: AgentGroupUserInjection; error?: string }>
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
  setPlanMode: (active: boolean) => Promise<{ success: boolean }>

  // Conversations
  listConversations: () => Promise<ConversationSummary[]>
  getConversation: (id: string) => Promise<ConversationData | null>
  saveConversation: (conversation: ConversationData) => Promise<{ success: boolean; summary?: ConversationSummary }>
  updateConversationMetadata: (id: string, patch: ConversationMetadataPatch) => Promise<{ success: boolean; summary: ConversationSummary | null }>
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
  onImageLibraryChanged: (callback: (payload: { source?: string }) => void) => () => void
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
  getComputerUsePermissions: () => Promise<import('./shared/computer-use-permissions').ComputerUsePermissionStatus>
  requestComputerUsePermissions: (target?: import('./shared/computer-use-permissions').ComputerUsePermissionTarget) => Promise<{ granted: boolean }>

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
  fetchProviderModels: (input: { baseUrl: string; apiKey: string; apiProtocol?: '' | 'openai-chat' | 'openai-responses' | 'anthropic' }) => Promise<{ models: string[] }>
  detectProviderProtocol: (input: { baseUrl: string; apiKey: string; model: string }) => Promise<{ protocol: 'openai-chat' | 'openai-responses' | 'anthropic' | null; probes: Array<{ protocol: string; ok: boolean; error?: string }> }>
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
  deleteLongTermGoalMemory: (goalId: string, memoryId: string) => Promise<LongTermGoalSnapshot>
  runLongTermGoalNow: (goalId: string) => Promise<ScheduledTaskRunReport>
  compactLongTermGoalMemory: (goalId: string, streamId?: string) => Promise<LongTermGoalSnapshot>
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
  importDocument: (filePath: string) => Promise<{ artifact: DocumentArtifactDTO }>
  listDocuments: () => Promise<DocumentSummaryDTO[]>
  getDocument: (artifactId: string) => Promise<DocumentArtifactDTO | null>
  ensureDocumentRenderPreview: (artifactId: string) => Promise<DocumentArtifactDTO | null>
  getDocumentRenderData: (artifactId: string) => Promise<{ mimeType: string; bytes: Uint8Array } | null>
  openDocumentOriginal: (artifactId: string) => Promise<{ success: boolean; supported?: boolean; error?: string }>
  removeDocument: (artifactId: string) => Promise<boolean>
  createDocumentSelection: (payload: { artifactId: string; nodeIds: string[]; label: string; color: string; excerpt?: string }) => Promise<DocumentSelectionDTO>
  removeDocumentSelection: (regionId: string) => Promise<boolean>
  updateDocumentSelectionLabel: (regionId: string, label: string) => Promise<DocumentSelectionDTO | null>
  getDocumentSelections: (artifactId: string) => Promise<DocumentSelectionDTO[]>
  buildDocumentSelectionsPrompt: (regionIds?: string[]) => Promise<string>
  getDocumentEditSourceState: (artifactId: string) => Promise<DocumentEditSourceState>
  pickDocumentEditImage: () => Promise<DocumentEditImagePickResult>
  exportDocumentEditCopy: (request: DocumentEditExportRequest) => Promise<DocumentEditExportResult>

  // Folder workspace preview
  pickFolderWorkspace: () => Promise<FolderWorkspacePickResult>
  listFolderWorkspaceFiles: (rootPath: string) => Promise<FolderWorkspaceListResult>
  readFolderWorkspaceFile: (rootPath: string, filePath: string) => Promise<FolderWorkspaceReadResult>
  onFolderWorkspaceChanged: (callback: (event: FolderWorkspaceChangeEvent) => void) => () => void
}

interface Window {
  electronAPI?: ElectronAPI
}

// Local Font Access API — typed here because the bundled TS lib.dom.d.ts does
// not yet ship these declarations. `queryLocalFonts` requires the `local-fonts`
// permission; callers must handle rejection / empty results with a fallback.
interface FontData {
  readonly family: string
  readonly fullName: string
  readonly postscriptName: string
  readonly style: string
}

interface Window {
  queryLocalFonts?: (options?: { postscriptNames?: string[] }) => Promise<FontData[]>
}
