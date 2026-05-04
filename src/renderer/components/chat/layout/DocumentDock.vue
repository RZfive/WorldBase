<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import DocumentRenderHost from '../blocks/DocumentRenderHost.vue'

type DocumentNode = DocumentNodeDTO
type DocumentArtifact = DocumentArtifactDTO
type DocumentSummary = DocumentSummaryDTO
type SelectionRegion = DocumentSelectionDTO

interface HighlightSelectionPayload {
  nodeIds?: string[]
  text: string
  pageIndex?: number
}

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'selectionsChanged'): void
  (e: 'insertSelectionTag', tag: string): void
}>()

const documents = ref<DocumentSummary[]>([])
const activeArtifactId = ref<string | null>(null)
const activeArtifact = ref<DocumentArtifact | null>(null)
const activeSelections = ref<SelectionRegion[]>([])
const isImporting = ref(false)
const importError = ref('')

const SELECTION_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16']
let colorIndex = 0

function nextColor (): string {
  const color = SELECTION_COLORS[colorIndex % SELECTION_COLORS.length]
  colorIndex++
  return color
}

const MIN_DOCK_HEIGHT = 200
const MAX_DOCK_HEIGHT = 800
const dockHeight = ref(380)
let resizeStartY = 0
let resizeStartHeight = 0

function startResize (e: MouseEvent) {
  resizeStartY = e.clientY
  resizeStartHeight = dockHeight.value
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = 'ns-resize'
  document.body.style.userSelect = 'none'
}

function onResizeMove (e: MouseEvent) {
  const delta = resizeStartY - e.clientY
  dockHeight.value = Math.min(MAX_DOCK_HEIGHT, Math.max(MIN_DOCK_HEIGHT, resizeStartHeight + delta))
}

function stopResize () {
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', stopResize)
})

async function loadDocumentList () {
  if (!window.electronAPI?.listDocuments) return
  try {
    documents.value = await window.electronAPI.listDocuments() as DocumentSummary[]
  } catch {
    // ignore list refresh failures to avoid blocking the dock
  }
}

async function reloadActiveSelections () {
  if (!window.electronAPI?.getDocumentSelections || !activeArtifact.value) return
  activeSelections.value = await window.electronAPI.getDocumentSelections(activeArtifact.value.id) as SelectionRegion[]
}

async function ensurePreviewForArtifact (id: string) {
  if (!window.electronAPI?.ensureDocumentRenderPreview) return

  try {
    const artifact = await window.electronAPI.ensureDocumentRenderPreview(id) as DocumentArtifact | null
    if (artifact && activeArtifactId.value === id) {
      activeArtifact.value = artifact
    }
  } catch (err) {
    console.error('[doc-dock] Failed to prepare render preview:', err)
  }
}

async function openArtifact (id: string) {
  if (!window.electronAPI?.getDocument) return
  activeArtifactId.value = id

  try {
    activeArtifact.value = await window.electronAPI.getDocument(id) as DocumentArtifact | null
    await reloadActiveSelections()
    if (activeArtifact.value && (!activeArtifact.value.render || activeArtifact.value.render.status !== 'ready')) {
      void ensurePreviewForArtifact(id)
    }
  } catch (err) {
    console.error('[doc-dock] Failed to load artifact:', err)
  }
}

async function handleImportClick () {
  if (!window.electronAPI?.pickDocumentFiles || !window.electronAPI?.importDocument) return

  isImporting.value = true
  importError.value = ''

  try {
    const { canceled, filePaths } = await window.electronAPI.pickDocumentFiles()
    if (canceled || filePaths.length === 0) {
      isImporting.value = false
      return
    }

    let lastImportedArtifactId: string | null = null
    for (const filePath of filePaths) {
      try {
        const result = await window.electronAPI.importDocument(filePath)
        const artifact = result.artifact as DocumentArtifact
        lastImportedArtifactId = artifact.id
      } catch (err) {
        importError.value = `导入失败: ${(err as Error).message}`
      }
    }

    if (lastImportedArtifactId) {
      await loadDocumentList()
      await openArtifact(lastImportedArtifactId)
    }
  } catch (err) {
    importError.value = `打开文件选择器失败: ${(err as Error).message}`
  }

  isImporting.value = false
}

async function removeDocument (id: string) {
  if (!window.electronAPI?.removeDocument) return
  await window.electronAPI.removeDocument(id)

  if (activeArtifactId.value === id) {
    activeArtifactId.value = null
    activeArtifact.value = null
    activeSelections.value = []
  }

  await loadDocumentList()
  emit('selectionsChanged')
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

function insertSelectionTag (selection: SelectionRegion) {
  emit('insertSelectionTag', buildSelectionTag(selection))
}

async function handleHighlightSelection (payload: HighlightSelectionPayload) {
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

    await reloadActiveSelections()
    await loadDocumentList()
    emit('selectionsChanged')
  } catch (err) {
    console.error('[doc-dock] Failed to create tag from highlight:', err)
  }
}

async function removeSelection (regionId: string) {
  if (!window.electronAPI?.removeDocumentSelection || !activeArtifact.value) return
  await window.electronAPI.removeDocumentSelection(regionId)
  await reloadActiveSelections()
  await loadDocumentList()
  emit('selectionsChanged')
}

async function openOriginalFile () {
  if (!activeArtifact.value || !window.electronAPI?.openDocumentOriginal) return
  importError.value = ''
  const result = await window.electronAPI.openDocumentOriginal(activeArtifact.value.id)
  if (!result.success) {
    importError.value = `打开原文件失败: ${result.error || 'unknown error'}`
  }
}

function formatFileSize (bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function getTypeLabel (type: string): string {
  const labels: Record<string, string> = {
    pdf: 'PDF',
    xlsx: 'Excel',
    docx: 'Word',
    pptx: 'PPT'
  }
  return labels[type] || type.toUpperCase()
}

function getTypeEmoji (type: string): string {
  const emojis: Record<string, string> = {
    pdf: '📕',
    xlsx: '📊',
    docx: '📄',
    pptx: '🎞️'
  }
  return emojis[type] || '📎'
}

onMounted(() => {
  if (props.visible) loadDocumentList()
})

watch(() => props.visible, (visible) => {
  if (visible) loadDocumentList()
})
</script>

<template>
  <div v-if="visible" class="document-dock" :style="{ height: dockHeight + 'px' }">
    <div class="dock-resize-handle" @mousedown.prevent="startResize">
      <div class="resize-grip"></div>
    </div>

    <div class="dock-header">
      <h3 class="dock-title">文档工作台</h3>
      <button class="dock-close" @click="emit('close')" title="关闭">×</button>
    </div>

    <div class="dock-body">
      <div class="dock-sidebar">
        <button class="import-btn" :class="{ disabled: isImporting }" :disabled="isImporting" @click="handleImportClick">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          导入文档
        </button>
        <div class="import-hint">支持单个文档最大 100MB，大型文档会由 AI 分片读取。</div>

        <div v-if="importError" class="import-error">{{ importError }}</div>

        <div class="doc-list">
          <div
            v-for="doc in documents"
            :key="doc.id"
            class="doc-item"
            :class="{ active: doc.id === activeArtifactId }"
            @click="openArtifact(doc.id)"
          >
            <span class="doc-icon">{{ getTypeEmoji(doc.fileType) }}</span>
            <div class="doc-meta">
              <div class="doc-name">{{ doc.fileName }}</div>
              <div class="doc-detail">
                {{ getTypeLabel(doc.fileType) }} · {{ formatFileSize(doc.fileSize) }}
                <span v-if="doc.selectionCount > 0" class="doc-sel-count">· {{ doc.selectionCount }} 标签</span>
              </div>
            </div>
            <button class="doc-remove" @click.stop="removeDocument(doc.id)" title="移除">×</button>
          </div>

          <div v-if="documents.length === 0" class="doc-empty">
            暂无导入文档
          </div>
        </div>
      </div>

      <div class="dock-preview">
        <template v-if="activeArtifact">
          <div class="selection-toolbar">
            <button class="sel-btn" @click="openOriginalFile">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/></svg>
              打开原文件
            </button>
            <span class="sel-hint">拖拽高亮文档内容会自动生成标签。点击标签会插入聊天框，仅这些标签会在发送时注入给 AI。</span>
          </div>

          <div v-if="activeSelections.length > 0" class="selection-tags">
            <div
              v-for="selection in activeSelections"
              :key="selection.id"
              class="selection-tag-card"
              :style="{ '--tag-color': selection.color }"
            >
              <button class="selection-tag" :title="buildSelectionTag(selection)" @click="insertSelectionTag(selection)">
                <span class="tag-dot"></span>
                <span class="tag-label">#{{ selection.label }}</span>
              </button>
              <button class="tag-remove" @click.stop="removeSelection(selection.id)" title="删除标签">×</button>
            </div>
          </div>

          <div class="preview-scroll">
            <DocumentRenderHost
              :artifact="activeArtifact"
              :selections="activeSelections"
              @highlight-selection="handleHighlightSelection"
            />
          </div>
        </template>

        <div v-else class="preview-empty">
          <div class="empty-icon">📂</div>
          <div class="empty-text">选择左侧文档查看内容</div>
          <div class="empty-hint">支持 PDF、Excel、Word、PowerPoint，单个文档最大 100MB</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.document-dock {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 200px;
  max-height: 800px;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-panel);
  overflow: hidden;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
}

.dock-resize-handle {
  height: 10px;
  flex-shrink: 0;
  cursor: ns-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--app-panel-subtle);
  border-bottom: 1px solid var(--app-border);
  transition: background 0.15s;
}

.dock-resize-handle:hover {
  background: var(--app-panel-muted);
}

.resize-grip {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: var(--app-border);
  opacity: 0.6;
}

.dock-resize-handle:hover .resize-grip {
  opacity: 1;
}

.dock-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
  flex-shrink: 0;
}

.dock-title {
  margin: 0;
  font-size: 0.92em;
  font-weight: 600;
  color: var(--app-text-strong);
}

.dock-close {
  background: none;
  border: none;
  font-size: 1.3em;
  color: var(--app-text-muted);
  cursor: pointer;
  line-height: 1;
  padding: 0 4px;
}

.dock-close:hover { color: var(--app-text); }

.dock-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.dock-sidebar {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--app-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.import-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 10px 6px;
  padding: 7px 12px;
  border-radius: 8px;
  background: var(--app-accent);
  color: #fff;
  font-size: 0.82em;
  cursor: pointer;
  transition: background 0.15s;
  justify-content: center;
}

.import-btn:hover { background: var(--app-accent-strong); }
.import-btn.disabled { opacity: 0.6; pointer-events: none; }

.import-hint {
  margin: 0 10px 8px;
  font-size: 0.72em;
  line-height: 1.45;
  color: var(--app-text-muted);
}

.import-error {
  margin: 0 10px 6px;
  font-size: 0.74em;
  color: var(--app-danger);
}

.doc-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 6px 6px;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.doc-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
  position: relative;
}

.doc-item:hover { background: var(--app-panel-muted); }
.doc-item.active { background: var(--app-accent-soft); }

.doc-icon { font-size: 1.2em; flex-shrink: 0; }
.doc-meta { min-width: 0; flex: 1; }

.doc-name {
  font-size: 0.82em;
  color: var(--app-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.doc-detail {
  font-size: 0.7em;
  color: var(--app-text-muted);
  margin-top: 1px;
}

.doc-sel-count { color: var(--app-accent); }

.doc-remove {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--app-danger);
  color: #fff;
  border: none;
  font-size: 0.65em;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s;
}

.doc-item:hover .doc-remove { opacity: 1; }

.doc-empty {
  text-align: center;
  padding: 30px 10px;
  color: var(--app-text-faint);
  font-size: 0.82em;
}

.dock-preview {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.selection-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--app-border);
  flex-shrink: 0;
}

.selection-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 14px 0;
}

.selection-tag-card {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.selection-tag {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  border: 1px solid color-mix(in srgb, var(--tag-color, #3b82f6) 35%, var(--app-border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--tag-color, #3b82f6) 12%, transparent);
  color: var(--app-text);
  cursor: pointer;
  transition: transform 0.12s, background 0.12s;
}

.selection-tag:hover {
  transform: translateY(-1px);
  background: color-mix(in srgb, var(--tag-color, #3b82f6) 18%, transparent);
}

.tag-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--tag-color, #3b82f6);
}

.tag-label {
  font-size: 0.78em;
  font-weight: 600;
}

.tag-remove {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
  color: var(--app-text-muted);
  cursor: pointer;
}

.tag-remove:hover {
  color: var(--app-danger);
  border-color: color-mix(in srgb, var(--app-danger) 35%, var(--app-border));
}

.sel-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
  color: var(--app-text);
  font-size: 0.8em;
  cursor: pointer;
  transition: all 0.15s;
}

.sel-btn:hover { background: var(--app-panel-muted); }

.sel-hint {
  font-size: 0.74em;
  color: var(--app-text-faint);
}

.preview-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.preview-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.empty-icon { font-size: 2.4em; opacity: 0.5; }
.empty-text { color: var(--app-text-muted); font-size: 0.9em; }
.empty-hint { color: var(--app-text-faint); font-size: 0.78em; }
</style>
