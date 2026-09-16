<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ChatMessageBlock, ToolRun } from '../types'
import { formatElapsedDuration } from '../message-utils'
import { translateProgressEntry } from '../progress-i18n'
import ExecutionDisclosure from './ExecutionDisclosure.vue'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'tool' }>
}>()

const { t } = useI18n()

// Codex-style work row: live seconds while the run is active, frozen total
// once it reaches a terminal status (design v1.7 P1).
const nowTick = ref(Date.now())
let tickTimer: number | null = null

watch(() => props.block.toolRun.status, (status) => {
  if (status === 'running' && tickTimer == null) {
    nowTick.value = Date.now()
    tickTimer = window.setInterval(() => {
      nowTick.value = Date.now()
    }, 1000)
  } else if (status !== 'running' && tickTimer != null) {
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

const elapsedLabel = computed(() => {
  const { startedAt, endedAt, status } = props.block.toolRun
  if (status === 'running') {
    if (typeof startedAt !== 'number') return ''
    const liveSeconds = (nowTick.value - startedAt) / 1000
    return liveSeconds >= 1 ? formatElapsedDuration(liveSeconds, t) : ''
  }
  if (typeof startedAt !== 'number' || typeof endedAt !== 'number' || endedAt < startedAt) return ''
  const seconds = (endedAt - startedAt) / 1000
  // Sub-second runs would read as "完成 · 0 秒" — just show the status.
  return seconds >= 1 ? formatElapsedDuration(seconds, t) : ''
})

function getToolRunSummaryStatusLabel (status: ToolRun['status']): string {
  if (status === 'completed') {
    return elapsedLabel.value ? t('chatUi.toolDoneElapsed', { time: elapsedLabel.value }) : ''
  }
  if (status === 'failed') {
    return elapsedLabel.value
      ? t('chatUi.toolFailedElapsed', { time: elapsedLabel.value })
      : t('chatUi.toolStatusFailed')
  }
  return elapsedLabel.value
    ? t('chatUi.workingElapsed', { time: elapsedLabel.value })
    : t('chatUi.toolStatusRunning')
}

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

function getLatestProgressText (): string {
  const latest = props.block.toolRun.progress[props.block.toolRun.progress.length - 1]
  if (!latest) return ''
  const translated = translateProgressEntry(latest, t)
  return translated.detail ? `${translated.stage}: ${translated.detail}` : translated.stage
}

function getToolRunDisplayName (name: string): string {
  if (name === 'long_term_goal_propose_update') return '生成待确认目标变更'
  if (name === 'long_term_goal_get_context') return '读取长期目标状态'
  if (name === 'long_term_goal_update_schedule') return '更新长期目标排期'
  if (name === 'long_term_goal_record_run_result') return '记录长期目标执行结果'
  return name
}
</script>

<template>
  <ExecutionDisclosure
    :title="getToolRunDisplayName(props.block.toolRun.name)"
    :meta="getToolRunSummaryStatusLabel(props.block.toolRun.status)"
    :detail="getLatestProgressText()"
    :status="props.block.toolRun.status"
    :default-expanded="props.block.toolRun.status === 'failed'"
  >
    <div class="tool-run-header">
      <div class="tool-run-name">{{ getToolRunDisplayName(props.block.toolRun.name) }}</div>
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
  </ExecutionDisclosure>
</template>

<style scoped>
.tool-run-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.tool-run-name {
  min-width: 0;
  font-size: 0.8em;
  font-weight: 600;
  color: var(--app-text-strong);
  overflow-wrap: anywhere;
}

.tool-run-status {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.7em;
  border: 1px solid var(--app-border);
  color: var(--app-text-muted);
  background: transparent;
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
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tool-run-step {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.tool-run-step-index {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: transparent;
  border: 1px solid var(--app-border);
  color: var(--app-text-muted);
  font-size: 0.68em;
}

.tool-run-step-body {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}

.tool-run-step-stage {
  font-size: 0.78em;
  color: var(--app-text);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.tool-run-step-detail {
  margin-top: 3px;
  font-size: 0.74em;
  color: var(--app-text-muted);
  overflow-wrap: anywhere;
  word-break: break-word;
}
</style>
