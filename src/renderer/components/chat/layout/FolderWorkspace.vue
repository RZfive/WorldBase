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

interface CodeLine {
  number: number
  html: string
}

interface TemplateHighlightState {
  embeddedLanguage: string | null
  inAstroFrontmatter: boolean
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
  (e: 'insertSelectionTag', tag: string): void
  (e: 'updateWorkspace', state: WorkspaceState | null): void
}>()

const workspaceRoot = ref<HTMLElement | null>(null)
const treeListRef = ref<HTMLElement | null>(null)
const fileSearchInputRef = ref<HTMLInputElement | null>(null)
const codePreviewRef = ref<HTMLElement | null>(null)
const codeScrollRef = ref<HTMLElement | null>(null)
const codeSelectionToolbarRef = ref<HTMLElement | null>(null)
const workspaceWidth = ref(props.workspaceWidth)
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
let workspaceShortcutsBound = false
let toolbarPositionFrame: number | null = null

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
const renderedMarkdown = computed(() => selectedFile.value?.isMarkdown ? renderMarkdown(selectedFile.value.content) : '')
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
const codeSelectionLabel = computed(() => {
  const selection = normalizedCodeSelection.value
  if (!selection || !selectedFile.value) return ''
  const linePart = selection.start === selection.end
    ? `L${selection.start}`
    : `L${selection.start}-L${selection.end}`
  return `${selectedFile.value.filePath}#${linePart}`
})
const codeLines = computed<CodeLine[]>(() => {
  const file = selectedFile.value
  if (!file || file.isMarkdown) return []
  if (file.content === '') return []

  const state: TemplateHighlightState = {
    embeddedLanguage: null,
    inAstroFrontmatter: false
  }
  return file.content.split('\n').map((line, index) => ({
    number: index + 1,
    html: highlightCodeLine(line, file, state, index)
  }))
})

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
    focusFileSearch()
  }
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
  const preview = codePreviewRef.value
  if (!node || !preview) return null
  const element = node instanceof Element ? node : node.parentElement
  const lineElement = element?.closest<HTMLElement>('.code-line') || null
  if (!lineElement || !preview.contains(lineElement)) return null
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
  updateCodeSelectionToolbarPosition()
}

function insertCodeSelectionTag (): void {
  const tag = buildCodeSelectionTag()
  if (!tag) return
  emit('insertSelectionTag', tag)
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
      if (workspaceShortcutsBound) {
        document.removeEventListener('keydown', handleWorkspaceKeydown)
        workspaceShortcutsBound = false
      }
      layoutObserver?.disconnect()
      layoutObserver = null
      return
    }

    if (!workspaceShortcutsBound) {
      document.addEventListener('keydown', handleWorkspaceKeydown)
      workspaceShortcutsBound = true
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
    const previousActiveFilePath = previous?.[2]
    currentRootPath.value = rootPath || null
    currentRootName.value = rootName || null
    currentActiveFilePath.value = activeFilePath || null
    if (!props.visible || !currentRootPath.value) return
    if (rootPath !== previousRootPath) {
      expandedDirs.value = new Set()
      await loadWorkspaceTree(activeFilePath || null)
      return
    }
    if (activeFilePath && activeFilePath !== previousActiveFilePath && selectedFile.value?.filePath !== activeFilePath) {
      const entry = findEntry(fileTree.value, activeFilePath)
      if (entry?.type === 'file') {
        await openFile(entry, { persist: false })
      }
    }
  },
  { immediate: true }
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

onMounted(() => {
  if (!props.visible) return
  bindLayoutObserver()
  void syncWorkspaceWidthToLayout(props.workspaceWidth)
})

onBeforeUnmount(() => {
  stopResize()
  if (toolbarPositionFrame !== null) {
    window.cancelAnimationFrame(toolbarPositionFrame)
    toolbarPositionFrame = null
  }
  if (workspaceShortcutsBound) {
    document.removeEventListener('keydown', handleWorkspaceKeydown)
    workspaceShortcutsBound = false
  }
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
          <h3 class="workspace-title">{{ $t('chatUi.codeWorkspace') }}</h3>
          <p class="workspace-subtitle" :title="currentRootPath || undefined">{{ currentRootName || $t('chatUi.noFolderSelected') }}</p>
        </div>
        <div class="workspace-header-actions">
          <button class="workspace-icon-btn" type="button" :title="$t('chatUi.chooseFolder')" @click="chooseFolder">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4l2 2h6A2.5 2.5 0 0 1 20.5 8.5v8A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-10Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
              <path d="M12 10v5M9.5 12.5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </button>
          <button class="workspace-icon-btn" type="button" :title="$t('chatUi.refresh')" :disabled="!currentRootPath || isLoadingTree" @click="refreshWorkspace">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M20 12a8 8 0 0 1-13.66 5.66M4 12A8 8 0 0 1 17.66 6.34" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              <path d="M17 3.5h2.8V6.3M7 20.5H4.2V17.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button class="workspace-close" type="button" :title="$t('chatUi.closeCodeWorkspace')" @click="emit('close')">×</button>
        </div>
      </header>

      <div v-if="!currentRootPath" class="workspace-empty">
        <div class="workspace-empty-title">{{ $t('chatUi.noWorkspaceSelected') }}</div>
        <button class="choose-folder-btn" type="button" :disabled="isPickingFolder" @click="chooseFolder">
          {{ isPickingFolder ? $t('chatUi.opening') : $t('chatUi.chooseFolder') }}
        </button>
        <div v-if="workspaceError" class="workspace-error">{{ workspaceError }}</div>
      </div>

      <div v-else class="workspace-body">
        <aside class="workspace-tree">
          <div class="tree-root" :title="currentRootPath || undefined">{{ currentRootName }}</div>
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
          <template v-if="selectedFile">
            <div class="preview-header">
              <div class="preview-path" :title="selectedFile.filePath">{{ selectedFile.filePath }}</div>
              <div class="preview-meta">
                <span>{{ formatFileSize(selectedFile.size) }}</span>
                <span v-if="lineCount > 0">{{ $t('chatUi.lineCount', { count: lineCount }) }}</span>
                <span v-if="selectedFile.truncated">{{ $t('chatUi.contentTruncated') }}</span>
              </div>
            </div>

            <div v-if="selectedFile.isMarkdown" class="markdown-preview markdown-body" v-html="renderedMarkdown"></div>
            <div
              v-else
              ref="codePreviewRef"
              class="code-preview"
              @scroll="handleCodePreviewScroll"
              @mouseup="handleCodeTextSelection"
              @touchend="handleCodeTextSelection"
            >
              <div ref="codeScrollRef" class="code-scroll">
                <div
                  v-for="line in codeLines"
                  :key="line.number"
                  class="code-line"
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
  display: inline-block;
  width: max-content;
  min-width: 100%;
  margin: 0;
  padding: 10px 0 16px;
  color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre;
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
