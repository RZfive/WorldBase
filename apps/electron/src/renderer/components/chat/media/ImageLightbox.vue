<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import type { GalleryImage } from '../types'

const props = defineProps<{
  images: GalleryImage[]
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const lightboxBodyRef = ref<HTMLElement | null>(null)
const lightboxIndex = ref<number | null>(null)
const lightboxZoom = ref(1)
const lightboxNaturalSize = ref({ width: 0, height: 0 })
const lightboxViewport = ref({ width: 0, height: 0 })

const MIN_LIGHTBOX_ZOOM = 1
const MAX_LIGHTBOX_ZOOM = 4
const LIGHTBOX_ZOOM_STEP = 0.25

const lightboxImage = computed(() => {
  if (lightboxIndex.value == null) return null
  return props.images[lightboxIndex.value] ?? null
})

const lightboxZoomPercent = computed(() => `${Math.round(lightboxZoom.value * 100)}%`)

const canShowPreviousImage = computed(() => lightboxIndex.value !== null && lightboxIndex.value > 0)
const canShowNextImage = computed(() => lightboxIndex.value !== null && lightboxIndex.value < props.images.length - 1)

const lightboxMetrics = computed(() => {
  const image = lightboxImage.value
  const { width: naturalWidth, height: naturalHeight } = lightboxNaturalSize.value
  const { width: viewportWidth, height: viewportHeight } = lightboxViewport.value

  if (!image || !naturalWidth || !naturalHeight || !viewportWidth || !viewportHeight) return null

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
  return { width: `${metrics.stageWidth}px`, height: `${metrics.stageHeight}px` }
})

const lightboxImageStyle = computed(() => {
  const metrics = lightboxMetrics.value
  if (!metrics) return {}
  return { width: `${metrics.renderedWidth}px`, height: `${metrics.renderedHeight}px` }
})

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

function zoomInLightbox () { setLightboxZoom(lightboxZoom.value + LIGHTBOX_ZOOM_STEP) }
function zoomOutLightbox () { setLightboxZoom(lightboxZoom.value - LIGHTBOX_ZOOM_STEP) }
function resetLightboxZoom () { setLightboxZoom(1) }

function selectLightboxImage (index: number) {
  if (index < 0 || index >= props.images.length) return
  lightboxIndex.value = index
  resetLightboxZoom()
  lightboxNaturalSize.value = { width: 0, height: 0 }
  updateLightboxViewport()
}

function closeLightbox () {
  emit('close')
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

function handleLightboxImageClick () { zoomInLightbox() }

function handleLightboxImageLoad (event: Event) {
  const target = event.target as HTMLImageElement | null
  if (!target) return
  lightboxNaturalSize.value = { width: target.naturalWidth, height: target.naturalHeight }
  updateLightboxViewport()
  centerLightboxScroll()
}

function handleLightboxWheel (event: WheelEvent) {
  if (!lightboxImage.value || !event.ctrlKey) return
  event.preventDefault()
  setLightboxZoom(lightboxZoom.value * Math.exp(-event.deltaY * 0.003))
}

function getDownloadName (imageUrl: string): string {
  const mimeType = imageUrl.match(/^data:(image\/[^;]+);base64,/)?.[1]
  const extension = mimeType?.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
  const timestamp = new Date().toISOString().replace(/[.:]/g, '-')
  return `worldbase-image-${timestamp}.${extension}`
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
  if (event.key === 'Escape') { closeLightbox(); return }
  if (event.key === 'ArrowLeft') { event.preventDefault(); showPreviousImage(); return }
  if (event.key === 'ArrowRight') { event.preventDefault(); showNextImage(); return }
  if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomInLightbox(); return }
  if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomOutLightbox(); return }
  if (event.key === '0') { event.preventDefault(); resetLightboxZoom() }
}

// Sync lightbox state when image gallery changes
watch(
  () => props.images,
  () => {
    if (lightboxIndex.value == null) return
    if (props.images.length === 0) { closeLightbox(); return }
    if (lightboxIndex.value >= props.images.length) {
      lightboxIndex.value = props.images.length - 1
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

/** Open the lightbox at the image matching the given coordinates. */
function open (messageIndex: number, blockIndex: number, partIndex: number) {
  const index = props.images.findIndex(img =>
    img.messageIndex === messageIndex && img.blockIndex === blockIndex && img.partIndex === partIndex
  )
  if (index === -1) return
  selectLightboxImage(index)
}

defineExpose({ open })
</script>

<template>
  <div v-if="lightboxImage" class="image-lightbox" @click.self="closeLightbox">
    <div class="image-lightbox-dialog">
      <div class="image-lightbox-toolbar">
        <div class="image-lightbox-meta">
          <span class="image-lightbox-title">{{ $t('chatUi.imagePreview') }}</span>
          <span class="image-lightbox-counter">{{ (lightboxIndex ?? 0) + 1 }} / {{ props.images.length }}</span>
        </div>
        <div class="image-lightbox-actions">
          <button class="image-lightbox-btn secondary" type="button" :disabled="!canShowPreviousImage" @click="showPreviousImage">{{ $t('chatUi.previousImage') }}</button>
          <button class="image-lightbox-btn secondary" type="button" :disabled="!canShowNextImage" @click="showNextImage">{{ $t('chatUi.nextImage') }}</button>
          <span class="image-lightbox-zoom">{{ lightboxZoomPercent }}</span>
          <button class="image-lightbox-btn secondary" type="button" :disabled="lightboxZoom <= 1" @click="zoomOutLightbox">{{ $t('chatUi.zoomOut') }}</button>
          <button class="image-lightbox-btn secondary" type="button" @click="resetLightboxZoom">100%</button>
          <button class="image-lightbox-btn secondary" type="button" :disabled="lightboxZoom >= 4" @click="zoomInLightbox">{{ $t('chatUi.zoomIn') }}</button>
          <button class="image-lightbox-btn" type="button" @click="downloadImage(lightboxImage.url)">{{ $t('chatUi.downloadLocal') }}</button>
          <button class="image-lightbox-btn secondary" type="button" @click="closeLightbox">{{ $t('common.close') }}</button>
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
      <div v-if="props.images.length > 1" class="image-lightbox-strip">
        <button
          v-for="(image, imageIndex) in props.images"
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
</template>

<style scoped>
.image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  /* No scrim: the dialog floats over the app so the conversation behind stays
     visible. Clicking this transparent layer still closes the preview. */
  background: transparent;
}

.image-lightbox-dialog {
  width: min(920px, calc(100vw - 64px));
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  background: var(--app-panel-strong);
  border: 1px solid var(--app-border-strong);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: var(--shadow-3);
  animation: image-lightbox-enter 160ms var(--ease-out);
}

@keyframes image-lightbox-enter {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.99);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.image-lightbox-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel-strong);
}

.image-lightbox-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.image-lightbox-title {
  font-size: 0.86rem;
  font-weight: 500;
  color: var(--app-text-soft);
  letter-spacing: 0.01em;
}

.image-lightbox-counter {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-faint);
  font-size: 0.74rem;
  font-variant-numeric: tabular-nums;
}

.image-lightbox-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.image-lightbox-zoom {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 52px;
  height: 30px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
  color: var(--app-text-faint);
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
}

.image-lightbox-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  padding: 0 11px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 38%, transparent);
  background: var(--app-accent-soft);
  color: var(--app-text-strong);
  font-size: 0.8rem;
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
}

.image-lightbox-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.image-lightbox-btn:hover:not(:disabled) {
  background: var(--app-panel-muted);
  border-color: var(--app-border-strong);
}

.image-lightbox-btn.secondary {
  border-color: var(--app-border-strong);
  background: transparent;
  color: var(--app-text-soft);
}

.image-lightbox-btn.secondary:hover:not(:disabled) {
  background: var(--app-panel-muted);
  color: var(--app-text-strong);
}

.image-lightbox-body {
  padding: 18px;
  overflow: auto;
  overscroll-behavior: contain;
  overflow-anchor: none;
  min-height: 280px;
  background: var(--app-chat-canvas);
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
  border-radius: 10px;
  border: 1px solid var(--app-border);
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
  gap: 8px;
  padding: 10px 14px 12px;
  overflow-x: auto;
  border-top: 1px solid var(--app-border);
  background: var(--app-panel-strong);
}

.image-lightbox-thumb {
  flex: 0 0 auto;
  width: 56px;
  height: 56px;
  padding: 3px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-subtle);
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
  .image-lightbox {
    padding: 12px;
  }

  .image-lightbox-dialog {
    width: 100%;
    max-height: calc(100vh - 24px);
  }
}
</style>
