<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { QuestionNavigationEntry, QuestionAnnotationNavigationEntry } from '../types'

const props = defineProps<{
  questions: QuestionNavigationEntry[]
}>()

const emit = defineEmits<{
  (e: 'jump', payload: { messageIndex: number; annotationId?: string }): void
}>()

// Fixed navigation slots, unrelated to message heights. These same values are
// passed to CSS so gaps/padding and pointer hit testing cannot drift apart.
const ROW_HEIGHT = 16
const LIST_PADDING = 8
const MAX_SCALE = 1.9
const INFLUENCE_RADIUS = 2.5
const TOOLTIP_WIDTH = 260
const TOOLTIP_GAP = 8
const TOOLTIP_MARGIN = 8

const listRef = ref<HTMLElement | null>(null)
const tooltipRef = ref<HTMLElement | null>(null)
const hoverPosition = ref<number | null>(null)
const selectedKey = ref<string | null>(null)
const tooltipPosition = ref({ left: 0, top: 0, width: TOOLTIP_WIDTH })
const hoveredIndex = computed(() => hoverPosition.value == null ? null : Math.round(hoverPosition.value))
const hoveredQuestion = computed(() => hoveredIndex.value == null ? null : props.questions[hoveredIndex.value] || null)
let pointerY: number | null = null
let hoverFrameId: number | null = null
let disposed = false

function lineWidth (question: QuestionNavigationEntry): number {
  // 34 * 1.9 = 64.6px: even the longest enlarged mark fits inside the 72px rail.
  return Math.min(34, 12 + question.excerpt.trim().length * 0.22)
}

function dockScale (index: number): number {
  if (hoverPosition.value == null) return 1
  const distance = Math.abs(index - hoverPosition.value)
  if (distance >= INFLUENCE_RADIUS) return 1
  // A continuous curve (also between buttons), not discrete enter/leave sizes.
  return 1 + (MAX_SCALE - 1) * (1 + Math.cos(Math.PI * distance / INFLUENCE_RADIUS)) / 2
}

function questionLineStyle (question: QuestionNavigationEntry, index: number): Record<string, string> {
  const scale = dockScale(index)
  return {
    width: `${lineWidth(question)}px`,
    transform: `scale(${scale})`,
    opacity: `${0.78 + 0.22 * (scale - 1) / (MAX_SCALE - 1)}`
  }
}

function updateTooltipPosition (): void {
  const index = hoveredIndex.value
  const question = hoveredQuestion.value
  const button = index == null ? null : listRef.value?.children[index]
  if (disposed || !button || !question) return
  const rect = button.getBoundingClientRect()
  const width = Math.min(TOOLTIP_WIDTH, Math.max(0, window.innerWidth - TOOLTIP_MARGIN * 2))
  const height = tooltipRef.value?.offsetHeight || 80
  // Anchor to the enlarged mark, not the wide button. `left` is already the
  // popup's left edge; CSS must NOT subtract another 100% of its width.
  const lineLeft = rect.right - lineWidth(question) * dockScale(index!)
  const left = lineLeft - width - TOOLTIP_GAP
  const preferredLeft = left >= TOOLTIP_MARGIN ? left : rect.right + TOOLTIP_GAP
  tooltipPosition.value = {
    left: Math.max(TOOLTIP_MARGIN, Math.min(preferredLeft, window.innerWidth - width - TOOLTIP_MARGIN)),
    top: Math.max(TOOLTIP_MARGIN, Math.min(rect.top + rect.height / 2 - height / 2, window.innerHeight - height - TOOLTIP_MARGIN)),
    width
  }
}

function flushPointerPosition (): void {
  hoverFrameId = null
  const list = listRef.value
  if (disposed || pointerY == null || !list || props.questions.length === 0) return
  const rect = list.getBoundingClientRect()
  // O(1) geometry: no query/measurement of the conversation or every mark.
  const position = (pointerY - rect.top + list.scrollTop - LIST_PADDING) / ROW_HEIGHT - 0.5
  hoverPosition.value = Math.min(props.questions.length - 1, Math.max(0, position))
  updateTooltipPosition()
}

function schedulePointerPosition (): void {
  if (disposed || hoverFrameId != null) return
  hoverFrameId = window.requestAnimationFrame(flushPointerPosition)
}

function handlePointerMove (event: PointerEvent): void {
  if (event.pointerType === 'touch') return
  pointerY = event.clientY
  schedulePointerPosition()
}

function clearHover (): void {
  pointerY = null
  hoverPosition.value = null
  if (hoverFrameId != null) window.cancelAnimationFrame(hoverFrameId)
  hoverFrameId = null
}

function handleFocus (index: number): void {
  // Pointer-induced focus must not snap a fractional Dock position to a row.
  if (pointerY != null) return
  hoverPosition.value = index
  updateTooltipPosition()
}

function handleFocusOut (event: FocusEvent): void {
  if (pointerY != null || (event.relatedTarget && listRef.value?.contains(event.relatedTarget as Node))) return
  clearHover()
}

function handleListScroll (): void {
  if (pointerY != null) schedulePointerPosition()
  else updateTooltipPosition()
}

function selectQuestion (question: QuestionNavigationEntry): void {
  selectedKey.value = question.key
  emit('jump', { messageIndex: question.messageIndex })
}

function selectAnnotation (question: QuestionNavigationEntry, annotation: QuestionAnnotationNavigationEntry): void {
  selectedKey.value = question.key
  emit('jump', { messageIndex: annotation.messageIndex, annotationId: annotation.id })
}

function annotationStatus (annotation: QuestionAnnotationNavigationEntry): string {
  return annotation.status || 'resolved'
}

// Re-measure the single popup after its text renders, for correct edge clamping.
watch(hoveredQuestion, () => { nextTick(updateTooltipPosition) })
watch(() => props.questions, () => {
  if (selectedKey.value && !props.questions.some(question => question.key === selectedKey.value)) selectedKey.value = null
  if (pointerY != null) nextTick(schedulePointerPosition)
  else clearHover()
})

onMounted(() => {
  window.addEventListener('resize', clearHover)
  window.addEventListener('blur', clearHover)
  document.addEventListener('visibilitychange', clearHover)
})

onBeforeUnmount(() => {
  disposed = true
  clearHover()
  window.removeEventListener('resize', clearHover)
  window.removeEventListener('blur', clearHover)
  document.removeEventListener('visibilitychange', clearHover)
})
</script>

<template>
  <aside
    v-if="props.questions.length > 0"
    class="question-outline"
    :style="{ '--question-row-height': `${ROW_HEIGHT}px`, '--question-list-padding': `${LIST_PADDING}px` }"
    aria-label="Conversation questions"
    @pointerenter="handlePointerMove"
    @pointermove="handlePointerMove"
    @pointerleave="clearHover"
    @pointercancel="clearHover"
    @focusout="handleFocusOut"
  >
    <div ref="listRef" class="question-outline-list" @scroll.passive="handleListScroll">
      <button
        v-for="(question, index) in props.questions"
        :key="question.key"
        class="question-outline-item"
        :class="{ hovered: hoveredIndex === index, selected: selectedKey === question.key }"
        type="button"
        :aria-label="question.excerpt || `Question ${index + 1}`"
        :aria-current="selectedKey === question.key ? 'true' : undefined"
        @focus="handleFocus(index)"
        @click="selectQuestion(question)"
      >
        <span class="question-outline-line" :style="questionLineStyle(question, index)" />
        <span
          v-if="question.annotations?.length"
          class="question-outline-annotation"
          :class="`status-${annotationStatus(question.annotations[0])}`"
          role="button"
          tabindex="0"
          :aria-label="`${question.annotations.length} annotations`"
          @click.stop="selectAnnotation(question, question.annotations[0])"
          @keydown.enter.stop="selectAnnotation(question, question.annotations[0])"
          @keydown.space.prevent.stop="selectAnnotation(question, question.annotations[0])"
        >
          <span class="question-outline-annotation-dot" aria-hidden="true"></span>
          <span v-if="question.annotations.length > 1" class="question-outline-annotation-count">{{ question.annotations.length }}</span>
        </span>
      </button>
    </div>
  </aside>
  <Teleport to="body">
    <div
      v-if="hoveredQuestion"
      ref="tooltipRef"
      class="question-outline-tooltip"
      role="tooltip"
      :style="{ left: `${tooltipPosition.left}px`, top: `${tooltipPosition.top}px`, width: `${tooltipPosition.width}px` }"
    >
      <span class="question-outline-tooltip-label">{{ $t('chatUi.minimapQuestionLabel', { current: (hoveredIndex ?? 0) + 1, total: props.questions.length }) }}</span>
      <span class="question-outline-tooltip-text">{{ hoveredQuestion.excerpt || 'Untitled question' }}</span>
      <div v-if="hoveredQuestion.annotations?.length" class="question-outline-tooltip-annotations">
        <div class="question-outline-tooltip-annotation-label">{{ hoveredQuestion.annotations.length }} 个批注</div>
        <div
          v-for="annotation in hoveredQuestion.annotations.slice(0, 3)"
          :key="annotation.id"
          class="question-outline-tooltip-annotation"
          :class="`status-${annotationStatus(annotation)}`"
        >
          <span class="question-outline-tooltip-dot" aria-hidden="true"></span>
          <span>{{ annotation.excerpt }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.question-outline {
  position: absolute;
  top: 50%;
  right: 8px;
  z-index: 8;
  width: 84px;
  max-height: min(68%, 460px);
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  padding: 8px 0;
  box-sizing: border-box;
  background: transparent;
  /* The whole transparent Dock, including gaps, owns the hover interaction. */
  pointer-events: auto;
}

.question-outline-list {
  width: 100%;
  min-height: 0;
  padding: var(--question-list-padding) 6px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-width: none;
}

.question-outline-list::-webkit-scrollbar {
  display: none;
}

.question-outline-item {
  position: relative;
  flex: 0 0 var(--question-row-height);
  height: var(--question-row-height);
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.question-outline-item:focus-visible {
  outline: 1px solid var(--app-accent);
  outline-offset: -1px;
  border-radius: 4px;
}

.question-outline-line {
  display: block;
  flex: 0 0 auto;
  height: 2px;
  min-width: 12px;
  max-width: 34px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-text-muted) 62%, transparent);
  transform-origin: right center;
  transition: transform 0.12s cubic-bezier(0.22, 1, 0.36, 1), background 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease;
}

.question-outline-annotation {
  position: relative;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 12px;
  height: 16px;
  margin-left: 4px;
  border-radius: 999px;
  color: var(--app-text);
  cursor: pointer;
  transition: transform 0.12s ease, background 0.12s ease;
}

.question-outline-annotation:hover,
.question-outline-annotation:focus-visible {
  transform: scale(1.18);
  background: color-mix(in srgb, var(--app-accent) 12%, transparent);
  outline: none;
}

.question-outline-annotation-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--app-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--app-accent) 18%, transparent);
}

.question-outline-annotation-count {
  min-width: 13px;
  height: 13px;
  margin-left: -2px;
  padding: 0 3px;
  border-radius: 999px;
  background: var(--app-accent);
  color: var(--app-panel);
  font-size: 0.58rem;
  font-weight: 700;
  line-height: 13px;
  text-align: center;
}

.question-outline-annotation.status-generating .question-outline-annotation-dot {
  background: transparent;
  border: 2px solid var(--app-accent);
  animation: question-annotation-pulse 1.1s ease-in-out infinite;
}

.question-outline-annotation.status-ambiguous .question-outline-annotation-dot {
  background: #d38b22;
}

.question-outline-annotation.status-orphaned .question-outline-annotation-dot {
  background: var(--app-text-faint);
  box-shadow: none;
}

@keyframes question-annotation-pulse {
  50% { opacity: 0.45; transform: scale(0.72); }
}

.question-outline-item.hovered .question-outline-line {
  background: var(--app-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--app-accent) 16%, transparent);
}

.question-outline-item.selected .question-outline-line {
  background: var(--app-accent-strong);
}

.question-outline-tooltip {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 1000;
  box-sizing: border-box;
  max-width: calc(100vw - 16px);
  max-height: min(96px, calc(100vh - 16px));
  animation: question-tooltip-in 0.12s ease-out both;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 9px;
  overflow: hidden;
  border: 1px solid var(--app-border-strong);
  border-radius: 8px;
  background: var(--app-panel);
  box-shadow: var(--app-shadow);
  color: var(--app-text);
  font-size: 0.72rem;
  line-height: 1.5;
  text-align: left;
  pointer-events: none;
}

@keyframes question-tooltip-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.question-outline-tooltip-label {
  flex-shrink: 0;
  color: var(--app-accent-strong);
  font-weight: 700;
}

.question-outline-tooltip-text {
  display: -webkit-box;
  overflow: hidden;
  color: var(--app-text-soft);
  text-overflow: ellipsis;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.question-outline-tooltip-annotations {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--app-border);
}

.question-outline-tooltip-annotation-label {
  color: var(--app-accent-strong);
  font-size: 0.66rem;
  font-weight: 700;
}

.question-outline-tooltip-annotation {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
  color: var(--app-text-soft);
  font-size: 0.66rem;
}

.question-outline-tooltip-annotation > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.question-outline-tooltip-dot {
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  margin-top: 1px;
  border-radius: 50%;
  background: var(--app-accent);
}

.question-outline-tooltip-annotation.status-ambiguous .question-outline-tooltip-dot { background: #d38b22; }
.question-outline-tooltip-annotation.status-orphaned .question-outline-tooltip-dot { background: var(--app-text-faint); }

@media (prefers-reduced-motion: reduce) {
  .question-outline-line { transition: none; }
  .question-outline-annotation { transition: none; }
  .question-outline-annotation.status-generating .question-outline-annotation-dot { animation: none; }
  .question-outline-tooltip { animation: none; }
}
</style>
