<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderMarkdown } from '../markdown'
import type { QuickAskMode, QuickAskPopoverState } from '../types'

const POPOVER_WIDTH = 340
const POPOVER_ESTIMATED_HEIGHT = 260
const VIEWPORT_PADDING = 8

const props = defineProps<{
  /** null hides the popover. Turns are owned by the container: dismissing
      this popover never cancels an in-flight answer. */
  state: QuickAskPopoverState | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'ask', payload: { question: string; mode: QuickAskMode }): void
}>()

const { t } = useI18n()

const question = ref('')
const lastMode = ref<QuickAskMode>('quick')
const popoverRef = ref<HTMLElement | null>(null)
const threadRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)

const modeOptions = computed<Array<{ value: QuickAskMode; label: string; hint: string }>>(() => [
  { value: 'quick', label: t('chatUi.quickAskModeQuick'), hint: t('chatUi.quickAskModeQuickHint') },
  { value: 'detailed', label: t('chatUi.quickAskModeDetailed'), hint: t('chatUi.quickAskModeDetailedHint') }
])

const turns = computed(() => props.state?.turns || [])
const isGenerating = computed(() => turns.value.some(turn => turn.status === 'generating'))

// Anchored under the selection / marked text; flips above when the viewport
// runs out of room below.
const positionStyle = computed(() => {
  const anchor = props.state?.anchor
  if (!anchor) return {}
  const left = Math.max(
    VIEWPORT_PADDING,
    Math.min((anchor.left + anchor.right) / 2 - POPOVER_WIDTH / 2, window.innerWidth - POPOVER_WIDTH - VIEWPORT_PADDING)
  )
  const belowY = anchor.bottom + 8
  const flip = belowY + POPOVER_ESTIMATED_HEIGHT > window.innerHeight - VIEWPORT_PADDING &&
    anchor.top - POPOVER_ESTIMATED_HEIGHT - 8 > VIEWPORT_PADDING
  const top = flip ? Math.max(VIEWPORT_PADDING, anchor.top - POPOVER_ESTIMATED_HEIGHT - 8) : belowY
  return { left: `${left}px`, top: `${top}px`, width: `${POPOVER_WIDTH}px` }
})

function scrollThreadToBottom (): void {
  nextTick(() => {
    const element = threadRef.value
    if (element) element.scrollTop = element.scrollHeight
  })
}

watch(() => props.state, (state) => {
  if (!state) return
  question.value = ''
  lastMode.value = [...state.turns].reverse().find(turn => turn.status === 'done')?.mode || 'quick'
  nextTick(() => inputRef.value?.focus())
  scrollThreadToBottom()
})

watch(turns, () => scrollThreadToBottom())

function submit (mode: QuickAskMode): void {
  const trimmed = question.value.trim()
  if (!trimmed || isGenerating.value) return
  lastMode.value = mode
  question.value = ''
  emit('ask', { question: trimmed, mode })
}

function handleInputKeydown (event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit(lastMode.value)
  }
}

// Dismiss on the next press outside the popover; wheel elsewhere scrolls the
// conversation away from the anchor, so it closes too. Either way the
// in-flight answer keeps running against the annotation.
function handleGlobalMousedown (event: MouseEvent): void {
  if (!props.state) return
  const target = event.target as Node | null
  if (popoverRef.value && target && popoverRef.value.contains(target)) return
  emit('close')
}

function handleGlobalWheel (event: WheelEvent): void {
  if (!props.state) return
  const target = event.target as Node | null
  if (popoverRef.value && target && popoverRef.value.contains(target)) return
  emit('close')
}

function handleGlobalKeydown (event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.state) emit('close')
}

onMounted(() => {
  document.addEventListener('mousedown', handleGlobalMousedown)
  document.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('wheel', handleGlobalWheel, { passive: true, capture: true })
})

onUnmounted(() => {
  document.removeEventListener('mousedown', handleGlobalMousedown)
  document.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('wheel', handleGlobalWheel, { capture: true })
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="props.state"
      ref="popoverRef"
      class="quick-ask-popover"
      :style="positionStyle"
      @mousedown.stop
      @contextmenu.prevent
    >
      <div class="quick-ask-head" aria-hidden="true">
        <span class="quick-ask-head-spark">✦</span>
        {{ $t('chatUi.quickAskAction') }}
      </div>

      <div v-if="turns.length > 0" ref="threadRef" class="quick-ask-thread">
        <div v-for="(turn, index) in turns" :key="index" class="quick-ask-turn">
          <p class="quick-ask-turn-question">{{ turn.question }}</p>
          <div v-if="turn.status === 'generating'" class="quick-ask-loading">
            <span class="quick-ask-spinner" aria-hidden="true"></span>
            <span>{{ $t('chatUi.quickAskThinking') }}</span>
          </div>
          <p v-else-if="turn.status === 'error'" class="quick-ask-error">{{ turn.error || $t('chatUi.quickAskFailed') }}</p>
          <div v-else class="quick-ask-turn-answer markdown-body" v-html="renderMarkdown(turn.answer)"></div>
        </div>
      </div>

      <textarea
        ref="inputRef"
        v-model="question"
        class="quick-ask-input"
        rows="1"
        :placeholder="$t('chatUi.quickAskQuestionPlaceholder')"
        :disabled="isGenerating"
        @keydown="handleInputKeydown"
      ></textarea>

      <div class="quick-ask-toolbar">
        <button
          v-for="option in modeOptions"
          :key="option.value"
          type="button"
          class="quick-ask-pill"
          :class="{ active: lastMode === option.value }"
          :disabled="isGenerating"
          :title="option.hint"
          @click="submit(option.value)"
        >
          {{ option.label }}
        </button>
        <button
          class="quick-ask-send"
          type="button"
          :disabled="isGenerating || !question.trim()"
          :title="lastMode === 'detailed' ? $t('chatUi.quickAskModeDetailed') : $t('chatUi.quickAskModeQuick')"
          @click="submit(lastMode)"
        >
          <span v-if="isGenerating" class="quick-ask-send-spinner" aria-hidden="true"></span>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Mini composer: frosted glass card (same recipe as the main composer),
   borderless textarea, state-pill mode buttons and the accent send key. */
.quick-ask-popover {
  position: fixed;
  z-index: 6000;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--app-input-border, var(--app-border));
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-panel) 80%, transparent);
  backdrop-filter: blur(18px) saturate(150%);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.18);
  overflow: hidden;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.quick-ask-popover:focus-within {
  border-color: color-mix(in srgb, var(--app-accent) 42%, var(--app-border));
  box-shadow: 0 0 0 2px var(--app-accent-soft), 0 16px 36px rgba(0, 0, 0, 0.18);
}

.quick-ask-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 12px 0;
  color: var(--app-text-faint);
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  user-select: none;
}

.quick-ask-head-spark {
  color: var(--app-accent);
  font-size: 0.72rem;
  line-height: 1;
}

.quick-ask-thread {
  display: flex;
  flex-direction: column;
  margin: 0 12px;
  padding: 6px 0 2px;
  max-height: 240px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.quick-ask-thread::-webkit-scrollbar { width: 5px; }
.quick-ask-thread::-webkit-scrollbar-track { background: transparent; }
.quick-ask-thread::-webkit-scrollbar-thumb { background: var(--app-scrollbar); border-radius: 3px; }

.quick-ask-turn + .quick-ask-turn {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--app-border);
}

.quick-ask-turn-question {
  margin: 0 0 3px;
  font-size: 0.74em;
  font-weight: 700;
  color: var(--app-text-strong);
  line-height: 1.5;
}

.quick-ask-turn-answer {
  font-size: 0.8em;
  line-height: 1.6;
  color: var(--app-text);
}

.quick-ask-turn-answer :deep(p) { margin: 0.3em 0; }
.quick-ask-turn-answer :deep(p:first-child) { margin-top: 0; }
.quick-ask-turn-answer :deep(p:last-child) { margin-bottom: 0; }
.quick-ask-turn-answer :deep(ul),
.quick-ask-turn-answer :deep(ol) { margin: 0.3em 0; padding-left: 1.3em; }

.quick-ask-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--app-text-muted);
  font-size: 0.74em;
}

.quick-ask-spinner,
.quick-ask-send-spinner {
  display: inline-block;
  border-radius: 50%;
  animation: quick-ask-spin 1s linear infinite;
}

.quick-ask-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--app-border-strong);
  border-top-color: var(--app-accent);
}

.quick-ask-send-spinner {
  width: 13px;
  height: 13px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #ffffff;
}

@keyframes quick-ask-spin {
  from { transform: rotate(0); }
  to { transform: rotate(360deg); }
}

.quick-ask-error {
  margin: 0;
  font-size: 0.74em;
  color: var(--app-danger);
}

.quick-ask-input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  min-height: 42px;
  max-height: 120px;
  padding: 9px 12px 5px;
  background: transparent;
  border: none;
  outline: none;
  color: var(--app-text);
  font-size: 0.86em;
  line-height: 1.5;
  font-family: inherit;
  resize: none;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.quick-ask-input::placeholder { color: var(--app-text-faint); }

.quick-ask-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px 8px;
  border-top: 1px solid var(--app-border);
}

/* Same shape as the composer's state pills (design v1.7). */
.quick-ask-pill {
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel-strong) 60%, transparent);
  color: var(--app-text-muted);
  font-size: 0.66rem;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: none;
}

.quick-ask-pill:hover:not(:disabled) {
  background: var(--app-panel-muted);
  color: var(--app-text);
}

.quick-ask-pill.active {
  color: var(--app-accent-strong);
  border-color: color-mix(in srgb, var(--app-accent) 38%, var(--app-border));
  background: var(--app-accent-soft);
}

.quick-ask-pill:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* Miniature of the composer's accent send key. */
.quick-ask-send {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-left: auto;
  border: none;
  border-radius: 999px;
  background: var(--app-accent);
  color: #ffffff;
  cursor: pointer;
  box-shadow: 0 4px 14px color-mix(in srgb, var(--app-accent) 32%, transparent);
  transition: transform 0.16s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.2s ease, opacity 0.2s ease;
}

.quick-ask-send:hover:not(:disabled) {
  transform: translateY(-1px) scale(1.05);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--app-accent) 42%, transparent);
}

.quick-ask-send:active:not(:disabled) {
  transform: scale(0.94);
}

.quick-ask-send:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
