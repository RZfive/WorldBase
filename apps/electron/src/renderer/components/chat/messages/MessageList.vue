<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { buildMessageBlocks, getContentExcerpt, getContentParts } from '../message-utils'
import { copyTextToClipboard } from '../export-utils'
import type { ChatMessage, GalleryImage, FilePreviewState, MessageAnnotation, MessageAnnotationLocator, QuestionAnnotationNavigationEntry, QuestionNavigationEntry } from '../types'
import MessageRow from './MessageRow.vue'
import ImageLightbox from '../media/ImageLightbox.vue'
import MermaidPreviewDialog from '../media/MermaidPreviewDialog.vue'
import QuestionOutline from './QuestionOutline.vue'

const { locale } = useI18n()

const props = defineProps<{
  messages: ChatMessage[]
  isLoading: boolean
  filePreview: FilePreviewState
  assistantIcon?: string
  assistantName?: string
  editingMessageId?: string | null
  groupMode?: boolean
}>()

const emit = defineEmits<{
  (e: 'respondAuth', requestId: string, approved: boolean): void
  (e: 'respondSudoPassword', requestId: string, password: string | null): void
  (e: 'openLink', url: string): void
  (e: 'requestEditMessage', messageId: string): void
  (e: 'forkMessage', messageId: string): void
  (e: 'submitEdit', payload: { messageId: string; text: string; mode: 'fork' | 'inplace' }): void
  (e: 'cancelEdit'): void
  (e: 'addToContext', text: string): void
  (e: 'openQuickAsk', payload: { text: string; locator?: MessageAnnotationLocator; messageId: string | null; messageIndex: number; anchor: { left: number; top: number; right: number; bottom: number } }): void
  (e: 'removeMessageAnnotation', payload: { messageId: string | null; messageIndex: number; annotationId: string }): void
  (e: 'openAnnotationThread', payload: { messageId: string | null; messageIndex: number; annotationId: string; anchor: { left: number; top: number; right: number; bottom: number } }): void
}>()

const messagesContainer = ref<HTMLElement | null>(null)
const lightboxRef = ref<InstanceType<typeof ImageLightbox> | null>(null)
const selectionToolbarRef = ref<HTMLElement | null>(null)
const collapsedThinking = reactive<Record<string, boolean>>({})
const activeMermaidPreview = ref<{ code: string } | null>(null)
const scrollTop = ref(0)
const viewportVisible = ref(false)
const autoStickEnabled = ref(true)
const nearBottom = ref(true)
const selectionCopyMenu = reactive({ visible: false, text: '', x: 0, y: 0, copied: false })
// Selection toolbar: 加入上下文 / 快速问答 — appears under a mouse selection
// inside the message list, like the right-click copy menu but committed on
// mouseup rather than contextmenu.
const selectionToolbar = reactive({
  visible: false,
  text: '',
  x: 0,
  y: 0,
  anchor: null as { left: number; top: number; right: number; bottom: number } | null,
  locator: null as MessageAnnotationLocator | null,
  messageId: null as string | null,
  messageIndex: -1
})
const galleryActive = ref(false)
let containerObserver: ResizeObserver | null = null
let programmaticScrollFrameId: number | null = null
let selectionCopyResetTimer: number | null = null
let bottomScrollScheduled = false
let bottomScrollFrameId: number | null = null
let jumpHighlightTimer: number | null = null
const highlightedMessageKey = ref<string | null>(null)

const AUTO_SCROLL_THRESHOLD = 96
const RESTORE_AUTO_SCROLL_THRESHOLD = 4
const SELECTION_COPY_MENU_WIDTH = 112
const SELECTION_COPY_MENU_HEIGHT = 40
const SELECTION_TOOLBAR_WIDTH = 188
const SELECTION_TOOLBAR_HEIGHT = 40

const dateAnchorLabel = computed(() => {
  const date = new Date()
  const dateText = new Intl.DateTimeFormat(locale.value, {
    month: 'numeric',
    day: 'numeric'
  }).format(date)
  return `${locale.value.startsWith('zh') ? '今天' : 'Today'} · ${dateText}`
})

const latestAssistantMessageIndex = computed(() => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    if (props.messages[i].role === 'assistant') return i
  }
  return -1
})

const questionEntries = computed<QuestionNavigationEntry[]>(() => {
  const entries = props.messages
    .map((message, messageIndex) => ({ message, messageIndex }))
    .filter(({ message }) => message.role === 'user')
    .map(({ message, messageIndex }) => ({
      key: message.id || `question-${messageIndex}`,
      messageIndex,
      excerpt: getContentExcerpt(message.content, 120),
      annotations: [] as QuestionAnnotationNavigationEntry[]
    }))

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex]
    const endIndex = entries[entryIndex + 1]?.messageIndex ?? props.messages.length
    for (let messageIndex = entry.messageIndex + 1; messageIndex < endIndex; messageIndex++) {
      const message = props.messages[messageIndex]
      if (message?.role !== 'assistant' || !message.annotations?.length) continue
      entry.annotations.push(...message.annotations.map(annotation => ({
        id: annotation.id,
        messageIndex,
        excerpt: getAnnotationExcerpt(annotation),
        status: getAnnotationStatus(annotation)
      })))
    }
  }
  return entries
})

function getAnnotationExcerpt (annotation: MessageAnnotation): string {
  return (annotation.locator?.exact || annotation.text).replace(/\s+/g, ' ').trim().slice(0, 72)
}

function getAnnotationStatus (annotation: MessageAnnotation): QuestionAnnotationNavigationEntry['status'] {
  if (annotation.status) return annotation.status
  return annotation.turns?.some(turn => turn.status === 'generating') ? 'generating' : 'resolved'
}

const lastMessageGrowthKey = computed(() => {
  const message = props.messages[props.messages.length - 1]
  if (!message) return ''
  const contentLength = typeof message.content === 'string'
    ? message.content.length
    : Array.isArray(message.content)
      ? message.content.reduce((total, part) => total + (part.text?.length || 0) + (part.image_url?.url?.length || 0), 0)
      : 0
  return `${contentLength}:${message.thinking?.length || 0}:${message.blocks?.length || 0}:${message.toolRuns?.length || 0}`
})

const galleryImages = computed<GalleryImage[]>(() => {
  if (!galleryActive.value) return []
  const images: GalleryImage[] = []
  props.messages.forEach((message, messageIndex) => {
    buildMessageBlocks(message, messageIndex, props.filePreview, latestAssistantMessageIndex.value, props.isLoading)
      .forEach((block, blockIndex) => {
        if (block.kind !== 'content') return
        getContentParts(block.content).forEach((part, partIndex) => {
          if (part.type === 'image_url' && part.image_url?.url) {
            images.push({ url: part.image_url.url, messageIndex, blockIndex, partIndex })
          }
        })
      })
  })
  return images
})

function getMessageKey (message: ChatMessage, index: number): string {
  return message.id || `message-${index}`
}

function toggleThinking (id: string): void {
  collapsedThinking[id] = !isThinkingCollapsed(id)
}

function isThinkingCollapsed (id: string): boolean {
  return collapsedThinking[id] !== false
}

async function openLightbox (messageIndex: number, blockIndex: number, partIndex: number): Promise<void> {
  const history = props.messages
  galleryActive.value = true
  await nextTick()
  if (props.messages === history) lightboxRef.value?.open(messageIndex, blockIndex, partIndex)
}

function closeLightbox (): void {
  galleryActive.value = false
}

function openMermaidPreview (code: string): void {
  activeMermaidPreview.value = { code }
}

function closeMermaidPreview (): void {
  activeMermaidPreview.value = null
}

function handleMessageLinkClick (event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  const link = target?.closest('a[href]') as HTMLAnchorElement | null
  if (!link || (!link.closest('.markdown-body') && !link.hasAttribute('data-chat-external'))) return
  const href = link.getAttribute('href')?.trim()
  if (!href || !/^https?:\/\//i.test(href)) return
  try {
    const url = new URL(href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return
    event.preventDefault()
    emit('openLink', url.toString())
  } catch { /* ignore malformed links */ }
}

function hideSelectionCopyMenu (): void {
  selectionCopyMenu.visible = false
  selectionCopyMenu.copied = false
}

function getChatSelectionText (): string {
  const selection = window.getSelection()
  const container = messagesContainer.value
  if (!selection || selection.isCollapsed || !container) return ''
  const text = selection.toString().trim()
  if (!text) return ''
  for (let index = 0; index < selection.rangeCount; index++) {
    if (selection.getRangeAt(index).intersectsNode(container)) return text
  }
  return ''
}

function positionSelectionCopyMenu (event: MouseEvent): void {
  selectionCopyMenu.x = Math.max(8, Math.min(event.clientX, window.innerWidth - SELECTION_COPY_MENU_WIDTH - 8))
  selectionCopyMenu.y = Math.max(8, Math.min(event.clientY, window.innerHeight - SELECTION_COPY_MENU_HEIGHT - 8))
}

function handleSelectionContextMenu (event: MouseEvent): void {
  const selectedText = getChatSelectionText()
  if (!selectedText) {
    hideSelectionCopyMenu()
    return
  }
  event.preventDefault()
  positionSelectionCopyMenu(event)
  selectionCopyMenu.text = selectedText
  selectionCopyMenu.visible = true
  selectionCopyMenu.copied = false
}

function handleDocumentSelectionChange (): void {
  if (!getChatSelectionText()) {
    hideSelectionCopyMenu()
    hideSelectionToolbar()
  }
}

async function copySelectedText (): Promise<void> {
  if (!selectionCopyMenu.text) return
  try {
    await copyTextToClipboard(selectionCopyMenu.text)
    selectionCopyMenu.copied = true
    if (selectionCopyResetTimer != null) window.clearTimeout(selectionCopyResetTimer)
    selectionCopyResetTimer = window.setTimeout(() => {
      hideSelectionCopyMenu()
      selectionCopyResetTimer = null
    }, 700)
  } catch (error) {
    console.error('Failed to copy selected message text:', error)
    hideSelectionCopyMenu()
  }
}

function hideSelectionToolbar (): void {
  selectionToolbar.visible = false
  selectionToolbar.text = ''
  selectionToolbar.messageId = null
  selectionToolbar.messageIndex = -1
  selectionToolbar.locator = null
}

/** Message element that owns the current selection anchor, if any. */
function resolveSelectionMessageAnchor (): HTMLElement | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const anchorNode = selection.anchorNode
  const element = anchorNode?.nodeType === Node.TEXT_NODE ? anchorNode.parentElement : anchorNode as HTMLElement | null
  return element?.closest('[data-message-index]') as HTMLElement | null
}

function normalizeAnnotationText (text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Return a normalized text offset for a DOM range inside one content block. */
function getNormalizedRangeOffset (root: HTMLElement, container: Node, offset: number): number {
  try {
    const before = document.createRange()
    before.selectNodeContents(root)
    before.setEnd(container, offset)
    return normalizeAnnotationText(before.toString()).length
  } catch {
    return 0
  }
}

function buildSelectionLocator (selectedText: string, selection: Selection, blockRoot: HTMLElement | null): MessageAnnotationLocator | undefined {
  if (!blockRoot || selection.rangeCount === 0) return undefined
  const range = selection.getRangeAt(0)
  const exact = normalizeAnnotationText(selectedText)
  if (!exact) return undefined
  const blockText = normalizeAnnotationText(blockRoot.textContent || '')
  const rawStart = getNormalizedRangeOffset(blockRoot, range.startContainer, range.startOffset)
  const startOffset = Math.max(0, Math.min(rawStart, blockText.length))
  const endOffset = Math.max(startOffset, Math.min(startOffset + exact.length, blockText.length))
  const contextLength = 48
  const rawBlockIndex = Number.parseInt(blockRoot.closest('[data-block-index]')?.getAttribute('data-block-index') || '', 10)
  return {
    version: 1,
    exact,
    prefix: blockText.slice(Math.max(0, startOffset - contextLength), startOffset),
    suffix: blockText.slice(endOffset, endOffset + contextLength),
    blockIndex: Number.isFinite(rawBlockIndex) ? rawBlockIndex : undefined,
    startOffset,
    endOffset,
    status: 'resolved'
  }
}

function showSelectionToolbar (event?: MouseEvent): void {
  // Right-button release belongs to the context menu, not this toolbar.
  if (event && event.button !== 0) return
  const text = getChatSelectionText()
  if (!text) {
    hideSelectionToolbar()
    return
  }
  const selection = window.getSelection()
  const container = messagesContainer.value
  if (!selection || selection.rangeCount === 0 || !container) {
    hideSelectionToolbar()
    return
  }

  const rect = selection.getRangeAt(0).getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) {
    hideSelectionToolbar()
    return
  }

  const messageAnchor = resolveSelectionMessageAnchor()
  const blockRoot = (selection.anchorNode?.nodeType === Node.TEXT_NODE
    ? selection.anchorNode.parentElement
    : selection.anchorNode as HTMLElement | null)?.closest('.message-text') as HTMLElement | null
  selectionToolbar.text = text
  selectionToolbar.anchor = rect.toJSON()
  selectionToolbar.messageId = messageAnchor?.getAttribute('data-message-id') || null
  selectionToolbar.messageIndex = messageAnchor
    ? Number.parseInt(messageAnchor.getAttribute('data-message-index') || '', 10)
    : -1
  if (Number.isNaN(selectionToolbar.messageIndex)) selectionToolbar.messageIndex = -1
  selectionToolbar.locator = buildSelectionLocator(text, selection, blockRoot) || null

  const centerX = rect.left + rect.width / 2
  selectionToolbar.x = Math.max(8, Math.min(centerX - SELECTION_TOOLBAR_WIDTH / 2, window.innerWidth - SELECTION_TOOLBAR_WIDTH - 8))
  const belowY = rect.bottom + 8
  if (belowY + SELECTION_TOOLBAR_HEIGHT > window.innerHeight - 8 && rect.top - SELECTION_TOOLBAR_HEIGHT - 8 > 8) {
    selectionToolbar.y = rect.top - SELECTION_TOOLBAR_HEIGHT - 8
  } else {
    selectionToolbar.y = belowY
  }
  selectionToolbar.visible = true
}

function addSelectionToContext (): void {
  const text = selectionToolbar.text
  hideSelectionToolbar()
  window.getSelection()?.removeAllRanges()
  if (text) emit('addToContext', text)
}

function openQuickAskForSelection (): void {
  const { text, locator, anchor, messageId, messageIndex } = selectionToolbar
  hideSelectionToolbar()
  window.getSelection()?.removeAllRanges()
  if (text && anchor) emit('openQuickAsk', { text, locator: locator || undefined, messageId, messageIndex, anchor })
}

// Hide the toolbar on the NEXT press outside it — mousedown, not click, so the
// click that follows the selecting gesture can't immediately dismiss it.
function handleGlobalMousedown (event: MouseEvent): void {
  if (!selectionToolbar.visible) return
  const target = event.target as Node | null
  if (selectionToolbarRef.value && target && selectionToolbarRef.value.contains(target)) return
  hideSelectionToolbar()
}

function handleGlobalKeydown (event: KeyboardEvent): void {
  if (event.key === 'Escape' && selectionToolbar.visible) hideSelectionToolbar()
}

function hasVisibleViewport (): boolean {
  const element = messagesContainer.value
  return Boolean(element && element.clientHeight > 0 && element.clientWidth > 0 && document.visibilityState !== 'hidden')
}

function isNearBottom (element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= AUTO_SCROLL_THRESHOLD
}

function isAtBottom (element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= RESTORE_AUTO_SCROLL_THRESHOLD
}

function syncViewportState (): void {
  const element = messagesContainer.value
  if (!element || !hasVisibleViewport()) {
    viewportVisible.value = false
    return
  }
  viewportVisible.value = true
  scrollTop.value = element.scrollTop
  nearBottom.value = isNearBottom(element)
}

function markProgrammaticScroll (): void {
  if (programmaticScrollFrameId != null) window.cancelAnimationFrame(programmaticScrollFrameId)
  programmaticScrollFrameId = window.requestAnimationFrame(() => {
    programmaticScrollFrameId = null
  })
}

function setContainerScrollTop (element: HTMLElement, top: number): void {
  if (!hasVisibleViewport()) return
  markProgrammaticScroll()
  element.scrollTop = top
  scrollTop.value = element.scrollTop
  nearBottom.value = isNearBottom(element)
}

function flushScrollToBottom (): void {
  bottomScrollScheduled = false
  bottomScrollFrameId = null
  const element = messagesContainer.value
  if (!element || !hasVisibleViewport()) return
  setContainerScrollTop(element, element.scrollHeight)
  nearBottom.value = true
  autoStickEnabled.value = true
}

function scrollToBottom (): void {
  if (!hasVisibleViewport() || bottomScrollScheduled) return
  bottomScrollScheduled = true
  nextTick(() => {
    if (!bottomScrollScheduled) return
    bottomScrollFrameId = window.requestAnimationFrame(flushScrollToBottom)
  })
}

function handleScroll (): void {
  hideSelectionCopyMenu()
  hideSelectionToolbar()
  const element = messagesContainer.value
  if (!element) return
  if (!viewportVisible.value) {
    syncViewportState()
    return
  }
  const movingUp = element.scrollTop < scrollTop.value
  syncViewportState()
  if (movingUp) autoStickEnabled.value = false
  else if (isAtBottom(element)) autoStickEnabled.value = true
}

function handleWheel (event: WheelEvent): void {
  hideSelectionCopyMenu()
  hideSelectionToolbar()
  if (event.deltaY < 0) autoStickEnabled.value = false
}

function jumpToMessageIndex (payload: { messageIndex: number; annotationId?: string }): void {
  const index = payload.messageIndex
  const element = messagesContainer.value
  const message = props.messages[index]
  if (!element || !message) return
  const target = element.querySelector<HTMLElement>(`[data-message-index="${index}"]`)
  if (!target) return
  autoStickEnabled.value = false
  setContainerScrollTop(element, Math.max(0, target.offsetTop - 24))
  highlightedMessageKey.value = getMessageKey(message, index)
  if (jumpHighlightTimer != null) window.clearTimeout(jumpHighlightTimer)
  jumpHighlightTimer = window.setTimeout(() => {
    highlightedMessageKey.value = null
    jumpHighlightTimer = null
  }, 1500)

  if (!payload.annotationId) return
  nextTick(() => {
    const mark = element.querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(payload.annotationId!)}"]`)
    if (!mark) return
    const containerRect = element.getBoundingClientRect()
    const markRect = mark.getBoundingClientRect()
    setContainerScrollTop(element, element.scrollTop + markRect.top - containerRect.top - element.clientHeight / 2 + markRect.height / 2)
    mark.classList.add('outline-navigation-focus')
    window.setTimeout(() => mark.classList.remove('outline-navigation-focus'), 1200)
    const annotation = message.annotations?.find(item => item.id === payload.annotationId)
    if (!annotation) return
    nextTick(() => emit('openAnnotationThread', {
      messageId: message.id || null,
      messageIndex: index,
      annotationId: annotation.id,
      anchor: mark.getBoundingClientRect().toJSON()
    }))
  })
}

watch(
  () => props.isLoading,
  (loading, wasLoading) => {
    if (!loading && wasLoading) {
      const lastIndex = props.messages.length - 1
      const last = lastIndex >= 0 ? props.messages[lastIndex] : null
      if (last?.role === 'assistant') {
        buildMessageBlocks(last, lastIndex, props.filePreview, latestAssistantMessageIndex.value, false)
          .forEach(block => {
            if (block.kind === 'thinking') collapsedThinking[block.id] = true
          })
      }
    }
  }
)

watch(
  () => props.messages,
  (messages, previous) => {
    if (messages !== previous) {
      closeLightbox()
      syncViewportState()
      if (autoStickEnabled.value) nextTick(scrollToBottom)
    }
  }
)

watch(
  () => props.messages.length,
  () => {
    if (autoStickEnabled.value) nextTick(scrollToBottom)
  }
)

watch(lastMessageGrowthKey, () => {
  if (autoStickEnabled.value) nextTick(scrollToBottom)
})

watch(
  () => [props.filePreview.active, props.filePreview.filePath],
  () => {
    if (autoStickEnabled.value) nextTick(scrollToBottom)
  }
)

onMounted(() => {
  document.addEventListener('click', hideSelectionCopyMenu)
  document.addEventListener('selectionchange', handleDocumentSelectionChange)
  document.addEventListener('visibilitychange', syncViewportState)
  window.addEventListener('blur', hideSelectionCopyMenu)
  window.addEventListener('blur', hideSelectionToolbar)
  document.addEventListener('mousedown', handleGlobalMousedown)
  document.addEventListener('keydown', handleGlobalKeydown)
  syncViewportState()
  if (props.messages.length > 0) nextTick(scrollToBottom)
  if (typeof ResizeObserver !== 'undefined' && messagesContainer.value) {
    containerObserver = new ResizeObserver(() => {
      syncViewportState()
    })
    containerObserver.observe(messagesContainer.value)
  }
})

onUnmounted(() => {
  document.removeEventListener('click', hideSelectionCopyMenu)
  document.removeEventListener('selectionchange', handleDocumentSelectionChange)
  document.removeEventListener('visibilitychange', syncViewportState)
  window.removeEventListener('blur', hideSelectionCopyMenu)
  window.removeEventListener('blur', hideSelectionToolbar)
  document.removeEventListener('mousedown', handleGlobalMousedown)
  document.removeEventListener('keydown', handleGlobalKeydown)
  if (selectionCopyResetTimer != null) window.clearTimeout(selectionCopyResetTimer)
  if (programmaticScrollFrameId != null) window.cancelAnimationFrame(programmaticScrollFrameId)
  if (bottomScrollFrameId != null) window.cancelAnimationFrame(bottomScrollFrameId)
  if (jumpHighlightTimer != null) window.clearTimeout(jumpHighlightTimer)
  containerObserver?.disconnect()
  containerObserver = null
})
</script>

<template>
  <div class="message-list-shell">
    <QuestionOutline
      v-if="questionEntries.length > 0"
      :questions="questionEntries"
      @jump="jumpToMessageIndex"
    />
    <div
      ref="messagesContainer"
      class="chat-messages"
      @scroll.passive="handleScroll"
      @wheel.capture.passive="handleWheel"
      @click.capture="handleMessageLinkClick"
      @contextmenu="handleSelectionContextMenu"
      @mouseup="showSelectionToolbar"
    >
      <div v-if="props.messages.length === 0" class="empty-state">
        <slot name="empty">
          <div class="empty-state-card">
            <div class="empty-state-icon">AI</div>
            <h3>{{ $t('chatUi.emptyChatTitle') }}</h3>
            <p>{{ $t('chatUi.emptyChatHint') }}</p>
            <ul>
              <li>{{ $t('chatUi.emptyChatIdeaCreateWebApp') }}</li>
              <li>{{ $t('chatUi.emptyChatIdeaModifyProject') }}</li>
              <li>{{ $t('chatUi.emptyChatIdeaAnalyzeData') }}</li>
              <li>{{ $t('chatUi.emptyChatIdeaDebugApi') }}</li>
            </ul>
          </div>
        </slot>
      </div>
      <template v-else>
        <div v-if="props.messages.length > 0" class="message-date-divider" aria-hidden="true">
          <span>{{ dateAnchorLabel }}</span>
        </div>
        <div
          v-for="(msg, index) in props.messages"
          :key="getMessageKey(msg, index)"
          class="message-item"
          :data-message-index="index"
          :data-message-id="msg.id || null"
          :class="{ 'with-leading-gap': index > 0, 'jump-highlight': getMessageKey(msg, index) === highlightedMessageKey }"
        >
          <MessageRow
            :msg="msg"
            :index="index"
            :is-loading="props.isLoading"
            :latest-assistant-message-index="latestAssistantMessageIndex"
            :file-preview="props.filePreview"
            :collapsed-thinking="collapsedThinking"
            :assistant-icon="props.assistantIcon"
            :assistant-name="props.assistantName"
            :editing-message-id="props.editingMessageId"
            @respond-auth="(requestId, approved) => emit('respondAuth', requestId, approved)"
            @respond-sudo-password="(requestId, password) => emit('respondSudoPassword', requestId, password)"
            @toggle-thinking="toggleThinking"
            @open-lightbox="(mi, bi, pi) => openLightbox(mi, bi, pi)"
            @open-mermaid-preview="openMermaidPreview"
            @request-edit-message="(messageId) => emit('requestEditMessage', messageId)"
            @fork-message="(messageId) => emit('forkMessage', messageId)"
            @submit-edit="(payload) => emit('submitEdit', payload)"
            @cancel-edit="() => emit('cancelEdit')"
            @remove-annotation="(annotationId) => emit('removeMessageAnnotation', { messageId: msg.id || null, messageIndex: index, annotationId })"
            @open-annotation-thread="({ annotationId, anchor }) => emit('openAnnotationThread', { messageId: msg.id || null, messageIndex: index, annotationId, anchor })"
          />
        </div>
      </template>

      <ImageLightbox v-if="galleryActive" ref="lightboxRef" :images="galleryImages" @close="closeLightbox" />
      <MermaidPreviewDialog :diagram="activeMermaidPreview" @close="closeMermaidPreview" />

      <Teleport to="body">
        <div
          v-if="selectionToolbar.visible"
          ref="selectionToolbarRef"
          class="message-selection-toolbar"
          :style="{ left: `${selectionToolbar.x}px`, top: `${selectionToolbar.y}px` }"
          @mousedown.prevent
          @click.stop
          @contextmenu.prevent
        >
          <button class="message-selection-toolbar-action" type="button" @click.stop="addSelectionToContext">
            {{ $t('chatUi.addToContext') }}
          </button>
          <span class="message-selection-toolbar-divider" aria-hidden="true"></span>
          <button class="message-selection-toolbar-action" type="button" @click.stop="openQuickAskForSelection">
            {{ $t('chatUi.quickAskAction') }}
          </button>
        </div>
        <div
          v-if="selectionCopyMenu.visible"
          class="message-selection-copy-menu"
          :style="{ left: `${selectionCopyMenu.x}px`, top: `${selectionCopyMenu.y}px` }"
          @mousedown.prevent
          @click.stop
          @contextmenu.prevent
        >
          <button class="message-selection-copy-action" type="button" @click.stop="copySelectedText">
            {{ selectionCopyMenu.copied ? $t('chatUi.copied') : $t('chatUi.copy') }}
          </button>
        </div>
      </Teleport>
    </div>
  </div>
</template>

<style scoped>
.message-list-shell {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: calc(17px + var(--chat-header-height, 0px)) var(--chat-message-gutter, 27px) calc(8px + var(--chat-input-overlap, 0px));
  scrollbar-gutter: stable;
  overscroll-behavior-y: contain;
  overflow-anchor: none;
  position: relative;
}

.message-date-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 0 4px;
  color: var(--app-text-faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.68rem;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.message-date-divider::before,
.message-date-divider::after {
  content: '';
  height: 1px;
  flex: 1;
  background: var(--app-border);
}

.message-item.with-leading-gap {
  margin-top: 15px;
}

.message-item.jump-highlight {
  border-radius: 14px;
  outline: 2px solid color-mix(in srgb, var(--app-accent) 55%, transparent);
  outline-offset: 4px;
  animation: jump-highlight-fade 1.5s ease forwards;
}

@keyframes jump-highlight-fade {
  0%, 55% {
    outline-color: color-mix(in srgb, var(--app-accent) 55%, transparent);
  }
  100% {
    outline-color: transparent;
  }
}

.message-spacer {
  width: 100%;
  flex: 0 0 auto;
}

.message-selection-copy-menu {
  position: fixed;
  z-index: 5000;
  padding: 4px;
  border: 1px solid var(--app-border-strong);
  border-radius: 10px;
  background: var(--app-panel);
  box-shadow: 0 14px 36px rgba(15, 23, 42, 0.18);
}

.message-selection-toolbar {
  position: fixed;
  z-index: 5000;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--app-border-strong);
  border-radius: 10px;
  background: var(--app-panel);
  box-shadow: 0 14px 36px rgba(15, 23, 42, 0.18);
}

.message-selection-toolbar-action {
  height: 32px;
  padding: 0 12px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text-strong);
  font-size: 0.84rem;
  white-space: nowrap;
  cursor: pointer;
  text-align: left;
}

.message-selection-toolbar-action:hover {
  background: var(--app-panel-subtle);
}

.message-selection-toolbar-divider {
  width: 1px;
  height: 18px;
  background: var(--app-border);
}

.message-selection-copy-action {
  height: 32px;
  min-width: 96px;
  padding: 0 14px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text-strong);
  font-size: 0.86rem;
  cursor: pointer;
  text-align: left;
}

.message-selection-copy-action:hover {
  background: var(--app-panel-subtle);
}

.empty-state {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 0;
}

.empty-state-card {
  width: min(720px, 100%);
  padding: 28px 30px;
  border-radius: 24px;
  border: 1px solid var(--app-border-strong);
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  box-shadow: var(--app-shadow);
  color: var(--app-text);
}

.empty-state-icon {
  width: 48px;
  height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  background: linear-gradient(135deg, var(--app-accent), var(--app-accent-strong));
  color: #ffffff;
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.empty-state-card h3 {
  margin: 18px 0 8px;
  color: var(--app-text-strong);
}

.empty-state-card p {
  margin: 0;
  color: var(--app-text-muted);
  line-height: 1.7;
}

.empty-state-card ul {
  margin: 18px 0 0;
  padding-left: 1.25rem;
  color: var(--app-text-soft);
  line-height: 1.8;
}

@media (max-width: 860px) {
  .chat-messages {
    padding: calc(20px + var(--chat-header-height, 0px)) 16px calc(8px + var(--chat-input-overlap, 0px));
  }

  .empty-state-card {
    width: min(100%, 640px);
  }
}
</style>
