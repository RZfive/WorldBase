<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderMarkdown } from '../markdown'
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
  <div class="thinking-card message-event-card">
    <button class="thinking-header" type="button" @click="emit('toggle')">
      <span class="thinking-header-left">
        <span v-if="props.isStreaming" class="thinking-dot-icon" aria-hidden="true">
          <span class="thinking-dot"></span>
          <span class="thinking-dot"></span>
          <span class="thinking-dot"></span>
        </span>
        <svg v-else class="thinking-brain-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 2a5 5 0 0 1 5 5c0 1.07-.34 2.06-.9 2.88A4 4 0 0 1 20 14a4 4 0 0 1-4 4h-1v2a1 1 0 0 1-2 0v-2H8a4 4 0 0 1-4-4 4 4 0 0 1 3.9-3.12A5 5 0 0 1 7 7a5 5 0 0 1 5-5z"/>
        </svg>
        <span class="thinking-header-label">{{ props.isStreaming ? $t('chatUi.thinkingStreaming') : $t('chatUi.thinkingProcess') }}</span>
        <span v-if="!props.isStreaming" class="thinking-char-count">{{ thinkingCharacterCount }}</span>
      </span>
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
/* Base event card styles */
.message-event-card {
  width: min(100%, var(--chat-event-card-max, 1080px));
  border: 1px solid var(--app-border-strong);
  border-radius: 18px;
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);
  overflow: hidden;
}

.thinking-card {
  border-color: rgba(139, 92, 246, 0.2);
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
}

.thinking-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 11px 16px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  gap: 10px;
  transition: background 0.15s ease;
  border-radius: 18px;
}

.thinking-header:hover {
  background: var(--app-panel-muted);
}

.thinking-header-left {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.thinking-brain-icon {
  color: rgba(139, 92, 246, 0.7);
  flex-shrink: 0;
}

.thinking-header-label {
  font-size: 0.82em;
  font-weight: 600;
  color: var(--app-text-strong);
}

.thinking-char-count {
  font-size: 0.75em;
  color: var(--app-text-muted);
  white-space: nowrap;
}

.thinking-chevron {
  color: var(--app-text-muted);
  flex-shrink: 0;
  transform: rotate(-90deg);
  transition: transform 0.22s ease;
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
  border-top: 1px solid var(--app-border);
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
  padding: 14px 16px 16px;
  color: var(--app-text-muted);
  line-height: 1.68;
}

/* Animated dots for streaming */
.thinking-dot-icon {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}

.thinking-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(139, 92, 246, 0.7);
  animation: thinking-bounce 1.2s ease-in-out infinite;
}

.thinking-dot:nth-child(1) { animation-delay: 0s; }
.thinking-dot:nth-child(2) { animation-delay: 0.2s; }
.thinking-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes thinking-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}
</style>
