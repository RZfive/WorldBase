<script setup lang="ts">
import { computed, nextTick, ref, watch, type CSSProperties } from 'vue'
import ProviderDropdown from './ProviderDropdown.vue'
import ProviderModelDropdown from './ProviderModelDropdown.vue'

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

type ReasoningStrength = 'low' | 'medium' | 'high' | 'max'
type AIExecutionAuthMode = 'strict' | 'auto'

interface ProviderItem {
  id: string
  name: string
  models: string[]
}

interface AgentOption {
  id: string
  name: string
  icon?: string
}

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
  reasoningStrength: ReasoningStrength
  temperature?: number | null
  providerDefaultTemperature?: number
  authMode: AIExecutionAuthMode
  planModeActive: boolean
  providers?: ProviderItem[]
  activeProviderId?: string
  selectedModel?: string
  showProviderSelector?: boolean
  availableAgents?: AgentOption[]
  selectedAgentId?: string
  groupMentionHints?: GroupMentionHint[]
  isGroupConversation?: boolean
  isNewConversation?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'send'): void
  (e: 'stop'): void
  (e: 'addAttachments', files: File[]): void
  (e: 'removeImage', index: number): void
  (e: 'removeFile', id: string): void
  (e: 'update:reasoning-strength', value: ReasoningStrength): void
  (e: 'update:temperature', value: number | null): void
  (e: 'toggleDocumentDock'): void
  (e: 'update:auth-mode', value: AIExecutionAuthMode): void
  (e: 'togglePlanMode'): void
  (e: 'update:active-provider-id', id: string): void
  (e: 'update:selected-model', model: string): void
  (e: 'update:selected-agent-id', id: string): void
}>()

const DOCUMENT_TAG_PATTERN = /\[\[doc:([A-Za-z0-9_-]+)(?:\|([^\]]*))?\]\]/g
const PROJECT_TAG_PATTERN = /\[\[project:([^\]|]+)(?:\|([^\]]*))?\]\]/g

const inputFocused = ref(false)
const dragDepth = ref(0)
const dragActive = ref(false)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const activeMention = ref<MentionQueryState | null>(null)
const activeMentionIndex = ref(0)
const pendingSelection = ref<{ start: number; end: number } | null>(null)
const MAX_MENTION_DROPDOWN_HEIGHT = 320
const MIN_MENTION_DROPDOWN_HEIGHT = 120
const reasoningLevels: Array<{ value: ReasoningStrength; label: string }> = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'max', label: '最高' }
]
const currentReasoningIndex = computed(() => {
  const index = reasoningLevels.findIndex(level => level.value === props.reasoningStrength)
  return index >= 0 ? index : 1
})
const currentReasoningLabel = computed(() => {
  return reasoningLevels[currentReasoningIndex.value]?.label || '中'
})
const groupReasoningTitle = computed(() => {
  return `群聊中此处不单独调节思考强度，当前会沿用群内各 Agent 自身的思考强度配置（当前界面值：${currentReasoningLabel.value}）。`
})
const TEMPERATURE_MIN = 0
const TEMPERATURE_MAX = 2
const showAdvancedPanel = ref(false)
const isTemperatureOverridden = computed(() => typeof props.temperature === 'number' && Number.isFinite(props.temperature))
const fallbackTemperature = computed(() => {
  const value = props.providerDefaultTemperature
  return typeof value === 'number' && Number.isFinite(value) ? value : 0.3
})
const effectiveTemperature = computed(() => {
  return isTemperatureOverridden.value ? (props.temperature as number) : fallbackTemperature.value
})
function toggleAdvancedPanel () {
  showAdvancedPanel.value = !showAdvancedPanel.value
}
function onTemperatureInput (e: Event) {
  const value = Number.parseFloat((e.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  emit('update:temperature', Math.min(Math.max(value, TEMPERATURE_MIN), TEMPERATURE_MAX))
}
function resetTemperature () {
  emit('update:temperature', null)
}
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
      label: match[2]?.trim() || '文档标签',
      raw: match[0]
    })
  }

  return tags
})
const plainDraftText = computed(() => {
  return props.modelValue
    .replace(PROJECT_TAG_PATTERN, '')
    .replace(DOCUMENT_TAG_PATTERN, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\n+/, '')
})
const hasDraftContent = computed(() => {
  return props.modelValue.trim().length > 0 || props.pendingImages.length > 0 || props.pendingFiles.length > 0
})
const isSendDisabled = computed(() => props.isUploadingFiles || (!props.isLoading && !hasDraftContent.value))
const runtimeStatusLabel = computed(() => {
  if (!props.isLoading) {
    return ''
  }

  if ((props.pendingAuthCount || 0) > 0) {
    return props.pendingAuthCount === 1 ? '等待授权以继续执行' : `等待 ${props.pendingAuthCount} 项授权以继续执行`
  }

  return '执行中，请稍候'
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

function buildDraftValue (tags: DocumentTagChip[], text: string): string {
  const tagSegment = tags.map(tag => tag.raw).join(' ')
  if (tagSegment && text) return `${tagSegment}\n${text}`
  return tagSegment || text
}

function buildTaggedDraftValue (text: string): string {
  const projectSegment = projectTags.value.map(tag => tag.raw).join(' ')
  const docSegment = documentTags.value.map(tag => tag.raw).join(' ')
  const tagSegment = [projectSegment, docSegment].filter(Boolean).join(' ')
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
  const match = /(?:^|\s)@([^\s@]*)$/.exec(beforeCaret)
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
  const tagSegment = [projectSegment, docSegment].filter(Boolean).join(' ')
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
  if (files.length === 0) return

  e.preventDefault()
  emit('addAttachments', files)
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
          <button class="project-tag-chip-remove" @click="removeProjectTag(tag.projectId)" title="移除项目标签">×</button>
        </div>
      </div>
      <div v-if="documentTags.length > 0" class="document-tag-bar">
        <div v-for="tag in documentTags" :key="tag.regionId" class="document-tag-chip">
          <span class="document-tag-chip-prefix">#</span>
          <span class="document-tag-chip-label">{{ tag.label }}</span>
          <button class="document-tag-chip-remove" @click="removeDocumentTag(tag.regionId)" title="移除文档标签">×</button>
        </div>
      </div>
      <div class="textarea-shell">
        <textarea
          ref="textareaRef"
          :value="plainDraftText"
          :class="{ busy: props.isLoading }"
          placeholder="输入消息… (Enter 发送, Shift+Enter 换行)"
          :aria-busy="props.isLoading ? 'true' : 'false'"
          @input="handleTextInput"
          @keydown="handleKeydown"
          @keyup="scheduleMentionRefresh"
          @click="scheduleMentionRefresh"
          @mouseup="scheduleMentionRefresh"
          @scroll="scheduleMentionRefresh"
          @paste="handlePaste"
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
        <div class="input-actions-left">
          <!-- Advanced settings: gear opens a popover (temperature now, more later) -->
          <div class="advanced-settings-anchor">
            <div class="tooltip-container">
              <button
                class="action-btn advanced-btn"
                :class="{ active: showAdvancedPanel }"
                type="button"
                aria-label="高级设置"
                @click="toggleAdvancedPanel"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
              </button>
              <span class="tooltip-text">高级设置</span>
            </div>
            <div v-if="showAdvancedPanel" class="advanced-backdrop" @click="showAdvancedPanel = false"></div>
            <div v-if="showAdvancedPanel" class="advanced-panel">
              <div class="advanced-panel-title">高级设置</div>
              <div class="advanced-setting">
                <div class="advanced-setting-head">
                  <span class="advanced-setting-name">模型温度</span>
                  <span class="advanced-setting-value">{{ effectiveTemperature.toFixed(2) }}</span>
                </div>
                <input
                  class="advanced-slider"
                  type="range"
                  :min="TEMPERATURE_MIN"
                  :max="TEMPERATURE_MAX"
                  step="0.1"
                  :value="effectiveTemperature"
                  @input="onTemperatureInput"
                />
                <div class="advanced-slider-scale">
                  <span>精确 0</span>
                  <span>2 发散</span>
                </div>
                <div class="advanced-setting-foot">
                  <span v-if="!isTemperatureOverridden" class="advanced-setting-hint">跟随供应商默认（{{ fallbackTemperature.toFixed(2) }}）</span>
                  <template v-else>
                    <span class="advanced-setting-hint accent">仅当前会话</span>
                    <button class="advanced-reset" type="button" @click="resetTemperature">跟随供应商默认</button>
                  </template>
                </div>
              </div>
            </div>
          </div>
          <ProviderDropdown
            v-if="props.isNewConversation && props.availableAgents && props.availableAgents.length > 0"
            :model-value="props.selectedAgentId || ''"
            :options="[{ value: '', label: '默认 Agent' }, ...props.availableAgents.map(a => ({ value: a.id, label: (a.icon ? a.icon + ' ' : '') + a.name }))]"
            title="选择 Agent"
            @update:model-value="emit('update:selected-agent-id', $event)"
          />
          <template v-if="props.showProviderSelector && props.providers && props.providers.length > 0">
            <ProviderModelDropdown
              :providers="props.providers"
              :active-provider-id="props.activeProviderId"
              :selected-model="props.selectedModel"
              title="供应商 / 模型"
              @update:active-provider-id="emit('update:active-provider-id', $event)"
              @update:selected-model="emit('update:selected-model', $event)"
            />
          </template>
          <!-- Reasoning strength: segmented pill control -->
          <div class="tooltip-container reasoning-tooltip">
            <template v-if="!props.isGroupConversation">
              <div class="reasoning-segmented">
                <svg class="reasoning-icon" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                </svg>
                <button
                  v-for="level in reasoningLevels"
                  :key="level.value"
                  class="reasoning-pill"
                  :class="{ active: props.reasoningStrength === level.value }"
                  type="button"
                  @click="emit('update:reasoning-strength', level.value)"
                >{{ level.label }}</button>
              </div>
              <span class="tooltip-text">推理强度</span>
            </template>
            <template v-else>
              <div class="reasoning-group-indicator" :title="groupReasoningTitle">
                <svg class="reasoning-icon" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                </svg>
                <span>群聊沿用 Agent 思考强度</span>
              </div>
              <span class="tooltip-text">{{ groupReasoningTitle }}</span>
            </template>
          </div>
        </div>
        <div class="input-actions-right">
          <!-- Auth mode: icon toggle (lock = strict, unlock = auto) -->
          <div class="tooltip-container">
            <button
            class="action-btn auth-mode-btn"
            :class="{ auto: props.authMode === 'auto' }"
            type="button"
            @click="emit('update:auth-mode', props.authMode === 'strict' ? 'auto' : 'strict')"
          >
            <svg v-if="props.authMode === 'strict'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>
            </svg>
          </button>
          <span class="tooltip-text">{{ props.authMode === 'strict' ? '严格授权 — 执行前需人工确认' : '自动执行 — 无需人工确认' }}</span>
          </div>
          <!-- Plan mode: icon toggle -->
          <div class="tooltip-container">
            <button
              class="action-btn plan-mode-btn"
              :class="{ active: props.planModeActive }"
              type="button"
              @click="emit('togglePlanMode')"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                <polyline points="3 6 4 7 6 5"/><polyline points="3 12 4 13 6 11"/><polyline points="3 18 4 19 6 17"/>
              </svg>
            </button>
            <span class="tooltip-text">{{ props.planModeActive ? '退出规划模式' : '进入规划模式' }}</span>
          </div>
          <div class="tooltip-container">
            <button class="action-btn doc-btn" :class="{ active: props.documentDockVisible }" type="button" @click="emit('toggleDocumentDock')">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
            </button>
            <span class="tooltip-text">文档中心</span>
          </div>
          <div class="tooltip-container">
            <label class="action-btn upload-btn" :class="{ disabled: props.isLoading || props.isUploadingFiles }" :aria-disabled="props.isLoading || props.isUploadingFiles">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 115.66 5.66l-9.2 9.2a2 2 0 01-2.82-2.83l8.49-8.48"/></svg>
              <input type="file" multiple hidden :disabled="props.isLoading || props.isUploadingFiles" @change="handleAttachmentSelection" />
            </label>
            <span class="tooltip-text">添加附件</span>
          </div>
          <button
            class="action-btn send-btn"
            :class="{ stopping: props.isLoading, waitingAuth: (props.pendingAuthCount || 0) > 0 }"
            type="button"
            @click="props.isLoading ? emit('stop') : emit('send')"
            :disabled="isSendDisabled"
            :title="props.isUploadingFiles ? '文件处理中...' : (props.isLoading ? '停止生成' : '发送')"
          >
            <svg v-if="!props.isLoading" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
          </button>
        </div>
      </div>
    </div>
    <div v-if="props.uploadFeedback" class="upload-feedback" role="status">{{ props.uploadFeedback }}</div>
  </div>
</template>

<style scoped>
.chat-input {
  position: relative;
  z-index: 6;
  padding: 10px var(--chat-message-gutter, 24px) 18px;
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
  position: relative;
  background: var(--app-input-bg);
  border: 1px solid var(--app-input-border);
  border-radius: 24px;
  transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
  overflow: visible;
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.12);
}

.input-container.focused {
  border-color: var(--app-accent);
  box-shadow: 0 0 0 2px var(--app-accent-soft);
}

.input-container.dragging {
  border-color: var(--app-accent);
  box-shadow: 0 0 0 2px var(--app-accent-soft);
  background: color-mix(in srgb, var(--app-accent-soft) 26%, var(--app-input-bg));
}

.input-container.busy {
  border-color: color-mix(in srgb, var(--app-accent-glow) 72%, transparent);
  box-shadow: 0 0 0 1px rgba(91, 140, 255, 0.08), 0 18px 36px rgba(91, 140, 255, 0.08);
}

.input-container.waitingAuth {
  border-color: rgba(245, 158, 11, 0.42);
  box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.12), 0 18px 36px rgba(245, 158, 11, 0.12);
  background: color-mix(in srgb, rgba(245, 158, 11, 0.08) 32%, var(--app-input-bg));
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
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-subtle);
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
  border: 1px solid var(--app-border-strong);
}

.image-remove {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--app-danger);
  color: #ffffff;
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
  color: #ffffff;
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
  border: 1px solid var(--app-border-strong);
  background: color-mix(in srgb, var(--app-panel-strong) 92%, white 8%);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.18);
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
  background: rgba(0, 0, 0, 0.06);
  color: var(--app-danger);
}

.document-tag-bar {
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
  background: rgba(0, 0, 0, 0.06);
  color: var(--app-danger);
}

.input-container textarea {
  display: block;
  width: 100%;
  background: transparent;
  border: none;
  color: var(--app-text);
  padding: 12px 14px 4px;
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
  background: rgba(245, 158, 11, 0.14);
  color: #b45309;
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

.input-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 4px 8px 8px;
}

.input-actions-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.advanced-settings-anchor {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.action-btn.advanced-btn {
  width: 28px;
  height: 28px;
}

.action-btn.advanced-btn.active {
  color: var(--app-accent);
  background: var(--app-accent-soft);
}

.advanced-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}

.advanced-panel {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 50;
  width: 248px;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.advanced-panel-title {
  font-size: 0.74em;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--app-text-muted);
}

.advanced-setting {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.advanced-setting-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.advanced-setting-name {
  font-size: 0.82em;
  font-weight: 600;
  color: var(--app-text);
}

.advanced-setting-value {
  font-size: 0.82em;
  font-weight: 700;
  color: var(--app-accent);
  font-variant-numeric: tabular-nums;
}

.advanced-slider {
  width: 100%;
  accent-color: var(--app-accent);
  cursor: pointer;
}

.advanced-slider-scale {
  display: flex;
  justify-content: space-between;
  font-size: 0.68em;
  color: var(--app-text-faint);
}

.advanced-setting-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 18px;
}

.advanced-setting-hint {
  font-size: 0.72em;
  color: var(--app-text-muted);
}

.advanced-setting-hint.accent {
  color: var(--app-accent);
}

.advanced-reset {
  border: none;
  background: transparent;
  color: var(--app-text-muted);
  font-size: 0.72em;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 6px;
  text-decoration: underline;
}

.advanced-reset:hover {
  color: var(--app-accent);
}

.input-actions-right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.plan-mode-btn.active {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.12);
}

.plan-mode-btn.active:hover {
  background: rgba(245, 158, 11, 0.18);
  color: #d97706;
}

.reasoning-segmented {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  height: 28px;
  padding: 3px;
  border-radius: 8px;
  background: var(--app-panel-muted);
  border: 1px solid var(--app-border);
}

.reasoning-group-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  background: var(--app-panel-muted);
  border: 1px dashed var(--app-border);
  color: var(--app-text-soft);
  font-size: 0.72em;
  font-weight: 600;
  white-space: nowrap;
}

.reasoning-icon {
  color: var(--app-accent);
  margin: 0 3px 0 3px;
  flex-shrink: 0;
  opacity: 0.75;
}

.reasoning-pill {
  height: 22px;
  padding: 0 7px;
  border-radius: 5px;
  border: none;
  background: transparent;
  color: var(--app-text-muted);
  font-size: 0.72em;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
  white-space: nowrap;
  line-height: 22px;
}

.reasoning-pill:hover {
  background: color-mix(in srgb, var(--app-panel) 70%, transparent);
  color: var(--app-text);
}

.reasoning-pill.active {
  background: var(--app-accent);
  color: #ffffff;
  box-shadow: 0 1px 3px color-mix(in srgb, var(--app-accent) 45%, transparent);
}

.auth-mode-btn.auto {
  color: #22c55e;
  background: rgba(34, 197, 94, 0.1);
}

.auth-mode-btn.auto:hover {
  background: rgba(34, 197, 94, 0.16);
  color: #16a34a;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
  transition: all 0.15s;
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
  background: var(--app-panel-strong);
  border: 1px solid var(--app-border);
  box-shadow: var(--app-shadow);
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
  border-top-color: var(--app-panel-strong);
}

.action-btn:hover { background: var(--app-panel-muted); color: var(--app-text); }
.action-btn.doc-btn.active { color: var(--app-accent); background: var(--app-accent-soft); }
.action-btn.upload-btn { cursor: pointer; }
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
  background: var(--app-accent);
  color: #ffffff;
}

.action-btn.send-btn:hover:not(:disabled) { background: var(--app-accent-strong); }

.action-btn.send-btn.stopping {
  background: var(--app-danger);
  box-shadow: 0 10px 24px rgba(220, 38, 38, 0.24);
}

.action-btn.send-btn.stopping:hover:not(:disabled) {
  background: #dc2626;
}

.action-btn.send-btn.stopping.waitingAuth {
  background: #f59e0b;
  box-shadow: 0 10px 24px rgba(245, 158, 11, 0.28);
}

.action-btn.send-btn.stopping.waitingAuth:hover:not(:disabled) {
  background: #d97706;
}

.action-btn.send-btn:disabled {
  background: var(--app-panel-muted);
  color: var(--app-text-faint);
  cursor: not-allowed;
}

@keyframes runtime-pulse {
  0%, 100% { transform: scale(0.9); opacity: 0.72; }
  50% { transform: scale(1.2); opacity: 1; }
}
</style>
