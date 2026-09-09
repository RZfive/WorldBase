<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ThemePreference } from '../../utils/theme'
import { applyThemePreference, resolveThemePreference, watchSystemThemeChange } from '../../utils/theme'

interface ThemeOption {
  id: ThemePreference
  labelKey: string
  descKey: string
  previewTone: 'light' | 'dark' | 'system'
}

const { t } = useI18n()

const themeOptions: ThemeOption[] = [
  {
    id: 'system',
    labelKey: 'settings.appearancePanel.themeSystem',
    descKey: 'settings.appearancePanel.themeSystemDesc',
    previewTone: 'system'
  },
  {
    id: 'light',
    labelKey: 'settings.appearancePanel.themeLight',
    descKey: 'settings.appearancePanel.themeLightDesc',
    previewTone: 'light'
  },
  {
    id: 'dark',
    labelKey: 'settings.appearancePanel.themeDark',
    descKey: 'settings.appearancePanel.themeDarkDesc',
    previewTone: 'dark'
  }
]

const preference = ref<ThemePreference>('system')
const saving = ref(false)
const feedback = ref('')

let stopThemeWatcher: (() => void) | null = null

const effectiveThemeLabel = computed(() => {
  const resolved = resolveThemePreference(preference.value)
  return resolved === 'dark' ? t('settings.appearancePanel.statusDark') : t('settings.appearancePanel.statusLight')
})

async function loadThemePreference () {
  try {
    const nextPreference = await window.electronAPI?.getThemePreference?.()
    preference.value = nextPreference || 'system'
  } catch {
    preference.value = 'system'
  }

  applyThemePreference(preference.value)
}

async function selectTheme (nextPreference: ThemePreference) {
  if (saving.value) return

  const previousPreference = preference.value
  preference.value = nextPreference
  applyThemePreference(nextPreference)

  saving.value = true
  feedback.value = ''

  try {
    await window.electronAPI?.saveThemePreference?.(nextPreference)
    feedback.value = t('settings.appearancePanel.saved')
  } catch (err) {
    preference.value = previousPreference
    applyThemePreference(previousPreference)
    feedback.value = t('common.saveFailed', { message: (err as Error).message })
  } finally {
    saving.value = false
    window.setTimeout(() => {
      feedback.value = ''
    }, 1800)
  }
}

onMounted(async () => {
  await loadThemePreference()
  stopThemeWatcher = watchSystemThemeChange(() => {
    if (preference.value === 'system') {
      applyThemePreference('system')
    }
  })
})

onUnmounted(() => {
  stopThemeWatcher?.()
})
</script>

<template>
  <div class="ap-root">
    <div class="ap-header">
      <h3 class="ap-title">{{ $t('settings.appearancePanel.title') }}</h3>
      <p class="ap-desc">{{ $t('settings.appearancePanel.description', { status: effectiveThemeLabel }) }}</p>
      <span v-if="feedback" class="ap-feedback">{{ feedback }}</span>
    </div>

    <div class="ap-separator" />

    <div class="ap-list">
      <button
        v-for="option in themeOptions"
        :key="option.id"
        :class="['ap-item', { active: preference === option.id }]"
        @click="selectTheme(option.id)"
      >
        <div class="ap-item-left">
          <span class="ap-item-icon">{{ option.previewTone === 'light' ? '☀️' : option.previewTone === 'dark' ? '🌙' : '💻' }}</span>
          <div class="ap-item-text">
            <span class="ap-item-label">{{ $t(option.labelKey) }}</span>
            <span class="ap-item-hint">{{ $t(option.descKey) }}</span>
          </div>
        </div>
        <span v-if="preference === option.id" class="ap-check">✓</span>
      </button>
    </div>

    <div class="ap-separator" />

    <div class="ap-note">
      <span class="ap-note-title">{{ $t('settings.appearancePanel.noteTitle') }}</span>
      <p>{{ $t('settings.appearancePanel.noteText') }}</p>
    </div>
  </div>
</template>

<style scoped>
.ap-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 20px 28px;
  overflow-y: auto;
  color: var(--app-text);
}

.ap-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ap-title {
  margin: 0;
  font-size: 1.1em;
  color: var(--app-text-strong);
}

.ap-desc {
  margin: 0;
  font-size: 0.85em;
  color: var(--app-text-muted);
}

.ap-feedback {
  font-size: 0.8em;
  color: var(--app-accent);
  margin-top: 2px;
}

.ap-separator {
  height: 1px;
  background: var(--app-border);
  margin: 16px 0;
}

.ap-list {
  display: flex;
  flex-direction: column;
}

.ap-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 4px;
  border: none;
  border-bottom: 1px solid var(--app-border);
  background: none;
  cursor: pointer;
  color: inherit;
  text-align: left;
  transition: background 0.12s;
}
.ap-item:last-child { border-bottom: none; }
.ap-item:hover { background: var(--app-panel-muted); }

.ap-item.active {
  background: var(--app-panel-muted);
}

.ap-item-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ap-item-icon {
  font-size: 1.3em;
  flex-shrink: 0;
  width: 32px;
  text-align: center;
}

.ap-item-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ap-item-label {
  font-size: 0.92em;
  font-weight: 500;
  color: var(--app-text);
}

.ap-item-hint {
  font-size: 0.78em;
  color: var(--app-text-faint);
}

.ap-check {
  font-size: 1em;
  color: var(--app-accent);
  font-weight: 600;
  flex-shrink: 0;
  margin-right: 4px;
}

.ap-note {
  font-size: 0.82em;
  color: var(--app-text-muted);
  line-height: 1.5;
}

.ap-note-title {
  font-weight: 600;
  color: var(--app-text-soft);
  margin-bottom: 4px;
  display: block;
}

.ap-note p {
  margin: 0;
}
</style>
