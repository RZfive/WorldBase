<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'
import SidebarIcon from '../../chat/layout/SidebarIcon.vue'
import { renderMarkdown } from '../../chat/markdown'
import { workspaceStore } from '../workspace-store'
import type { WorkspaceTabInstance } from '../tab-registry'

type WorkspaceState = ConversationFolderWorkspaceState
type WorkspaceEntry = FolderWorkspaceFileEntry
type WorkspaceReadResult = FolderWorkspaceReadResult

interface FlatWorkspaceEntry extends WorkspaceEntry {
  depth: number
}

interface CodeLine {
  number: number
  html: string
  /** 虚拟滚动：行在滚动内容里的绝对纵坐标（px）。 */
  top: number
}

interface TemplateHighlightState {
  embeddedLanguage: string | null
  inAstroFrontmatter: boolean
}

const props = withDefaults(defineProps<{
  /** The owning workspace tab instance. */
  tab: WorkspaceTabInstance
  rootPath?: string | null
  rootName?: string | null
  activeFilePath?: string | null
}>(), {
  rootPath: null,
  rootName: null,
  activeFilePath: null
})

const emit = defineEmits<{
  (e: 'insertSelectionTag', tag: string): void
  (e: 'updateWorkspace', state: WorkspaceState | null): void
}>()

const treeListRef = ref<HTMLElement | null>(null)
const fileSearchInputRef = ref<HTMLInputElement | null>(null)
const codePreviewRef = ref<HTMLElement | null>(null)
const codeScrollRef = ref<HTMLElement | null>(null)
const codeSelectionToolbarRef = ref<HTMLElement | null>(null)
const currentRootPath = ref<string | null>(props.rootPath || null)
const currentRootName = ref<string | null>(props.rootName || null)
const currentActiveFilePath = ref<string | null>(props.activeFilePath || null)
const fileTree = ref<WorkspaceEntry[]>([])
const expandedDirs = ref<Set<string>>(new Set())
const selectedFile = ref<WorkspaceReadResult | null>(null)
const fileSearchQuery = ref('')
const activeSearchIndex = ref(0)
const codeSelectionStart = ref<number | null>(null)
const codeSelectionEnd = ref<number | null>(null)
const codeSelectionToolbarStyle = ref<Record<string, string>>({ top: '10px', left: '70px' })
const isPickingFolder = ref(false)
const isLoadingTree = ref(false)
const isLoadingFile = ref(false)
const workspaceError = ref('')
const fileError = ref('')
const promptedForOpen = ref(false)
/** Mirrors onActivated/onDeactivated so cached (KeepAlive) tabs stay passive. */
const isActiveTab = ref(false)

const SIDEBAR_WIDTH = 280

/**
 * 目录树默认收起：代码查看默认只显示单文件预览。仅当用户导入代码区
 * （选择文件夹）时自动展开；之后可随时用左上角按钮收起/再展开。
 */
const isTreeExpanded = ref(false)

function toggleFileTree (): void {
  isTreeExpanded.value = !isTreeExpanded.value
}

let workspaceShortcutsBound = false
let toolbarPositionFrame: number | null = null
let workspaceChangeCleanup: (() => void) | null = null
let workspaceRefreshTimer: number | null = null
let pendingWorkspaceRefreshFilePath: string | null = null
let workspaceTreeDirty = false

const SCRIPT_CLOSE_PREFIX = '<' + '/script'
const SCRIPT_CLOSE_TAG = `${SCRIPT_CLOSE_PREFIX}>`
const STYLE_CLOSE_PREFIX = '<' + '/style'
const STYLE_CLOSE_TAG = `${STYLE_CLOSE_PREFIX}>`

const HIGHLIGHT_LANGUAGE_ALIASES: Record<string, string> = {
  vue: 'xml',
  svelte: 'xml',
  astro: 'xml',
  mdx: 'markdown',
  ejs: 'xml',
  eta: 'xml',
  blade: 'php-template',
  razor: 'xml',
  cshtml: 'xml',
  jinja2: 'jinja',
  nunjucks: 'jinja',
  njk: 'jinja',
  liquid: 'django',
  gohtml: 'handlebars',
  gotmpl: 'handlebars',
  tmpl: 'handlebars',
  mustache: 'handlebars',
  pug: 'haml',
  eex: 'xml',
  heex: 'xml',
  jsp: 'xml',
  ftl: 'xml',
  thymeleaf: 'xml',
  velocity: 'xml'
}

const flatFileTree = computed(() => flattenFileTree(fileTree.value))
const allFileEntries = computed(() => flattenAllFileTree(fileTree.value))
const selectedPath = computed(() => currentActiveFilePath.value || selectedFile.value?.filePath || null)
const lineCount = computed(() => selectedFile.value?.lineCount || 0)
const normalizedFileSearchQuery = computed(() => fileSearchQuery.value.trim().toLowerCase())
const searchResults = computed(() => {
  const query = normalizedFileSearchQuery.value
  if (!query) return []

  return allFileEntries.value
    .filter(item => item.type === 'file')
    .map(item => ({ item, score: getFileSearchScore(item, query) }))
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || a.item.path.localeCompare(b.item.path))
    .slice(0, 80)
    .map(result => result.item)
})
const hasFileSearch = computed(() => normalizedFileSearchQuery.value.length > 0)
const normalizedCodeSelection = computed(() => {
  const start = codeSelectionStart.value
  const end = codeSelectionEnd.value
  if (!start) return null
  const safeEnd = end || start
  return {
    start: Math.min(start, safeEnd),
    end: Math.max(start, safeEnd),
    isComplete: end !== null
  }
})

// 选中区间写入全局 store：AI 请求会携带"当前正在查看的文件 + 勾选行范围"，
// 让"帮我看看选中的部分"这类请求无需显式引用文件路径。
watch(normalizedCodeSelection, (selection) => {
  workspaceStore.folderActiveSelection.value = selection ? { start: selection.start, end: selection.end } : null
})

// 当前文件的元信息（行数/截断）也进 store，供 AI 上下文使用；换文件时重置
// 虚拟滚动视图。
watch(selectedFile, (file) => {
  workspaceStore.folderActiveFileMeta.value = file
    ? { lineCount: file.lineCount, truncated: file.truncated }
    : null
  resetCodeView()
})
const codeSelectionLabel = computed(() => {
  const selection = normalizedCodeSelection.value
  if (!selection || !selectedFile.value) return ''
  const linePart = selection.start === selection.end
    ? `L${selection.start}`
    : `L${selection.start}-L${selection.end}`
  return `${selectedFile.value.filePath}#${linePart}`
})
// ── 大文件防卡死：虚拟滚动 + 懒高亮 ──
// 代码行不换行（white-space: pre），行高恒定，因此只渲染可视区±过扫描的行，
// 滚动容器用等高占位撑出真实滚动长度：全部内容都可通过滚动查看，不截断、
// 不冻结。高亮按行懒计算并缓存；vue/svelte/astro 的嵌入式语言状态用检查点
// 回放保证随机跳转时着色依然正确。超长行（压缩产物）跳过 token 着色只做
// 转义——单行 hljs 数百 KB 会卡顿且着色无意义。
const VIRTUAL_OVERSCAN = 12
const STATE_CHECKPOINT_EVERY = 200
const HLJS_MAX_LINE_CHARS = 50_000
const HIGHLIGHT_CACHE_MAX = 20_000
const MARKDOWN_CHUNK_CHARS = 80_000
const DEFAULT_ROW_HEIGHT = 19

const renderedRows = ref<CodeLine[]>([])
const virtualRowHeight = ref(DEFAULT_ROW_HEIGHT)
const markdownChunks = ref<string[]>([])
let sourceCodeLines: string[] = []
let highlightCache = new Map<number, string>()
let stateCheckpoints = new Map<number, TemplateHighlightState>()
let virtualScrollFrame: number | null = null
let markdownRenderToken = 0
let markdownRenderTimer: number | null = null

const virtualRowCount = computed(() => {
  const file = selectedFile.value
  return file && !file.isMarkdown ? sourceCodeLines.length : 0
})
const virtualScrollHeight = computed(() => Math.round(virtualRowCount.value * virtualRowHeight.value))

function stopPreviewRenderLoops (): void {
  markdownRenderToken += 1
  if (markdownRenderTimer !== null) {
    window.clearTimeout(markdownRenderTimer)
    markdownRenderTimer = null
  }
  if (virtualScrollFrame !== null) {
    window.cancelAnimationFrame(virtualScrollFrame)
    virtualScrollFrame = null
  }
}

function resetCodeView (): void {
  stopPreviewRenderLoops()
  sourceCodeLines = []
  highlightCache = new Map()
  stateCheckpoints = new Map()
  renderedRows.value = []
  markdownChunks.value = []
  virtualRowHeight.value = DEFAULT_ROW_HEIGHT
  const file = selectedFile.value
  if (!file) return
  if (file.isMarkdown) {
    scheduleMarkdownRender()
    return
  }
  sourceCodeLines = file.content.split('\n')
  // 内容替换后回到文件顶部，并立即计算首屏窗口。
  void nextTick(() => {
    if (codePreviewRef.value) codePreviewRef.value.scrollTop = 0
    updateVirtualWindow()
  })
}

/** 嵌入式语言状态机（vue/svelte/astro）在 lineIndex 行之前的状态；非模板语言无状态。 */
function highlightStateAt (lineIndex: number, file: WorkspaceReadResult): TemplateHighlightState {
  const fileLanguage = file.language?.trim().toLowerCase() || null
  if (!fileLanguage || !isSingleFileTemplateLanguage(fileLanguage)) {
    return { embeddedLanguage: null, inAstroFrontmatter: false }
  }
  const checkpoint = Math.floor(lineIndex / STATE_CHECKPOINT_EVERY) * STATE_CHECKPOINT_EVERY
  let state: TemplateHighlightState = { embeddedLanguage: null, inAstroFrontmatter: false }
  let start = 0
  if (checkpoint > 0) {
    const saved = stateCheckpoints.get(checkpoint)
    if (saved) {
      state = { ...saved }
      start = checkpoint
    }
  }
  for (let index = start; index < lineIndex; index++) {
    // 仅推进状态机（正则扫描），不做 token 高亮；沿途补存检查点。
    getLineHighlightLanguage(sourceCodeLines[index], file, state, index)
    if ((index + 1) % STATE_CHECKPOINT_EVERY === 0 && !stateCheckpoints.has(index + 1)) {
      stateCheckpoints.set(index + 1, { ...state })
    }
  }
  return state
}

/** 确保 [first, last) 区间的行高亮已缓存；返回后调用方直接取缓存。 */
function ensureWindowHighlights (first: number, last: number, file: WorkspaceReadResult): void {
  let index = first
  while (index < last) {
    if (highlightCache.has(index)) {
      index += 1
      continue
    }
    let runEnd = index
    while (runEnd < last && !highlightCache.has(runEnd)) runEnd += 1
    let state = highlightStateAt(index, file)
    for (; index < runEnd; index++) {
      const text = sourceCodeLines[index]
      const html = text.length > HLJS_MAX_LINE_CHARS
        ? escapeHtml(text)
        : highlightLineWithLanguage(text, getLineHighlightLanguage(text, file, state, index))
      if ((index + 1) % STATE_CHECKPOINT_EVERY === 0 && !stateCheckpoints.has(index + 1)) {
        stateCheckpoints.set(index + 1, { ...state })
      }
      highlightCache.set(index, html)
      if (highlightCache.size > HIGHLIGHT_CACHE_MAX) {
        // 简易淘汰：重访时按检查点重算即可，正确性不受影响。
        const oldest = highlightCache.keys().next().value
        if (oldest === undefined) break
        highlightCache.delete(oldest)
      }
    }
  }
}

function updateVirtualWindow (): void {
  const preview = codePreviewRef.value
  const file = selectedFile.value
  if (!preview || !file || file.isMarkdown || sourceCodeLines.length === 0) {
    renderedRows.value = []
    return
  }
  const rowHeight = virtualRowHeight.value
  const first = Math.max(0, Math.floor(preview.scrollTop / rowHeight) - VIRTUAL_OVERSCAN)
  const last = Math.min(sourceCodeLines.length, Math.ceil((preview.scrollTop + preview.clientHeight) / rowHeight) + VIRTUAL_OVERSCAN)
  ensureWindowHighlights(first, last, file)
  const rows: CodeLine[] = []
  for (let index = first; index < last; index++) {
    rows.push({
      number: index + 1,
      top: index * rowHeight,
      html: highlightCache.get(index) ?? escapeHtml(sourceCodeLines[index])
    })
  }
  renderedRows.value = rows
  // 用真实渲染的行高校准（首帧后字体/行高可能略不同于默认值）；校正后
  // 重算一次窗口，让已渲染行的 top 与占位高度用同一行高。
  const measured = preview.querySelector<HTMLElement>('.code-line')?.offsetHeight
  if (measured && Math.abs(measured - rowHeight) > 0.5) {
    virtualRowHeight.value = measured
    scheduleVirtualUpdate()
  }
}

function scheduleVirtualUpdate (): void {
  // 用 0ms 定时器而非 rAF：窗口被遮挡时 rAF 不触发，滚动后会看到空白；
  // setTimeout 在任何可见性下都可靠，scroll 事件本身已按帧合并。
  if (virtualScrollFrame !== null) return
  virtualScrollFrame = window.setTimeout(() => {
    virtualScrollFrame = null
    updateVirtualWindow()
  }, 0)
}

/** Markdown 按空行 + 代码围栏边界切块，逐块渲染直到完整——不截断也不冻结。 */
function scheduleMarkdownRender (): void {
  const file = selectedFile.value
  if (!file?.isMarkdown) return
  const content = file.content
  const chunks: string[] = []
  let current: string[] = []
  let size = 0
  let inFence = false
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    current.push(line)
    size += line.length + 1
    if (!inFence && size >= MARKDOWN_CHUNK_CHARS && line.trim() === '') {
      chunks.push(current.join('\n'))
      current = []
      size = 0
    }
  }
  if (current.length > 0) chunks.push(current.join('\n'))

  const token = markdownRenderToken
  let index = 0
  const step = () => {
    if (token !== markdownRenderToken) return
    if (index >= chunks.length) return
    markdownChunks.value.push(renderMarkdown(chunks[index]))
    index += 1
    markdownRenderTimer = window.setTimeout(step, 0)
  }
  step()
}

function highlightCodeLine (line: string, file: WorkspaceReadResult, state: TemplateHighlightState, index: number): string {
  const language = getLineHighlightLanguage(line, file, state, index)
  return highlightLineWithLanguage(line, language)
}

function highlightLineWithLanguage (line: string, language?: string | null): string {
  const resolvedLanguage = resolveHighlightLanguage(language)
  if (resolvedLanguage && hljs.getLanguage(resolvedLanguage)) {
    return hljs.highlight(line, { language: resolvedLanguage, ignoreIllegals: true }).value
  }
  return escapeHtml(line)
}

function getLineHighlightLanguage (line: string, file: WorkspaceReadResult, state: TemplateHighlightState, index: number): string | null {
  const fileLanguage = file.language?.trim().toLowerCase() || null
  if (!fileLanguage) return null

  if (fileLanguage === 'astro') {
    const trimmed = line.trim()
    if (index === 0 && trimmed === '---') {
      state.inAstroFrontmatter = true
      return 'xml'
    }
    if (state.inAstroFrontmatter) {
      if (trimmed === '---') {
        state.inAstroFrontmatter = false
        return 'xml'
      }
      return 'typescript'
    }
  }

  if (!isSingleFileTemplateLanguage(fileLanguage)) return fileLanguage

  const trimmedLower = line.trim().toLowerCase()
  if (state.embeddedLanguage) {
    if (trimmedLower.startsWith(SCRIPT_CLOSE_PREFIX) || trimmedLower.startsWith(STYLE_CLOSE_PREFIX)) {
      state.embeddedLanguage = null
      return 'xml'
    }
    const activeLanguage = state.embeddedLanguage
    if (trimmedLower.includes(SCRIPT_CLOSE_TAG) || trimmedLower.includes(STYLE_CLOSE_TAG)) {
      state.embeddedLanguage = null
    }
    return activeLanguage
  }

  const scriptMatch = line.match(/<script\b([^>]*)>/i)
  if (scriptMatch) {
    if (!line.slice(scriptMatch.index || 0).toLowerCase().includes(SCRIPT_CLOSE_TAG)) {
      state.embeddedLanguage = getScriptBlockLanguage(scriptMatch[1] || '')
    }
    return 'xml'
  }

  const styleMatch = line.match(/<style\b([^>]*)>/i)
  if (styleMatch) {
    if (!line.slice(styleMatch.index || 0).toLowerCase().includes(STYLE_CLOSE_TAG)) {
      state.embeddedLanguage = getStyleBlockLanguage(styleMatch[1] || '')
    }
    return 'xml'
  }

  return fileLanguage
}

function isSingleFileTemplateLanguage (language: string): boolean {
  return language === 'vue' || language === 'svelte' || language === 'astro'
}

function getAttributeLanguage (attributes: string): string | null {
  const match = attributes.match(/\blang=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i)
  return (match?.[1] || match?.[2] || match?.[3] || '').trim().toLowerCase() || null
}

function getScriptBlockLanguage (attributes: string): string {
  const language = getAttributeLanguage(attributes)
  if (language === 'ts' || language === 'tsx') return 'typescript'
  if (language === 'jsx') return 'javascript'
  if (language === 'coffee' || language === 'coffeescript') return 'coffeescript'
  return 'javascript'
}

function getStyleBlockLanguage (attributes: string): string {
  const language = getAttributeLanguage(attributes)
  if (language === 'scss' || language === 'sass') return 'scss'
  if (language === 'less') return 'less'
  if (language === 'styl' || language === 'stylus') return 'stylus'
  return 'css'
}

function resolveHighlightLanguage (language?: string | null): string | null {
  const normalized = language?.trim().toLowerCase()
  if (!normalized) return null
  if (hljs.getLanguage(normalized)) return normalized
  const alias = HIGHLIGHT_LANGUAGE_ALIASES[normalized]
  return alias && hljs.getLanguage(alias) ? alias : null
}

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

function flattenAllFileTree (items: WorkspaceEntry[], depth = 0): FlatWorkspaceEntry[] {
  const flat: FlatWorkspaceEntry[] = []
  for (const item of items) {
    flat.push({ ...item, depth })
    if (item.children?.length) {
      flat.push(...flattenAllFileTree(item.children, depth + 1))
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

function getFileSearchScore (item: WorkspaceEntry, query: string): number {
  const pathValue = item.path.toLowerCase()
  const nameValue = item.name.toLowerCase()
  if (nameValue === query) return 100
  if (pathValue === query) return 95
  if (nameValue.startsWith(query)) return 80
  if (pathValue.startsWith(query)) return 70
  if (nameValue.includes(query)) return 56
  if (pathValue.includes(query)) return 42

  const queryParts = query.split(/\s+/).filter(Boolean)
  if (queryParts.length > 1 && queryParts.every(part => pathValue.includes(part))) return 34
  return 0
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

function expandAncestorsForPath (filePath: string): void {
  if (!filePath.includes('/')) return
  const next = new Set(expandedDirs.value)
  const parts = filePath.split('/')
  for (let index = 1; index < parts.length; index += 1) {
    next.add(parts.slice(0, index).join('/'))
  }
  expandedDirs.value = next
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

function getFileIcon (item: WorkspaceEntry): string {
  if (item.type === 'directory') return expandedDirs.value.has(item.path) ? '▾' : '▸'
  if (item.kind === 'markdown') return 'MD'
  if (item.kind === 'binary') return 'BIN'
  return item.language?.slice(0, 2).toUpperCase() || 'F'
}

function clearFileSearch (): void {
  fileSearchQuery.value = ''
  activeSearchIndex.value = 0
}

function focusFileSearch (): void {
  fileSearchInputRef.value?.focus()
  fileSearchInputRef.value?.select()
}

async function openSearchResult (item: WorkspaceEntry): Promise<void> {
  expandAncestorsForPath(item.path)
  await openFile(item)
  clearFileSearch()
}

function handleSearchKeydown (event: KeyboardEvent): void {
  if (!hasFileSearch.value) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeSearchIndex.value = searchResults.value.length > 0
      ? (activeSearchIndex.value + 1) % searchResults.value.length
      : 0
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeSearchIndex.value = searchResults.value.length > 0
      ? (activeSearchIndex.value - 1 + searchResults.value.length) % searchResults.value.length
      : 0
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    const item = searchResults.value[activeSearchIndex.value] || searchResults.value[0]
    if (item) void openSearchResult(item)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    clearFileSearch()
  }
}

function handleWorkspaceKeydown (event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable
  if (isTyping) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    // 文件搜索框在目录树里：收起状态下先展开树再聚焦搜索。
    if (!isTreeExpanded.value) isTreeExpanded.value = true
    void nextTick(() => focusFileSearch())
  }
}

function emitWorkspaceState (): void {
  if (!currentRootPath.value) {
    emit('updateWorkspace', null)
    return
  }

  emit('updateWorkspace', {
    rootPath: currentRootPath.value,
    rootName: currentRootName.value || currentRootPath.value,
    activeFilePath: currentActiveFilePath.value || undefined
  })
}

function normalizeRootPathKey (value?: string | null): string {
  return (value || '').trim().replace(/\\/g, '/')
}

function isSameRootPath (left?: string | null, right?: string | null): boolean {
  return normalizeRootPathKey(left) === normalizeRootPathKey(right)
}

function queueWorkspaceTreeRefresh (preferredFilePath?: string | null): void {
  if (preferredFilePath) {
    pendingWorkspaceRefreshFilePath = preferredFilePath
  }
  workspaceTreeDirty = false

  if (workspaceRefreshTimer !== null) return
  workspaceRefreshTimer = window.setTimeout(() => {
    workspaceRefreshTimer = null
    const nextPreferredFilePath = pendingWorkspaceRefreshFilePath || currentActiveFilePath.value
    pendingWorkspaceRefreshFilePath = null
    void loadWorkspaceTree(nextPreferredFilePath)
  }, 80)
}

function handleFolderWorkspaceChanged (event: FolderWorkspaceChangeEvent): void {
  if (!currentRootPath.value || !isSameRootPath(event.rootPath, currentRootPath.value)) return

  const preferredFilePath = event.action === 'deleted'
    ? currentActiveFilePath.value
    : (currentActiveFilePath.value && currentActiveFilePath.value !== event.filePath ? currentActiveFilePath.value : event.filePath)

  if (!isActiveTab.value) {
    workspaceTreeDirty = true
    if (preferredFilePath) {
      pendingWorkspaceRefreshFilePath = preferredFilePath
    }
    return
  }

  queueWorkspaceTreeRefresh(preferredFilePath)
}

function bindWorkspaceChangeListener (): void {
  if (workspaceChangeCleanup || !window.electronAPI?.onFolderWorkspaceChanged) return
  workspaceChangeCleanup = window.electronAPI.onFolderWorkspaceChanged(handleFolderWorkspaceChanged)
}

function buildCodeSelectionTag (): string {
  const selection = normalizedCodeSelection.value
  const file = selectedFile.value
  if (!selection || !file) return ''
  const linePart = selection.start === selection.end
    ? `L${selection.start}`
    : `L${selection.start}-L${selection.end}`
  return `[[code:${file.filePath}#${linePart}]]`
}

function resetCodeSelection (): void {
  codeSelectionStart.value = null
  codeSelectionEnd.value = null
}

function selectCodeLine (lineNumber: number): void {
  if (!codeSelectionStart.value || codeSelectionEnd.value) {
    codeSelectionStart.value = lineNumber
    codeSelectionEnd.value = null
    queueCodeSelectionToolbarPositionUpdate()
    return
  }
  codeSelectionEnd.value = lineNumber
  queueCodeSelectionToolbarPositionUpdate()
}

function isCodeLineSelected (lineNumber: number): boolean {
  const selection = normalizedCodeSelection.value
  if (!selection) return false
  return lineNumber >= selection.start && lineNumber <= selection.end
}

function getLineNumberFromElement (element: Element | null): number | null {
  if (!element) return null
  const rawLineNumber = element.getAttribute('data-line-number')
  if (!rawLineNumber) return null
  const lineNumber = Number.parseInt(rawLineNumber, 10)
  return Number.isFinite(lineNumber) ? lineNumber : null
}

function getCodeLineElementFromNode (node: Node | null): HTMLElement | null {
  if (!node || !codePreviewRef.value) return null
  const element = node instanceof Element ? node : node.parentElement
  const lineElement = element?.closest<HTMLElement>('.code-line') || null
  if (!lineElement || !codePreviewRef.value.contains(lineElement)) return null
  return lineElement
}

function handleCodeTextSelection (): void {
  const selection = window.getSelection()
  const preview = codePreviewRef.value
  const scroll = codeScrollRef.value
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !preview || !scroll) return
  if (!preview.contains(selection.anchorNode) && !preview.contains(selection.focusNode)) return

  const range = selection.getRangeAt(0)
  const selectedLines: number[] = []
  for (const lineElement of Array.from(scroll.querySelectorAll<HTMLElement>('.code-line'))) {
    try {
      if (!range.intersectsNode(lineElement)) continue
    } catch {
      continue
    }
    const lineNumber = getLineNumberFromElement(lineElement)
    if (lineNumber) selectedLines.push(lineNumber)
  }

  if (selectedLines.length > 0) {
    codeSelectionStart.value = Math.min(...selectedLines)
    codeSelectionEnd.value = Math.max(...selectedLines)
    queueCodeSelectionToolbarPositionUpdate()
    return
  }

  const anchorLine = getLineNumberFromElement(getCodeLineElementFromNode(selection.anchorNode))
  const focusLine = getLineNumberFromElement(getCodeLineElementFromNode(selection.focusNode))
  if (!anchorLine || !focusLine) return
  codeSelectionStart.value = anchorLine
  codeSelectionEnd.value = focusLine
  queueCodeSelectionToolbarPositionUpdate()
}

function updateCodeSelectionToolbarPosition (): void {
  const preview = codePreviewRef.value
  const scroll = codeScrollRef.value
  const selection = normalizedCodeSelection.value
  if (!preview || !scroll || !selection || selectedFile.value?.isMarkdown) return

  const firstLine = scroll.querySelector<HTMLElement>(`.code-line[data-line-number="${selection.start}"]`)
  if (!firstLine) return
  const lastLine = scroll.querySelector<HTMLElement>(`.code-line[data-line-number="${selection.end}"]`) || firstLine

  const toolbar = codeSelectionToolbarRef.value
  const toolbarWidth = toolbar?.offsetWidth || 248
  const toolbarHeight = toolbar?.offsetHeight || 34
  const firstTop = firstLine.offsetTop
  const lastBottom = lastLine.offsetTop + lastLine.offsetHeight
  const selectionHeight = Math.max(firstLine.offsetHeight, lastBottom - firstTop)
  const desiredTop = selectionHeight > toolbarHeight + 8
    ? firstTop + 4
    : firstTop + firstLine.offsetHeight + 4

  const minTop = preview.scrollTop + 8
  const maxTop = preview.scrollTop + preview.clientHeight - toolbarHeight - 8
  const top = Math.max(minTop, Math.min(desiredTop, Math.max(minTop, maxTop)))
  const gutterWidth = firstLine.querySelector<HTMLElement>('.line-number')?.offsetWidth || 58
  const minLeft = preview.scrollLeft + 8
  const preferredLeft = preview.scrollLeft + gutterWidth + 10
  const maxLeft = preview.scrollLeft + preview.clientWidth - toolbarWidth - 12
  const left = Math.max(minLeft, Math.min(preferredLeft, Math.max(minLeft, maxLeft)))

  codeSelectionToolbarStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`
  }
}

function queueCodeSelectionToolbarPositionUpdate (): void {
  void nextTick(() => {
    if (typeof window === 'undefined') {
      updateCodeSelectionToolbarPosition()
      return
    }
    if (toolbarPositionFrame !== null) {
      window.cancelAnimationFrame(toolbarPositionFrame)
    }
    toolbarPositionFrame = window.requestAnimationFrame(() => {
      toolbarPositionFrame = null
      updateCodeSelectionToolbarPosition()
    })
  })
}

function handleCodePreviewScroll (): void {
  scheduleVirtualUpdate()
  updateCodeSelectionToolbarPosition()
}

function insertCodeSelectionTag (): void {
  const tag = buildCodeSelectionTag()
  if (!tag) return
  emit('insertSelectionTag', tag)
}

function bindWorkspaceShortcuts (): void {
  if (workspaceShortcutsBound) return
  document.addEventListener('keydown', handleWorkspaceKeydown)
  workspaceShortcutsBound = true
}

function unbindWorkspaceShortcuts (): void {
  if (!workspaceShortcutsBound) return
  document.removeEventListener('keydown', handleWorkspaceKeydown)
  workspaceShortcutsBound = false
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
    // 用户导入代码区的瞬间展开目录树，便于确认导入内容；之后可手动收起。
    isTreeExpanded.value = true
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
    resetCodeSelection()
    fileError.value = 'Binary file preview is unavailable.'
    if (options?.persist !== false) emitWorkspaceState()
    return
  }

  isLoadingFile.value = true
  fileError.value = ''
  currentActiveFilePath.value = item.path
  resetCodeSelection()
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

/** Copies the conversation-bound folder state into the tab and reloads what changed. */
async function syncFromExternalProps (): Promise<void> {
  const rootPath = props.rootPath || null
  const rootName = props.rootName || null
  const activeFilePath = props.activeFilePath || null
  const previousRootPath = currentRootPath.value
  const previousActiveFilePath = currentActiveFilePath.value

  currentRootPath.value = rootPath
  currentRootName.value = rootName
  currentActiveFilePath.value = activeFilePath

  if (!isActiveTab.value || !rootPath) return
  if (rootPath !== previousRootPath) {
    expandedDirs.value = new Set()
    await loadWorkspaceTree(activeFilePath)
    return
  }
  if (activeFilePath && activeFilePath !== previousActiveFilePath && selectedFile.value?.filePath !== activeFilePath) {
    const entry = findEntry(fileTree.value, activeFilePath)
    if (entry?.type === 'file') {
      await openFile(entry, { persist: false })
    }
  }
}

watch(
  () => [props.rootPath, props.rootName, props.activeFilePath] as const,
  () => {
    void syncFromExternalProps()
  }
)

watch(searchResults, (results) => {
  if (activeSearchIndex.value >= results.length) {
    activeSearchIndex.value = 0
  }
})

watch(normalizedCodeSelection, (selection) => {
  if (!selection) return
  queueCodeSelectionToolbarPositionUpdate()
}, { flush: 'post' })

async function handleTabActivated (): Promise<void> {
  if (isActiveTab.value) return
  isActiveTab.value = true
  bindWorkspaceShortcuts()
  bindWorkspaceChangeListener()
  await syncFromExternalProps()
  if (currentRootPath.value && (workspaceTreeDirty || fileTree.value.length === 0)) {
    workspaceTreeDirty = false
    await loadWorkspaceTree(pendingWorkspaceRefreshFilePath || currentActiveFilePath.value)
    pendingWorkspaceRefreshFilePath = null
    return
  }
  if (!currentRootPath.value && !promptedForOpen.value) {
    promptedForOpen.value = true
    await chooseFolder()
  }
}

function handleTabDeactivated (): void {
  if (!isActiveTab.value) return
  isActiveTab.value = false
  promptedForOpen.value = false
  unbindWorkspaceShortcuts()
}

async function copyRootPath (): Promise<void> {
  if (!currentRootPath.value) return
  try {
    await navigator.clipboard.writeText(currentRootPath.value)
  } catch {
    // Clipboard writes can fail without permissions; the action is best-effort.
  }
}

onActivated(() => {
  void handleTabActivated()
})

onDeactivated(() => {
  handleTabDeactivated()
})

onMounted(() => {
  bindWorkspaceChangeListener()
})

onBeforeUnmount(() => {
  handleTabDeactivated()
  stopPreviewRenderLoops()
  if (workspaceRefreshTimer !== null) {
    window.clearTimeout(workspaceRefreshTimer)
    workspaceRefreshTimer = null
  }
  if (toolbarPositionFrame !== null) {
    window.cancelAnimationFrame(toolbarPositionFrame)
    toolbarPositionFrame = null
  }
  workspaceChangeCleanup?.()
  workspaceChangeCleanup = null
})

defineExpose({
  chooseFolder,
  refreshWorkspace,
  copyRootPath
})
</script>

<template>
  <div class="folder-workspace-tab">
    <div class="workspace-shell">
      <div v-if="!currentRootPath" class="workspace-empty">
        <div class="workspace-empty-title">{{ $t('chatUi.noWorkspaceSelected') }}</div>
        <button class="choose-folder-btn" type="button" :disabled="isPickingFolder" @click="chooseFolder">
          {{ isPickingFolder ? $t('chatUi.opening') : $t('chatUi.chooseFolder') }}
        </button>
        <div v-if="workspaceError" class="workspace-error">{{ workspaceError }}</div>
      </div>

      <div v-else class="workspace-body" :class="{ 'tree-collapsed': !isTreeExpanded }">
        <aside class="workspace-tree">
          <div class="tree-root" :title="currentRootPath || undefined">
            <span class="tree-root-name">{{ currentRootName }}</span>
          </div>
          <div class="file-search">
            <input
              ref="fileSearchInputRef"
              v-model="fileSearchQuery"
              class="file-search-input"
              type="search"
              :placeholder="$t('chatUi.searchFilesPlaceholder')"
              @keydown="handleSearchKeydown"
            >
            <button v-if="fileSearchQuery" class="file-search-clear" type="button" :title="$t('common.clear')" @click="clearFileSearch">×</button>
          </div>
          <div v-if="hasFileSearch" class="file-search-results">
            <button
              v-for="(item, index) in searchResults"
              :key="item.path"
              class="file-search-result"
              :class="{ active: index === activeSearchIndex }"
              type="button"
              :title="item.path"
              @mousedown.prevent="openSearchResult(item)"
            >
              <span class="file-search-result-icon">{{ getFileIcon(item) }}</span>
              <span class="file-search-result-copy">
                <strong>{{ item.name }}</strong>
                <small>{{ item.path }}</small>
              </span>
            </button>
            <div v-if="searchResults.length === 0" class="file-search-empty">{{ $t('chatUi.noFileSearchMatches') }}</div>
          </div>
          <div v-if="workspaceError" class="workspace-error inline">{{ workspaceError }}</div>
          <div v-if="isLoadingTree" class="tree-loading">{{ $t('chatUi.loadingPlain') }}</div>
          <div v-else ref="treeListRef" class="tree-list">
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
            <div v-if="flatFileTree.length === 0" class="tree-empty">{{ $t('chatUi.noPreviewableFiles') }}</div>
          </div>
        </aside>

        <main class="workspace-preview">
          <div class="preview-header">
            <button
              class="workspace-icon-btn tree-toggle"
              :class="{ active: isTreeExpanded }"
              type="button"
              :title="isTreeExpanded ? $t('chatUi.collapseFileTree') : $t('chatUi.expandFileTree')"
              :aria-expanded="isTreeExpanded"
              @click="toggleFileTree"
            >
              <SidebarIcon name="panel" :size="14" />
            </button>
            <div class="preview-path">
              <span v-if="currentRootName" class="path-root" :title="currentRootPath || undefined">{{ currentRootName }}</span>
              <span v-if="currentRootName && selectedFile" class="path-sep" aria-hidden="true">›</span>
              <span v-if="selectedFile" class="path-file" :title="selectedFile.filePath">{{ selectedFile.filePath }}</span>
            </div>
            <div v-if="selectedFile" class="preview-meta">
              <span>{{ formatFileSize(selectedFile.size) }}</span>
              <span v-if="lineCount > 0">{{ $t('chatUi.lineCount', { count: lineCount }) }}</span>
              <span v-if="selectedFile.truncated">{{ $t('chatUi.contentTruncated') }}</span>
            </div>
          </div>

            <template v-if="selectedFile">
              <template v-if="selectedFile.isMarkdown">
                <div class="markdown-preview markdown-body">
                  <div v-for="(html, index) in markdownChunks" :key="index" class="markdown-chunk" v-html="html"></div>
                </div>
              </template>
            <div
              v-else
              ref="codePreviewRef"
              class="code-preview"
              @scroll="handleCodePreviewScroll"
              @mouseup="handleCodeTextSelection"
              @touchend="handleCodeTextSelection"
            >
              <div ref="codeScrollRef" class="code-scroll" :style="{ height: `${virtualScrollHeight}px` }">
                <div
                  v-for="line in renderedRows"
                  :key="line.number"
                  class="code-line virtual-row"
                  :style="{ top: `${line.top}px` }"
                  :class="{ selected: isCodeLineSelected(line.number), pending: codeSelectionStart === line.number && codeSelectionEnd === null }"
                  :data-line-number="line.number"
                >
                  <button
                    class="line-number"
                    type="button"
                    :title="$t('chatUi.selectCodeLine', { line: line.number })"
                    @click="selectCodeLine(line.number)"
                  >
                    {{ line.number }}
                  </button>
                  <code class="code-line-content hljs" v-html="line.html || '&nbsp;'"></code>
                </div>
              </div>
              <div
                v-if="normalizedCodeSelection"
                ref="codeSelectionToolbarRef"
                class="code-selection-popover"
                :style="codeSelectionToolbarStyle"
                @mousedown.stop
              >
                <span class="code-selection-range" :title="codeSelectionLabel">{{ $t('chatUi.codeSelectionReady', { range: codeSelectionLabel }) }}</span>
                <div class="code-selection-popover-actions">
                  <button class="code-selection-insert" type="button" @mousedown.prevent @click="insertCodeSelectionTag">{{ $t('chatUi.insertCodeSelectionTag') }}</button>
                  <button class="code-selection-cancel" type="button" :title="$t('common.cancel')" @mousedown.prevent @click="resetCodeSelection">×</button>
                </div>
              </div>
            </div>
          </template>

          <div v-else-if="isLoadingFile" class="preview-placeholder">{{ $t('chatUi.readingPlain') }}</div>
          <div v-else-if="fileError" class="preview-error">{{ fileError }}</div>
          <div v-else class="preview-placeholder">{{ $t('chatUi.selectFileToPreview') }}</div>
        </main>
      </div>
    </div>
  </div>
</template>

<style scoped>
.folder-workspace-tab {
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--app-bg);
  color: var(--app-text);
  overflow: hidden;
}

.workspace-shell {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.workspace-icon-btn {
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

.workspace-icon-btn:hover {
  color: var(--app-text-strong);
  border-color: color-mix(in srgb, var(--app-accent) 36%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 38%, var(--app-panel));
}

/* 左上角目录树开关：展开态用强调色标出当前树可见。 */
.workspace-icon-btn.tree-toggle.active {
  color: var(--app-accent-strong, var(--app-accent));
  border-color: color-mix(in srgb, var(--app-accent) 48%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 55%, var(--app-panel));
}

.workspace-icon-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.workspace-icon-btn svg {
  width: 17px;
  height: 17px;
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
  /* 收起时目录树整列滑出左侧，需要裁掉越界部分。 */
  position: relative;
  overflow: hidden;
}

.workspace-tree {
  width: 280px;
  flex: 0 0 280px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  background: color-mix(in srgb, var(--app-panel) 74%, transparent);
  transition: margin-left 0.22s ease, opacity 0.18s ease, visibility 0s linear 0s;
}

/* 默认收起（tree-collapsed 由左上角开关控制）：代码查看只占满整行，
   目录树滑出视口左侧并从可聚焦树里移除；再点开关滑回。 */
.tree-collapsed .workspace-tree {
  margin-left: -281px;
  opacity: 0;
  visibility: hidden;
  transition: margin-left 0.22s ease, opacity 0.18s ease, visibility 0s linear 0.22s;
}

.tree-root {
  flex: 0 0 auto;
  /* 与右侧预览头同高(45px)且垂直居中：目录树展开时两侧的项目名行水平对齐。 */
  min-height: 45px;
  padding: 6px 12px;
  display: flex;
  align-items: center;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 72%, transparent);
  color: var(--app-text-strong);
  font-size: 0.78rem;
  font-weight: 800;
}

.tree-root-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-search {
  position: relative;
  flex: 0 0 auto;
  padding: 8px 8px 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 62%, transparent);
}

.file-search-input {
  width: 100%;
  height: 32px;
  padding: 0 30px 0 10px;
  border: 1px solid color-mix(in srgb, var(--app-border) 76%, transparent);
  border-radius: 9px;
  outline: none;
  background: color-mix(in srgb, var(--app-input-bg) 88%, transparent);
  color: var(--app-text);
  font-size: 0.76rem;
}

.file-search-input:focus {
  border-color: color-mix(in srgb, var(--app-accent) 42%, var(--app-border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent-soft) 48%, transparent);
}

.file-search-clear {
  position: absolute;
  right: 14px;
  top: 14px;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
}

.file-search-clear:hover {
  background: var(--app-panel-muted);
  color: var(--app-text-strong);
}

.file-search-results {
  flex: 0 0 auto;
  max-height: 270px;
  overflow: auto;
  padding: 4px 6px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 62%, transparent);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--app-accent-soft) 20%, transparent), transparent 45%),
    color-mix(in srgb, var(--app-panel-strong) 92%, transparent);
}

.file-search-result {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--app-text);
  text-align: left;
  cursor: pointer;
}

.file-search-result:hover,
.file-search-result.active {
  background: color-mix(in srgb, var(--app-accent-soft) 56%, transparent);
}

.file-search-result-icon {
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  background: color-mix(in srgb, var(--app-panel-muted) 84%, transparent);
  color: var(--app-text-muted);
  font-size: 0.58rem;
  font-weight: 900;
}

.file-search-result-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.file-search-result-copy strong,
.file-search-result-copy small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-search-result-copy strong {
  color: var(--app-text-strong);
  font-size: 0.74rem;
}

.file-search-result-copy small {
  color: var(--app-text-muted);
  font-size: 0.64rem;
}

.file-search-empty {
  padding: 12px 8px 6px;
  color: var(--app-text-muted);
  font-size: 0.74rem;
  text-align: center;
}

.tree-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px;
}

.tree-list::-webkit-scrollbar,
.file-search-results::-webkit-scrollbar {
  width: 9px;
  height: 9px;
}

.tree-list::-webkit-scrollbar-thumb,
.file-search-results::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-scrollbar) 78%, transparent);
  background-clip: padding-box;
}

.tree-list::-webkit-scrollbar-thumb:hover,
.file-search-results::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--app-scrollbar-hover) 88%, transparent);
  background-clip: padding-box;
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
  gap: 10px;
  padding: 6px 12px 6px 8px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.16);
  color: #dbeafe;
}

.preview-path {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.78rem;
}

/* 项目/文件夹名作为面包屑第一级，收起目录树时也始终可见。 */
.path-root {
  flex-shrink: 0;
  max-width: 36%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--app-text-muted);
}

.path-sep {
  flex-shrink: 0;
  color: var(--app-text-faint);
}

.path-file {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  position: relative;
  flex: 1;
  width: 100%;
  max-width: 100%;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  background: #0b0f16;
  scrollbar-color: rgba(71, 85, 105, 0.86) rgba(15, 23, 42, 0.86);
  scrollbar-width: auto;
}

.code-selection-popover {
  position: absolute;
  z-index: 6;
  max-width: calc(100% - 16px);
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 5px 4px 10px;
  border: 1px solid rgba(56, 189, 248, 0.34);
  border-radius: 8px;
  background:
    linear-gradient(90deg, rgba(14, 165, 233, 0.24), rgba(34, 197, 94, 0.12)),
    rgba(8, 13, 22, 0.96);
  box-shadow: 0 12px 26px rgba(0, 0, 0, 0.34);
  color: #dbeafe;
  backdrop-filter: blur(10px);
}

.code-selection-range {
  min-width: 0;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #bfdbfe;
  font-size: 0.68rem;
  font-weight: 750;
}

.code-selection-popover-actions {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.code-selection-popover button {
  height: 24px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 7px;
  color: #e2e8f0;
  font-size: 0.68rem;
  font-weight: 800;
  cursor: pointer;
}

.code-selection-insert {
  padding: 0 9px;
  background: rgba(14, 165, 233, 0.26);
}

.code-selection-cancel {
  width: 24px;
  padding: 0;
  background: rgba(255, 255, 255, 0.06);
  font-size: 1rem;
  line-height: 1;
}

.code-selection-popover button:hover {
  border-color: rgba(125, 211, 252, 0.56);
  background: rgba(14, 165, 233, 0.34);
}

.code-preview::-webkit-scrollbar {
  width: 15px;
  height: 15px;
}

.code-preview::-webkit-scrollbar-track {
  background: rgba(15, 23, 42, 0.86);
}

.code-preview::-webkit-scrollbar-thumb {
  border: 3px solid rgba(15, 23, 42, 0.86);
  border-radius: 999px;
  background: rgba(71, 85, 105, 0.9);
  background-clip: padding-box;
}

.code-preview::-webkit-scrollbar-thumb:hover {
  background: rgba(100, 116, 139, 0.96);
  background-clip: padding-box;
}

.code-scroll {
  /* 虚拟滚动的定位上下文：高度 = 总行数 × 行高（:style 绑定），
     可视区之外的行不存在于 DOM。 */
  position: relative;
  display: inline-block;
  width: max-content;
  min-width: 100%;
  margin: 0;
  padding: 0;
  color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre;
}

.virtual-row {
  position: absolute;
  left: 0;
}

.code-line {
  display: flex;
  width: max-content;
  min-width: 100%;
}

.code-line:hover {
  background: rgba(148, 163, 184, 0.06);
}

.code-line.selected {
  background: rgba(14, 165, 233, 0.16);
}

.code-line.pending {
  background: rgba(245, 158, 11, 0.16);
}

.line-number {
  position: sticky;
  left: 0;
  z-index: 2;
  width: 58px;
  min-height: 18.6px;
  padding: 0 10px 0 8px;
  border: none;
  border-right: 1px solid rgba(148, 163, 184, 0.16);
  background:
    linear-gradient(90deg, rgba(15, 23, 42, 0.98), rgba(15, 23, 42, 0.92));
  color: #64748b;
  text-align: right;
  font: inherit;
  line-height: inherit;
  user-select: none;
  cursor: crosshair;
}

.code-line:hover .line-number {
  color: #93c5fd;
  background:
    linear-gradient(90deg, rgba(20, 30, 48, 1), rgba(20, 30, 48, 0.96));
}

.code-line.selected .line-number {
  color: #dbeafe;
  background:
    linear-gradient(90deg, rgba(3, 105, 161, 0.96), rgba(14, 116, 144, 0.88));
}

.code-line.pending .line-number {
  color: #fef3c7;
  background:
    linear-gradient(90deg, rgba(146, 64, 14, 0.96), rgba(133, 77, 14, 0.88));
}

.code-line-content {
  flex: 0 0 auto;
  min-width: max-content;
  min-height: 18.6px;
  display: block;
  padding: 0 18px 0 12px;
  background: transparent;
  font: inherit;
  line-height: inherit;
  white-space: pre;
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
