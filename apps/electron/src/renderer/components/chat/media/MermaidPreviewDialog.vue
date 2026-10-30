<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import MermaidDiagram from './MermaidDiagram.vue'

interface MermaidPreviewPayload {
  code: string
}

const props = defineProps<{
  diagram: MermaidPreviewPayload | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const zoom = ref(1)
const offset = ref({ x: 0, y: 0 })
const isDragging = ref(false)
const dragStart = ref({ x: 0, y: 0, offsetX: 0, offsetY: 0 })

const MIN_ZOOM = 0.6
const MAX_ZOOM = 3
const ZOOM_STEP = 0.2

const zoomPercent = computed(() => `${Math.round(zoom.value * 100)}%`)
const diagramTransformStyle = computed(() => ({
  transform: `translate(${offset.value.x}px, ${offset.value.y}px) scale(${zoom.value})`
}))

function setZoom (nextZoom: number) {
  zoom.value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(nextZoom.toFixed(2))))
}

function zoomIn () { setZoom(zoom.value + ZOOM_STEP) }
function zoomOut () { setZoom(zoom.value - ZOOM_STEP) }

function resetView () {
  zoom.value = 1
  offset.value = { x: 0, y: 0 }
}

function closeDialog () {
  isDragging.value = false
  emit('close')
}

function handlePointerDown (event: PointerEvent) {
  if (!props.diagram || event.button !== 0) return
  isDragging.value = true
  dragStart.value = {
    x: event.clientX,
    y: event.clientY,
    offsetX: offset.value.x,
    offsetY: offset.value.y
  }
}

function handlePointerMove (event: PointerEvent) {
  if (!isDragging.value) return
  offset.value = {
    x: dragStart.value.offsetX + event.clientX - dragStart.value.x,
    y: dragStart.value.offsetY + event.clientY - dragStart.value.y
  }
}

function handlePointerUp () {
  isDragging.value = false
}

function handleWheel (event: WheelEvent) {
  if (!props.diagram) return
  event.preventDefault()
  setZoom(zoom.value * Math.exp(-event.deltaY * 0.0018))
}

function handleWindowKeydown (event: KeyboardEvent) {
  if (!props.diagram) return
  if (event.key === 'Escape') { closeDialog(); return }
  if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomIn(); return }
  if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomOut(); return }
  if (event.key === '0') { event.preventDefault(); resetView() }
}

watch(() => props.diagram?.code, () => {
  if (props.diagram) resetView()
})

onMounted(() => {
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', handlePointerUp)
  window.addEventListener('keydown', handleWindowKeydown)
})

onUnmounted(() => {
  window.removeEventListener('pointermove', handlePointerMove)
  window.removeEventListener('pointerup', handlePointerUp)
  window.removeEventListener('keydown', handleWindowKeydown)
})
</script>

<template>
  <div v-if="props.diagram" class="mermaid-preview" @click.self="closeDialog">
    <div class="mermaid-preview-dialog">
      <div class="mermaid-preview-toolbar">
        <div class="mermaid-preview-meta">
          <span class="mermaid-preview-title">{{ $t('chatUi.mermaidPreview') }}</span>
          <span class="mermaid-preview-hint">{{ $t('chatUi.mermaidPreviewHint') }}</span>
        </div>
        <div class="mermaid-preview-actions">
          <span class="mermaid-preview-zoom">{{ zoomPercent }}</span>
          <button class="mermaid-preview-btn secondary" type="button" :disabled="zoom <= MIN_ZOOM" @click="zoomOut">{{ $t('chatUi.zoomOut') }}</button>
          <button class="mermaid-preview-btn secondary" type="button" @click="resetView">{{ $t('chatUi.reset') }}</button>
          <button class="mermaid-preview-btn secondary" type="button" :disabled="zoom >= MAX_ZOOM" @click="zoomIn">{{ $t('chatUi.zoomIn') }}</button>
          <button class="mermaid-preview-btn" type="button" @click="closeDialog">{{ $t('common.close') }}</button>
        </div>
      </div>

      <div
        class="mermaid-preview-body"
        :class="{ dragging: isDragging }"
        @wheel="handleWheel"
        @pointerdown="handlePointerDown"
      >
        <div class="mermaid-preview-transform" :style="diagramTransformStyle">
          <MermaidDiagram :code="props.diagram.code" mode="preview" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mermaid-preview {
  position: fixed;
  inset: 0;
  z-index: 1250;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  /* No scrim, matching the image lightbox: the diagram floats over the app
     and the conversation behind it stays readable. */
  background: transparent;
}

.mermaid-preview-dialog {
  width: min(1440px, calc(100vw - 64px));
  height: min(960px, calc(100vh - 64px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  box-shadow: var(--shadow-3);
  animation: mermaid-preview-enter 160ms var(--ease-out);
}

@keyframes mermaid-preview-enter {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.99);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.mermaid-preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel-strong);
}

.mermaid-preview-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.mermaid-preview-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.mermaid-preview-title {
  font-size: 0.86rem;
  font-weight: 500;
  color: var(--app-text-soft);
  letter-spacing: 0.01em;
}

.mermaid-preview-hint {
  font-size: 0.74rem;
  color: var(--app-text-faint);
}

.mermaid-preview-zoom {
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

.mermaid-preview-btn {
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

.mermaid-preview-btn.secondary {
  border-color: var(--app-border-strong);
  background: transparent;
  color: var(--app-text-soft);
}

.mermaid-preview-btn:hover:not(:disabled) {
  background: var(--app-panel-muted);
  border-color: var(--app-border-strong);
}

.mermaid-preview-btn.secondary:hover:not(:disabled) {
  color: var(--app-text-strong);
}

.mermaid-preview-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.mermaid-preview-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  background: var(--app-chat-canvas);
  cursor: grab;
  user-select: none;
}

.mermaid-preview-body.dragging {
  cursor: grabbing;
}

.mermaid-preview-transform {
  transform-origin: center center;
  transition: transform 0.12s ease;
}

@media (max-width: 860px) {
  .mermaid-preview {
    padding: 12px;
  }

  .mermaid-preview-dialog {
    width: 100%;
    height: calc(100vh - 24px);
  }

  .mermaid-preview-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .mermaid-preview-body {
    padding: 12px;
  }
}
</style>
