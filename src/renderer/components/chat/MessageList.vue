<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { renderMarkdown } from './markdown'

type MessageContent = string | ChatContentPart[]

interface ChatContentPart {
  type: string
  text?: string
  image_url?: { url: string }
}

interface ToolProgressEntry {
  stage: string
  detail?: string
}

interface ToolRun {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
  progress: ToolProgressEntry[]
}

type ChatMessageBlock =
  | { id: string; kind: 'content'; content: MessageContent }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tool'; toolRun: ToolRun }
  | { id: string; kind: 'file_preview'; filePath: string; previewContent: string; truncated: boolean; active: boolean }

interface ChatMessage {
  role: string
  content: MessageContent
  thinking?: string
  modelLabel?: string
  toolRuns?: ToolRun[]
  blocks?: ChatMessageBlock[]
}

interface GalleryImage {
  url: string
  messageIndex: number
  blockIndex: number
  partIndex: number
}

const props = defineProps<{
  messages: ChatMessage[]
  isLoading: boolean
  filePreview: { active: boolean; filePath: string; content: string; truncated: boolean }
}>()

const messagesContainer = ref<HTMLElement | null>(null)
const filePreviewRef = ref<HTMLElement | null>(null)
const lightboxBodyRef = ref<HTMLElement | null>(null)
const lightboxIndex = ref<number | null>(null)
const lightboxZoom = ref(1)
const lightboxNaturalSize = ref({ width: 0, height: 0 })
const lightboxViewport = ref({ width: 0, height: 0 })

const MIN_LIGHTBOX_ZOOM = 1
const MAX_LIGHTBOX_ZOOM = 4
const LIGHTBOX_ZOOM_STEP = 0.25

const latestAssistantMessageIndex = computed(() => {
  for (let index = props.messages.length - 1; index >= 0; index--) {
    if (props.messages[index].role === 'assistant') {
      return index
    }
  }
  return -1
})

const galleryImages = computed<GalleryImage[]>(() => {
  const images: GalleryImage[] = []

  props.messages.forEach((message, messageIndex) => {
    getMessageBlocks(message, messageIndex).forEach((block, blockIndex) => {
      if (block.kind !== 'content') return

      getContentParts(block.content).forEach((part, partIndex) => {
        if (part.type === 'image_url' && part.image_url?.url) {
          images.push({
            url: part.image_url.url,
            messageIndex,
            blockIndex,
            partIndex
          })
        }
      })
    })
  })

  return images
})

const lightboxImage = computed(() => {
  if (lightboxIndex.value == null) return null
  return galleryImages.value[lightboxIndex.value] ?? null
})

const lightboxZoomPercent = computed(() => `${Math.round(lightboxZoom.value * 100)}%`)

const canShowPreviousImage = computed(() => lightboxIndex.value !== null && lightboxIndex.value > 0)
const canShowNextImage = computed(() => lightboxIndex.value !== null && lightboxIndex.value < galleryImages.value.length - 1)

const lightboxMetrics = computed(() => {
  const image = lightboxImage.value
  const { width: naturalWidth, height: naturalHeight } = lightboxNaturalSize.value
  const { width: viewportWidth, height: viewportHeight } = lightboxViewport.value

  if (!image || !naturalWidth || !naturalHeight || !viewportWidth || !viewportHeight) {
    return null
  }

  const fitScale = Math.min(viewportWidth / naturalWidth, viewportHeight / naturalHeight, 1)
  const fittedWidth = naturalWidth * fitScale
  const fittedHeight = naturalHeight * fitScale
  const renderedWidth = fittedWidth * lightboxZoom.value
  const renderedHeight = fittedHeight * lightboxZoom.value
  const maxRenderedWidth = fittedWidth * MAX_LIGHTBOX_ZOOM
  const maxRenderedHeight = fittedHeight * MAX_LIGHTBOX_ZOOM

  return {
    fittedWidth,
    fittedHeight,
    renderedWidth,
    renderedHeight,
    stageWidth: Math.max(viewportWidth, maxRenderedWidth),
    stageHeight: Math.max(viewportHeight, maxRenderedHeight)
  }
})

const lightboxStageStyle = computed(() => {
  const metrics = lightboxMetrics.value
  if (!metrics) return {}

  return {
    width: `${metrics.stageWidth}px`,
    height: `${metrics.stageHeight}px`
  }
})

const lightboxImageStyle = computed(() => {
  const metrics = lightboxMetrics.value
  if (!metrics) return {}

  return {
    width: `${metrics.renderedWidth}px`,
    height: `${metrics.renderedHeight}px`
  }
})

function getContentText (content: MessageContent): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(part => part.type === 'text')
      .map(part => part.text || '')
      .join('')
  }
  return ''
}

function getMessageText (msg: ChatMessage): string {
  return getContentText(msg.content)
}

function getContentParts (content: MessageContent): ChatContentPart[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  return content
}

function getMessageParts (msg: ChatMessage): ChatContentPart[] {
  return getContentParts(msg.content)
}

function hasRenderableContent (content: MessageContent): boolean {
  return getContentParts(content).some(part => {
    if (part.type === 'text') {
      return Boolean(part.text?.length)
    }
    return Boolean(part.image_url?.url)
  })
}

function getMessageBlocks (msg: ChatMessage, index: number): ChatMessageBlock[] {
  if (Array.isArray(msg.blocks) && msg.blocks.length > 0) {
    return msg.blocks
  }

  const blocks: ChatMessageBlock[] = []

  if (msg.role === 'assistant' && msg.thinking) {
    blocks.push({
      id: `legacy-thinking-${index}`,
      kind: 'thinking',
      text: msg.thinking
    })
  }

  if (msg.role === 'assistant' && Array.isArray(msg.toolRuns)) {
    for (const toolRun of msg.toolRuns) {
      blocks.push({
        id: `legacy-tool-${toolRun.id}`,
        kind: 'tool',
        toolRun
      })
    }
  }

  if (hasRenderableContent(msg.content) || isStreamingAssistant(index, msg)) {
    blocks.push({
      id: `legacy-content-${index}`,
      kind: 'content',
      content: msg.content
    })
  }

  if (shouldShowFilePreview(index, msg)) {
    blocks.push({
      id: `legacy-preview-${index}`,
      kind: 'file_preview',
      filePath: props.filePreview.filePath,
      previewContent: props.filePreview.content,
      truncated: props.filePreview.truncated,
      active: props.filePreview.active
    })
  }

  return blocks
}

function getMessageSignature (msg?: ChatMessage): string {
  if (!msg) return ''

  const blockSignature = (msg.blocks || getMessageBlocks(msg, -1))
    .map(block => {
      if (block.kind === 'content') {
        return `content:${getContentParts(block.content)
          .map(part => part.type === 'image_url' ? part.image_url?.url || '' : part.text || '')
          .join('|')}`
      }
      if (block.kind === 'thinking') {
        return `thinking:${block.text}`
      }
      if (block.kind === 'file_preview') {
        return `preview:${block.filePath}:${block.previewContent}:${block.truncated}:${block.active}`
      }
      return `tool:${block.toolRun.id}:${block.toolRun.status}:${block.toolRun.progress.map(step => `${step.stage}:${step.detail || ''}`).join('>')}`
    })
    .join('|')

  return [blockSignature, msg.thinking || '', msg.modelLabel || ''].join('::')
}

function collapseWhitespace (text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function getGalleryIndex (messageIndex: number, blockIndex: number, partIndex: number): number {
  return galleryImages.value.findIndex(image => image.messageIndex === messageIndex && image.blockIndex === blockIndex && image.partIndex === partIndex)
}

function getMessageAuthor (msg: ChatMessage): string {
  return msg.role === 'assistant' ? 'The World AI' : '你'
}

function getAvatarLabel (msg: ChatMessage): string {
  return msg.role === 'assistant' ? 'AI' : '你'
}

function getModelLabel (msg: ChatMessage): string {
  return msg.modelLabel || 'The World AI'
}

function getBlockParts (block: Extract<ChatMessageBlock, { kind: 'content' }>): ChatContentPart[] {
  return getContentParts(block.content)
}

function isStreamingAssistant (index: number, msg: ChatMessage): boolean {
  return props.isLoading && msg.role === 'assistant' && index === latestAssistantMessageIndex.value
}

function hasRenderableBlock (block: ChatMessageBlock): boolean {
  if (block.kind === 'content') {
    return hasRenderableContent(block.content)
  }
  if (block.kind === 'thinking') {
    return block.text.trim().length > 0
  }
  return true
}

function getLastContentBlockIndex (blocks: ChatMessageBlock[]): number {
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (blocks[index].kind === 'content') {
      return index
    }
  }
  return -1
}

function isStreamingContentBlock (messageIndex: number, msg: ChatMessage, blockIndex: number, blocks: ChatMessageBlock[]): boolean {
  return isStreamingAssistant(messageIndex, msg) && blockIndex === getLastContentBlockIndex(blocks)
}

function shouldShowFilePreview (index: number, msg: ChatMessage): boolean {
  return msg.role === 'assistant' && index === latestAssistantMessageIndex.value && props.filePreview.active
}

function getToolRunStatusLabel (status: ToolRun['status']): string {
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  return '执行中'
}

function updateLightboxViewport () {
  nextTick(() => {
    if (!lightboxBodyRef.value) return
    const computedStyle = window.getComputedStyle(lightboxBodyRef.value)
    const horizontalPadding = parseFloat(computedStyle.paddingLeft) + parseFloat(computedStyle.paddingRight)
    const verticalPadding = parseFloat(computedStyle.paddingTop) + parseFloat(computedStyle.paddingBottom)

    lightboxViewport.value = {
      width: Math.max(lightboxBodyRef.value.clientWidth - horizontalPadding, 0),
      height: Math.max(lightboxBodyRef.value.clientHeight - verticalPadding, 0)
    }
  })
}

function centerLightboxScroll () {
  nextTick(() => {
    if (!lightboxBodyRef.value) return
    lightboxBodyRef.value.scrollLeft = Math.max(0, (lightboxBodyRef.value.scrollWidth - lightboxBodyRef.value.clientWidth) / 2)
    lightboxBodyRef.value.scrollTop = Math.max(0, (lightboxBodyRef.value.scrollHeight - lightboxBodyRef.value.clientHeight) / 2)
  })
}

function syncLightboxScroll (previousZoom: number, nextZoom: number) {
  nextTick(() => {
    if (!lightboxBodyRef.value) return

    const metrics = lightboxMetrics.value
    if (!metrics || previousZoom === nextZoom) return

    const { clientWidth, clientHeight, scrollLeft, scrollTop } = lightboxBodyRef.value
    const previousRenderedWidth = metrics.fittedWidth * previousZoom
    const previousRenderedHeight = metrics.fittedHeight * previousZoom
    const nextRenderedWidth = metrics.fittedWidth * nextZoom
    const nextRenderedHeight = metrics.fittedHeight * nextZoom
    const scaleRatioX = previousRenderedWidth > 0 ? nextRenderedWidth / previousRenderedWidth : 1
    const scaleRatioY = previousRenderedHeight > 0 ? nextRenderedHeight / previousRenderedHeight : 1
    const stageCenterX = metrics.stageWidth / 2
    const stageCenterY = metrics.stageHeight / 2
    const viewportCenterX = scrollLeft + clientWidth / 2
    const viewportCenterY = scrollTop + clientHeight / 2
    const offsetFromCenterX = viewportCenterX - stageCenterX
    const offsetFromCenterY = viewportCenterY - stageCenterY
    const targetScrollLeft = stageCenterX + offsetFromCenterX * scaleRatioX - clientWidth / 2
    const targetScrollTop = stageCenterY + offsetFromCenterY * scaleRatioY - clientHeight / 2
    const maxScrollLeft = Math.max(metrics.stageWidth - clientWidth, 0)
    const maxScrollTop = Math.max(metrics.stageHeight - clientHeight, 0)

    lightboxBodyRef.value.scrollLeft = Math.max(0, Math.min(targetScrollLeft, maxScrollLeft))
    lightboxBodyRef.value.scrollTop = Math.max(0, Math.min(targetScrollTop, maxScrollTop))
  })
}

function setLightboxZoom (zoom: number) {
  const nextZoom = Math.min(MAX_LIGHTBOX_ZOOM, Math.max(MIN_LIGHTBOX_ZOOM, Number(zoom.toFixed(2))))
  const previousZoom = lightboxZoom.value

  if (nextZoom === previousZoom) return

  lightboxZoom.value = nextZoom
  syncLightboxScroll(previousZoom, nextZoom)
}

function zoomInLightbox () {
  setLightboxZoom(lightboxZoom.value + LIGHTBOX_ZOOM_STEP)
}

function zoomOutLightbox () {
  setLightboxZoom(lightboxZoom.value - LIGHTBOX_ZOOM_STEP)
}

function resetLightboxZoom () {
  setLightboxZoom(1)
}

function selectLightboxImage (index: number) {
  if (index < 0 || index >= galleryImages.value.length) return
  lightboxIndex.value = index
  resetLightboxZoom()
  lightboxNaturalSize.value = { width: 0, height: 0 }
  updateLightboxViewport()
}

function openLightbox (messageIndex: number, blockIndex: number, partIndex: number) {
  const index = getGalleryIndex(messageIndex, blockIndex, partIndex)
  if (index === -1) return
  selectLightboxImage(index)
}

function closeLightbox () {
  lightboxIndex.value = null
  resetLightboxZoom()
  lightboxNaturalSize.value = { width: 0, height: 0 }
}

function showPreviousImage () {
  if (!canShowPreviousImage.value || lightboxIndex.value == null) return
  selectLightboxImage(lightboxIndex.value - 1)
}

function showNextImage () {
  if (!canShowNextImage.value || lightboxIndex.value == null) return
  selectLightboxImage(lightboxIndex.value + 1)
}

function handleLightboxImageClick () {
  zoomInLightbox()
}

function handleLightboxImageLoad (event: Event) {
  const target = event.target as HTMLImageElement | null
  if (!target) return
  lightboxNaturalSize.value = {
    width: target.naturalWidth,
    height: target.naturalHeight
  }
  updateLightboxViewport()
  centerLightboxScroll()
}

function handleLightboxWheel (event: WheelEvent) {
  if (!lightboxImage.value || !event.ctrlKey) return

  event.preventDefault()
  const nextZoom = lightboxZoom.value * Math.exp(-event.deltaY * 0.003)
  setLightboxZoom(nextZoom)
}

function getDownloadName (imageUrl: string): string {
  const mimeType = imageUrl.match(/^data:(image\/[^;]+);base64,/)?.[1]
  const extension = mimeType?.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
  const timestamp = new Date().toISOString().replace(/[.:]/g, '-')
  return `the-world-image-${timestamp}.${extension}`
}

async function downloadImage (imageUrl: string) {
  const defaultName = getDownloadName(imageUrl)

  if (window.electronAPI?.saveImageToFile) {
    try {
      await window.electronAPI.saveImageToFile(imageUrl, defaultName)
      return
    } catch (error) {
      console.error('Failed to save image via Electron API:', error)
    }
  }

  const link = document.createElement('a')
  link.href = imageUrl
  link.download = defaultName
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function handleWindowKeydown (event: KeyboardEvent) {
  if (!lightboxImage.value) return

  if (event.key === 'Escape') {
    closeLightbox()
    return
  }

  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    showPreviousImage()
    return
  }

  if (event.key === 'ArrowRight') {
    event.preventDefault()
    showNextImage()
    return
  }

  if (event.key === '+' || event.key === '=') {
    event.preventDefault()
    zoomInLightbox()
    return
  }

  if (event.key === '-' || event.key === '_') {
    event.preventDefault()
    zoomOutLightbox()
    return
  }

  if (event.key === '0') {
    event.preventDefault()
    resetLightboxZoom()
  }
}

function scrollToBottom () {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

watch(() => props.messages.length, scrollToBottom)

watch(
  () => getMessageSignature(props.messages[props.messages.length - 1]),
  () => {
    scrollToBottom()
  }
)

watch(
  () => [props.filePreview.active, props.filePreview.content],
  () => {
    scrollToBottom()
    nextTick(() => {
      if (filePreviewRef.value) {
        filePreviewRef.value.scrollTop = filePreviewRef.value.scrollHeight
      }
    })
  }
)

watch(
  () => galleryImages.value.map(image => `${image.messageIndex}:${image.blockIndex}:${image.partIndex}:${image.url}`).join('|'),
  () => {
    if (lightboxIndex.value == null) return

    if (galleryImages.value.length === 0) {
      closeLightbox()
      return
    }

    if (lightboxIndex.value >= galleryImages.value.length) {
      lightboxIndex.value = galleryImages.value.length - 1
    }

    updateLightboxViewport()
  }
)

onMounted(() => {
  window.addEventListener('keydown', handleWindowKeydown)
  window.addEventListener('resize', updateLightboxViewport)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleWindowKeydown)
  window.removeEventListener('resize', updateLightboxViewport)
})
</script>

<template>
  <div class="chat-messages" ref="messagesContainer">
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

    <div
      v-for="(msg, i) in props.messages"
      :key="i"
      class="message-row"
      :class="msg.role"
    >
      <div v-if="msg.role === 'assistant'" class="message-avatar assistant-avatar">{{ getAvatarLabel(msg) }}</div>

      <div class="message-column" :class="msg.role">
        <div class="message-meta" :class="msg.role">
          <span class="message-author">{{ getMessageAuthor(msg) }}</span>
          <span v-if="msg.role === 'assistant'" class="message-model-chip">{{ getModelLabel(msg) }}</span>
        </div>

        <div class="message-flow" :class="msg.role">
          <template v-for="(block, blockIndex) in getMessageBlocks(msg, i)" :key="block.id">
            <div
              v-if="block.kind === 'thinking' && hasRenderableBlock(block)"
              class="message-event-card thinking-card"
            >
              <!-- <div class="message-event-header">
                <span class="message-event-kicker">思考过程</span>
                <span class="message-event-status">按顺序输出</span>
              </div> -->
              <div class="message-event-body markdown-body" v-html="renderMarkdown(block.text)"></div>
            </div>

            <div
              v-else-if="block.kind === 'tool'"
              class="message-event-card tool-event-card"
              :class="block.toolRun.status"
            >
              <div class="tool-run-header">
                <div class="tool-run-name">{{ block.toolRun.name }}</div>
                <span class="tool-run-status" :class="block.toolRun.status">{{ getToolRunStatusLabel(block.toolRun.status) }}</span>
              </div>

              <div v-if="block.toolRun.progress.length > 0" class="tool-run-steps">
                <div
                  v-for="(step, stepIndex) in block.toolRun.progress"
                  :key="`${block.toolRun.id}-${stepIndex}`"
                  class="tool-run-step"
                >
                  <span class="tool-run-step-index">{{ stepIndex + 1 }}</span>
                  <div class="tool-run-step-body">
                    <div class="tool-run-step-stage">{{ step.stage }}</div>
                    <div v-if="step.detail" class="tool-run-step-detail">{{ step.detail }}</div>
                  </div>
                </div>
              </div>
            </div>

            <div
              v-else-if="block.kind === 'file_preview'"
              class="message-event-card file-preview-panel"
              :class="{ active: block.active }"
            >
              <div class="file-preview-header">
                <span class="file-preview-label">正在生成</span>
                <span class="file-preview-path">{{ block.filePath }}</span>
                <span v-if="block.truncated" class="file-preview-truncated">预览已截断</span>
              </div>
              <pre ref="filePreviewRef" class="file-preview-body">{{ block.previewContent }}</pre>
            </div>

            <div
              v-else-if="block.kind === 'content' && (hasRenderableBlock(block) || isStreamingContentBlock(i, msg, blockIndex, getMessageBlocks(msg, i)))"
              class="message-bubble"
              :class="[msg.role, { streaming: isStreamingContentBlock(i, msg, blockIndex, getMessageBlocks(msg, i)) }]"
            >
              <template v-if="hasRenderableBlock(block)">
                <template v-for="(part, partIndex) in getBlockParts(block)" :key="`${block.id}-${partIndex}`">
                  <div
                    v-if="part.type === 'text' && part.text"
                    class="message-text markdown-body"
                    v-html="renderMarkdown(part.text)"
                  ></div>

                  <button
                    v-else-if="part.type === 'image_url' && part.image_url?.url"
                    class="message-image-card"
                    type="button"
                    @click="openLightbox(i, blockIndex, partIndex)"
                  >
                    <img :src="part.image_url.url" class="message-image" />
                    <span class="message-image-action">点击查看大图</span>
                  </button>
                </template>
              </template>
              <div v-else class="message-placeholder">{{ msg.role === 'assistant' ? '正在流式输出…' : collapseWhitespace(getMessageText(msg)) }}</div>

              <!-- <div v-if="isStreamingContentBlock(i, msg, blockIndex, getMessageBlocks(msg, i))" class="bubble-status">
                <span class="bubble-status-dot"></span>
                <span class="bubble-status-text">实时输出中</span>
              </div> -->
            </div>
          </template>
        </div>
      </div>

      <div v-if="msg.role === 'user'" class="message-avatar user-avatar">{{ getAvatarLabel(msg) }}</div>
    </div>

    <div v-if="lightboxImage" class="image-lightbox" @click.self="closeLightbox">
      <div class="image-lightbox-dialog">
        <div class="image-lightbox-toolbar">
          <div class="image-lightbox-meta">
            <span class="image-lightbox-title">图片预览</span>
            <span class="image-lightbox-counter">{{ (lightboxIndex ?? 0) + 1 }} / {{ galleryImages.length }}</span>
          </div>
          <div class="image-lightbox-actions">
            <button class="image-lightbox-btn secondary" type="button" :disabled="!canShowPreviousImage" @click="showPreviousImage">上一张</button>
            <button class="image-lightbox-btn secondary" type="button" :disabled="!canShowNextImage" @click="showNextImage">下一张</button>
            <span class="image-lightbox-zoom">{{ lightboxZoomPercent }}</span>
            <button class="image-lightbox-btn secondary" type="button" :disabled="lightboxZoom <= 1" @click="zoomOutLightbox">缩小</button>
            <button class="image-lightbox-btn secondary" type="button" @click="resetLightboxZoom">100%</button>
            <button class="image-lightbox-btn secondary" type="button" :disabled="lightboxZoom >= 4" @click="zoomInLightbox">放大</button>
            <button class="image-lightbox-btn" type="button" @click="downloadImage(lightboxImage.url)">下载到本地</button>
            <button class="image-lightbox-btn secondary" type="button" @click="closeLightbox">关闭</button>
          </div>
        </div>
        <div ref="lightboxBodyRef" class="image-lightbox-body" @wheel="handleLightboxWheel">
          <div class="image-lightbox-stage" :style="lightboxStageStyle">
            <img
              :src="lightboxImage.url"
              class="image-lightbox-image"
              :class="{ zoomable: lightboxZoom < 4 }"
              :style="lightboxImageStyle"
              @load="handleLightboxImageLoad"
              @click.stop="handleLightboxImageClick"
            />
          </div>
        </div>
        <div v-if="galleryImages.length > 1" class="image-lightbox-strip">
          <button
            v-for="(image, imageIndex) in galleryImages"
            :key="`${image.messageIndex}-${image.blockIndex}-${image.partIndex}-${imageIndex}`"
            class="image-lightbox-thumb"
            :class="{ active: imageIndex === lightboxIndex }"
            type="button"
            @click="selectLightboxImage(imageIndex)"
          >
            <img :src="image.url" class="image-lightbox-thumb-image" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 24px 28px 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 0;
}

.empty-state-card {
  width: min(560px, 100%);
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

.message-row {
  display: flex;
  align-items: flex-end;
  gap: 14px;
}

.message-row.user {
  justify-content: flex-end;
}

.message-row.assistant {
  justify-content: flex-start;
}

.message-avatar {
  width: 40px;
  height: 40px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 0.82rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.12);
}

.assistant-avatar {
  background: linear-gradient(135deg, var(--app-accent), #7aa7ff);
  color: #ffffff;
}

.user-avatar {
  background: linear-gradient(135deg, #22c55e, #16a34a);
  color: #ffffff;
}

.message-column {
  width: min(820px, calc(100% - 54px));
  max-width: calc(100% - 54px);
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.message-column.user {
  align-items: flex-end;
}

.message-column.assistant {
  align-items: flex-start;
}

.message-flow {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.message-flow.user {
  align-items: flex-end;
}

.message-flow.assistant {
  align-items: flex-start;
}

.message-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 20px;
}

.message-meta.user {
  justify-content: flex-end;
}

.message-author {
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--app-text-strong);
}

.message-model-chip {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text-muted);
  font-size: 0.76rem;
}

.message-event-card {
  width: min(100%, 760px);
  border: 1px solid var(--app-border-strong);
  border-radius: 18px;
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);
  overflow: hidden;
}

.message-event-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel-muted);
}

.message-event-kicker {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--app-text-strong);
}

.message-event-status {
  font-size: 0.74rem;
  color: var(--app-text-muted);
}

.message-event-body {
  padding: 14px 16px 16px;
  color: var(--app-text-muted);
  line-height: 1.68;
}

.tool-event-card.running {
  border-color: var(--app-accent-glow);
}

.tool-event-card {
  padding: 14px 16px;
}

.tool-event-card.completed {
  border-color: rgba(34, 197, 94, 0.22);
}

.tool-event-card.failed {
  border-color: rgba(239, 68, 68, 0.22);
}

.message-bubble {
  width: fit-content;
  max-width: 100%;
  padding: 16px 18px;
  border-radius: 22px;
  border: 1px solid var(--app-border-strong);
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.08);
}

.message-bubble.assistant {
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  color: var(--app-text);
  border-top-left-radius: 10px;
}

.message-bubble.user {
  background: linear-gradient(180deg, var(--app-accent-soft), rgba(91, 140, 255, 0.12));
  color: var(--app-text-strong);
  border-color: var(--app-accent-glow);
  border-top-right-radius: 10px;
}

.message-bubble.streaming {
  border-color: var(--app-accent-glow);
  box-shadow: 0 18px 40px rgba(91, 140, 255, 0.12);
}

.message-placeholder {
  color: var(--app-text-muted);
  min-width: 160px;
}

.bubble-status {
  margin-top: 12px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--app-text-faint);
  font-size: 0.78rem;
}

.bubble-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--app-accent);
  box-shadow: 0 0 0 0 rgba(91, 140, 255, 0.4);
  animation: pulseDot 1.4s ease infinite;
}

@keyframes pulseDot {
  0% { box-shadow: 0 0 0 0 rgba(91, 140, 255, 0.38); }
  70% { box-shadow: 0 0 0 10px rgba(91, 140, 255, 0); }
  100% { box-shadow: 0 0 0 0 rgba(91, 140, 255, 0); }
}

.message-text + .message-text {
  margin-top: 10px;
}

.message-text + .message-image-card,
.message-image-card + .message-text,
.message-image-card + .message-image-card {
  margin-top: 12px;
}

.message-bubble :deep(p) { margin: 0.45em 0; }
.message-bubble :deep(p:first-child) { margin-top: 0; }
.message-bubble :deep(p:last-child) { margin-bottom: 0; }

.message-bubble :deep(pre) {
  background: var(--app-panel-strong);
  border: 1px solid var(--app-border-strong);
  border-radius: 12px;
  padding: 12px 14px;
  overflow-x: auto;
  font-size: 0.85em;
  line-height: 1.55;
  margin: 10px 0;
}

.message-bubble :deep(code) {
  font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
  font-size: 0.9em;
}

.message-bubble :deep(:not(pre) > code) {
  background: var(--app-panel-muted);
  padding: 2px 6px;
  border-radius: 6px;
  color: var(--app-accent-strong);
}

.message-bubble :deep(ul),
.message-bubble :deep(ol) {
  padding-left: 1.45em;
  margin: 0.45em 0;
}

.message-bubble :deep(li) { margin: 0.24em 0; }

.message-bubble :deep(h1),
.message-bubble :deep(h2),
.message-bubble :deep(h3),
.message-bubble :deep(h4) {
  margin: 0.65em 0 0.32em;
  line-height: 1.35;
}

.message-bubble :deep(h1) { font-size: 1.22em; }
.message-bubble :deep(h2) { font-size: 1.12em; }
.message-bubble :deep(h3) { font-size: 1.02em; }

.message-bubble :deep(blockquote) {
  border-left: 3px solid var(--app-accent);
  padding-left: 12px;
  color: var(--app-text-muted);
  margin: 0.55em 0;
}

.message-bubble :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.55em 0;
  font-size: 0.9em;
}

.message-bubble :deep(th),
.message-bubble :deep(td) {
  border: 1px solid var(--app-border-strong);
  padding: 6px 10px;
  text-align: left;
}

.message-bubble :deep(th) {
  background: var(--app-panel-muted);
  font-weight: 600;
}

.message-bubble :deep(a) {
  color: var(--app-accent-strong);
  text-decoration: none;
}

.message-bubble :deep(a:hover) {
  text-decoration: underline;
}

.message-bubble :deep(hr) {
  border: none;
  border-top: 1px solid var(--app-border-strong);
  margin: 0.9em 0;
}

.message-image-card {
  display: inline-flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  max-width: min(340px, 100%);
  padding: 8px;
  background: var(--app-panel);
  border: 1px solid var(--app-border-strong);
  border-radius: 16px;
  cursor: zoom-in;
  transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
}

.message-image-card:hover {
  transform: translateY(-1px);
  border-color: var(--app-accent-glow);
  box-shadow: 0 12px 26px rgba(0, 0, 0, 0.12);
}

.message-image {
  display: block;
  width: 100%;
  max-width: 324px;
  max-height: 324px;
  object-fit: cover;
  border-radius: 12px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
}

.message-image-action {
  font-size: 0.78rem;
  color: var(--app-text-muted);
}

.tool-run-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.tool-run-name {
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--app-text-strong);
}

.tool-run-status {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 0.74rem;
  border: 1px solid var(--app-border-strong);
  color: var(--app-text-muted);
  background: var(--app-panel-strong);
}

.tool-run-status.running {
  border-color: var(--app-accent-glow);
  color: var(--app-accent-strong);
  background: var(--app-accent-soft);
}

.tool-run-status.completed {
  border-color: rgba(34, 197, 94, 0.26);
  color: #15803d;
  background: rgba(34, 197, 94, 0.12);
}

.tool-run-status.failed {
  border-color: rgba(239, 68, 68, 0.25);
  color: #dc2626;
  background: rgba(239, 68, 68, 0.12);
}

.tool-run-steps {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tool-run-step {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.tool-run-step-index {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--app-panel-strong);
  border: 1px solid var(--app-border-strong);
  color: var(--app-text-muted);
  font-size: 0.72rem;
}

.tool-run-step-body {
  min-width: 0;
}

.tool-run-step-stage {
  font-size: 0.82rem;
  color: var(--app-text);
}

.tool-run-step-detail {
  margin-top: 3px;
  font-size: 0.76rem;
  color: var(--app-text-muted);
  word-break: break-word;
}

.file-preview-panel {
  border: 1px solid var(--app-border-strong);
  border-radius: 14px;
  background: var(--app-panel);
  overflow: hidden;
}

.file-preview-panel.active {
  border-color: var(--app-accent-glow);
}

.file-preview-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--app-border-strong);
  background: var(--app-panel-muted);
  font-size: 0.78rem;
  color: var(--app-text-soft);
}

.file-preview-label {
  color: var(--app-text-muted);
  flex-shrink: 0;
}

.file-preview-path {
  font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-preview-truncated {
  margin-left: auto;
  color: #d97706;
  flex-shrink: 0;
}

.file-preview-body {
  margin: 0;
  padding: 12px 14px;
  background: var(--app-panel-strong);
  color: var(--app-text-soft);
  font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
  font-size: 0.83rem;
  line-height: 1.45;
  max-height: calc(1.45em * 6 + 28px);
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-width: thin;
}

.image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: rgba(9, 13, 20, 0.78);
  backdrop-filter: blur(16px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.image-lightbox-dialog {
  width: min(960px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  background: var(--app-panel);
  border: 1px solid var(--app-border-strong);
  border-radius: 20px;
  overflow: hidden;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
}

.image-lightbox-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--app-border);
}

.image-lightbox-meta {
  display: flex;
  align-items: center;
  gap: 10px;
}

.image-lightbox-title {
  font-size: 0.95rem;
  color: var(--app-text-strong);
  font-weight: 600;
}

.image-lightbox-counter {
  font-size: 0.82rem;
  color: var(--app-text-muted);
}

.image-lightbox-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.image-lightbox-zoom {
  min-width: 60px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text-muted);
  font-size: 0.82rem;
  text-align: center;
}

.image-lightbox-btn {
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--app-accent-glow);
  background: var(--app-accent-soft);
  color: var(--app-text-strong);
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease;
}

.image-lightbox-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.image-lightbox-btn:hover {
  background: var(--app-panel-muted);
  border-color: var(--app-accent);
}

.image-lightbox-btn:disabled:hover {
  background: transparent;
  border-color: var(--app-border-strong);
}

.image-lightbox-btn.secondary {
  border-color: var(--app-border-strong);
  background: transparent;
}

.image-lightbox-body {
  padding: 20px;
  overflow: auto;
  overscroll-behavior: contain;
  overflow-anchor: none;
  min-height: 280px;
  background: var(--app-panel-strong);
  scrollbar-gutter: stable both-edges;
  scrollbar-width: thin;
  scrollbar-color: var(--app-border-strong) transparent;
}

.image-lightbox-body::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.image-lightbox-body::-webkit-scrollbar-thumb {
  background: var(--app-border-strong);
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: padding-box;
}

.image-lightbox-body::-webkit-scrollbar-track {
  background: transparent;
}

.image-lightbox-stage {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  min-width: 100%;
  min-height: 100%;
}

.image-lightbox-image {
  display: block;
  max-width: none;
  max-height: none;
  border-radius: 14px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  cursor: default;
  transition: border-color 0.18s ease;
  user-select: none;
}

.image-lightbox-image.zoomable {
  cursor: zoom-in;
}

.image-lightbox-strip {
  display: flex;
  gap: 10px;
  padding: 14px 18px 18px;
  overflow-x: auto;
  border-top: 1px solid var(--app-border);
  background: var(--app-panel);
}

.image-lightbox-thumb {
  flex: 0 0 auto;
  width: 68px;
  height: 68px;
  padding: 4px;
  border-radius: 12px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  cursor: pointer;
  transition: border-color 0.16s ease, transform 0.16s ease, box-shadow 0.16s ease;
}

.image-lightbox-thumb:hover {
  transform: translateY(-1px);
  border-color: var(--app-accent-glow);
}

.image-lightbox-thumb.active {
  border-color: var(--app-accent);
  box-shadow: 0 0 0 1px var(--app-accent-glow);
}

.image-lightbox-thumb-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 8px;
}

@media (max-width: 860px) {
  .chat-messages {
    padding: 20px 16px 16px;
  }

  .message-column {
    width: min(100%, calc(100% - 50px));
    max-width: calc(100% - 50px);
  }

  .message-bubble {
    width: 100%;
  }

  .image-lightbox-dialog {
    width: calc(100vw - 24px);
    max-height: calc(100vh - 24px);
  }
}
</style>