<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'
import { renderMarkdown } from '../markdown'

type WorkspaceState = ConversationFolderWorkspaceState
type WorkspaceEntry = FolderWorkspaceFileEntry
type WorkspaceReadResult = FolderWorkspaceReadResult

interface FlatWorkspaceEntry extends WorkspaceEntry {
  depth: number
}

const props = withDefaults(defineProps<{
  visible: boolean
  rootPath?: string | null
  rootName?: string | null
  activeFilePath?: string | null
  workspaceWidth?: number
}>(), {
  rootPath: null,
  rootName: null,
  activeFilePath: null,
  workspaceWidth: 980
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'updateWorkspace', state: WorkspaceState | null): void
}>()

const workspaceRoot = ref<HTMLElement | null>(null)
const workspaceWidth = ref(props.workspaceWidth)
const currentRootPath = ref<string | null>(props.rootPath || null)
const currentRootName = ref<string | null>(props.rootName || null)
const currentActiveFilePath = ref<string | null>(props.activeFilePath || null)
const fileTree = ref<WorkspaceEntry[]>([])
const expandedDirs = ref<Set<string>>(new Set())
const selectedFile = ref<WorkspaceReadResult | null>(null)
const isPickingFolder = ref(false)
const isLoadingTree = ref(false)
const isLoadingFile = ref(false)
const workspaceError = ref('')
const fileError = ref('')
const promptedForOpen = ref(false)

const CONVERSATION_SIDEBAR_WIDTH = 252
const MIN_CHAT_MAIN_WIDTH = 640
const WORKSPACE_RESIZE_HANDLE_WIDTH = 12
const SIDEBAR_WIDTH = 280
const PREVIEW_MIN_WIDTH = 420
const DEFAULT_WORKSPACE_WIDTH = 980
const MIN_WORKSPACE_WIDTH = SIDEBAR_WIDTH + PREVIEW_MIN_WIDTH + WORKSPACE_RESIZE_HANDLE_WIDTH
const MAX_WORKSPACE_WIDTH = 1320

let resizeStartX = 0
let resizeStartWidth = 0
let resizing = false
let layoutObserver: ResizeObserver | null = null

const flatFileTree = computed(() => flattenFileTree(fileTree.value))
const selectedPath = computed(() => currentActiveFilePath.value || selectedFile.value?.filePath || null)
const lineCount = computed(() => selectedFile.value?.lineCount || 0)
const renderedMarkdown = computed(() => selectedFile.value?.isMarkdown ? renderMarkdown(selectedFile.value.content) : '')
const highlightedCode = computed(() => {
  const file = selectedFile.value
  if (!file) return ''
  const language = file.language?.trim().toLowerCase()
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(file.content, { language, ignoreIllegals: true }).value
  }
  return escapeHtml(file.content)
})

function escapeHtml (value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function flattenFileTree (items: WorkspaceEntry[], depth = 0): FlatWorkspaceEntry[] {
  const flat: FlatWorkspaceEntry[] = []
  for (const item of items) {
    flat.push({ ...item, depth })
    if (item.type === 'directory' && item.children?.length && expandedDirs.value.has(item.path)) {
      flat.push(...flattenFileTree(item.children, depth + 1))
    }
  }
  return flat
}

function findEntry (items: WorkspaceEntry[], filePath: string | null): WorkspaceEntry | null {
  if (!filePath) return null
  for (const item of items) {
    if (item.path === filePath) return item
    if (item.children?.length) {
      const child = findEntry(item.children, filePath)
      if (child) return child
    }
  }
  return null
}

function findFirstPreviewableFile (items: WorkspaceEntry[]): WorkspaceEntry | null {
  for (const item of items) {
    if (item.type === 'file' && item.kind !== 'binary') return item
    if (item.children?.length) {
      const child = findFirstPreviewableFile(item.children)
      if (child) return child
    }
  }
  return null
}

function expandTopLevelDirectories (): void {
  const next = new Set(expandedDirs.value)
  for (const item of fileTree.value) {
    if (item.type === 'directory') next.add(item.path)
  }
  expandedDirs.value = next
}

function toggleDirectory (item: WorkspaceEntry): void {
  const next = new Set(expandedDirs.value)
  if (next.has(item.path)) next.delete(item.path)
  else next.add(item.path)
  expandedDirs.value = next
}

function formatFileSize (bytes?: number): string {
  const value = bytes || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function getFileBadge (item: WorkspaceEntry): string {
  if (item.type === 'directory') return 'DIR'
  if (item.kind === 'markdown') return 'MD'
  if (item.language) return item.language.toUpperCase().slice(0, 6)
  if (item.kind === 'binary') return 'BIN'
  if (item.kind === 'large') return 'BIG'
  return 'TXT'
}

function getChatPanelWidth (): number {
  return workspaceRoot.value?.parentElement?.clientWidth || Math.max(0, window.innerWidth - CONVERSATION_SIDEBAR_WIDTH)
}

function getMaxWorkspaceWidth (): number {
  const maxByParent = getChatPanelWidth() - MIN_CHAT_MAIN_WIDTH
  return Math.max(SIDEBAR_WIDTH + 320, Math.min(MAX_WORKSPACE_WIDTH, Math.round(maxByParent)))
}

function clampWorkspaceWidth (value: number): number {
  const maxWorkspaceWidth = getMaxWorkspaceWidth()
  const minWorkspaceWidth = Math.min(MIN_WORKSPACE_WIDTH, maxWorkspaceWidth)
  return Math.min(maxWorkspaceWidth, Math.max(minWorkspaceWidth, Math.round(value)))
}

function emitWorkspaceState (): void {
  if (!currentRootPath.value) {
    emit('updateWorkspace', null)
    return
  }

  emit('updateWorkspace', {
    rootPath: currentRootPath.value,
    rootName: currentRootName.value || currentRootPath.value,
    activeFilePath: currentActiveFilePath.value || undefined,
    width: workspaceWidth.value
  })
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
  emitWorkspaceState()
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
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (resizing || !props.visible || !workspaceRoot.value?.parentElement) return
  workspaceWidth.value = clampWorkspaceWidth(desiredWidth)
}

async function loadWorkspaceTree (preferredFilePath?: string | null): Promise<void> {
  if (!currentRootPath.value || !window.electronAPI?.listFolderWorkspaceFiles) return
  isLoadingTree.value = true
  workspaceError.value = ''

  try {
    const result = await window.electronAPI.listFolderWorkspaceFiles(currentRootPath.value)
    currentRootName.value = result.rootName
    fileTree.value = result.entries
    expandTopLevelDirectories()
    const preferred = findEntry(result.entries, preferredFilePath || currentActiveFilePath.value)
    const nextFile = preferred?.type === 'file' ? preferred : findFirstPreviewableFile(result.entries)
    if (nextFile) {
      await openFile(nextFile, { persist: false })
    } else {
      selectedFile.value = null
      currentActiveFilePath.value = null
    }
    emitWorkspaceState()
  } catch (error) {
    fileTree.value = []
    selectedFile.value = null
    workspaceError.value = (error as Error).message
  } finally {
    isLoadingTree.value = false
  }
}

async function chooseFolder (): Promise<void> {
  if (!window.electronAPI?.pickFolderWorkspace || isPickingFolder.value) return
  isPickingFolder.value = true
  workspaceError.value = ''

  try {
    const result = await window.electronAPI.pickFolderWorkspace()
    if (result.canceled || !result.rootPath) return
    currentRootPath.value = result.rootPath
    currentRootName.value = result.rootName || result.rootPath
    currentActiveFilePath.value = null
    selectedFile.value = null
    expandedDirs.value = new Set()
    emitWorkspaceState()
    await loadWorkspaceTree()
  } catch (error) {
    workspaceError.value = (error as Error).message
  } finally {
    isPickingFolder.value = false
  }
}

async function refreshWorkspace (): Promise<void> {
  await loadWorkspaceTree(currentActiveFilePath.value)
}

async function openFile (item: WorkspaceEntry, options?: { persist?: boolean }): Promise<void> {
  if (item.type === 'directory') {
    toggleDirectory(item)
    return
  }
  if (!currentRootPath.value || !window.electronAPI?.readFolderWorkspaceFile) return
  if (item.kind === 'binary') {
    selectedFile.value = null
    currentActiveFilePath.value = item.path
    fileError.value = 'Binary file preview is unavailable.'
    if (options?.persist !== false) emitWorkspaceState()
    return
  }

  isLoadingFile.value = true
  fileError.value = ''
  currentActiveFilePath.value = item.path
  try {
    selectedFile.value = await window.electronAPI.readFolderWorkspaceFile(currentRootPath.value, item.path)
    if (options?.persist !== false) emitWorkspaceState()
  } catch (error) {
    selectedFile.value = null
    fileError.value = (error as Error).message
    if (options?.persist !== false) emitWorkspaceState()
  } finally {
    isLoadingFile.value = false
  }
}

watch(
  () => props.workspaceWidth,
  (width) => {
    if (typeof width !== 'number' || resizing) return
    workspaceWidth.value = props.visible && workspaceRoot.value?.parentElement
      ? clampWorkspaceWidth(width)
      : Math.round(width)
  },
  { immediate: true }
)

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) {
      promptedForOpen.value = false
      stopResize()
      layoutObserver?.disconnect()
      layoutObserver = null
      return
    }

    await nextTick()
    bindLayoutObserver()
    await syncWorkspaceWidthToLayout(props.workspaceWidth)
    if (!currentRootPath.value && !promptedForOpen.value) {
      promptedForOpen.value = true
      await chooseFolder()
    }
  },
  { immediate: true }
)

watch(
  () => [props.rootPath, props.rootName, props.activeFilePath] as const,
  async ([rootPath, rootName, activeFilePath], previous) => {
    const previousRootPath = previous?.[0]
    currentRootPath.value = rootPath || null
    currentRootName.value = rootName || null
    currentActiveFilePath.value = activeFilePath || null
    if (!props.visible || !currentRootPath.value) return
    if (rootPath !== previousRootPath) {
      expandedDirs.value = new Set()
    }
    await loadWorkspaceTree(activeFilePath || null)
  },
  { immediate: true }
)

onMounted(() => {
  if (!props.visible) return
  bindLayoutObserver()
  void syncWorkspaceWidthToLayout(props.workspaceWidth)
})

onBeforeUnmount(() => {
  stopResize()
  layoutObserver?.disconnect()
  layoutObserver = null
})
</script>

<template>
  <aside
    v-if="visible"
    ref="workspaceRoot"
    class="folder-workspace"
    :style="{ width: `${workspaceWidth}px`, flexBasis: `${workspaceWidth}px`, maxWidth: `${workspaceWidth}px` }"
  >
    <div class="workspace-resize-handle" @mousedown.prevent="startResize">
      <div class="resize-grip"></div>
    </div>

    <div class="workspace-shell">
      <header class="workspace-header">
        <div class="workspace-heading">
          <h3 class="workspace-title">代码工作区</h3>
          <p class="workspace-subtitle" :title="currentRootPath || undefined">{{ currentRootName || '未选择文件夹' }}</p>
        </div>
        <div class="workspace-header-actions">
          <button class="workspace-icon-btn" type="button" title="选择文件夹" @click="chooseFolder">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4l2 2h6A2.5 2.5 0 0 1 20.5 8.5v8A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-10Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
              <path d="M12 10v5M9.5 12.5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </button>
          <button class="workspace-icon-btn" type="button" title="刷新" :disabled="!currentRootPath || isLoadingTree" @click="refreshWorkspace">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M20 12a8 8 0 0 1-13.66 5.66M4 12A8 8 0 0 1 17.66 6.34" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              <path d="M17 3.5h2.8V6.3M7 20.5H4.2V17.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button class="workspace-close" type="button" title="关闭代码工作区" @click="emit('close')">×</button>
        </div>
      </header>

      <div v-if="!currentRootPath" class="workspace-empty">
        <div class="workspace-empty-title">未选择工作区</div>
        <button class="choose-folder-btn" type="button" :disabled="isPickingFolder" @click="chooseFolder">
          {{ isPickingFolder ? '打开中...' : '选择文件夹' }}
        </button>
        <div v-if="workspaceError" class="workspace-error">{{ workspaceError }}</div>
      </div>

      <div v-else class="workspace-body">
        <aside class="workspace-tree">
          <div class="tree-root" :title="currentRootPath || undefined">{{ currentRootName }}</div>
          <div v-if="workspaceError" class="workspace-error inline">{{ workspaceError }}</div>
          <div v-if="isLoadingTree" class="tree-loading">加载中...</div>
          <div v-else class="tree-list">
            <button
              v-for="item in flatFileTree"
              :key="item.path"
              class="tree-item"
              :class="{ active: selectedPath === item.path, directory: item.type === 'directory', disabled: item.kind === 'binary' }"
              type="button"
              :style="{ paddingLeft: `${10 + item.depth * 16}px` }"
              :title="item.path"
              @click="openFile(item)"
            >
              <span class="tree-chevron" aria-hidden="true">
                <template v-if="item.type === 'directory'">{{ expandedDirs.has(item.path) ? '▾' : '▸' }}</template>
              </span>
              <span class="tree-name">{{ item.name }}</span>
              <span class="tree-badge">{{ getFileBadge(item) }}</span>
            </button>
            <div v-if="flatFileTree.length === 0" class="tree-empty">暂无可预览文件</div>
          </div>
        </aside>

        <main class="workspace-preview">
          <template v-if="selectedFile">
            <div class="preview-header">
              <div class="preview-path" :title="selectedFile.filePath">{{ selectedFile.filePath }}</div>
              <div class="preview-meta">
                <span>{{ formatFileSize(selectedFile.size) }}</span>
                <span v-if="lineCount > 0">{{ lineCount }} 行</span>
                <span v-if="selectedFile.truncated">已截断</span>
              </div>
            </div>

            <div v-if="selectedFile.isMarkdown" class="markdown-preview markdown-body" v-html="renderedMarkdown"></div>
            <div v-else class="code-preview">
              <div class="line-numbers" aria-hidden="true">
                <span v-for="n in lineCount" :key="n">{{ n }}</span>
              </div>
              <pre class="code-scroll"><code class="hljs" v-html="highlightedCode"></code></pre>
            </div>
          </template>

          <div v-else-if="isLoadingFile" class="preview-placeholder">读取中...</div>
          <div v-else-if="fileError" class="preview-error">{{ fileError }}</div>
          <div v-else class="preview-placeholder">选择文件查看预览</div>
        </main>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.folder-workspace {
  position: relative;
  flex: 0 0 auto;
  min-width: 0;
  height: 100%;
  border-left: 1px solid var(--app-border);
  background: var(--app-bg);
  color: var(--app-text);
  overflow: hidden;
}

.workspace-resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  z-index: 3;
  width: 12px;
  cursor: ew-resize;
  display: flex;
  align-items: center;
  justify-content: center;
}

.resize-grip {
  width: 3px;
  height: 44px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-border) 72%, transparent);
}

.workspace-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding-left: 12px;
  min-width: 0;
}

.workspace-header {
  height: 62px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px 10px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
}

.workspace-heading {
  min-width: 0;
}

.workspace-title {
  margin: 0;
  color: var(--app-text-strong);
  font-size: 0.92rem;
  font-weight: 800;
}

.workspace-subtitle {
  margin: 3px 0 0;
  color: var(--app-text-muted);
  font-size: 0.74rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.workspace-icon-btn,
.workspace-close {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  background: color-mix(in srgb, var(--app-panel) 92%, transparent);
  color: var(--app-text-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.workspace-icon-btn:hover,
.workspace-close:hover {
  color: var(--app-text-strong);
  border-color: color-mix(in srgb, var(--app-accent) 36%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 38%, var(--app-panel));
}

.workspace-icon-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.workspace-icon-btn svg {
  width: 17px;
  height: 17px;
}

.workspace-close {
  font-size: 1.2rem;
  line-height: 1;
}

.workspace-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
}

.workspace-empty-title {
  color: var(--app-text-muted);
  font-size: 0.88rem;
  font-weight: 700;
}

.choose-folder-btn {
  height: 34px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: var(--app-accent);
  color: #fff;
  font-size: 0.82rem;
  font-weight: 800;
  cursor: pointer;
}

.choose-folder-btn:disabled {
  cursor: progress;
  opacity: 0.72;
}

.workspace-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.workspace-tree {
  width: 280px;
  flex: 0 0 280px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  background: color-mix(in srgb, var(--app-panel) 74%, transparent);
}

.tree-root {
  flex: 0 0 auto;
  padding: 10px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 72%, transparent);
  color: var(--app-text-strong);
  font-size: 0.78rem;
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px;
}

.tree-item {
  width: 100%;
  min-width: 0;
  height: 30px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text);
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  text-align: left;
}

.tree-item:hover {
  background: color-mix(in srgb, var(--app-panel-muted) 72%, transparent);
}

.tree-item.active {
  background: color-mix(in srgb, var(--app-accent-soft) 58%, transparent);
  color: var(--app-text-strong);
}

.tree-item.disabled {
  color: var(--app-text-faint);
}

.tree-chevron {
  width: 12px;
  flex: 0 0 12px;
  color: var(--app-text-muted);
  font-size: 0.68rem;
}

.tree-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.76rem;
}

.tree-badge {
  flex: 0 0 auto;
  max-width: 48px;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 2px 5px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--app-panel-muted) 80%, transparent);
  color: var(--app-text-muted);
  font-size: 0.58rem;
  font-weight: 800;
}

.tree-loading,
.tree-empty,
.workspace-error,
.preview-placeholder,
.preview-error {
  color: var(--app-text-muted);
  font-size: 0.8rem;
}

.workspace-error {
  color: var(--app-danger, #ef4444);
}

.workspace-error.inline {
  padding: 8px 10px;
}

.tree-empty {
  padding: 20px 8px;
  text-align: center;
}

.tree-loading {
  padding: 12px;
}

.workspace-preview {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #0b0f16;
}

.preview-header {
  flex: 0 0 auto;
  min-height: 45px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.16);
  color: #dbeafe;
}

.preview-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.78rem;
}

.preview-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  color: #94a3b8;
  font-size: 0.7rem;
}

.code-preview {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: auto;
}

.line-numbers {
  flex: 0 0 auto;
  min-width: 48px;
  padding: 12px 8px;
  border-right: 1px solid rgba(148, 163, 184, 0.14);
  background: rgba(15, 23, 42, 0.74);
  color: #64748b;
  text-align: right;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  user-select: none;
}

.line-numbers span {
  display: block;
  height: 18.6px;
}

.code-scroll {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 12px 14px;
  overflow: visible;
  color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre;
}

.code-scroll code {
  background: transparent;
  padding: 0;
}

.markdown-preview {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 18px 22px 28px;
  background: color-mix(in srgb, var(--app-panel) 96%, #ffffff);
  color: var(--app-text);
}

.preview-placeholder,
.preview-error {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.preview-error {
  color: var(--app-danger, #ef4444);
}
</style>
