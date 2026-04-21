<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'

const props = defineProps<{
  active: boolean
}>()

const snapshot = ref<ProcessManagerSnapshot | null>(null)
const systemStatus = ref<SystemStatusSnapshot | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const actionInProgress = ref<string | null>(null)

let pollTimer: ReturnType<typeof setInterval> | null = null
const POLL_INTERVAL_MS = 5000

const managedProcesses = computed(() => snapshot.value?.managed || [])
const orphanProcesses = computed(() => snapshot.value?.orphans || [])
const runningCount = computed(() => managedProcesses.value.filter(process => process.status === 'running').length)
const totalMemory = computed(() => managedProcesses.value.reduce((sum, process) => sum + (process.memoryRssBytes || 0), 0))

const resourceCards = computed(() => {
  if (!systemStatus.value) {
    return [
      { label: 'CPU', value: '不可用', detail: '资源采样未返回', tone: 'degraded' },
      { label: '系统内存', value: '不可用', detail: '资源采样未返回', tone: 'degraded' },
      { label: 'GPU', value: '不可用', detail: '资源采样未返回', tone: 'degraded' }
    ]
  }

  return [
    {
      label: 'CPU',
      value: formatPercent(systemStatus.value.summary.cpuUsagePercent),
      detail: `${systemStatus.value.cpu.model} · ${systemStatus.value.cpu.cores} 核`,
      tone: (systemStatus.value.summary.cpuUsagePercent ?? 0) >= 85 ? 'busy' : ''
    },
    {
      label: '系统内存',
      value: formatPercent(systemStatus.value.summary.memoryUsagePercent),
      detail: `${formatBytes(systemStatus.value.memory.usedBytes)} / ${formatBytes(systemStatus.value.memory.totalBytes)}`,
      tone: systemStatus.value.summary.memoryUsagePercent >= 85 ? 'busy' : ''
    },
    {
      label: 'GPU',
      value: formatGpuStatus(systemStatus.value.gpu.status),
      detail: systemStatus.value.gpu.primaryDevice,
      tone: gpuTone(systemStatus.value.gpu.status)
    }
  ]
})

const processCards = computed(() => {
  if (!snapshot.value) return []
  return [
    { label: '运行中', value: `${runningCount.value}`, detail: '当前活跃应用进程', tone: runningCount.value > 0 ? 'ok' : '' },
    { label: '总进程', value: `${managedProcesses.value.length}`, detail: '受管应用总数', tone: '' },
    { label: '总内存占用', value: formatBytes(totalMemory.value), detail: '受管应用 RSS 汇总', tone: '' },
    { label: '遗留进程', value: `${orphanProcesses.value.length}`, detail: '可能需要手动清理', tone: orphanProcesses.value.length > 0 ? 'degraded' : 'ok' }
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
  await loadData()
  pollTimer = setInterval(() => {
    void loadData()
  }, POLL_INTERVAL_MS)
}

function stopPolling () {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function loadData () {
  if (!window.electronAPI?.getProcessSnapshot) return

  loading.value = true
  error.value = null

  const [processResult, systemResult] = await Promise.allSettled([
    window.electronAPI.getProcessSnapshot(),
    window.electronAPI.getSystemStatus ? window.electronAPI.getSystemStatus() : Promise.resolve(null)
  ])

  if (processResult.status === 'fulfilled') {
    snapshot.value = processResult.value
  } else {
    snapshot.value = null
    error.value = processResult.reason instanceof Error ? processResult.reason.message : '进程快照加载失败'
  }

  if (systemResult.status === 'fulfilled') {
    systemStatus.value = systemResult.value
  } else {
    systemStatus.value = null
  }

  loading.value = false
}

async function doRestart (projectId: string) {
  if (actionInProgress.value) return
  actionInProgress.value = `restart:${projectId}`
  try {
    const result = await window.electronAPI!.restartManagedProcess(projectId)
    if (!result.success) {
      error.value = result.error || '重启失败'
    }
    await loadData()
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
    await loadData()
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
    await loadData()
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
    await loadData()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    actionInProgress.value = null
  }
}

function formatPercent (value?: number | null): string {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : '采样中'
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

function formatGpuStatus (value: SystemStatusSnapshot['gpu']['status']) {
  if (value === 'hardware') return '硬件加速'
  if (value === 'software') return '软件渲染'
  if (value === 'disabled') return '已禁用'
  return '不可用'
}

function gpuTone (value: SystemStatusSnapshot['gpu']['status']): string {
  if (value === 'hardware') return 'ok'
  if (value === 'software') return 'busy'
  return 'degraded'
}

function formatGpuFeatureSummary (featureStatus: Record<string, string>): string {
  const enabledFeatures = Object.entries(featureStatus)
    .filter(([, status]) => status === 'enabled' || status === 'enabled_readback' || status === 'enabled_force')
    .map(([name]) => name)

  if (enabledFeatures.length === 0) {
    return '未启用硬件加速功能'
  }
  return enabledFeatures.slice(0, 3).join(' / ')
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
        <p class="pm-desc">管理当前运行的应用进程，并查看 CPU、内存、GPU 的宿主状态。</p>
      </div>
      <button class="pm-btn" :disabled="loading" @click="loadData">刷新</button>
    </div>

    <div v-if="error" class="pm-alert">
      {{ error }}
      <button class="pm-alert-close" @click="error = null">✕</button>
    </div>

    <div v-if="loading && !snapshot" class="pm-empty">加载中…</div>
    <div v-else-if="snapshot" class="pm-content">
      <section class="pm-section">
        <div class="pm-section-title">主机资源</div>
        <div class="pm-summary-grid">
          <div
            v-for="card in resourceCards"
            :key="card.label"
            :class="['pm-card', 'summary-card', card.tone ? `summary-${card.tone}` : '']"
          >
            <div class="pm-card-label">{{ card.label }}</div>
            <div class="pm-card-value">{{ card.value }}</div>
            <div class="pm-card-detail">{{ card.detail }}</div>
          </div>
        </div>
      </section>

      <section class="pm-section">
        <div class="pm-section-title">进程概览</div>
        <div class="pm-summary-grid">
          <div
            v-for="card in processCards"
            :key="card.label"
            :class="['pm-card', 'summary-card', card.tone ? `summary-${card.tone}` : '']"
          >
            <div class="pm-card-label">{{ card.label }}</div>
            <div class="pm-card-value">{{ card.value }}</div>
            <div class="pm-card-detail">{{ card.detail }}</div>
          </div>
        </div>
      </section>

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
              <tr v-for="process in managedProcesses" :key="process.projectId">
                <td class="pm-app-name">
                  <span class="pm-app-name-text" :title="process.projectId">{{ process.projectName }}</span>
                </td>
                <td>
                  <span :class="['pm-status-badge', statusTone(process.status)]">{{ formatStatus(process.status) }}</span>
                </td>
                <td class="pm-mono">{{ process.pid || '-' }}</td>
                <td class="pm-mono">{{ process.port || '-' }}</td>
                <td class="pm-mono">{{ formatBytes(process.memoryRssBytes || 0) }}</td>
                <td>{{ formatDuration(process.uptimeSeconds) }}</td>
                <td class="pm-actions">
                  <button
                    v-if="isAlive(process.status)"
                    class="pm-action-btn pm-action-restart"
                    :disabled="!!actionInProgress"
                    :title="actionInProgress === `restart:${process.projectId}` ? '重启中…' : '重启'"
                    @click="doRestart(process.projectId)"
                  >
                    {{ actionInProgress === `restart:${process.projectId}` ? '⏳' : '🔄' }}
                  </button>
                  <button
                    v-if="isAlive(process.status)"
                    class="pm-action-btn pm-action-stop"
                    :disabled="!!actionInProgress"
                    :title="actionInProgress === `stop:${process.projectId}` ? '停止中…' : '停止'"
                    @click="doStop(process.projectId)"
                  >
                    {{ actionInProgress === `stop:${process.projectId}` ? '⏳' : '⏹' }}
                  </button>
                  <button
                    v-if="isAlive(process.status)"
                    class="pm-action-btn pm-action-kill"
                    :disabled="!!actionInProgress"
                    :title="actionInProgress === `kill:${process.projectId}` ? '终止中…' : '强制终止'"
                    @click="doForceKill(process.projectId)"
                  >
                    {{ actionInProgress === `kill:${process.projectId}` ? '⏳' : '💀' }}
                  </button>
                  <span v-if="!isAlive(process.status) && process.error" class="pm-error-hint" :title="process.error">⚠ {{ process.error.slice(0, 40) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

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
              <tr v-for="process in orphanProcesses" :key="process.pid">
                <td class="pm-mono">{{ process.pid }}</td>
                <td>{{ process.name }}</td>
                <td class="pm-mono">{{ formatBytes(process.memoryRssBytes) }}</td>
                <td class="pm-cmdline" :title="process.commandLine">{{ process.commandLine }}</td>
                <td class="pm-actions">
                  <button
                    class="pm-action-btn pm-action-kill"
                    :disabled="!!actionInProgress"
                    :title="actionInProgress === `orphan:${process.pid}` ? '终止中…' : '终止'"
                    @click="doKillOrphan(process.pid)"
                  >
                    {{ actionInProgress === `orphan:${process.pid}` ? '⏳' : '💀' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div class="pm-footer">
        <span class="pm-footer-text">进程更新: {{ snapshot.fetchedAt }}</span>
        <span v-if="systemStatus" class="pm-footer-text">资源更新: {{ systemStatus.fetchedAt }}</span>
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

.pm-header,
.pm-card-header,
.pm-footer,
.pm-alert,
.pm-resource-grid,
.pm-kv div,
.pm-actions {
  display: flex;
}

.pm-header,
.pm-alert,
.pm-card-header,
.pm-kv div {
  justify-content: space-between;
}

.pm-header {
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

.pm-btn,
.pm-action-btn {
  border: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
  color: var(--app-text);
  cursor: pointer;
}

.pm-btn {
  border-radius: 10px;
  padding: 8px 14px;
  white-space: nowrap;
}

.pm-btn:disabled,
.pm-action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pm-alert {
  align-items: center;
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
}

.pm-empty,
.pm-empty-inline {
  color: var(--app-text-muted);
  font-size: 0.88rem;
}

.pm-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.pm-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pm-section-title {
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--app-text-soft);
}

.pm-summary-grid,
.pm-resource-grid {
  display: grid;
  gap: 16px;
}

.pm-summary-grid {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.pm-resource-grid {
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.pm-card,
.pm-resource-block {
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

.summary-busy {
  border-color: rgba(255, 159, 10, 0.35);
}

.summary-degraded {
  border-color: rgba(255, 69, 58, 0.35);
}

.pm-card-header {
  align-items: baseline;
  gap: 10px;
  color: var(--app-text-soft);
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 12px;
}

.pm-card-header-hint {
  font-weight: 400;
  font-size: 0.78rem;
  opacity: 0.7;
}

.pm-card-label,
.pm-resource-title {
  color: var(--app-text-soft);
  font-size: 0.82rem;
  margin-bottom: 8px;
}

.pm-card-value {
  font-size: 1.2rem;
  font-weight: 700;
}

.pm-card-detail {
  margin-top: 8px;
  font-size: 0.78rem;
  color: var(--app-text-muted);
  line-height: 1.5;
}

.pm-kv {
  display: grid;
  gap: 10px;
  margin: 0;
}

.pm-kv dt {
  color: var(--app-text-soft);
}

.pm-kv dd {
  margin: 0;
  text-align: right;
  word-break: break-word;
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

.pm-mono,
.pm-cmdline {
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
}

.pm-mono {
  font-size: 0.82rem;
}

.pm-app-name {
  max-width: 180px;
}

.pm-app-name-text,
.pm-cmdline {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pm-cmdline {
  max-width: 260px;
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
  align-items: center;
  gap: 8px;
}

.pm-action-btn {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.pm-action-restart:hover:not(:disabled) {
  color: #0a84ff;
}

.pm-action-stop:hover:not(:disabled) {
  color: #ff9f0a;
}

.pm-action-kill:hover:not(:disabled) {
  color: #ff453a;
}

.pm-error-hint {
  color: #ff9f0a;
  font-size: 0.78rem;
}

.pm-footer {
  flex-wrap: wrap;
  gap: 16px;
  color: var(--app-text-muted);
  font-size: 0.78rem;
}

@media (max-width: 800px) {
  .pm-root {
    padding: 18px;
  }

  .pm-header {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>