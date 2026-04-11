<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'

const props = defineProps<{
  active: boolean
}>()

const snapshot = ref<ProcessManagerSnapshot | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const actionInProgress = ref<string | null>(null)

let pollTimer: ReturnType<typeof setInterval> | null = null
const POLL_INTERVAL_MS = 5000

const managedProcesses = computed(() => snapshot.value?.managed || [])
const orphanProcesses = computed(() => snapshot.value?.orphans || [])
const runningCount = computed(() => managedProcesses.value.filter(p => p.status === 'running').length)
const totalMemory = computed(() => {
  return managedProcesses.value.reduce((sum, p) => sum + (p.memoryRssBytes || 0), 0)
})

const summaryCards = computed(() => {
  if (!snapshot.value) return []
  return [
    { label: '运行中', value: `${runningCount.value}`, tone: runningCount.value > 0 ? 'ok' : '' },
    { label: '总进程', value: `${managedProcesses.value.length}` },
    { label: '总内存占用', value: formatBytes(totalMemory.value) },
    { label: '遗留进程', value: `${orphanProcesses.value.length}`, tone: orphanProcesses.value.length > 0 ? 'degraded' : '' }
  ]
})

watch(() => props.active, (active) => {
  if (active) {
    void startPolling()
  } else {
    stopPolling()
  }
}, { immediate: true })

onUnmounted(() => {
  stopPolling()
})

async function startPolling () {
  stopPolling()
  await loadSnapshot()
  pollTimer = setInterval(() => {
    void loadSnapshot()
  }, POLL_INTERVAL_MS)
}

function stopPolling () {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function loadSnapshot () {
  if (!window.electronAPI?.getProcessSnapshot) return
  loading.value = true
  error.value = null
  try {
    snapshot.value = await window.electronAPI.getProcessSnapshot()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    loading.value = false
  }
}

async function doRestart (projectId: string) {
  if (actionInProgress.value) return
  actionInProgress.value = `restart:${projectId}`
  try {
    const result = await window.electronAPI!.restartManagedProcess(projectId)
    if (!result.success) {
      error.value = result.error || '重启失败'
    }
    await loadSnapshot()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    actionInProgress.value = null
  }
}

async function doStop (projectId: string) {
  if (actionInProgress.value) return
  actionInProgress.value = `stop:${projectId}`
  try {
    const result = await window.electronAPI!.stopManagedProcess(projectId)
    if (!result.success) {
      error.value = result.error || '停止失败'
    }
    await loadSnapshot()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    actionInProgress.value = null
  }
}

async function doForceKill (projectId: string) {
  if (actionInProgress.value) return
  actionInProgress.value = `kill:${projectId}`
  try {
    const result = await window.electronAPI!.forceKillManagedProcess(projectId)
    if (!result.success) {
      error.value = result.error || '强制终止失败'
    }
    await loadSnapshot()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    actionInProgress.value = null
  }
}

async function doKillOrphan (pid: number) {
  if (actionInProgress.value) return
  actionInProgress.value = `orphan:${pid}`
  try {
    const result = await window.electronAPI!.killOrphanProcess(pid)
    if (!result.success) {
      error.value = result.error || '终止遗留进程失败'
    }
    await loadSnapshot()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    actionInProgress.value = null
  }
}

function formatBytes (value: number) {
  if (!value || !Number.isFinite(value)) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
}

function formatDuration (seconds?: number) {
  if (typeof seconds !== 'number') return '-'
  if (seconds < 60) return `${Math.floor(seconds)} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`
  return `${Math.floor(seconds / 86400)} 天`
}

function formatStatus (value: string) {
  if (value === 'running') return '运行中'
  if (value === 'starting') return '启动中'
  if (value === 'stopping') return '停止中'
  if (value === 'stopped' || value === 'not_started' || value === 'not_running') return '已停止'
  if (value === 'crashed') return '已崩溃'
  if (value === 'error') return '错误'
  return value
}

function statusTone (value: string): string {
  if (value === 'running') return 'tone-ok'
  if (value === 'starting' || value === 'stopping') return 'tone-busy'
  if (value === 'crashed' || value === 'error') return 'tone-error'
  return ''
}

function isAlive (status: string): boolean {
  return status === 'running' || status === 'starting'
}
</script>

<template>
  <div class="pm-root">
    <div class="pm-header">
      <div>
        <h3 class="pm-title">进程管理</h3>
        <p class="pm-desc">管理当前运行的应用进程，查看内存占用，发现并清理遗留进程</p>
      </div>
      <button class="pm-btn" :disabled="loading" @click="loadSnapshot">刷新</button>
    </div>

    <div v-if="error" class="pm-alert">{{ error }}<button class="pm-alert-close" @click="error = null">✕</button></div>

    <div v-if="loading && !snapshot" class="pm-empty">加载中…</div>
    <div v-else-if="snapshot" class="pm-content">
      <!-- Summary cards -->
      <div class="pm-summary-grid">
        <div
          v-for="card in summaryCards"
          :key="card.label"
          :class="['pm-card', 'summary-card', card.tone ? `summary-${card.tone}` : '']"
        >
          <div class="pm-card-label">{{ card.label }}</div>
          <div class="pm-card-value">{{ card.value }}</div>
        </div>
      </div>

      <!-- Managed processes table -->
      <section class="pm-card">
        <div class="pm-card-header">应用进程</div>
        <div v-if="managedProcesses.length === 0" class="pm-empty-inline">暂无应用进程</div>
        <div v-else class="pm-table-wrap">
          <table class="pm-table">
            <thead>
              <tr>
                <th>应用名称</th>
                <th>状态</th>
                <th>PID</th>
                <th>端口</th>
                <th>内存</th>
                <th>运行时长</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="proc in managedProcesses" :key="proc.projectId">
                <td class="pm-app-name">
                  <span class="pm-app-name-text" :title="proc.projectId">{{ proc.projectName }}</span>
                </td>
                <td>
                  <span :class="['pm-status-badge', statusTone(proc.status)]">{{ formatStatus(proc.status) }}</span>
                </td>
                <td class="pm-mono">{{ proc.pid || '-' }}</td>
                <td class="pm-mono">{{ proc.port || '-' }}</td>
                <td class="pm-mono">{{ formatBytes(proc.memoryRssBytes || 0) }}</td>
                <td>{{ formatDuration(proc.uptimeSeconds) }}</td>
                <td class="pm-actions">
                  <button
                    v-if="isAlive(proc.status)"
                    class="pm-action-btn pm-action-restart"
                    :disabled="!!actionInProgress"
                    :title="actionInProgress === `restart:${proc.projectId}` ? '重启中…' : '重启'"
                    @click="doRestart(proc.projectId)"
                  >
                    {{ actionInProgress === `restart:${proc.projectId}` ? '⏳' : '🔄' }}
                  </button>
                  <button
                    v-if="isAlive(proc.status)"
                    class="pm-action-btn pm-action-stop"
                    :disabled="!!actionInProgress"
                    :title="actionInProgress === `stop:${proc.projectId}` ? '停止中…' : '停止'"
                    @click="doStop(proc.projectId)"
                  >
                    {{ actionInProgress === `stop:${proc.projectId}` ? '⏳' : '⏹' }}
                  </button>
                  <button
                    v-if="isAlive(proc.status)"
                    class="pm-action-btn pm-action-kill"
                    :disabled="!!actionInProgress"
                    :title="actionInProgress === `kill:${proc.projectId}` ? '终止中…' : '强制终止'"
                    @click="doForceKill(proc.projectId)"
                  >
                    {{ actionInProgress === `kill:${proc.projectId}` ? '⏳' : '💀' }}
                  </button>
                  <span v-if="!isAlive(proc.status) && proc.error" class="pm-error-hint" :title="proc.error">⚠ {{ proc.error?.slice(0, 40) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Orphan processes table -->
      <section class="pm-card">
        <div class="pm-card-header">
          遗留进程
          <span class="pm-card-header-hint">系统中发现的可能由本应用产生的遗留 Node 进程</span>
        </div>
        <div v-if="orphanProcesses.length === 0" class="pm-empty-inline">未发现遗留进程 ✓</div>
        <div v-else class="pm-table-wrap">
          <table class="pm-table">
            <thead>
              <tr>
                <th>PID</th>
                <th>进程名</th>
                <th>内存</th>
                <th>命令行</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="proc in orphanProcesses" :key="proc.pid">
                <td class="pm-mono">{{ proc.pid }}</td>
                <td>{{ proc.name }}</td>
                <td class="pm-mono">{{ formatBytes(proc.memoryRssBytes) }}</td>
                <td class="pm-cmdline" :title="proc.commandLine">{{ proc.commandLine }}</td>
                <td class="pm-actions">
                  <button
                    class="pm-action-btn pm-action-kill"
                    :disabled="!!actionInProgress"
                    :title="actionInProgress === `orphan:${proc.pid}` ? '终止中…' : '终止'"
                    @click="doKillOrphan(proc.pid)"
                  >
                    {{ actionInProgress === `orphan:${proc.pid}` ? '⏳' : '💀' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div class="pm-footer">
        <span class="pm-footer-text">最近更新: {{ snapshot.fetchedAt }}</span>
        <span class="pm-footer-text">自动刷新: 每 {{ POLL_INTERVAL_MS / 1000 }} 秒</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pm-root {
  height: 100%;
  padding: 24px;
  overflow: auto;
}

.pm-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 20px;
}

.pm-title {
  margin: 0;
  font-size: 1.1rem;
}

.pm-desc {
  margin: 6px 0 0;
  color: var(--app-text-soft);
  font-size: 0.9rem;
}

.pm-btn {
  border: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
  color: var(--app-text);
  border-radius: 10px;
  padding: 8px 14px;
  cursor: pointer;
  white-space: nowrap;
}

.pm-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pm-alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  margin-bottom: 16px;
  background: rgba(255, 69, 58, 0.1);
  border: 1px solid rgba(255, 69, 58, 0.3);
  border-radius: 10px;
  color: #ff453a;
  font-size: 0.9rem;
}

.pm-alert-close {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 0.85rem;
  padding: 2px 6px;
  border-radius: 4px;
}

.pm-alert-close:hover {
  background: rgba(255, 69, 58, 0.15);
}

.pm-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.pm-summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 16px;
}

.pm-card {
  border: 1px solid var(--app-border);
  background: var(--app-panel);
  border-radius: 14px;
  padding: 16px;
}

.summary-card {
  text-align: center;
}

.summary-ok {
  border-color: rgba(52, 199, 89, 0.35);
}

.summary-degraded {
  border-color: rgba(255, 69, 58, 0.35);
}

.pm-card-header {
  color: var(--app-text-soft);
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 12px;
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.pm-card-header-hint {
  font-weight: 400;
  font-size: 0.78rem;
  opacity: 0.7;
}

.pm-card-label {
  color: var(--app-text-soft);
  font-size: 0.82rem;
  margin-bottom: 8px;
}

.pm-card-value {
  font-size: 1.2rem;
  font-weight: 700;
}

.pm-table-wrap {
  overflow: auto;
}

.pm-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}

.pm-table th,
.pm-table td {
  padding: 10px 8px;
  border-bottom: 1px solid var(--app-border);
  text-align: left;
  white-space: nowrap;
}

.pm-table th {
  color: var(--app-text-soft);
  font-weight: 600;
  font-size: 0.82rem;
}

.pm-mono {
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  font-size: 0.82rem;
}

.pm-app-name {
  max-width: 180px;
}

.pm-app-name-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pm-cmdline {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  font-size: 0.78rem;
  color: var(--app-text-soft);
}

.pm-status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 600;
  background: var(--app-panel-subtle);
}

.pm-status-badge.tone-ok {
  background: rgba(52, 199, 89, 0.15);
  color: #34c759;
}

.pm-status-badge.tone-busy {
  background: rgba(255, 159, 10, 0.15);
  color: #ff9f0a;
}

.pm-status-badge.tone-error {
  background: rgba(255, 69, 58, 0.15);
  color: #ff453a;
}

.pm-actions {
  display: flex;
  gap: 4px;
  align-items: center;
}

.pm-action-btn {
  border: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
  border-radius: 6px;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 0.85rem;
  line-height: 1;
  transition: background 0.12s, border-color 0.12s;
}

.pm-action-btn:hover:not(:disabled) {
  background: var(--app-panel);
  border-color: var(--app-text-soft);
}

.pm-action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.pm-action-restart:hover:not(:disabled) {
  border-color: rgba(52, 199, 89, 0.6);
  background: rgba(52, 199, 89, 0.08);
}

.pm-action-stop:hover:not(:disabled) {
  border-color: rgba(255, 159, 10, 0.6);
  background: rgba(255, 159, 10, 0.08);
}

.pm-action-kill:hover:not(:disabled) {
  border-color: rgba(255, 69, 58, 0.6);
  background: rgba(255, 69, 58, 0.08);
}

.pm-error-hint {
  color: #ff9f0a;
  font-size: 0.78rem;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pm-empty,
.pm-empty-inline {
  padding: 28px;
  border: 1px dashed var(--app-border);
  border-radius: 14px;
  text-align: center;
  color: var(--app-text-soft);
}

.pm-footer {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 4px 0;
}

.pm-footer-text {
  color: var(--app-text-soft);
  font-size: 0.78rem;
}
</style>
