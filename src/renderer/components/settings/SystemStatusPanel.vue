<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'

const props = defineProps<{
  active: boolean
}>()

const status = ref<SystemStatusSnapshot | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

let pollTimer: ReturnType<typeof setInterval> | null = null

const summaryCards = computed(() => {
  if (!status.value) return []
  return [
    { label: '系统状态', value: formatStatus(status.value.summary.status), tone: status.value.summary.status },
    { label: 'CPU', value: formatPercent(status.value.summary.cpuUsagePercent) },
    { label: '内存', value: formatPercent(status.value.summary.memoryUsagePercent) },
    { label: '运行中服务', value: `${status.value.services.totalRunning}/${status.value.services.services.length}` }
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
  return typeof value === 'number' ? `${value.toFixed(1)}%` : '采样中'
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
  if (seconds < 60) return `${Math.floor(seconds)} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`
  return `${Math.floor(seconds / 86400)} 天`
}

function formatStatus (value: string) {
  if (value === 'ok') return '正常'
  if (value === 'busy') return '负载较高'
  if (value === 'degraded') return '存在异常'
  if (value === 'running') return '运行中'
  if (value === 'starting') return '启动中'
  if (value === 'stopped' || value === 'not_started' || value === 'not_running') return '已停止'
  if (value === 'crashed') return '已崩溃'
  if (value === 'error') return '错误'
  return value
}
</script>

<template>
  <div class="sys-root">
    <div class="sys-header">
      <div>
        <h3 class="sys-title">系统状态</h3>
        <p class="sys-desc">查看基座当前状态、CPU / 内存、宿主进程与项目服务信息</p>
      </div>
      <button class="sys-btn" :disabled="loading" @click="loadSystemStatus">刷新</button>
    </div>

    <div v-if="error" class="sys-empty sys-error">{{ error }}</div>
    <div v-else-if="loading && !status" class="sys-empty">加载中…</div>
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
          <div class="sys-card-header">宿主概览</div>
          <dl class="sys-kv">
            <div><dt>平台</dt><dd>{{ status.host.platform }} {{ status.host.release }}</dd></div>
            <div><dt>架构</dt><dd>{{ status.host.arch }}</dd></div>
            <div><dt>Node / Electron</dt><dd>{{ status.host.nodeVersion }} / {{ status.host.electronVersion || '-' }}</dd></div>
            <div><dt>宿主运行时长</dt><dd>{{ formatDuration(status.host.uptimeSeconds) }}</dd></div>
            <div><dt>最近采集</dt><dd>{{ status.fetchedAt }}</dd></div>
            <div><dt>缓存年龄</dt><dd>{{ Math.round(status.cacheAgeMs) }} ms</dd></div>
          </dl>
        </section>

        <section class="sys-card">
          <div class="sys-card-header">CPU 与内存</div>
          <dl class="sys-kv">
            <div><dt>CPU 型号</dt><dd>{{ status.cpu.model }}</dd></div>
            <div><dt>核心数</dt><dd>{{ status.cpu.cores }}</dd></div>
            <div><dt>CPU 使用率</dt><dd>{{ formatPercent(status.cpu.usagePercent) }}</dd></div>
            <div><dt>采样窗口</dt><dd>{{ status.cpu.sampleWindowMs ? `${status.cpu.sampleWindowMs} ms` : '首次采样' }}</dd></div>
            <div><dt>Load Average</dt><dd>{{ status.cpu.loadAverage.join(' / ') }}</dd></div>
            <div><dt>系统内存</dt><dd>{{ formatBytes(status.memory.usedBytes) }} / {{ formatBytes(status.memory.totalBytes) }}</dd></div>
            <div><dt>宿主 RSS</dt><dd>{{ formatBytes(status.memory.processRssBytes) }}</dd></div>
            <div><dt>宿主 Heap</dt><dd>{{ formatBytes(status.memory.processHeapUsedBytes) }} / {{ formatBytes(status.memory.processHeapTotalBytes) }}</dd></div>
          </dl>
        </section>

        <section class="sys-card">
          <div class="sys-card-header">当前宿主进程</div>
          <dl class="sys-kv">
            <div><dt>PID</dt><dd>{{ status.currentProcess.pid }}</dd></div>
            <div><dt>运行时长</dt><dd>{{ formatDuration(status.currentProcess.uptimeSeconds) }}</dd></div>
            <div><dt>平台</dt><dd>{{ status.currentProcess.platform }} / {{ status.currentProcess.arch }}</dd></div>
            <div><dt>RSS</dt><dd>{{ formatBytes(status.currentProcess.memory.rssBytes) }}</dd></div>
            <div><dt>Heap Used</dt><dd>{{ formatBytes(status.currentProcess.memory.heapUsedBytes) }}</dd></div>
            <div><dt>External</dt><dd>{{ formatBytes(status.currentProcess.memory.externalBytes) }}</dd></div>
          </dl>
        </section>

        <section class="sys-card">
          <div class="sys-card-header">服务摘要</div>
          <dl class="sys-kv">
            <div><dt>项目服务总数</dt><dd>{{ status.summary.totalServiceCount }}</dd></div>
            <div><dt>运行中</dt><dd>{{ status.services.totalRunning }}</dd></div>
            <div><dt>已停止</dt><dd>{{ status.services.totalStopped }}</dd></div>
            <div><dt>异常</dt><dd>{{ status.services.totalCrashed }}</dd></div>
            <div><dt>项目进程跟踪数</dt><dd>{{ status.summary.trackedProjectProcessCount }}</dd></div>
          </dl>
        </section>
      </div>

      <section class="sys-card">
        <div class="sys-card-header">项目进程</div>
        <div v-if="status.projectProcesses.length === 0" class="sys-empty-inline">暂无项目进程</div>
        <div v-else class="sys-table-wrap">
          <table class="sys-table">
            <thead>
              <tr>
                <th>项目</th>
                <th>状态</th>
                <th>PID</th>
                <th>端口</th>
                <th>运行时长</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="processItem in status.projectProcesses" :key="`${processItem.projectId}:${processItem.pid || processItem.startedAt || 'unknown'}`">
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
        <div class="sys-card-header">服务列表</div>
        <div class="sys-table-wrap">
          <table class="sys-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>状态</th>
                <th>PID</th>
                <th>端口</th>
                <th>重启策略</th>
                <th>重启次数</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="service in status.services.services" :key="`${service.projectId}:${service.name}`">
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
