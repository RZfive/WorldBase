<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { ChatMessageBlock, ToolRun } from '../types'
import { translateProgressEntry } from '../progress-i18n'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'tool' }>
}>()

const { t } = useI18n()

function getToolRunStatusLabel (status: ToolRun['status']): string {
  if (status === 'completed') return t('chatUi.toolStatusCompleted')
  if (status === 'failed') return t('chatUi.toolStatusFailed')
  return t('chatUi.toolStatusRunning')
}

function getProgressStage (step: ToolRun['progress'][number]): string {
  return translateProgressEntry(step, t).stage
}

function getProgressDetail (step: ToolRun['progress'][number]): string | undefined {
  return translateProgressEntry(step, t).detail
}
</script>

<template>
  <div
    class="message-event-card tool-event-card"
    :class="props.block.toolRun.status"
  >
    <div class="tool-run-header">
      <div class="tool-run-name">{{ props.block.toolRun.name }}</div>
      <span class="tool-run-status" :class="props.block.toolRun.status">
        {{ getToolRunStatusLabel(props.block.toolRun.status) }}
      </span>
    </div>

    <div v-if="props.block.toolRun.progress.length > 0" class="tool-run-steps">
      <div
        v-for="(step, stepIndex) in props.block.toolRun.progress"
        :key="`${props.block.toolRun.id}-${stepIndex}`"
        class="tool-run-step"
      >
        <span class="tool-run-step-index">{{ stepIndex + 1 }}</span>
        <div class="tool-run-step-body">
          <div class="tool-run-step-stage">{{ getProgressStage(step) }}</div>
          <div v-if="getProgressDetail(step)" class="tool-run-step-detail">{{ getProgressDetail(step) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.message-event-card {
  width: min(100%, var(--chat-event-card-max, 1080px));
  border: 1px solid var(--app-border-strong);
  border-radius: 18px;
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);
  overflow: hidden;
}

.tool-event-card {
  padding: 14px 16px;
}

.tool-event-card.running {
  border-color: var(--app-accent-glow);
}

.tool-event-card.completed {
  border-color: rgba(34, 197, 94, 0.22);
}

.tool-event-card.failed {
  border-color: rgba(239, 68, 68, 0.22);
}

.tool-run-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.tool-run-name {
  font-size: 0.84em;
  font-weight: 600;
  color: var(--app-text-strong);
}

.tool-run-status {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 0.74em;
  border: 1px solid var(--app-border-strong);
  color: var(--app-text-muted);
  background: var(--app-panel-strong);
}

.tool-run-status.running {
  border-color: var(--app-accent-glow);
  color: var(--app-accent-strong);
  background: var(--app-accent-soft);
}

.tool-run-status.completed {
  border-color: rgba(34, 197, 94, 0.26);
  color: #15803d;
  background: rgba(34, 197, 94, 0.12);
}

.tool-run-status.failed {
  border-color: rgba(239, 68, 68, 0.25);
  color: #dc2626;
  background: rgba(239, 68, 68, 0.12);
}

.tool-run-steps {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tool-run-step {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.tool-run-step-index {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--app-panel-strong);
  border: 1px solid var(--app-border-strong);
  color: var(--app-text-muted);
  font-size: 0.72em;
}

.tool-run-step-body {
  min-width: 0;
}

.tool-run-step-stage {
  font-size: 0.82em;
  color: var(--app-text);
}

.tool-run-step-detail {
  margin-top: 3px;
  font-size: 0.76em;
  color: var(--app-text-muted);
  word-break: break-word;
}
</style>
