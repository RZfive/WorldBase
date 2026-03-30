import fs from 'node:fs'
import path from 'node:path'

export interface ChatMessage {
  role: string
  content: string
}

export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: string
  updatedAt: string
  /** Provider ID used for this conversation */
  providerId?: string
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
          providerId: data.providerId
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
    const text = firstUser.content.trim()
    return text.length > 40 ? text.substring(0, 40) + '...' : text
  }
}
