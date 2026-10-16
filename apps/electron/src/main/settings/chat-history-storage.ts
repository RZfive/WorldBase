import fs from 'node:fs'
import path from 'node:path'
import type { ChatMessage, Conversation, ConversationListEntry } from './chat-history.js'
import { validateConversationMetadata, type ConversationMetadataPatch } from '../../shared/conversation-metadata.js'

const CATALOG_FILE = 'catalog.json'

/** Time budget for the one-time grouping-root heal inside a single list(). */
const GROUPING_HEAL_BUDGET_MS = 3_000

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

// Legacy rows only carry targetProjectId (the optimization lock). The sidebar's
// project grouping reads projectId, so derive it once at the storage boundary.
function withProjectFallback (row: ConversationListEntry): ConversationListEntry {
  if (!row.projectId && row.targetProjectId) row.projectId = row.targetProjectId
  return row
}

// Catalog rows strip the workspace snapshot objects, but the sidebar's project
// grouping still needs the code directory identity — promote it to two short
// strings at summary time (folder tab first, legacy field as fallback).
function resolveWorkspaceRoot (conversation: Conversation): Pick<ConversationListEntry, 'workspaceRootPath' | 'workspaceRootName'> | undefined {
  const folderTab = conversation.workspace?.tabs?.find(tab => tab.kind === 'folder')
  const tabState = folderTab?.state as Record<string, unknown> | undefined
  const fromTab = typeof tabState?.rootPath === 'string' ? tabState.rootPath.trim() : ''
  const fromLegacy = typeof conversation.folderWorkspace?.rootPath === 'string' ? conversation.folderWorkspace.rootPath.trim() : ''
  const rootPath = fromTab || fromLegacy
  if (!rootPath) return undefined
  const tabName = typeof tabState?.rootName === 'string' ? tabState.rootName.trim() : ''
  const legacyName = typeof conversation.folderWorkspace?.rootName === 'string' ? conversation.folderWorkspace.rootName.trim() : ''
  const rootName = tabName || legacyName || rootPath.split(/[\\/]/).filter(Boolean).pop() || rootPath
  return { workspaceRootPath: rootPath, workspaceRootName: rootName }
}

// Grouping root comparisons treat /a/b/ and /a/b as the same directory and
// ignore case (macOS/Windows default filesystems).
function normalizeRootKey (value: string): string {
  return value.replace(/[\\/]+$/, '').toLowerCase()
}

/** Working directories of the conversation's terminal tabs, normalized. */
function terminalWorkingDirectories (conversation: Conversation): string[] {
  const tabs = conversation.workspace?.tabs
  if (!Array.isArray(tabs)) return []
  const directories: string[] = []
  for (const tab of tabs) {
    if (tab.kind !== 'terminal') continue
    const cwd = tab.state?.cwd
    if (typeof cwd === 'string' && cwd.trim()) directories.push(normalizeRootKey(cwd))
  }
  return directories
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
    if (record) {
      for (const [key, field] of Object.entries(record.patch)) {
        if (field === null) delete (value as Record<string, unknown>)[key]
        else (value as Record<string, unknown>)[key] = field
      }
      if (record.updatedAt > value.updatedAt) value.updatedAt = record.updatedAt
    }
    // Legacy fallback only when no patch ever wrote projectId — a patch may
    // have explicitly cleared it, and re-deriving would resurrect the value.
    if (!record || !('projectId' in record.patch)) withProjectFallback(value)
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
          const { searchText: _searchText, messages: _messages, documentWorkspace: _documents, folderWorkspace: _folder, workspace: _workspace, ...catalogItem } = item
          return this.applyMetadata({ ...catalogItem }, this.readMetadata(item.id))
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    } catch { return null }
  }

  private writeCatalog (): void {
    if (!this.summaries) return
    const rows = [...this.summaries.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ folderWorkspace: _folder, workspace: _workspace, ...row }) => row)
    this.writeAtomic(this.catalogPath, rows)
    // Mark the catalog as workspaceRoot-aware so the one-time migration in
    // list() only ever runs for installs whose catalog predates the field.
    try {
      if (!fs.existsSync(this.migrationMarkerPath())) {
        fs.writeFileSync(this.migrationMarkerPath(), new Date().toISOString(), 'utf-8')
      }
    } catch { /* best-effort marker */ }
  }

  private summary (conversation: Conversation, index = buildConversationIndex(conversation.messages || [])): ConversationListEntry {
    const { messages: _messages, documentWorkspace: _documents, folderWorkspace: _folder, workspace: _workspace, ...metadata } = conversation
    return { ...metadata, ...index, ...resolveWorkspaceRoot(conversation) }
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
      if (catalog) {
        // One-time migration: catalog rows created before workspaceRootPath
        // promotion lack the field, so the project sidebar would leave every
        // existing folder-workspace conversation ungrouped. Rebuild once.
        if (!fs.existsSync(this.migrationMarkerPath())) {
          try {
            const migrated = this.rebuildCatalogFromConversationFiles()
            fs.writeFileSync(this.migrationMarkerPath(), new Date().toISOString(), 'utf-8')
            return migrated
          } catch {
            // Fall through to the plain catalog read.
          }
        }
        this.summaries = new Map(catalog.map(conversation => [conversation.id, conversation]))
        this.healGroupingRoots()
      } else return this.rebuildCatalogFromConversationFiles()
    }
    return [...this.summaries.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  private migrationMarkerPath (): string {
    return path.join(this.dir, '.workspace-root-migrated')
  }

  private healMarkerPath (): string {
    return path.join(this.dir, '.grouping-root-healed')
  }

  private readHealConversation (id: string): Conversation | null {
    try {
      const file = this.filePath(id)
      if (!fs.existsSync(file)) return null
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as Conversation
    } catch { return null }
  }

  /**
   * One-time repair for project groupings wiped before saves kept the grouping
   * root sticky (see inheritGroupingRoot): a full save captured while the
   * folder tab was closed cleared workspaceRootPath from the catalog, and the
   * conversation left its directory group after a restart. Conservative by
   * construction — a row is re-rooted only when every terminal tab in its
   * workspace snapshot agrees on one directory and that directory is already
   * the grouping root of another row, so existing groups can be rejoined but
   * new ones are never invented.
   *
   * The scan reads full histories and is therefore budgeted: an oversized
   * library heals across successive launches instead of delaying the first
   * sidebar read. The completion marker is only written when the scan ran to
   * the end.
   */
  private healGroupingRoots (): void {
    if (fs.existsSync(this.healMarkerPath())) return
    const startedAt = Date.now()
    let complete = true
    try {
      const rows = this.summaries ? [...this.summaries.values()] : []
      const knownRoots = new Map<string, { rootPath: string; rootName?: string }>()
      for (const row of rows) {
        if (!row.workspaceRootPath) continue
        knownRoots.set(normalizeRootKey(row.workspaceRootPath), {
          rootPath: row.workspaceRootPath,
          ...(row.workspaceRootName ? { rootName: row.workspaceRootName } : {})
        })
      }
      let changed = false
      for (const row of rows) {
        if (Date.now() - startedAt > GROUPING_HEAL_BUDGET_MS) { complete = false; break }
        if (row.workspaceRootPath) continue
        const conversation = this.readHealConversation(row.id)
        if (!conversation) continue
        const folderRoot = resolveWorkspaceRoot(conversation)
        if (folderRoot) {
          row.workspaceRootPath = folderRoot.workspaceRootPath
          row.workspaceRootName = folderRoot.workspaceRootName
          changed = true
          continue
        }
        const directories = [...new Set(terminalWorkingDirectories(conversation))]
        if (directories.length !== 1) continue
        const match = knownRoots.get(directories[0])
        if (!match) continue
        row.workspaceRootPath = match.rootPath
        row.workspaceRootName = match.rootName || match.rootPath.split(/[\\/]/).filter(Boolean).pop() || match.rootPath
        changed = true
      }
      if (changed) this.writeCatalog()
    } finally {
      if (complete) {
        try { fs.writeFileSync(this.healMarkerPath(), new Date().toISOString(), 'utf-8') } catch { /* best-effort marker */ }
      }
    }
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
    this.inheritGroupingRoot(summary)
    this.upsertSummary(summary)
    return summary
  }

  /**
   * Project grouping must survive workspace churn: a save captured while the
   * folder tab is closed (user closed it, a background save without a workspace
   * context, restore ordering) must not strip the directory this conversation
   * was already grouped under. A newly present root still overwrites — moving
   * a conversation to another project directory is a deliberate act.
   */
  private inheritGroupingRoot (summary: ConversationListEntry): void {
    if (summary.workspaceRootPath) return
    if (!this.summaries) this.list()
    const previous = this.summaries?.get(summary.id)
    if (!previous?.workspaceRootPath) return
    summary.workspaceRootPath = previous.workspaceRootPath
    if (previous.workspaceRootName) summary.workspaceRootName = previous.workspaceRootName
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
