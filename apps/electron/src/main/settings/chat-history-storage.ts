import fs from 'node:fs'
import path from 'node:path'
import type { ChatMessage, Conversation, ConversationListEntry } from './chat-history.js'
import { validateConversationMetadata, type ConversationMetadataPatch } from '../../shared/conversation-metadata.js'

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
 * ChatHistoryStorage — worker-owned history persistence
 * 将每个对话保存为 userData/conversations/ 下的独立 JSON 文件
 */
export class ChatHistoryStorage {
  private dir: string
  private summaries: Map<string, ConversationListEntry> | null = null
  private readonly metadataDir: string

  constructor (userDataPath: string) {
    this.dir = path.join(userDataPath, 'conversations')
    this.metadataDir = path.join(this.dir, 'metadata')
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true })
    }
    fs.mkdirSync(this.metadataDir, { recursive: true })
  }

  private filePath (id: string): string {
    // Prevent directory traversal
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid conversation id')
    return path.join(this.dir, `${id}.json`)
  }

  private metadataPath (id: string): string {
    return path.join(this.metadataDir, path.basename(this.filePath(id)))
  }

  private readMetadata (id: string): { patch: ConversationMetadataPatch; updatedAt: string } | null {
    const file = this.metadataPath(id)
    if (!fs.existsSync(file)) return null
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (typeof record.updatedAt !== 'string') return null
      return { patch: validateConversationMetadata(record.patch), updatedAt: record.updatedAt }
    } catch { return null }
  }

  private applyMetadata<T extends ConversationListEntry> (value: T, record: ReturnType<ChatHistoryStorage['readMetadata']>): T {
    if (!record) return value
    for (const [key, field] of Object.entries(record.patch)) {
      if (field === null) delete (value as Record<string, unknown>)[key]
      else (value as Record<string, unknown>)[key] = field
    }
    if (record.updatedAt > value.updatedAt) value.updatedAt = record.updatedAt
    return value
  }

  private writeAtomic (file: string, value: unknown): void {
    const temporary = `${file}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf-8', mode: 0o600 })
      fs.renameSync(temporary, file)
    } finally { fs.rmSync(temporary, { force: true }) }
  }

  /**
   * List all conversations (sorted by updatedAt desc).
   */
  list (): ConversationListEntry[] {
    if (this.summaries) return [...this.summaries.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'))
    const convos: ConversationListEntry[] = []

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.dir, file), 'utf-8')
        const rawConversation = JSON.parse(raw) as Conversation
        if (!rawConversation || typeof rawConversation.id !== 'string' || typeof rawConversation.updatedAt !== 'string') continue
        const data = this.applyMetadata(rawConversation, this.readMetadata(rawConversation.id))
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
          channelBindingId: data.channelBindingId,
          forkedFromConversationId: data.forkedFromConversationId,
          forkedFromMessageId: data.forkedFromMessageId,
          rootConversationId: data.rootConversationId,
          forkDepth: data.forkDepth,
          forkedAt: data.forkedAt
        })
      } catch {
        // skip corrupted files
      }
    }

    this.summaries = new Map(convos.map(conversation => [conversation.id, conversation]))
    return convos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * Get a single conversation by ID.
   */
  get (id: string): Conversation | null {
    const fp = this.filePath(id)
    if (!fs.existsSync(fp)) return null
    try {
      return this.applyMetadata(JSON.parse(fs.readFileSync(fp, 'utf-8')) as Conversation, this.readMetadata(id))
    } catch {
      return null
    }
  }

  /**
   * Create or update a conversation.
   */
  private write (conversation: Conversation): void {
    this.writeAtomic(this.filePath(conversation.id), conversation)
  }

  private summary (conversation: Conversation, index = buildConversationIndex(conversation.messages || [])): ConversationListEntry {
    const { messages: _messages, documentWorkspace: _documents, folderWorkspace: _folder, ...metadata } = conversation
    return { ...metadata, ...index }
  }

  save (conversation: Conversation): ConversationListEntry {
    // A provider change is newer than an in-flight stream's old metadata.
    // Fold its tiny sidecar into the next content write, then remove it.
    this.applyMetadata(conversation, this.readMetadata(conversation.id))
    conversation.updatedAt = new Date().toISOString()
    this.write(conversation)
    fs.rmSync(this.metadataPath(conversation.id), { force: true })
    const summary = this.summary(conversation)
    this.summaries?.set(conversation.id, summary)
    return summary
  }

  updateMetadata (id: string, input: ConversationMetadataPatch): ConversationListEntry | null {
    const patch = validateConversationMetadata(input)
    if (!fs.existsSync(this.filePath(id))) return null
    let summary = this.summaries?.get(id)
    if (!summary) {
      const conversation = this.get(id)
      if (!conversation) return null
      summary = this.summary(conversation)
    }
    const record = {
      patch: { ...this.readMetadata(id)?.patch, ...patch },
      updatedAt: new Date().toISOString()
    }
    // O(metadata size), not O(history size): no screenshot/text reserialization.
    this.writeAtomic(this.metadataPath(id), record)
    const updated = this.applyMetadata({ ...summary }, record)
    this.summaries?.set(id, updated)
    return updated
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
      const conversation = this.get(id)
      if (!conversation) return false
      conversation.title = nextTitle
      conversation.manualTitle = true
      this.write(conversation)
      fs.rmSync(this.metadataPath(id), { force: true })
      const cached = this.summaries?.get(id)
      if (cached) this.summaries!.set(id, { ...cached, title: nextTitle, manualTitle: true })
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
      fs.rmSync(this.metadataPath(id), { force: true })
      this.summaries?.delete(id)
      return true
    }
    return false
  }
}
