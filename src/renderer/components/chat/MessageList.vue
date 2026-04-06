<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { renderMarkdown } from './markdown'

interface ChatContentPart {
  type: string
  text?: string
  image_url?: { url: string }
}

interface ChatMessage {
  role: string
  content: string | ChatContentPart[]
  thinking?: string
}

interface GalleryImage {
  url: string
  messageIndex: number
  partIndex: number
}

const props = defineProps<{
  messages: ChatMessage[]
  isLoading: boolean
  toolStatus: string
  progressSteps: Array<{ stage: string; detail?: string }>
  filePreview: { active: boolean; filePath: string; content: string; truncated: boolean }
}>()

const messagesContainer = ref<HTMLElement | null>(null)
const streamingLineRef = ref<HTMLElement | null>(null)
const progressLineRef = ref<HTMLElement | null>(null)
const filePreviewRef = ref<HTMLElement | null>(null)
const lightboxBodyRef = ref<HTMLElement | null>(null)
const expandedThinking = ref<Record<number, boolean>>({})
const lightboxIndex = ref<number | null>(null)
const lightboxZoom = ref(1)
const lightboxNaturalSize = ref({ width: 0, height: 0 })
const lightboxViewport = ref({ width: 0, height: 0 })

const MIN_LIGHTBOX_ZOOM = 1
const MAX_LIGHTBOX_ZOOM = 4
const LIGHTBOX_ZOOM_STEP = 0.25

const latestProgressText = computed(() => {
  const latest = props.progressSteps[props.progressSteps.length - 1]
  if (!latest) return ''
  return latest.detail ? `${latest.stage} ${latest.detail}` : latest.stage
})

const galleryImages = computed<GalleryImage[]>(() => {
  const images: GalleryImage[] = []

  props.messages.forEach((message, messageIndex) => {
    getMessageParts(message).forEach((part, partIndex) => {
      if (part.type === 'image_url' && part.image_url?.url) {
        images.push({
          url: part.image_url.url,
          messageIndex,
          partIndex
        })
      }
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
  if (!metrics) {
    return {}
  }

  return {
    width: `${metrics.stageWidth}px`,
    height: `${metrics.stageHeight}px`
  }
})

const lightboxImageStyle = computed(() => {
  const metrics = lightboxMetrics.value
  if (!metrics) {
    return {}
  }

  return {
    width: `${metrics.renderedWidth}px`,
    height: `${metrics.renderedHeight}px`
  }
})

function getMessageText (msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(part => part.type === 'text')
      .map(part => part.text || '')
      .join('')
  }
  return ''
}

function getMessageParts (msg: ChatMessage): ChatContentPart[] {
  if (typeof msg.content === 'string') {
    return msg.content ? [{ type: 'text', text: msg.content }] : []
  }
  return msg.content
}

function collapseWhitespace (text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function toggleThinking (index: number) {
  expandedThinking.value[index] = !expandedThinking.value[index]
}

function getGalleryIndex (messageIndex: number, partIndex: number): number {
  return galleryImages.value.findIndex(image => image.messageIndex === messageIndex && image.partIndex === partIndex)
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
    if (!metrics) return

    if (previousZoom === nextZoom) {
      return
    }

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

  if (nextZoom === previousZoom) {
    return
  }

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

function openLightbox (messageIndex: number, partIndex: number) {
  const index = getGalleryIndex(messageIndex, partIndex)
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
  if (!lightboxImage.value) return

  if (!event.ctrlKey) {
    return
  }

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
  () => {
    const last = props.messages[props.messages.length - 1]
    return last?.content
  },
  () => {
    scrollToBottom()
    nextTick(() => {
      if (streamingLineRef.value) {
        streamingLineRef.value.scrollLeft = streamingLineRef.value.scrollWidth
      }
    })
  }
)

watch(
  () => props.progressSteps.length,
  () => {
    nextTick(() => {
      if (progressLineRef.value) {
        progressLineRef.value.scrollLeft = progressLineRef.value.scrollWidth
      }
    })
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
  () => galleryImages.value.map(image => `${image.messageIndex}:${image.partIndex}:${image.url}`).join('|'),
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
      <p>👋 你好！我是 The World AI 助手。</p>
      <p>你可以让我：</p>
      <ul>
        <li>创建一个新的 Web 应用项目</li>
        <li>修改现有项目的后端代码</li>
        <li>分析项目中的数据</li>
        <li>调用项目的 API 进行测试</li>
      </ul>
    </div>

    <div
      v-for="(msg, i) in props.messages"
      :key="i"
      :class="['message', msg.role]"
    >
      <div class="message-role">
        {{ msg.role === 'user' ? '🧑 你' : '🤖 AI' }}
      </div>

      <div v-if="msg.thinking" class="thinking-block">
        <div class="thinking-header" @click="toggleThinking(i)">
          <span class="thinking-icon">💭</span>
          <span class="thinking-label">思考过程</span>
          <span class="thinking-toggle">{{ expandedThinking[i] ? '▼' : '▶' }}</span>
        </div>
        <div v-if="expandedThinking[i]" class="thinking-content" v-html="renderMarkdown(msg.thinking)"></div>
      </div>

      <div
        v-if="props.isLoading && i === props.messages.length - 1 && msg.role === 'assistant'"
        ref="streamingLineRef"
        class="message-content streaming-line"
      >
        {{ collapseWhitespace(getMessageText(msg)) || 'AI 正在生成内容…' }}
      </div>

      <div v-else class="message-content">
        <template v-for="(part, partIndex) in getMessageParts(msg)" :key="`${i}-${partIndex}`">
          <div
            v-if="part.type === 'text' && part.text"
            class="message-text markdown-body"
            v-html="renderMarkdown(part.text)"
          ></div>

          <button
            v-else-if="part.type === 'image_url' && part.image_url?.url"
            class="message-image-card"
            type="button"
            @click="openLightbox(i, partIndex)"
          >
            <img :src="part.image_url.url" class="message-image" />
            <span class="message-image-action">点击放大</span>
          </button>
        </template>
      </div>

      <span v-if="props.isLoading && i === props.messages.length - 1 && msg.role === 'assistant'" class="cursor-blink">▍</span>
    </div>

    <div v-if="props.filePreview.active" class="file-preview-panel" :class="{ active: props.filePreview.active }">
      <div class="file-preview-header">
        <span class="file-preview-label">正在生成</span>
        <span class="file-preview-path">{{ props.filePreview.filePath }}</span>
        <span v-if="props.filePreview.truncated" class="file-preview-truncated">预览已截断</span>
      </div>
      <pre ref="filePreviewRef" class="file-preview-body">{{ props.filePreview.content }}</pre>
    </div>

    <div v-if="!props.filePreview.active && (props.toolStatus || props.progressSteps.length > 0)" class="tool-progress-panel">
      <div v-if="props.toolStatus" class="tool-status-header">
        <span class="tool-status-icon">🔧</span>
        <span class="tool-status-text">{{ props.toolStatus }}</span>
        <span class="tool-status-spinner"></span>
      </div>
      <div v-if="props.progressSteps.length > 0" class="progress-steps">
        <div ref="progressLineRef" class="progress-step step-latest">
          {{ latestProgressText }}
        </div>
      </div>
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
            :key="`${image.messageIndex}-${image.partIndex}-${imageIndex}`"
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
  padding: 16px 24px;
}

.empty-state {
  color: var(--app-text-muted);
  padding: 40px 0;
  text-align: center;
}

.empty-state ul {
  list-style: none;
  padding: 0;
}

.empty-state li {
  padding: 4px 0;
}

.empty-state li::before {
  content: "• ";
  color: var(--app-accent);
}

.message {
  margin-bottom: 16px;
  padding: 12px 16px;
  border-radius: 12px;
  border: 1px solid var(--app-border);
  color: var(--app-text);
}

.message.user {
  background: var(--app-accent-soft);
  border-color: var(--app-accent-glow);
  margin-left: 40px;
}

.message.assistant {
  background: var(--app-panel-subtle);
  margin-right: 40px;
}

.message-role {
  font-size: 0.75em;
  color: var(--app-text-muted);
  margin-bottom: 4px;
}

.message-content {
  word-break: break-word;
  line-height: 1.6;
}

.message-text + .message-text {
  margin-top: 8px;
}

.message-text + .message-image-card,
.message-image-card + .message-text,
.message-image-card + .message-image-card {
  margin-top: 10px;
}

.streaming-line {
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  scrollbar-width: none;
  font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
}

.streaming-line::-webkit-scrollbar {
  display: none;
}

/* Markdown content styles */
.message-content :deep(p) { margin: 0.4em 0; }
.message-content :deep(p:first-child) { margin-top: 0; }
.message-content :deep(p:last-child) { margin-bottom: 0; }

.message-content :deep(pre) {
  background: var(--app-panel-strong);
  border: 1px solid var(--app-border-strong);
  border-radius: 8px;
  padding: 12px 16px;
  overflow-x: auto;
  font-size: 0.85em;
  line-height: 1.5;
  margin: 8px 0;
}

.message-content :deep(code) {
  font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
  font-size: 0.9em;
}

.message-content :deep(:not(pre) > code) {
  background: var(--app-panel-muted);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--app-accent-strong);
}

.message-content :deep(ul),
.message-content :deep(ol) {
  padding-left: 1.5em;
  margin: 0.4em 0;
}

.message-content :deep(li) { margin: 0.2em 0; }

.message-content :deep(h1),
.message-content :deep(h2),
.message-content :deep(h3),
.message-content :deep(h4) {
  margin: 0.6em 0 0.3em;
  line-height: 1.3;
}

.message-content :deep(h1) { font-size: 1.3em; }
.message-content :deep(h2) { font-size: 1.15em; }
.message-content :deep(h3) { font-size: 1.05em; }

.message-content :deep(blockquote) {
  border-left: 3px solid var(--app-accent);
  padding-left: 12px;
  color: var(--app-text-muted);
  margin: 0.5em 0;
}

.message-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.5em 0;
  font-size: 0.9em;
}

.message-content :deep(th),
.message-content :deep(td) {
  border: 1px solid var(--app-border-strong);
  padding: 6px 10px;
  text-align: left;
}

.message-content :deep(th) {
  background: var(--app-panel-muted);
  font-weight: 600;
}

.message-content :deep(a) { color: var(--app-accent-strong); text-decoration: none; }
.message-content :deep(a:hover) { text-decoration: underline; }

.message-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--app-border-strong);
  margin: 0.8em 0;
}

.message-image-card {
  display: inline-flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  max-width: min(320px, 100%);
  padding: 8px;
  background: var(--app-panel);
  border: 1px solid var(--app-border-strong);
  border-radius: 14px;
  cursor: zoom-in;
  transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
}

.message-image-card:hover {
  transform: translateY(-1px);
  border-color: var(--app-accent-glow);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.12);
}

.message-image {
  display: block;
  width: 100%;
  max-width: 304px;
  max-height: 304px;
  object-fit: cover;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
}

.message-image-action {
  font-size: 0.78em;
  color: var(--app-text-muted);
}

/* Thinking block */
.thinking-block {
  margin-bottom: 8px;
  border: 1px solid var(--app-border-strong);
  border-radius: 8px;
  overflow: hidden;
  background: var(--app-panel-strong);
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 0.82em;
  color: var(--app-accent);
  user-select: none;
}

.thinking-header:hover { background: var(--app-panel-muted); }
.thinking-icon { font-size: 1em; }
.thinking-label { flex: 1; font-weight: 500; }
.thinking-toggle { font-size: 0.7em; color: var(--app-text-faint); }

.thinking-content {
  padding: 8px 12px;
  border-top: 1px solid var(--app-border);
  font-size: 0.82em;
  color: var(--app-text-muted);
  line-height: 1.5;
  max-height: 300px;
  overflow-y: auto;
}

.thinking-content :deep(p) { margin: 0.3em 0; }

.cursor-blink {
  animation: blink 0.8s infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* Tool progress panel */
.tool-progress-panel {
  margin: 8px 0;
  background: var(--app-panel-strong);
  border: 1px solid var(--app-border);
  border-radius: 10px;
  overflow: hidden;
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.tool-status-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  font-size: 0.82em;
  color: var(--app-accent);
  border-bottom: 1px solid var(--app-border);
}

.tool-status-icon { flex-shrink: 0; }
.tool-status-text { flex: 1; }

.tool-status-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--app-border-strong);
  border-top-color: var(--app-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.progress-steps { padding: 6px 0; }

.progress-step {
  display: block;
  padding: 3px 14px;
  font-size: 0.78em;
  color: var(--app-text-faint);
  animation: stepSlideIn 0.25s ease;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  scrollbar-width: none;
}

.progress-step::-webkit-scrollbar { display: none; }

.progress-step.step-latest { color: var(--app-text-muted); }

@keyframes stepSlideIn {
  from { opacity: 0; transform: translateX(-8px); }
  to { opacity: 1; transform: translateX(0); }
}

.file-preview-panel {
  margin: 8px 0;
  border: 1px solid var(--app-border-strong);
  border-radius: 12px;
  background: var(--app-panel);
  overflow: hidden;
  animation: fadeIn 0.2s ease;
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
  font-size: 0.78em;
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
  font-size: 0.83em;
  line-height: 1.45;
  max-height: calc(1.45em * 5 + 24px);
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
  font-size: 0.95em;
  color: var(--app-text-strong);
  font-weight: 600;
}

.image-lightbox-counter {
  font-size: 0.82em;
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
  font-size: 0.82em;
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
</style>
