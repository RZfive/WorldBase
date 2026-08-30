<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderMarkdown } from '../chat/markdown'

const props = defineProps<{
  report: ScheduledTaskRunReport | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const { t, locale } = useI18n()

const visible = computed(() => Boolean(props.report))
const resultContent = computed(() => {
  if (!props.report) return ''
  return props.report.resultText?.trim() || props.report.error?.trim() || ''
})

function closeDialog () {
  emit('close')
}

function onKeydown (event: KeyboardEvent) {
  if (event.key === 'Escape') {
    closeDialog()
  }
}

function formatTimestamp (value?: string | null): string {
  if (!value) return t('settings.taskReport.notRecorded')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(locale.value)
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="visible && report" class="task-report-overlay" @click.self="closeDialog">
      <div class="task-report-dialog">
        <header class="task-report-header">
          <div>
            <p class="task-report-eyebrow">{{ $t('settings.taskReport.eyebrow') }}</p>
            <h3>{{ report.taskTitle }}</h3>
          </div>
          <button class="task-report-close" type="button" @click="closeDialog">{{ $t('settings.taskReport.close') }}</button>
        </header>

        <section class="task-report-section">
          <h4>{{ $t('settings.taskReport.resultTitle') }}</h4>
          <div v-if="resultContent" class="task-report-result markdown-body" v-html="renderMarkdown(resultContent)"></div>
          <div v-else class="task-report-empty">{{ $t('settings.taskReport.emptyResult') }}</div>
        </section>

        <section class="task-report-section">
          <h4>{{ $t('settings.taskReport.progressTitle') }}</h4>
          <div v-if="report.progress.length === 0" class="task-report-empty">{{ $t('settings.taskReport.emptyProgress') }}</div>
          <div v-else class="task-report-progress-list">
            <div v-for="entry in report.progress" :key="`${entry.at}-${entry.stage}-${entry.detail || ''}`" class="task-report-progress-item">
              <div class="task-report-progress-time">{{ formatTimestamp(entry.at) }}</div>
              <div class="task-report-progress-body">
                <strong>{{ entry.stage }}</strong>
                <p v-if="entry.detail">{{ entry.detail }}</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.task-report-overlay {
  position: fixed;
  inset: 0;
  z-index: 10400;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(8, 15, 24, 0.62);
  backdrop-filter: blur(8px);
}

.task-report-dialog {
  width: min(920px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  overflow: auto;
  border-radius: 24px;
  border: 1px solid var(--app-border);
  background:
    radial-gradient(circle at top right, rgba(34, 197, 94, 0.08), transparent 24%),
    var(--app-panel-strong);
  box-shadow: var(--app-shadow);
}

.task-report-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 24px 26px 18px;
  border-bottom: 1px solid var(--app-border);
}

.task-report-eyebrow {
  margin: 0 0 6px;
  font-size: 0.74rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--app-text-faint);
}

.task-report-header h3,
.task-report-section h4 {
  margin: 0;
  color: var(--app-text);
}

.task-report-close {
  flex-shrink: 0;
  padding: 9px 16px;
  border-radius: 12px;
  border: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--app-text);
  cursor: pointer;
}

.task-report-progress-time {
  display: block;
  font-size: 0.76rem;
  color: var(--app-text-faint);
}

.task-report-section {
  padding: 18px 26px 0;
}

.task-report-progress-body p,
.task-report-empty {
  margin: 10px 0 0;
  color: var(--app-text-soft);
  font-size: 0.84rem;
  line-height: 1.6;
}

.task-report-section:last-child {
  padding-bottom: 26px;
}

.task-report-result {
  margin: 10px 0 0;
  padding: 14px 16px;
  border-radius: 16px;
  border: 1px solid var(--app-border);
  background: rgba(34, 197, 94, 0.06);
  color: var(--app-text);
  font-size: 0.84rem;
  line-height: 1.65;
  overflow-x: auto;
}

.task-report-progress-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}

.task-report-progress-item {
  display: grid;
  grid-template-columns: 148px minmax(0, 1fr);
  gap: 14px;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.03);
}

.task-report-progress-body strong {
  color: var(--app-text);
}

@media (max-width: 880px) {
  .task-report-progress-item {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .task-report-overlay {
    padding: 12px;
  }

  .task-report-dialog {
    width: 100%;
    max-height: calc(100vh - 24px);
  }

  .task-report-header,
  .task-report-section {
    padding-left: 18px;
    padding-right: 18px;
  }

  .task-report-header {
    flex-direction: column;
  }
}
</style>
