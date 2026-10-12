import { reactive, ref } from 'vue'
import {
  createWorkspaceTabId,
  getWorkspaceTabDefinition,
  type WorkspaceTabInstance
} from './tab-registry'
import { buildOutgoingChatMessages } from '../chat/panel/message-runtime'
import type { ChatMessage, MessageContent } from '../chat/panel/types'
import type {
  BrowserAutomationAction,
  BrowserAutomationActionResult,
  BrowserAutomationSnapshot
} from '../../../shared/page-automation-types.js'

export const DEFAULT_DOCUMENT_WORKSPACE_WIDTH = 900
export const DEFAULT_FOLDER_WORKSPACE_WIDTH = 980
export const DEFAULT_WORKSPACE_WIDTH = DEFAULT_FOLDER_WORKSPACE_WIDTH

/** Automation handle exposed by a browser tab's embedded webview. */
export interface WorkspaceBrowserHandle {
  captureAutomationSnapshot: () => Promise<BrowserAutomationSnapshot>
  runAutomationAction: (action: BrowserAutomationAction) => Promise<BrowserAutomationActionResult>
}

/** Live page state of a browser tab; kept current by BrowserWorkspaceTab. */
export interface WorkspaceBrowserSurface {
  url: string
  title: string
  handle: WorkspaceBrowserHandle | null
}

/**
 * Module-singleton state for the tabbed right-side workspace panel. The panel
 * is intentionally kind-agnostic: folder keeps its conversation binding in a
 * dedicated ref, documents derive from the tab set itself (one document per
 * tab), and browser tabs carry { url, title } state. Everything persists
 * through the conversation snapshot (`workspace` field, with the legacy
 * folder/document fields kept in sync for rollback safety).
 */
export const workspaceStore = {
  /** Whether the workspace panel is shown on the right of the chat. */
  visible: ref(false),
  tabs: ref<WorkspaceTabInstance[]>([]),
  activeTabId: ref<string | null>(null),
  width: ref<number>(DEFAULT_WORKSPACE_WIDTH),
  // Conversation-bound folder (code) workspace state; owned by the folder tab.
  folderRootPath: ref<string | null>(null),
  folderRootName: ref<string | null>(null),
  folderActiveFilePath: ref<string | null>(null)
}

/** Live automation surfaces of mounted browser tabs, keyed by tab id. */
export const workspaceBrowserSurfaces = reactive(new Map<string, WorkspaceBrowserSurface>())

/** Live terminal surfaces of mounted terminal tabs, keyed by tab id. */
export interface WorkspaceTerminalSurface {
  sessionId: string
  cwd: string
}

export const workspaceTerminalSurfaces = reactive(new Map<string, WorkspaceTerminalSurface>())

// ---------------------------------------------------------------------------
// Document tab helpers (one document per tab; binding derives from the tabs)
// ---------------------------------------------------------------------------

function getDocumentFileName (filePath: string, fallback?: string | null): string {
  const normalizedFallback = fallback?.trim()
  if (normalizedFallback) return normalizedFallback
  const segments = filePath.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] || filePath
}

export function normalizeDocumentFileKey (filePath?: string | null): string {
  return (filePath || '')
    .trim()
    .replace(/\//g, '\\')
    .toLowerCase()
}

/** Open document tab for a path, if any (draft-restore fallback uses this). */
export function getDocumentTabFilePath (tab: WorkspaceTabInstance): string | null {
  const filePath = tab.state?.filePath
  return typeof filePath === 'string' && filePath.trim() ? filePath.trim() : null
}

/** All open document tabs, in strip order. */
export function getDocumentTabs (): WorkspaceTabInstance[] {
  return workspaceStore.tabs.value.filter(tab => tab.kind === 'document' && getDocumentTabFilePath(tab))
}

function sanitizeDocumentReferences (
  documents?: Array<{ filePath?: unknown; fileName?: unknown } | null | undefined>
): ConversationDocumentReference[] {
  const uniqueDocuments = new Map<string, ConversationDocumentReference>()

  for (const documentRef of documents || []) {
    const filePath = typeof documentRef?.filePath === 'string' ? documentRef.filePath.trim() : ''
    if (!filePath || !documentRef) continue
    const fileKey = normalizeDocumentFileKey(filePath)
    if (!fileKey || uniqueDocuments.has(fileKey)) continue
    const rawFileName = typeof documentRef.fileName === 'string' ? documentRef.fileName : undefined
    uniqueDocuments.set(fileKey, {
      filePath,
      fileName: getDocumentFileName(filePath, rawFileName)
    })
  }

  return Array.from(uniqueDocuments.values())
}

/**
 * Legacy dual-write view of the document binding: the union of all document
 * tabs, with the active tab (when it is a document tab) as activeFilePath.
 */
export function buildCurrentDocumentWorkspaceState (): ConversationDocumentWorkspaceState | undefined {
  const documents = sanitizeDocumentReferences(
    getDocumentTabs().map(tab => ({
      filePath: getDocumentTabFilePath(tab) || '',
      fileName: typeof tab.state?.fileName === 'string' ? tab.state.fileName : undefined
    }))
  )
  if (documents.length === 0) return undefined

  const activeTab = getActiveWorkspaceTab()
  const activeFilePath = activeTab && activeTab.kind === 'document'
    ? getDocumentTabFilePath(activeTab)
    : null
  const activeDocument = activeFilePath
    ? documents.find(item => normalizeDocumentFileKey(item.filePath) === normalizeDocumentFileKey(activeFilePath))
    : undefined

  return {
    documents,
    activeFilePath: activeDocument?.filePath || documents[0]?.filePath
  }
}

// ---------------------------------------------------------------------------
// Folder tab state helpers
// ---------------------------------------------------------------------------

function getFolderWorkspaceName (rootPath: string, fallback?: string | null): string {
  const normalizedFallback = fallback?.trim()
  if (normalizedFallback) return normalizedFallback
  const segments = rootPath.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] || rootPath
}

function normalizeFolderWorkspacePathKey (value?: string | null): string {
  return (value || '')
    .trim()
    .replace(/\\/g, '/')
}

export function applyFolderWorkspaceState (state?: ConversationFolderWorkspaceState | null): void {
  const rootPath = state?.rootPath?.trim()
  if (!rootPath) {
    resetFolderWorkspaceState()
    return
  }

  workspaceStore.folderRootPath.value = rootPath
  workspaceStore.folderRootName.value = getFolderWorkspaceName(rootPath, state?.rootName)
  workspaceStore.folderActiveFilePath.value = normalizeFolderWorkspacePathKey(state?.activeFilePath) || null
}

export function buildCurrentFolderWorkspaceState (): ConversationFolderWorkspaceState | undefined {
  const rootPath = workspaceStore.folderRootPath.value?.trim()
  if (!rootPath) return undefined

  return {
    rootPath,
    rootName: getFolderWorkspaceName(rootPath, workspaceStore.folderRootName.value),
    activeFilePath: normalizeFolderWorkspacePathKey(workspaceStore.folderActiveFilePath.value) || undefined
  }
}

export function resetFolderWorkspaceState (): void {
  workspaceStore.folderRootPath.value = null
  workspaceStore.folderRootName.value = null
  workspaceStore.folderActiveFilePath.value = null
}

// ---------------------------------------------------------------------------
// Tab instance helpers
// ---------------------------------------------------------------------------

export function getWorkspaceTabByKind (kind: string): WorkspaceTabInstance | null {
  return workspaceStore.tabs.value.find(tab => tab.kind === kind) || null
}

export function getActiveWorkspaceTab (): WorkspaceTabInstance | null {
  const activeTabId = workspaceStore.activeTabId.value
  if (!activeTabId) return null
  return workspaceStore.tabs.value.find(tab => tab.id === activeTabId) || null
}

export function hasWorkspaceTabKind (kind: string): boolean {
  return workspaceStore.tabs.value.some(tab => tab.kind === kind)
}

/**
 * Opens (or activates) a tab of the given kind. Singleton kinds dedupe by
 * kind; multi-instance kinds dedupe through the definition's `matches`
 * (document by file path, browser by URL). Payload becomes the tab state.
 */
export function ensureWorkspaceTab (kind: string, payload?: Record<string, unknown>): { tab: WorkspaceTabInstance; created: boolean } | null {
  const definition = getWorkspaceTabDefinition(kind)
  if (!definition) return null

  const existing = workspaceStore.tabs.value.find(tab => {
    if (tab.kind !== kind) return false
    if (definition.singleton) return true
    if (!payload || !definition.matches) return false
    return definition.matches(tab, payload)
  })
  if (existing) {
    if (payload) {
      existing.state = { ...(existing.state || {}), ...payload }
    }
    workspaceStore.activeTabId.value = existing.id
    return { tab: existing, created: false }
  }

  const tab: WorkspaceTabInstance = {
    id: createWorkspaceTabId(kind),
    kind,
    ...(payload ? { state: { ...payload } } : {})
  }
  workspaceStore.tabs.value = [...workspaceStore.tabs.value, tab]
  workspaceStore.activeTabId.value = tab.id
  return { tab, created: true }
}

export function removeWorkspaceTab (tabId: string): WorkspaceTabInstance | null {
  const tab = workspaceStore.tabs.value.find(item => item.id === tabId) || null
  if (!tab) return null

  workspaceStore.tabs.value = workspaceStore.tabs.value.filter(item => item.id !== tabId)
  // Closing the tab releases its conversation binding; hiding the panel does
  // not. Document/browser bindings live on the tab itself, so only folder
  // state needs an explicit reset.
  if (tab.kind === 'folder') resetFolderWorkspaceState()
  workspaceBrowserSurfaces.delete(tabId)
  if (tab.kind === 'terminal') {
    const sessionId = tab.state?.sessionId
    if (typeof sessionId === 'string' && window.electronAPI?.killTerminalSession) {
      void window.electronAPI.killTerminalSession(sessionId)
    }
    workspaceTerminalSurfaces.delete(tabId)
  }

  if (workspaceStore.activeTabId.value === tabId) {
    workspaceStore.activeTabId.value = workspaceStore.tabs.value[workspaceStore.tabs.value.length - 1]?.id ?? null
  }
  return tab
}

export function activateWorkspaceTab (tabId: string): void {
  if (!workspaceStore.tabs.value.some(tab => tab.id === tabId)) return
  workspaceStore.activeTabId.value = tabId
}

// ---------------------------------------------------------------------------
// Conversation snapshot (persistence)
// ---------------------------------------------------------------------------

/**
 * Serializes the whole workspace panel. Folder/document keep their legacy
 * shapes inside `state` so a rollback build can still read them via the
 * sibling conversation fields.
 */
export function buildCurrentWorkspaceState (): ConversationWorkspaceState | undefined {
  const tabs: ConversationWorkspaceTabState[] = []

  const folderState = buildCurrentFolderWorkspaceState()
  if (folderState) tabs.push({ kind: 'folder', state: { ...folderState } })

  for (const tab of getDocumentTabs()) {
    tabs.push({
      id: tab.id,
      kind: 'document',
      title: typeof tab.title === 'string' ? tab.title : undefined,
      state: {
        filePath: getDocumentTabFilePath(tab),
        fileName: typeof tab.state?.fileName === 'string' ? tab.state.fileName : getDocumentFileName(getDocumentTabFilePath(tab) || '')
      }
    })
  }

  for (const tab of workspaceStore.tabs.value) {
    if (tab.kind === 'folder' || tab.kind === 'document') continue
    tabs.push({
      id: tab.id,
      kind: tab.kind,
      ...(tab.title ? { title: tab.title } : {}),
      ...(tab.state ? { state: tab.state } : {})
    })
  }

  if (tabs.length === 0) return undefined
  return {
    tabs,
    activeTabId: workspaceStore.activeTabId.value,
    width: workspaceStore.width.value
  }
}

/** Restores tabs from the new `workspace` field, falling back to the legacy folder/document fields. */
export function applyWorkspaceState (
  state?: ConversationWorkspaceState | null,
  legacy?: {
    folderWorkspace?: ConversationFolderWorkspaceState | null
    documentWorkspace?: ConversationDocumentWorkspaceState | null
  }
): void {
  const tabs: WorkspaceTabInstance[] = []
  let folderApplied = false
  let legacyActiveTabId: string | null = null

  for (const entry of state?.tabs || []) {
    if (!entry || typeof entry.kind !== 'string') continue
    if (!getWorkspaceTabDefinition(entry.kind)) continue

    if (entry.kind === 'folder') {
      applyFolderWorkspaceState((entry.state || null) as ConversationFolderWorkspaceState | null)
      folderApplied = true
    } else if (entry.kind === 'document') {
      const [documentRef] = sanitizeDocumentReferences([entry.state])
      if (!documentRef) continue
      tabs.push({
        id: typeof entry.id === 'string' && entry.id ? entry.id : createWorkspaceTabId('document'),
        kind: 'document',
        title: entry.title || documentRef.fileName,
        state: { ...documentRef }
      })
    } else {
      tabs.push({
        id: typeof entry.id === 'string' && entry.id ? entry.id : createWorkspaceTabId(entry.kind),
        kind: entry.kind,
        ...(entry.title ? { title: entry.title } : {}),
        ...(entry.state ? { state: entry.state } : {})
      })
    }
  }

  // Conversations saved before the tabbed workspace only carry the two
  // legacy fields; synthesize their tabs so nothing is lost on upgrade.
  if (tabs.length === 0 && !folderApplied) {
    if (legacy?.folderWorkspace?.rootPath) {
      applyFolderWorkspaceState(legacy.folderWorkspace)
      folderApplied = true
      tabs.push({ id: createWorkspaceTabId('folder'), kind: 'folder' })
    }
    const legacyDocuments = sanitizeDocumentReferences(legacy?.documentWorkspace?.documents || [])
    const legacyActiveKey = normalizeDocumentFileKey(legacy?.documentWorkspace?.activeFilePath)
    for (const documentRef of legacyDocuments) {
      const tabId = createWorkspaceTabId('document')
      if (legacyActiveKey && normalizeDocumentFileKey(documentRef.filePath) === legacyActiveKey) {
        legacyActiveTabId = tabId
      }
      tabs.push({
        id: tabId,
        kind: 'document',
        title: documentRef.fileName,
        state: { ...documentRef }
      })
    }
  }

  if (!folderApplied) resetFolderWorkspaceState()

  workspaceStore.tabs.value = tabs

  const restoredActiveTabId = state?.activeTabId
  workspaceStore.activeTabId.value = (restoredActiveTabId && tabs.some(tab => tab.id === restoredActiveTabId))
    ? restoredActiveTabId
    : legacyActiveTabId ?? tabs[0]?.id ?? null

  const restoredWidth = state?.width ?? legacy?.folderWorkspace?.width ?? legacy?.documentWorkspace?.width
  workspaceStore.width.value = typeof restoredWidth === 'number' && Number.isFinite(restoredWidth)
    ? Math.round(restoredWidth)
    : DEFAULT_WORKSPACE_WIDTH

  void prefetchWorkspaceDocumentTabs()
}

export function resetWorkspaceState (): void {
  resetFolderWorkspaceState()
  workspaceStore.tabs.value = []
  workspaceStore.activeTabId.value = null
  workspaceStore.width.value = DEFAULT_WORKSPACE_WIDTH
  workspaceBrowserSurfaces.clear()
}

// ---------------------------------------------------------------------------
// AI document drafts (authoritative state lives in the Rust harness; this is
// the UI mirror that routes workspace tabs into draft preview mode)
// ---------------------------------------------------------------------------

export interface WorkspaceDocumentDraft {
  artifactId: string
  filePath: string
  draftPath: string
  fileType: string
  sourceSha256: string
  createdAt: string
  /** harness 计算的变更清单（ops 草稿精确、全文草稿为 diff 推导） */
  changes?: DocumentDraftChangesDTO | null
  /** 模型自述的修改说明（仅展示） */
  summary?: string | null
  /** 全文重建将丢失的媒体统计；存在时 UI 必须二次确认 */
  dataLossRisk?: { mediaCount: number } | null
}

const documentDrafts = ref(new Map<string, WorkspaceDocumentDraft>())

export function getWorkspaceDocumentDraft (filePath?: string | null): WorkspaceDocumentDraft | null {
  const key = normalizeDocumentFileKey(filePath)
  return (key && documentDrafts.value.get(key)) || null
}

export function stageWorkspaceDocumentDraft (payload: WorkspaceDocumentDraft): boolean {
  const key = normalizeDocumentFileKey(payload.filePath)
  if (!key) return false
  documentDrafts.value.set(key, payload)
  // Reassign so computed readers of the Map observe the change.
  documentDrafts.value = new Map(documentDrafts.value)
  return true
}

export function clearWorkspaceDocumentDraft (filePath?: string | null): void {
  const key = normalizeDocumentFileKey(filePath)
  if (!key || !documentDrafts.value.has(key)) return
  documentDrafts.value.delete(key)
  documentDrafts.value = new Map(documentDrafts.value)
}

// ---------------------------------------------------------------------------
// Restore prefetch
// ---------------------------------------------------------------------------

let documentPrefetchToken = 0

/**
 * Re-imports every restored document tab in the background. The panel only
 * mounts the active tab, so without this a restored non-active tab stays on
 * its placeholder until clicked — and after an app restart nothing is in the
 * document store at all. Failures stay silent here; DocumentFileTab surfaces
 * the import error when its tab is activated.
 */
export async function prefetchWorkspaceDocumentTabs (): Promise<void> {
  const filePaths = Array.from(new Set(
    getDocumentTabs()
      .map(tab => getDocumentTabFilePath(tab))
      .filter((filePath): filePath is string => Boolean(filePath))
  ))
  if (filePaths.length === 0) return

  const api = window.electronAPI
  if (!api?.listDocuments || !api.importDocument || !api.ensureDocumentRenderPreview) return

  const token = ++documentPrefetchToken
  try {
    const summaries = await api.listDocuments()
    if (token !== documentPrefetchToken) return
    const imported = new Map(
      summaries.map(summary => [normalizeDocumentFileKey(summary.filePath), summary.id] as const)
    )

    for (const filePath of filePaths) {
      if (token !== documentPrefetchToken) return
      try {
        let artifactId = imported.get(normalizeDocumentFileKey(filePath)) ?? null
        if (!artifactId) {
          const { artifact } = await api.importDocument(filePath)
          artifactId = artifact?.id ?? null
        }
        if (artifactId) await api.ensureDocumentRenderPreview(artifactId)
      } catch {
        // missing/unreadable file: the tab shows its re-add card on activation
      }
    }
  } catch {
    // document listing failed; tabs fall back to lazy resolution
  }
}

// ---------------------------------------------------------------------------
// AI context prompt for the document tab bindings
// ---------------------------------------------------------------------------

function trimDocumentWorkspaceContextValue (value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength)}...[truncated ${normalized.length - maxLength} chars]`
}

async function buildDocumentWorkspaceContextPrompt (): Promise<string | null> {
  const documentTabs = getDocumentTabs()
  const activeTab = getActiveWorkspaceTab()
  const activeFilePath = activeTab && activeTab.kind === 'document' ? getDocumentTabFilePath(activeTab) : null
  const documents = sanitizeDocumentReferences(
    documentTabs.map(tab => ({
      filePath: getDocumentTabFilePath(tab) || '',
      fileName: typeof tab.state?.fileName === 'string' ? tab.state.fileName : undefined
    }))
  )
  if (documents.length === 0) return null

  const importedSummaries = new Map<string, DocumentSummaryDTO>()
  if (window.electronAPI?.listDocuments) {
    try {
      const summaries = await window.electronAPI.listDocuments()
      for (const summary of summaries) {
        importedSummaries.set(normalizeDocumentFileKey(summary.filePath), summary)
      }
    } catch {
      // Workspace paths still provide useful context when document lookup fails.
    }
  }

  const lines = [
    '## Document workspace context',
    activeFilePath && workspaceStore.visible.value
      ? '- The user currently has a document tab open in this conversation.'
      : '- This conversation has document workspace files bound from an earlier workspace state.',
    '- If the user asks about "the document", "the opened file", "the workbench document", or similar phrasing, treat the files below as the relevant document context.',
    '- Use `list_documents` to verify available imported artifacts when needed, then `read_document` with the matching artifact_id to inspect document content. Do not claim no document is available before checking this context and the document tools.',
    '- To modify a document at the user\'s request, ALWAYS call the `doc_draft` tool; NEVER overwrite document files directly with write tools (they are blocked and destroy embedded images).',
    '- For docx/pptx modifications run `doc_parse` first, then call `doc_draft` with the `ops` operation list (docx_replace_text / docx_insert_paragraph_after / docx_delete_paragraph / docx_insert_image / pptx_replace_text / pptx_insert_image / pptx_insert_slide_after / pptx_delete_slide) using the parse output\'s stable indices. Full-content rebuilds (blocks/slides/sheets) destroy embedded images and trigger a data-loss warning for the user — only use them when the user explicitly asks to recreate the whole file.'
  ]

  lines.push('Current document workspace files:')
  for (const documentRef of documents.slice(0, 20)) {
    const fileKey = normalizeDocumentFileKey(documentRef.filePath)
    const summary = importedSummaries.get(fileKey)
    const isActive = fileKey === normalizeDocumentFileKey(activeFilePath)
    const details = [
      `name: ${trimDocumentWorkspaceContextValue(documentRef.fileName || getDocumentFileName(documentRef.filePath), 120)}`,
      `path: ${trimDocumentWorkspaceContextValue(documentRef.filePath)}`
    ]
    if (summary) {
      details.push(
        `artifact_id: ${summary.id}`,
        `type: ${summary.fileType}`,
        `selections: ${summary.selectionCount}`
      )
    } else {
      details.push('artifact_id: unknown until `list_documents` is checked')
    }
    lines.push(`- ${isActive ? '[active] ' : ''}${details.join('; ')}`)
  }

  if (documents.length > 20) {
    lines.push(`- ...and ${documents.length - 20} more workspace file(s).`)
  }

  return lines.join('\n')
}

export async function buildOutgoingMessagesWithDocumentWorkspaceContext (
  sourceMessages: ChatMessage[]
): Promise<Array<{ role: string; content: MessageContent }>> {
  const outgoingMessages = buildOutgoingChatMessages(sourceMessages)
  const documentContextPrompt = await buildDocumentWorkspaceContextPrompt()
  if (!documentContextPrompt) return outgoingMessages

  const insertIndex = Math.max(outgoingMessages.length - 1, 0)
  outgoingMessages.splice(insertIndex, 0, {
    role: 'system',
    content: documentContextPrompt
  })
  return outgoingMessages
}
