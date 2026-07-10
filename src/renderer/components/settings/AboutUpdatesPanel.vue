<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  active: boolean
}>()

const { locale, t } = useI18n()

const aboutInfo = ref<AppAboutInfo | null>(null)
const updateState = ref<AppUpdateState | null>(null)
const loading = ref(false)
const checking = ref(false)
const localError = ref<string | null>(null)

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
    case 'checking': return t('settings.about.statusChecking')
    case 'up_to_date': return t('settings.about.statusUpToDate')
    case 'unsupported_platform': return t('settings.about.statusUnsupported')
    case 'update_available': return t('settings.about.statusUpdateAvailable', { version: updateState.value.latestVersion || '' }).trim()
    case 'failed': return t('settings.about.statusFailed')
    default: return ''
  }
})

const statusTone = computed(() => {
  switch (updateState.value?.status) {
    case 'up_to_date': return 'ok'
    case 'update_available': return 'busy'
    case 'checking': return 'busy'
    case 'failed': return 'danger'
    default: return 'idle'
  }
})

const resolvedError = computed(() => localError.value || updateState.value?.error || '')

const releaseNotes = computed(() => {
  const notes = updateState.value?.notes
  if (!notes) return []

  const primaryLanguage = locale.value.startsWith('zh') ? 'zh' : 'en'
  const fallbackLanguage = primaryLanguage === 'zh' ? 'en' : 'zh'
  return notes[primaryLanguage].length > 0 ? notes[primaryLanguage] : notes[fallbackLanguage]
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
    const [info, state] = await Promise.all([
      window.electronAPI.getAboutInfo(),
      window.electronAPI.getAppUpdateState()
    ])
    aboutInfo.value = info
    updateState.value = state
  } catch (error) {
    localError.value = (error as Error).message
  } finally {
    loading.value = false
  }
}

async function checkForUpdates () {
  if (!window.electronAPI || checking.value) return
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
</script>

<template>
  <section class="au-root">
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
        :disabled="loading || checking"
        @click="checkForUpdates"
      >
        {{ checking ? $t('settings.about.checking') : $t('settings.about.check') }}
      </button>
    </div>

    <p v-if="statusLabel" class="au-status" :data-tone="statusTone">{{ statusLabel }}</p>
    <p v-if="resolvedError" class="au-error">{{ resolvedError }}</p>

    <section v-if="releaseNotes.length > 0 || publishedAtLabel" class="au-release">
      <div class="au-release-head">
        <strong>{{ $t('settings.about.releaseNotes') }}</strong>
        <span v-if="publishedAtLabel">{{ $t('settings.about.releasedAt', { date: publishedAtLabel }) }}</span>
      </div>
      <ul v-if="releaseNotes.length > 0" class="au-release-list">
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
