<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  active: boolean
}>()

const { t } = useI18n()

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
      { label: 'CPU', value: t('settings.processManager.unavailable'), detail: t('settings.processManager.resourceSamplingUnavailable'), tone: 'degraded' },
      { label: t('settings.processManager.systemMemory'), value: t('settings.processManager.unavailable'), detail: t('settings.processManager.resourceSamplingUnavailable'), tone: 'degraded' },
      { label: 'GPU', value: t('settings.processManager.unavailable'), detail: t('settings.processManager.resourceSamplingUnavailable'), tone: 'degraded' }
    ]
  }

  return [
    {
      label: 'CPU',
      value: formatPercent(systemStatus.value.summary.cpuUsagePercent),
      detail: `${systemStatus.value.cpu.model} · ${t('settings.processManager.cpuCores', { count: systemStatus.value.cpu.cores })}`,
      tone: (systemStatus.value.summary.cpuUsagePercent ?? 0) >= 85 ? 'busy' : ''
    },
    {
      label: t('settings.processManager.systemMemory'),
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
    { label: t('settings.processManager.runningProcesses'), value: `${runningCount.value}`, detail: t('settings.processManager.runningProcessesDetail'), tone: runningCount.value > 0 ? 'ok' : '' },
    { label: t('settings.processManager.totalProcesses'), value: `${managedProcesses.value.length}`, detail: t('settings.processManager.totalProcessesDetail'), tone: '' },
    { label: t('settings.processManager.totalMemory'), value: formatBytes(totalMemory.value), detail: t('settings.processManager.totalMemoryDetail'), tone: '' },
    { label: t('settings.processManager.orphanProcesses'), value: `${orphanProcesses.value.length}`, detail: t('settings.processManager.orphanProcessesDetail'), tone: orphanProcesses.value.length > 0 ? 'degraded' : 'ok' }
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
    error.value = processResult.reason instanceof Error ? processResult.reason.message : t('settings.processManager.snapshotLoadFailed')
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
      error.value = result.error || t('settings.processManager.restartFailed')
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
      error.value = result.error || t('settings.processManager.stopFailed')
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
      error.value = result.error || t('settings.processManager.forceKillFailed')
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
      error.value = result.error || t('settings.processManager.killOrphanFailed')
    }
    await loadData()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    actionInProgress.value = null
  }
}

function formatPercent (value?: number | null): string {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : t('settings.processManager.sampling')
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
  if (seconds < 60) return t('settings.processManager.seconds', { count: Math.floor(seconds) })
  if (seconds < 3600) return t('settings.processManager.minutes', { count: Math.floor(seconds / 60) })
  if (seconds < 86400) return t('settings.processManager.hours', { count: Math.floor(seconds / 3600) })
  return t('settings.processManager.days', { count: Math.floor(seconds / 86400) })
}

function formatStatus (value: string) {
  if (value === 'running') return t('settings.processManager.statusRunning')
  if (value === 'starting') return t('settings.processManager.statusStarting')
  if (value === 'stopping') return t('settings.processManager.statusStopping')
  if (value === 'stopped' || value === 'not_started' || value === 'not_running') return t('settings.processManager.statusStopped')
  if (value === 'crashed') return t('settings.processManager.statusCrashed')
  if (value === 'error') return t('settings.processManager.statusError')
  return value
}

function statusTone (value: string): string {
  if (value === 'running') return 'tone-ok'
  if (value === 'starting' || value === 'stopping') return 'tone-busy'
  if (value === 'crashed' || value === 'error') return 'tone-error'
  return ''
}

function formatGpuStatus (value: SystemStatusSnapshot['gpu']['status']) {
  if (value === 'hardware') return t('settings.processManager.gpuHardware')
  if (value === 'software') return t('settings.processManager.gpuSoftware')
  if (value === 'disabled') return t('settings.processManager.gpuDisabled')
  return t('settings.processManager.gpuUnavailable')
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
    return t('settings.processManager.gpuNoHardwareFeatures')
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
        <h3 class="pm-title">{{ $t('settings.processManager.title') }}</h3>
        <p class="pm-desc">{{ $t('settings.processManager.description') }}</p>
      </div>
      <button class="pm-btn" :disabled="loading" @click="loadData">{{ $t('settings.processManager.refresh') }}</button>
    </div>

    <div v-if="error" class="pm-alert">
      {{ error }}
      <button class="pm-alert-close" @click="error = null">✕</button>
    </div>

    <div v-if="loading && !snapshot" class="pm-empty">{{ $t('settings.processManager.loading') }}</div>
    <div v-else-if="snapshot" class="pm-content">
      <section class="pm-section">
        <div class="pm-section-title">{{ $t('settings.processManager.hostResources') }}</div>
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
        <div class="pm-section-title">{{ $t('settings.processManager.processOverview') }}</div>
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
        <div class="pm-card-header">{{ $t('settings.processManager.appProcesses') }}</div>
        <div v-if="managedProcesses.length === 0" class="pm-empty-inline">{{ $t('settings.processManager.noAppProcesses') }}</div>
        <div v-else class="pm-table-wrap">
          <table class="pm-table">
            <thead>
              <tr>
                <th>{{ $t('settings.processManager.columnAppName') }}</th>
                <th>{{ $t('settings.processManager.columnStatus') }}</th>
                <th>PID</th>
                <th>{{ $t('settings.processManager.columnPort') }}</th>
                <th>{{ $t('settings.processManager.columnMemory') }}</th>
                <th>{{ $t('settings.processManager.columnUptime') }}</th>
                <th>{{ $t('settings.processManager.columnActions') }}</th>
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
                    :title="actionInProgress === `restart:${process.projectId}` ? $t('settings.processManager.restartBusy') : $t('settings.processManager.restart')"
                    @click="doRestart(process.projectId)"
                  >
                    {{ actionInProgress === `restart:${process.projectId}` ? '⏳' : '🔄' }}
                  </button>
                  <button
                    v-if="isAlive(process.status)"
                    class="pm-action-btn pm-action-stop"
                    :disabled="!!actionInProgress"
                    :title="actionInProgress === `stop:${process.projectId}` ? $t('settings.processManager.stopBusy') : $t('settings.processManager.stop')"
                    @click="doStop(process.projectId)"
                  >
                    {{ actionInProgress === `stop:${process.projectId}` ? '⏳' : '⏹' }}
                  </button>
                  <button
                    v-if="isAlive(process.status)"
                    class="pm-action-btn pm-action-kill"
                    :disabled="!!actionInProgress"
                    :title="actionInProgress === `kill:${process.projectId}` ? $t('settings.processManager.killBusy') : $t('settings.processManager.forceKill')"
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
          {{ $t('settings.processManager.orphanProcesses') }}
          <span class="pm-card-header-hint">{{ $t('settings.processManager.orphanProcessesHint') }}</span>
        </div>
        <div v-if="orphanProcesses.length === 0" class="pm-empty-inline">{{ $t('settings.processManager.noOrphanProcesses') }}</div>
        <div v-else class="pm-table-wrap">
          <table class="pm-table">
            <thead>
              <tr>
                <th>PID</th>
                <th>{{ $t('settings.processManager.columnProcessName') }}</th>
                <th>{{ $t('settings.processManager.columnMemory') }}</th>
                <th>{{ $t('settings.processManager.columnCommandLine') }}</th>
                <th>{{ $t('settings.processManager.columnActions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="process in orphanProcesses" :key="process.pid">
                <td class="pm-mono">{{ process.pid }}</td>
                <td>{{ process.name }}</td>
                <td class="pm-mono">{{ formatBytes(process.memoryRssBytes) }}</td>
                <td class="pm-cmd" :title="process.commandLine"><span class="pm-cmdline">{{ process.commandLine }}</span></td>
                <td class="pm-actions">
                  <button
                    class="pm-action-btn pm-action-kill"
                    :disabled="!!actionInProgress"
                    :title="actionInProgress === `orphan:${process.pid}` ? $t('settings.processManager.killBusy') : $t('settings.processManager.kill')"
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
        <span class="pm-footer-text">{{ $t('settings.processManager.processUpdated', { time: snapshot.fetchedAt }) }}</span>
        <span v-if="systemStatus" class="pm-footer-text">{{ $t('settings.processManager.resourceUpdated', { time: systemStatus.fetchedAt }) }}</span>
        <span class="pm-footer-text">{{ $t('settings.processManager.autoRefresh', { seconds: POLL_INTERVAL_MS / 1000 }) }}</span>
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

.pm-cmd {
  max-width: 260px;
}

.pm-cmdline {
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
