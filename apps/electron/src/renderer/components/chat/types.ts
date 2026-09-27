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
  /** Epoch ms when the run started — feeds the work-elapsed summary row. */
  startedAt?: number
  /** Epoch ms when the run reached a terminal status. */
  endedAt?: number
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
  | { id: string; kind: 'thinking'; text: string; startedAt?: number; endedAt?: number }
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

/** Depth preset for a quick-ask annotation; drives the answer prompt. */
export type QuickAskMode = 'quick' | 'detailed'

/** One question + answer exchange inside an annotation thread. */
export interface MessageAnnotationTurn {
  question: string
  answer: string
  mode: QuickAskMode
  /** 'generating' while the quickAsk call is in flight; undefined = done. */
  status?: 'generating' | 'done' | 'error'
  error?: string
  startedAt?: number
}

/**
 * Stable text anchor captured when an annotation is created.  `exact` is
 * whitespace-normalized to match the renderer's markdown text index while
 * prefix/suffix disambiguate repeated phrases in the same message.
 */
export interface MessageAnnotationLocator {
  version: 1
  exact: string
  prefix?: string
  suffix?: string
  /** Index of the content block containing the selection. */
  blockIndex?: number
  /** Normalized character offsets within the content block, when known. */
  startOffset?: number
  endOffset?: number
  /** Runtime/persisted resolution hint used by navigation surfaces. */
  status?: 'resolved' | 'ambiguous' | 'orphaned'
}

/** A quick Q&A thread pinned to a text range inside one message. */
export interface MessageAnnotation {
  id: string
  /** Exact selected text the annotation is anchored to. */
  text: string
  /** Contextual anchor; absent on legacy annotations created before locator support. */
  locator?: MessageAnnotationLocator
  /** Full Q&A thread; turns[0] is the original question. */
  turns: MessageAnnotationTurn[]
  createdAt: number
  /** Resolver state for stale or ambiguous anchors. */
  status?: 'resolved' | 'ambiguous' | 'orphaned'
}

/** Viewport-space rect used to anchor lightweight popovers to text. */
export interface AnnotationAnchor {
  left: number
  top: number
  right: number
  bottom: number
}

/** State for the inline quick-ask popover (ask mode or thread mode). */
export interface QuickAskPopoverState {
  mode: 'ask' | 'thread'
  text: string
  locator?: MessageAnnotationLocator
  messageId: string | null
  messageIndex: number
  anchor: AnnotationAnchor
  /** thread mode: the annotation being continued. */
  annotationId: string | null
  turns: MessageAnnotationTurn[]
}

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
  /** Quick-ask annotations attached to text ranges of this message. */
  annotations?: MessageAnnotation[]
}

/** Lightweight navigation entry for one user question. */
export interface QuestionNavigationEntry {
  key: string
  messageIndex: number
  excerpt: string
  annotations?: QuestionAnnotationNavigationEntry[]
}

export interface QuestionAnnotationNavigationEntry {
  id: string
  messageIndex: number
  excerpt: string
  status?: 'resolved' | 'ambiguous' | 'orphaned' | 'generating'
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
