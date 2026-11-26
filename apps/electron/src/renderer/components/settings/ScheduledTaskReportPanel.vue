<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ExecutionDisclosure from '../chat/blocks/ExecutionDisclosure.vue'
import { renderMarkdown } from '../chat/markdown'
import { formatElapsedDuration, getToolRunDisplayName } from '../chat/message-utils'
import { translateProgressEntry } from '../chat/progress-i18n'
import {
  buildScheduledTaskTrace,
  type ScheduledTaskTraceItem,
  type ScheduledTaskTraceStep,
  type ScheduledTaskTraceTool
} from './scheduled-task-trace'

const props = defineProps<{
  report: ScheduledTaskRunReport
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const { t, locale } = useI18n()

const nowTick = ref(Date.now())
let tickTimer: number | null = null

const isLive = computed(() => {
  return props.report.status === 'running' || props.report.status === 'retrying'
})

watch(isLive, (live) => {
  if (live && tickTimer == null) {
    nowTick.value = Date.now()
    tickTimer = window.setInterval(() => {
      nowTick.value = Date.now()
    }, 1000)
  } else if (!live && tickTimer != null) {
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

const thinkingText = computed(() => props.report.thinkingText?.trim() || '')
const trace = computed(() => {
  return buildScheduledTaskTrace(props.report.progress, props.report.status, Boolean(thinkingText.value))
})

const resultContent = computed(() => {
  const report = props.report
  const result = report.outputText?.trim() || report.resultText?.trim()
  if (result) return result
  if (report.error?.trim()) return ''
  return report.summary?.trim() || ''
})

const errorContent = computed(() => props.report.error?.trim() || '')

const durationSeconds = computed(() => {
  const startedAt = Date.parse(props.report.startedAt)
  if (!Number.isFinite(startedAt)) return null
  const finishedAt = props.report.finishedAt ? Date.parse(props.report.finishedAt) : NaN
  const endedAt = Number.isFinite(finishedAt)
    ? finishedAt
    : (isLive.value ? nowTick.value : Date.now())
  if (endedAt < startedAt) return null
  return (endedAt - startedAt) / 1000
})

const durationLabel = computed(() => {
  if (durationSeconds.value == null || durationSeconds.value < 1) return ''
  return formatElapsedDuration(durationSeconds.value, t)
})

const traceStatus = computed<'running' | 'completed' | 'failed'>(() => {
  if (props.report.status === 'failed') return 'failed'
  return isLive.value ? 'running' : 'completed'
})

const traceTitle = computed(() => {
  const title = t('settings.taskReport.progressTitle')
  return durationLabel.value
    ? `${title} · ${durationLabel.value}`
    : title
})

const traceMeta = computed(() => {
  const parts: string[] = []
  if (trace.value.tools.length > 0) {
    parts.push(t('settings.taskReport.toolCount', { count: trace.value.tools.length }))
  }
  if (trace.value.stepCount > 0) {
    parts.push(t('settings.taskReport.stepCount', { count: trace.value.stepCount }))
  }
  return parts.join(' · ')
})

const latestActivity = computed(() => {
  const lastItem = trace.value.items[trace.value.items.length - 1]
  if (!lastItem) return ''
  if (lastItem.kind === 'thinking') return t('settings.taskReport.thinkingTitle')
  if (lastItem.kind === 'stage') return stepText(lastItem.step)
  const lastStep = lastItem.tool.steps[lastItem.tool.steps.length - 1]
  return lastStep ? stepText(lastStep) : getToolRunDisplayName(lastItem.tool.name)
})

const statusLabel = computed(() => {
  switch (props.report.status) {
    case 'completed': return t('settings.scheduledTasks.statusCompleted')
    case 'failed': return t('settings.scheduledTasks.statusFailed')
    case 'retrying': return t('settings.scheduledTasks.statusRetrying')
    default: return t('settings.scheduledTasks.statusRunning')
  }
})

const statusClass = computed(() => `is-${props.report.status}`)

const triggerLabel = computed(() => {
  return props.report.trigger === 'manual'
    ? t('settings.scheduledTasks.manualTrigger')
    : t('settings.scheduledTasks.scheduledTrigger')
})

function localizedStep (step: ScheduledTaskTraceStep): { stage: string; detail?: string } {
  return translateProgressEntry({ stage: step.stage, detail: step.detail }, t)
}

function stepText (step: ScheduledTaskTraceStep): string {
  const translated = localizedStep(step)
  return translated.detail ? `${translated.stage} · ${translated.detail}` : translated.stage
}

function formatTimestamp (value?: string | null): string {
  if (!value) return t('settings.taskReport.notRecorded')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(locale.value)
}

function formatClock (value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(locale.value, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function toolElapsed (tool: ScheduledTaskTraceTool): string {
  const startedAt = Date.parse(tool.startedAt)
  if (!Number.isFinite(startedAt)) return ''
  const endedAt = tool.endedAt ? Date.parse(tool.endedAt) : (tool.status === 'running' ? nowTick.value : NaN)
  if (!Number.isFinite(endedAt) || endedAt < startedAt) return ''
  const seconds = (endedAt - startedAt) / 1000
  return seconds >= 1 ? formatElapsedDuration(seconds, t) : ''
}

function toolStatusLabel (tool: ScheduledTaskTraceTool): string {
  const elapsed = toolElapsed(tool)
  if (tool.status === 'completed') {
    return elapsed
      ? t('chatUi.toolDoneElapsed', { time: elapsed })
      : t('chatUi.toolStatusCompleted')
  }
  if (tool.status === 'failed') {
    return elapsed
      ? t('chatUi.toolFailedElapsed', { time: elapsed })
      : t('chatUi.toolStatusFailed')
  }
  return elapsed
    ? t('chatUi.workingElapsed', { time: elapsed })
    : t('chatUi.toolStatusRunning')
}

function toolLatestStep (tool: ScheduledTaskTraceTool): string {
  const step = tool.steps[tool.steps.length - 1]
  return step ? stepText(step) : ''
}

function itemKey (item: ScheduledTaskTraceItem, index: number): string {
  if (item.kind === 'tool') return `tool-${item.tool.id}`
  if (item.kind === 'stage') return `stage-${item.step.at}-${index}`
  return 'thinking'
}

function closePanel (): void {
  emit('close')
}
</script>

<template>
  <aside class="task-report-panel" :aria-label="$t('settings.taskReport.eyebrow')">
    <header class="trp-header">
      <div class="trp-title-row">
        <div class="trp-heading">
          <p class="trp-eyebrow">{{ $t('settings.taskReport.eyebrow') }}</p>
          <h3>{{ report.taskTitle }}</h3>
        </div>
        <div class="trp-actions">
          <span class="trp-status" :class="statusClass">{{ statusLabel }}</span>
          <button class="trp-close" type="button" :aria-label="$t('settings.taskReport.close')" @click="closePanel">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </div>
    </header>

    <div class="trp-body">
      <div class="trp-run-meta">
        <span>{{ triggerLabel }}</span>
        <span :title="formatTimestamp(report.startedAt)">{{ formatTimestamp(report.startedAt) }}</span>
        <span v-if="durationLabel" :title="formatTimestamp(report.finishedAt)">
          {{ $t('settings.taskReport.duration', { time: durationLabel }) }}
        </span>
        <span>{{ $t('settings.scheduledTasks.attemptCount', { count: report.attempt }) }}</span>
      </div>

      <ExecutionDisclosure
        v-if="trace.items.length > 0"
        class="trp-trace"
        :title="traceTitle"
        :status="traceStatus"
        :detail="latestActivity"
      >
        <template v-if="traceMeta" #meta>
          <span class="execution-meta trp-trace-meta">{{ traceMeta }}</span>
        </template>

        <div class="trp-trace-body">
          <template v-for="(item, index) in trace.items" :key="itemKey(item, index)">
            <div v-if="item.kind === 'stage'" class="trp-stage">
              <time class="trp-time" :datetime="item.step.at" :title="formatTimestamp(item.step.at)">
                {{ formatClock(item.step.at) }}
              </time>
              <div class="trp-stage-copy">
                <strong>{{ localizedStep(item.step).stage }}</strong>
                <p v-if="localizedStep(item.step).detail">{{ localizedStep(item.step).detail }}</p>
              </div>
            </div>

            <ExecutionDisclosure
              v-else-if="item.kind === 'tool'"
              class="trp-tool"
              :title="getToolRunDisplayName(item.tool.name)"
              :meta="toolStatusLabel(item.tool)"
              :detail="toolLatestStep(item.tool)"
              :status="item.tool.status"
            >
              <div v-if="item.tool.steps.length > 0" class="trp-step-list">
                <div
                  v-for="(step, stepIndex) in item.tool.steps"
                  :key="`${item.tool.id}-${step.at}-${stepIndex}`"
                  class="trp-step"
                >
                  <time class="trp-time" :datetime="step.at" :title="formatTimestamp(step.at)">
                    {{ formatClock(step.at) }}
                  </time>
                  <div class="trp-step-copy">
                    <span>{{ localizedStep(step).stage }}</span>
                    <p v-if="localizedStep(step).detail">{{ localizedStep(step).detail }}</p>
                  </div>
                </div>
              </div>
              <p v-else class="trp-inline-empty">{{ $t('settings.taskReport.emptyProgress') }}</p>
            </ExecutionDisclosure>

            <ExecutionDisclosure
              v-else
              class="trp-thinking"
              :title="$t('settings.taskReport.thinkingTitle')"
              status="neutral"
            >
              <div class="trp-thinking-body">{{ thinkingText }}</div>
            </ExecutionDisclosure>
          </template>
        </div>
      </ExecutionDisclosure>

      <section class="trp-result">
        <div class="trp-result-head">
          <span>{{ $t('settings.taskReport.resultTitle') }}</span>
        </div>
        <div
          v-if="resultContent"
          class="trp-result-body markdown-body"
          v-html="renderMarkdown(resultContent)"
        ></div>
        <div v-if="errorContent" class="trp-error">
          <strong>{{ $t('settings.taskReport.errorTitle') }}</strong>
          <p>{{ errorContent }}</p>
        </div>
        <div v-if="!resultContent && !errorContent" class="trp-empty">
          {{ $t('settings.taskReport.emptyResult') }}
        </div>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.task-report-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-left: 1px solid var(--app-border);
  background: var(--app-panel);
  animation: trp-panel-in 240ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.trp-header {
  flex: 0 0 auto;
  box-sizing: border-box;
  min-height: var(--st-pane-head-height, 64px);
  display: flex;
  align-items: center;
  padding: 11px 18px;
  border-bottom: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel) 86%, transparent);
}

.trp-title-row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.trp-heading {
  flex: 1 1 auto;
  min-width: 0;
}

.trp-eyebrow {
  margin: 0;
  color: var(--app-text-faint);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.56rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.trp-heading h3 {
  margin: 4px 0 0;
  overflow: hidden;
  color: var(--app-text-strong);
  font-size: 1rem;
  font-weight: 650;
  letter-spacing: -0.015em;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trp-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.trp-close {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--app-border);
  border-radius: 9px;
  color: var(--app-text-muted);
  background: var(--app-panel-muted);
  cursor: pointer;
}

.trp-close svg {
  width: 14px;
  height: 14px;
}

.trp-close:hover {
  border-color: var(--app-border-strong);
  color: var(--app-text);
  background: var(--app-panel-subtle);
}

.trp-run-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  margin-top: -3px;
  color: var(--app-text-faint);
  font-size: 0.65rem;
  line-height: 1.4;
}

.trp-run-meta > span + span::before {
  content: '·';
  margin-right: 10px;
  color: var(--app-text-faint);
}

.trp-status {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 1px 8px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  color: var(--app-text-soft);
  background: var(--app-panel-muted);
  font-size: 0.63rem;
  font-weight: 600;
}

.trp-status.is-completed {
  border-color: color-mix(in srgb, var(--app-success) 30%, var(--app-border));
  color: var(--app-success);
  background: color-mix(in srgb, var(--app-success) 10%, transparent);
}

.trp-status.is-failed {
  border-color: color-mix(in srgb, var(--app-danger) 30%, var(--app-border));
  color: var(--app-danger-strong);
  background: color-mix(in srgb, var(--app-danger) 10%, transparent);
}

.trp-status.is-running,
.trp-status.is-retrying {
  border-color: color-mix(in srgb, var(--app-accent) 30%, var(--app-border));
  color: var(--app-accent-strong);
  background: var(--app-accent-soft);
}

.trp-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 14px 18px 24px;
  overflow-y: auto;
}

.trp-trace {
  flex: 0 0 auto;
}

.trp-trace :deep(.execution-summary) {
  min-height: 34px;
  background: color-mix(in srgb, var(--app-panel-muted) 74%, transparent);
}

.trp-trace-meta {
  color: var(--app-text-faint);
}

.trp-trace-body {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.trp-trace :deep(.execution-body),
.trp-tool :deep(.execution-body),
.trp-thinking :deep(.execution-body) {
  transform-origin: top center;
  animation: trp-disclosure-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.trp-stage {
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 7px;
}

.trp-stage:hover {
  background: color-mix(in srgb, var(--app-panel-muted) 55%, transparent);
}

.trp-time {
  color: var(--app-text-faint);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.6rem;
  line-height: 1.55;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.trp-stage-copy,
.trp-step-copy {
  min-width: 0;
  overflow-wrap: anywhere;
}

.trp-stage-copy strong,
.trp-step-copy span {
  color: var(--app-text-soft);
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1.5;
}

.trp-stage-copy p,
.trp-step-copy p {
  margin: 1px 0 0;
  color: var(--app-text-faint);
  font-size: 0.68rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.trp-tool {
  width: 100%;
}

.trp-tool :deep(.execution-summary) {
  min-height: 30px;
  padding: 5px 8px;
  border-color: color-mix(in srgb, var(--app-border) 54%, transparent);
  background: transparent;
}

.trp-tool :deep(.execution-body) {
  margin-top: 4px;
}

.trp-step-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.trp-step {
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  padding: 4px 2px;
}

.trp-inline-empty {
  margin: 2px 0;
  color: var(--app-text-faint);
  font-size: 0.7rem;
}

.trp-thinking-body {
  max-height: 300px;
  overflow: auto;
  color: var(--app-text-muted);
  font-size: 0.73rem;
  line-height: 1.62;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.trp-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.trp-result-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 2px;
  color: var(--app-text-faint);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.58rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.trp-result-head::after {
  content: '';
  flex: 1 1 auto;
  height: 1px;
  background: var(--app-border);
}

.trp-result-body {
  color: var(--app-text);
  font-size: 0.84rem;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.trp-result-body :deep(> :first-child) {
  margin-top: 0;
}

.trp-result-body :deep(> :last-child) {
  margin-bottom: 0;
}

.trp-result-body :deep(pre) {
  max-width: 100%;
  overflow-x: auto;
}

.trp-error {
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--app-danger) 26%, var(--app-border));
  border-radius: 9px;
  color: var(--app-danger-strong);
  background: color-mix(in srgb, var(--app-danger) 7%, transparent);
  font-size: 0.74rem;
  line-height: 1.55;
}

.trp-error strong {
  display: block;
  margin-bottom: 4px;
  font-size: 0.68rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.trp-error p {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.trp-empty {
  padding: 18px 0;
  color: var(--app-text-faint);
  font-size: 0.76rem;
}

@keyframes trp-panel-in {
  from {
    opacity: 0;
    transform: translateX(26px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes trp-disclosure-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .task-report-panel,
  .trp-trace :deep(.execution-body),
  .trp-tool :deep(.execution-body),
  .trp-thinking :deep(.execution-body) {
    animation: none;
  }
}

@media (max-width: 720px) {
  .trp-header {
    padding: 10px 14px;
  }

  .trp-body {
    padding: 12px 14px 18px;
  }

  .trp-stage,
  .trp-step {
    grid-template-columns: 52px minmax(0, 1fr);
    gap: 8px;
  }
}
</style>
