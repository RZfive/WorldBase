<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  active: boolean
}>()

const { t } = useI18n()

const status = ref<SystemStatusSnapshot | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

let pollTimer: ReturnType<typeof setInterval> | null = null

const summaryCards = computed(() => {
  if (!status.value) return []
  return [
    { label: t('settings.systemStatus.summaryStatus'), value: formatStatus(status.value.summary.status), tone: status.value.summary.status },
    { label: 'CPU', value: formatPercent(status.value.summary.cpuUsagePercent) },
    { label: t('settings.systemStatus.summaryMemory'), value: formatPercent(status.value.summary.memoryUsagePercent) },
    { label: t('settings.systemStatus.summaryRunningServices'), value: `${status.value.services.totalRunning}/${status.value.services.services.length}` }
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
  await loadSystemStatus()
  pollTimer = setInterval(() => {
    void loadSystemStatus()
  }, status.value?.refreshIntervalMs || 5000)
}

function stopPolling () {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function loadSystemStatus () {
  if (!window.electronAPI?.getSystemStatus) return
  loading.value = true
  error.value = null
  try {
    status.value = await window.electronAPI.getSystemStatus()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    loading.value = false
  }
}

function formatPercent (value?: number | null) {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : t('settings.systemStatus.sampling')
}

function formatBytes (value: number) {
  if (!Number.isFinite(value)) return '-'
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
  if (seconds < 60) return t('settings.systemStatus.seconds', { count: Math.floor(seconds) })
  if (seconds < 3600) return t('settings.systemStatus.minutes', { count: Math.floor(seconds / 60) })
  if (seconds < 86400) return t('settings.systemStatus.hours', { count: Math.floor(seconds / 3600) })
  return t('settings.systemStatus.days', { count: Math.floor(seconds / 86400) })
}

function formatStatus (value: string) {
  if (value === 'ok') return t('settings.systemStatus.statusOk')
  if (value === 'busy') return t('settings.systemStatus.statusBusy')
  if (value === 'degraded') return t('settings.systemStatus.statusDegraded')
  if (value === 'running') return t('settings.systemStatus.statusRunning')
  if (value === 'starting') return t('settings.systemStatus.statusStarting')
  if (value === 'stopped' || value === 'not_started' || value === 'not_running') return t('settings.systemStatus.statusStopped')
  if (value === 'crashed') return t('settings.systemStatus.statusCrashed')
  if (value === 'error') return t('settings.systemStatus.statusError')
  return value
}
</script>

<template>
  <div class="sys-root">
    <div class="sys-header">
      <div>
        <h3 class="sys-title">{{ $t('settings.systemStatus.title') }}</h3>
        <p class="sys-desc">{{ $t('settings.systemStatus.description') }}</p>
      </div>
      <button class="sys-btn" :disabled="loading" @click="loadSystemStatus">{{ $t('settings.systemStatus.refresh') }}</button>
    </div>

    <div v-if="error" class="sys-empty sys-error">{{ error }}</div>
    <div v-else-if="loading && !status" class="sys-empty">{{ $t('settings.systemStatus.loading') }}</div>
    <div v-else-if="status" class="sys-content">
      <div class="sys-summary-grid">
        <div
          v-for="card in summaryCards"
          :key="card.label"
          :class="['sys-card', 'summary-card', card.tone ? `tone-${card.tone}` : '']"
        >
          <div class="sys-card-label">{{ card.label }}</div>
          <div class="sys-card-value">{{ card.value }}</div>
        </div>
      </div>

      <div class="sys-grid">
        <section class="sys-card">
          <div class="sys-card-header">{{ $t('settings.systemStatus.hostOverview') }}</div>
          <dl class="sys-kv">
            <div><dt>{{ $t('settings.systemStatus.platform') }}</dt><dd>{{ status.host.platform }} {{ status.host.release }}</dd></div>
            <div><dt>{{ $t('settings.systemStatus.architecture') }}</dt><dd>{{ status.host.arch }}</dd></div>
            <div><dt>Node / Electron</dt><dd>{{ status.host.nodeVersion }} / {{ status.host.electronVersion || '-' }}</dd></div>
            <div><dt>{{ $t('settings.systemStatus.hostUptime') }}</dt><dd>{{ formatDuration(status.host.uptimeSeconds) }}</dd></div>
            <div><dt>{{ $t('settings.systemStatus.latestSample') }}</dt><dd>{{ status.fetchedAt }}</dd></div>
            <div><dt>{{ $t('settings.systemStatus.cacheAge') }}</dt><dd>{{ Math.round(status.cacheAgeMs) }} ms</dd></div>
          </dl>
        </section>

        <section class="sys-card">
          <div class="sys-card-header">{{ $t('settings.systemStatus.cpuMemory') }}</div>
          <dl class="sys-kv">
            <div><dt>{{ $t('settings.systemStatus.cpuModel') }}</dt><dd>{{ status.cpu.model }}</dd></div>
            <div><dt>{{ $t('settings.systemStatus.cpuCores') }}</dt><dd>{{ status.cpu.cores }}</dd></div>
            <div><dt>{{ $t('settings.systemStatus.cpuUsage') }}</dt><dd>{{ formatPercent(status.cpu.usagePercent) }}</dd></div>
            <div><dt>{{ $t('settings.systemStatus.sampleWindow') }}</dt><dd>{{ status.cpu.sampleWindowMs ? `${status.cpu.sampleWindowMs} ms` : $t('settings.systemStatus.firstSample') }}</dd></div>
            <div><dt>Load Average</dt><dd>{{ status.cpu.loadAverage.join(' / ') }}</dd></div>
            <div><dt>{{ $t('settings.systemStatus.systemMemory') }}</dt><dd>{{ formatBytes(status.memory.usedBytes) }} / {{ formatBytes(status.memory.totalBytes) }}</dd></div>
            <div><dt>{{ $t('settings.systemStatus.hostRss') }}</dt><dd>{{ formatBytes(status.memory.processRssBytes) }}</dd></div>
            <div><dt>{{ $t('settings.systemStatus.hostHeap') }}</dt><dd>{{ formatBytes(status.memory.processHeapUsedBytes) }} / {{ formatBytes(status.memory.processHeapTotalBytes) }}</dd></div>
          </dl>
        </section>

        <section class="sys-card">
          <div class="sys-card-header">{{ $t('settings.systemStatus.currentHostProcess') }}</div>
          <dl class="sys-kv">
            <div><dt>PID</dt><dd>{{ status.currentProcess.pid }}</dd></div>
            <div><dt>{{ $t('settings.systemStatus.uptime') }}</dt><dd>{{ formatDuration(status.currentProcess.uptimeSeconds) }}</dd></div>
            <div><dt>{{ $t('settings.systemStatus.platform') }}</dt><dd>{{ status.currentProcess.platform }} / {{ status.currentProcess.arch }}</dd></div>
            <div><dt>RSS</dt><dd>{{ formatBytes(status.currentProcess.memory.rssBytes) }}</dd></div>
            <div><dt>Heap Used</dt><dd>{{ formatBytes(status.currentProcess.memory.heapUsedBytes) }}</dd></div>
            <div><dt>External</dt><dd>{{ formatBytes(status.currentProcess.memory.externalBytes) }}</dd></div>
          </dl>
        </section>

        <section class="sys-card">
          <div class="sys-card-header">{{ $t('settings.systemStatus.serviceSummary') }}</div>
          <dl class="sys-kv">
            <div><dt>{{ $t('settings.systemStatus.totalProjectServices') }}</dt><dd>{{ status.summary.totalServiceCount }}</dd></div>
            <div><dt>{{ $t('settings.systemStatus.running') }}</dt><dd>{{ status.services.totalRunning }}</dd></div>
            <div><dt>{{ $t('settings.systemStatus.stopped') }}</dt><dd>{{ status.services.totalStopped }}</dd></div>
            <div><dt>{{ $t('settings.systemStatus.crashed') }}</dt><dd>{{ status.services.totalCrashed }}</dd></div>
            <div><dt>{{ $t('settings.systemStatus.trackedProjectProcesses') }}</dt><dd>{{ status.summary.trackedProjectProcessCount }}</dd></div>
          </dl>
        </section>
      </div>

      <section class="sys-card">
        <div class="sys-card-header">{{ $t('settings.systemStatus.projectProcesses') }}</div>
        <div v-if="status.projectProcesses.length === 0" class="sys-empty-inline">{{ $t('settings.systemStatus.noProjectProcesses') }}</div>
        <div v-else class="sys-table-wrap">
          <table class="sys-table">
            <thead>
              <tr>
                <th>{{ $t('settings.systemStatus.project') }}</th>
                <th>{{ $t('settings.systemStatus.status') }}</th>
                <th>PID</th>
                <th>{{ $t('settings.systemStatus.port') }}</th>
                <th>{{ $t('settings.systemStatus.uptime') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(processItem, index) in status.projectProcesses" :key="`${processItem.projectId}:${processItem.pid || processItem.startedAt || index}`">
                <td>{{ processItem.projectId }}</td>
                <td>{{ formatStatus(processItem.status) }}</td>
                <td>{{ processItem.pid || '-' }}</td>
                <td>{{ processItem.port || '-' }}</td>
                <td>{{ formatDuration(processItem.uptimeSeconds) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="sys-card">
        <div class="sys-card-header">{{ $t('settings.systemStatus.serviceList') }}</div>
        <div class="sys-table-wrap">
          <table class="sys-table">
            <thead>
              <tr>
                <th>{{ $t('settings.systemStatus.name') }}</th>
                <th>{{ $t('settings.systemStatus.status') }}</th>
                <th>PID</th>
                <th>{{ $t('settings.systemStatus.port') }}</th>
                <th>{{ $t('settings.systemStatus.restartPolicy') }}</th>
                <th>{{ $t('settings.systemStatus.restartCount') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(service, index) in status.services.services" :key="`${service.projectId}:${service.name}:${index}`">
                <td>{{ service.name }}</td>
                <td>{{ formatStatus(service.status) }}</td>
                <td>{{ service.pid || '-' }}</td>
                <td>{{ service.port || '-' }}</td>
                <td>{{ service.restartPolicy }}</td>
                <td>{{ service.restartCount }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.sys-root {
  height: 100%;
  padding: 24px;
  overflow: auto;
}

.sys-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 20px;
}

.sys-title {
  margin: 0;
  font-size: 1.1rem;
}

.sys-desc {
  margin: 6px 0 0;
  color: var(--app-text-soft);
  font-size: 0.9rem;
}

.sys-btn {
  border: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
  color: var(--app-text);
  border-radius: 10px;
  padding: 8px 14px;
  cursor: pointer;
}

.sys-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.sys-summary-grid,
.sys-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}

.sys-card {
  border: 1px solid var(--app-border);
  background: var(--app-panel);
  border-radius: 14px;
  padding: 16px;
}

.summary-card.tone-ok {
  border-color: rgba(52, 199, 89, 0.35);
}

.summary-card.tone-busy {
  border-color: rgba(255, 159, 10, 0.35);
}

.summary-card.tone-degraded {
  border-color: rgba(255, 69, 58, 0.35);
}

.sys-card-header,
.sys-card-label {
  color: var(--app-text-soft);
  font-size: 0.82rem;
  margin-bottom: 8px;
}

.sys-card-value {
  font-size: 1.2rem;
  font-weight: 700;
}

.sys-kv {
  display: grid;
  gap: 10px;
  margin: 0;
}

.sys-kv div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.sys-kv dt {
  color: var(--app-text-soft);
}

.sys-kv dd {
  margin: 0;
  text-align: right;
  word-break: break-word;
}

.sys-table-wrap {
  overflow: auto;
}

.sys-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.sys-table th,
.sys-table td {
  padding: 10px 8px;
  border-bottom: 1px solid var(--app-border);
  text-align: left;
}

.sys-table th {
  color: var(--app-text-soft);
  font-weight: 600;
}

.sys-empty,
.sys-empty-inline {
  padding: 28px;
  border: 1px dashed var(--app-border);
  border-radius: 14px;
  text-align: center;
  color: var(--app-text-soft);
}

.sys-error {
  color: #ff453a;
}
</style>
