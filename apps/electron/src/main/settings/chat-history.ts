import { Worker } from 'node:worker_threads'
import type { ConversationMetadataPatch } from '../../shared/conversation-metadata.js'
import { t } from '../i18n/main-i18n.js'
import type { AIExecutionAuthMode } from './settings-store.js'
import type { AgentGroupDirectReply, AgentGroupProgressSnapshot, AgentGroupTranscript, AgentGroupUserInjection, AgentSidechatSession, SharedBoardSnapshot } from '../../shared/agent-workspace-types.js'
import type { ConversationFolderWorkspaceState } from '../../shared/folder-workspace-types.js'

export type ChatMessageContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>
export type ReasoningStrength = 'low' | 'medium' | 'high' | 'max'

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
  | { id: string; kind: 'content'; content: ChatMessageContent }
  | { id: string; kind: 'error'; message: string }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tool'; toolRun: ToolRun }
  | { id: string; kind: 'todo'; items: TodoItem[] }
  | { id: string; kind: 'file_preview'; filePath: string; lineCount: number; added: number; removed: number; active: boolean }
  | { id: string; kind: 'agent_sidechat'; session: AgentSidechatSession }
  | { id: string; kind: 'group_progress'; snapshot: AgentGroupProgressSnapshot }
  | { id: string; kind: 'group_transcript'; transcript: AgentGroupTranscript }
  | { id: string; kind: 'group_board'; board: SharedBoardSnapshot }
  | { id: string; kind: 'group_direct_reply'; directReply: AgentGroupDirectReply }
  | { id: string; kind: 'group_user_injection'; injection: AgentGroupUserInjection }
  | { id: string; kind: 'group_peer_message'; peerMessage: import('../../shared/agent-workspace-types.js').AgentGroupMessage }
  | { id: string; kind: 'web_search'; query: string; engine: string; results: WebSearchResultItem[] }
  | { id: string; kind: 'web_fetch'; query?: string; result: WebFetchResultEntry }
  | { id: string; kind: 'attachment'; fileName: string; fileType: string; fileSizeLabel: string; previewText: string }
  | { id: string; kind: 'auth_request'; requestId: string; title: string; detail: string; status: 'pending' | 'approved' | 'denied' }
  | { id: string; kind: 'sudo_password_request'; requestId: string; command: string; status: 'pending' | 'submitted' | 'canceled' }

export interface ChatMessage {
  role: string
  content: ChatMessageContent
  /** Stable message identity; set on new writes, absent on legacy history. */
  id?: string
  thinking?: string
  speakerName?: string
  modelLabel?: string
  toolRuns?: ToolRun[]
  blocks?: ChatMessageBlock[]
}

export interface ConversationDocumentReference {
  filePath: string
  fileName: string
}

export interface ConversationDocumentWorkspaceState {
  documents?: ConversationDocumentReference[]
  activeFilePath?: string
  width?: number
}

export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: string
  updatedAt: string
  /** User-edited title that should not be replaced by automatic title generation. */
  manualTitle?: boolean
  /** Authorization mode used by this conversation. */
  authMode?: AIExecutionAuthMode
  /** Provider ID used for this conversation */
  providerId?: string
  /** Model selected for this conversation */
  selectedModel?: string
  /** Reasoning strength selected for this conversation */
  reasoningStrength?: ReasoningStrength
  /** Per-conversation temperature override. Unset → provider/engine default. */
  temperature?: number
  /** Existing project locked to this conversation for optimization/editing. */
  targetProjectId?: string
  /** Active custom agent bound to this conversation. */
  agentId?: string
  /** Active agent group bound to this conversation. */
  groupId?: string
  /** Active IM channel binding bound to this conversation. */
  channelBindingId?: string
  /** Conversation-scoped document workspace state. */
  documentWorkspace?: ConversationDocumentWorkspaceState
  /** Conversation-scoped folder/code workspace state. */
  folderWorkspace?: ConversationFolderWorkspaceState
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

export interface ConversationListEntry extends Omit<Conversation, 'messages'> {
  previewText?: string
  searchText?: string
}

/** All history JSON/IO/index work runs in one serialized worker, never the UI thread. */
export class ChatHistoryStore {
  private readonly worker: Worker
  private nextId = 0
  private readonly timeoutMs: number
  private stopped: Error | null = null
  private closing: Promise<void> | null = null
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor (userDataPath: string, workerUrl = new URL('./chat-history-worker.cjs', import.meta.url), timeoutMs = 30_000) {
    this.timeoutMs = timeoutMs
    this.worker = new Worker(workerUrl, { workerData: { userDataPath }, execArgv: [] })
    this.worker.on('message', ({ id, result, error }) => {
      const request = this.pending.get(id)
      if (!request) return
      this.pending.delete(id)
      clearTimeout(request.timer)
      if (error) request.reject(new Error(error))
      else request.resolve(result)
      if (this.pending.size === 0) this.worker.unref()
    })
    this.worker.on('error', error => this.fail(error instanceof Error ? error : new Error(String(error))))
    this.worker.on('exit', code => this.fail(new Error(`Chat history worker exited (${code})`)))
    this.worker.unref()
  }

  private fail (error: Error): void {
    this.stopped = error
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }

  private call<T> (method: string, ...args: unknown[]): Promise<T> {
    if (this.stopped) return Promise.reject(this.stopped)
    if (this.closing && method !== 'close') return Promise.reject(new Error('Chat history is closing'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        if (this.pending.size === 0) this.worker.unref()
        reject(new Error(`Chat history ${method} timed out; write outcome may be unknown`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.worker.ref()
      try { this.worker.postMessage({ id, method, args }) } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        if (this.pending.size === 0) this.worker.unref()
        reject(error)
      }
    })
  }

  list (): Promise<ConversationListEntry[]> { return this.call('list') }
  get (id: string): Promise<Conversation | null> { return this.call('get', id) }
  save (conversation: Conversation): Promise<ConversationListEntry> { return this.call('save', conversation) }
  updateMetadata (id: string, patch: ConversationMetadataPatch): Promise<ConversationListEntry | null> {
    return this.call('updateMetadata', id, patch)
  }
  rename (id: string, title: string): Promise<boolean> { return this.call('rename', id, title) }
  delete (id: string): Promise<boolean> { return this.call('delete', id) }

  dispose (): Promise<void> {
    if (!this.closing) {
      // The close message follows all accepted writes in the worker's FIFO.
      this.closing = this.call<void>('close').finally(async () => { await this.worker.terminate() })
    }
    return this.closing
  }

  /**
   * Generate a short title from the first user message.
   */
  static generateTitle (messages: ChatMessage[]): string {
    const firstUser = messages.find(m => m.role === 'user')
    if (!firstUser) return t('mainDialog.newConversation')
    const text = typeof firstUser.content === 'string'
      ? firstUser.content.trim()
      : firstUser.content
        .filter(part => part.type === 'text')
        .map(part => part.text || '')
        .join(' ')
        .trim()
    if (!text) return t('mainDialog.newConversation')
    return text.length > 40 ? text.substring(0, 40) + '...' : text
  }
}
