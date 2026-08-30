<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { LongTermGoalMessageResult } from '../../../../shared/long-term-goal-types'

const props = defineProps<{
  proposal: NonNullable<LongTermGoalMessageResult['proposal']>
}>()

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
  (e: 'adjust'): void
}>()

const { t } = useI18n()

function scheduleLabel (schedule?: unknown): string {
  if (!schedule || typeof schedule !== 'object') return ''
  const s = schedule as { kind?: string; timeOfDay?: string; weekdays?: number[]; everyMinutes?: number; runAt?: string; dates?: string[] }
  if (s.kind === 'daily') return t('chatUi.longTermGoalScheduleDaily', { time: s.timeOfDay || '' })
  if (s.kind === 'weekly') return t('chatUi.longTermGoalScheduleWeekly', { weekdays: (s.weekdays || []).join(', '), time: s.timeOfDay || '' })
  if (s.kind === 'interval') return t('chatUi.longTermGoalScheduleInterval', { minutes: s.everyMinutes ?? '' })
  if (s.kind === 'once') return t('chatUi.longTermGoalScheduleOnce', { time: s.runAt || '' })
  if (s.kind === 'dates') return t('chatUi.longTermGoalScheduleDates', { count: (s.dates || []).length })
  return ''
}

const scheduleText = computed(() => scheduleLabel(props.proposal.after?.schedule))
const title = computed(() => props.proposal.title || '')
const objective = computed(() => props.proposal.objective || '')
</script>

<template>
  <section class="ask-shell goal-create-confirm-shell">
    <div class="ask-float goal-create-confirm-float">
      <div class="ask-detail">
        <div class="ask-detail-head">
          <span class="ask-strip-status">{{ $t('chatUi.createGoalConfirmBadge') }}</span>
          <span>{{ $t('chatUi.createGoalConfirmTitle') }}</span>
        </div>

        <div class="ask-scroll">
          <div class="ask-question">
            <div class="goal-confirm-summary">
              <p v-if="title" class="goal-confirm-title">{{ title }}</p>
              <p v-if="objective" class="goal-confirm-objective">{{ objective }}</p>
              <p v-if="scheduleText" class="goal-confirm-schedule">{{ scheduleText }}</p>
            </div>
          </div>
        </div>

        <div class="ask-actions">
          <button class="ask-cancel-btn" type="button" @click="emit('cancel')">{{ $t('chatUi.cancelCreation') }}</button>
          <button class="ask-ghost-btn" type="button" @click="emit('adjust')">{{ $t('chatUi.adjustInstead') }}</button>
          <button class="ask-submit-btn" type="button" @click="emit('confirm')">{{ $t('chatUi.confirmCreateGoal') }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.goal-create-confirm-shell {
  --chat-input-overlap: 0px;
}

.goal-create-confirm-float {
  position: static;
  transform: none;
  width: 100%;
  max-width: none;
  padding: 0 18px 12px;
  box-sizing: border-box;
  pointer-events: auto;
}

.goal-create-confirm-float .ask-detail {
  border: 1px solid color-mix(in srgb, #f59e0b 32%, var(--app-border-strong));
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-panel) 96%, transparent);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
  backdrop-filter: blur(14px) saturate(130%);
  -webkit-backdrop-filter: blur(14px) saturate(130%);
}

.goal-create-confirm-float .ask-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.goal-confirm-summary {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 0 12px;
}

.goal-confirm-title {
  margin: 0;
  font-weight: 700;
  color: var(--app-text-strong);
}

.goal-confirm-objective {
  margin: 0;
  color: var(--app-text);
  white-space: pre-wrap;
}

.goal-confirm-schedule {
  margin: 0;
  color: var(--app-text-muted);
  font-size: 0.85rem;
}

.ask-ghost-btn {
  height: 34px;
  padding: 0 14px;
  border: 1px solid var(--app-border-strong);
  border-radius: 8px;
  background: transparent;
  color: var(--app-text);
  font-weight: 600;
  cursor: pointer;
}

.ask-ghost-btn:hover {
  background: color-mix(in srgb, var(--app-panel-muted) 60%, transparent);
}
</style>
