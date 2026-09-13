import fs from 'node:fs'
import path from 'node:path'
import type { ChatMessage, Conversation, ConversationListEntry } from './chat-history.js'
import { validateConversationMetadata, type ConversationMetadataPatch } from '../../shared/conversation-metadata.js'

const CATALOG_FILE = 'catalog.json'

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

function buildConversationIndex (messages: ChatMessage[]): Pick<ConversationListEntry, 'previewText'> {
  const searchSegments = messages.map(getMessageContentText).filter(Boolean)
  const latestPreview = [...searchSegments].reverse().find(Boolean) || ''
  const previewText = latestPreview ? (latestPreview.length > 96 ? `${latestPreview.slice(0, 96)}...` : latestPreview) : undefined
  // Only used to create/update the catalog entry. It is intentionally bounded
  // and never includes screenshots or the full conversation payload.
  return { previewText }
}

/**
 * Worker-owned history storage. The conversation directory has two layers:
 * - catalog.json: lightweight list rows for the sidebar
 * - <id>.json: full messages, read only after a conversation is opened
 */
export class ChatHistoryStorage {
  private dir: string
  private summaries: Map<string, ConversationListEntry> | null = null
  private readonly metadataDir: string
  private readonly catalogPath: string

  constructor (userDataPath: string) {
    this.dir = path.join(userDataPath, 'conversations')
    this.catalogPath = path.join(this.dir, CATALOG_FILE)
    this.metadataDir = path.join(this.dir, 'metadata')
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true })
    fs.mkdirSync(this.metadataDir, { recursive: true })
  }

  private filePath (id: string): string {
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

  private readCatalog (): ConversationListEntry[] | null {
    if (!fs.existsSync(this.catalogPath)) return null
    try {
      const value = JSON.parse(fs.readFileSync(this.catalogPath, 'utf-8'))
      if (!Array.isArray(value)) return null
      return value
        .filter(item => item && typeof item.id === 'string' && typeof item.updatedAt === 'string')
        .map(item => {
          const { searchText: _searchText, messages: _messages, documentWorkspace: _documents, folderWorkspace: _folder, ...catalogItem } = item
          return this.applyMetadata({ ...catalogItem }, this.readMetadata(item.id))
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    } catch { return null }
  }

  private writeCatalog (): void {
    if (!this.summaries) return
    const rows = [...this.summaries.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ folderWorkspace: _folder, ...row }) => row)
    this.writeAtomic(this.catalogPath, rows)
  }

  private summary (conversation: Conversation, index = buildConversationIndex(conversation.messages || [])): ConversationListEntry {
    const { messages: _messages, documentWorkspace: _documents, folderWorkspace: _folder, ...metadata } = conversation
    return { ...metadata, ...index }
  }

  /** One-time migration for installations created before catalog.json. */
  private rebuildCatalogFromConversationFiles (): ConversationListEntry[] {
    const convos: ConversationListEntry[] = []
    const files = fs.readdirSync(this.dir).filter(file => file.endsWith('.json') && file !== CATALOG_FILE)
    for (const file of files) {
      try {
        const rawConversation = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf-8')) as Conversation
        if (!rawConversation || typeof rawConversation.id !== 'string' || typeof rawConversation.updatedAt !== 'string') continue
        convos.push(this.summary(this.applyMetadata(rawConversation, this.readMetadata(rawConversation.id))))
      } catch {
        // Ignore corrupted or temporary files.
      }
    }
    this.summaries = new Map(convos.map(conversation => [conversation.id, conversation]))
    this.writeCatalog()
    return convos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** List only lightweight catalog rows. Full conversation files are not read. */
  list (): ConversationListEntry[] {
    if (!this.summaries) {
      const catalog = this.readCatalog()
      if (catalog) this.summaries = new Map(catalog.map(conversation => [conversation.id, conversation]))
      else return this.rebuildCatalogFromConversationFiles()
    }
    return [...this.summaries.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** Read one full conversation after the user opens it. */
  get (id: string): Conversation | null {
    const fp = this.filePath(id)
    if (!fs.existsSync(fp)) return null
    try {
      return this.applyMetadata(JSON.parse(fs.readFileSync(fp, 'utf-8')) as Conversation, this.readMetadata(id))
    } catch { return null }
  }

  private write (conversation: Conversation): void {
    this.writeAtomic(this.filePath(conversation.id), conversation)
  }

  private upsertSummary (summary: ConversationListEntry): void {
    if (!this.summaries) this.list()
    this.summaries!.set(summary.id, summary)
    this.writeCatalog()
  }

  save (conversation: Conversation): ConversationListEntry {
    this.applyMetadata(conversation, this.readMetadata(conversation.id))
    conversation.updatedAt = new Date().toISOString()
    this.write(conversation)
    fs.rmSync(this.metadataPath(conversation.id), { force: true })
    const summary = this.summary(conversation)
    this.upsertSummary(summary)
    return summary
  }

  updateMetadata (id: string, input: ConversationMetadataPatch): ConversationListEntry | null {
    const patch = validateConversationMetadata(input)
    if (!fs.existsSync(this.filePath(id))) return null
    if (!this.summaries) this.list()
    const summary = this.summaries?.get(id)
    if (!summary) return null
    const record = {
      patch: { ...this.readMetadata(id)?.patch, ...patch },
      updatedAt: new Date().toISOString()
    }
    this.writeAtomic(this.metadataPath(id), record)
    const updated = this.applyMetadata({ ...summary }, record)
    this.summaries!.set(id, updated)
    this.writeCatalog()
    return updated
  }

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
      if (!this.summaries) this.list()
      const cached = this.summaries?.get(id)
      if (cached) {
        this.summaries!.set(id, { ...cached, title: nextTitle, manualTitle: true })
        this.writeCatalog()
      }
      return true
    } catch { return false }
  }

  delete (id: string): boolean {
    const fp = this.filePath(id)
    if (!fs.existsSync(fp)) return false
    fs.unlinkSync(fp)
    fs.rmSync(this.metadataPath(id), { force: true })
    if (!this.summaries) this.list()
    this.summaries?.delete(id)
    this.writeCatalog()
    return true
  }
}
