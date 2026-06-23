<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'

export interface AskUserQuestionItem {
  id: string
  question: string
  options: string[]
}

export interface AskUserPanelRequest {
  requestId: string
  questions: AskUserQuestionItem[]
}

const props = defineProps<{
  request: AskUserPanelRequest
}>()

const emit = defineEmits<{
  (e: 'submit', requestId: string, answers: Array<{ questionId: string; selectedOption: string | null; customAnswer: string | null }>): void
  (e: 'cancel', requestId: string): void
}>()

interface DraftAnswer {
  selectedOption: string | null
  customAnswer: string
}

const drafts = reactive<Record<string, DraftAnswer>>({})
const collapsed = ref(false)

function ensureDraft (questionId: string): DraftAnswer {
  if (!drafts[questionId]) {
    drafts[questionId] = { selectedOption: null, customAnswer: '' }
  }
  return drafts[questionId]
}

watch(
  () => props.request.requestId,
  () => {
    for (const key of Object.keys(drafts)) {
      delete drafts[key]
    }
    collapsed.value = false
  },
  { immediate: true }
)

const allAnswered = computed(() => {
  return props.request.questions.every((q) => {
    const draft = drafts[q.id]
    if (!draft) return false
    if (draft.customAnswer.trim().length > 0) return true
    return Boolean(draft.selectedOption)
  })
})

const answeredCount = computed(() => {
  return props.request.questions.reduce((count, q) => {
    const draft = drafts[q.id]
    if (!draft) return count
    if (draft.customAnswer.trim().length > 0) return count + 1
    return count + (draft.selectedOption ? 1 : 0)
  }, 0)
})

function pickOption (questionId: string, option: string) {
  const draft = ensureDraft(questionId)
  draft.selectedOption = option
  // Picking a chip clears any half-typed custom text so the chip wins unambiguously.
  draft.customAnswer = ''
}

function onCustomInput (questionId: string, value: string) {
  const draft = ensureDraft(questionId)
  draft.customAnswer = value
  // Typing into the free-text input takes precedence over any chip selection.
  if (value.trim().length > 0) {
    draft.selectedOption = null
  }
}

function submit () {
  if (!allAnswered.value) return
  const answers = props.request.questions.map((q) => {
    const draft = drafts[q.id]
    const customAnswer = draft?.customAnswer.trim() || ''
    return {
      questionId: q.id,
      selectedOption: customAnswer.length > 0 ? null : (draft?.selectedOption ?? null),
      customAnswer: customAnswer.length > 0 ? customAnswer : null
    }
  })
  emit('submit', props.request.requestId, answers)
}

function cancel () {
  emit('cancel', props.request.requestId)
}

function toggleCollapsed () {
  collapsed.value = !collapsed.value
}
</script>

<template>
  <section class="ask-shell" :aria-label="$t('chatUi.askPendingAria')">
    <div class="ask-float" :class="{ expanded: !collapsed }">
      <Transition name="ask-expand">
        <div v-if="!collapsed" class="ask-detail">
          <div class="ask-detail-head">
            <span>{{ $t('chatUi.askNeedAnswer') }}</span>
            <span>{{ answeredCount }}/{{ props.request.questions.length }}</span>
          </div>

          <div class="ask-scroll">
            <div
              v-for="(q, qIdx) in props.request.questions"
              :key="q.id"
              class="ask-question"
            >
              <div class="ask-question-head">
                <span class="ask-question-index">{{ qIdx + 1 }}</span>
                <span class="ask-question-text">{{ q.question }}</span>
              </div>

              <div class="ask-question-options">
                <button
                  v-for="option in q.options.slice(0, 4)"
                  :key="option"
                  class="ask-option"
                  :class="{ active: drafts[q.id]?.selectedOption === option && !(drafts[q.id]?.customAnswer.trim().length) }"
                  type="button"
                  @click="pickOption(q.id, option)"
                >
                  <span class="ask-option-radio" aria-hidden="true"></span>
                  <span class="ask-option-label">{{ option }}</span>
                </button>
              </div>

              <div class="ask-custom-row">
                <span class="ask-custom-label">{{ $t('chatUi.askOther') }}</span>
                <input
                  :value="drafts[q.id]?.customAnswer || ''"
                  class="ask-custom-input"
                  type="text"
                  :placeholder="$t('chatUi.askCustomPlaceholder')"
                  @input="onCustomInput(q.id, ($event.target as HTMLInputElement).value)"
                  @keydown.enter.prevent="submit"
                />
              </div>
            </div>
          </div>

          <div class="ask-actions">
            <button class="ask-cancel-btn" type="button" @click="cancel">{{ $t('common.cancel') }}</button>
            <button
              class="ask-submit-btn"
              type="button"
              :disabled="!allAnswered"
              @click="submit"
            >
              {{ $t('chatUi.askSubmitAnswer') }}
            </button>
          </div>
        </div>
      </Transition>

      <button
        class="ask-strip"
        type="button"
        :aria-expanded="!collapsed"
        @click="toggleCollapsed"
      >
        <span class="ask-strip-status">{{ $t('chatUi.askNeedAnswerShort') }}</span>
        <span class="ask-strip-title">{{ props.request.questions.length === 1 ? props.request.questions[0].question : $t('chatUi.askQuestionsPending', { count: props.request.questions.length }) }}</span>
        <span class="ask-strip-count">{{ answeredCount }}/{{ props.request.questions.length }}</span>
        <span class="ask-toggle" :class="{ collapsed }" aria-hidden="true">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.ask-shell {
  position: relative;
  z-index: 10;
  height: 0;
  width: 100%;
  max-width: var(--chat-message-track-max, 980px);
  margin: 0 auto;
  padding: 0 var(--chat-message-gutter, 28px);
  box-sizing: border-box;
  pointer-events: none;
}

.ask-float {
  position: absolute;
  left: 50%;
  bottom: max(0px, calc(var(--chat-input-overlap, 56px) - 10px));
  width: min(560px, calc(100% - 32px));
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: stretch;
  pointer-events: auto;
  transform: translateX(-50%);
}

.ask-strip {
  width: 100%;
  height: 36px;
  min-width: 0;
  padding: 0 8px 0 10px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  border: 1px solid color-mix(in srgb, #f59e0b 32%, var(--app-border-strong));
  border-bottom: 0;
  border-radius: 10px 10px 0 0;
  background: color-mix(in srgb, var(--app-panel) 96%, transparent);
  box-shadow: 0 -10px 28px rgba(0, 0, 0, 0.16);
  color: var(--app-text);
  cursor: pointer;
  text-align: left;
  backdrop-filter: blur(14px) saturate(130%);
  -webkit-backdrop-filter: blur(14px) saturate(130%);
}

.ask-strip:hover {
  border-color: color-mix(in srgb, #f59e0b 48%, var(--app-border-strong));
  background: color-mix(in srgb, rgba(245, 158, 11, 0.16) 60%, var(--app-panel));
}

.ask-strip-status {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 7px;
  border-radius: 7px;
  border: 1px solid color-mix(in srgb, #f59e0b 36%, var(--app-border-strong));
  background: rgba(245, 158, 11, 0.16);
  color: #b45309;
  font-size: 0.68rem;
  font-weight: 800;
  white-space: nowrap;
}

:global(:root[data-theme='dark'] .ask-strip-status) {
  color: #fbbf24;
}

.ask-strip-title {
  min-width: 0;
  color: var(--app-text-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.8rem;
  font-weight: 700;
}

.ask-strip-count {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 7px;
  border-radius: 7px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text-muted);
  font-size: 0.68rem;
  font-weight: 800;
  white-space: nowrap;
}

.ask-toggle {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text-muted);
  transition:
    transform 0.18s ease,
    color 0.18s ease,
    border-color 0.18s ease;
}

.ask-toggle.collapsed {
  transform: rotate(180deg);
}

.ask-detail {
  padding: 12px;
  border: 1px solid color-mix(in srgb, #f59e0b 28%, var(--app-border-strong));
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-panel) 97%, transparent);
  box-shadow: var(--app-shadow);
  overflow: hidden;
  backdrop-filter: blur(14px) saturate(130%);
  -webkit-backdrop-filter: blur(14px) saturate(130%);
}

.ask-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
  color: var(--app-text-muted);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.ask-scroll {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: min(360px, 50vh);
  overflow-y: auto;
  padding-right: 4px;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.ask-question {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-muted);
}

.ask-question-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.ask-question-index {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  font-weight: 800;
  color: #b45309;
  background: rgba(245, 158, 11, 0.16);
  border: 1px solid color-mix(in srgb, #f59e0b 28%, var(--app-border-strong));
}

:global(:root[data-theme='dark'] .ask-question-index) {
  color: #fbbf24;
}

.ask-question-text {
  flex: 1;
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--app-text-strong);
  line-height: 1.5;
}

.ask-question-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ask-option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel);
  color: var(--app-text);
  font-size: 0.82rem;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.ask-option:hover {
  border-color: color-mix(in srgb, var(--app-accent) 32%, var(--app-border-strong));
  background: color-mix(in srgb, var(--app-accent-soft) 36%, var(--app-panel));
}

.ask-option.active {
  border-color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent-soft) 80%, var(--app-panel));
  color: var(--app-text-strong);
  font-weight: 600;
}

.ask-option-radio {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 2px solid var(--app-border-strong);
  background: var(--app-panel);
  position: relative;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.ask-option:hover .ask-option-radio {
  border-color: color-mix(in srgb, var(--app-accent) 48%, var(--app-border-strong));
}

.ask-option.active .ask-option-radio {
  border-color: var(--app-accent);
  background: var(--app-accent);
  box-shadow: inset 0 0 0 2px var(--app-panel);
}

.ask-option-label {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.ask-custom-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 2px;
}

.ask-custom-label {
  flex-shrink: 0;
  font-size: 0.74rem;
  font-weight: 700;
  color: var(--app-text-muted);
  letter-spacing: 0.04em;
}

.ask-custom-input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel);
  color: var(--app-text);
  font-size: 0.84rem;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.ask-custom-input:focus {
  border-color: var(--app-accent);
  box-shadow: 0 0 0 2px var(--app-accent-soft);
}

.ask-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--app-border);
}

.ask-cancel-btn,
.ask-submit-btn {
  height: 32px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel);
  color: var(--app-text);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.ask-cancel-btn:hover {
  border-color: var(--app-danger);
  color: var(--app-danger);
}

.ask-submit-btn {
  border-color: var(--app-accent);
  background: var(--app-accent);
  color: #ffffff;
}

.ask-submit-btn:hover:not(:disabled) {
  background: var(--app-accent-strong);
  border-color: var(--app-accent-strong);
}

.ask-submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ask-expand-enter-active,
.ask-expand-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
  transform-origin: bottom center;
}

.ask-expand-enter-from,
.ask-expand-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

@media (max-width: 860px) {
  .ask-shell {
    padding: 0 16px;
  }

  .ask-float {
    width: calc(100% - 16px);
  }

  .ask-strip {
    grid-template-columns: auto minmax(0, 1fr) auto auto;
  }
}
</style>
