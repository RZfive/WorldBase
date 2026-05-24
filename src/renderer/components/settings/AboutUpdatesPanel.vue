<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'

const props = defineProps<{
  active: boolean
}>()

const aboutInfo = ref<AppAboutInfo | null>(null)
const updateState = ref<AppUpdateState | null>(null)
const updateConfig = ref<AppUpdateConfig>({
  websiteBaseUrl: '',
  updateApiUrl: '',
  downloadsPageUrl: '',
  updatesPageUrl: ''
})
const loading = ref(false)
const actionInProgress = ref<string | null>(null)
const savingConfig = ref(false)
const localError = ref<string | null>(null)
const configFeedback = ref('')

let updateStateCleanup: (() => void) | null = null

watch(() => props.active, (active) => {
  if (active) {
    void activatePanel()
  } else {
    deactivatePanel()
  }
}, { immediate: true })

onUnmounted(() => {
  deactivatePanel()
})

const statusLabel = computed(() => {
  switch (updateState.value?.status) {
    case 'checking': return '正在检查更新'
    case 'up_to_date': return '当前已是最新版本'
    case 'unsupported_platform': return '当前平台请前往官网更新'
    case 'update_available': return `发现新版本 ${updateState.value.latestVersion || ''}`.trim()
    case 'downloading': return '正在下载更新包'
    case 'downloaded': return '更新包已下载并校验通过'
    case 'installing': return '正在启动安装程序'
    case 'install_triggered': return '安装程序已启动'
    case 'failed': return '更新失败'
    default: return '尚未检查更新'
  }
})

const statusTone = computed(() => {
  switch (updateState.value?.status) {
    case 'up_to_date':
    case 'downloaded':
    case 'install_triggered':
      return 'ok'
    case 'update_available':
    case 'checking':
    case 'downloading':
    case 'installing':
      return 'busy'
    case 'failed':
      return 'danger'
    case 'unsupported_platform':
      return 'warn'
    default:
      return 'idle'
  }
})

const noteList = computed(() => {
  if (!updateState.value?.notes) return []
  return updateState.value.notes.zh.length > 0
    ? updateState.value.notes.zh
    : updateState.value.notes.en
})

const progressLabel = computed(() => {
  const progress = updateState.value?.progress
  if (!progress) return ''

  const downloaded = formatBytes(progress.bytesDownloaded)
  const total = progress.totalBytes != null ? formatBytes(progress.totalBytes) : '未知大小'
  const percent = progress.percent != null ? `${progress.percent.toFixed(1)}%` : ''

  return [percent, `${downloaded} / ${total}`].filter(Boolean).join(' · ')
})

const resolvedError = computed(() => {
  return localError.value || updateState.value?.error || ''
})

const effectiveUpdateApiUrl = computed(() => {
  return resolveConfiguredUrl(updateConfig.value.updateApiUrl) || joinConfiguredUrl(updateConfig.value.websiteBaseUrl, '/api/app-update/latest')
})

const effectiveDownloadsUrl = computed(() => {
  return resolveConfiguredUrl(updateConfig.value.downloadsPageUrl) || joinConfiguredUrl(updateConfig.value.websiteBaseUrl, '/downloads')
})

const effectiveUpdatesUrl = computed(() => {
  return resolveConfiguredUrl(updateConfig.value.updatesPageUrl) || joinConfiguredUrl(updateConfig.value.websiteBaseUrl, '/updates')
})

const canCheck = computed(() => isValidHttpUrl(effectiveUpdateApiUrl.value))
const canOpenDownloads = computed(() => isValidHttpUrl(effectiveDownloadsUrl.value))
const canOpenUpdates = computed(() => isValidHttpUrl(effectiveUpdatesUrl.value))
const canDownload = computed(() => updateState.value?.status === 'update_available')
const canInstall = computed(() => updateState.value?.status === 'downloaded')

async function activatePanel () {
  deactivatePanel()
  updateStateCleanup = window.electronAPI?.onAppUpdateStateChanged?.((state) => {
    updateState.value = state
    if (state.status !== 'failed') {
      localError.value = null
    }
  }) || null
  await loadPanelData()
}

function deactivatePanel () {
  updateStateCleanup?.()
  updateStateCleanup = null
}

async function loadPanelData () {
  if (!window.electronAPI) return
  loading.value = true
  localError.value = null

  try {
    const [info, state, config] = await Promise.all([
      window.electronAPI.getAboutInfo(),
      window.electronAPI.getAppUpdateState(),
      window.electronAPI.getAppUpdateConfig()
    ])
    aboutInfo.value = info
    updateState.value = state
    updateConfig.value = config
  } catch (error) {
    localError.value = (error as Error).message
  } finally {
    loading.value = false
  }
}

async function checkForUpdates () {
  if (!window.electronAPI || actionInProgress.value || !canCheck.value) return
  actionInProgress.value = 'check'
  localError.value = null

  try {
    updateState.value = await window.electronAPI.checkAppUpdate()
  } catch (error) {
    localError.value = (error as Error).message
  } finally {
    actionInProgress.value = null
  }
}

async function downloadUpdate () {
  if (!window.electronAPI || actionInProgress.value || !canDownload.value) return
  actionInProgress.value = 'download'
  localError.value = null

  try {
    updateState.value = await window.electronAPI.downloadAppUpdate()
  } catch (error) {
    localError.value = (error as Error).message
  } finally {
    actionInProgress.value = null
  }
}

async function installUpdate () {
  if (!window.electronAPI || actionInProgress.value || !canInstall.value) return
  actionInProgress.value = 'install'
  localError.value = null

  try {
    const result = await window.electronAPI.installAppUpdate()
    updateState.value = result.state
    if (!result.success && result.error) {
      localError.value = result.error
    }
  } catch (error) {
    localError.value = (error as Error).message
  } finally {
    actionInProgress.value = null
  }
}

async function saveUpdateConfig () {
  if (!window.electronAPI || savingConfig.value) return
  savingConfig.value = true
  localError.value = null
  configFeedback.value = ''

  try {
    const result = await window.electronAPI.saveAppUpdateConfig(updateConfig.value)
    updateConfig.value = result.config
    configFeedback.value = '官网更新配置已保存，后续启动会自动读取。'

    const [info, state] = await Promise.all([
      window.electronAPI.getAboutInfo(),
      window.electronAPI.getAppUpdateState()
    ])
    aboutInfo.value = info
    updateState.value = state
  } catch (error) {
    localError.value = (error as Error).message
  } finally {
    savingConfig.value = false
  }
}

async function openWebsite (kind: AppUpdateWebsiteKind) {
  if (!window.electronAPI || actionInProgress.value) return
  actionInProgress.value = kind
  localError.value = null

  try {
    const result = await window.electronAPI.openAppUpdateWebsite(kind)
    if (!result.success) {
      localError.value = result.error || '打开官网失败'
    }
  } catch (error) {
    localError.value = (error as Error).message
  } finally {
    actionInProgress.value = null
  }
}

function resolveConfiguredUrl (value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.replace(/\/+$/, '')
}

function joinConfiguredUrl (baseUrl: string, pathname: string): string {
  const normalizedBaseUrl = resolveConfiguredUrl(baseUrl)
  if (!normalizedBaseUrl) return ''
  return `${normalizedBaseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
}

function isValidHttpUrl (value: string): boolean {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function formatBytes (value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let amount = value
  let unitIndex = 0
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024
    unitIndex += 1
  }
  const digits = amount >= 100 || unitIndex === 0 ? 0 : 1
  return `${amount.toFixed(digits)} ${units[unitIndex]}`
}

function formatTime (value: string | null | undefined): string {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}
</script>

<template>
  <section class="au-root">
    <header class="au-hero">
      <div>
        <span class="au-kicker">About & Updates</span>
        <h2 class="au-title">关于与更新</h2>
        <p class="au-desc">显示当前应用版本，检查官网更新，并在 Windows 上完成下载、校验和启动安装。</p>
      </div>
      <button class="au-refresh" :disabled="loading || actionInProgress === 'check'" @click="checkForUpdates">
        {{ actionInProgress === 'check' ? '检查中…' : '检查更新' }}
      </button>
    </header>

    <div class="au-grid">
      <article class="au-card au-card-primary">
        <div class="au-card-head">
          <span class="au-card-kicker">Application</span>
          <strong>{{ aboutInfo?.productName || 'The World' }}</strong>
        </div>
        <dl class="au-meta-grid">
          <div>
            <dt>当前版本</dt>
            <dd>{{ aboutInfo?.version || '-' }}</dd>
          </div>
          <div>
            <dt>渠道</dt>
            <dd>{{ aboutInfo?.channel || '-' }}</dd>
          </div>
          <div>
            <dt>平台 / 架构</dt>
            <dd>{{ aboutInfo?.platform || '-' }} / {{ aboutInfo?.arch || '-' }}</dd>
          </div>
          <div>
            <dt>更新源状态</dt>
            <dd>{{ canCheck ? '已配置' : '未配置' }}</dd>
          </div>
        </dl>
      </article>

      <article class="au-card" :data-tone="statusTone">
        <div class="au-card-head">
          <span class="au-card-kicker">Update Status</span>
          <strong>{{ statusLabel }}</strong>
        </div>
        <div class="au-status-stack">
          <div class="au-status-line">
            <span>最近检查</span>
            <strong>{{ formatTime(updateState?.lastCheckedAt) }}</strong>
          </div>
          <div class="au-status-line">
            <span>最新版本</span>
            <strong>{{ updateState?.latestVersion || '未发现更新' }}</strong>
          </div>
          <div class="au-status-line">
            <span>发布时间</span>
            <strong>{{ formatTime(updateState?.publishedAt) }}</strong>
          </div>
          <div v-if="progressLabel" class="au-progress-block">
            <div class="au-progress-copy">
              <span>下载进度</span>
              <strong>{{ progressLabel }}</strong>
            </div>
            <div class="au-progress-track">
              <span class="au-progress-bar" :style="{ width: `${updateState?.progress?.percent ?? 0}%` }" />
            </div>
          </div>
        </div>
      </article>
    </div>

    <section class="au-card">
      <div class="au-card-head">
        <span class="au-card-kicker">Source Config</span>
        <strong>更新源配置</strong>
      </div>
      <div class="au-config-grid">
        <label class="au-field">
          <span>官网根地址</span>
          <input v-model="updateConfig.websiteBaseUrl" class="au-input" type="text" placeholder="https://worldbase.example.com">
        </label>
        <label class="au-field">
          <span>更新检查接口</span>
          <input v-model="updateConfig.updateApiUrl" class="au-input" type="text" placeholder="可选，留空时自动拼接 /api/app-update/latest">
        </label>
        <label class="au-field">
          <span>官网下载页</span>
          <input v-model="updateConfig.downloadsPageUrl" class="au-input" type="text" placeholder="可选，留空时自动拼接 /downloads">
        </label>
        <label class="au-field">
          <span>官网更新页</span>
          <input v-model="updateConfig.updatesPageUrl" class="au-input" type="text" placeholder="可选，留空时自动拼接 /updates">
        </label>
      </div>
      <div class="au-config-preview">
        <div class="au-status-line">
          <span>实际检查接口</span>
          <strong>{{ effectiveUpdateApiUrl || '未配置' }}</strong>
        </div>
        <div class="au-status-line">
          <span>实际下载页</span>
          <strong>{{ effectiveDownloadsUrl || '未配置' }}</strong>
        </div>
        <div class="au-status-line">
          <span>实际更新页</span>
          <strong>{{ effectiveUpdatesUrl || '未配置' }}</strong>
        </div>
      </div>
      <div class="au-config-actions">
        <button class="au-action primary" :disabled="savingConfig" @click="saveUpdateConfig">
          {{ savingConfig ? '保存中…' : '保存配置' }}
        </button>
      </div>
      <p v-if="configFeedback" class="au-success">{{ configFeedback }}</p>
      <p v-else class="au-hint">这些地址会持久化到本地设置，后续启动自动读取，不再依赖环境变量。检查接口可单独配置，也可以只填官网根地址后自动拼接。</p>
    </section>

    <section class="au-card au-actions">
      <div class="au-card-head">
        <span class="au-card-kicker">Actions</span>
        <strong>更新操作</strong>
      </div>
      <div class="au-actions-grid">
        <button class="au-action primary" :disabled="actionInProgress !== null || !canCheck" @click="checkForUpdates">
          {{ actionInProgress === 'check' ? '检查中…' : '检查更新' }}
        </button>
        <button class="au-action" :disabled="actionInProgress !== null || !canDownload" @click="downloadUpdate">
          {{ actionInProgress === 'download' ? '下载中…' : '下载更新' }}
        </button>
        <button class="au-action" :disabled="actionInProgress !== null || !canInstall" @click="installUpdate">
          {{ actionInProgress === 'install' ? '启动中…' : '启动安装' }}
        </button>
        <button class="au-action ghost" :disabled="actionInProgress !== null || !canOpenUpdates" @click="openWebsite('updates')">
          打开官网更新页
        </button>
        <button class="au-action ghost" :disabled="actionInProgress !== null || !canOpenDownloads" @click="openWebsite('downloads')">
          打开官网下载页
        </button>
      </div>
      <p v-if="resolvedError" class="au-error">{{ resolvedError }}</p>
      <p v-else-if="!canCheck" class="au-hint">请先保存更新检查地址，然后再使用官网更新能力。</p>
    </section>

    <section class="au-card">
      <div class="au-card-head">
        <span class="au-card-kicker">Release Notes</span>
        <strong>版本说明</strong>
      </div>
      <ul v-if="noteList.length > 0" class="au-notes">
        <li v-for="note in noteList" :key="note">{{ note }}</li>
      </ul>
      <p v-else class="au-hint">检查到新版本后，这里会显示官网返回的更新说明。</p>
    </section>
  </section>
</template>

<style scoped>
.au-root {
  display: flex;
  flex-direction: column;
  gap: 18px;
  height: 100%;
  padding: 22px 24px;
  overflow: auto;
  color: var(--app-text);
  background:
    radial-gradient(circle at top left, rgba(94, 123, 255, 0.12), transparent 26%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 32%);
}

.au-hero,
.au-card-head,
.au-status-line,
.au-progress-copy {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.au-kicker,
.au-card-kicker {
  display: inline-flex;
  font-size: 0.72em;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--app-text-faint);
}

.au-title {
  margin: 4px 0 8px;
  font-size: 1.4em;
  color: var(--app-text-strong);
}

.au-desc,
.au-hint,
.au-notes,
.au-error,
.au-success,
.au-status-line span,
.au-progress-copy span,
.au-meta-grid dt {
  margin: 0;
  color: var(--app-text-muted);
  line-height: 1.6;
}

.au-refresh,
.au-action {
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-panel-subtle);
  color: var(--app-text);
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, transform 0.14s ease;
}

.au-refresh {
  padding: 10px 14px;
  font-size: 0.88em;
}

.au-refresh:hover,
.au-action:hover {
  background: rgba(94, 123, 255, 0.12);
  border-color: rgba(94, 123, 255, 0.28);
  transform: translateY(-1px);
}

.au-refresh:disabled,
.au-action:disabled {
  opacity: 0.58;
  cursor: not-allowed;
  transform: none;
}

.au-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.au-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px 20px;
  border: 1px solid var(--app-border);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.03);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.12);
}

.au-card-primary {
  background: linear-gradient(180deg, rgba(94, 123, 255, 0.16), rgba(94, 123, 255, 0.05));
}

.au-card[data-tone='ok'] {
  border-color: rgba(75, 191, 126, 0.28);
}

.au-card[data-tone='busy'] {
  border-color: rgba(94, 123, 255, 0.28);
}

.au-card[data-tone='warn'] {
  border-color: rgba(255, 178, 92, 0.28);
}

.au-card[data-tone='danger'] {
  border-color: rgba(255, 107, 107, 0.28);
}

.au-card-head strong,
.au-status-line strong,
.au-progress-copy strong,
.au-meta-grid dd {
  color: var(--app-text);
}

.au-meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 18px;
  margin: 0;
}

.au-meta-grid div {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.au-meta-grid dd {
  margin: 0;
  font-weight: 600;
}

.au-status-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.au-config-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.au-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.au-field span {
  color: var(--app-text-soft);
  font-size: 0.84em;
}

.au-input {
  min-height: 42px;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  color: var(--app-text);
}

.au-input:focus {
  outline: none;
  border-color: rgba(94, 123, 255, 0.48);
  box-shadow: 0 0 0 3px rgba(94, 123, 255, 0.16);
}

.au-config-preview,
.au-config-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.au-config-preview .au-status-line strong {
  max-width: 72%;
  text-align: right;
  overflow-wrap: anywhere;
}

.au-progress-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.au-progress-track {
  width: 100%;
  height: 9px;
  border-radius: 999px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.08);
}

.au-progress-bar {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, rgba(94, 123, 255, 0.86), rgba(88, 205, 255, 0.88));
}

.au-actions-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.au-action {
  min-height: 44px;
  padding: 0 14px;
  font-size: 0.88em;
}

.au-action.primary {
  background: rgba(94, 123, 255, 0.18);
  border-color: rgba(94, 123, 255, 0.34);
}

.au-action.ghost {
  background: transparent;
}

.au-error {
  color: #ff8d8d;
}

.au-success {
  color: #95e3af;
}

.au-notes {
  padding-left: 18px;
}

.au-notes li {
  color: var(--app-text-soft);
  line-height: 1.7;
}

@media (max-width: 980px) {
  .au-grid,
  .au-config-grid,
  .au-actions-grid,
  .au-meta-grid {
    grid-template-columns: 1fr;
  }

  .au-hero {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>