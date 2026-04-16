import fs from 'node:fs'
import path from 'node:path'
import type { AIExecutionAuthMode } from './settings-store.js'

export type ChatMessageContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>

export interface ToolProgressEntry {
  stage: string
  detail?: string
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
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tool'; toolRun: ToolRun }
  | { id: string; kind: 'file_preview'; filePath: string; previewContent: string; truncated: boolean; active: boolean }
  | { id: string; kind: 'web_search'; query: string; engine: string; results: WebSearchResultItem[] }
  | { id: string; kind: 'web_fetch'; query?: string; result: WebFetchResultEntry }
  | { id: string; kind: 'attachment'; fileName: string; fileType: string; fileSizeLabel: string; previewText: string }
  | { id: string; kind: 'auth_request'; requestId: string; title: string; detail: string; status: 'pending' | 'approved' | 'denied' }

export interface ChatMessage {
  role: string
  content: ChatMessageContent
  thinking?: string
  modelLabel?: string
  toolRuns?: ToolRun[]
  blocks?: ChatMessageBlock[]
}

export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: string
  updatedAt: string
  /** Authorization mode used by this conversation. */
  authMode?: AIExecutionAuthMode
  /** Provider ID used for this conversation */
  providerId?: string
  /** Model selected for this conversation */
  selectedModel?: string
  /** Existing project locked to this conversation for optimization/editing. */
  targetProjectId?: string
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
  list (): Omit<Conversation, 'messages'>[] {
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'))
    const convos: Omit<Conversation, 'messages'>[] = []

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.dir, file), 'utf-8')
        const data = JSON.parse(raw) as Conversation
        convos.push({
          id: data.id,
          title: data.title,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          authMode: data.authMode,
          providerId: data.providerId,
          selectedModel: data.selectedModel,
          targetProjectId: data.targetProjectId
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
