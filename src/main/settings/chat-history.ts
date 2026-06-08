import fs from 'node:fs'
import path from 'node:path'
import type { AIExecutionAuthMode } from './settings-store.js'
import type { AgentGroupProgressSnapshot, AgentGroupTranscript, AgentSidechatSession } from '../../shared/agent-workspace-types.js'

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
  | { id: string; kind: 'web_search'; query: string; engine: string; results: WebSearchResultItem[] }
  | { id: string; kind: 'web_fetch'; query?: string; result: WebFetchResultEntry }
  | { id: string; kind: 'attachment'; fileName: string; fileType: string; fileSizeLabel: string; previewText: string }
  | { id: string; kind: 'auth_request'; requestId: string; title: string; detail: string; status: 'pending' | 'approved' | 'denied' }
  | { id: string; kind: 'sudo_password_request'; requestId: string; command: string; status: 'pending' | 'submitted' | 'canceled' }

export interface ChatMessage {
  role: string
  content: ChatMessageContent
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
}

interface ConversationListEntry extends Omit<Conversation, 'messages'> {
  previewText?: string
  searchText?: string
}

function getMessageContentText (message: ChatMessage): string {
  const contentText = typeof message.content === 'string'
    ? message.content.trim()
    : message.content
      .filter(part => part.type === 'text')
      .map(part => part.text || '')
      .join(' ')
      .trim()

  const blockText = (message.blocks || [])
    .flatMap((block) => {
      switch (block.kind) {
        case 'content':
          return typeof block.content === 'string'
            ? [block.content]
            : block.content.filter(part => part.type === 'text').map(part => part.text || '')
        case 'attachment':
          return [block.fileName, block.previewText]
        case 'error':
          return [block.message]
        case 'auth_request':
          return [block.title, block.detail]
        default:
          return []
      }
    })
    .join(' ')
    .trim()

  return [message.speakerName, contentText, blockText]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildConversationIndex (messages: ChatMessage[]): Pick<ConversationListEntry, 'previewText' | 'searchText'> {
  const searchSegments = messages
    .map(getMessageContentText)
    .filter(Boolean)

  const latestPreview = [...searchSegments].reverse().find(Boolean) || ''

  return {
    previewText: latestPreview ? (latestPreview.length > 96 ? `${latestPreview.slice(0, 96)}...` : latestPreview) : undefined,
    searchText: searchSegments.join('\n').slice(0, 6000) || undefined
  }
}

/**
 * ChatHistoryStore — 对话历史持久化
 * 将每个对话保存为 userData/conversations/ 下的独立 JSON 文件
 */
export class ChatHistoryStore {
  private dir: string

  constructor (userDataPath: string) {
    this.dir = path.join(userDataPath, 'conversations')
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true })
    }
  }

  private filePath (id: string): string {
    // Prevent directory traversal
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, '')
    return path.join(this.dir, `${safe}.json`)
  }

  /**
   * List all conversations (sorted by updatedAt desc).
   */
  list (): ConversationListEntry[] {
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'))
    const convos: ConversationListEntry[] = []

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.dir, file), 'utf-8')
        const data = JSON.parse(raw) as Conversation
        const conversationIndex = buildConversationIndex(data.messages || [])
        convos.push({
          id: data.id,
          title: data.title,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          previewText: conversationIndex.previewText,
          searchText: conversationIndex.searchText,
          manualTitle: data.manualTitle,
          authMode: data.authMode,
          providerId: data.providerId,
          selectedModel: data.selectedModel,
          reasoningStrength: data.reasoningStrength,
          temperature: data.temperature,
          targetProjectId: data.targetProjectId,
          agentId: data.agentId,
          groupId: data.groupId,
          channelBindingId: data.channelBindingId
        })
      } catch {
        // skip corrupted files
      }
    }

    return convos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * Get a single conversation by ID.
   */
  get (id: string): Conversation | null {
    const fp = this.filePath(id)
    if (!fs.existsSync(fp)) return null
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf-8')) as Conversation
    } catch {
      return null
    }
  }

  /**
   * Create or update a conversation.
   */
  save (conversation: Conversation): void {
    conversation.updatedAt = new Date().toISOString()
    fs.writeFileSync(this.filePath(conversation.id), JSON.stringify(conversation, null, 2), 'utf-8')
  }

  /**
   * Rename a conversation without changing its updatedAt ordering.
   */
  rename (id: string, title: string): boolean {
    const fp = this.filePath(id)
    if (!fs.existsSync(fp)) return false

    const nextTitle = title.trim()
    if (!nextTitle) return false

    try {
      const conversation = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Conversation
      conversation.title = nextTitle
      conversation.manualTitle = true
      fs.writeFileSync(fp, JSON.stringify(conversation, null, 2), 'utf-8')
      return true
    } catch {
      return false
    }
  }

  /**
   * Delete a conversation.
   */
  delete (id: string): boolean {
    const fp = this.filePath(id)
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp)
      return true
    }
    return false
  }

  /**
   * Generate a short title from the first user message.
   */
  static generateTitle (messages: ChatMessage[]): string {
    const firstUser = messages.find(m => m.role === 'user')
    if (!firstUser) return '新对话'
    const text = typeof firstUser.content === 'string'
      ? firstUser.content.trim()
      : firstUser.content
        .filter(part => part.type === 'text')
        .map(part => part.text || '')
        .join(' ')
        .trim()
    if (!text) return '新对话'
    return text.length > 40 ? text.substring(0, 40) + '...' : text
  }
}
