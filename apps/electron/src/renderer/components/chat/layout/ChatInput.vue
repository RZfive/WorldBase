<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch, type CSSProperties } from 'vue'
import { useI18n } from 'vue-i18n'
import { copyTextToClipboard } from '../export-utils'

interface PendingAttachment {
  id: string
  name: string
  fileType: string
  fileSizeLabel: string
}

interface DocumentTagChip {
  regionId: string
  label: string
  raw: string
}

interface ProjectTagChip {
  projectId: string
  name: string
  raw: string
}

interface CodeTagChip {
  id: string
  label: string
  raw: string
}

type AIExecutionAuthMode = 'strict' | 'auto'

interface GroupMentionHint {
  token: string
  label: string
  aliases?: string[]
}

interface MentionQueryState {
  start: number
  end: number
  query: string
  top: number
  left: number
  lineHeight: number
}

const props = defineProps<{
  modelValue: string
  isLoading: boolean
  pendingAuthCount?: number
  pendingImages: Array<{ base64: string; mimeType: string }>
  pendingFiles: PendingAttachment[]
  isUploadingFiles: boolean
  uploadFeedback: string
  documentDockVisible: boolean
  folderWorkspaceVisible: boolean
  authMode: AIExecutionAuthMode
  planModeActive: boolean
  computerUseEnabled?: boolean
  /** null until the first macOS permission query lands; false gates the toggle. */
  computerUsePermissionGranted?: boolean | null
  availableSkills?: Array<{ id: string; name: string }>
  activeSkillIds?: Set<string>
  showSkillPicker?: boolean
  selectedGroupId?: string
  activeGroupSessionId?: string
  groupMentionHints?: GroupMentionHint[]
  isGroupConversation?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'send'): void
  (e: 'stop'): void
  (e: 'addAttachments', files: File[]): void
  (e: 'removeImage', index: number): void
  (e: 'removeFile', id: string): void
  (e: 'toggleDocumentDock'): void
  (e: 'toggleFolderWorkspace'): void
  (e: 'update:auth-mode', value: AIExecutionAuthMode): void
  (e: 'togglePlanMode'): void
  (e: 'toggleComputerUse'): void
  (e: 'toggleSkillPicker'): void
  (e: 'selectAllSkills'): void
  (e: 'clearSkills'): void
  (e: 'toggleSkill', skillId: string): void
}>()

const { t } = useI18n()

const DOCUMENT_TAG_PATTERN = /\[\[doc:([A-Za-z0-9_-]+)(?:\|([^\]]*))?\]\]/g
const PROJECT_TAG_PATTERN = /\[\[project:([^\]|]+)(?:\|([^\]]*))?\]\]/g
const CODE_TAG_PATTERN = /\[\[code:([^\]#|]+)#L(\d+)(?:-L?(\d+))?(?:\|([^\]]*))?\]\]/g

const inputFocused = ref(false)
const dragDepth = ref(0)
const dragActive = ref(false)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const activeMention = ref<MentionQueryState | null>(null)
const activeMentionIndex = ref(0)
const pendingSelection = ref<{ start: number; end: number } | null>(null)
// R5 · human-in-the-loop injection into a running group deliberation.
const showInjectPanel = ref(false)
const injectText = ref('')
const injectFeedback = ref<'idle' | 'sent' | 'failed'>('idle')
const isInjecting = ref(false)
let injectFeedbackTimer: ReturnType<typeof setTimeout> | null = null
const canInject = computed(() => Boolean(props.isGroupConversation && props.selectedGroupId && props.activeGroupSessionId && props.isLoading))
const inputContextMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  copied: false
})
let inputContextMenuResetTimer: number | null = null
const MAX_MENTION_DROPDOWN_HEIGHT = 320
const MIN_MENTION_DROPDOWN_HEIGHT = 120
// design v1.7: the auth pill reads its state without hover —
// auto = green breathing dot, strict = amber; while an auth request is
// pending in strict mode it says 等待授权 (waiting for authorization).
const authModeLabel = computed(() => {
  if (props.authMode === 'strict') {
    return (props.pendingAuthCount || 0) > 0
      ? t('chatUi.waitingAuth')
      : t('chatUi.authModeStrict')
  }
  return t('chatUi.authModeAuto')
})
const LARGE_PASTE_TEXT_ATTACHMENT_THRESHOLD = 2000
const INPUT_CONTEXT_MENU_WIDTH = 128
const INPUT_CONTEXT_MENU_HEIGHT = 112
const projectTags = computed<ProjectTagChip[]>(() => {
  const seenIds = new Set<string>()
  const tags: ProjectTagChip[] = []
  for (const match of props.modelValue.matchAll(PROJECT_TAG_PATTERN)) {
    const projectId = match[1]
    if (seenIds.has(projectId)) continue
    seenIds.add(projectId)
    tags.push({ projectId, name: match[2]?.trim() || projectId, raw: match[0] })
  }
  return tags
})
const documentTags = computed<DocumentTagChip[]>(() => {
  const seenRegionIds = new Set<string>()
  const tags: DocumentTagChip[] = []

  for (const match of props.modelValue.matchAll(DOCUMENT_TAG_PATTERN)) {
    const regionId = match[1]
    if (seenRegionIds.has(regionId)) continue
    seenRegionIds.add(regionId)
    tags.push({
      regionId,
      label: match[2]?.trim() || t('chatUi.documentTagFallback'),
      raw: match[0]
    })
  }

  return tags
})
const codeTags = computed<CodeTagChip[]>(() => {
  const seenIds = new Set<string>()
  const tags: CodeTagChip[] = []

  for (const match of props.modelValue.matchAll(CODE_TAG_PATTERN)) {
    const filePath = match[1]?.trim()
    const startLine = match[2]
    const endLine = match[3] || startLine
    if (!filePath || !startLine) continue
    const id = `${filePath}#L${startLine}${endLine !== startLine ? `-L${endLine}` : ''}`
    if (seenIds.has(id)) continue
    seenIds.add(id)
    tags.push({
      id,
      label: match[4]?.trim() || id,
      raw: match[0]
    })
  }

  return tags
})
const plainDraftText = computed(() => {
  return props.modelValue
    .replace(PROJECT_TAG_PATTERN, '')
    .replace(DOCUMENT_TAG_PATTERN, '')
    .replace(CODE_TAG_PATTERN, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\n+/, '')
})
const hasDraftContent = computed(() => {
  return props.modelValue.trim().length > 0 || props.pendingImages.length > 0 || props.pendingFiles.length > 0
})
const isSendDisabled = computed(() => props.isUploadingFiles || (!props.isLoading && !hasDraftContent.value))

function clearInjectFeedbackTimer (): void {
  if (injectFeedbackTimer !== null) {
    clearTimeout(injectFeedbackTimer)
    injectFeedbackTimer = null
  }
}

function scheduleInjectFeedbackReset (delay: number): void {
  clearInjectFeedbackTimer()
  injectFeedbackTimer = setTimeout(() => {
    injectFeedback.value = 'idle'
    injectFeedbackTimer = null
  }, delay)
}

async function submitGroupInjection (): Promise<void> {
  if (isInjecting.value) return
  const groupId = props.selectedGroupId
  const sessionId = props.activeGroupSessionId
  const content = injectText.value.trim()
  if (!sessionId || !groupId || !content) return
  if (!window.electronAPI?.injectGroupClarification) return
  isInjecting.value = true
  try {
    const result = await window.electronAPI.injectGroupClarification(sessionId, groupId, content)
    if (result?.injected) {
      injectFeedback.value = 'sent'
      injectText.value = ''
      scheduleInjectFeedbackReset(2500)
    } else {
      injectFeedback.value = 'failed'
      scheduleInjectFeedbackReset(3500)
    }
  } catch {
    injectFeedback.value = 'failed'
    scheduleInjectFeedbackReset(3500)
  } finally {
    isInjecting.value = false
  }
}
const runtimeStatusLabel = computed(() => {
  if (!props.isLoading) {
    return ''
  }

  if ((props.pendingAuthCount || 0) > 0) {
    return props.pendingAuthCount === 1
      ? t('chatUi.waitingSingleAuth')
      : t('chatUi.waitingMultipleAuth', { count: props.pendingAuthCount })
  }

  return t('chatUi.runningWait')
})
const mentionOptions = computed<GroupMentionHint[]>(() => {
  const mention = activeMention.value
  const hints = props.groupMentionHints || []
  if (!mention || hints.length === 0) {
    return []
  }

  const query = normalizeMentionToken(mention.query)
  const scored = hints.map((hint, index) => {
    const searchableTokens = Array.from(new Set([
      hint.label,
      hint.token,
      ...(hint.aliases || [])
    ].map(normalizeMentionToken).filter(Boolean)))

    let score = query.length === 0 ? 1 : Number.POSITIVE_INFINITY
    for (const token of searchableTokens) {
      if (query.length === 0) {
        score = Math.min(score, 1)
        continue
      }
      if (token === query) {
        score = 0
        break
      }
      if (token.startsWith(query)) {
        score = Math.min(score, 1)
        continue
      }
      if (token.includes(query)) {
        score = Math.min(score, 2)
      }
    }

    return { hint, index, score }
  }).filter(item => Number.isFinite(item.score))

  scored.sort((left, right) => {
    if (left.score !== right.score) {
      return left.score - right.score
    }
    return left.index - right.index
  })

  return scored.map(item => item.hint)
})
const showMentionDropdown = computed(() => {
  return Boolean(activeMention.value) && mentionOptions.value.length > 0 && !props.isLoading && !props.isUploadingFiles
})
const mentionDropdownStyle = computed<CSSProperties>(() => {
  const mention = activeMention.value
  const textarea = textareaRef.value
  if (!mention || !textarea) {
    return {}
  }

  const availableWidth = Math.max(220, textarea.clientWidth - 16)
  const longestOptionLength = mentionOptions.value.reduce((maxLength, hint) => {
    return Math.max(maxLength, `${hint.label} ${hint.token}`.trim().length)
  }, 0)
  const viewportPadding = 12
  const preferredWidth = Math.min(
    Math.max(260, longestOptionLength * 9 + 72),
    Math.min(420, availableWidth, window.innerWidth - viewportPadding * 2)
  )
  const baseTop = mention.top + mention.lineHeight + 8
  const spaceBelow = window.innerHeight - baseTop - viewportPadding
  const spaceAbove = mention.top - viewportPadding - 8
  const placeAbove = spaceBelow < 180 && spaceAbove > spaceBelow
  const resolvedMaxHeight = Math.min(MAX_MENTION_DROPDOWN_HEIGHT, Math.max(MIN_MENTION_DROPDOWN_HEIGHT, placeAbove ? spaceAbove : spaceBelow))
  const resolvedTop = placeAbove
    ? Math.max(viewportPadding, mention.top - resolvedMaxHeight - 8)
    : Math.max(viewportPadding, baseTop)
  const maxLeft = Math.max(viewportPadding, window.innerWidth - preferredWidth - viewportPadding)

  return {
    position: 'fixed',
    top: `${resolvedTop}px`,
    left: `${Math.min(Math.max(viewportPadding, mention.left), maxLeft)}px`,
    width: `${preferredWidth}px`,
    maxWidth: `${Math.max(220, Math.min(window.innerWidth - viewportPadding * 2, availableWidth))}px`,
    maxHeight: `${resolvedMaxHeight}px`
  }
})

watch(mentionOptions, (options) => {
  if (options.length === 0) {
    activeMentionIndex.value = 0
    return
  }
  if (activeMentionIndex.value >= options.length) {
    activeMentionIndex.value = 0
  }
})

watch(() => props.modelValue, () => {
  if (!pendingSelection.value) return

  nextTick(() => {
    const textarea = textareaRef.value
    const selection = pendingSelection.value
    if (!textarea || !selection) return
    textarea.focus()
    textarea.setSelectionRange(selection.start, selection.end)
    pendingSelection.value = null
    refreshMentionState(textarea.value)
  })
})

watch(canInject, (active) => {
  if (active) return
  showInjectPanel.value = false
  injectText.value = ''
  injectFeedback.value = 'idle'
  clearInjectFeedbackTimer()
})

function buildDraftValue (tags: DocumentTagChip[], text: string): string {
  const projectSegment = projectTags.value.map(tag => tag.raw).join(' ')
  const docSegment = tags.map(tag => tag.raw).join(' ')
  const codeSegment = codeTags.value.map(tag => tag.raw).join(' ')
  const tagSegment = [projectSegment, docSegment, codeSegment].filter(Boolean).join(' ')
  if (tagSegment && text) return `${tagSegment}\n${text}`
  return tagSegment || text
}

function buildTaggedDraftValue (text: string): string {
  const projectSegment = projectTags.value.map(tag => tag.raw).join(' ')
  const docSegment = documentTags.value.map(tag => tag.raw).join(' ')
  const codeSegment = codeTags.value.map(tag => tag.raw).join(' ')
  const tagSegment = [projectSegment, docSegment, codeSegment].filter(Boolean).join(' ')
  if (tagSegment && text) return `${tagSegment}\n${text}`
  return tagSegment || text
}

function normalizeMentionToken (value: string): string {
  return value
    .replace(/^@+/, '')
    .replace(/[【】\[\]（）(){}<>《》「」『』"'“”‘’`~!?,.:;，。！？、：；]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase()
}

function measureMentionPosition (textarea: HTMLTextAreaElement, text: string, caretIndex: number): { top: number; left: number; lineHeight: number } {
  const style = window.getComputedStyle(textarea)
  const rect = textarea.getBoundingClientRect()
  const mirror = document.createElement('div')
  const marker = document.createElement('span')
  const properties = [
    'boxSizing',
    'width',
    'height',
    'overflowX',
    'overflowY',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'fontStyle',
    'fontVariant',
    'fontWeight',
    'fontStretch',
    'fontSize',
    'fontSizeAdjust',
    'lineHeight',
    'fontFamily',
    'letterSpacing',
    'textTransform',
    'textIndent',
    'textDecoration',
    'textAlign',
    'wordSpacing',
    'tabSize'
  ] as const

  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.wordWrap = 'break-word'
  mirror.style.overflow = 'hidden'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'

  for (const property of properties) {
    mirror.style[property] = style[property]
  }

  mirror.textContent = text.slice(0, caretIndex)
  if (mirror.textContent.endsWith('\n')) {
    mirror.textContent += '\u200b'
  }

  marker.textContent = text.slice(caretIndex) || '\u200b'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)

  const lineHeight = Number.parseFloat(style.lineHeight || '20') || 20
  const top = rect.top + marker.offsetTop - textarea.scrollTop
  const left = rect.left + marker.offsetLeft - textarea.scrollLeft

  document.body.removeChild(mirror)
  return { top, left, lineHeight }
}

function computeMentionState (text: string, textarea: HTMLTextAreaElement): MentionQueryState | null {
  const caret = textarea.selectionStart ?? text.length
  const beforeCaret = text.slice(0, caret)
  // `@` triggers a mention when at the start of the input or after any character
  // that is not whitespace or another `@`. The looser left boundary (previously
  // `(?:^|\s)`) lets CJK input work without a leading space, e.g. "请帮我@张三".
  const match = /(?:^|[^\s@])@([^\s@]*)$/.exec(beforeCaret)
  if (!match) {
    return null
  }

  const query = match[1] || ''
  const start = caret - query.length - 1
  const position = measureMentionPosition(textarea, text, caret)

  return {
    start,
    end: caret,
    query,
    top: position.top,
    left: position.left,
    lineHeight: position.lineHeight
  }
}

function refreshMentionState (text?: string) {
  const textarea = textareaRef.value
  if (!textarea || props.isLoading || props.isUploadingFiles || !props.groupMentionHints?.length) {
    activeMention.value = null
    activeMentionIndex.value = 0
    return
  }

  activeMention.value = computeMentionState(text ?? textarea.value, textarea)
  if (!activeMention.value) {
    activeMentionIndex.value = 0
  }
}

function scheduleMentionRefresh () {
  requestAnimationFrame(() => {
    refreshMentionState()
  })
}

function chooseMention (hint: GroupMentionHint) {
  const textarea = textareaRef.value
  const mention = activeMention.value
  if (!textarea || !mention) return

  const text = textarea.value
  const before = text.slice(0, mention.start)
  const after = text.slice(mention.end)
  const suffixSpace = after.length === 0 || !/^\s/.test(after) ? ' ' : ''
  const nextText = `${before}${hint.token}${suffixSpace}${after}`
  const nextCaret = before.length + hint.token.length + suffixSpace.length

  pendingSelection.value = { start: nextCaret, end: nextCaret }
  activeMention.value = null
  activeMentionIndex.value = 0
  emit('update:modelValue', buildTaggedDraftValue(nextText))
}

function removeProjectTag (projectId: string) {
  const remaining = projectTags.value.filter(t => t.projectId !== projectId)
  const projectSegment = remaining.map(t => t.raw).join(' ')
  const docSegment = documentTags.value.map(t => t.raw).join(' ')
  const codeSegment = codeTags.value.map(t => t.raw).join(' ')
  const tagSegment = [projectSegment, docSegment, codeSegment].filter(Boolean).join(' ')
  const text = plainDraftText.value
  if (tagSegment && text) { emit('update:modelValue', `${tagSegment}\n${text}`); return }
  emit('update:modelValue', tagSegment || text)
}

function handleTextInput (e: Event) {
  const nextText = (e.target as HTMLTextAreaElement).value
  emit('update:modelValue', buildTaggedDraftValue(nextText))
  refreshMentionState(nextText)
}

function removeDocumentTag (regionId: string) {
  const remainingTags = documentTags.value.filter(tag => tag.regionId !== regionId)
  emit('update:modelValue', buildDraftValue(remainingTags, plainDraftText.value))
}

function removeCodeTag (id: string) {
  const projectSegment = projectTags.value.map(tag => tag.raw).join(' ')
  const docSegment = documentTags.value.map(tag => tag.raw).join(' ')
  const codeSegment = codeTags.value.filter(tag => tag.id !== id).map(tag => tag.raw).join(' ')
  const tagSegment = [projectSegment, docSegment, codeSegment].filter(Boolean).join(' ')
  const text = plainDraftText.value
  if (tagSegment && text) { emit('update:modelValue', `${tagSegment}\n${text}`); return }
  emit('update:modelValue', tagSegment || text)
}

function handleKeydown (e: KeyboardEvent) {
  if (props.isLoading) return
  if (showMentionDropdown.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      activeMentionIndex.value = (activeMentionIndex.value + 1) % mentionOptions.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      activeMentionIndex.value = (activeMentionIndex.value - 1 + mentionOptions.value.length) % mentionOptions.value.length
      return
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && mentionOptions.value[activeMentionIndex.value]) {
      e.preventDefault()
      chooseMention(mentionOptions.value[activeMentionIndex.value])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      activeMention.value = null
      activeMentionIndex.value = 0
      return
    }
  }
  if (e.key === 'Backspace' && plainDraftText.value.trim().length === 0) {
    if (documentTags.value.length > 0) {
      e.preventDefault()
      removeDocumentTag(documentTags.value[documentTags.value.length - 1].regionId)
      return
    }
    if (codeTags.value.length > 0) {
      e.preventDefault()
      removeCodeTag(codeTags.value[codeTags.value.length - 1].id)
      return
    }
    if (projectTags.value.length > 0) {
      e.preventDefault()
      removeProjectTag(projectTags.value[projectTags.value.length - 1].projectId)
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    emit('send')
  }
}

function collectTransferFiles (transfer: DataTransfer | null): File[] {
  if (!transfer) return []

  const directFiles = Array.from(transfer.files || [])
  if (directFiles.length > 0) return directFiles

  return Array.from(transfer.items || [])
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => Boolean(file))
}

function hasTransferFiles (transfer: DataTransfer | null): boolean {
  return collectTransferFiles(transfer).length > 0
}

function formatPastedTextAttachmentTimestamp (date: Date): string {
  const pad = (value: number, length = 2) => value.toString().padStart(length, '0')
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    pad(date.getMilliseconds(), 3)
  ].join('-')
}

function createPastedTextAttachment (text: string): File {
  return new File(
    [text],
    `pasted-text-${formatPastedTextAttachmentTimestamp(new Date())}.txt`,
    { type: 'text/plain;charset=utf-8' }
  )
}

function handleAttachmentSelection (e: Event) {
  if (props.isLoading || props.isUploadingFiles) return
  const input = e.target as HTMLInputElement
  if (!input.files || input.files.length === 0) return

  emit('addAttachments', Array.from(input.files))
  input.value = ''
}

function handlePaste (e: ClipboardEvent) {
  if (props.isLoading || props.isUploadingFiles) return

  const files = collectTransferFiles(e.clipboardData)
  if (files.length > 0) {
    e.preventDefault()
    emit('addAttachments', files)
    return
  }

  const pastedText = e.clipboardData?.getData('text/plain') ?? ''
  if (pastedText.length < LARGE_PASTE_TEXT_ATTACHMENT_THRESHOLD) return

  e.preventDefault()
  emit('addAttachments', [createPastedTextAttachment(pastedText)])
}

function hideInputContextMenu () {
  inputContextMenu.visible = false
  inputContextMenu.copied = false
  if (inputContextMenuResetTimer != null) {
    window.clearTimeout(inputContextMenuResetTimer)
    inputContextMenuResetTimer = null
  }
}

function openInputContextMenu (e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  inputFocused.value = true
  textareaRef.value?.focus({ preventScroll: true })
  inputContextMenu.visible = true
  inputContextMenu.copied = false
  inputContextMenu.x = Math.max(8, Math.min(e.clientX, window.innerWidth - INPUT_CONTEXT_MENU_WIDTH - 8))
  inputContextMenu.y = Math.max(8, Math.min(e.clientY, window.innerHeight - INPUT_CONTEXT_MENU_HEIGHT - 8))
}

function getInputCopyText (): string {
  const textarea = textareaRef.value
  if (!textarea) return plainDraftText.value
  const start = textarea.selectionStart ?? 0
  const end = textarea.selectionEnd ?? start
  return start !== end ? textarea.value.slice(start, end) : textarea.value
}

async function copyInputText () {
  const text = getInputCopyText()
  if (!text) return

  try {
    await copyTextToClipboard(text)
    inputContextMenu.copied = true
    if (inputContextMenuResetTimer != null) window.clearTimeout(inputContextMenuResetTimer)
    inputContextMenuResetTimer = window.setTimeout(() => {
      hideInputContextMenu()
    }, 650)
  } catch (error) {
    console.error('Failed to copy chat input text:', error)
    hideInputContextMenu()
  }
}

function insertTextIntoInput (text: string) {
  if (!text || props.isLoading || props.isUploadingFiles) return

  if (text.length >= LARGE_PASTE_TEXT_ATTACHMENT_THRESHOLD) {
    emit('addAttachments', [createPastedTextAttachment(text)])
    return
  }

  const textarea = textareaRef.value
  if (!textarea) return
  const start = textarea.selectionStart ?? textarea.value.length
  const end = textarea.selectionEnd ?? start
  const nextText = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`
  const nextCaret = start + text.length
  pendingSelection.value = { start: nextCaret, end: nextCaret }
  emit('update:modelValue', buildTaggedDraftValue(nextText))
  refreshMentionState(nextText)
}

async function pasteInputText () {
  const textarea = textareaRef.value
  if (!textarea || props.isLoading || props.isUploadingFiles) {
    hideInputContextMenu()
    return
  }

  textarea.focus({ preventScroll: true })

  try {
    if (navigator.clipboard?.readText) {
      insertTextIntoInput(await navigator.clipboard.readText())
    } else {
      document.execCommand('paste')
    }
  } catch {
    document.execCommand('paste')
  } finally {
    hideInputContextMenu()
  }
}

function selectAllInputText () {
  const textarea = textareaRef.value
  if (!textarea) return
  textarea.focus({ preventScroll: true })
  textarea.select()
  scheduleMentionRefresh()
  hideInputContextMenu()
}

function handleDragEnter (e: DragEvent) {
  if (props.isLoading || props.isUploadingFiles || !hasTransferFiles(e.dataTransfer)) return

  e.preventDefault()
  dragDepth.value += 1
  dragActive.value = true
}

function handleDragOver (e: DragEvent) {
  if (!hasTransferFiles(e.dataTransfer)) return

  e.preventDefault()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = props.isLoading || props.isUploadingFiles ? 'none' : 'copy'
  }

  if (!props.isLoading && !props.isUploadingFiles) {
    dragActive.value = true
  }
}

function handleDragLeave (e: DragEvent) {
  if (!hasTransferFiles(e.dataTransfer)) return

  e.preventDefault()
  dragDepth.value = Math.max(0, dragDepth.value - 1)
  if (dragDepth.value === 0) {
    dragActive.value = false
  }
}

function handleDrop (e: DragEvent) {
  const files = collectTransferFiles(e.dataTransfer)
  e.preventDefault()

  dragDepth.value = 0
  dragActive.value = false

  if (props.isLoading || props.isUploadingFiles || files.length === 0) return
  emit('addAttachments', files)
}

function handleTextareaFocus () {
  inputFocused.value = true
  scheduleMentionRefresh()
}

function handleTextareaBlur () {
  inputFocused.value = false
  activeMention.value = null
  activeMentionIndex.value = 0
}

onMounted(() => {
  document.addEventListener('click', hideInputContextMenu)
  window.addEventListener('blur', hideInputContextMenu)
})

onUnmounted(() => {
  document.removeEventListener('click', hideInputContextMenu)
  window.removeEventListener('blur', hideInputContextMenu)
  hideInputContextMenu()
  clearInjectFeedbackTimer()
})
</script>

<template>
  <div class="chat-input">
    <!-- Unified input container -->
    <div
      class="input-container"
      :class="{ focused: inputFocused, dragging: dragActive, busy: props.isLoading, waitingAuth: (props.pendingAuthCount || 0) > 0 }"
      @dragenter="handleDragEnter"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <!-- Image preview inside input -->
      <div v-if="props.pendingFiles.length > 0" class="file-preview-bar">
        <div v-for="file in props.pendingFiles" :key="file.id" class="file-preview-item">
          <div class="file-preview-icon">📎</div>
          <div class="file-preview-meta">
            <div class="file-preview-name">{{ file.name }}</div>
            <div class="file-preview-detail">{{ file.fileType.toUpperCase() }} · {{ file.fileSizeLabel }}</div>
          </div>
          <button class="file-remove" @click="emit('removeFile', file.id)">×</button>
        </div>
      </div>
      <div v-if="props.pendingImages.length > 0" class="image-preview-bar">
        <div v-for="(img, idx) in props.pendingImages" :key="idx" class="image-preview-item">
          <img :src="img.base64" class="image-thumb" />
          <button class="image-remove" @click="emit('removeImage', idx)">×</button>
        </div>
      </div>
      <div v-if="projectTags.length > 0" class="project-tag-bar">
        <div v-for="tag in projectTags" :key="tag.projectId" class="project-tag-chip">
          <span class="project-tag-chip-prefix">📦</span>
          <span class="project-tag-chip-label">{{ tag.name }}</span>
          <button class="project-tag-chip-remove" @click="removeProjectTag(tag.projectId)" :title="$t('chatUi.removeProjectTag')">×</button>
        </div>
      </div>
      <div v-if="documentTags.length > 0" class="document-tag-bar">
        <div v-for="tag in documentTags" :key="tag.regionId" class="document-tag-chip">
          <span class="document-tag-chip-prefix">#</span>
          <span class="document-tag-chip-label">{{ tag.label }}</span>
          <button class="document-tag-chip-remove" @click="removeDocumentTag(tag.regionId)" :title="$t('chatUi.removeDocumentTag')">×</button>
        </div>
      </div>
      <div v-if="codeTags.length > 0" class="code-tag-bar">
        <div v-for="tag in codeTags" :key="tag.id" class="code-tag-chip">
          <span class="code-tag-chip-prefix">&lt;/&gt;</span>
          <span class="code-tag-chip-label">{{ tag.label }}</span>
          <button class="code-tag-chip-remove" @click="removeCodeTag(tag.id)" :title="$t('chatUi.removeCodeTag')">×</button>
        </div>
      </div>
      <div class="textarea-shell">
        <textarea
          ref="textareaRef"
          :value="plainDraftText"
          :class="{ busy: props.isLoading }"
          :placeholder="$t('chatUi.messagePlaceholder')"
          :aria-busy="props.isLoading ? 'true' : 'false'"
          @input="handleTextInput"
          @keydown="handleKeydown"
          @keyup="scheduleMentionRefresh"
          @click="scheduleMentionRefresh"
          @mouseup="scheduleMentionRefresh"
          @scroll="scheduleMentionRefresh"
          @paste="handlePaste"
          @contextmenu.prevent.stop="openInputContextMenu"
          @focus="handleTextareaFocus"
          @blur="handleTextareaBlur"
          rows="3"
        />
        <div v-if="showMentionDropdown" class="mention-dropdown" :style="mentionDropdownStyle">
          <button
            v-for="(hint, hintIndex) in mentionOptions"
            :key="hint.token"
            class="mention-option"
            :class="{ active: hintIndex === activeMentionIndex }"
            type="button"
            @mousedown.prevent="chooseMention(hint)"
          >
            <span class="mention-option-label">{{ hint.label }}</span>
            <span class="mention-option-token">{{ hint.token }}</span>
          </button>
        </div>
      </div>
      <div v-if="props.isLoading" class="runtime-status-bar" :class="{ waitingAuth: (props.pendingAuthCount || 0) > 0 }" role="status" aria-live="polite">
        <span class="runtime-status-indicator"></span>
        <span class="runtime-status-copy">{{ runtimeStatusLabel }}</span>
      </div>
      <div class="input-actions">
        <!-- design v1.7: high-frequency actions stay icons and lead the row —
             attachment / code workspace / document center. The agent switcher
             lives in the header next to the agent name. -->
        <div class="tooltip-container">
          <label class="action-btn upload-btn" :class="{ disabled: props.isLoading || props.isUploadingFiles }" :aria-disabled="props.isLoading || props.isUploadingFiles">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 115.66 5.66l-9.2 9.2a2 2 0 01-2.82-2.83l8.49-8.48"/></svg>
            <input type="file" multiple hidden :disabled="props.isLoading || props.isUploadingFiles" @change="handleAttachmentSelection" />
          </label>
          <span class="tooltip-text">{{ $t('chatUi.addAttachment') }}</span>
        </div>
        <div class="tooltip-container">
          <button class="action-btn folder-btn" :class="{ active: props.folderWorkspaceVisible }" type="button" @click="emit('toggleFolderWorkspace')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4l2 2h6A2.5 2.5 0 0 1 20.5 8.5v8A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-10Z"/>
              <path d="m10 12-2 2 2 2"/>
              <path d="m14 12 2 2-2 2"/>
            </svg>
          </button>
          <span class="tooltip-text">{{ $t('chatUi.codeWorkspace') }}</span>
        </div>
        <div class="tooltip-container">
          <button class="action-btn doc-btn" :class="{ active: props.documentDockVisible }" type="button" @click="emit('toggleDocumentDock')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          </button>
          <span class="tooltip-text">{{ $t('chatUi.documentCenter') }}</span>
        </div>
        <!-- Readable state pills follow (design v1.7): 技能 / 计划 / 电脑使用 / 授权模式. -->
        <div v-if="props.availableSkills && props.availableSkills.length > 0" class="composer-skill-selector">
            <button
              class="action-btn state-pill skills-pill"
              :class="{ active: (props.activeSkillIds?.size || 0) > 0 }"
              type="button"
              @click="emit('toggleSkillPicker')"
            >
              <span class="skills-pill-spark" aria-hidden="true">✦</span>
              {{ $t('chatUi.skillsLabel') }}{{ (props.activeSkillIds?.size || 0) > 0 ? ` (${props.activeSkillIds?.size})` : '' }}
            </button>
            <div v-if="props.showSkillPicker" class="composer-skill-dropdown">
              <div class="composer-skill-actions">
                <button type="button" :disabled="props.activeSkillIds?.size === props.availableSkills.length" @click="emit('selectAllSkills')">{{ $t('common.selectAll') }}</button>
                <button type="button" :disabled="(props.activeSkillIds?.size || 0) === 0" @click="emit('clearSkills')">{{ $t('common.clear') }}</button>
              </div>
              <button
                v-for="skill in props.availableSkills"
                :key="skill.id"
                type="button"
                class="composer-skill-option"
                :class="{ selected: props.activeSkillIds?.has(skill.id) }"
                @click="emit('toggleSkill', skill.id)"
              >
                <span class="composer-skill-check" aria-hidden="true">{{ props.activeSkillIds?.has(skill.id) ? '✓' : '' }}</span>
                <span>{{ skill.name }}</span>
              </button>
            </div>
          </div>
          <!-- Plan mode: readable text pill (design v1.7) -->
          <div class="tooltip-container">
            <button
              class="action-btn state-pill plan-mode-btn"
              :class="{ active: props.planModeActive }"
              type="button"
              @click="emit('togglePlanMode')"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                <polyline points="3 6 4 7 6 5"/><polyline points="3 12 4 13 6 11"/><polyline points="3 18 4 19 6 17"/>
              </svg>
              {{ $t('chatUi.planModeLabel') }}
            </button>
            <span class="tooltip-text">{{ props.planModeActive ? $t('chatUi.exitPlanMode') : $t('chatUi.enterPlanMode') }}</span>
          </div>
          <div class="tooltip-container">
            <button
              class="action-btn state-pill computer-use-btn"
              :class="{ active: props.computerUseEnabled, 'permission-locked': props.computerUsePermissionGranted === false }"
              type="button"
              :aria-pressed="props.computerUseEnabled === true"
              :aria-label="props.computerUsePermissionGranted === false ? $t('chatUi.computerUsePermissionNeeded') : (props.computerUseEnabled ? $t('chatUi.disableComputerUse') : $t('chatUi.enableComputerUse'))"
              @click="emit('toggleComputerUse')"
            >
              <span v-if="props.computerUseEnabled" class="pill-dot live" aria-hidden="true"></span>
              <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><path d="m9 10 2 2 4-4"/></svg>
              {{ props.computerUseEnabled ? $t('chatUi.computerUseActiveLabel') : $t('chatUi.computerUseLabel') }}
            </button>
            <span class="tooltip-text">{{ props.computerUsePermissionGranted === false
              ? $t('chatUi.computerUsePermissionNeeded')
              : (props.computerUseEnabled ? $t('chatUi.disableComputerUse') : $t('chatUi.enableComputerUse')) }}</span>
          </div>
          <!-- Auth mode: breathing-dot pill (design v1.7 — auto green / strict amber,
               等待授权 while a request is pending in strict mode). -->
          <div class="tooltip-container">
            <button
              class="action-btn state-pill auth-mode-btn"
              :class="{ auto: props.authMode === 'auto', strict: props.authMode === 'strict' }"
              type="button"
              @click="emit('update:auth-mode', props.authMode === 'strict' ? 'auto' : 'strict')"
            >
              <span class="pill-dot" aria-hidden="true"></span>
              {{ authModeLabel }}
            </button>
            <span class="tooltip-text">{{ props.authMode === 'strict' ? $t('chatUi.strictAuthTooltip') : $t('chatUi.autoAuthTooltip') }}</span>
          </div>
          <div v-if="canInject" class="tooltip-container group-inject-wrapper">
            <button
              class="action-btn group-inject-btn"
              :class="{ active: showInjectPanel }"
              type="button"
              :aria-label="$t('chatUi.groupInjectButton')"
              @click="showInjectPanel = !showInjectPanel"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
            </button>
            <span class="tooltip-text">{{ $t('chatUi.groupInjectButton') }}</span>
            <Transition name="advanced-drawer">
              <div v-if="showInjectPanel" class="group-inject-panel" @click.stop>
                <textarea
                  v-model="injectText"
                  class="group-inject-textarea"
                  :placeholder="$t('chatUi.groupInjectPlaceholder')"
                  rows="2"
                  @keydown.enter.exact.prevent="submitGroupInjection"
                />
                <div class="group-inject-actions">
                  <span v-if="injectFeedback === 'sent'" class="group-inject-feedback sent">{{ $t('chatUi.groupInjectSent') }}</span>
                  <span v-else-if="injectFeedback === 'failed'" class="group-inject-feedback failed">{{ $t('chatUi.groupInjectFailed') }}</span>
                  <button
                    class="group-inject-submit"
                    type="button"
                    :disabled="isInjecting || !injectText.trim()"
                    @click="submitGroupInjection"
                  >{{ $t('chatUi.groupInjectSubmit') }}</button>
                </div>
              </div>
            </Transition>
          </div>
          <button
            class="action-btn send-btn"
            :class="{ stopping: props.isLoading, waitingAuth: (props.pendingAuthCount || 0) > 0 }"
            type="button"
            @click="props.isLoading ? emit('stop') : emit('send')"
            :disabled="isSendDisabled"
            :title="props.isUploadingFiles ? $t('chatUi.processingFiles') : (props.isLoading ? $t('chatUi.stopGenerating') : $t('chatUi.send'))"
          >
            <svg v-if="!props.isLoading" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
          </button>
      </div>
    </div>
    <Teleport to="body">
      <div
        v-if="inputContextMenu.visible"
        class="chat-input-context-menu"
        :style="{ left: `${inputContextMenu.x}px`, top: `${inputContextMenu.y}px` }"
        @mousedown.prevent.stop
        @click.stop
        @contextmenu.prevent
      >
        <button class="chat-input-context-action" type="button" :disabled="plainDraftText.length === 0" @click.stop="copyInputText">
          {{ inputContextMenu.copied ? $t('chatUi.copied') : $t('common.copy') }}
        </button>
        <button class="chat-input-context-action" type="button" :disabled="props.isLoading || props.isUploadingFiles" @click.stop="pasteInputText">
          {{ $t('common.paste') }}
        </button>
        <button class="chat-input-context-action" type="button" :disabled="plainDraftText.length === 0" @click.stop="selectAllInputText">
          {{ $t('common.selectAll') }}
        </button>
      </div>
    </Teleport>
    <div v-if="props.uploadFeedback" class="upload-feedback" role="status">{{ props.uploadFeedback }}</div>
  </div>
</template>

<style scoped>
.chat-input {
  position: relative;
  z-index: 6;
  margin-top: calc(-1 * var(--chat-input-overlap, 0px));
  padding: 10px var(--chat-input-gutter, 16px) 18px;
  background: transparent;
}

.chat-input > * {
  position: relative;
  z-index: 1;
  max-width: var(--chat-message-track-max, 1480px);
  margin-left: auto;
  margin-right: auto;
}

.input-container {
  --chat-input-surface: var(--app-panel);
  --chat-input-border: var(--app-input-border);
  --chat-input-control-surface: color-mix(in srgb, var(--app-panel-muted) 84%, transparent);
  --chat-input-control-border: var(--app-border-strong);
  --chat-input-floating-surface: color-mix(in srgb, var(--app-panel-strong) 92%, white 8%);
  --chat-input-hover-surface: var(--app-panel-muted);
  --chat-input-disabled-surface: var(--app-panel-muted);
  --chat-input-chip-remove-hover: rgba(255, 255, 255, 0.08);
  --chat-input-shadow: 0 12px 32px rgba(28, 32, 60, 0.12);
  --chat-input-focus-shadow: 0 0 0 2px var(--app-accent-soft);
  --chat-input-busy-shadow: 0 0 0 1px rgba(91, 140, 255, 0.08), 0 18px 36px rgba(91, 140, 255, 0.08);
  --chat-input-waiting-shadow: 0 0 0 1px rgba(245, 158, 11, 0.12), 0 18px 36px rgba(245, 158, 11, 0.12);
  --chat-input-popover-shadow: 0 16px 36px rgba(0, 0, 0, 0.18);
  position: relative;
  box-sizing: border-box;
  background: var(--chat-input-surface);
  border: 1px solid var(--chat-input-border);
  border-radius: 15px;
  transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
  overflow: visible;
  box-shadow: var(--chat-input-shadow);
}

:global(:root[data-theme='light'] .chat-input .input-container) {
  --chat-input-border: var(--app-border);
  --chat-input-control-surface: rgba(15, 23, 42, 0.035);
  --chat-input-control-border: rgba(15, 23, 42, 0.11);
  --chat-input-hover-surface: rgba(15, 23, 42, 0.055);
  --chat-input-disabled-surface: rgba(15, 23, 42, 0.05);
  --chat-input-chip-remove-hover: rgba(15, 23, 42, 0.08);
  --chat-input-shadow: 0 18px 44px rgba(15, 23, 42, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.82);
  --chat-input-focus-shadow: 0 0 0 2px rgba(2, 132, 199, 0.14), 0 18px 44px rgba(15, 23, 42, 0.1);
  --chat-input-busy-shadow: 0 0 0 1px rgba(2, 132, 199, 0.13), 0 18px 36px rgba(2, 132, 199, 0.08);
  --chat-input-waiting-shadow: 0 0 0 1px rgba(245, 158, 11, 0.16), 0 18px 36px rgba(245, 158, 11, 0.1);
  --chat-input-popover-shadow: 0 18px 42px rgba(15, 23, 42, 0.14);
}

.input-container.focused {
  border-color: var(--app-accent);
  box-shadow: var(--chat-input-focus-shadow);
}

.input-container.dragging {
  border-color: var(--app-accent);
  box-shadow: var(--chat-input-focus-shadow);
  background: color-mix(in srgb, var(--app-accent) 8%, var(--chat-input-surface));
}

.input-container.busy {
  border-color: color-mix(in srgb, var(--app-accent-glow) 72%, transparent);
  box-shadow: var(--chat-input-busy-shadow);
}

.input-container.waitingAuth {
  border-color: rgba(245, 158, 11, 0.42);
  box-shadow: var(--chat-input-waiting-shadow);
  background: color-mix(in srgb, rgb(245, 158, 11) 6%, var(--chat-input-surface));
}

.image-preview-bar {
  display: flex;
  gap: 8px;
  padding: 10px 12px 4px;
  flex-wrap: wrap;
}

.file-preview-bar {
  display: flex;
  gap: 8px;
  padding: 10px 12px 0;
  flex-wrap: wrap;
}

.file-preview-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 180px;
  max-width: 280px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--chat-input-control-border);
  background: var(--chat-input-control-surface);
}

.file-preview-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: var(--app-accent-soft);
  flex-shrink: 0;
}

.file-preview-meta {
  min-width: 0;
  flex: 1;
}

.file-preview-name {
  font-size: 0.84em;
  color: var(--app-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-preview-detail {
  margin-top: 2px;
  font-size: 0.72em;
  color: var(--app-text-muted);
}

.image-preview-item {
  position: relative;
  display: inline-block;
}

.image-thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--chat-input-control-border);
}

.image-remove {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--app-danger);
  color: var(--app-on-accent);
  border: none;
  font-size: 0.7em;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.15s;
}

.image-preview-item:hover .image-remove { opacity: 1; }
.file-preview-item:hover .file-remove { opacity: 1; }

.file-remove {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--app-danger);
  color: var(--app-on-accent);
  border: none;
  font-size: 0.7em;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.15s;
}

.project-tag-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px 0;
}

.textarea-shell {
  position: relative;
  z-index: 2;
  overflow: visible;
}

.mention-dropdown {
  z-index: 60;
  min-width: 220px;
  max-width: min(420px, calc(100% - 16px));
  max-height: min(320px, 45vh);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 6px;
  border-radius: 12px;
  border: 1px solid var(--chat-input-control-border);
  background: var(--chat-input-floating-surface);
  box-shadow: var(--chat-input-popover-shadow);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mention-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--app-text);
  cursor: pointer;
  text-align: left;
}

.mention-option:hover,
.mention-option.active {
  background: var(--app-accent-soft);
}

.mention-option-label {
  min-width: 0;
  width: 100%;
  font-size: 0.82em;
  font-weight: 600;
  color: var(--app-text-strong);
  white-space: normal;
  word-break: break-word;
}

.mention-option-token {
  width: 100%;
  font-size: 0.72em;
  color: var(--app-text-muted);
  white-space: normal;
  word-break: break-word;
}

.project-tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 40%, transparent);
  background: color-mix(in srgb, var(--app-accent) 12%, transparent);
  color: var(--app-text-soft);
}

.project-tag-chip-prefix {
  font-size: 0.82em;
}

.project-tag-chip-label {
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.8em;
  font-weight: 600;
  color: var(--app-accent);
}

.project-tag-chip-remove {
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
  line-height: 1;
  padding: 0;
}

.project-tag-chip-remove:hover {
  background: var(--chat-input-chip-remove-hover);
  color: var(--app-danger);
}

.document-tag-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px 0;
}

.code-tag-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px 0;
}

.document-tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--app-accent-glow);
  background: var(--app-accent-soft);
  color: var(--app-text-soft);
}

.document-tag-chip-prefix {
  color: var(--app-accent);
  font-weight: 700;
}

.document-tag-chip-label {
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.8em;
  font-weight: 600;
}

.document-tag-chip-remove {
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
  line-height: 1;
  padding: 0;
}

.document-tag-chip-remove:hover {
  background: var(--chat-input-chip-remove-hover);
  color: var(--app-danger);
}

.code-tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid color-mix(in srgb, var(--app-success) 38%, transparent);
  background: var(--app-success-soft);
  color: var(--app-text-soft);
}

.code-tag-chip-prefix {
  color: var(--app-success);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.72em;
  font-weight: 900;
}

.code-tag-chip-label {
  max-width: 320px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.76em;
  font-weight: 700;
}

.code-tag-chip-remove {
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
  line-height: 1;
  padding: 0;
}

.code-tag-chip-remove:hover {
  background: var(--chat-input-chip-remove-hover);
  color: var(--app-danger);
}

.input-container textarea {
  display: block;
  width: 100%;
  background: transparent;
  border: none;
  color: var(--app-text);
  min-height: 66px;
  max-height: 176px;
  padding: 13px 12px 6px;
  font-size: 0.92em;
  line-height: 1.5;
  resize: none;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.input-container textarea::-webkit-scrollbar { width: 5px; }
.input-container textarea::-webkit-scrollbar-track { background: transparent; }
.input-container textarea::-webkit-scrollbar-thumb { background: var(--app-scrollbar); border-radius: 3px; }
.input-container textarea::placeholder { color: var(--app-text-faint); }

.input-container textarea.busy {
  opacity: 0.8;
  cursor: progress;
}

.chat-input-context-menu {
  position: fixed;
  z-index: 5000;
  min-width: 120px;
  padding: 4px;
  border: 1px solid var(--app-border-strong);
  border-radius: 10px;
  background: var(--app-panel);
  box-shadow: 0 14px 36px rgba(15, 23, 42, 0.18);
}

.chat-input-context-action {
  width: 100%;
  height: 32px;
  padding: 0 12px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text-strong);
  font-size: 0.86rem;
  cursor: pointer;
  text-align: left;
}

.chat-input-context-action:hover:not(:disabled) {
  background: var(--app-panel-subtle);
}

.chat-input-context-action:disabled {
  cursor: not-allowed;
  color: var(--app-text-faint);
}

.runtime-status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 12px 4px;
  padding: 8px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-accent-soft) 72%, transparent);
  color: var(--app-accent-strong);
}

.runtime-status-bar.waitingAuth {
  background: var(--app-warning-soft);
  color: var(--app-warning-strong);
}

.runtime-status-indicator {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: currentColor;
  animation: runtime-pulse 1.2s ease-in-out infinite;
}

.runtime-status-copy {
  font-size: 0.8rem;
  font-weight: 600;
}

/* design v1.7: one left-flowing toolbar — high-frequency icons lead,
   state pills follow, the send key is pushed to the far edge. */
.input-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px 7px;
  border-top: 1px solid var(--app-border);
}

.group-inject-btn.active {
  background: color-mix(in srgb, var(--app-accent) 18%, transparent);
  color: var(--app-accent-strong);
}

.group-inject-wrapper {
  position: relative;
}

.group-inject-panel {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  width: 300px;
  max-width: 70vw;
  padding: 10px;
  border: 1px solid var(--app-border-strong, var(--app-border));
  border-radius: 10px;
  background: var(--chat-input-surface, var(--app-panel));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  z-index: 20;
  transform-origin: bottom right;
}

.group-inject-textarea {
  width: 100%;
  resize: vertical;
  min-height: 44px;
  max-height: 140px;
  padding: 8px 10px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--chat-input-bg, transparent);
  color: var(--app-text);
  font-size: 0.84em;
  line-height: 1.45;
  font-family: inherit;
}

.group-inject-textarea:focus {
  outline: none;
  border-color: var(--app-accent);
}

.group-inject-actions {
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.group-inject-feedback {
  font-size: 0.74em;
  margin-right: auto;
}
.group-inject-feedback.sent { color: var(--app-success); }
.group-inject-feedback.failed { color: var(--app-danger); }

.group-inject-submit {
  border: none;
  border-radius: 6px;
  padding: 5px 14px;
  background: var(--app-accent);
  color: var(--app-on-accent);
  font-size: 0.78em;
  font-weight: 600;
  cursor: pointer;
}
.group-inject-submit:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.advanced-drawer-enter-active,
.advanced-drawer-leave-active {
  overflow: hidden;
  transition:
    max-width 0.24s cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 0.18s ease,
    transform 0.24s cubic-bezier(0.2, 0.8, 0.2, 1),
    padding-left 0.24s cubic-bezier(0.2, 0.8, 0.2, 1),
    padding-right 0.24s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.advanced-drawer-enter-from,
.advanced-drawer-leave-to {
  max-width: 0;
  opacity: 0;
  transform: translateX(-8px) scaleX(0.96);
  padding-left: 0;
  padding-right: 0;
}

.advanced-drawer-enter-to,
.advanced-drawer-leave-from {
  max-width: 296px;
  opacity: 1;
  transform: translateX(0) scaleX(1);
}

.plan-mode-btn.active {
  color: var(--app-warning);
  background: var(--app-warning-soft);
}

.plan-mode-btn.active:hover {
  background: color-mix(in srgb, var(--app-warning) 18%, transparent);
  color: var(--app-warning-strong);
}

.auth-mode-btn.auto {
  color: var(--app-success);
  background: var(--app-success-soft);
}

.auth-mode-btn.auto:hover {
  background: color-mix(in srgb, var(--app-success) 16%, transparent);
  color: var(--app-success);
}

/* design v1.7: auth pill = breathing dot, auto green / strict amber. */
.auth-mode-btn .pill-dot {
  animation: runtime-pulse 2s ease-in-out infinite;
}

.auth-mode-btn.strict {
  color: var(--app-warning-strong);
  background: var(--app-warning-soft);
  border-color: color-mix(in srgb, var(--app-warning) 32%, var(--app-border));
}

.auth-mode-btn.strict .pill-dot {
  background: var(--app-warning);
}

.auth-mode-btn.strict:hover {
  background: color-mix(in srgb, var(--app-warning) 16%, transparent);
  color: var(--app-warning-strong);
}


.composer-skill-selector {
  position: relative;
  flex: 0 0 auto;
}

.skills-pill {
  width: auto;
  min-width: 62px;
}

.skills-pill-spark {
  color: var(--app-accent-strong);
  font-size: 0.78rem;
}

.skills-pill.active {
  color: var(--app-accent-strong);
  border-color: color-mix(in srgb, var(--app-accent) 30%, var(--app-border));
  background: var(--app-accent-soft);
}

.composer-skill-dropdown {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 30;
  width: 220px;
  max-height: min(320px, 42vh);
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--app-border-strong);
  border-radius: 10px;
  background: var(--app-panel-strong);
  box-shadow: var(--shadow-2);
}

.composer-skill-actions {
  display: flex;
  justify-content: flex-end;
  gap: 5px;
  padding: 2px 2px 6px;
  border-bottom: 1px solid var(--app-border);
}

.composer-skill-actions button,
.composer-skill-option {
  border: 0;
  background: transparent;
  color: var(--app-text-soft);
  cursor: pointer;
}

.composer-skill-actions button {
  padding: 4px 6px;
  font-size: 0.68rem;
}

.composer-skill-actions button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.composer-skill-option {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px 6px;
  border-radius: 7px;
  text-align: left;
  font-size: 0.74rem;
}

.composer-skill-option:hover,
.composer-skill-option.selected {
  background: var(--app-accent-soft);
  color: var(--app-text-strong);
}

.composer-skill-check {
  width: 15px;
  color: var(--app-accent);
  font-weight: 700;
  text-align: center;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 24px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
  transition: none;
  flex-shrink: 0;
}

.tooltip-container {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.tooltip-container .tooltip-text {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 8px);
  transform: translateX(-50%) translateY(4px);
  opacity: 0;
  pointer-events: none;
  white-space: nowrap;
  padding: 5px 9px;
  border-radius: 8px;
  font-size: 0.76em;
  line-height: 1.3;
  color: var(--app-text-soft);
  background: var(--chat-input-floating-surface);
  border: 1px solid var(--chat-input-control-border);
  box-shadow: var(--chat-input-popover-shadow);
  transition: opacity 0.16s ease, transform 0.16s ease;
  z-index: 10;
}

.tooltip-container:hover .tooltip-text,
.tooltip-container:focus-within .tooltip-text {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.tooltip-text::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -5px;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: var(--chat-input-floating-surface);
}

.action-btn:hover { background: var(--chat-input-hover-surface); color: var(--app-text); }
.action-btn.doc-btn.active,
.action-btn.folder-btn.active { color: var(--app-accent); background: var(--app-accent-soft); }
.action-btn.upload-btn { cursor: pointer; }

/* Labeled state pills (design v1.7): plan / auth / computer-use read their
   state without hover. */
.action-btn.state-pill {
  width: auto;
  height: 24px;
  padding: 0 9px;
  gap: 5px;
  border-radius: 999px;
  border: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel-strong) 60%, transparent);
  color: var(--app-text-muted);
  font-size: 0.62rem;
  font-weight: 600;
}

.action-btn.state-pill svg {
  width: 13px;
  height: 13px;
}

.pill-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--app-success);
  flex-shrink: 0;
}

.pill-dot.live {
  background: #ffffff;
  animation: runtime-pulse 1.2s ease-in-out infinite;
}

.plan-mode-btn.active {
  color: var(--app-accent-strong);
  border-color: color-mix(in srgb, var(--app-accent) 38%, var(--app-border));
  background: var(--app-accent-soft);
}

.computer-use-btn.active {
  color: var(--app-on-accent);
  border-color: transparent;
  background: var(--app-accent);
}
/* macOS permission gate: grayed out until Screen Recording + Accessibility are granted. */
.computer-use-btn.permission-locked { opacity: 0.38; cursor: not-allowed; }
.computer-use-btn.permission-locked:hover { background: transparent; color: var(--app-text-muted); }
.action-btn.disabled {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

.upload-feedback {
  margin-top: 8px;
  padding: 0 4px;
  color: var(--app-danger);
  font-size: 0.78em;
  line-height: 1.5;
}

.action-btn.send-btn {
  width: 32px;
  height: 32px;
  margin-left: auto;
  border-radius: 999px;
  background: var(--app-sig);
  color: #ffffff;
  box-shadow: 0 4px 14px color-mix(in srgb, var(--app-accent) 32%, transparent);
}

.action-btn.send-btn:hover:not(:disabled) {
  background: var(--app-sig);
  filter: none;
}

/* Running: the icon becomes a stop square, the gradient stays (design v1.7). */
.action-btn.send-btn.stopping {
  background: var(--app-sig);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--app-accent) 32%, transparent), 0 0 0 2px var(--app-accent-soft);
}

.action-btn.send-btn.stopping:hover:not(:disabled) {
  background: var(--app-sig);
  filter: none;
}

/* Waiting for authorization tints the key amber. */
.action-btn.send-btn.stopping.waitingAuth {
  background: var(--app-warning);
  box-shadow: 0 10px 24px color-mix(in srgb, var(--app-warning) 28%, transparent);
}

.action-btn.send-btn.stopping.waitingAuth:hover:not(:disabled) {
  background: var(--app-warning-strong);
  filter: none;
}

.action-btn.send-btn:disabled {
  background: var(--chat-input-disabled-surface);
  color: var(--app-text-faint);
  cursor: not-allowed;
}

@keyframes runtime-pulse {
  0%, 100% { transform: scale(0.9); opacity: 0.72; }
  50% { transform: scale(1.2); opacity: 1; }
}

@media (max-width: 860px) {
  .advanced-drawer-enter-to,
  .advanced-drawer-leave-from {
    max-width: 300px;
  }
}
</style>
