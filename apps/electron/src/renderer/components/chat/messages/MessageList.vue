<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { buildMessageBlocks, getContentParts, getContentText } from '../message-utils'
import { copyTextToClipboard } from '../export-utils'
import type { ChatMessage, GalleryImage, FilePreviewState, MinimapRow } from '../types'
import MessageRow from './MessageRow.vue'
import MessageMinimap from './MessageMinimap.vue'
import ImageLightbox from '../media/ImageLightbox.vue'
import MermaidPreviewDialog from '../media/MermaidPreviewDialog.vue'

const props = defineProps<{
  messages: ChatMessage[]
  isLoading: boolean
  filePreview: FilePreviewState
  assistantIcon?: string
  assistantName?: string
  editingMessageId?: string | null
  /** Group (multi-agent) conversation: minimap always shows + carries the group badge. */
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
}>()

const messagesContainer = ref<HTMLElement | null>(null)
const lightboxRef = ref<InstanceType<typeof ImageLightbox> | null>(null)
const collapsedThinking = reactive<Record<string, boolean>>({})
const activeMermaidPreview = ref<{ code: string } | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(0)
const autoStickEnabled = ref(true)
const nearBottom = ref(true)
const measuredMessageHeights = reactive<Record<string, number>>({})
const messageKeyMap = new WeakMap<ChatMessage, string>()
const estimatedMessageHeights = new Map<string, number>()
const messageObservers = new Map<string, ResizeObserver>()
const messageElements = new Map<string, HTMLElement>()
const selectionCopyMenu = reactive({
  visible: false,
  text: '',
  x: 0,
  y: 0,
  copied: false
})
let containerObserver: ResizeObserver | null = null
let isProgrammaticScrolling = false
let programmaticScrollFrameId: number | null = null
let selectionCopyResetTimer: number | null = null
let nextMessageKeyId = 0
let measuredHeightTotal = 0
let measuredHeightCount = 0

let pendingAnchorDelta = 0
let anchorFlushScheduled = false
let anchorFrameId: number | null = null
let bottomScrollScheduled = false
let bottomScrollFrameId: number | null = null

const OVERSCAN_COUNT = 4
const MESSAGE_GAP = 20
const FALLBACK_ESTIMATED_HEIGHT = 220
const AUTO_SCROLL_THRESHOLD = 96
const RESTORE_AUTO_SCROLL_THRESHOLD = 4
const SELECTION_COPY_MENU_WIDTH = 112
const SELECTION_COPY_MENU_HEIGHT = 40

const latestAssistantMessageIndex = computed(() => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    if (props.messages[i].role === 'assistant') return i
  }
  return -1
})

const galleryImages = computed<GalleryImage[]>(() => {
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

function toggleThinking (id: string): void {
  collapsedThinking[id] = !isThinkingCollapsed(id)
}

function isThinkingCollapsed (id: string): boolean {
  return collapsedThinking[id] !== false
}

function openLightbox (messageIndex: number, blockIndex: number, partIndex: number) {
  lightboxRef.value?.open(messageIndex, blockIndex, partIndex)
}

function openMermaidPreview (code: string) {
  activeMermaidPreview.value = { code }
}

function closeMermaidPreview () {
  activeMermaidPreview.value = null
}

function handleMessageLinkClick (event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  const link = target?.closest('a[href]') as HTMLAnchorElement | null
  if (!link || (!link.closest('.markdown-body') && !link.hasAttribute('data-chat-external'))) return

  const href = link.getAttribute('href')?.trim()
  if (!href || !/^https?:\/\//i.test(href)) return

  let url: URL
  try {
    url = new URL(href)
  } catch {
    return
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  event.preventDefault()
  emit('openLink', url.toString())
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
    const range = selection.getRangeAt(index)
    if (range.intersectsNode(container)) return text
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
  if (!getChatSelectionText()) hideSelectionCopyMenu()
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

function markProgrammaticScroll (): void {
  isProgrammaticScrolling = true
  if (programmaticScrollFrameId != null) {
    window.cancelAnimationFrame(programmaticScrollFrameId)
  }
  programmaticScrollFrameId = window.requestAnimationFrame(() => {
    isProgrammaticScrolling = false
    programmaticScrollFrameId = null
  })
}

function setContainerScrollTop (element: HTMLElement, top: number): void {
  markProgrammaticScroll()
  element.scrollTop = top
  scrollTop.value = element.scrollTop
  nearBottom.value = isNearBottom(element)
}

function flushScrollToBottom (): void {
  bottomScrollScheduled = false
  bottomScrollFrameId = null
  if (!messagesContainer.value) return

  setContainerScrollTop(messagesContainer.value, messagesContainer.value.scrollHeight)
  nearBottom.value = true
  autoStickEnabled.value = true
}

function scrollToBottom () {
  if (bottomScrollScheduled) return
  bottomScrollScheduled = true
  nextTick(() => {
    if (!bottomScrollScheduled) return
    bottomScrollFrameId = window.requestAnimationFrame(flushScrollToBottom)
  })
}

function isNearBottom (element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= AUTO_SCROLL_THRESHOLD
}

function isAtBottom (element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= RESTORE_AUTO_SCROLL_THRESHOLD
}

function syncViewportMetrics (): void {
  if (!messagesContainer.value) return
  scrollTop.value = messagesContainer.value.scrollTop
  viewportHeight.value = messagesContainer.value.clientHeight
  readContainerPaddings()
  readMinimapTrackWidth()
  nearBottom.value = isNearBottom(messagesContainer.value)
}

/** Resolved container paddings, so minimap ratios map onto the real scroll extent. */
const containerPaddings = ref({ top: 0, bottom: 0 })

function readContainerPaddings (): void {
  const element = messagesContainer.value
  if (!element) return
  const style = window.getComputedStyle(element)
  const next = {
    top: Number.parseFloat(style.paddingTop) || 0,
    bottom: Number.parseFloat(style.paddingBottom) || 0
  }
  if (next.top !== containerPaddings.value.top || next.bottom !== containerPaddings.value.bottom) {
    containerPaddings.value = next
  }
}

function handleScroll (): void {
  hideSelectionCopyMenu()
  if (!messagesContainer.value) return
  if (isProgrammaticScrolling) {
    syncViewportMetrics()
    return
  }
  const movingUp = messagesContainer.value.scrollTop < scrollTop.value
  syncViewportMetrics()

  if (movingUp) {
    autoStickEnabled.value = false
    return
  }

  if (isAtBottom(messagesContainer.value)) {
    autoStickEnabled.value = true
  }
}

function handleWheel (event: WheelEvent): void {
  hideSelectionCopyMenu()
  if (!messagesContainer.value) return
  if (event.deltaY < 0 && messagesContainer.value.scrollHeight > messagesContainer.value.clientHeight) {
    autoStickEnabled.value = false
  }
}

function getCurrentEstimatedHeight (): number {
  if (measuredHeightCount === 0) return FALLBACK_ESTIMATED_HEIGHT
  return Math.max(Math.ceil(measuredHeightTotal / measuredHeightCount), 1)
}

function getMessageKey (index: number): string {
  const message = props.messages[index]
  if (!message) return `missing-${index}`

  const existing = messageKeyMap.get(message)
  if (existing) return existing

  const key = `message-${++nextMessageKeyId}`
  messageKeyMap.set(message, key)
  return key
}

function getIndexForMessageKey (rowKey: string): number {
  for (let i = 0; i < props.messages.length; i++) {
    if (getMessageKey(i) === rowKey) return i
  }
  return -1
}

function getAssignedEstimatedHeight (rowKey: string): number {
  const existing = estimatedMessageHeights.get(rowKey)
  if (existing != null) return existing

  const estimatedHeight = getCurrentEstimatedHeight()
  estimatedMessageHeights.set(rowKey, estimatedHeight)
  return estimatedHeight
}

function getMessageHeight (index: number): number {
  const rowKey = getMessageKey(index)
  return measuredMessageHeights[rowKey] ?? getAssignedEstimatedHeight(rowKey)
}

function getMessageExtent (index: number): number {
  return getMessageHeight(index) + (index > 0 ? MESSAGE_GAP : 0)
}

const messageOffsets = computed(() => {
  const offsets: number[] = [0]
  let total = 0
  for (let i = 0; i < props.messages.length; i++) {
    total += getMessageExtent(i)
    offsets.push(total)
  }
  return offsets
})

function getOffsetBefore (index: number): number {
  const safeIndex = Math.max(0, Math.min(index, props.messages.length))
  return messageOffsets.value[safeIndex] ?? 0
}

const totalContentHeight = computed(() => messageOffsets.value[props.messages.length] ?? 0)

function findStartIndex (offsets: number[], targetTop: number): number {
  const messageCount = props.messages.length
  let low = 0
  let high = messageCount - 1

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if ((offsets[mid + 1] ?? 0) < targetTop) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  return low
}

const visibleRange = computed(() => {
  const messageCount = props.messages.length
  if (messageCount === 0) {
    return { start: 0, end: -1 }
  }

  const offsets = messageOffsets.value
  const viewportBottom = scrollTop.value + Math.max(viewportHeight.value, 1)
  const start = findStartIndex(offsets, scrollTop.value)

  let end = start
  let visibleBottom = offsets[start] ?? 0
  while (end < messageCount && visibleBottom < viewportBottom) {
    visibleBottom = offsets[end + 1] ?? visibleBottom + getMessageExtent(end)
    end++
  }

  return {
    start: Math.max(0, start - OVERSCAN_COUNT),
    end: Math.min(messageCount - 1, Math.max(start, end - 1) + OVERSCAN_COUNT)
  }
})

const virtualRows = computed(() => {
  if (visibleRange.value.end < visibleRange.value.start) return []
  return props.messages
    .slice(visibleRange.value.start, visibleRange.value.end + 1)
    .map((msg, offset) => ({
      msg,
      index: visibleRange.value.start + offset,
      key: getMessageKey(visibleRange.value.start + offset)
    }))
})

const topSpacerHeight = computed(() => getOffsetBefore(visibleRange.value.start))
const bottomSpacerHeight = computed(() => {
  if (visibleRange.value.end < visibleRange.value.start) return 0
  return Math.max(0, totalContentHeight.value - getOffsetBefore(visibleRange.value.end + 1))
})

// --- Minimap (PRD R9): scaled 1:1 conversation preview for quick navigation ---

/** Group chat detection: panel flag, or group content blocks in the history. */
const isGroupChat = computed(() => {
  if (props.groupMode === true) return true
  return props.messages.some(message =>
    Array.isArray(message.blocks) && message.blocks.some(block => block.kind.startsWith('group_'))
  )
})

/** Any conversation that overflows the screen gets the minimap. */
const minimapVisible = computed(() => {
  return totalContentHeight.value > Math.max(viewportHeight.value, 1)
})

/** Real scrollable extent: content plus resolved paddings, matching the container's scrollHeight. */
const minimapTotalHeight = computed(() => {
  return containerPaddings.value.top + totalContentHeight.value + containerPaddings.value.bottom
})

const minimapRows = computed<MinimapRow[]>(() => {
  const padTop = containerPaddings.value.top
  const mounted = minimapMountedIndexes.value
  let userOrdinal = 0

  return props.messages.map((message, index) => {
    const isUser = message.role === 'user'
    if (isUser) userOrdinal += 1
    const excerpt = getContentText(message.content)
    return {
      key: getMessageKey(index),
      messageIndex: index,
      role: isUser ? 'user' as const : 'assistant' as const,
      offsetPx: padTop + getOffsetBefore(index),
      extentPx: getMessageExtent(index),
      excerpt: excerpt.slice(0, 80),
      ordinal: isUser ? userOrdinal : undefined,
      isEditing: isUser && Boolean(message.id) && message.id === props.editingMessageId,
      mounted: mounted.has(index)
    }
  })
})

/**
 * Progressive mounting of the REAL row renders inside the minimap (1:1 reuse
 * of MessageRow + all block components, uniformly scaled). The viewport
 * neighborhood mounts immediately; the rest fills in during browser idle time
 * in small batches so a long history never blocks the UI thread. Conversations
 * beyond the cap keep lightweight stripes for the far tail.
 */
const MINIMAP_MAX_MOUNTED_ROWS = 300
const minimapMountedIndexes = ref<Set<number>>(new Set())
let minimapMountIdleId: number | null = null
let minimapMountQueue: number[] = []

function rebuildMinimapMountQueue (): void {
  const mounted = minimapMountedIndexes.value
  const center = Math.floor((visibleRange.value.start + visibleRange.value.end) / 2)
  const indexes: number[] = []
  for (let i = 0; i < props.messages.length; i++) {
    if (!mounted.has(i)) indexes.push(i)
  }
  // Priority: closest to the current viewport first.
  indexes.sort((a, b) => Math.abs(a - center) - Math.abs(b - center))
  minimapMountQueue = indexes.slice(0, Math.max(0, MINIMAP_MAX_MOUNTED_ROWS - mounted.size))
}

function mountMinimapRows (indexes: number[]): void {
  if (indexes.length === 0) return
  const next = new Set(minimapMountedIndexes.value)
  for (const index of indexes) next.add(index)
  minimapMountedIndexes.value = next
}

/** Mount the viewport neighborhood right away, schedule the rest for idle. */
function ensureMinimapViewportMounted (): void {
  if (!minimapVisible.value) return
  const range = visibleRange.value
  const from = Math.max(0, range.start - 6)
  const to = Math.min(props.messages.length - 1, range.end + 6)
  const immediate: number[] = []
  for (let i = from; i <= to; i++) {
    if (!minimapMountedIndexes.value.has(i)) immediate.push(i)
  }
  // Always mount the tail: it is where streaming output lands, and it may sit
  // outside the viewport neighborhood while the conversation grows.
  const last = props.messages.length - 1
  if (last >= 0 && !minimapMountedIndexes.value.has(last)) immediate.push(last)
  mountMinimapRows(immediate.slice(0, MINIMAP_MAX_MOUNTED_ROWS))
  scheduleMinimapIdleMounts()
}

function scheduleMinimapIdleMounts (): void {
  rebuildMinimapMountQueue()
  if (minimapMountQueue.length === 0) return
  if (typeof window.requestIdleCallback !== 'function') {
    mountMinimapRows(minimapMountQueue.splice(0, minimapMountQueue.length))
    return
  }
  if (minimapMountIdleId != null) return
  minimapMountIdleId = window.requestIdleCallback(() => {
    minimapMountIdleId = null
    // Small batches per idle slot; Vue mounts + markdown/KaTeX renders cost.
    mountMinimapRows(minimapMountQueue.splice(0, 3))
    if (minimapMountQueue.length > 0) scheduleMinimapIdleMounts()
  }, { timeout: 2000 })
}

// Mount on appends and viewport moves - AND on visibility: a streaming reply
// often grows the conversation past the overflow threshold mid-stream, and
// neither messages.length nor visibleRange.start changes while a single
// message streams. Without this, rows appended while the minimap was hidden
// stay unmounted (3px stripes) and new output never renders in the rail.
watch([() => props.messages.length, () => visibleRange.value.start, minimapVisible], () => {
  ensureMinimapViewportMounted()
})

/** Rendered track width of the real message list (for the uniform minimap scale). */
const minimapTrackWidth = ref(0)

function readMinimapTrackWidth (): void {
  const element = messagesContainer.value
  if (!element) return
  const style = window.getComputedStyle(element)
  const horizontal = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
  const inner = element.clientWidth - horizontal
  // Keep in sync with --chat-message-track-max used by .message-row.
  minimapTrackWidth.value = Math.max(Math.min(inner, 1180), 1)
}

const highlightedMessageKey = ref<string | null>(null)
let jumpHighlightTimer: number | null = null

function jumpToMessageIndex (index: number): void {
  const container = messagesContainer.value
  if (!container) return
  autoStickEnabled.value = false
  const maxTop = Math.max(0, container.scrollHeight - container.clientHeight)
  const target = Math.min(Math.max(getOffsetBefore(index) - 24, 0), maxTop)
  setContainerScrollTop(container, target)

  highlightedMessageKey.value = getMessageKey(index)
  if (jumpHighlightTimer != null) window.clearTimeout(jumpHighlightTimer)
  jumpHighlightTimer = window.setTimeout(() => {
    highlightedMessageKey.value = null
    jumpHighlightTimer = null
  }, 1500)
}

function minimapScrub (ratio: number): void {
  const container = messagesContainer.value
  if (!container) return
  autoStickEnabled.value = false
  const maxTop = Math.max(0, container.scrollHeight - container.clientHeight)
  setContainerScrollTop(container, Math.min(Math.max(ratio, 0), 1) * maxTop)
}

function flushAnchorDelta (): void {
  anchorFlushScheduled = false
  anchorFrameId = null
  if (!messagesContainer.value || autoStickEnabled.value) {
    pendingAnchorDelta = 0
    return
  }
  if (pendingAnchorDelta === 0) return

  const delta = pendingAnchorDelta
  pendingAnchorDelta = 0

  const maxScroll = Math.max(0, messagesContainer.value.scrollHeight - messagesContainer.value.clientHeight)
  const desired = Math.max(0, Math.min(messagesContainer.value.scrollTop + delta, maxScroll))
  setContainerScrollTop(messagesContainer.value, desired)
}

function scheduleAnchorFlush (): void {
  if (anchorFlushScheduled) return
  anchorFlushScheduled = true
  nextTick(() => {
    if (!anchorFlushScheduled) return
    anchorFrameId = window.requestAnimationFrame(flushAnchorDelta)
  })
}

function updateMeasuredHeight (rowKey: string, index: number, height: number): void {
  const nextHeight = Math.max(Math.ceil(height), 1)
  const prevHeight = measuredMessageHeights[rowKey]
  if (prevHeight === nextHeight) return

  const assumedHeight = prevHeight ?? getAssignedEstimatedHeight(rowKey)
  const heightDelta = nextHeight - assumedHeight
  const messageTop = getOffsetBefore(index)
  const messageBottom = messageTop + assumedHeight + (index > 0 ? MESSAGE_GAP : 0)

  measuredMessageHeights[rowKey] = nextHeight
  if (prevHeight == null) {
    measuredHeightCount += 1
    measuredHeightTotal += nextHeight
  } else {
    measuredHeightTotal += nextHeight - prevHeight
  }

  if (autoStickEnabled.value) {
    scrollToBottom()
    return
  }

  if (messageBottom <= scrollTop.value + pendingAnchorDelta) {
    pendingAnchorDelta += heightDelta
    scheduleAnchorFlush()
  }
}

function cleanupMessageObserver (rowKey: string): void {
  const observer = messageObservers.get(rowKey)
  if (observer) {
    observer.disconnect()
    messageObservers.delete(rowKey)
  }
  messageElements.delete(rowKey)
}

function extractHTMLElement (element: unknown): HTMLElement | null {
  if (element instanceof HTMLElement) return element
  if (element && typeof element === 'object' && '$el' in element) {
    const candidate = (element as { $el?: unknown }).$el
    if (candidate instanceof HTMLElement) return candidate
  }
  return null
}

function setMessageItemRef (rowKey: string, index: number, element: unknown): void {
  const item = extractHTMLElement(element)
  if (!item) {
    cleanupMessageObserver(rowKey)
    return
  }

  if (messageElements.get(rowKey) === item) return
  cleanupMessageObserver(rowKey)
  messageElements.set(rowKey, item)

  updateMeasuredHeight(rowKey, index, item.offsetHeight)
  if (typeof ResizeObserver === 'undefined') return

  const observer = new ResizeObserver(entries => {
    const entry = entries[0]
    if (!entry) return
    const currentIndex = getIndexForMessageKey(rowKey)
    if (currentIndex < 0) {
      cleanupMessageObserver(rowKey)
      return
    }
    // Use borderBoxSize when available for consistency with offsetHeight;
    // fall back to offsetHeight (contentRect excludes padding/border).
    let height: number
    if (entry.borderBoxSize?.length) {
      height = entry.borderBoxSize[0].blockSize
    } else {
      height = (entry.target as HTMLElement).offsetHeight
    }
    updateMeasuredHeight(rowKey, currentIndex, height)
  })
  observer.observe(item)
  messageObservers.set(rowKey, observer)
}

function resetVirtualMeasurements (): void {
  for (const key in measuredMessageHeights) {
    delete measuredMessageHeights[key]
  }
  messageObservers.forEach(observer => observer.disconnect())
  messageObservers.clear()
  messageElements.clear()
  estimatedMessageHeights.clear()
  pendingAnchorDelta = 0
  anchorFlushScheduled = false
  measuredHeightTotal = 0
  measuredHeightCount = 0
  if (anchorFrameId != null) {
    window.cancelAnimationFrame(anchorFrameId)
    anchorFrameId = null
  }
  if (bottomScrollFrameId != null) {
    window.cancelAnimationFrame(bottomScrollFrameId)
    bottomScrollFrameId = null
  }
  if (programmaticScrollFrameId != null) {
    window.cancelAnimationFrame(programmaticScrollFrameId)
    programmaticScrollFrameId = null
  }
  bottomScrollScheduled = false
  isProgrammaticScrolling = false
}

function trimVirtualMeasurements (): void {
  const activeKeys = new Set<string>()
  for (let i = 0; i < props.messages.length; i++) {
    activeKeys.add(getMessageKey(i))
  }

  for (const key in measuredMessageHeights) {
    if (!activeKeys.has(key)) {
      measuredHeightTotal -= measuredMessageHeights[key] ?? 0
      measuredHeightCount = Math.max(0, measuredHeightCount - 1)
      delete measuredMessageHeights[key]
      estimatedMessageHeights.delete(key)
      cleanupMessageObserver(key)
    }
  }

  for (const key of Array.from(messageObservers.keys())) {
    if (!activeKeys.has(key)) cleanupMessageObserver(key)
  }

  for (const key of Array.from(estimatedMessageHeights.keys())) {
    if (!activeKeys.has(key)) estimatedMessageHeights.delete(key)
  }
}

function getMessageSignature (msg?: ChatMessage): string {
  if (!msg) return ''
  const blocks = Array.isArray(msg.blocks) && msg.blocks.length > 0
    ? msg.blocks
    : buildMessageBlocks(msg, -1, props.filePreview, latestAssistantMessageIndex.value, false)
  const blockSignature = blocks.map(block => {
    if (block.kind === 'content') {
      return `content:${getContentParts(block.content)
        .map(part => part.type === 'image_url' ? part.image_url?.url || '' : part.text || '')
        .join('|')}`
    }
    if (block.kind === 'error') return `error:${block.message}`
    if (block.kind === 'thinking') return `thinking:${block.text}`
    if (block.kind === 'file_preview') return `preview:${block.filePath}:${block.lineCount}:${block.added}:${block.removed}:${block.active}`
    if (block.kind === 'group_collaboration_plan') return `groupplan:${block.plan.groupId}:${block.plan.phase}:${block.plan.mode}:${block.plan.planner.agentId}:${block.plan.reportToName}:${block.plan.originalRequest}:${block.plan.normalizedRequest}:${block.plan.reason}:${block.plan.round || 0}:${block.plan.mentionedParticipants.map(item => `${item.agentId}:${item.agentName}`).join('|')}:${block.plan.candidateParticipants.map(item => `${item.agentId}:${item.agentName}`).join('|')}:${block.plan.invitedParticipants.map(item => `${item.agentId}:${item.agentName}`).join('|')}`
    if (block.kind === 'agent_sidechat') return `sidechat:${block.session.id}:${block.session.status}:${block.session.round}:${block.session.agentId}:${block.session.request}:${block.session.response}:${block.session.error || ''}:${block.session.progress.map(step => `${step.stage}:${step.detail || ''}`).join('>')}`
    if (block.kind === 'group_progress') return `groupprogress:${block.snapshot.groupId}:${block.snapshot.status}:${block.snapshot.activeRound}:${block.snapshot.items.map((item: typeof block.snapshot.items[number]) => `${item.agentId}:${item.status}:${item.currentRound}:${item.completedRounds}:${item.stage}:${item.detail || ''}:${item.summary || ''}:${item.progress.map(step => `${step.stage}:${step.detail || ''}`).join('>')}`).join('|')}`
    if (block.kind === 'group_transcript') return `grouptranscript:${block.transcript.groupId}:${block.transcript.visibility}:${block.transcript.entryCount}:${block.transcript.summary}:${block.transcript.entries.map((entry: typeof block.transcript.entries[number]) => `${entry.id}:${entry.round}:${entry.agentId}:${entry.content}:${entry.directReply ? 1 : 0}:${entry.toolCalls?.length || 0}:${entry.peerMessages?.length || 0}:${(entry.boardFields || []).join(',')}`).join('|')}`
    if (block.kind === 'group_board') return `groupboard:${block.board.groupId}:${block.board.updatedAt}:${block.board.recentUpdates.length}`
    if (block.kind === 'group_direct_reply') return `groupdirectreply:${block.directReply.id}:${block.directReply.agentName}:${block.directReply.content}`
    if (block.kind === 'group_user_injection') return `groupinjection:${block.injection.id}:${block.injection.content}`
    if (block.kind === 'group_peer_message') return `grouppeer:${block.peerMessage.id}:${block.peerMessage.status}:${block.peerMessage.response}`
    if (block.kind === 'web_search') return `websearch:${block.query}:${block.engine}:${block.results.map(item => `${item.rank}:${item.url}:${item.title}:${item.snippet}`).join('|')}`
    if (block.kind === 'web_fetch') return `webfetch:${block.query || ''}:${block.result.url}:${block.result.final_url || ''}:${block.result.ok}:${block.result.title || ''}:${block.result.error || ''}:${block.result.query_snippets?.join('|') || ''}`
    if (block.kind === 'attachment') return `attachment:${block.fileName}:${block.fileType}:${block.fileSizeLabel}:${block.previewText}`
    if (block.kind === 'auth_request') return `auth:${block.requestId}:${block.status}:${block.title}:${block.detail}`
    if (block.kind === 'sudo_password_request') return `sudo:${block.requestId}:${block.status}`
    if (block.kind === 'todo') return `todo:${block.items.map(item => `${item.id}:${item.status}:${item.title}`).join('|')}`
    return `tool:${block.toolRun.id}:${block.toolRun.status}:${block.toolRun.progress.map((step: { stage: string; detail?: string }) => `${step.stage}:${step.detail || ''}`).join('>')}`
  }).join('|')
  return [blockSignature, msg.thinking || '', msg.speakerName || '', msg.modelLabel || ''].join('::')
}

// Auto-collapse thinking blocks when streaming finishes
watch(
  () => props.isLoading,
  (loading, wasLoading) => {
    if (!loading && wasLoading) {
      const lastIdx = props.messages.length - 1
      if (lastIdx < 0) return
      const last = props.messages[lastIdx]
      if (last?.role !== 'assistant') return
      buildMessageBlocks(last, lastIdx, props.filePreview, latestAssistantMessageIndex.value, false)
        .forEach(block => {
          if (block.kind === 'thinking') collapsedThinking[block.id] = true
        })
    }
  }
)

watch(
  () => props.messages,
  () => {
    trimVirtualMeasurements()
    nextTick(syncViewportMetrics)
  }
)

watch(
  () => props.messages.length,
  () => {
    if (autoStickEnabled.value) {
      scrollToBottom()
      return
    }
    nextTick(syncViewportMetrics)
  }
)

watch(
  () => getMessageSignature(props.messages[props.messages.length - 1]),
  () => {
    if (autoStickEnabled.value) {
      scrollToBottom()
      return
    }
    nextTick(syncViewportMetrics)
  }
)

watch(
  () => [props.filePreview.active, props.filePreview.filePath],
  () => {
    if (autoStickEnabled.value) {
      scrollToBottom()
      return
    }
    nextTick(syncViewportMetrics)
  }
)

watch(
  totalContentHeight,
  () => {
    if (autoStickEnabled.value) {
      scrollToBottom()
    }
  }
)

onMounted(() => {
  document.addEventListener('click', hideSelectionCopyMenu)
  document.addEventListener('selectionchange', handleDocumentSelectionChange)
  window.addEventListener('blur', hideSelectionCopyMenu)
  syncViewportMetrics()
  ensureMinimapViewportMounted()
  if (props.messages.length > 0) {
    nextTick(scrollToBottom)
  }
  if (typeof ResizeObserver === 'undefined') return
  containerObserver = new ResizeObserver(() => {
    syncViewportMetrics()
  })
  if (messagesContainer.value) containerObserver.observe(messagesContainer.value)
})

onUnmounted(() => {
  document.removeEventListener('click', hideSelectionCopyMenu)
  document.removeEventListener('selectionchange', handleDocumentSelectionChange)
  window.removeEventListener('blur', hideSelectionCopyMenu)
  if (selectionCopyResetTimer != null) {
    window.clearTimeout(selectionCopyResetTimer)
    selectionCopyResetTimer = null
  }
  containerObserver?.disconnect()
  containerObserver = null
  if (minimapMountIdleId != null && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(minimapMountIdleId)
    minimapMountIdleId = null
  }
  if (jumpHighlightTimer != null) {
    window.clearTimeout(jumpHighlightTimer)
    jumpHighlightTimer = null
  }
  resetVirtualMeasurements()
})
</script>

<template>
  <div class="message-list-shell">
    <MessageMinimap
      v-if="minimapVisible"
      :rows="minimapRows"
      :messages="props.messages"
      :track-width="minimapTrackWidth"
      :total-scroll-px="minimapTotalHeight"
      :scroll-top-px="scrollTop"
      :viewport-px="viewportHeight"
      :is-streaming="props.isLoading"
      :assistant-icon="props.assistantIcon"
      :assistant-name="props.assistantName"
      :group-icon="isGroupChat ? (props.assistantIcon?.trim() || '👥') : undefined"
      @jump="jumpToMessageIndex"
      @scrub="minimapScrub"
    />
    <div
      class="chat-messages"
      :class="{ 'with-minimap': minimapVisible }"
      ref="messagesContainer"
      @scroll.passive="handleScroll"
      @wheel.capture.passive="handleWheel"
      @click.capture="handleMessageLinkClick"
      @contextmenu="handleSelectionContextMenu"
    >
    <div v-if="props.messages.length === 0" class="empty-state">
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
    </div>

    <template v-else>
      <div v-if="topSpacerHeight > 0" class="message-spacer" :style="{ height: `${topSpacerHeight}px` }" aria-hidden="true" />

      <div
        v-for="{ msg, index, key } in virtualRows"
        :key="key"
        :ref="(element) => setMessageItemRef(key, index, element)"
        class="message-item"
        :class="{ 'with-leading-gap': index > 0, 'jump-highlight': key === highlightedMessageKey }"
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
        />
      </div>

      <div v-if="bottomSpacerHeight > 0" class="message-spacer" :style="{ height: `${bottomSpacerHeight}px` }" aria-hidden="true" />
    </template>

    <ImageLightbox ref="lightboxRef" :images="galleryImages" />
    <MermaidPreviewDialog :diagram="activeMermaidPreview" @close="closeMermaidPreview" />

    <Teleport to="body">
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
  padding: calc(24px + var(--chat-header-height, 0px)) var(--chat-message-gutter, 28px) calc(8px + var(--chat-input-overlap, 0px));
  scrollbar-gutter: stable;
  overscroll-behavior-y: contain;
  overflow-anchor: none;
  position: relative;
}

/* Long conversations: the minimap IS the scroll UI - hide the native bar and
   shift content left so the wider minimap never covers it. */
.chat-messages.with-minimap {
  padding-right: 104px;
  scrollbar-gutter: auto;
  scrollbar-width: none;
}

.chat-messages.with-minimap::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.message-item.with-leading-gap {
  margin-top: 20px;
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
