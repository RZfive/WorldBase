<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MessageRow from './MessageRow.vue'
import type { ChatMessage, FilePreviewState, MinimapRow } from '../types'

const props = defineProps<{
  rows: MinimapRow[]
  messages: ChatMessage[]
  /** Rendered track width of the real message list (px). */
  trackWidth: number
  /** Real scrollable height of the conversation (px, paddings included). */
  totalScrollPx: number
  scrollTopPx: number
  viewportPx: number
  isStreaming: boolean
  /** Group-conversation badge icon shown at the top of the rail. */
  groupIcon?: string
  assistantIcon?: string
  assistantName?: string
}>()

const emit = defineEmits<{
  (e: 'jump', messageIndex: number): void
  (e: 'scrub', ratio: number): void
}>()

const { t } = useI18n()

const INACTIVE_PREVIEW: FilePreviewState = { active: false, filePath: '', lineCount: 0, added: 0, removed: 0 }

const bodyRef = ref<HTMLElement | null>(null)
const bodyHeight = ref(0)
const hoveredRow = ref<MinimapRow | null>(null)
/** Pointer Y inside the rail, driving the tooltip position. */
const hoveredPointerY = ref(12)
const bodyHovered = ref(false)
const isScrubbing = ref(false)
/** Which surface is being dragged: body scrub / indicator handle / global bar. */
const dragMode = ref<'body' | 'handle' | 'global' | null>(null)
const pointerStart = ref({ x: 0, y: 0, at: 0, moved: false })
/** Indicator-drag state: the pointer's offset inside the slider (rail px). */
const handleDrag = ref({ grabRail: 0 })
/** Internal scroll of the miniature (VS Code style: content can be taller than the rail). */
const miniScroll = ref(0)
/** Global-scrollbar drag state (declared early: the sync watch reads it). */
const globalBarRef = ref<HTMLElement | null>(null)
const globalBarHovered = ref(false)
const globalDragging = ref(false)
const globalGrabOffsetRatio = ref(0)

let bodyObserver: ResizeObserver | null = null

/**
 * Safety net: if pointer capture is lost (pointer leaves the window, element
 * moved, etc.) the element-level pointerup never fires and the drag state
 * would stick - killing all further drags. Always release on window-level
 * pointer up/cancel (idempotent with the element handlers).
 */
function releaseDragState (): void {
  if (isScrubbing.value || globalDragging.value || dragMode.value != null) {
    isScrubbing.value = false
    globalDragging.value = false
    dragMode.value = null
    syncMiniScroll(props.scrollTopPx)
  }
}

onMounted(() => {
  const body = bodyRef.value
  if (body) {
    bodyHeight.value = body.clientHeight
    if (typeof ResizeObserver !== 'undefined') {
      bodyObserver = new ResizeObserver(() => {
        bodyHeight.value = bodyRef.value?.clientHeight ?? 0
      })
      bodyObserver.observe(body)
    }
  }
  window.addEventListener('pointerup', releaseDragState)
  window.addEventListener('pointercancel', releaseDragState)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerup', releaseDragState)
  window.removeEventListener('pointercancel', releaseDragState)
  bodyObserver?.disconnect()
  bodyObserver = null
})

/** Miniature body width; keep in sync with the CSS rail geometry (84px rail - 8px slider lane). */
const MINIMAP_BODY_WIDTH = 76

/**
 * VS Code-style scale: width-fit so the content always fills the rail width
 * (uniform aspect). Long conversations make the miniature TALLER than the
 * rail; the rail then scrolls internally, synced to the outer scroll.
 */
const minimapScale = computed(() => {
  if (props.trackWidth <= 0 || props.totalScrollPx <= 0) return 0
  return MINIMAP_BODY_WIDTH / props.trackWidth
})

const miniContentHeight = computed(() => props.totalScrollPx * minimapScale.value)
const maxMiniScroll = computed(() => Math.max(0, miniContentHeight.value - bodyHeight.value))
const maxScrollPx = computed(() => Math.max(props.totalScrollPx - props.viewportPx, 1))

/**
 * VS Code-anchored minimap tracking: the miniature does NOT recenter while
 * scrolling. It stays put (internal scroll 0) until the screen region would
 * leave the rail, then scrolls just enough to keep it visible. So:
 * document top -> miniature shows the head; document bottom -> the tail; in
 * between the slider travels across a static miniature. Adjustments are
 * minimal and only at the edges, which also keeps dragging perfectly linear.
 */
function syncMiniScroll (top: number): void {
  const scale = minimapScale.value
  if (scale <= 0) return
  miniScroll.value = Math.min(Math.max(miniScroll.value, 0), maxMiniScroll.value)
  const sliderTop = top * scale
  const sliderHeight = Math.max(props.viewportPx * scale, 1)
  if (sliderTop - miniScroll.value < 0) {
    // Slider would exit the top: pin it to the rail head.
    miniScroll.value = Math.max(sliderTop, 0)
  } else if (sliderTop - miniScroll.value + sliderHeight > bodyHeight.value) {
    // Slider would exit the bottom: follow just enough to keep it visible.
    miniScroll.value = Math.min(Math.max(sliderTop + sliderHeight - bodyHeight.value, 0), maxMiniScroll.value)
  }
}

watch([() => props.scrollTopPx, bodyHeight], ([top]) => {
  // Indicator drags drive miniScroll directly from the pointer (see
  // onHandlePointerMove); only passive scrolling uses the anchored sync.
  if (dragMode.value === 'handle') return
  syncMiniScroll(top)
}, { immediate: true })

/** Pointer Y relative to the rail top, clamped INSIDE the rail (px). */
function railYFromEvent (event: PointerEvent): number {
  const body = bodyRef.value
  if (!body) return 0
  const rect = body.getBoundingClientRect()
  return Math.min(Math.max(event.clientY - rect.top, 0), Math.max(rect.height, 1))
}

const contentStyle = computed(() => ({
  height: `${miniContentHeight.value}px`,
  transform: `translateY(${-miniScroll.value}px)`
}))

const viewportStyle = computed(() => {
  const scale = minimapScale.value
  const height = Math.min(Math.max(props.viewportPx * scale, 10), bodyHeight.value)
  // Bottom must align with the rail bottom: clamp top so the slider can never
  // sink past it (which visually reads as "center reaching the bottom").
  const maxTop = Math.max(bodyHeight.value - height, 0)
  const top = Math.min(Math.max(props.scrollTopPx * scale - miniScroll.value, 0), maxTop)
  return { top: `${top}px`, height: `${height}px` }
})

// --- Global scrollbar: classic track/thumb over the WHOLE document height,
// separate from the minimap preview (which scrolls internally). ---
// (drag state declared at the top of the setup block)

const globalThumbStyle = computed(() => {
  if (props.totalScrollPx <= 0 || bodyHeight.value <= 0) {
    return { top: '0px', height: '100%' }
  }
  const height = Math.max((props.viewportPx / props.totalScrollPx) * bodyHeight.value, 14)
  const track = Math.max(bodyHeight.value - height, 0)
  const top = Math.min(Math.max((props.scrollTopPx / maxScrollPx.value) * track, 0), track)
  return { top: `${top}px`, height: `${height}px` }
})

function globalPointerRatio (event: PointerEvent): number {
  const bar = globalBarRef.value
  if (!bar) return 0
  const rect = bar.getBoundingClientRect()
  if (rect.height <= 0) return 0
  return Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1)
}

/** Click the track -> thumb centers on the pointer; keep dragging to scrub. */
function onGlobalBarPointerDown (event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  globalDragging.value = true
  dragMode.value = 'global'
  hoveredRow.value = null
  const heightRatio = Math.min(Math.max(props.viewportPx / Math.max(props.totalScrollPx, 1), 0.05), 1)
  globalGrabOffsetRatio.value = heightRatio / 2
  try {
    globalBarRef.value?.setPointerCapture(event.pointerId)
  } catch { /* capture loss is covered by the window-level release */ }
  emit('scrub', Math.min(Math.max(globalPointerRatio(event) - globalGrabOffsetRatio.value, 0), 1))
}

function onGlobalBarPointerMove (event: PointerEvent): void {
  if (!globalDragging.value) return
  emit('scrub', Math.min(Math.max(globalPointerRatio(event) - globalGrabOffsetRatio.value, 0), 1))
}

function onGlobalBarPointerUp (): void {
  globalDragging.value = false
  dragMode.value = null
}

const lastUserKey = computed(() => {
  for (let i = props.rows.length - 1; i >= 0; i--) {
    if (props.rows[i].role === 'user') return props.rows[i].key
  }
  return ''
})

function rowStyle (row: MinimapRow): Record<string, string> {
  const scale = minimapScale.value
  return {
    top: `${Math.max(row.offsetPx * scale, 0)}px`,
    height: `${Math.max(row.extentPx * scale, 2)}px`
  }
}

function scaledInnerStyle (): Record<string, string> {
  const scale = minimapScale.value
  return {
    width: `${props.trackWidth}px`,
    transform: `scale(${scale})`,
    transformOrigin: '0 0'
  }
}

/** Pointer Y inside the rail -> REAL content coordinate (undo scale + internal scroll). */
function contentPxFromEvent (event: PointerEvent | MouseEvent): number {
  const body = bodyRef.value
  const scale = minimapScale.value
  if (!body || scale <= 0) return 0
  const rect = body.getBoundingClientRect()
  if (rect.height <= 0) return 0
  const railY = Math.min(Math.max(event.clientY - rect.top, 0), Math.max(rect.height, 1))
  const contentPx = (railY + miniScroll.value) / scale
  return Math.min(Math.max(contentPx, 0), props.totalScrollPx)
}

function rowAtContentPx (contentPx: number, userOnly: boolean): MinimapRow | null {
  let nearest: MinimapRow | null = null
  let best = Number.POSITIVE_INFINITY
  for (const row of props.rows) {
    if (userOnly && row.role !== 'user') continue
    const center = row.offsetPx + row.extentPx / 2
    const distance = Math.abs(center - contentPx)
    if (distance < best) {
      nearest = row
      best = distance
    }
  }
  return nearest
}

/** The user row whose band contains the given content position, if any. */
function userRowAtContentPx (contentPx: number): MinimapRow | null {
  for (const row of props.rows) {
    if (row.role !== 'user') continue
    if (contentPx >= row.offsetPx && contentPx <= row.offsetPx + row.extentPx) return row
  }
  return null
}

/** Hover tracking on the surface itself (scaled rows are pointer-transparent).
 * The tooltip follows the pointer's rail position and ONLY shows while the
 * pointer is directly over a user message band. */
function updateHoverFromPointer (event: PointerEvent): void {
  if (isScrubbing.value) return
  const body = bodyRef.value
  if (body) {
    const rect = body.getBoundingClientRect()
    hoveredPointerY.value = Math.min(Math.max(event.clientY - rect.top, 0), Math.max(rect.height, 1))
  }
  hoveredRow.value = userRowAtContentPx(contentPxFromEvent(event))
}

/**
 * The whole minimap surface is a scrub bar (VS Code style): press anywhere to
 * center that content in the viewport and drag to scrub continuously. A quick
 * press without movement counts as a click and jumps to the nearest user
 * message instead.
 */
function onBodyPointerDown (event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  isScrubbing.value = true
  dragMode.value = 'body'
  hoveredRow.value = null
  pointerStart.value = { x: event.clientX, y: event.clientY, at: Date.now(), moved: false }
  try {
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  } catch { /* capture loss is covered by the window-level release */ }
  emitScrollFromContentPx(contentPxFromEvent(event))
}

function onBodyPointerMove (event: PointerEvent): void {
  if (!isScrubbing.value) {
    updateHoverFromPointer(event)
    return
  }
  const dx = Math.abs(event.clientX - pointerStart.value.x)
  const dy = Math.abs(event.clientY - pointerStart.value.y)
  if (dx + dy > 5) pointerStart.value.moved = true
  emitScrollFromContentPx(contentPxFromEvent(event))
}

function onBodyPointerUp (event: PointerEvent): void {
  if (!isScrubbing.value) return
  isScrubbing.value = false
  dragMode.value = null
  const quickTap = !pointerStart.value.moved && (Date.now() - pointerStart.value.at) < 350
  if (!quickTap) return
  const row = rowAtContentPx(contentPxFromEvent(event), true)
  if (row) emit('jump', row.messageIndex)
}

function onBodyPointerLeave (): void {
  hoveredRow.value = null
  bodyHovered.value = false
}

/** Center the pressed content position in the real viewport (like VS Code). */
function emitScrollFromContentPx (contentPx: number): void {
  const targetScrollTop = contentPx - props.viewportPx / 2
  emit('scrub', Math.min(Math.max(targetScrollTop / maxScrollPx.value, 0), 1))
}

/** Wheel over the minimap scrolls the conversation (delta passthrough). */
function onBodyWheel (event: WheelEvent): void {
  event.preventDefault()
  const targetScrollTop = props.scrollTopPx + event.deltaY
  emit('scrub', Math.min(Math.max(targetScrollTop / maxScrollPx.value, 0), 1))
}

/**
 * Dragging the screen-region indicator (VS Code slider behavior): a PURE
 * proportional mapping - the slider's position across the rail maps linearly
 * onto the whole document, so slider at the very top = text head, at the very
 * bottom = text tail, with one uniform speed throughout (no clamped dead
 * zones). The miniature content moves along for the whole drag.
 */
function onHandlePointerDown (event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  isScrubbing.value = true
  dragMode.value = 'handle'
  hoveredRow.value = null
  pointerStart.value = { x: event.clientX, y: event.clientY, at: 0, moved: true }

  const scale = minimapScale.value
  const railY = railYFromEvent(event)
  const sliderRailTop = props.scrollTopPx * scale - miniScroll.value
  handleDrag.value = { grabRail: sliderRailTop - railY }
  try {
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  } catch { /* capture loss is covered by the window-level release */ }
}

function onHandlePointerMove (event: PointerEvent): void {
  if (dragMode.value !== 'handle') return
  const scale = minimapScale.value
  if (scale <= 0) return

  const sliderHeight = Math.max(props.viewportPx * scale, 1)
  const railRange = Math.max(bodyHeight.value - sliderHeight, 1)
  const sliderRailTop = railYFromEvent(event) + handleDrag.value.grabRail
  const ratio = Math.min(Math.max(sliderRailTop / railRange, 0), 1)
  const targetScroll = ratio * maxScrollPx.value

  // Keep the slider glued to the pointer: displayed top = target*scale - miniScroll.
  miniScroll.value = Math.min(Math.max(targetScroll * scale - Math.max(sliderRailTop, 0), 0), maxMiniScroll.value)
  emit('scrub', ratio)
}

function onHandlePointerUp (): void {
  isScrubbing.value = false
  dragMode.value = null
  syncMiniScroll(props.scrollTopPx)
}

const userMessageTotal = computed(() => props.rows.filter(row => row.role === 'user').length)

function rowTitle (row: MinimapRow): string {
  if (row.role !== 'user') return ''
  return t('chatUi.minimapQuestionLabel', { current: row.ordinal ?? 0, total: userMessageTotal.value })
}
</script>

<template>
  <div class="message-minimap">
    <div
      ref="bodyRef"
      class="minimap-body"
      :class="{ scrubbing: isScrubbing, hovered: bodyHovered }"
      @pointerdown="onBodyPointerDown"
      @pointermove="onBodyPointerMove"
      @pointerup="onBodyPointerUp"
      @pointercancel="onBodyPointerUp"
      @pointerleave="onBodyPointerLeave"
      @pointerenter="bodyHovered = true"
      @wheel="onBodyWheel"
    >
      <div v-if="miniContentHeight > 0" class="minimap-content" :style="contentStyle">
        <div
          v-for="row in props.rows"
          :key="row.key"
          class="minimap-scaled-row"
          :class="{
            user: row.role === 'user',
            assistant: row.role !== 'user',
            editing: row.isEditing,
            streaming: props.isStreaming && row.key === lastUserKey,
            hovered: hoveredRow?.key === row.key
          }"
          :style="rowStyle(row)"
        >
          <!-- 1:1 reuse of the real row render, uniformly scaled down. -->
          <div v-if="row.mounted" class="minimap-scaled-inner" :style="scaledInnerStyle()">
            <MessageRow
              :msg="props.messages[row.messageIndex]"
              :index="row.messageIndex"
              :is-loading="false"
              :latest-assistant-message-index="-1"
              :file-preview="INACTIVE_PREVIEW"
              :collapsed-thinking="{}"
              :assistant-icon="props.assistantIcon"
              :assistant-name="props.assistantName"
            />
          </div>
          <!-- Not yet mounted (idle scheduler pending / over the cap): stripe. -->
          <template v-else>
            <span class="minimap-row-stripe" :class="{ user: row.role === 'user' }">
              {{ row.excerpt }}
            </span>
          </template>
        </div>
      </div>
    </div>

    <!-- Current-screen region frame over the miniature (draggable). -->
    <div
      class="minimap-viewport"
      :class="{ emphasized: bodyHovered || isScrubbing }"
      :style="viewportStyle"
      @pointerdown="onHandlePointerDown"
      @pointermove="onHandlePointerMove"
      @pointerup="onHandlePointerUp"
      @pointercancel="onHandlePointerUp"
    />

    <!-- Global scrollbar: whole-document track/thumb at the far right,
         independent of the minimap preview (which scrolls internally). -->
    <div
      ref="globalBarRef"
      class="minimap-globalbar"
      :class="{ hovered: globalBarHovered, dragging: globalDragging }"
      @pointerenter="globalBarHovered = true"
      @pointerleave="globalBarHovered = false"
      @pointerdown="onGlobalBarPointerDown"
      @pointermove="onGlobalBarPointerMove"
      @pointerup="onGlobalBarPointerUp"
      @pointercancel="onGlobalBarPointerUp"
    >
      <div class="minimap-globalbar-thumb" :style="globalThumbStyle" />
    </div>

    <div v-if="props.groupIcon" class="minimap-group-badge" :title="$t('chatUi.minimapGroupBadge')">
      {{ props.groupIcon }}
    </div>

    <Transition name="minimap-tooltip">
      <div
        v-if="hoveredRow && !isScrubbing"
        class="minimap-tooltip"
        :style="{ top: `${Math.min(Math.max(hoveredPointerY, 12), Math.max(bodyHeight - 16, 12))}px` }"
      >
        <span class="minimap-tooltip-ordinal">{{ rowTitle(hoveredRow) }}</span>
        <span class="minimap-tooltip-excerpt">{{ hoveredRow.excerpt || '…' }}</span>
        <span class="minimap-tooltip-arrow" />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.message-minimap {
  position: absolute;
  /* Flush against the far right edge. Lanes (right to left): 10px global
     scrollbar, 10px slider bar, 76px miniature preview. */
  right: 0;
  top: calc(16px + var(--chat-header-height, 0px));
  bottom: 16px;
  width: 96px;
  z-index: 5;
}

.minimap-body {
  position: absolute;
  inset: 0 20px 0 0;
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-panel) 45%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-text-muted) 9%, transparent);
  cursor: pointer;
  touch-action: none;
  overflow: hidden;
}

.minimap-body.scrubbing {
  cursor: grabbing;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-accent) 30%, transparent);
}

.minimap-content {
  position: absolute;
  inset: 0 auto 0 0;
  width: 100%;
  will-change: transform;
}

/* Each band allocates the message's scaled extent; the real row render inside
   is pointer-transparent so the surface handles scrub/hover/jump itself. */
.minimap-scaled-row {
  position: absolute;
  left: 0;
  right: 0;
  overflow: hidden;
  pointer-events: none;
  content-visibility: auto;
  contain-intrinsic-size: auto 40px;
}

.minimap-scaled-row.user {
  /* Highlight bar across the full rail width for user conversation zones. */
  background: color-mix(in srgb, var(--app-accent) 10%, transparent);
  border-radius: 2px;
}

.minimap-scaled-row.user.hovered,
.minimap-scaled-row.editing {
  background: color-mix(in srgb, var(--app-accent) 20%, transparent);
}

/* Bright anchor dot at the top-left of every user band - the pick target. */
.minimap-scaled-row.user::before {
  content: '';
  position: absolute;
  left: 1px;
  top: 0;
  transform: translateY(20%);
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--app-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--app-accent) 25%, transparent);
  z-index: 2;
}

.minimap-scaled-row.user.hovered::before,
.minimap-scaled-row.editing::before {
  transform: translateY(20%) scale(1.5);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--app-accent) 30%, transparent);
}

.minimap-scaled-row.streaming {
  animation: minimap-pulse 1.8s ease-in-out infinite;
}

@keyframes minimap-pulse {
  0%, 100% {
    opacity: 0.75;
  }
  50% {
    opacity: 1;
  }
}

/* The scaled real row render. */
.minimap-scaled-inner {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  user-select: none;
}

.minimap-scaled-inner :deep(.message-row) {
  padding-bottom: 0;
}

/* Lightweight placeholder for rows the idle scheduler hasn't mounted yet. */
.minimap-row-stripe {
  display: block;
  font-family: var(--chat-font-family);
  font-size: 3px;
  line-height: 4.6px;
  letter-spacing: 0.1px;
  word-break: break-all;
  overflow: hidden;
  white-space: pre-wrap;
  color: color-mix(in srgb, var(--app-text) 52%, transparent);
  padding-left: 8px;
}

.minimap-row-stripe.user {
  color: color-mix(in srgb, var(--app-accent) 80%, transparent);
  font-weight: 700;
}

/* Current-screen region: a full-width frame over the miniature (draggable),
   showing where the screen is within the internally-scrolled preview. */
.minimap-viewport {
  position: absolute;
  left: 0;
  right: 12px;
  /* Square edges: it's a screen-region indicator, not a pill. Only top/bottom
     hairlines bracket the region - side borders would fight the content. */
  border-radius: 0;
  border: none;
  border-top: 1px solid color-mix(in srgb, var(--app-accent) 42%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--app-accent) 42%, transparent);
  background: color-mix(in srgb, var(--app-accent) 7%, transparent);
  cursor: grab;
  touch-action: none;
  pointer-events: auto;
  transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}

/* Mouse on the minimap -> make the current screen region unmistakable. */
.minimap-viewport.emphasized {
  background: color-mix(in srgb, var(--app-accent) 14%, transparent);
  border-top-color: color-mix(in srgb, var(--app-accent) 75%, transparent);
  border-bottom-color: color-mix(in srgb, var(--app-accent) 75%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--app-accent) 12%, transparent), 0 2px 12px color-mix(in srgb, var(--app-accent) 16%, transparent);
}

.minimap-viewport:active {
  cursor: grabbing;
}

/* Group-conversation badge at the top of the rail. */
.minimap-group-badge {
  position: absolute;
  right: 6px;
  top: -4px;
  transform: translateY(-100%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 1;
  border: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
  background: color-mix(in srgb, var(--app-panel) 92%, transparent);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  pointer-events: none;
}

/* Global scrollbar - classic whole-document track at the far right edge. */
.minimap-globalbar {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  width: 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-text-muted) 8%, transparent);
  cursor: pointer;
  touch-action: none;
}

.minimap-globalbar-thumb {
  position: absolute;
  left: 1px;
  right: 1px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-text-muted) 38%, transparent);
  transition: background 0.15s ease;
}

.minimap-globalbar.hovered .minimap-globalbar-thumb,
.minimap-globalbar.dragging .minimap-globalbar-thumb {
  background: color-mix(in srgb, var(--app-accent) 62%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-accent) 20%, transparent);
}

.minimap-globalbar.dragging {
  cursor: grabbing;
}

/* Tooltip opens leftward from the hovered user row. */
.minimap-tooltip {
  position: absolute;
  right: 104px;
  transform: translateY(-50%);
  width: max-content;
  max-width: 280px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 12px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
  background: color-mix(in srgb, var(--app-panel) 90%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.22);
  pointer-events: none;
  text-align: left;
}

.minimap-tooltip-ordinal {
  font-size: 0.66rem;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: var(--app-accent-strong, var(--app-accent));
  white-space: nowrap;
}

.minimap-tooltip-excerpt {
  font-size: 0.76rem;
  line-height: 1.45;
  color: var(--app-text);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.minimap-tooltip-arrow {
  position: absolute;
  right: -4px;
  top: 50%;
  width: 8px;
  height: 8px;
  transform: translateY(-50%) rotate(45deg);
  border-top: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
  border-right: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
  background: color-mix(in srgb, var(--app-panel) 90%, transparent);
}

.minimap-tooltip-enter-active,
.minimap-tooltip-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.minimap-tooltip-enter-from,
.minimap-tooltip-leave-to {
  opacity: 0;
  transform: translateY(-50%) translateX(4px);
}

@media (max-width: 860px) {
  .message-minimap {
    display: none;
  }
}
</style>
