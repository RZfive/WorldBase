import type {
  AgentDefinition,
  AgentGroupDefinition,
  AgentGroupProgressSnapshot,
  AgentGroupTranscript,
  AgentSidechatSession,
  ChannelBinding
} from '../../../../shared/agent-workspace-types.js'
import type { ActivePageAutomationContext } from '../../../../shared/page-automation-types.js'
import type { ActiveTerminalContext } from '../../../../shared/terminal-types.js'
import type {
  BrowserAutomationAction,
  BrowserAutomationActionResult,
  BrowserAutomationSnapshot
} from '../../../../shared/page-automation-types.js'
import type {
  ChatMessage,
  ChatMessageBlock,
  FilePreviewState,
  MessageContent,
  TodoItem,
  ToolProgressEntry,
  ToolRun,
  WebFetchResultEntry,
  WebSearchResultItem
} from '../types'

export type {
  AgentDefinition,
  AgentGroupDefinition,
  AgentGroupProgressSnapshot,
  AgentGroupTranscript,
  AgentSidechatSession,
  ChannelBinding,
  ChatMessage,
  ChatMessageBlock,
  FilePreviewState,
  MessageContent,
  TodoItem,
  ToolProgressEntry,
  ToolRun,
  WebFetchResultEntry,
  WebSearchResultItem
}

export type AIExecutionAuthMode = 'strict' | 'auto'
export type ReasoningStrength = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  manualTitle?: boolean
  previewText?: string
  authMode?: AIExecutionAuthMode
  providerId?: string
  selectedModel?: string
  reasoningStrength?: ReasoningStrength
  temperature?: number
  targetProjectId?: string
  agentId?: string
  groupId?: string
  channelBindingId?: string
  folderWorkspace?: ConversationFolderWorkspaceState
  /** Tabbed right-side workspace snapshot (folder/document migrate into it). */
  workspace?: ConversationWorkspaceState
  /** 直接父会话 id（fork / 编辑分叉时写入） */
  forkedFromConversationId?: string
  /** 分叉锚点：父会话中被复制前缀的最后一条消息 id */
  forkedFromMessageId?: string
  /** 谱系树根会话 id（同一棵树的会话共享） */
  rootConversationId?: string
  /** 树深度：根为 0，每分叉一层 +1 */
  forkDepth?: number
  /** 分叉时间 */
  forkedAt?: string
}

export interface ChatPanelProps {
  projectContext?: Record<string, unknown> | null
  activePageContext?: ActivePageAutomationContext | null
  activeTerminalContext?: ActiveTerminalContext | null
  computerUseEnabled?: boolean
  /** null until the first macOS permission query lands; false gates the toggle. */
  computerUsePermissionGranted?: boolean | null
  /** Latest AI-originated workspace tab open request; consumed on first watch. */
  workspaceTabRequest?: { kind: string; payload?: Record<string, unknown>; seq: number } | null
  /** Latest AI-staged document draft; consumed on first watch. */
  workspaceDraftRequest?: { payload: { artifactId: string; filePath: string; draftPath: string; fileType: string; sourceSha256: string; createdAt: string }; seq: number } | null
}

export interface ChatPanelEmit {
  (e: 'contextConsumed'): void
  (e: 'workspaceTabRequestConsumed'): void
  (e: 'workspaceDraftRequestConsumed'): void
  (e: 'pageSurfaceChange', surface: WorkspacePageSurfaceSummary | null): void
  (e: 'terminalSurfaceChange', surface: WorkspaceTerminalSurfaceSummary | null): void
  (e: 'openWebLink', url: string): void
  (e: 'statusChange', status: ChatSurfaceStatusSummary): void
  (e: 'openSettings', category?: string, options?: OpenSettingsOptions): void
}

/**
 * Live page state of the active workspace browser tab, forwarded to the app
 * shell so page automation tools can target it when no embedded app page is
 * active.
 */
export interface WorkspacePageSurfaceSummary {
  appId: string
  title: string
  url: string
  handle: {
    captureAutomationSnapshot: () => Promise<BrowserAutomationSnapshot>
    runAutomationAction: (action: BrowserAutomationAction) => Promise<BrowserAutomationActionResult>
  } | null
}

/** Live state of the active workspace terminal tab, forwarded to the app shell. */
export interface WorkspaceTerminalSurfaceSummary {
  sessionId: string
  cwd: string
}

export interface ChatSurfaceStatusSummary {
  contextLabel: string
  contextDetail: string
  isLoading: boolean
  pendingAuthCount: number
  activeTodoCount: number
  primaryTaskTitle: string | null
}

export interface OpenSettingsOptions {
  /** Open the provider panel straight into "use this template" for the given template id. */
  useProviderTemplate?: string
}

export interface SidebarAgentItem {
  id: string
  conversationId: string | null
  title: string
  subtitle: string
  searchText: string
  icon: string
  modelId: string
  providerName: string
  modelOptions: string[]
  isStreaming: boolean
  pendingAuthCount: number
  unreadCount: number
  isActive: boolean
}

export interface SidebarGroupItem {
  id: string
  conversationId: string | null
  title: string
  subtitle: string
  searchText: string
  icon: string
  isStreaming: boolean
  pendingAuthCount: number
  unreadCount: number
  isActive: boolean
}

export interface SidebarConversationItem {
  id: string
  title: string
  subtitle: string
  searchText: string
  icon: string
  isStreaming: boolean
  pendingAuthCount: number
  unreadCount: number
  isActive: boolean
  isFork?: boolean
}

export interface SidebarLongTermGoalItem {
  id: string
  title: string
  subtitle: string
  searchText: string
  icon: string
  status: LongTermGoalDefinition['status']
  isRunning: boolean
  needsUserInput: boolean
  isStreaming: boolean
  pendingAuthCount: number
  unreadCount: number
  isActive: boolean
}

export interface GroupMentionHint {
  token: string
  label: string
  aliases?: string[]
}

export interface ProviderOption {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: string[]
  modelContextWindows?: Record<string, number>
  modelCapabilities?: Record<string, {
    imageGeneration?: boolean
    imageEditing?: boolean
    /** Reasoning effort values the gateway declares this model accepts. */
    reasoningEfforts?: string[]
    defaultReasoningEffort?: string
    /** User-chosen default reasoning strength for this model. */
    reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
    /** Levels the user allows for this model (multi-pick in settings). */
    allowedReasoningEfforts?: string[]
  }>
  activeModel: string
  enableThinking?: boolean
  temperature?: number
}

export interface ProvidersConfig {
  providers: ProviderOption[]
  activeProviderId: string
  enabledProviderIds: string[]
}

export interface PendingAttachment {
  id: string
  name: string
  filePath: string
  fileType: string
  fileSizeLabel: string
  promptContent: string
  previewText: string
}

export interface PendingImage {
  base64: string
  mimeType: string
}

export interface BackgroundStreamState {
  messages: ChatMessage[]
  assistantIdx: number
  targetProjectId: string | null
  authMode: AIExecutionAuthMode
  providerId: string | null
  selectedModel: string | null
  reasoningStrength: ReasoningStrength
  temperature?: number | null
  agentId: string | null
  groupId: string | null
  channelBindingId: string | null
  documentWorkspace?: ConversationDocumentWorkspaceState
  folderWorkspace?: ConversationFolderWorkspaceState
  workspace?: ConversationWorkspaceState
}

export interface UploadedAttachmentResult {
  filePath: string
  fileName: string
  size: number
  fileType: string
  content: string
}

export interface AuthRequestPayload {
  requestId: string
  conversationId?: string
  sessionId?: string
  title: string
  detail: string
}

export interface SudoPasswordRequestPayload {
  requestId: string
  conversationId?: string
  sessionId?: string
  command: string
}

export interface AskUserQuestionPayload {
  id: string
  question: string
  options: string[]
}

export interface AskUserRequestPayload {
  requestId: string
  conversationId?: string
  sessionId?: string
  questions: AskUserQuestionPayload[]
}

export interface AskUserAnswerPayload {
  questionId: string
  selectedOption: string | null
  customAnswer: string | null
}

export interface SkillItem {
  id: string
  name: string
  description?: string
  content?: string
}
