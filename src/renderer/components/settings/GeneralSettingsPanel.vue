<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { loadAIExecutionPreferences, persistAIExecutionPreferences } from '../../utils/ai-execution-preferences'
import type { ThemePreference } from '../../utils/theme'
import { applyThemePreference, resolveThemePreference, watchSystemThemeChange } from '../../utils/theme'
import { setLocale } from '../../i18n'
import { loadLocalePreference, persistLocalePreference } from '../../utils/locale'
import type { LanguagePreference } from '../../../locales'

type GeneralSectionId = 'appearance' | 'execution' | 'transfer' | 'language'

interface ThemeOption {
  id: ThemePreference
  labelKey: string
  descKey: string
  previewTone: 'light' | 'dark' | 'system'
}

interface LanguageOption {
  id: LanguagePreference
  labelKey: string
  descKey: string
  mark: string
  badge: string
  tone: 'zh' | 'en' | 'system'
}

interface GeneralSection {
  id: GeneralSectionId
  icon: string
  label: string
  summary: string
  status: string
  title: string
  description: string
}

const FEEDBACK_DISPLAY_DURATION_MS = 2200
const { t } = useI18n()

const themeOptions: ThemeOption[] = [
  { id: 'system', labelKey: 'settings.general.appearance.themeSystem', descKey: 'settings.general.appearance.themeSystemDesc', previewTone: 'system' },
  { id: 'light', labelKey: 'settings.general.appearance.themeLight', descKey: 'settings.general.appearance.themeLightDesc', previewTone: 'light' },
  { id: 'dark', labelKey: 'settings.general.appearance.themeDark', descKey: 'settings.general.appearance.themeDarkDesc', previewTone: 'dark' }
]

const languageOptions: LanguageOption[] = [
  { id: 'zh-CN', labelKey: 'settings.general.language.zhCN', descKey: 'settings.general.language.zhCNDesc', mark: '中', badge: '简体', tone: 'zh' },
  { id: 'en-US', labelKey: 'settings.general.language.enUS', descKey: 'settings.general.language.enUSDesc', mark: 'EN', badge: 'US', tone: 'en' },
  { id: 'system', labelKey: 'settings.general.language.system', descKey: 'settings.general.language.systemDesc', mark: 'A/文', badge: 'Auto', tone: 'system' }
]

const activeSectionId = ref<GeneralSectionId>('appearance')
const themePreference = ref<ThemePreference>('system')
const languagePreference = ref<LanguagePreference>('system')
const executionPreferences = ref<AIExecutionPreferences>({
  notifyOnTaskComplete: true,
  enableAiLogging: false
})
const savingTheme = ref(false)
const savingLanguage = ref(false)
const savingExecution = ref(false)
const exporting = ref(false)
const importing = ref(false)
const feedback = ref('')

let stopThemeWatcher: (() => void) | null = null

const currentThemeOption = computed(() => {
  return themeOptions.find(option => option.id === themePreference.value) || themeOptions[0]
})

const currentLanguageOption = computed(() => {
  return languageOptions.find(option => option.id === languagePreference.value) || languageOptions[0]
})

const effectiveThemeLabel = computed(() => {
  const resolved = resolveThemePreference(themePreference.value)
  return resolved === 'dark' ? t('settings.general.appearance.statusDark') : t('settings.general.appearance.statusLight')
})

const sections = computed<GeneralSection[]>(() => {
  const themeSummary = t('settings.general.appearance.summary', { label: currentThemeOption.value ? t(currentThemeOption.value.labelKey) : '' })
  const executionSummary = executionPreferences.value.notifyOnTaskComplete
    ? t('settings.general.execution.summaryOn')
    : t('settings.general.execution.summaryOff')
  const transferSummary = exporting.value
    ? t('settings.general.transfer.summaryExporting')
    : importing.value
      ? t('settings.general.transfer.summaryImporting')
      : t('settings.general.transfer.summaryIdle')
  const languageSummary = t('settings.general.language.summary', { label: t(currentLanguageOption.value.labelKey) })

  return [
    {
      id: 'appearance',
      icon: '◐',
      label: t('settings.general.appearance.navLabel'),
      summary: themeSummary,
      status: effectiveThemeLabel.value,
      title: t('settings.general.appearance.title'),
      description: t('settings.general.appearance.description')
    },
    {
      id: 'execution',
      icon: '◎',
      label: t('settings.general.execution.navLabel'),
      summary: executionSummary,
      status: t('settings.general.execution.status'),
      title: t('settings.general.execution.title'),
      description: t('settings.general.execution.description')
    },
    {
      id: 'language',
      icon: '⌘',
      label: t('settings.general.language.navLabel'),
      summary: languageSummary,
      status: t('settings.general.language.status'),
      title: t('settings.general.language.title'),
      description: t('settings.general.language.description')
    },
    {
      id: 'transfer',
      icon: '⇄',
      label: t('settings.general.transfer.navLabel'),
      summary: transferSummary,
      status: t('settings.general.transfer.status'),
      title: t('settings.general.transfer.title'),
      description: t('settings.general.transfer.description')
    }
  ]
})

const activeSection = computed(() => {
  return sections.value.find(section => section.id === activeSectionId.value) || sections.value[0]
})

function setFeedback (message: string) {
  feedback.value = message
  window.setTimeout(() => {
    if (feedback.value === message) {
      feedback.value = ''
    }
  }, FEEDBACK_DISPLAY_DURATION_MS)
}

async function loadSettings () {
  try {
    const nextPreference = await window.electronAPI?.getThemePreference?.()
    themePreference.value = nextPreference || 'system'
  } catch {
    themePreference.value = 'system'
  }

  executionPreferences.value = await loadAIExecutionPreferences()

  languagePreference.value = await loadLocalePreference()

  applyThemePreference(themePreference.value)
}

async function selectTheme (nextPreference: ThemePreference) {
  if (savingTheme.value) return

  const previousPreference = themePreference.value
  themePreference.value = nextPreference
  applyThemePreference(nextPreference)

  savingTheme.value = true
  feedback.value = ''

  try {
    await window.electronAPI?.saveThemePreference?.(nextPreference)
    setFeedback(t('common.saved'))
  } catch (err) {
    themePreference.value = previousPreference
    applyThemePreference(previousPreference)
    setFeedback(t('common.saveFailed', { message: (err as Error).message }))
  } finally {
    savingTheme.value = false
  }
}

async function selectLanguage (nextPreference: LanguagePreference) {
  if (savingLanguage.value) return

  const previousPreference = languagePreference.value
  languagePreference.value = nextPreference
  setLocale(nextPreference)

  savingLanguage.value = true
  feedback.value = ''

  try {
    await persistLocalePreference(nextPreference)
    setFeedback(t('settings.general.language.saved'))
  } catch (err) {
    languagePreference.value = previousPreference
    setLocale(previousPreference)
    setFeedback(t('common.saveFailed', { message: (err as Error).message }))
  } finally {
    savingLanguage.value = false
  }
}

async function saveTaskNotificationPreference (notifyOnTaskComplete: boolean) {
  if (savingExecution.value) return

  const previousValue = executionPreferences.value.notifyOnTaskComplete
  executionPreferences.value = {
    ...executionPreferences.value,
    notifyOnTaskComplete
  }

  savingExecution.value = true
  feedback.value = ''

  try {
    await persistAIExecutionPreferences(executionPreferences.value)
    setFeedback(t('common.saved'))
  } catch (err) {
    executionPreferences.value = {
      ...executionPreferences.value,
      notifyOnTaskComplete: previousValue
    }
    setFeedback(t('common.saveFailed', { message: (err as Error).message }))
  } finally {
    savingExecution.value = false
  }
}

function toggleTaskNotificationPreference () {
  void saveTaskNotificationPreference(!executionPreferences.value.notifyOnTaskComplete)
}

async function exportConfig () {
  if (!window.electronAPI?.exportAppConfig || exporting.value || importing.value) return

  exporting.value = true
  feedback.value = ''
  try {
    const result = await window.electronAPI.exportAppConfig()
    if (result.canceled) return
    setFeedback(result.success
      ? t('settings.general.transfer.exportDone', { path: result.filePath || t('settings.general.transfer.targetFile') })
      : t('settings.general.transfer.exportIncomplete'))
  } catch (error) {
    setFeedback(t('settings.general.transfer.exportFailed', { message: (error as Error).message }))
  } finally {
    exporting.value = false
  }
}

async function importConfig () {
  if (!window.electronAPI?.importAppConfig || exporting.value || importing.value) return
  if (!window.confirm(t('settings.general.transfer.importConfirm'))) return

  importing.value = true
  feedback.value = ''
  try {
    const result = await window.electronAPI.importAppConfig()
    if (result.canceled) return
    setFeedback(t('settings.general.transfer.importDone'))
    if (result.requiresReload) {
      window.setTimeout(() => {
        window.location.reload()
      }, 500)
    }
  } catch (error) {
    setFeedback(t('settings.general.transfer.importFailed', { message: (error as Error).message }))
  } finally {
    importing.value = false
  }
}

onMounted(async () => {
  await loadSettings()
  stopThemeWatcher = watchSystemThemeChange(() => {
    if (themePreference.value === 'system') {
      applyThemePreference('system')
    }
  })
})

onUnmounted(() => {
  stopThemeWatcher?.()
})
</script>

<template>
  <div class="gs-root">
    <aside class="gs-nav">
      <div class="gs-nav-list">
        <button
          v-for="section in sections"
          :key="section.id"
          :class="['gs-nav-item', { active: activeSectionId === section.id }]"
          @click="activeSectionId = section.id"
        >
          <span class="gs-nav-icon">{{ section.icon }}</span>
          <div class="gs-nav-copy">
            <span class="gs-nav-label">{{ section.label }}</span>
            <span class="gs-nav-summary">{{ section.summary }}</span>
          </div>
          <span class="gs-nav-status">{{ section.status }}</span>
        </button>
      </div>
    </aside>

    <section class="gs-detail">
      <div class="gs-detail-shell">
        <template v-if="activeSectionId === 'appearance'">
          <div class="gs-theme-grid">
            <button
              v-for="option in themeOptions"
              :key="option.id"
              :class="['gs-theme-card', `tone-${option.previewTone}`, { active: themePreference === option.id }]"
              @click="selectTheme(option.id)"
            >
              <div class="gs-theme-card-top">
                <div class="gs-theme-visual">
                  <span class="gs-theme-orb orb-a" />
                  <span class="gs-theme-orb orb-b" />
                  <span class="gs-theme-orb orb-c" />
                </div>
                <span v-if="themePreference === option.id" class="gs-theme-badge">{{ $t('common.current') }}</span>
              </div>
              <div class="gs-theme-card-body">
                <span class="gs-theme-label">{{ $t(option.labelKey) }}</span>
                <span class="gs-theme-hint">{{ $t(option.descKey) }}</span>
              </div>
            </button>
          </div>
        </template>

        <template v-else-if="activeSectionId === 'execution'">
          <section class="gs-control-card">
            <div class="gs-control-copy">
              <span class="gs-control-title">{{ $t('settings.general.execution.notifyTitle') }}</span>
              <p class="gs-control-hint">{{ $t('settings.general.execution.notifyHint') }}</p>
            </div>
            <button
              type="button"
              class="gs-switch-row"
              :disabled="savingExecution"
              role="switch"
              :aria-checked="executionPreferences.notifyOnTaskComplete"
              :aria-label="executionPreferences.notifyOnTaskComplete ? $t('settings.general.execution.notifyOff') : $t('settings.general.execution.notifyOn')"
              @click="toggleTaskNotificationPreference"
            >
              <span class="gs-switch-track" :class="{ on: executionPreferences.notifyOnTaskComplete }">
                <span class="gs-switch-thumb" />
              </span>
            </button>
          </section>
        </template>

        <template v-else-if="activeSectionId === 'language'">
          <div class="gs-theme-grid">
            <button
              v-for="option in languageOptions"
              :key="option.id"
              :class="['gs-theme-card', 'tone-system', { active: languagePreference === option.id }]"
              :disabled="savingLanguage"
              @click="selectLanguage(option.id)"
            >
              <div class="gs-theme-card-top">
                <div :class="['gs-language-visual', `lang-${option.tone}`]" aria-hidden="true">
                  <span class="gs-language-mark">{{ option.mark }}</span>
                  <span class="gs-language-submark">{{ option.badge }}</span>
                </div>
                <span v-if="languagePreference === option.id" class="gs-theme-badge">{{ $t('common.current') }}</span>
              </div>
              <div class="gs-theme-card-body">
                <span class="gs-theme-label">{{ $t(option.labelKey) }}</span>
                <span class="gs-theme-hint">{{ $t(option.descKey) }}</span>
              </div>
            </button>
          </div>
        </template>

        <template v-else>

          <div class="gs-transfer-grid">
            <button class="gs-transfer-card primary" :disabled="exporting || importing" @click="exportConfig">
              <span class="gs-transfer-kicker">{{ $t('settings.general.transfer.exportKicker') }}</span>
              <strong class="gs-transfer-title">{{ $t('settings.general.transfer.exportTitle') }}</strong>
              <p class="gs-transfer-text">{{ $t('settings.general.transfer.exportText') }}</p>
              <span class="gs-transfer-action">{{ exporting ? $t('settings.general.transfer.exportActionBusy') : $t('settings.general.transfer.exportAction') }}</span>
            </button>

            <button class="gs-transfer-card secondary" :disabled="exporting || importing" @click="importConfig">
              <span class="gs-transfer-kicker">{{ $t('settings.general.transfer.importKicker') }}</span>
              <strong class="gs-transfer-title">{{ $t('settings.general.transfer.importTitle') }}</strong>
              <p class="gs-transfer-text">{{ $t('settings.general.transfer.importText') }}</p>
              <span class="gs-transfer-action">{{ importing ? $t('settings.general.transfer.importActionBusy') : $t('settings.general.transfer.importAction') }}</span>
            </button>
          </div>

          <div class="gs-note-grid">
            <article class="gs-note-card">
              <span class="gs-note-title">{{ $t('settings.general.transfer.noteIncludedTitle') }}</span>
              <p>{{ $t('settings.general.transfer.noteIncludedText') }}</p>
            </article>
            <article class="gs-note-card">
              <span class="gs-note-title">{{ $t('settings.general.transfer.noteExcludedTitle') }}</span>
              <p>{{ $t('settings.general.transfer.noteExcludedText') }}</p>
            </article>
          </div>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.gs-root {
  display: flex;
  height: 100%;
  color: var(--app-text);
  background:
    radial-gradient(circle at top right, rgba(95, 130, 255, 0.08), transparent 30%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 22%);
}

.gs-nav {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 20px 16px;
  border-right: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.02);
}

.gs-nav-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.gs-kicker,
.gs-detail-kicker,
.gs-transfer-kicker,
.gs-detail-meta-label,
.gs-overview-label,
.gs-footnote-title {
  font-size: 0.72em;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--app-text-faint);
}

.gs-title,
.gs-detail-title {
  margin: 0;
  color: var(--app-text-strong);
}

.gs-title {
  font-size: 1.1em;
}

.gs-desc,
.gs-detail-desc,
.gs-nav-summary,
.gs-overview-text,
.gs-theme-hint,
.gs-control-hint,
.gs-note-card p,
.gs-note-panel p,
.gs-nav-footnote p,
.gs-transfer-text {
  margin: 0;
  color: var(--app-text-muted);
  line-height: 1.6;
}

.gs-feedback {
  font-size: 0.8em;
  color: var(--app-accent);
}

.gs-nav-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.gs-nav-item {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  width: 100%;
  padding: 12px;
  border: 1px solid transparent;
  border-radius: 14px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.14s ease, background 0.14s ease, transform 0.14s ease;
}

.gs-nav-item:hover {
  background: var(--app-panel-subtle);
  border-color: rgba(255, 255, 255, 0.04);
  transform: translateX(2px);
}

.gs-nav-item.active {
  background: linear-gradient(180deg, rgba(94, 123, 255, 0.16), rgba(94, 123, 255, 0.08));
  border-color: rgba(94, 123, 255, 0.3);
}

.gs-nav-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--app-text-soft);
  font-size: 0.9em;
}

.gs-nav-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.gs-nav-label,
.gs-theme-label,
.gs-control-title,
.gs-note-title,
.gs-transfer-title,
.gs-detail-meta-value,
.gs-overview-value {
  color: var(--app-text);
}

.gs-nav-label,
.gs-control-title,
.gs-transfer-title {
  font-size: 0.9em;
  font-weight: 600;
}

.gs-nav-summary {
  font-size: 0.77em;
}

.gs-nav-status {
  grid-column: 2;
  font-size: 0.74em;
  color: var(--app-text-faint);
}

.gs-nav-footnote {
  margin-top: auto;
  padding: 14px;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-panel-subtle);
}

.gs-detail {
  flex: 1;
  min-width: 0;
  padding: 24px 28px;
  overflow: auto;
}

.gs-detail-shell {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 100%;
}

.gs-detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  border: 1px solid var(--app-border);
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01));
}

.gs-detail-copy {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.gs-detail-title {
  font-size: 1.35em;
}

.gs-detail-meta {
  min-width: 180px;
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--app-panel-subtle);
  border: 1px solid rgba(255, 255, 255, 0.04);
}

.gs-detail-meta-value {
  display: block;
  margin-top: 4px;
  font-size: 0.92em;
  font-weight: 600;
}

.gs-overview-grid,
.gs-transfer-grid,
.gs-note-grid,
.gs-theme-grid {
  display: grid;
  gap: 14px;
}

.gs-overview-grid,
.gs-transfer-grid,
.gs-note-grid {
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.gs-overview-grid.single {
  grid-template-columns: minmax(0, 1fr);
}

.gs-overview-card,
.gs-control-card,
.gs-note-card,
.gs-note-panel,
.gs-transfer-card {
  border: 1px solid var(--app-border);
  border-radius: 18px;
  background: var(--app-panel);
}

.gs-overview-card,
.gs-note-card,
.gs-note-panel,
.gs-transfer-card,
.gs-control-card {
  padding: 18px;
}

.gs-overview-card.emphasis,
.gs-transfer-card.primary {
  background:
    radial-gradient(circle at top left, rgba(102, 140, 255, 0.18), transparent 42%),
    var(--app-panel);
}

.gs-overview-value {
  display: block;
  margin-top: 8px;
  font-size: 1.18em;
}

.gs-overview-text {
  margin-top: 8px;
  font-size: 0.82em;
}

.gs-theme-grid {
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
}

.gs-theme-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--app-border);
  border-radius: 18px;
  background: var(--app-panel);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.14s ease, transform 0.14s ease, box-shadow 0.14s ease;
}

.gs-theme-card:hover {
  transform: translateY(-2px);
}

.gs-theme-card.active {
  border-color: rgba(94, 123, 255, 0.42);
  box-shadow: 0 14px 28px rgba(24, 28, 48, 0.18);
}

.gs-theme-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.gs-theme-visual {
  width: 72px;
  height: 72px;
  border-radius: 18px;
  position: relative;
  overflow: hidden;
}

.gs-language-visual {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  width: 72px;
  height: 72px;
  padding: 12px;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
}

.lang-zh {
  background: linear-gradient(135deg, #fff4e8, #ffb76c);
  color: #6a2d00;
}

.lang-en {
  background: linear-gradient(135deg, #eef4ff, #8db9ff);
  color: #10294f;
}

.lang-system {
  background: linear-gradient(135deg, #eef4fb 0%, #d9e6f6 48%, #10192a 52%, #1a2940 100%);
  color: #f5f8ff;
}

.gs-language-mark {
  font-size: 1.5em;
  line-height: 1;
  font-weight: 700;
  letter-spacing: -0.04em;
}

.lang-system .gs-language-mark {
  font-size: 1.16em;
  letter-spacing: -0.03em;
}

.gs-language-submark {
  align-self: flex-start;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.42);
  font-size: 0.72em;
  line-height: 1;
  font-weight: 700;
}

.lang-system .gs-language-submark {
  background: rgba(255, 255, 255, 0.16);
  color: #f5f8ff;
}

.tone-light .gs-theme-visual {
  background: linear-gradient(180deg, #fbfdff, #dfe7f3);
}

.tone-dark .gs-theme-visual {
  background: linear-gradient(180deg, #152033, #070b14);
}

.tone-system .gs-theme-visual {
  background: linear-gradient(135deg, #f2f6fb 0 50%, #0b1220 50% 100%);
}

.gs-theme-orb {
  position: absolute;
  display: block;
  border-radius: 999px;
}

.orb-a {
  width: 34px;
  height: 34px;
  top: 10px;
  left: 10px;
  background: rgba(255, 255, 255, 0.45);
}

.orb-b {
  width: 26px;
  height: 26px;
  right: 10px;
  top: 18px;
  background: rgba(94, 123, 255, 0.55);
}

.orb-c {
  width: 40px;
  height: 12px;
  left: 14px;
  bottom: 12px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.3);
}

.gs-theme-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(94, 123, 255, 0.14);
  color: var(--app-accent);
  font-size: 0.74em;
  font-weight: 600;
}

.gs-theme-card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.gs-theme-label {
  font-size: 0.96em;
  font-weight: 600;
}

.gs-theme-hint {
  font-size: 0.8em;
}

.gs-control-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}

.gs-control-copy {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.gs-control-hint {
  font-size: 0.82em;
}

.gs-switch-row {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
}

.gs-switch-row:disabled {
  cursor: default;
  opacity: 0.72;
}

.gs-switch-track {
  width: 54px;
  height: 30px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.08);
  position: relative;
  transition: background 0.16s ease;
}

.gs-switch-track.on {
  background: rgba(94, 123, 255, 0.9);
}

.gs-switch-thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: #fff;
  transition: transform 0.16s ease;
}

.gs-switch-track.on .gs-switch-thumb {
  transform: translateX(24px);
}

.gs-transfer-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.gs-transfer-card.secondary {
  background:
    radial-gradient(circle at bottom right, rgba(84, 206, 170, 0.12), transparent 38%),
    var(--app-panel);
}

.gs-transfer-card:disabled {
  opacity: 0.65;
  cursor: default;
}

.gs-transfer-action {
  margin-top: auto;
  color: var(--app-accent);
  font-size: 0.82em;
  font-weight: 600;
}

.gs-note-card p,
.gs-note-panel p,
.gs-transfer-text,
.gs-control-hint {
  font-size: 0.82em;
}

@media (max-width: 980px) {
  .gs-root {
    flex-direction: column;
  }

  .gs-nav {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--app-border);
  }

  .gs-detail {
    padding: 20px 18px;
  }

  .gs-detail-header,
  .gs-control-card {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
