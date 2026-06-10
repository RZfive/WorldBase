<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { renderMarkdown } from '../chat/markdown'

const props = defineProps<{
  report: ScheduledTaskRunReport | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const visible = computed(() => Boolean(props.report))

function closeDialog () {
  emit('close')
}

function onKeydown (event: KeyboardEvent) {
  if (event.key === 'Escape') {
    closeDialog()
  }
}

function formatTimestamp (value?: string | null): string {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN')
}

function statusLabel (status: ScheduledTaskRunReport['status']): string {
  switch (status) {
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'retrying': return '重试中'
    default: return '执行中'
  }
}

function statusClass (status: ScheduledTaskRunReport['status']): string {
  switch (status) {
    case 'completed': return 'is-completed'
    case 'failed': return 'is-failed'
    case 'retrying': return 'is-retrying'
    default: return 'is-running'
  }
}

function triggerLabel (trigger: ScheduledTaskRunReport['trigger']): string {
  return trigger === 'manual' ? '手动执行' : '计划触发'
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
            <p class="task-report-eyebrow">任务执行报告</p>
            <h3>{{ report.taskTitle }}</h3>
            <div class="task-report-meta-row">
              <span class="task-report-pill" :class="statusClass(report.status)">{{ statusLabel(report.status) }}</span>
              <span>{{ triggerLabel(report.trigger) }}</span>
              <span>第 {{ report.attempt }} 次尝试</span>
            </div>
          </div>
          <button class="task-report-close" type="button" @click="closeDialog">关闭</button>
        </header>

        <section class="task-report-summary-grid">
          <div class="task-report-metric">
            <span>计划时间</span>
            <strong>{{ formatTimestamp(report.scheduledFor) }}</strong>
          </div>
          <div class="task-report-metric">
            <span>开始时间</span>
            <strong>{{ formatTimestamp(report.startedAt) }}</strong>
          </div>
          <div class="task-report-metric">
            <span>结束时间</span>
            <strong>{{ formatTimestamp(report.finishedAt) }}</strong>
          </div>
          <div class="task-report-metric">
            <span>重试计划</span>
            <strong>{{ formatTimestamp(report.retryScheduledAt) }}</strong>
          </div>
        </section>

        <section class="task-report-section">
          <h4>摘要</h4>
          <div class="task-report-summary markdown-body" v-html="renderMarkdown(report.summary || '')"></div>
          <p v-if="report.error" class="task-report-error">{{ report.error }}</p>
        </section>

        <section class="task-report-section">
          <h4>执行提示词</h4>
          <pre class="task-report-pre">{{ report.prompt }}</pre>
        </section>

        <section v-if="report.resultText" class="task-report-section">
          <h4>执行结果</h4>
          <div class="task-report-result markdown-body" v-html="renderMarkdown(report.resultText || '')"></div>
        </section>

        <section class="task-report-section">
          <h4>执行轨迹</h4>
          <div v-if="report.progress.length === 0" class="task-report-empty">当前没有进度记录。</div>
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

        <section class="task-report-section task-report-tags">
          <div>
            <h4>Skill</h4>
            <div class="task-report-tag-list">
              <span v-for="skillId in report.selectedSkillIds" :key="skillId" class="task-report-tag">{{ skillId }}</span>
              <span v-if="report.selectedSkillIds.length === 0" class="task-report-empty-inline">未限制</span>
            </div>
          </div>
          <div>
            <h4>MCP</h4>
            <div class="task-report-tag-list">
              <span v-for="serverId in report.selectedMcpServerIds" :key="serverId" class="task-report-tag">{{ serverId }}</span>
              <span v-if="report.selectedMcpServerIds.length === 0" class="task-report-empty-inline">未限制</span>
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

.task-report-meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
  font-size: 0.82rem;
  color: var(--app-text-soft);
}

.task-report-pill,
.task-report-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 0.76rem;
  border: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.04);
}

.task-report-pill.is-completed {
  color: #166534;
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.28);
}

.task-report-pill.is-failed {
  color: #b91c1c;
  background: rgba(239, 68, 68, 0.12);
  border-color: rgba(239, 68, 68, 0.24);
}

.task-report-pill.is-retrying {
  color: #92400e;
  background: rgba(250, 204, 21, 0.16);
  border-color: rgba(250, 204, 21, 0.28);
}

.task-report-pill.is-running {
  color: #0f766e;
  background: rgba(45, 212, 191, 0.16);
  border-color: rgba(45, 212, 191, 0.24);
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

.task-report-summary-grid,
.task-report-tags {
  display: grid;
  gap: 14px;
  padding: 18px 26px 0;
}

.task-report-summary-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.task-report-metric {
  padding: 14px;
  border-radius: 16px;
  border: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.04);
}

.task-report-metric span,
.task-report-progress-time {
  display: block;
  font-size: 0.76rem;
  color: var(--app-text-faint);
}

.task-report-metric strong {
  display: block;
  margin-top: 6px;
  font-size: 0.88rem;
  color: var(--app-text);
  line-height: 1.5;
}

.task-report-section {
  padding: 18px 26px 0;
}

.task-report-summary,
.task-report-progress-body p,
.task-report-empty,
.task-report-empty-inline {
  margin: 10px 0 0;
  color: var(--app-text-soft);
  font-size: 0.84rem;
  line-height: 1.6;
}

.task-report-error {
  margin: 10px 0 0;
  color: #b91c1c;
  font-size: 0.84rem;
  line-height: 1.6;
}

.task-report-pre {
  margin: 10px 0 0;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--app-text);
  font-size: 0.82rem;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
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

.task-report-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.task-report-empty-inline {
  margin-top: 0;
}

@media (max-width: 880px) {
  .task-report-summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

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
  .task-report-summary-grid,
  .task-report-section,
  .task-report-tags {
    padding-left: 18px;
    padding-right: 18px;
  }

  .task-report-header {
    flex-direction: column;
  }

  .task-report-summary-grid {
    grid-template-columns: 1fr;
  }
}
</style>