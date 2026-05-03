<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { buildMessageBlocks, getContentParts } from '../message-utils'
import type { ChatMessage, GalleryImage, FilePreviewState } from '../types'
import MessageRow from './MessageRow.vue'
import ImageLightbox from '../media/ImageLightbox.vue'
import MermaidPreviewDialog from '../media/MermaidPreviewDialog.vue'

const props = defineProps<{
  messages: ChatMessage[]
  isLoading: boolean
  filePreview: FilePreviewState
}>()

const emit = defineEmits<{
  (e: 'respondAuth', requestId: string, approved: boolean): void
  (e: 'respondSudoPassword', requestId: string, password: string | null): void
  (e: 'openLink', url: string): void
}>()

const messagesContainer = ref<HTMLElement | null>(null)
const lightboxRef = ref<InstanceType<typeof ImageLightbox> | null>(null)
const collapsedThinking = reactive<Record<string, boolean>>({})
const activeMermaidPreview = ref<{ code: string } | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(0)
const autoStickEnabled = ref(true)
const nearBottom = ref(true)
const measuredMessageHeights = reactive<Record<number, number>>({})
const messageObservers = new Map<number, ResizeObserver>()
let containerObserver: ResizeObserver | null = null

const OVERSCAN_COUNT = 4
const MESSAGE_GAP = 20
const ESTIMATED_MESSAGE_HEIGHT = 220
const AUTO_SCROLL_THRESHOLD = 96
const RESTORE_AUTO_SCROLL_THRESHOLD = 4

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

function scrollToBottom () {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
      scrollTop.value = messagesContainer.value.scrollTop
      nearBottom.value = true
      autoStickEnabled.value = true
    }
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
  nearBottom.value = isNearBottom(messagesContainer.value)
}

function handleScroll (): void {
  if (!messagesContainer.value) return
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
  if (!messagesContainer.value) return
  if (event.deltaY < 0 && messagesContainer.value.scrollHeight > messagesContainer.value.clientHeight) {
    autoStickEnabled.value = false
  }
}

function getMessageHeight (index: number): number {
  return measuredMessageHeights[index] ?? ESTIMATED_MESSAGE_HEIGHT
}

function getMessageExtent (index: number): number {
  return getMessageHeight(index) + (index > 0 ? MESSAGE_GAP : 0)
}

function getOffsetBefore (index: number): number {
  let total = 0
  for (let i = 0; i < index; i++) {
    total += getMessageExtent(i)
  }
  return total
}

const totalContentHeight = computed(() => getOffsetBefore(props.messages.length))

const visibleRange = computed(() => {
  const messageCount = props.messages.length
  if (messageCount === 0) {
    return { start: 0, end: -1 }
  }

  const viewportBottom = scrollTop.value + Math.max(viewportHeight.value, 1)
  let start = 0
  let offset = 0

  while (start < messageCount) {
    const nextOffset = offset + getMessageExtent(start)
    if (nextOffset >= scrollTop.value) break
    offset = nextOffset
    start++
  }

  let end = start
  let visibleBottom = offset
  while (end < messageCount && visibleBottom < viewportBottom) {
    visibleBottom += getMessageExtent(end)
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
      index: visibleRange.value.start + offset
    }))
})

const topSpacerHeight = computed(() => getOffsetBefore(visibleRange.value.start))
const bottomSpacerHeight = computed(() => {
  if (visibleRange.value.end < visibleRange.value.start) return 0
  return Math.max(0, totalContentHeight.value - getOffsetBefore(visibleRange.value.end + 1))
})

function updateMeasuredHeight (index: number, height: number): void {
  const nextHeight = Math.max(Math.ceil(height), 1)
  if (measuredMessageHeights[index] === nextHeight) return
  measuredMessageHeights[index] = nextHeight
  if (autoStickEnabled.value) scrollToBottom()
}

function cleanupMessageObserver (index: number): void {
  const observer = messageObservers.get(index)
  if (!observer) return
  observer.disconnect()
  messageObservers.delete(index)
}

function extractHTMLElement (element: unknown): HTMLElement | null {
  if (element instanceof HTMLElement) return element
  if (element && typeof element === 'object' && '$el' in element) {
    const candidate = (element as { $el?: unknown }).$el
    if (candidate instanceof HTMLElement) return candidate
  }
  return null
}

function setMessageItemRef (index: number, element: unknown): void {
  cleanupMessageObserver(index)

  const item = extractHTMLElement(element)
  if (!item) return

  updateMeasuredHeight(index, item.offsetHeight)
  if (typeof ResizeObserver === 'undefined') return

  const observer = new ResizeObserver(entries => {
    const entry = entries[0]
    if (entry) {
      updateMeasuredHeight(index, entry.contentRect.height)
    }
  })
  observer.observe(item)
  messageObservers.set(index, observer)
}

function resetVirtualMeasurements (): void {
  for (const key in measuredMessageHeights) {
    delete measuredMessageHeights[Number(key)]
  }
  messageObservers.forEach(observer => observer.disconnect())
  messageObservers.clear()
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
    if (block.kind === 'file_preview') return `preview:${block.filePath}:${block.previewContent}:${block.truncated}:${block.active}`
    if (block.kind === 'group_collaboration_plan') return `groupplan:${block.plan.groupId}:${block.plan.phase}:${block.plan.mode}:${block.plan.planner.agentId}:${block.plan.reportToName}:${block.plan.originalRequest}:${block.plan.normalizedRequest}:${block.plan.reason}:${block.plan.round || 0}:${block.plan.mentionedParticipants.map(item => `${item.agentId}:${item.agentName}`).join('|')}:${block.plan.candidateParticipants.map(item => `${item.agentId}:${item.agentName}`).join('|')}:${block.plan.invitedParticipants.map(item => `${item.agentId}:${item.agentName}`).join('|')}`
    if (block.kind === 'agent_sidechat') return `sidechat:${block.session.id}:${block.session.status}:${block.session.round}:${block.session.agentId}:${block.session.request}:${block.session.response}:${block.session.error || ''}:${block.session.progress.map(step => `${step.stage}:${step.detail || ''}`).join('>')}`
    if (block.kind === 'group_progress') return `groupprogress:${block.snapshot.groupId}:${block.snapshot.status}:${block.snapshot.activeRound}:${block.snapshot.items.map((item: typeof block.snapshot.items[number]) => `${item.agentId}:${item.status}:${item.currentRound}:${item.completedRounds}:${item.stage}:${item.detail || ''}:${item.summary || ''}:${item.progress.map(step => `${step.stage}:${step.detail || ''}`).join('>')}`).join('|')}`
    if (block.kind === 'group_transcript') return `grouptranscript:${block.transcript.groupId}:${block.transcript.visibility}:${block.transcript.entryCount}:${block.transcript.summary}:${block.transcript.entries.map((entry: typeof block.transcript.entries[number]) => `${entry.id}:${entry.round}:${entry.agentId}:${entry.content}`).join('|')}`
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
    resetVirtualMeasurements()
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
  () => [props.filePreview.active, props.filePreview.content],
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
  syncViewportMetrics()
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
  containerObserver?.disconnect()
  containerObserver = null
  resetVirtualMeasurements()
})
</script>

<template>
  <div class="chat-messages" ref="messagesContainer" @scroll.passive="handleScroll" @wheel.capture.passive="handleWheel" @click.capture="handleMessageLinkClick">
    <div v-if="props.messages.length === 0" class="empty-state">
      <div class="empty-state-card">
        <div class="empty-state-icon">AI</div>
        <h3>开始一段新对话</h3>
        <p>我可以为你创建应用、修改项目、分析数据，或者直接协助调试现有代码。</p>
        <ul>
          <li>创建一个新的 Web 应用项目</li>
          <li>修改现有项目的前后端逻辑</li>
          <li>分析项目中的数据库与业务数据</li>
          <li>调用运行中项目的 API 进行排查</li>
        </ul>
      </div>
    </div>

    <template v-else>
      <div v-if="topSpacerHeight > 0" class="message-spacer" :style="{ height: `${topSpacerHeight}px` }" aria-hidden="true" />

      <div
        v-for="{ msg, index } in virtualRows"
        :key="index"
        :ref="(element) => setMessageItemRef(index, element)"
        class="message-item"
        :class="{ 'with-leading-gap': index > 0 }"
      >
        <MessageRow
          :msg="msg"
          :index="index"
          :is-loading="props.isLoading"
          :latest-assistant-message-index="latestAssistantMessageIndex"
          :file-preview="props.filePreview"
          :collapsed-thinking="collapsedThinking"
          @respond-auth="(requestId, approved) => emit('respondAuth', requestId, approved)"
          @respond-sudo-password="(requestId, password) => emit('respondSudoPassword', requestId, password)"
          @toggle-thinking="toggleThinking"
          @open-lightbox="(mi, bi, pi) => openLightbox(mi, bi, pi)"
          @open-mermaid-preview="openMermaidPreview"
        />
      </div>

      <div v-if="bottomSpacerHeight > 0" class="message-spacer" :style="{ height: `${bottomSpacerHeight}px` }" aria-hidden="true" />
    </template>

    <ImageLightbox ref="lightboxRef" :images="galleryImages" />
    <MermaidPreviewDialog :diagram="activeMermaidPreview" @close="closeMermaidPreview" />
  </div>
</template>

<style scoped>
.chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 24px var(--chat-message-gutter, 28px) 20px;
  scrollbar-gutter: stable;
  overscroll-behavior-y: contain;
  overflow-anchor: none;
  position: relative;
}

.message-item.with-leading-gap {
  margin-top: 20px;
}

.message-spacer {
  width: 100%;
  flex: 0 0 auto;
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
    padding: 20px 16px 16px;
  }

  .empty-state-card {
    width: min(100%, 640px);
  }
}
</style>
