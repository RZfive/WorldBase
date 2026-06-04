<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

const props = defineProps<{
  src: string
  alt?: string
}>()

const MIN_ZOOM = 0.5
const MAX_ZOOM = 4
const ZOOM_STEP = 0.25
const ZOOM_DECIMAL_PRECISION = 2
const WHEEL_ZOOM_SENSITIVITY = 0.003
const PRIMARY_MOUSE_BUTTON = 0

const wrapperRef = ref<HTMLElement | null>(null)
const naturalSize = ref({ width: 0, height: 0 })
const viewport = ref({ width: 0, height: 0 })
const zoomLevel = ref(1)
// Pan offset (px) on top of the fitted+zoomed image; 0,0 keeps it centered.
const panX = ref(0)
const panY = ref(0)
const draggingPan = ref(false)
const dragState = ref({ pointerId: -1, startX: 0, startY: 0, panX: 0, panY: 0 })

const zoomPercent = computed(() => `${Math.round(zoomLevel.value * 100)}%`)

const metrics = computed(() => {
  const { width: naturalWidth, height: naturalHeight } = naturalSize.value
  const { width: viewportWidth, height: viewportHeight } = viewport.value
  if (!naturalWidth || !naturalHeight || !viewportWidth || !viewportHeight) return null

  const fitScale = Math.min(viewportWidth / naturalWidth, viewportHeight / naturalHeight, 1)
  const renderedWidth = naturalWidth * fitScale * zoomLevel.value
  const renderedHeight = naturalHeight * fitScale * zoomLevel.value
  return {
    viewportWidth,
    viewportHeight,
    renderedWidth,
    renderedHeight,
    maxPanX: Math.max(0, (renderedWidth - viewportWidth) / 2),
    maxPanY: Math.max(0, (renderedHeight - viewportHeight) / 2)
  }
})

const canPan = computed(() => {
  const m = metrics.value
  return Boolean(m && (m.maxPanX > 0 || m.maxPanY > 0))
})

const imageStyle = computed(() => {
  const m = metrics.value
  if (!m) return {}
  return {
    width: `${m.renderedWidth}px`,
    height: `${m.renderedHeight}px`,
    transform: `translate(${panX.value}px, ${panY.value}px)`
  }
})

function clampPan () {
  const m = metrics.value
  if (!m) {
    panX.value = 0
    panY.value = 0
    return
  }
  panX.value = Math.max(-m.maxPanX, Math.min(m.maxPanX, panX.value))
  panY.value = Math.max(-m.maxPanY, Math.min(m.maxPanY, panY.value))
}

function updateViewport () {
  nextTick(() => {
    if (!wrapperRef.value) return
    viewport.value = { width: wrapperRef.value.clientWidth, height: wrapperRef.value.clientHeight }
    clampPan()
  })
}

function setZoom (zoom: number, anchor?: { x: number; y: number }) {
  const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(zoom.toFixed(ZOOM_DECIMAL_PRECISION))))
  const previousZoom = zoomLevel.value
  if (nextZoom === previousZoom) return

  if (anchor && wrapperRef.value) {
    const rect = wrapperRef.value.getBoundingClientRect()
    const focalX = anchor.x - rect.left - rect.width / 2
    const focalY = anchor.y - rect.top - rect.height / 2
    const ratio = nextZoom / previousZoom
    panX.value = focalX - (focalX - panX.value) * ratio
    panY.value = focalY - (focalY - panY.value) * ratio
  }

  zoomLevel.value = nextZoom
  clampPan()
}

function zoomIn () { setZoom(zoomLevel.value + ZOOM_STEP) }
function zoomOut () { setZoom(zoomLevel.value - ZOOM_STEP) }
function zoomReset () {
  zoomLevel.value = 1
  panX.value = 0
  panY.value = 0
}

function onWheel (event: WheelEvent) {
  event.preventDefault()
  setZoom(zoomLevel.value * Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY), { x: event.clientX, y: event.clientY })
}

function onImageLoad (event: Event) {
  const target = event.target as HTMLImageElement | null
  if (!target) return
  naturalSize.value = { width: target.naturalWidth, height: target.naturalHeight }
  updateViewport()
}

function startPan (event: PointerEvent) {
  if (!canPan.value || event.button !== PRIMARY_MOUSE_BUTTON) return
  draggingPan.value = true
  dragState.value = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    panX: panX.value,
    panY: panY.value
  }
  ;(event.currentTarget as HTMLElement | null)?.setPointerCapture(event.pointerId)
}

function onPointerMove (event: PointerEvent) {
  if (!draggingPan.value || dragState.value.pointerId !== event.pointerId) return
  panX.value = dragState.value.panX + (event.clientX - dragState.value.startX)
  panY.value = dragState.value.panY + (event.clientY - dragState.value.startY)
  clampPan()
}

function endPan (event?: PointerEvent) {
  if (event && dragState.value.pointerId !== -1 && dragState.value.pointerId !== event.pointerId) return
  if (event) {
    ;(event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId)
  }
  draggingPan.value = false
  dragState.value.pointerId = -1
}

// Reset when the image source changes.
watch(() => props.src, () => {
  zoomLevel.value = 1
  panX.value = 0
  panY.value = 0
  draggingPan.value = false
  naturalSize.value = { width: 0, height: 0 }
  updateViewport()
})

onMounted(() => {
  window.addEventListener('resize', updateViewport)
  updateViewport()
})

onUnmounted(() => {
  window.removeEventListener('resize', updateViewport)
})
</script>

<template>
  <div class="preview">
    <div
      ref="wrapperRef"
      class="preview-wrapper"
      :class="{ 'can-pan': canPan, dragging: draggingPan }"
      @wheel="onWheel"
      @pointerdown="startPan"
      @pointermove="onPointerMove"
      @pointerup="endPan"
      @pointercancel="endPan"
    >
      <img
        :src="src"
        :alt="alt || ''"
        class="preview-img"
        :style="imageStyle"
        draggable="false"
        @load="onImageLoad"
      />
    </div>
    <div class="preview-zoom">
      <button class="preview-zoom-btn" type="button" @click="zoomOut" :disabled="zoomLevel <= MIN_ZOOM">−</button>
      <span class="preview-zoom-label" title="点击复位" @click="zoomReset">{{ zoomPercent }}</span>
      <button class="preview-zoom-btn" type="button" @click="zoomIn" :disabled="zoomLevel >= MAX_ZOOM">+</button>
    </div>
  </div>
</template>

<style scoped>
.preview {
  position: relative;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
}

.preview-wrapper {
  width: 100%;
  height: 100%;
  overflow: hidden;
  overscroll-behavior: contain;
  border-radius: 16px;
  background: var(--app-panel-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
  touch-action: none;
}

.preview-wrapper.can-pan { cursor: grab; }
.preview-wrapper.can-pan.dragging { cursor: grabbing; }

.preview-img {
  display: block;
  flex: none;
  max-width: none;
  max-height: none;
  object-fit: contain;
  will-change: transform;
  box-shadow: 0 18px 40px rgba(15, 23, 42, 0.22);
}

.preview-zoom {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.8);
  backdrop-filter: blur(6px);
}

.preview-zoom-btn {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: #fff;
  font-size: 1.1em;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s ease;
}

.preview-zoom-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.15); }
.preview-zoom-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.preview-zoom-label {
  font-size: 0.72em;
  color: #e2e8f0;
  min-width: 40px;
  text-align: center;
  cursor: pointer;
}

.preview-zoom-label:hover { color: #fff; text-decoration: underline; }
</style>
