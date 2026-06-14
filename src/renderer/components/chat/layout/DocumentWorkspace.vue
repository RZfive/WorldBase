<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import DocumentRenderHost from '../blocks/DocumentRenderHost.vue'

type DocumentNode = DocumentNodeDTO
type DocumentArtifact = DocumentArtifactDTO
type DocumentSummary = DocumentSummaryDTO
type SelectionRegion = DocumentSelectionDTO
type DocumentReference = ConversationDocumentReference
type DocumentWorkspaceState = ConversationDocumentWorkspaceState

interface WorkspaceDocumentItem {
  artifactId: string | null
  filePath: string
  fileName: string
  fileType: string
  fileSize: number
  importedAt?: string
  selectionCount: number
  status: 'ready' | 'missing' | 'error'
  error?: string
}

interface HighlightSelectionPayload {
  nodeIds?: string[]
  text: string
  pageIndex?: number
}

const props = withDefaults(defineProps<{
  visible: boolean
  workspaceDocuments?: DocumentReference[]
  activeFilePath?: string | null
  workspaceWidth?: number
}>(), {
  workspaceDocuments: () => [],
  activeFilePath: null,
  workspaceWidth: 760
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'insertSelectionTag', tag: string): void
  (e: 'updateWorkspace', state: DocumentWorkspaceState): void
}>()

const workspaceDocuments = ref<WorkspaceDocumentItem[]>([])
const activeFilePath = ref<string | null>(null)
const activeArtifact = ref<DocumentArtifact | null>(null)
const activeSelections = ref<SelectionRegion[]>([])
const importError = ref('')
const isImporting = ref(false)
const previewLoading = ref(false)
const workspaceRoot = ref<HTMLElement | null>(null)
const sidebarCollapsed = ref(false)

const CONVERSATION_SIDEBAR_WIDTH = 252
const MIN_CHAT_MAIN_WIDTH = 640
const WORKSPACE_RESIZE_HANDLE_WIDTH = 12
const EXPANDED_SIDEBAR_WIDTH = 260
const COLLAPSED_SIDEBAR_WIDTH = 74
const PREFERRED_PREVIEW_MIN_WIDTH = EXPANDED_SIDEBAR_WIDTH * 2
const DEFAULT_WORKSPACE_WIDTH = 900
const MIN_WORKSPACE_WIDTH = EXPANDED_SIDEBAR_WIDTH + PREFERRED_PREVIEW_MIN_WIDTH + WORKSPACE_RESIZE_HANDLE_WIDTH
const MAX_WORKSPACE_WIDTH = 1280
const workspaceWidth = ref(props.workspaceWidth || DEFAULT_WORKSPACE_WIDTH)
const SELECTION_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16']
let colorIndex = 0
let resizeStartX = 0
let resizeStartWidth = 0
let resizing = false
let layoutObserver: ResizeObserver | null = null

const selectedDocument = computed(() => {
  const activeKey = normalizeFileKey(activeFilePath.value)
  return workspaceDocuments.value.find(item => normalizeFileKey(item.filePath) === activeKey) || null
})

const sidebarWidth = computed(() => (sidebarCollapsed.value ? COLLAPSED_SIDEBAR_WIDTH : EXPANDED_SIDEBAR_WIDTH))
const previewMinWidth = computed(() => {
  return Math.max(0, Math.min(PREFERRED_PREVIEW_MIN_WIDTH, workspaceWidth.value - sidebarWidth.value - WORKSPACE_RESIZE_HANDLE_WIDTH))
})

function nextColor (): string {
  const color = SELECTION_COLORS[colorIndex % SELECTION_COLORS.length]
  colorIndex++
  return color
}

function normalizeFileKey (filePath?: string | null): string {
  return (filePath || '')
    .trim()
    .replace(/\//g, '\\')
    .toLowerCase()
}

function getFileName (filePath: string, fallback?: string | null): string {
  const normalizedFallback = fallback?.trim()
  if (normalizedFallback) return normalizedFallback
  const segments = filePath.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] || filePath
}

function sanitizeDocumentReferences (documents: DocumentReference[]): DocumentReference[] {
  const uniqueDocuments = new Map<string, DocumentReference>()

  for (const documentRef of documents) {
    const filePath = documentRef?.filePath?.trim()
    if (!filePath) continue
    const fileKey = normalizeFileKey(filePath)
    if (!fileKey || uniqueDocuments.has(fileKey)) continue
    uniqueDocuments.set(fileKey, {
      filePath,
      fileName: getFileName(filePath, documentRef.fileName)
    })
  }

  return Array.from(uniqueDocuments.values())
}

function toDocumentReferences (documents: WorkspaceDocumentItem[]): DocumentReference[] {
  return documents.map(documentItem => ({
    filePath: documentItem.filePath,
    fileName: documentItem.fileName
  }))
}

function emitWorkspaceStateFrom (documents: WorkspaceDocumentItem[], nextActiveFilePath: string | null): void {
  emit('updateWorkspace', {
    documents: toDocumentReferences(documents),
    activeFilePath: nextActiveFilePath || undefined,
    width: workspaceWidth.value
  })
}

function formatFileSize (bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDateTime (value?: string): string {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function getTypeLabel (type: string): string {
  const labels: Record<string, string> = {
    pdf: 'PDF',
    xlsx: 'Excel',
    docx: 'Word',
    pptx: 'PPT',
    missing: '文件丢失',
    error: '异常'
  }
  return labels[type] || type.toUpperCase()
}

function getTypeEmoji (type: string): string {
  const emojis: Record<string, string> = {
    pdf: '📕',
    xlsx: '📊',
    docx: '📄',
    pptx: '🎞️',
    missing: '⚠️',
    error: '⚠️'
  }
  return emojis[type] || '📎'
}

function getStatusLabel (status: WorkspaceDocumentItem['status']): string {
  if (status === 'ready') return '已就绪'
  if (status === 'missing') return '文件丢失'
  return '加载失败'
}

function isMissingFileError (message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('enoent')
    || normalized.includes('no such file')
    || message.includes('路径不是一个文件')
    || message.includes('不存在')
    || message.includes('找不到')
}

function getChatPanelWidth (): number {
  return workspaceRoot.value?.parentElement?.clientWidth || Math.max(0, window.innerWidth - CONVERSATION_SIDEBAR_WIDTH)
}

function getMaxWorkspaceWidth (): number {
  const maxByParent = getChatPanelWidth() - MIN_CHAT_MAIN_WIDTH
  return Math.max(COLLAPSED_SIDEBAR_WIDTH + 280, Math.min(MAX_WORKSPACE_WIDTH, Math.round(maxByParent)))
}

function clampWorkspaceWidth (value: number): number {
  const maxWorkspaceWidth = getMaxWorkspaceWidth()
  const minWorkspaceWidth = Math.min(MIN_WORKSPACE_WIDTH, maxWorkspaceWidth)
  return Math.min(maxWorkspaceWidth, Math.max(minWorkspaceWidth, Math.round(value)))
}

function clearActiveDocumentState (): void {
  activeArtifact.value = null
  activeSelections.value = []
  previewLoading.value = false
}

function startResize (event: MouseEvent): void {
  resizeStartX = event.clientX
  resizeStartWidth = clampWorkspaceWidth(workspaceWidth.value)
  resizing = true
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = 'ew-resize'
  document.body.style.userSelect = 'none'
}

function onResizeMove (event: MouseEvent): void {
  const delta = resizeStartX - event.clientX
  workspaceWidth.value = clampWorkspaceWidth(resizeStartWidth + delta)
}

function stopResize (): void {
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  if (!resizing) return
  resizing = false
  emitWorkspaceStateFrom(workspaceDocuments.value, activeFilePath.value)
}

function bindLayoutObserver (): void {
  if (typeof ResizeObserver === 'undefined') return

  const parent = workspaceRoot.value?.parentElement
  if (!parent) return

  layoutObserver?.disconnect()
  layoutObserver = new ResizeObserver(() => {
    if (resizing) return
    workspaceWidth.value = clampWorkspaceWidth(workspaceWidth.value)
  })
  layoutObserver.observe(parent)
}

async function syncWorkspaceWidthToLayout (preferredWidth?: number): Promise<void> {
  if (resizing || !props.visible) return

  const desiredWidth = typeof preferredWidth === 'number' && Number.isFinite(preferredWidth)
    ? preferredWidth
    : workspaceWidth.value

  await nextTick()
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })

  if (resizing || !props.visible || !workspaceRoot.value?.parentElement) return
  workspaceWidth.value = clampWorkspaceWidth(desiredWidth)
}

onBeforeUnmount(() => {
  stopResize()
  layoutObserver?.disconnect()
  layoutObserver = null
})

onMounted(() => {
  if (!props.visible) return
  bindLayoutObserver()
  void syncWorkspaceWidthToLayout(props.workspaceWidth)
})

async function listImportedDocumentSummaries (): Promise<DocumentSummary[]> {
  if (!window.electronAPI?.listDocuments) return []
  try {
    return await window.electronAPI.listDocuments() as DocumentSummary[]
  } catch {
    return []
  }
}

function buildSummaryMap (documents: DocumentSummary[]): Map<string, DocumentSummary> {
  const summaryMap = new Map<string, DocumentSummary>()
  for (const documentSummary of documents) {
    summaryMap.set(normalizeFileKey(documentSummary.filePath), documentSummary)
  }
  return summaryMap
}

function resolveNextActiveFilePath (documents: WorkspaceDocumentItem[], preferredFilePath?: string | null): string | null {
  const preferredKey = normalizeFileKey(preferredFilePath)
  const existingPreferredDocument = documents.find(item => normalizeFileKey(item.filePath) === preferredKey)
  if (existingPreferredDocument) return existingPreferredDocument.filePath

  const readyDocument = documents.find(item => item.status === 'ready')
  if (readyDocument) return readyDocument.filePath

  return documents[0]?.filePath || null
}

async function ensurePreviewForArtifact (artifactId: string): Promise<void> {
  if (!window.electronAPI?.ensureDocumentRenderPreview) return

  try {
    const artifact = await window.electronAPI.ensureDocumentRenderPreview(artifactId) as DocumentArtifact | null
    if (artifact && activeArtifact.value?.id === artifactId) {
      activeArtifact.value = artifact
    }
  } catch (error) {
    console.error('[document-workspace] Failed to prepare preview:', error)
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
    clearActiveDocumentState()
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
    console.error('[document-workspace] Failed to load artifact:', error)
    activeArtifact.value = null
    activeSelections.value = []
  } finally {
    previewLoading.value = false
  }
}

async function syncActiveArtifact (): Promise<void> {
  const documentItem = selectedDocument.value
  if (!documentItem || documentItem.status !== 'ready' || !documentItem.artifactId) {
    clearActiveDocumentState()
    return
  }

  await loadSelectedArtifact(documentItem.artifactId)
}

async function syncWorkspaceDocuments (
  nextReferences: DocumentReference[],
  preferredFilePath?: string | null
): Promise<{ documents: WorkspaceDocumentItem[]; activeFilePath: string | null }> {
  const normalizedReferences = sanitizeDocumentReferences(nextReferences)
  importError.value = ''

  if (normalizedReferences.length === 0) {
    workspaceDocuments.value = []
    activeFilePath.value = null
    clearActiveDocumentState()
    return { documents: [], activeFilePath: null }
  }

  let importedDocuments = await listImportedDocumentSummaries()
  let summaryMap = buildSummaryMap(importedDocuments)
  const failedImports = new Map<string, WorkspaceDocumentItem>()
  let shouldReloadDocuments = false

  for (const documentRef of normalizedReferences) {
    const fileKey = normalizeFileKey(documentRef.filePath)
    if (summaryMap.has(fileKey) || !window.electronAPI?.importDocument) continue

    try {
      await window.electronAPI.importDocument(documentRef.filePath)
      shouldReloadDocuments = true
    } catch (error) {
      const message = (error as Error).message || '导入失败'
      failedImports.set(fileKey, {
        artifactId: null,
        filePath: documentRef.filePath,
        fileName: getFileName(documentRef.filePath, documentRef.fileName),
        fileType: isMissingFileError(message) ? 'missing' : 'error',
        fileSize: 0,
        selectionCount: 0,
        status: isMissingFileError(message) ? 'missing' : 'error',
        error: isMissingFileError(message)
          ? '源文件已丢失，请删除该记录后重新添加。'
          : message
      })
    }
  }

  if (shouldReloadDocuments) {
    importedDocuments = await listImportedDocumentSummaries()
    summaryMap = buildSummaryMap(importedDocuments)
  }

  const resolvedDocuments = normalizedReferences.map(documentRef => {
    const fileKey = normalizeFileKey(documentRef.filePath)
    const documentSummary = summaryMap.get(fileKey)
    if (documentSummary) {
      return {
        artifactId: documentSummary.id,
        filePath: documentSummary.filePath,
        fileName: getFileName(documentSummary.filePath, documentSummary.fileName),
        fileType: documentSummary.fileType,
        fileSize: documentSummary.fileSize,
        importedAt: documentSummary.importedAt,
        selectionCount: documentSummary.selectionCount,
        status: 'ready' as const
      }
    }

    return failedImports.get(fileKey) || {
      artifactId: null,
      filePath: documentRef.filePath,
      fileName: getFileName(documentRef.filePath, documentRef.fileName),
      fileType: 'missing',
      fileSize: 0,
      selectionCount: 0,
      status: 'missing' as const,
      error: '源文件已丢失，请删除该记录后重新添加。'
    }
  })

  workspaceDocuments.value = resolvedDocuments
  activeFilePath.value = resolveNextActiveFilePath(resolvedDocuments, preferredFilePath)
  await syncActiveArtifact()
  return {
    documents: resolvedDocuments,
    activeFilePath: activeFilePath.value
  }
}

async function refreshWorkspaceDocuments (): Promise<void> {
  await syncWorkspaceDocuments(toDocumentReferences(workspaceDocuments.value), activeFilePath.value)
}

async function handleImportClick (): Promise<void> {
  if (!window.electronAPI?.pickDocumentFiles) return

  isImporting.value = true
  importError.value = ''

  try {
    const { canceled, filePaths } = await window.electronAPI.pickDocumentFiles()
    if (canceled || filePaths.length === 0) return

    const nextReferences = sanitizeDocumentReferences([
      ...toDocumentReferences(workspaceDocuments.value),
      ...filePaths.map(filePath => ({
        filePath,
        fileName: getFileName(filePath)
      }))
    ])
    const lastImportedFilePath = filePaths[filePaths.length - 1] || null
    const state = await syncWorkspaceDocuments(nextReferences, lastImportedFilePath)
    emitWorkspaceStateFrom(state.documents, state.activeFilePath)
  } catch (error) {
    importError.value = `打开文件选择器失败: ${(error as Error).message}`
  } finally {
    isImporting.value = false
  }
}

async function selectDocument (filePath: string): Promise<void> {
  activeFilePath.value = filePath
  await syncActiveArtifact()
  emitWorkspaceStateFrom(workspaceDocuments.value, activeFilePath.value)
}

async function removeLinkedDocument (filePath: string): Promise<void> {
  const nextReferences = toDocumentReferences(workspaceDocuments.value)
    .filter(item => normalizeFileKey(item.filePath) !== normalizeFileKey(filePath))
  const preferredFilePath = normalizeFileKey(activeFilePath.value) === normalizeFileKey(filePath)
    ? null
    : activeFilePath.value
  const state = await syncWorkspaceDocuments(nextReferences, preferredFilePath)
  emitWorkspaceStateFrom(state.documents, state.activeFilePath)
}

function toggleSidebarCollapsed (): void {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

function formatSelectionLabel (text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return `选区 ${activeSelections.value.length + 1}`
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

function collectAllNodes (nodes: DocumentNode[]): DocumentNode[] {
  const result: DocumentNode[] = []
  const walk = (list: DocumentNode[]) => {
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
  const safeLabel = selection.label.replace(/\]\]/g, '').trim() || '文档标签'
  return `[[doc:${selection.id}|${safeLabel}]]`
}

function insertSelectionTag (selection: SelectionRegion): void {
  emit('insertSelectionTag', buildSelectionTag(selection))
}

async function handleHighlightSelection (payload: HighlightSelectionPayload): Promise<void> {
  if (!window.electronAPI?.createDocumentSelection || !activeArtifact.value) return
  const nodeIds = Array.from(new Set(payload.nodeIds?.length ? payload.nodeIds : resolveSelectionNodeIds(payload.text, payload.pageIndex)))
  if (hasSameNodeSelection(nodeIds, payload.text)) return

  try {
    await window.electronAPI.createDocumentSelection({
      artifactId: activeArtifact.value.id,
      nodeIds,
      label: formatSelectionLabel(payload.text),
      color: nextColor(),
      excerpt: payload.text
    })
    await loadSelectionsForArtifact(activeArtifact.value.id)
    await refreshWorkspaceDocuments()
  } catch (error) {
    console.error('[document-workspace] Failed to create tag from highlight:', error)
  }
}

async function removeSelection (regionId: string): Promise<void> {
  if (!window.electronAPI?.removeDocumentSelection || !activeArtifact.value) return
  await window.electronAPI.removeDocumentSelection(regionId)
  await loadSelectionsForArtifact(activeArtifact.value.id)
  await refreshWorkspaceDocuments()
}

async function openOriginalFile (): Promise<void> {
  if (!activeArtifact.value || !window.electronAPI?.openDocumentOriginal) return
  importError.value = ''
  const result = await window.electronAPI.openDocumentOriginal(activeArtifact.value.id)
  if (!result.success) {
    importError.value = `打开原文件失败: ${result.error || 'unknown error'}`
  }
}

watch(
  () => props.workspaceWidth,
  (width) => {
    if (typeof width !== 'number' || resizing) return
    if (!props.visible || !workspaceRoot.value?.parentElement) {
      workspaceWidth.value = Math.round(width)
      return
    }
    workspaceWidth.value = clampWorkspaceWidth(width)
  },
  { immediate: true }
)

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) {
      stopResize()
      layoutObserver?.disconnect()
      layoutObserver = null
      return
    }

    await nextTick()
    bindLayoutObserver()
    await syncWorkspaceWidthToLayout(props.workspaceWidth)
  },
  { immediate: true }
)

watch(
  () => [props.visible, props.activeFilePath, props.workspaceDocuments],
  async ([visible, preferredFilePath]) => {
    if (!visible) {
      return
    }
    await syncWorkspaceDocuments(props.workspaceDocuments, preferredFilePath as string | null | undefined)
  },
  { immediate: true, deep: true }
)
</script>

<template>
  <aside
    v-if="visible"
    ref="workspaceRoot"
    class="document-workspace"
    :style="{ width: `${workspaceWidth}px`, flexBasis: `${workspaceWidth}px`, maxWidth: `${workspaceWidth}px` }"
  >
    <div class="workspace-resize-handle" @mousedown.prevent="startResize">
      <div class="resize-grip"></div>
    </div>

    <div class="workspace-shell">
      <div class="workspace-header">
        <div>
          <h3 class="workspace-title">文档工作区</h3>
          <p class="workspace-subtitle">右侧独立查看文档，不打断主对话。</p>
        </div>
        <div class="workspace-header-actions">
          <button class="workspace-close" type="button" title="关闭文档工作区" @click="emit('close')">×</button>
        </div>
      </div>

      <div class="workspace-body">
        <aside :class="['workspace-rail', { collapsed: sidebarCollapsed }]" :style="{ width: `${sidebarWidth}px` }">
          <div class="rail-actions">
            <button class="import-btn" :class="{ disabled: isImporting, compact: sidebarCollapsed }" :disabled="isImporting" type="button" @click="handleImportClick">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <span v-if="!sidebarCollapsed">导入当前会话文档</span>
            </button>
            <div v-if="!sidebarCollapsed" class="import-hint">仅记录文件路径。下次打开对话时会按路径恢复，找不到文件则标记为丢失。</div>
            <div v-if="importError && !sidebarCollapsed" class="import-error">{{ importError }}</div>
          </div>

          <div class="doc-list">
            <div
              v-for="doc in workspaceDocuments"
              :key="doc.filePath"
              class="doc-item"
              :class="{ active: normalizeFileKey(doc.filePath) === normalizeFileKey(activeFilePath), compact: sidebarCollapsed }"
              :title="sidebarCollapsed ? `${doc.fileName}\n${doc.filePath}` : undefined"
              @click="selectDocument(doc.filePath)"
            >
              <span class="doc-icon">{{ getTypeEmoji(doc.fileType) }}</span>
              <div v-if="!sidebarCollapsed" class="doc-meta">
                <div class="doc-name">{{ doc.fileName }}</div>
                <div class="doc-detail">
                  {{ getTypeLabel(doc.fileType) }}
                  <span v-if="doc.status === 'ready'">· {{ formatFileSize(doc.fileSize) }}</span>
                  <span v-if="doc.selectionCount > 0">· {{ doc.selectionCount }} 标签</span>
                </div>
                <div v-if="doc.status !== 'ready'" class="doc-problem">{{ doc.error }}</div>
              </div>
              <button v-if="!sidebarCollapsed" class="doc-remove" type="button" title="从当前对话移除" @click.stop="removeLinkedDocument(doc.filePath)">×</button>
            </div>

            <div v-if="workspaceDocuments.length === 0" class="doc-empty">{{ sidebarCollapsed ? '无' : '当前对话暂无文档' }}</div>
          </div>

          <div v-if="!sidebarCollapsed" class="detail-card" :class="{ empty: !selectedDocument }">
            <template v-if="selectedDocument">
              <div class="detail-card-header">
                <span class="detail-card-title">文档详情</span>
                <span :class="['detail-status', `status-${selectedDocument.status}`]">{{ getStatusLabel(selectedDocument.status) }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">名称</span>
                <span class="detail-value" :title="selectedDocument.fileName">{{ selectedDocument.fileName }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">类型</span>
                <span class="detail-value">{{ getTypeLabel(selectedDocument.fileType) }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">大小</span>
                <span class="detail-value">{{ selectedDocument.fileSize > 0 ? formatFileSize(selectedDocument.fileSize) : '未读取' }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">标签</span>
                <span class="detail-value">{{ selectedDocument.selectionCount }} 个</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">导入时间</span>
                <span class="detail-value">{{ formatDateTime(selectedDocument.importedAt) }}</span>
              </div>
              <div class="detail-path" :title="selectedDocument.filePath">{{ selectedDocument.filePath }}</div>
            </template>
            <template v-else>
              <div class="detail-card-title">文档详情</div>
              <div class="detail-empty-text">选中文档后，这里会显示路径、状态和标签数。</div>
            </template>
          </div>
        </aside>

        <button
          class="workspace-list-toggle"
          type="button"
          :style="{ left: `${sidebarWidth}px` }"
          :title="sidebarCollapsed ? '展开文档列表' : '收起文档列表'"
          :aria-label="sidebarCollapsed ? '展开文档列表' : '收起文档列表'"
          @click="toggleSidebarCollapsed"
        >
          <svg v-if="sidebarCollapsed" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 6l6 6-6 6" />
          </svg>
          <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>

        <section class="workspace-preview" :style="{ minWidth: `${previewMinWidth}px` }">
          <template v-if="selectedDocument">
            <div class="preview-toolbar">
              <button class="toolbar-btn" type="button" :disabled="!activeArtifact" @click="openOriginalFile">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/></svg>
                打开原文件
              </button>
              <span class="preview-hint">高亮文档内容会自动生成标签。点击标签会插入聊天输入框。</span>
            </div>

            <div v-if="activeSelections.length > 0" class="selection-tags">
              <div
                v-for="selection in activeSelections"
                :key="selection.id"
                class="selection-tag-card"
                :style="{ '--tag-color': selection.color }"
              >
                <button class="selection-tag" type="button" :title="buildSelectionTag(selection)" @click="insertSelectionTag(selection)">
                  <span class="tag-dot"></span>
                  <span class="tag-label">#{{ selection.label }}</span>
                </button>
                <button class="tag-remove" type="button" title="删除标签" @click.stop="removeSelection(selection.id)">×</button>
              </div>
            </div>

            <div class="preview-scroll" :class="{ 'pdf-active': selectedDocument.fileType === 'pdf' }">
              <div v-if="previewLoading" class="preview-state-card">
                <div class="preview-state-title">正在准备文档预览</div>
                <div class="preview-state-detail">首次打开会生成预览资源，较大的 PDF 或 Office 文档可能稍慢。</div>
              </div>

              <DocumentRenderHost
                v-else-if="selectedDocument.status === 'ready' && activeArtifact"
                :artifact="activeArtifact"
                :selections="activeSelections"
                @highlight-selection="handleHighlightSelection"
              />

              <div v-else-if="selectedDocument.status === 'missing'" class="preview-state-card warning">
                <div class="preview-state-title">文档文件已丢失</div>
                <div class="preview-state-detail">{{ selectedDocument.error }}</div>
                <div class="preview-state-path">{{ selectedDocument.filePath }}</div>
              </div>

              <div v-else class="preview-state-card warning">
                <div class="preview-state-title">文档暂时无法显示</div>
                <div class="preview-state-detail">{{ selectedDocument.error || '请删除后重新添加该文档。' }}</div>
                <div class="preview-state-path">{{ selectedDocument.filePath }}</div>
              </div>
            </div>
          </template>

          <div v-else class="preview-empty">
            <div class="empty-icon">📂</div>
            <div class="empty-title">当前对话还没有绑定文档</div>
            <div class="empty-detail">从左侧导入 PDF、Excel、Word 或 PowerPoint，文档会只绑定到当前会话。</div>
          </div>
        </section>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.document-workspace {
  display: flex;
  flex-shrink: 0;
  flex-grow: 0;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--app-panel);
  border-left: 1px solid var(--app-border);
  overflow: hidden;
  animation: workspace-enter 0.24s cubic-bezier(0.22, 1, 0.36, 1);
  transform-origin: right center;
}

@keyframes workspace-enter {
  from {
    opacity: 0;
    transform: translateX(18px);
  }

  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.workspace-resize-handle {
  width: 12px;
  flex-shrink: 0;
  cursor: ew-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(180deg, var(--app-panel-subtle), var(--app-panel));
  border-right: 1px solid var(--app-border);
}

.resize-grip {
  width: 4px;
  height: 46px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-border) 72%, transparent);
}

.workspace-shell {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.workspace-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--app-border);
  background: linear-gradient(180deg, var(--app-panel-subtle), var(--app-panel));
}

.workspace-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.workspace-title {
  margin: 0;
  font-size: 0.96em;
  font-weight: 700;
  color: var(--app-text-strong);
}

.workspace-subtitle {
  margin: 4px 0 0;
  font-size: 0.74em;
  color: var(--app-text-muted);
}

.workspace-close {
  border: none;
  background: none;
  color: var(--app-text-muted);
  font-size: 1.4em;
  line-height: 1;
  cursor: pointer;
}

.workspace-close:hover {
  color: var(--app-text);
}

.workspace-body {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.workspace-list-toggle {
  position: absolute;
  top: 50%;
  z-index: 5;
  width: 18px;
  height: 64px;
  padding: 0;
  border-radius: 9px;
  border: 1px solid var(--app-border-strong);
  background: color-mix(in srgb, var(--app-panel) 86%, transparent);
  color: var(--app-text-muted);
  box-shadow: 0 8px 18px rgba(15, 23, 42, 0.12);
  transform: translate(-50%, -50%);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    left 0.18s ease,
    background 0.15s ease,
    color 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.workspace-list-toggle:hover {
  border-color: color-mix(in srgb, var(--app-accent) 45%, var(--app-border-strong));
  background: var(--app-panel-muted);
  color: var(--app-text-strong);
  box-shadow: 0 10px 22px rgba(15, 23, 42, 0.16);
}

.workspace-rail {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  padding: 16px 14px;
  border-right: 1px solid var(--app-border);
  background: linear-gradient(180deg, var(--app-panel), color-mix(in srgb, var(--app-panel-subtle) 40%, var(--app-panel)));
  transition: width 0.18s ease, padding 0.18s ease;
  overflow: hidden;
}

.workspace-rail.collapsed {
  padding-left: 10px;
  padding-right: 10px;
}

.workspace-preview {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-subtle) 65%, transparent), transparent 160px);
}

.preview-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--app-border);
}

.toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 11px;
  border-radius: 10px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
  color: var(--app-text);
  cursor: pointer;
}

.toolbar-btn:hover:not(:disabled) {
  background: var(--app-panel-muted);
}

.toolbar-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.preview-hint {
  font-size: 0.76em;
  color: var(--app-text-muted);
}

.selection-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 14px 18px 0;
}

.selection-tag-card {
  display: flex;
  align-items: center;
  gap: 4px;
}

.selection-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--tag-color, #3b82f6) 32%, transparent);
  background: color-mix(in srgb, var(--tag-color, #3b82f6) 12%, var(--app-panel));
  color: var(--app-text);
  cursor: pointer;
}

.tag-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--tag-color, #3b82f6);
}

.tag-remove {
  border: none;
  background: none;
  color: var(--app-text-muted);
  cursor: pointer;
}

.preview-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 18px;
}

.preview-scroll.pdf-active {
  overflow: hidden;
}

.preview-empty,
.preview-state-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.empty-icon {
  font-size: 2.2em;
  margin-bottom: 12px;
}

.empty-title,
.preview-state-title {
  font-size: 0.98em;
  font-weight: 700;
  color: var(--app-text-strong);
}

.empty-detail,
.preview-state-detail {
  margin-top: 8px;
  max-width: 420px;
  font-size: 0.8em;
  line-height: 1.6;
  color: var(--app-text-muted);
}

.preview-state-path {
  margin-top: 12px;
  font-size: 0.76em;
  color: var(--app-text);
  word-break: break-all;
}

.rail-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.import-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 12px;
  border-radius: 10px;
  border: none;
  background: var(--app-accent);
  color: #fff;
  cursor: pointer;
}

.import-btn.compact {
  width: 100%;
  padding-left: 0;
  padding-right: 0;
}

.import-btn:hover {
  background: var(--app-accent-strong);
}

.import-btn.disabled {
  opacity: 0.65;
  pointer-events: none;
}

.import-hint {
  font-size: 0.74em;
  line-height: 1.55;
  color: var(--app-text-muted);
}

.import-error {
  padding: 9px 10px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--app-danger) 20%, transparent);
  background: color-mix(in srgb, var(--app-danger) 8%, transparent);
  color: var(--app-danger);
  font-size: 0.75em;
  line-height: 1.5;
}

.detail-card {
  padding: 12px;
  border-radius: 14px;
  border: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel-subtle) 72%, transparent);
}

.detail-card.empty {
  color: var(--app-text-muted);
}

.detail-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.detail-card-title {
  font-size: 0.84em;
  font-weight: 700;
  color: var(--app-text-strong);
}

.detail-status {
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 0.7em;
  font-weight: 600;
}

.status-ready {
  color: #166534;
  background: color-mix(in srgb, #22c55e 14%, transparent);
}

.status-missing,
.status-error {
  color: #92400e;
  background: color-mix(in srgb, #f59e0b 18%, transparent);
}

.detail-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
}

.detail-label {
  flex-shrink: 0;
  font-size: 0.74em;
  color: var(--app-text-muted);
}

.detail-value {
  min-width: 0;
  text-align: right;
  font-size: 0.76em;
  color: var(--app-text);
  word-break: break-word;
}

.detail-path {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--app-border);
  font-size: 0.72em;
  line-height: 1.55;
  color: var(--app-text-muted);
  word-break: break-all;
}

.detail-empty-text {
  margin-top: 8px;
  font-size: 0.76em;
  line-height: 1.55;
}

.doc-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.doc-item {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 38px 11px 12px;
  border-radius: 12px;
  border: 1px solid transparent;
  background: color-mix(in srgb, var(--app-panel-subtle) 70%, transparent);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.doc-item.compact {
  align-items: center;
  justify-content: center;
  padding: 10px 8px;
}

.doc-item:hover {
  background: var(--app-panel-muted);
}

.doc-item.active {
  border-color: color-mix(in srgb, var(--app-accent) 42%, transparent);
  background: color-mix(in srgb, var(--app-accent-soft) 82%, transparent);
}

.doc-icon {
  font-size: 1.15em;
  line-height: 1.4;
  flex-shrink: 0;
}

.doc-meta {
  min-width: 0;
  flex: 1;
}

.doc-name {
  font-size: 0.82em;
  font-weight: 600;
  color: var(--app-text);
  word-break: break-word;
}

.doc-detail {
  margin-top: 4px;
  font-size: 0.72em;
  color: var(--app-text-muted);
}

.doc-problem {
  margin-top: 6px;
  font-size: 0.72em;
  line-height: 1.5;
  color: #92400e;
}

.doc-remove {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: none;
  background: color-mix(in srgb, var(--app-danger) 90%, transparent);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}

.doc-item:hover .doc-remove,
.doc-item.active .doc-remove {
  opacity: 1;
}

.doc-empty {
  padding: 28px 12px;
  text-align: center;
  font-size: 0.8em;
  color: var(--app-text-faint);
}

@media (max-width: 1100px) {
  .workspace-title {
    font-size: 0.9em;
  }

  .workspace-subtitle {
    display: none;
  }

  .preview-toolbar {
    padding: 10px 14px;
  }

  .preview-scroll {
    padding: 14px;
  }
}
</style>
