import type { AgentGroupCollaborationPlan, AgentGroupDirectReply, AgentGroupProgressSnapshot, AgentGroupTranscript, AgentGroupUserInjection, AgentSidechatSession, SharedBoardSnapshot } from '../../../shared/agent-workspace-types.js'

export type MessageContent = string | ChatContentPart[]

export interface ChatContentPart {
  type: string
  text?: string
  image_url?: { url: string }
}

export interface ToolProgressEntry {
  stage: string
  detail?: string
}

export type TodoStatus = 'not-started' | 'in-progress' | 'completed'

export interface TodoItem {
  id: number
  title: string
  status: TodoStatus
}

export interface ToolRun {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
  progress: ToolProgressEntry[]
}

export interface WebSearchResultItem {
  rank: number
  title: string
  url: string
  snippet: string
  source: string
  published_at?: string
}

export interface WebFetchResultEntry {
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

export type ChatMessageBlock =
  | { id: string; kind: 'content'; content: MessageContent }
  | { id: string; kind: 'error'; message: string }
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
  | { id: string; kind: 'group_peer_message'; peerMessage: import('../../../shared/agent-workspace-types.js').AgentGroupMessage }
  | { id: string; kind: 'web_search'; query: string; engine: string; results: WebSearchResultItem[] }
  | { id: string; kind: 'web_fetch'; query?: string; result: WebFetchResultEntry }
  | { id: string; kind: 'attachment'; fileName: string; fileType: string; fileSizeLabel: string; previewText: string }
  | { id: string; kind: 'auth_request'; requestId: string; title: string; detail: string; status: 'pending' | 'approved' | 'denied' }
  | { id: string; kind: 'sudo_password_request'; requestId: string; command: string; status: 'pending' | 'submitted' | 'canceled' }

export interface ChatMessage {
  role: string
  content: MessageContent
  /** Stable message identity; set on new writes, absent on legacy history. */
  id?: string
  thinking?: string
  speakerName?: string
  modelLabel?: string
  toolRuns?: ToolRun[]
  blocks?: ChatMessageBlock[]
}

/** One message band in the minimap's scaled conversation preview. */
export interface MinimapRow {
  key: string
  /** Message index to jump to. */
  messageIndex: number
  role: 'user' | 'assistant'
  /** Top offset from the scroll-content start, px (paddings included). */
  offsetPx: number
  /** Rendered message height incl. gap, px. */
  extentPx: number
  /** User-message text preview for the stripe placeholder / tooltip. */
  excerpt?: string
  /** 1-based ordinal among user messages (user rows only). */
  ordinal?: number
  isEditing?: boolean
  /** True once the real MessageRow is mounted in the offscreen layer. */
  mounted?: boolean
}

export interface GalleryImage {
  url: string
  messageIndex: number
  blockIndex: number
  partIndex: number
}

export interface FilePreviewState {
  active: boolean
  filePath: string
  lineCount: number
  added: number
  removed: number
}
