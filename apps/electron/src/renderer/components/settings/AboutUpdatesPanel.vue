<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  active: boolean
}>()

const { locale, t } = useI18n()

const OPEN_SOURCE_REPO_URL = 'https://github.com/RZfive/WorldBase'

const aboutInfo = ref<AppAboutInfo | null>(null)
const updateState = ref<AppUpdateState | null>(null)
const loading = ref(false)
const checking = ref(false)
const actionBusy = ref(false)
const localError = ref<string | null>(null)

let updateStateCleanup: (() => void) | null = null
let updateStateRevision = 0

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
    case 'checking': return t('settings.about.statusChecking')
    case 'up_to_date': return t('settings.about.statusUpToDate')
    case 'unsupported_platform': return t('settings.about.statusUnsupported')
    case 'update_available': return t('settings.about.statusUpdateAvailable', { version: updateState.value.latestVersion || '' }).trim()
    case 'downloading': return t('settings.about.statusDownloading')
    case 'downloaded': return t('settings.about.statusDownloaded')
    case 'applying': return t('settings.about.statusApplying')
    case 'applied': return t('settings.about.statusApplied')
    case 'installing': return t('settings.about.statusInstalling')
    case 'install_triggered': return t('settings.about.statusInstallTriggered')
    case 'failed': return t('settings.about.statusFailed')
    default: return ''
  }
})

const statusTone = computed(() => {
  switch (updateState.value?.status) {
    case 'up_to_date': return 'ok'
    case 'update_available': return 'busy'
    case 'checking': return 'busy'
    case 'downloading': return 'busy'
    case 'downloaded': return 'ok'
    case 'applying': return 'busy'
    case 'applied': return 'ok'
    case 'installing': return 'busy'
    case 'install_triggered': return 'ok'
    case 'failed': return 'danger'
    default: return 'idle'
  }
})

const resolvedError = computed(() => localError.value || updateState.value?.error || '')
const isChecking = computed(() => checking.value || updateState.value?.status === 'checking')
const isUpdating = computed(() => actionBusy.value || updateState.value?.status === 'downloading' || updateState.value?.status === 'installing' || updateState.value?.status === 'applying')
const supportsInAppInstall = computed(() => {
  const platform = (aboutInfo.value?.platform || updateState.value?.platform || '').toLowerCase()
  return ['win32', 'windows', 'win', 'darwin', 'macos', 'mac os', 'mac', 'osx', 'linux'].includes(platform)
})
const canStartDownload = computed(() => updateState.value?.status === 'update_available' && Boolean(updateState.value.asset))
const canInstall = computed(() =>
  updateState.value?.status === 'downloaded' ||
  updateState.value?.status === 'install_triggered' ||
  updateState.value?.status === 'applied'
)
// 热更新包已应用：安装动作变成"立即重启"
const isHotApplied = computed(() =>
  updateState.value?.status === 'applied' && updateState.value?.asset?.kind === 'hot_payload'
)
const progressLabel = computed(() => {
  const progress = updateState.value?.progress
  if (!progress) return ''
  const downloaded = formatBytes(progress.bytesDownloaded)
  const total = progress.totalBytes != null ? formatBytes(progress.totalBytes) : ''
  const percent = progress.percent != null ? `${progress.percent.toFixed(progress.percent % 1 === 0 ? 0 : 1)}%` : ''

  if (total && percent) return `${percent} · ${downloaded} / ${total}`
  if (total) return `${downloaded} / ${total}`
  return downloaded
})
const progressBarWidth = computed(() => {
  const percent = updateState.value?.progress?.percent
  if (percent == null) return '0%'
  return `${Math.max(0, Math.min(100, percent))}%`
})

const releaseNotes = computed(() => {
  const notes = updateState.value?.notes
  if (!notes) return []

  const primaryLanguage = locale.value.startsWith('zh') ? 'zh' : 'en'
  const fallbackLanguage = primaryLanguage === 'zh' ? 'en' : 'zh'
  return notes[primaryLanguage].length > 0 ? notes[primaryLanguage] : notes[fallbackLanguage]
})

const notesMeta = computed(() => {
  const version = updateState.value?.latestVersion ? `v${updateState.value.latestVersion}` : ''
  return [version, publishedAtLabel.value].filter(Boolean).join(' · ')
})

const publishedAtLabel = computed(() => {
  const publishedAt = updateState.value?.publishedAt
  if (!publishedAt) return ''

  const date = new Date(publishedAt)
  if (Number.isNaN(date.getTime())) return publishedAt

  return new Intl.DateTimeFormat(locale.value, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(date)
})

async function activatePanel () {
  deactivatePanel()
  updateStateCleanup = window.electronAPI?.onAppUpdateStateChanged?.((state) => {
    updateStateRevision += 1
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
  const revisionAtStart = updateStateRevision

  try {
    const [info, state] = await Promise.all([
      window.electronAPI.getAboutInfo(),
      window.electronAPI.getAppUpdateState()
    ])
    aboutInfo.value = info
    if (updateStateRevision === revisionAtStart) {
      updateState.value = state
      // 后端还没返回更新内容时静默补一次检查，取到当前版本的更新摘要
      if (!state.notes) void refreshUpdateState(revisionAtStart)
    }
  } catch (error) {
    localError.value = (error as Error).message
  } finally {
    loading.value = false
  }
}

async function checkForUpdates () {
  if (!window.electronAPI || isChecking.value) return
  checking.value = true
  localError.value = null

  try {
    updateState.value = await window.electronAPI.checkAppUpdate()
  } catch (error) {
    localError.value = (error as Error).message
  } finally {
    checking.value = false
  }
}

function formatBytes (bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

async function downloadAndInstallUpdate () {
  if (!window.electronAPI || isUpdating.value) return
  actionBusy.value = true
  localError.value = null

  try {
    const downloadedState = await window.electronAPI.downloadAppUpdate()
    updateState.value = downloadedState
    // 热更新包下载后自动应用（applied），安装动作变成"立即重启"按钮
    if (downloadedState.status === 'downloaded') {
      const result = await window.electronAPI.installAppUpdate()
      updateState.value = result.state
      if (!result.success) {
        localError.value = result.error || result.state.error
      }
    }
  } catch (error) {
    localError.value = (error as Error).message
  } finally {
    actionBusy.value = false
  }
}

async function installUpdate () {
  if (!window.electronAPI || isUpdating.value) return
  actionBusy.value = true
  localError.value = null

  try {
    const result = await window.electronAPI.installAppUpdate()
    updateState.value = result.state
    if (!result.success) {
      localError.value = result.error || result.state.error
    }
  } catch (error) {
    localError.value = (error as Error).message
  } finally {
    actionBusy.value = false
  }
}

async function openDownloadsPage () {
  if (!window.electronAPI) return
  localError.value = null
  const result = await window.electronAPI.openAppUpdateWebsite('downloads')
  if (!result.success) {
    localError.value = result.error || t('settings.about.openDownloadsFailed')
  }
}

async function openRepoPage () {
  if (!window.electronAPI?.openExternalUrl) return
  localError.value = null
  const result = await window.electronAPI.openExternalUrl(OPEN_SOURCE_REPO_URL)
  if (!result.ok) {
    localError.value = t('settings.about.openRepoFailed')
  }
}

async function refreshUpdateState (revision: number) {
  if (!window.electronAPI) return
  try {
    const state = await window.electronAPI.checkAppUpdate()
    if (updateStateRevision === revision) {
      updateState.value = state
    }
  } catch {
    /* 静默失败：保留现有状态 */
  }
}
</script>

<template>
  <section class="au-root">
    <section class="au-opensource">
      <span class="au-opensource-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>
      </span>
      <div class="au-opensource-copy">
        <strong>{{ $t('settings.about.openSourceTitle') }}</strong>
        <p>{{ $t('settings.about.openSourceDesc') }}</p>
        <a
          class="au-repo"
          :href="OPEN_SOURCE_REPO_URL"
          :title="OPEN_SOURCE_REPO_URL"
          @click.prevent="openRepoPage"
        >
          <span>{{ OPEN_SOURCE_REPO_URL }}</span>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7" /><path d="M8 7h9v9" /></svg>
        </a>
      </div>
    </section>

    <div class="au-hero">
      <div class="au-product">
        <span class="au-mark">🌍</span>
        <div class="au-product-copy">
          <strong class="au-name">{{ aboutInfo?.productName || 'WorldBase' }}</strong>
          <span class="au-version">{{ $t('settings.about.version', { version: aboutInfo?.version || '—' }) }}</span>
        </div>
      </div>
      <button
        class="au-check"
        :disabled="loading || isChecking"
        @click="checkForUpdates"
      >
        {{ isChecking ? $t('settings.about.checking') : $t('settings.about.check') }}
      </button>
    </div>

    <p v-if="statusLabel" class="au-status" :data-tone="statusTone">{{ statusLabel }}</p>
    <p v-if="resolvedError" class="au-error">{{ resolvedError }}</p>

    <section v-if="updateState?.status === 'downloading' || progressLabel" class="au-progress" aria-live="polite">
      <div class="au-progress-bar" role="progressbar" :aria-valuenow="updateState?.progress?.percent ?? undefined" aria-valuemin="0" aria-valuemax="100">
        <span :style="{ width: progressBarWidth }" />
      </div>
      <span>{{ progressLabel || $t('settings.about.downloadPreparing') }}</span>
    </section>

    <div v-if="canStartDownload || canInstall || updateState?.status === 'unsupported_platform'" class="au-actions">
      <button
        v-if="canStartDownload && supportsInAppInstall"
        class="au-primary"
        type="button"
        :disabled="isUpdating"
        @click="downloadAndInstallUpdate"
      >
        {{ isUpdating ? $t('settings.about.updating') : $t('settings.about.downloadAndInstall') }}
      </button>
      <button
        v-else-if="canInstall && supportsInAppInstall && isHotApplied"
        class="au-primary"
        type="button"
        :disabled="isUpdating"
        @click="installUpdate"
      >
        {{ isUpdating ? $t('settings.about.installing') : $t('settings.about.restartNow') }}
      </button>
      <button
        v-else-if="canInstall && supportsInAppInstall"
        class="au-primary"
        type="button"
        :disabled="isUpdating"
        @click="installUpdate"
      >
        {{ isUpdating ? $t('settings.about.installing') : $t('settings.about.installAndRestart') }}
      </button>
      <button
        v-else
        class="au-secondary"
        type="button"
        @click="openDownloadsPage"
      >
        {{ $t('settings.about.openDownloads') }}
      </button>
    </div>

    <section v-if="releaseNotes.length > 0" class="au-release">
      <div class="au-release-head">
        <strong>{{ $t('settings.about.releaseNotes') }}</strong>
        <span v-if="notesMeta">{{ notesMeta }}</span>
      </div>
      <ul class="au-release-list">
        <li v-for="note in releaseNotes" :key="note">{{ note }}</li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.au-root {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  padding: 22px 24px;
  overflow: auto;
  color: var(--app-text);
}

.au-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 22px;
  border: 1px solid var(--app-border);
  border-radius: 18px;
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  box-shadow: var(--app-shadow);
}

.au-product {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.au-mark {
  font-size: 1.6em;
  line-height: 1;
}

.au-product-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.au-name {
  font-size: 1.1em;
  color: var(--app-text-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.au-version {
  color: var(--app-text-muted);
  font-size: 0.86em;
}

.au-opensource {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 16px 18px;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-panel);
}

.au-opensource-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: var(--app-accent-soft);
  color: var(--app-text-strong);
}

.au-opensource-copy {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.au-opensource-copy strong {
  color: var(--app-text-strong);
  font-size: 0.96em;
}

.au-opensource-copy p {
  margin: 0;
  color: var(--app-text-muted);
  font-size: 0.86em;
  line-height: 1.55;
}

.au-repo {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  color: var(--app-accent-strong);
  font-size: 0.84em;
  text-decoration: none;
}

.au-repo span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.au-repo:hover {
  text-decoration: underline;
}

.au-check {
  flex: 0 0 auto;
  padding: 10px 18px;
  border: 1px solid var(--app-accent);
  border-radius: 12px;
  background: var(--app-accent-soft);
  color: var(--app-text-strong);
  font-size: 0.9em;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, transform 0.14s ease;
}

.au-check:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-accent) 28%, transparent);
  border-color: var(--app-accent-strong);
  transform: translateY(-1px);
}

.au-check:disabled {
  opacity: 0.58;
  cursor: not-allowed;
  transform: none;
}

.au-status {
  margin: 0;
  font-size: 0.9em;
  color: var(--app-text-muted);
}

.au-status[data-tone='ok'] { color: var(--app-success); }
.au-status[data-tone='busy'] { color: var(--app-text-soft); }
.au-status[data-tone='danger'] { color: var(--app-danger); }

.au-error {
  margin: 0;
  font-size: 0.86em;
  color: var(--app-danger);
}

.au-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--app-text-muted);
  font-size: 0.84em;
}

.au-progress-bar {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--app-panel-subtle);
  border: 1px solid var(--app-border);
}

.au-progress-bar span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--app-accent);
  transition: width 0.18s ease;
}

.au-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.au-primary,
.au-secondary {
  min-height: 38px;
  padding: 9px 16px;
  border-radius: 10px;
  font-size: 0.88em;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, transform 0.14s ease;
}

.au-primary {
  border: 1px solid var(--app-accent-strong);
  background: var(--app-accent);
  color: var(--app-button-text, #fff);
}

.au-secondary {
  border: 1px solid var(--app-border);
  background: var(--app-panel);
  color: var(--app-text-strong);
}

.au-primary:hover:not(:disabled),
.au-secondary:hover:not(:disabled) {
  transform: translateY(-1px);
}

.au-primary:disabled,
.au-secondary:disabled {
  opacity: 0.58;
  cursor: not-allowed;
  transform: none;
}

.au-release {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-panel);
}

.au-release-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.au-release-head strong {
  color: var(--app-text-strong);
  font-size: 0.96em;
}

.au-release-head span {
  flex: 0 0 auto;
  color: var(--app-text-muted);
  font-size: 0.82em;
}

.au-release-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding-left: 18px;
  color: var(--app-text);
  font-size: 0.9em;
  line-height: 1.55;
}

@media (max-width: 640px) {
  .au-hero {
    flex-direction: column;
    align-items: stretch;
  }

  .au-check {
    width: 100%;
  }

  .au-release-head {
    flex-direction: column;
    gap: 4px;
  }
}
</style>
