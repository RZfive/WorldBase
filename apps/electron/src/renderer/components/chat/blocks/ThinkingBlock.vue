<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderMarkdown } from '../markdown'
import { formatElapsedDuration } from '../message-utils'
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'thinking' }>
  isStreaming: boolean
  isCollapsed: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle'): void
}>()

const { t, locale } = useI18n()

// Keep each rendered markdown slice small enough to avoid long synchronous parse/render stalls.
const SEGMENT_TARGET_CHARS = 2200
// Merge a few neighboring markdown blocks together so the viewport still scrolls naturally.
const SEGMENT_BLOCK_LIMIT = 6
// Render a small buffer above/below the viewport to avoid blank gaps while scrolling.
const SEGMENT_OVERSCAN = 2
// Approximate markdown slice height before ResizeObserver measurements arrive.
const SEGMENT_ESTIMATED_HEIGHT = 220
// Keep reopened fenced-code slices large enough to remain readable after wrapper overhead is added back.
const MIN_FENCE_CONTENT_CHARS = 400

const viewportRef = ref<HTMLElement | null>(null)
const viewportScrollTop = ref(0)
const viewportHeight = ref(0)
const savedViewportScrollTop = ref(0)
const measuredSegmentHeights = reactive<Record<number, number>>({})
const segmentObservers = new Map<number, ResizeObserver>()
let viewportObserver: ResizeObserver | null = null

const thinkingCharacterCount = computed(() => {
  return t('chatUi.characterCount', { count: props.block.text.length.toLocaleString(locale.value) })
})

// design v1.7: thinking is a timed pill — pulsing dot + live seconds while
// streaming, frozen green dot + "已思考 · N 秒" once closed.
const localStartedAt = Date.now()
const nowTick = ref(Date.now())
let tickTimer: number | null = null

watch(() => props.isStreaming, (streaming) => {
  if (streaming && tickTimer == null) {
    nowTick.value = Date.now()
    tickTimer = window.setInterval(() => {
      nowTick.value = Date.now()
    }, 1000)
  } else if (!streaming && tickTimer != null) {
    window.clearInterval(tickTimer)
    tickTimer = null
  }
}, { immediate: true })

onBeforeUnmount(() => {
  if (tickTimer != null) {
    window.clearInterval(tickTimer)
    tickTimer = null
  }
})

const liveElapsedLabel = computed(() => {
  if (!props.isStreaming) return ''
  const startedAt = typeof props.block.startedAt === 'number' ? props.block.startedAt : localStartedAt
  return formatElapsedDuration((nowTick.value - startedAt) / 1000, t)
})

const doneElapsedLabel = computed(() => {
  const { startedAt, endedAt } = props.block
  if (typeof startedAt !== 'number' || typeof endedAt !== 'number' || endedAt < startedAt) return ''
  // Sub-second thinking (reasoning arrived in a single chunk right before the
  // next block) would read as "已思考 · 0 秒" — show the char count instead.
  if (endedAt - startedAt < 1000) return ''
  return formatElapsedDuration((endedAt - startedAt) / 1000, t)
})

interface ThinkingSegment {
  id: string
  text: string
}

function normalizeNewlines (text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function getFenceMarker (line: string): string | null {
  const match = line.trim().match(/^(`{3,}|~{3,})/)
  return match?.[1] || null
}

function canCloseFence (marker: string, fenceMarker: string): boolean {
  return marker.length >= fenceMarker.length && marker[0] === fenceMarker[0]
}

function splitOversizedBlock (block: string, maxChars: number): string[] {
  if (block.length <= maxChars) return [block]

  const lines = block.split('\n')
  const firstFence = getFenceMarker(lines[0] || '')
  const lastFence = getFenceMarker(lines[lines.length - 1] || '')
  if (
    firstFence &&
    lastFence &&
    canCloseFence(lastFence, firstFence) &&
    lines.length > 2
  ) {
    const contentLines = lines.slice(1, -1)
    const chunks: string[] = []
    let buffer: string[] = []
    let bufferLength = 0
    const wrapperLength = lines[0].length + lines[lines.length - 1].length + 2
    // Preserve room for reopening/closing fenced code blocks while still keeping each slice useful.
    const safeMaxChars = Math.max(maxChars - wrapperLength, MIN_FENCE_CONTENT_CHARS)

    for (const line of contentLines) {
      const nextLength = bufferLength + line.length + (buffer.length > 0 ? 1 : 0)
      if (buffer.length > 0 && nextLength > safeMaxChars) {
        chunks.push(`${lines[0]}\n${buffer.join('\n')}\n${lines[lines.length - 1]}`)
        buffer = [line]
        bufferLength = line.length
      } else {
        buffer.push(line)
        bufferLength = nextLength
      }
    }

    if (buffer.length > 0) {
      chunks.push(`${lines[0]}\n${buffer.join('\n')}\n${lines[lines.length - 1]}`)
    }
    return chunks
  }

  const chunks: string[] = []
  let buffer: string[] = []
  let bufferLength = 0
  for (const line of lines) {
    const nextLength = bufferLength + line.length + (buffer.length > 0 ? 1 : 0)
    if (buffer.length > 0 && nextLength > maxChars) {
      chunks.push(buffer.join('\n'))
      buffer = [line]
      bufferLength = line.length
    } else {
      buffer.push(line)
      bufferLength = nextLength
    }
  }
  if (buffer.length > 0) chunks.push(buffer.join('\n'))
  return chunks
}

function splitThinkingSegments (text: string): ThinkingSegment[] {
  const normalized = normalizeNewlines(text).trim()
  if (!normalized) return []

  const lines = normalized.split('\n')
  const blocks: string[] = []
  let currentBlock: string[] = []
  let inFence = false
  let activeFenceMarker = ''

  const pushCurrentBlock = () => {
    const value = currentBlock.join('\n').trim()
    if (value) blocks.push(value)
    currentBlock = []
  }

  for (const line of lines) {
    const marker = getFenceMarker(line)
    if (marker) {
      if (!inFence) {
        inFence = true
        activeFenceMarker = marker
      } else if (canCloseFence(marker, activeFenceMarker)) {
        inFence = false
        activeFenceMarker = ''
      }
    }

    if (!inFence && line.trim() === '') {
      pushCurrentBlock()
      continue
    }

    currentBlock.push(line)
  }

  pushCurrentBlock()

  const segments: ThinkingSegment[] = []
  let buffer: string[] = []
  let bufferLength = 0

  const pushBuffer = () => {
    const value = buffer.join('\n\n').trim()
    if (value) {
      segments.push({
        id: `segment-${segments.length}`,
        text: value
      })
    }
    buffer = []
    bufferLength = 0
  }

  for (const block of blocks) {
    const splitBlocks = splitOversizedBlock(block, SEGMENT_TARGET_CHARS)
    for (const part of splitBlocks) {
      const nextLength = bufferLength + part.length + (buffer.length > 0 ? 2 : 0)
      if (
        buffer.length > 0 &&
        (nextLength > SEGMENT_TARGET_CHARS || buffer.length >= SEGMENT_BLOCK_LIMIT)
      ) {
        pushBuffer()
      }
      buffer.push(part)
      bufferLength += part.length + (buffer.length > 1 ? 2 : 0)
    }
  }

  pushBuffer()
  return segments
}

const thinkingSegments = computed(() => splitThinkingSegments(props.block.text))
const shouldUseSegmentWindow = computed(() => thinkingSegments.value.length > 1)

function syncViewportMetrics (): void {
  if (!viewportRef.value) return
  viewportScrollTop.value = viewportRef.value.scrollTop
  savedViewportScrollTop.value = viewportScrollTop.value
  viewportHeight.value = viewportRef.value.clientHeight
}

function getSegmentHeight (index: number): number {
  return measuredSegmentHeights[index] ?? SEGMENT_ESTIMATED_HEIGHT
}

function getSegmentExtent (index: number): number {
  return getSegmentHeight(index) + (index > 0 ? 16 : 0)
}

function getOffsetBefore (index: number): number {
  let total = 0
  for (let i = 0; i < index; i++) total += getSegmentExtent(i)
  return total
}

const visibleRange = computed(() => {
  const segmentCount = thinkingSegments.value.length
  if (!shouldUseSegmentWindow.value || segmentCount === 0) {
    return { start: 0, end: segmentCount - 1 }
  }

  const viewportBottom = viewportScrollTop.value + Math.max(viewportHeight.value, 1)
  let start = 0
  let offset = 0

  while (start < segmentCount) {
    const nextOffset = offset + getSegmentExtent(start)
    if (nextOffset >= viewportScrollTop.value) break
    offset = nextOffset
    start += 1
  }

  let end = start
  let visibleBottom = offset
  while (end < segmentCount && visibleBottom < viewportBottom) {
    visibleBottom += getSegmentExtent(end)
    end += 1
  }

  return {
    start: Math.max(0, start - SEGMENT_OVERSCAN),
    end: Math.min(segmentCount - 1, Math.max(start, end - 1) + SEGMENT_OVERSCAN)
  }
})

const visibleSegments = computed(() => {
  if (visibleRange.value.end < visibleRange.value.start) return []
  return thinkingSegments.value
    .slice(visibleRange.value.start, visibleRange.value.end + 1)
    .map((segment, offset) => ({
      ...segment,
      index: visibleRange.value.start + offset
    }))
})

const totalSegmentHeight = computed(() => getOffsetBefore(thinkingSegments.value.length))
const topSpacerHeight = computed(() => getOffsetBefore(visibleRange.value.start))
const bottomSpacerHeight = computed(() => {
  if (visibleRange.value.end < visibleRange.value.start) return 0
  return Math.max(0, totalSegmentHeight.value - getOffsetBefore(visibleRange.value.end + 1))
})

function updateMeasuredHeight (index: number, height: number): void {
  const nextHeight = Math.max(Math.ceil(height), 1)
  if (measuredSegmentHeights[index] === nextHeight) return
  measuredSegmentHeights[index] = nextHeight
}

function cleanupSegmentObserver (index: number): void {
  const observer = segmentObservers.get(index)
  if (!observer) return
  observer.disconnect()
  segmentObservers.delete(index)
}

function setSegmentRef (index: number, element: Element | null): void {
  cleanupSegmentObserver(index)
  if (!(element instanceof HTMLElement)) return

  updateMeasuredHeight(index, element.offsetHeight)
  if (typeof ResizeObserver === 'undefined') return

  const observer = new ResizeObserver(entries => {
    const entry = entries[0]
    if (entry) updateMeasuredHeight(index, entry.contentRect.height)
  })
  observer.observe(element)
  segmentObservers.set(index, observer)
}

function resetSegmentMeasurements (): void {
  Object.keys(measuredSegmentHeights).forEach(key => delete measuredSegmentHeights[Number(key)])
  segmentObservers.forEach(observer => observer.disconnect())
  segmentObservers.clear()
}

function bindViewportObserver (element: HTMLElement | null): void {
  viewportObserver?.disconnect()
  viewportObserver = null
  if (typeof ResizeObserver === 'undefined' || !element) return
  viewportObserver = new ResizeObserver(() => {
    syncViewportMetrics()
  })
  viewportObserver.observe(element)
}

watch(
  () => props.isCollapsed,
  (collapsed) => {
    if (!collapsed) {
      nextTick(() => {
        if (viewportRef.value) viewportRef.value.scrollTop = savedViewportScrollTop.value
        syncViewportMetrics()
      })
    }
  }
)

watch(thinkingSegments, () => {
  resetSegmentMeasurements()
  nextTick(syncViewportMetrics)
})

watch(viewportRef, (element) => {
  bindViewportObserver(element)
  nextTick(syncViewportMetrics)
})

onMounted(() => {
  bindViewportObserver(viewportRef.value)
  syncViewportMetrics()
})

onBeforeUnmount(() => {
  viewportObserver?.disconnect()
  viewportObserver = null
  resetSegmentMeasurements()
})
</script>

<template>
  <div class="thinking-inline">
    <button class="thinking-header" type="button" @click="emit('toggle')">
      <span v-if="props.isStreaming" class="thinking-dot" aria-hidden="true" />
      <span v-else class="thinking-status-dot" aria-hidden="true" />
      <span class="thinking-header-label">{{ props.isStreaming ? $t('chatUi.thinkingStreaming') : $t('chatUi.thoughtDoneLabel') }}</span>
      <span v-if="liveElapsedLabel" class="thinking-char-count">{{ liveElapsedLabel }}</span>
      <span v-else-if="doneElapsedLabel" class="thinking-char-count">{{ doneElapsedLabel }}</span>
      <span v-else-if="!props.isStreaming" class="thinking-char-count">{{ thinkingCharacterCount }}</span>
      <span class="thinking-chevron" :class="{ expanded: !props.isCollapsed }" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </span>
    </button>
    <div class="thinking-body-wrapper" :class="{ collapsed: props.isCollapsed }">
      <div class="thinking-body">
        <div v-if="!props.isCollapsed" class="thinking-body-inner">
          <div
            v-if="shouldUseSegmentWindow"
            ref="viewportRef"
            class="thinking-segment-viewport"
            @scroll.passive="syncViewportMetrics"
          >
            <div v-if="topSpacerHeight > 0" class="thinking-segment-spacer" :style="{ height: `${topSpacerHeight}px` }" aria-hidden="true" />

            <div
              v-for="segment in visibleSegments"
              :key="segment.id"
              :ref="(element) => setSegmentRef(segment.index, element as Element | null)"
              class="thinking-segment message-event-body markdown-body"
              :class="{ 'with-leading-gap': segment.index > 0 }"
              v-html="renderMarkdown(segment.text)"
            ></div>

            <div v-if="bottomSpacerHeight > 0" class="thinking-segment-spacer" :style="{ height: `${bottomSpacerHeight}px` }" aria-hidden="true" />
          </div>

          <div
            v-else
            ref="viewportRef"
            class="thinking-segment-viewport"
            @scroll.passive="syncViewportMetrics"
          >
            <div class="thinking-segment message-event-body markdown-body" v-html="renderMarkdown(props.block.text)"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.thinking-inline {
  width: min(100%, var(--chat-event-card-max, 1080px));
  color: var(--app-text-muted);
}

/* design v1.7: thinking is a timed pill — rounded capsule, 6px pulsing dot
   while streaming, frozen green dot + "已思考 · N 秒" once closed. */
.thinking-header {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 24px;
  max-width: 100%;
  padding: 4px 10px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  background: var(--app-panel);
  color: var(--app-text-muted);
  cursor: pointer;
  text-align: left;
  font: inherit;
  font-size: 0.72em;
  line-height: 1.45;
  box-shadow: var(--shadow-1);
  transition: border-color 0.16s ease, background 0.16s ease, color 0.16s ease;
}

.thinking-header:hover,
.thinking-header:focus-visible {
  border-color: var(--app-border-strong);
  color: var(--app-text);
  outline: none;
}

.thinking-header:hover .thinking-chevron,
.thinking-header:focus-visible .thinking-chevron,
.thinking-chevron.expanded {
  opacity: 1;
}

/* 6px pulsing dot while thinking (1.2s, design motion spec). */
.thinking-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--app-accent);
  box-shadow: 0 0 0 3px var(--app-accent-soft);
  flex-shrink: 0;
  animation: thinking-pulse 1.2s ease-in-out infinite;
}

/* A finished thought settles into a green dot. */
.thinking-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--app-success);
  flex-shrink: 0;
}

.thinking-header-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  color: var(--app-text-muted);
}

.thinking-char-count {
  color: color-mix(in srgb, var(--app-text-muted) 74%, transparent);
  white-space: nowrap;
}

.thinking-char-count::before {
  content: "·";
  margin-right: 7px;
}

.thinking-chevron {
  margin-left: 1px;
  color: color-mix(in srgb, var(--app-text-muted) 65%, transparent);
  flex-shrink: 0;
  opacity: 0;
  transform: rotate(-90deg);
  transition: opacity 120ms ease, transform 140ms ease;
  display: flex;
  align-items: center;
}

.thinking-chevron.expanded {
  transform: rotate(0deg);
}

/* Smooth expand/collapse via grid-template-rows trick */
.thinking-body-wrapper {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.25s ease;
}

.thinking-body-wrapper.collapsed {
  grid-template-rows: 0fr;
}

.thinking-body {
  overflow: hidden;
  min-height: 0;
}

.thinking-body-inner {
  margin-top: 6px;
  padding: 10px 0 12px 13px;
  border-left: 1px solid var(--app-border);
}

.thinking-segment-viewport {
  max-height: min(60vh, 520px);
  overflow-y: auto;
}

.thinking-segment {
  min-height: 1px;
}

.thinking-segment.with-leading-gap {
  margin-top: 16px;
}

.thinking-segment-spacer {
  width: 100%;
  flex: 0 0 auto;
}

.message-event-body {
  padding: 0;
  color: var(--app-text-muted);
  line-height: 1.68;
}

/* Animated streaming dot (design v1.7: 6px pulse, 1.2s) */
@keyframes thinking-pulse {
  0%, 100% { transform: scale(0.85); opacity: 0.7; }
  50% { transform: scale(1.15); opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .thinking-dot {
    animation: none;
  }
}
</style>
