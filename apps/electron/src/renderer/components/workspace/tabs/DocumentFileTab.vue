<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import DocumentRenderHost from '../../chat/blocks/DocumentRenderHost.vue'
import {
  clearWorkspaceDocumentDraft,
  ensureWorkspaceTab,
  getWorkspaceDocumentDraft,
  normalizeDocumentFileKey,
  stageWorkspaceDocumentDraft
} from '../workspace-store'
import type { WorkspaceTabInstance } from '../tab-registry'

type DocumentArtifact = DocumentArtifactDTO
type SelectionRegion = DocumentSelectionDTO
type DocumentSummary = DocumentSummaryDTO

interface HighlightSelectionPayload {
  nodeIds?: string[]
  text: string
  pageIndex?: number
}

const props = defineProps<{
  /** The owning workspace tab; state carries { filePath, fileName }. */
  tab: WorkspaceTabInstance
}>()

const emit = defineEmits<{
  (e: 'insertSelectionTag', tag: string): void
}>()

const { t } = useI18n()

interface DocumentFileSummary {
  artifactId: string | null
  filePath: string
  fileName: string
  fileType: string
  fileSize: number
  selectionCount: number
  status: 'resolving' | 'ready' | 'missing' | 'error'
  error?: string
}

const state = props.tab.state as { filePath?: string; fileName?: string } | undefined
const filePath = (state?.filePath || '').trim()
const fileName = state?.fileName?.trim() || filePath.split(/[\\/]/).filter(Boolean).pop() || filePath

const documentSummary = ref<DocumentFileSummary>({
  artifactId: null,
  filePath,
  fileName,
  fileType: 'missing',
  fileSize: 0,
  selectionCount: 0,
  status: 'resolving'
})
const activeArtifact = ref<DocumentArtifact | null>(null)
const activeSelections = ref<SelectionRegion[]>([])
const importError = ref('')
const previewLoading = ref(false)
const isResolving = ref(false)
/** Mirrors onActivated/onDeactivated so cached (KeepAlive) tabs stay passive. */
const isActiveTab = ref(false)

// --- Zoom state: transform-scale the rendered document inside the viewport. ---
const viewportRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLElement | null>(null)
const zoomScale = ref(1)
const ZOOM_MIN = 0.25
const ZOOM_MAX = 4
const ZOOM_STEP = 1.2

const SELECTION_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16']
let colorIndex = 0
let resolveToken = 0

const selectedDocument = computed<DocumentFileSummary | null>(() => (
  documentSummary.value.status === 'resolving' ? null : documentSummary.value
))

const zoomPercent = computed(() => `${Math.round(zoomScale.value * 100)}%`)
// Anchor zoom-in at the top-left so the overflow stays reachable by scrolling;
// zoom-out keeps the top-center anchor so the shrunken page stays centered.
const canvasStyle = computed(() => ({
  transform: `scale(${zoomScale.value})`,
  transformOrigin: zoomScale.value > 1 ? '0 0' : '50% 0'
}))

const hasRenderableDocument = computed(() => (
  (documentSummary.value.status === 'ready' && Boolean(activeArtifact.value)) ||
  Boolean(draft.value && draftArtifact.value)
))

function clampZoom (value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100))
}

function zoomIn (): void {
  zoomScale.value = clampZoom(zoomScale.value * ZOOM_STEP)
}

function zoomOut (): void {
  zoomScale.value = clampZoom(zoomScale.value / ZOOM_STEP)
}

function zoomReset (): void {
  zoomScale.value = 1
}

/** Fits the document to the viewport width; PDF pages are measured directly. */
async function zoomFit (): Promise<void> {
  if (documentSummary.value.fileType !== 'pdf') {
    zoomReset()
    return
  }

  await nextTick()
  const viewport = viewportRef.value
  if (!viewport) return

  const page = canvasRef.value?.querySelector<HTMLElement>('.pdfViewer .page')
  const contentWidth = page?.offsetWidth || 0
  if (!contentWidth) {
    zoomScale.value = 1
    return
  }

  const available = Math.max(120, viewport.clientWidth - 32)
  zoomScale.value = clampZoom(available / contentWidth)
  await nextTick()
  viewport.scrollTo({ left: 0, top: 0 })
}

function nextColor (): string {
  const color = SELECTION_COLORS[colorIndex % SELECTION_COLORS.length]
  colorIndex++
  return color
}

function isMissingFileError (message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('enoent')
    || normalized.includes('no such file')
    || message.includes('路径不是一个文件')
    || message.includes('不存在')
    || message.includes('找不到')
}

async function listImportedDocumentSummaries (): Promise<DocumentSummary[]> {
  if (!window.electronAPI?.listDocuments) return []
  try {
    return await window.electronAPI.listDocuments() as DocumentSummary[]
  } catch {
    return []
  }
}

async function ensurePreviewForArtifact (artifactId: string): Promise<void> {
  if (!window.electronAPI?.ensureDocumentRenderPreview) return

  try {
    const artifact = await window.electronAPI.ensureDocumentRenderPreview(artifactId) as DocumentArtifact | null
    if (artifact && activeArtifact.value?.id === artifactId) {
      activeArtifact.value = artifact
    }
  } catch (error) {
    console.error('[document-file-tab] Failed to prepare preview:', error)
  }
}

async function loadSelectionsForArtifact (artifactId: string): Promise<void> {
  if (!window.electronAPI?.getDocumentSelections) {
    activeSelections.value = []
    return
  }
  activeSelections.value = await window.electronAPI.getDocumentSelections(artifactId) as SelectionRegion[]
}

async function loadSelectedArtifact (artifactId: string | null): Promise<void> {
  if (!artifactId || !window.electronAPI?.getDocument) {
    activeArtifact.value = null
    activeSelections.value = []
    return
  }

  previewLoading.value = true
  try {
    activeArtifact.value = await window.electronAPI.getDocument(artifactId) as DocumentArtifact | null
    if (!activeArtifact.value) {
      activeSelections.value = []
      return
    }

    await loadSelectionsForArtifact(artifactId)
    if (!activeArtifact.value.render || activeArtifact.value.render.status !== 'ready') {
      void ensurePreviewForArtifact(artifactId)
    }
  } catch (error) {
    console.error('[document-file-tab] Failed to load artifact:', error)
    activeArtifact.value = null
    activeSelections.value = []
  } finally {
    previewLoading.value = false
  }
}

/**
 * Resolves this tab's file into an imported artifact, importing it when the
 * store has not seen the path yet. Runs only while the tab is active; the
 * token discards stale resolutions after conversation switches.
 */
async function resolveDocumentArtifact (): Promise<void> {
  if (!filePath) return
  const token = ++resolveToken
  isResolving.value = true
  importError.value = ''

  try {
    let summaries = await listImportedDocumentSummaries()
    let summary = summaries.find(item => normalizeDocumentFileKey(item.filePath) === normalizeDocumentFileKey(filePath))

    if (!summary && window.electronAPI?.importDocument) {
      try {
        await window.electronAPI.importDocument(filePath)
        summaries = await listImportedDocumentSummaries()
        summary = summaries.find(item => normalizeDocumentFileKey(item.filePath) === normalizeDocumentFileKey(filePath))
      } catch (error) {
        const message = (error as Error).message || t('chatUi.importFailed')
        documentSummary.value = {
          artifactId: null,
          filePath,
          fileName,
          fileType: isMissingFileError(message) ? 'missing' : 'error',
          fileSize: 0,
          selectionCount: 0,
          status: isMissingFileError(message) ? 'missing' : 'error',
          error: isMissingFileError(message) ? t('chatUi.sourceFileMissingReadd') : message
        }
        return
      }
    }

    if (token !== resolveToken) return

    if (!summary) {
      documentSummary.value = {
        artifactId: null,
        filePath,
        fileName,
        fileType: 'missing',
        fileSize: 0,
        selectionCount: 0,
        status: 'missing',
        error: t('chatUi.sourceFileMissingReadd')
      }
      return
    }

    documentSummary.value = {
      artifactId: summary.id,
      filePath: summary.filePath,
      fileName: summary.fileName || fileName,
      fileType: summary.fileType,
      fileSize: summary.fileSize,
      selectionCount: summary.selectionCount,
      status: 'ready'
    }
    await loadSelectedArtifact(summary.id)
  } finally {
    if (token === resolveToken) isResolving.value = false
  }
}

async function refreshSelectionCount (): Promise<void> {
  if (documentSummary.value.status !== 'ready') return
  const summaries = await listImportedDocumentSummaries()
  const summary = summaries.find(item => normalizeDocumentFileKey(item.filePath) === normalizeDocumentFileKey(filePath))
  if (summary && documentSummary.value.artifactId === summary.id) {
    documentSummary.value = { ...documentSummary.value, selectionCount: summary.selectionCount }
  }
}

function formatSelectionLabel (text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return t('chatUi.selectionLabel', { index: activeSelections.value.length + 1 })
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized
}

function normalizeSelectionText (text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function tokenizeSelectionText (text: string): string[] {
  return normalizeSelectionText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length >= 2)
}

function collectAllNodes (nodes: DocumentNodeDTO[]): DocumentNodeDTO[] {
  const result: DocumentNodeDTO[] = []
  const walk = (list: DocumentNodeDTO[]) => {
    for (const node of list) {
      result.push(node)
      if (node.children?.length) {
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return result
}

function scoreNodeTextMatch (nodeText: string, normalizedExcerpt: string, excerptTokens: Set<string>): number {
  const normalizedNode = normalizeSelectionText(nodeText)
  if (!normalizedNode) return 0
  if (normalizedNode.includes(normalizedExcerpt)) return 1
  if (normalizedExcerpt.includes(normalizedNode) && normalizedNode.length >= 12) return 0.92

  const nodeTokens = tokenizeSelectionText(normalizedNode)
  if (nodeTokens.length === 0 || excerptTokens.size === 0) return 0

  let overlap = 0
  for (const token of nodeTokens) {
    if (excerptTokens.has(token)) overlap++
  }

  return overlap / Math.max(1, Math.min(nodeTokens.length, excerptTokens.size))
}

function resolveSelectionNodeIds (excerpt: string, pageIndex?: number): string[] {
  if (!activeArtifact.value) return []

  const normalizedExcerpt = normalizeSelectionText(excerpt)
  if (!normalizedExcerpt) return []
  const excerptTokens = new Set(tokenizeSelectionText(excerpt))

  const searchNodes = (pageFilter?: number) => collectAllNodes(activeArtifact.value!.nodes)
    .filter(node => !pageFilter || node.pageIndex === pageFilter)
    .map(node => ({ node, score: scoreNodeTextMatch(node.text, normalizedExcerpt, excerptTokens) }))
    .filter(candidate => candidate.score >= 0.45)
    .sort((left, right) => right.score - left.score || left.node.text.length - right.node.text.length)
    .slice(0, 12)
    .map(candidate => candidate.node.id)

  const pageMatches = pageIndex ? searchNodes(pageIndex) : []
  if (pageMatches.length > 0) return pageMatches
  return searchNodes()
}

function hasSameNodeSelection (nodeIds: string[], excerpt: string): boolean {
  const normalized = [...new Set(nodeIds)].sort()
  const normalizedExcerpt = excerpt.replace(/\s+/g, ' ').trim()
  return activeSelections.value.some(selection => {
    if (selection.nodeIds.length !== normalized.length) return false
    const existing = [...selection.nodeIds].sort()
    if (!existing.every((nodeId, index) => nodeId === normalized[index])) return false
    const existingExcerpt = selection.excerpt?.replace(/\s+/g, ' ').trim() || ''
    return existingExcerpt === normalizedExcerpt
  })
}

function buildSelectionTag (selection: SelectionRegion): string {
  const safeLabel = selection.label.replace(/\]\]/g, '').trim() || t('chatUi.documentTagFallback')
  return `[[doc:${selection.id}|${safeLabel}]]`
}

/** Full excerpt shown in the hover tooltip; falls back to the label text. */
function getSelectionTooltip (selection: SelectionRegion): string {
  const excerpt = selection.excerpt?.replace(/\s+/g, ' ').trim() || ''
  return excerpt || selection.label
}

function insertSelectionTag (selection: SelectionRegion): void {
  emit('insertSelectionTag', buildSelectionTag(selection))
}

async function handleHighlightSelection (payload: HighlightSelectionPayload): Promise<void> {
  const artifactId = documentSummary.value.artifactId
  if (!window.electronAPI?.createDocumentSelection || !activeArtifact.value || !artifactId) return
  const nodeIds = Array.from(new Set(payload.nodeIds?.length ? payload.nodeIds : resolveSelectionNodeIds(payload.text, payload.pageIndex)))
  if (hasSameNodeSelection(nodeIds, payload.text)) return

  try {
    await window.electronAPI.createDocumentSelection({
      artifactId,
      nodeIds,
      label: formatSelectionLabel(payload.text),
      color: nextColor(),
      excerpt: payload.text
    })
    await loadSelectionsForArtifact(artifactId)
    await refreshSelectionCount()
  } catch (error) {
    console.error('[document-file-tab] Failed to create tag from highlight:', error)
  }
}

async function removeSelection (regionId: string): Promise<void> {
  const artifactId = documentSummary.value.artifactId
  if (!window.electronAPI?.removeDocumentSelection || !activeArtifact.value || !artifactId) return
  await window.electronAPI.removeDocumentSelection(regionId)
  await loadSelectionsForArtifact(artifactId)
  await refreshSelectionCount()
}

async function openOriginalFile (): Promise<void> {
  if (!activeArtifact.value || !window.electronAPI?.openDocumentOriginal) return
  importError.value = ''
  const result = await window.electronAPI.openDocumentOriginal(activeArtifact.value.id)
  if (!result.success) {
    importError.value = t('chatUi.openOriginalFileFailed', { message: result.error || 'unknown error' })
  }
}

async function copyFilePath (): Promise<void> {
  try {
    await navigator.clipboard.writeText(filePath)
  } catch {
    // Clipboard writes can fail without permissions; the action is best-effort.
  }
}

// ---------------------------------------------------------------------------
// AI draft preview (draft state owned by the Rust harness; UI mirrors it)
// ---------------------------------------------------------------------------

const draft = computed(() => getWorkspaceDocumentDraft(filePath))
const draftArtifact = ref<DocumentArtifact | null>(null)
const draftBusy = ref(false)
const draftError = ref('')
const draftNotice = ref('')
let draftToken = 0

/** The tab previews the draft while one is pending, otherwise the original. */
const previewArtifact = computed(() => (draft.value ? draftArtifact.value : activeArtifact.value))

const draftTimeLabel = computed(() => {
  if (!draft.value) return ''
  const date = new Date(draft.value.createdAt)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString()
})

watch(draft, (value) => {
  const token = ++draftToken
  draftNotice.value = ''
  if (!value) {
    draftError.value = ''
    draftArtifact.value = null
    return
  }

  void (async () => {
    const api = window.electronAPI
    if (!api?.importDocument) {
      draftError.value = t('chatUi.documentDraftLoadFailed')
      return
    }
    draftError.value = ''
    const previousDraftId = draftArtifact.value?.id
    try {
      const { artifact } = await api.importDocument(value.draftPath)
      if (token !== draftToken) return
      draftArtifact.value = artifact
      if (previousDraftId && previousDraftId !== artifact.id && api.removeDocument) {
        // Draft re-imports are throwaway workbench entries; drop the stale one.
        void api.removeDocument(previousDraftId).catch(() => {})
      }
      if (!artifact.render || artifact.render.status !== 'ready') {
        const updated = await api.ensureDocumentRenderPreview(artifact.id)
        if (token === draftToken && updated) draftArtifact.value = updated
      }
    } catch (error) {
      if (token !== draftToken) return
      draftArtifact.value = null
      draftError.value = (error as Error).message || t('chatUi.documentDraftLoadFailed')
    }
  })()
}, { immediate: true })

async function applyDraftToSource (): Promise<void> {
  const current = draft.value
  if (!current || draftBusy.value || !window.electronAPI?.applyDocumentDraft) return
  draftBusy.value = true
  draftError.value = ''
  draftNotice.value = ''
  try {
    await window.electronAPI.applyDocumentDraft({
      artifactId: current.artifactId,
      sourceSha256: current.sourceSha256
    })
    const { artifact } = await window.electronAPI.refreshDocumentFromDisk(filePath)
    clearWorkspaceDocumentDraft(filePath)
    if (artifact) {
      activeArtifact.value = artifact
      documentSummary.value = {
        ...documentSummary.value,
        artifactId: artifact.id,
        fileType: artifact.fileType,
        fileSize: artifact.fileSize,
        status: 'ready',
        error: undefined
      }
    }
    draftNotice.value = t('chatUi.documentDraftApplied')
  } catch (error) {
    draftError.value = (error as Error).message || t('chatUi.documentDraftActionFailed')
  } finally {
    draftBusy.value = false
  }
}

async function saveDraftAsCopy (): Promise<void> {
  const current = draft.value
  if (!current || draftBusy.value || !window.electronAPI?.saveDocumentDraftAs) return
  draftBusy.value = true
  draftError.value = ''
  draftNotice.value = ''
  try {
    const result = await window.electronAPI.saveDocumentDraftAs({
      artifactId: current.artifactId,
      defaultName: fileName
    })
    if (!result.canceled && result.filePath) {
      clearWorkspaceDocumentDraft(filePath)
      draftNotice.value = t('chatUi.documentDraftSavedAs')
      const copyName = result.filePath.split(/[\\/]/).filter(Boolean).pop() || result.filePath
      const opened = ensureWorkspaceTab('document', { filePath: result.filePath, fileName: copyName })
      if (opened) opened.tab.title = copyName
    }
  } catch (error) {
    draftError.value = (error as Error).message || t('chatUi.documentDraftActionFailed')
  } finally {
    draftBusy.value = false
  }
}

async function discardDraft (): Promise<void> {
  const current = draft.value
  if (!current || draftBusy.value || !window.electronAPI?.discardDocumentDraft) return
  draftBusy.value = true
  draftError.value = ''
  draftNotice.value = ''
  try {
    await window.electronAPI.discardDocumentDraft(current.artifactId)
    clearWorkspaceDocumentDraft(filePath)
  } catch (error) {
    draftError.value = (error as Error).message || t('chatUi.documentDraftActionFailed')
  } finally {
    draftBusy.value = false
  }
}

/** Surfaces a pending draft again after an app restart / conversation switch. */
async function restorePendingDraft (): Promise<void> {
  if (!window.electronAPI?.getDocumentDraft) return
  try {
    const record = await window.electronAPI.getDocumentDraft(filePath)
    if (record && getWorkspaceDocumentDraft(filePath) === null) {
      stageWorkspaceDocumentDraft(record)
    }
  } catch {
    // Harness unavailable or no draft: silent, the original preview stays.
  }
}

/** Inserts a whole-document reference the chat resolves into full text context. */
function insertDocumentContextTag (): void {
  const artifactId = documentSummary.value.artifactId
  if (!artifactId) return
  emit('insertSelectionTag', `[[docfile:${artifactId}|${fileName}]]`)
}

watch(
  () => props.tab.state,
  () => {
    // Tab state is written at creation; later external mutations (restore)
    // re-resolve while the tab is active.
    if (isActiveTab.value) void resolveDocumentArtifact()
  }
)

// A fresh render invalidates the old fit; return to 100% so the new document
// never appears cropped.
watch(() => documentSummary.value.artifactId, () => {
  zoomScale.value = 1
})

onActivated(() => {
  isActiveTab.value = true
  if (documentSummary.value.status === 'resolving' || !documentSummary.value.artifactId) {
    void resolveDocumentArtifact()
  }
  void restorePendingDraft()
})

onDeactivated(() => {
  isActiveTab.value = false
})

onBeforeUnmount(() => {
  isActiveTab.value = false
})

defineExpose({
  openOriginalFile,
  copyFilePath,
  insertDocumentContextTag
})
</script>

<template>
  <div class="document-file-tab">
    <div class="doc-preview-stack">
      <div ref="viewportRef" class="doc-viewport" :class="{ 'pdf-active': documentSummary.fileType === 'pdf' }">
        <div ref="canvasRef" class="doc-canvas" :style="canvasStyle">
          <template v-if="hasRenderableDocument && previewArtifact">
            <div class="doc-paper">
              <DocumentRenderHost
                :artifact="previewArtifact"
                :selections="activeSelections"
                @highlight-selection="handleHighlightSelection"
              />
            </div>
          </template>

          <div v-else-if="previewLoading || isResolving" class="preview-state-card">
            <div class="preview-state-title">{{ $t('chatUi.preparingDocumentPreview') }}</div>
            <div class="preview-state-detail">{{ $t('chatUi.preparingDocumentPreviewDetail') }}</div>
          </div>

          <div v-else-if="selectedDocument && selectedDocument.status === 'missing'" class="preview-state-card warning">
            <div class="preview-state-title">{{ $t('chatUi.documentFileMissing') }}</div>
            <div class="preview-state-detail">{{ selectedDocument.error }}</div>
            <div class="preview-state-path">{{ selectedDocument.filePath }}</div>
          </div>

          <div v-else-if="selectedDocument" class="preview-state-card warning">
            <div class="preview-state-title">{{ $t('chatUi.documentUnavailable') }}</div>
            <div class="preview-state-detail">{{ selectedDocument.error || $t('chatUi.deleteAndReaddDocument') }}</div>
            <div class="preview-state-path">{{ selectedDocument.filePath }}</div>
          </div>

          <div v-else class="preview-state-card">
            <div class="preview-state-title">{{ fileName }}</div>
            <div class="preview-state-detail">{{ $t('chatUi.preparingDocumentPreviewDetail') }}</div>
          </div>
        </div>
      </div>

      <!-- Checked-in context (selection tags) floats above the full-bleed preview. -->
      <div v-if="activeSelections.length > 0 || importError" class="doc-context-bar">
        <div
          v-for="selection in activeSelections"
          :key="selection.id"
          class="selection-tag-card"
          :style="{ '--tag-color': selection.color }"
        >
          <button class="selection-tag" type="button" @click="insertSelectionTag(selection)">
            <span class="tag-dot"></span>
            <span class="tag-label">#{{ selection.label }}</span>
          </button>
          <button class="tag-remove" type="button" :title="$t('chatUi.deleteTag')" @click.stop="removeSelection(selection.id)">×</button>
          <div class="selection-tooltip">{{ getSelectionTooltip(selection) }}</div>
        </div>
        <span v-if="importError" class="doc-context-error" :title="importError">{{ importError }}</span>
      </div>

      <!-- Pending AI draft: floating decision bar above the previewed draft file. -->
      <div v-if="draft" class="doc-draft-banner" role="status">
        <div class="doc-draft-head">
          <span class="doc-draft-badge">{{ $t('chatUi.documentDraftBadge') }}</span>
          <span class="doc-draft-meta">{{ $t('chatUi.documentDraftMeta') }}<template v-if="draftTimeLabel"> · {{ draftTimeLabel }}</template></span>
        </div>
        <div v-if="draftError" class="doc-draft-error">{{ draftError }}</div>
        <div v-else-if="draftNotice" class="doc-draft-notice">{{ draftNotice }}</div>
        <div class="doc-draft-actions">
          <button class="doc-draft-btn primary" type="button" :disabled="draftBusy" @click="applyDraftToSource">
            {{ $t('chatUi.documentDraftApply') }}
          </button>
          <button class="doc-draft-btn" type="button" :disabled="draftBusy" @click="saveDraftAsCopy">
            {{ $t('chatUi.documentDraftSaveAs') }}
          </button>
          <button class="doc-draft-btn ghost" type="button" :disabled="draftBusy" @click="discardDraft">
            {{ $t('chatUi.documentDraftDiscard') }}
          </button>
        </div>
      </div>

      <div class="doc-zoom-cluster">
        <button class="doc-zoom-btn" type="button" :title="$t('chatUi.workspaceZoomOut')" @click="zoomOut">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="doc-zoom-value" type="button" :title="$t('chatUi.workspaceZoomReset')" @click="zoomReset">{{ zoomPercent }}</button>
        <button class="doc-zoom-btn" type="button" :title="$t('chatUi.workspaceZoomIn')" @click="zoomIn">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <span class="doc-zoom-divider"></span>
        <button class="doc-zoom-btn doc-zoom-fit" type="button" :title="$t('chatUi.workspaceZoomFit')" @click="zoomFit">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 3H4v5"/><path d="M15 3h5v5"/><path d="M9 21H4v-5"/><path d="M15 21h5v-5"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.document-file-tab {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--app-panel);
  overflow: hidden;
}

.doc-preview-stack {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.doc-draft-banner {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 8;
  width: min(560px, calc(100% - 32px));
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 32%, transparent);
  background: color-mix(in srgb, var(--app-panel) 96%, transparent);
  backdrop-filter: blur(14px);
  box-shadow: 0 16px 38px rgba(15, 23, 42, 0.22);
}

.doc-draft-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.doc-draft-badge {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--app-text-strong);
  background: color-mix(in srgb, var(--app-accent-soft) 62%, transparent);
  border: 1px solid color-mix(in srgb, var(--app-accent) 30%, transparent);
}

.doc-draft-meta {
  color: var(--app-text-muted);
  font-size: 0.76rem;
}

.doc-draft-error,
.doc-draft-notice {
  font-size: 0.76rem;
  border-radius: 8px;
  padding: 6px 9px;
  word-break: break-all;
}

.doc-draft-error {
  color: #b91c1c;
  background: color-mix(in srgb, #ef4444 12%, transparent);
}

.doc-draft-notice {
  color: #166534;
  background: color-mix(in srgb, #22c55e 14%, transparent);
}

.doc-draft-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.doc-draft-btn {
  height: 28px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  background: color-mix(in srgb, var(--app-panel) 92%, transparent);
  color: var(--app-text);
  font-size: 0.76rem;
  font-weight: 600;
  cursor: pointer;
}

.doc-draft-btn:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--app-accent) 36%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 38%, var(--app-panel));
}

.doc-draft-btn.primary {
  color: #fff;
  background: var(--app-accent, #2563eb);
  border-color: transparent;
}

.doc-draft-btn.primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-accent, #2563eb) 86%, #000);
}

.doc-draft-btn.ghost {
  background: transparent;
  color: var(--app-text-muted);
}

.doc-draft-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.doc-viewport {
  position: absolute;
  inset: 0;
  overflow: auto;
  padding: 16px;
  background:
    radial-gradient(1200px 400px at 50% -160px, color-mix(in srgb, var(--app-accent-soft) 16%, transparent), transparent),
    linear-gradient(180deg, color-mix(in srgb, var(--app-panel-subtle) 72%, transparent), var(--app-panel) 240px);
}

.doc-canvas {
  min-width: 100%;
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.doc-paper {
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  background: var(--app-panel);
  border: 1px solid color-mix(in srgb, var(--app-border) 76%, transparent);
  border-radius: 14px;
  box-shadow: 0 14px 40px rgba(15, 23, 42, 0.10);
  overflow: hidden;
}

/* Checked-in context floats above the preview as a wrapping pill row; it
   never consumes layout space and never clips (tooltips escape it). */
.doc-context-bar {
  position: absolute;
  top: 10px;
  left: 16px;
  right: 16px;
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  background: color-mix(in srgb, var(--app-panel) 88%, transparent);
  backdrop-filter: blur(12px);
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.16);
}

.doc-context-error {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  align-self: center;
  padding: 3px 8px;
  border-radius: 8px;
  color: var(--app-danger);
  background: color-mix(in srgb, var(--app-danger) 10%, transparent);
  font-size: 0.72em;
}

.selection-tag-card {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
}

.selection-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 240px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--tag-color, #3b82f6) 32%, transparent);
  background: color-mix(in srgb, var(--tag-color, #3b82f6) 12%, var(--app-panel));
  color: var(--app-text);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.selection-tag:hover {
  border-color: color-mix(in srgb, var(--tag-color, #3b82f6) 52%, transparent);
  background: color-mix(in srgb, var(--tag-color, #3b82f6) 20%, var(--app-panel));
}

.tag-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--tag-color, #3b82f6);
  flex: 0 0 auto;
}

.tag-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.74em;
  font-weight: 600;
}

.tag-remove {
  flex: 0 0 auto;
  border: none;
  background: none;
  color: var(--app-text-muted);
  cursor: pointer;
  line-height: 1;
}

/* Hover reveals the full excerpt below the pill; click-through disabled so it
   never steals the pointer from the pill or the preview. */
.selection-tooltip {
  display: none;
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 8;
  max-width: 400px;
  padding: 8px 11px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  background: color-mix(in srgb, var(--app-panel) 98%, transparent);
  box-shadow: 0 14px 34px rgba(15, 23, 42, 0.22);
  color: var(--app-text);
  font-size: 0.74em;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  pointer-events: none;
}

.selection-tag-card:hover .selection-tooltip {
  display: block;
}

.doc-zoom-cluster {
  position: absolute;
  right: 14px;
  bottom: 14px;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 11px;
  border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  background: color-mix(in srgb, var(--app-panel) 90%, transparent);
  backdrop-filter: blur(12px);
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.16);
}

.doc-zoom-btn,
.doc-zoom-value {
  height: 26px;
  min-width: 26px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.doc-zoom-btn:hover,
.doc-zoom-value:hover {
  background: color-mix(in srgb, var(--app-accent-soft) 46%, transparent);
  color: var(--app-text-strong);
}

.doc-zoom-value {
  min-width: 48px;
  padding: 0 6px;
  font-size: 0.72rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.doc-zoom-fit {
  padding: 0 6px;
}

.doc-zoom-divider {
  width: 1px;
  height: 16px;
  margin: 0 3px;
  background: color-mix(in srgb, var(--app-border) 82%, transparent);
}

.preview-state-card {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 48px 24px;
}

.preview-state-card.warning {
  color: #92400e;
}

.preview-state-title {
  font-size: 0.98em;
  font-weight: 700;
  color: var(--app-text-strong);
  word-break: break-all;
  text-align: center;
}

.preview-state-detail {
  margin-top: 8px;
  max-width: 420px;
  font-size: 0.8em;
  line-height: 1.6;
  color: var(--app-text-muted);
  text-align: center;
}

.preview-state-path {
  margin-top: 12px;
  font-size: 0.76em;
  color: var(--app-text);
  word-break: break-all;
  text-align: center;
}
</style>
