import type {
  AgentDefinition,
  AgentGroupDefinition,
  AgentGroupProgressSnapshot,
  AgentGroupTranscript,
  AgentSidechatSession,
  ChannelBinding
} from '../../../../shared/agent-workspace-types.js'
import type { ActivePageAutomationContext } from '../../../../shared/page-automation-types.js'
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
export type ReasoningStrength = 'low' | 'medium' | 'high' | 'max'

export interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  previewText?: string
  searchText?: string
  authMode?: AIExecutionAuthMode
  providerId?: string
  selectedModel?: string
  reasoningStrength?: ReasoningStrength
  targetProjectId?: string
  agentId?: string
  groupId?: string
  channelBindingId?: string
}

export interface ChatPanelProps {
  projectContext?: Record<string, unknown> | null
  activePageContext?: ActivePageAutomationContext | null
}

export interface ChatSurfaceStatusSummary {
  contextLabel: string
  contextDetail: string
  isLoading: boolean
  pendingAuthCount: number
  activeTodoCount: number
  primaryTaskTitle: string | null
}

export interface ChatPanelEmit {
  (e: 'contextConsumed'): void
  (e: 'openWebLink', url: string): void
  (e: 'statusChange', status: ChatSurfaceStatusSummary): void
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
  modelCapabilities?: Record<string, { imageGeneration?: boolean; imageEditing?: boolean }>
  activeModel: string
  enableThinking?: boolean
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
  agentId: string | null
  groupId: string | null
  channelBindingId: string | null
  documentWorkspace?: ConversationDocumentWorkspaceState
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

export interface SkillItem {
  id: string
  name: string
  description?: string
  content?: string
}