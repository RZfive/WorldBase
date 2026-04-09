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
          <span class="mermaid-preview-title">Mermaid 图表预览</span>
          <span class="mermaid-preview-hint">滚轮缩放，按住拖拽查看细节</span>
        </div>
        <div class="mermaid-preview-actions">
          <span class="mermaid-preview-zoom">{{ zoomPercent }}</span>
          <button class="mermaid-preview-btn secondary" type="button" :disabled="zoom <= MIN_ZOOM" @click="zoomOut">缩小</button>
          <button class="mermaid-preview-btn secondary" type="button" @click="resetView">重置</button>
          <button class="mermaid-preview-btn secondary" type="button" :disabled="zoom >= MAX_ZOOM" @click="zoomIn">放大</button>
          <button class="mermaid-preview-btn" type="button" @click="closeDialog">关闭</button>
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
  padding: 24px;
  background: rgba(9, 13, 20, 0.78);
  backdrop-filter: blur(16px);
}

.mermaid-preview-dialog {
  width: min(1200px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 22px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
}

.mermaid-preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--app-border);
}

.mermaid-preview-meta,
.mermaid-preview-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.mermaid-preview-title {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--app-text-strong);
}

.mermaid-preview-hint {
  font-size: 0.8rem;
  color: var(--app-text-muted);
}

.mermaid-preview-zoom {
  min-width: 60px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text-muted);
  font-size: 0.82rem;
  text-align: center;
}

.mermaid-preview-btn {
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--app-accent-glow);
  background: var(--app-accent-soft);
  color: var(--app-text-strong);
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease;
}

.mermaid-preview-btn.secondary {
  border-color: var(--app-border-strong);
  background: transparent;
}

.mermaid-preview-btn:hover {
  background: var(--app-panel-muted);
  border-color: var(--app-accent);
}

.mermaid-preview-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.mermaid-preview-body {
  flex: 1;
  min-height: 360px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background:
    radial-gradient(circle at center, rgba(91, 140, 255, 0.08), transparent 55%),
    var(--app-panel-strong);
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
    width: calc(100vw - 24px);
    max-height: calc(100vh - 24px);
  }

  .mermaid-preview-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .mermaid-preview-body {
    padding: 16px;
  }
}
</style>
