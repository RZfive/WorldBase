<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { loadAIExecutionPreferences, persistAIExecutionPreferences } from '../../utils/ai-execution-preferences'
import type { ThemePreference } from '../../utils/theme'
import { applyThemePreference, resolveThemePreference, watchSystemThemeChange } from '../../utils/theme'
import { setLocale } from '../../i18n'
import { loadLocalePreference, persistLocalePreference } from '../../utils/locale'
import type { LanguagePreference } from '../../../locales'
import {
  applyChatFontPreferences,
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_MIN,
  CHAT_FONT_SIZE_TICKS,
  chatFontSizeToPercent,
  getChatFontDisplayName,
  getChatFontSearchText,
  getChatFontSecondaryName,
  loadChatFontPreferences,
  loadSystemFonts,
  persistChatFontPreferences,
  resolveChatFontFamilyValue
} from '../../utils/chat-font-preferences'
import { DEFAULT_CHAT_FONT_SIZE } from '../../../shared/chat-font-preferences'

type GeneralSectionId = 'appearance' | 'font' | 'execution' | 'transfer' | 'language'

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
  glyphs: readonly [string, string]
  displayName: string
  sample: string
  localeCode: string
  tone: 'zh' | 'en' | 'auto'
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
  { id: 'zh-CN', labelKey: 'settings.general.language.zhCN', descKey: 'settings.general.language.zhCNDesc', glyphs: ['中', '文'], displayName: '中文', sample: '你好，世界', localeCode: 'ZH-CN', tone: 'zh' },
  { id: 'en-US', labelKey: 'settings.general.language.enUS', descKey: 'settings.general.language.enUSDesc', glyphs: ['E', 'N'], displayName: 'English', sample: 'Hello, world', localeCode: 'EN-US', tone: 'en' },
  { id: 'system', labelKey: 'settings.general.language.system', descKey: 'settings.general.language.systemDesc', glyphs: ['中', 'A'], displayName: 'Auto', sample: '跟随系统 / System', localeCode: 'AUTO', tone: 'auto' }
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
const savingFont = ref(false)
const exporting = ref(false)
const importing = ref(false)
const feedback = ref('')

const chatFontPreferences = ref<ChatFontPreferences>({
  fontFamily: '',
  fontSize: DEFAULT_CHAT_FONT_SIZE
})
const systemFonts = ref<string[]>([])
const fontsLoading = ref(false)
const fontsUnavailable = ref(false)
const fontDropdownOpen = ref(false)
const fontSearch = ref('')
const fontTriggerRef = ref<HTMLButtonElement | null>(null)
const fontPanelRef = ref<HTMLDivElement | null>(null)
const fontPanelStyle = ref<Record<string, string>>({ display: 'none' })

let stopThemeWatcher: (() => void) | null = null

const fontSizeTicks = CHAT_FONT_SIZE_TICKS
const fontSliderMin = CHAT_FONT_SIZE_MIN
const fontSliderMax = CHAT_FONT_SIZE_MAX
const fontSliderStyle = computed(() => ({
  // Position the filled portion of the track and the thumb via a CSS var the
  // webkit slider pseudo-elements read, so the track reflects the live value.
  '--gs-font-slider-progress': `${chatFontSizeToPercent(chatFontPreferences.value.fontSize)}%`
}))

const filteredSystemFonts = computed(() => {
  const query = fontSearch.value.trim().toLowerCase()
  if (!query) return systemFonts.value
  return systemFonts.value.filter(font => getChatFontSearchText(font).includes(query))
})

const currentFontFamilyLabel = computed(() => {
  return chatFontPreferences.value.fontFamily.trim()
    ? getChatFontDisplayName(chatFontPreferences.value.fontFamily.trim())
    : t('settings.general.font.systemDefault')
})

const currentFontFamilyStyle = computed(() => resolveChatFontFamilyValue(chatFontPreferences.value.fontFamily))

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
  const fontSummary = currentFontFamilyLabel.value
  const fontStatusKey = 'settings.general.font.sizeStatus'
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
      id: 'font',
      icon: 'Aa',
      label: t('settings.general.font.navLabel'),
      summary: fontSummary,
      status: t(fontStatusKey),
      title: t('settings.general.font.title'),
      description: t('settings.general.font.description')
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
      icon: '文/A',
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

  try {
    chatFontPreferences.value = await loadChatFontPreferences()
    applyChatFontPreferences(chatFontPreferences.value)
  } catch {
    // Keep CSS defaults on failure.
  }

  applyThemePreference(themePreference.value)
}

async function ensureSystemFonts () {
  if (systemFonts.value.length > 0 || fontsLoading.value) return
  fontsLoading.value = true
  try {
    const fonts = await loadSystemFonts()
    systemFonts.value = fonts
    fontsUnavailable.value = fonts.length === 0
  } catch {
    fontsUnavailable.value = true
  } finally {
    fontsLoading.value = false
  }
}

/** Live preview while dragging: update the value + CSS immediately, no IPC. */
function onFontSizeInput (event: Event) {
  const target = event.target as HTMLInputElement
  const px = Number.parseInt(target.value, 10)
  if (!Number.isFinite(px)) return
  chatFontPreferences.value = { ...chatFontPreferences.value, fontSize: px }
  applyChatFontPreferences(chatFontPreferences.value)
}

/** Persist on release (change fires once when the drag ends). */
async function onFontSizeChange (event: Event) {
  const target = event.target as HTMLInputElement
  const px = Number.parseInt(target.value, 10)
  if (!Number.isFinite(px) || savingFont.value) return

  // Sync the source of truth in case the input rounded/clamped.
  chatFontPreferences.value = { ...chatFontPreferences.value, fontSize: px }
  applyChatFontPreferences(chatFontPreferences.value)

  savingFont.value = true
  feedback.value = ''

  try {
    await persistChatFontPreferences(chatFontPreferences.value)
    setFeedback(t('common.saved'))
  } catch (err) {
    setFeedback(t('common.saveFailed', { message: (err as Error).message }))
  } finally {
    savingFont.value = false
  }
}

async function selectFontFamily (family: string) {
  if (savingFont.value) return

  const previous = chatFontPreferences.value.fontFamily
  const normalized = family.trim()
  if (previous === normalized) {
    fontDropdownOpen.value = false
    return
  }

  chatFontPreferences.value = { ...chatFontPreferences.value, fontFamily: normalized }
  applyChatFontPreferences(chatFontPreferences.value)
  fontDropdownOpen.value = false

  savingFont.value = true
  feedback.value = ''

  try {
    await persistChatFontPreferences(chatFontPreferences.value)
    setFeedback(t('common.saved'))
  } catch (err) {
    chatFontPreferences.value = { ...chatFontPreferences.value, fontFamily: previous }
    applyChatFontPreferences(chatFontPreferences.value)
    setFeedback(t('common.saveFailed', { message: (err as Error).message }))
  } finally {
    savingFont.value = false
  }
}

function updateFontPanelPosition () {
  if (!fontDropdownOpen.value || !fontTriggerRef.value) {
    fontPanelStyle.value = { display: 'none' }
    return
  }

  const rect = fontTriggerRef.value.getBoundingClientRect()
  const viewportPadding = 10
  const panelGap = 6
  const preferredWidth = Math.max(rect.width, 280)
  const maxWidth = Math.max(220, window.innerWidth - viewportPadding * 2)
  const width = Math.min(preferredWidth, maxWidth)
  const left = Math.min(
    Math.max(rect.left, viewportPadding),
    window.innerWidth - viewportPadding - width
  )
  const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - panelGap - viewportPadding)
  const spaceAbove = Math.max(0, rect.top - panelGap - viewportPadding)
  const measuredHeight = fontPanelRef.value?.offsetHeight || 320
  const desiredHeight = Math.min(measuredHeight, 320)
  const placeAbove = spaceBelow < desiredHeight && spaceAbove > spaceBelow
  const availableHeight = placeAbove ? spaceAbove : spaceBelow
  const maxHeight = Math.min(
    320,
    Math.max(120, availableHeight),
    Math.max(120, window.innerHeight - viewportPadding * 2)
  )
  const topLimit = Math.max(viewportPadding, window.innerHeight - viewportPadding - maxHeight)
  const preferredTop = placeAbove ? rect.top - panelGap - maxHeight : rect.bottom + panelGap
  const top = Math.min(Math.max(preferredTop, viewportPadding), topLimit)

  fontPanelStyle.value = {
    position: 'fixed',
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    maxHeight: `${maxHeight}px`
  }
}

async function toggleFontDropdown () {
  if (savingFont.value) return
  fontDropdownOpen.value = !fontDropdownOpen.value
  if (fontDropdownOpen.value) {
    fontSearch.value = ''
    // Position immediately so the panel pops in (showing a loading state) while
    // fonts enumerate in the background, rather than waiting for queryLocalFonts.
    updateFontPanelPosition()
    void ensureSystemFonts()
    await nextTick(() => {
      updateFontPanelPosition()
      const searchEl = document.querySelector<HTMLInputElement>('.gs-font-search')
      searchEl?.focus()
    })
  }
}

function closeFontDropdown () {
  fontDropdownOpen.value = false
}

function handleFontSearchKeydown (event: KeyboardEvent) {
  if (event.key !== 'Enter') return
  const match = filteredSystemFonts.value[0]
  if (match) void selectFontFamily(match)
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
  window.addEventListener('resize', handleFontReposition)
  window.addEventListener('scroll', handleFontReposition, true)
})

onUnmounted(() => {
  stopThemeWatcher?.()
  window.removeEventListener('resize', handleFontReposition)
  window.removeEventListener('scroll', handleFontReposition, true)
})

function handleFontReposition () {
  if (fontDropdownOpen.value) updateFontPanelPosition()
}
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

        <template v-else-if="activeSectionId === 'font'">
          <section class="gs-control-card gs-font-family-card">
            <div class="gs-control-copy">
              <span class="gs-control-title">{{ $t('settings.general.font.familyTitle') }}</span>
              <p class="gs-control-hint">{{ $t('settings.general.font.familyHint') }}</p>
            </div>
            <div class="gs-font-picker">
              <button
                ref="fontTriggerRef"
                type="button"
                class="gs-font-trigger"
                :disabled="savingFont"
                @click="toggleFontDropdown"
              >
                <span class="gs-font-trigger-name" :style="{ fontFamily: currentFontFamilyStyle }">{{ currentFontFamilyLabel }}</span>
                <span class="gs-font-trigger-caret" aria-hidden="true">▾</span>
              </button>
              <Teleport to="body">
                <template v-if="fontDropdownOpen">
                  <div class="gs-font-backdrop" @click="closeFontDropdown" />
                  <div ref="fontPanelRef" class="gs-font-panel" :style="fontPanelStyle" @click.stop>
                    <input
                      v-model="fontSearch"
                      class="gs-font-search"
                      type="text"
                      :placeholder="$t('settings.general.font.searchPlaceholder')"
                      @keydown.esc.prevent="closeFontDropdown"
                      @keydown="handleFontSearchKeydown"
                    />
                    <div v-if="fontsLoading" class="gs-font-status">{{ $t('settings.general.font.loading') }}</div>
                    <div v-else-if="fontsUnavailable" class="gs-font-status">{{ $t('settings.general.font.unavailable') }}</div>
                    <div v-else class="gs-font-list">
                      <button
                        type="button"
                        class="gs-font-item"
                        :class="{ active: chatFontPreferences.fontFamily === '' }"
                        @click="selectFontFamily('')"
                      >
                        <span class="gs-font-item-name gs-font-item-default">{{ $t('settings.general.font.systemDefault') }}</span>
                      </button>
                      <button
                        v-for="font in filteredSystemFonts"
                        :key="font"
                        type="button"
                        class="gs-font-item"
                        :class="{ active: chatFontPreferences.fontFamily === font }"
                        :style="{ fontFamily: resolveChatFontFamilyValue(font) }"
                        @click="selectFontFamily(font)"
                      >
                        <span class="gs-font-item-copy">
                          <span class="gs-font-item-name">{{ getChatFontDisplayName(font) }}</span>
                          <span v-if="getChatFontSecondaryName(font)" class="gs-font-item-meta">{{ getChatFontSecondaryName(font) }}</span>
                        </span>
                      </button>
                      <div v-if="filteredSystemFonts.length === 0" class="gs-font-status">{{ $t('settings.general.font.noMatch') }}</div>
                    </div>
                  </div>
                </template>
              </Teleport>
            </div>
          </section>

          <div class="gs-font-preview" :style="{ fontSize: `${chatFontPreferences.fontSize}px`, fontFamily: currentFontFamilyStyle }">
            <span class="gs-font-preview-text">{{ $t('settings.general.font.previewSample') }}</span>
            <span class="gs-font-size-value">{{ chatFontPreferences.fontSize }}px</span>
          </div>

          <div class="gs-font-slider" :style="fontSliderStyle">
            <input
              class="gs-font-slider-input"
              type="range"
              :min="fontSliderMin"
              :max="fontSliderMax"
              step="1"
              :value="chatFontPreferences.fontSize"
              :disabled="savingFont"
              :aria-label="$t('settings.general.font.sizeTitle')"
              @input="onFontSizeInput"
              @change="onFontSizeChange"
            />
            <div class="gs-font-slider-ticks" aria-hidden="true">
              <span
                v-for="tick in fontSizeTicks"
                :key="tick.px"
                class="gs-font-slider-tick"
                :class="{ active: chatFontPreferences.fontSize === tick.px }"
                :style="{ left: `${chatFontSizeToPercent(tick.px)}%` }"
              >
                <span class="gs-font-slider-tick-mark" />
                <span class="gs-font-slider-tick-label">{{ $t(tick.labelKey) }}</span>
              </span>
            </div>
            <div class="gs-font-slider-scale">
              <span>{{ fontSliderMin }}</span>
              <span>{{ fontSliderMax }}</span>
            </div>
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
          <div class="gs-language-grid">
            <button
              v-for="option in languageOptions"
              :key="option.id"
              :class="['gs-language-card', `lang-card-${option.tone}`, { active: languagePreference === option.id }]"
              :disabled="savingLanguage"
              @click="selectLanguage(option.id)"
            >
              <div class="gs-language-card-top">
                <div :class="['gs-language-visual', `lang-${option.tone}`]" aria-hidden="true">
                  <span class="gs-language-code">{{ option.localeCode }}</span>
                  <span class="gs-language-glyphs">
                    <span
                      v-for="glyph in option.glyphs"
                      :key="glyph"
                      class="gs-language-glyph"
                    >
                      {{ glyph }}
                    </span>
                  </span>
                  <span class="gs-language-display">{{ option.displayName }}</span>
                  <span class="gs-language-sample">{{ option.sample }}</span>
                </div>
                <span v-if="languagePreference === option.id" class="gs-language-badge">{{ $t('common.current') }}</span>
              </div>
              <div class="gs-language-card-body">
                <span class="gs-language-label">{{ $t(option.labelKey) }}</span>
                <span class="gs-language-hint">{{ $t(option.descKey) }}</span>
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
.gs-language-hint,
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
.gs-language-label,
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
.gs-theme-grid,
.gs-language-grid {
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

.gs-theme-grid,
.gs-language-grid {
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
}

.gs-theme-card,
.gs-language-card {
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

.gs-theme-card:hover,
.gs-language-card:hover {
  transform: translateY(-2px);
}

.gs-theme-card.active,
.gs-language-card.active {
  border-color: rgba(94, 123, 255, 0.42);
  box-shadow: 0 14px 28px rgba(24, 28, 48, 0.18);
}

.gs-theme-card-top,
.gs-language-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.gs-language-card {
  min-height: 172px;
  overflow: hidden;
  position: relative;
}

.gs-language-card::before {
  content: '';
  position: absolute;
  inset: 0;
  opacity: 0.62;
  pointer-events: none;
}

.lang-card-zh::before {
  background:
    radial-gradient(circle at 18% 12%, rgba(255, 187, 104, 0.28), transparent 36%),
    radial-gradient(circle at 82% 10%, rgba(255, 91, 91, 0.12), transparent 34%);
}

.lang-card-en::before {
  background:
    radial-gradient(circle at 20% 10%, rgba(111, 165, 255, 0.22), transparent 38%),
    radial-gradient(circle at 86% 22%, rgba(78, 215, 183, 0.1), transparent 34%);
}

.lang-card-auto::before {
  background:
    radial-gradient(circle at 18% 12%, rgba(255, 184, 105, 0.22), transparent 36%),
    radial-gradient(circle at 82% 16%, rgba(111, 165, 255, 0.18), transparent 36%),
    radial-gradient(circle at 52% 88%, rgba(78, 215, 183, 0.12), transparent 30%);
}

.gs-language-card > * {
  position: relative;
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
  width: 132px;
  min-height: 126px;
  padding: 12px;
  border-radius: 22px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  overflow: hidden;
  position: relative;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    0 16px 28px rgba(16, 24, 40, 0.16);
}

.gs-language-visual::after {
  content: '';
  position: absolute;
  right: -24px;
  bottom: -28px;
  width: 82px;
  height: 82px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.2);
  pointer-events: none;
}

.lang-zh {
  background:
    radial-gradient(circle at 85% 16%, rgba(255, 255, 255, 0.58), transparent 26%),
    linear-gradient(135deg, rgba(255, 240, 210, 0.98), rgba(245, 156, 78, 0.96)),
    #f59c4e;
  color: #642400;
}

.lang-en {
  background:
    radial-gradient(circle at 86% 16%, rgba(255, 255, 255, 0.56), transparent 26%),
    linear-gradient(135deg, rgba(232, 246, 255, 0.98), rgba(62, 151, 222, 0.92)),
    #3e97de;
  color: #09284a;
}

.lang-auto {
  background:
    radial-gradient(circle at 86% 16%, rgba(255, 255, 255, 0.58), transparent 26%),
    linear-gradient(135deg, rgba(255, 238, 201, 0.98), rgba(221, 239, 255, 0.96) 52%, rgba(212, 248, 232, 0.92)),
    #ddefef;
  color: #1d2c44;
}

.gs-language-code {
  align-self: flex-start;
  position: relative;
  z-index: 1;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.48);
  font-size: 0.66em;
  line-height: 1;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.gs-language-glyphs {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
  margin-top: 12px;
}

.gs-language-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  aspect-ratio: 1;
  border-radius: 15px;
  background: rgba(255, 255, 255, 0.46);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.38);
  font-size: 1.52em;
  line-height: 1;
  font-weight: 800;
  letter-spacing: -0.04em;
}

.lang-en .gs-language-glyph {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 1.42em;
  letter-spacing: 0;
}

.lang-auto .gs-language-glyph {
  color: #1d2c44;
}

.gs-language-display {
  position: relative;
  z-index: 1;
  margin-top: 10px;
  font-size: 0.84em;
  line-height: 1;
  font-weight: 800;
  letter-spacing: -0.01em;
}

.gs-language-sample {
  position: relative;
  z-index: 1;
  margin-top: 7px;
  font-size: 0.78em;
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.lang-auto .gs-language-sample {
  color: #1d2c44;
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

.gs-theme-badge,
.gs-language-badge {
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

.gs-theme-card-body,
.gs-language-card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.gs-theme-label,
.gs-language-label {
  font-size: 0.96em;
  font-weight: 600;
}

.gs-theme-hint,
.gs-language-hint {
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

.gs-font-family-card {
  align-items: center;
}

.gs-font-picker {
  position: relative;
  flex-shrink: 0;
}

.gs-font-trigger {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 190px;
  padding: 9px 12px;
  border: 1px solid var(--app-border-strong);
  border-radius: 12px;
  background: var(--app-input-bg);
  color: var(--app-text);
  cursor: pointer;
  transition: border-color 0.14s ease, background 0.14s ease;
}

.gs-font-trigger:hover:not(:disabled) {
  border-color: var(--app-accent-glow);
}

.gs-font-trigger:disabled {
  opacity: 0.7;
  cursor: default;
}

.gs-font-trigger-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.9em;
}

.gs-font-trigger-caret {
  color: var(--app-text-muted);
  font-size: 0.8em;
}

.gs-font-size-value {
  flex-shrink: 0;
  min-width: 56px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 0.82em;
  font-weight: 600;
  color: var(--app-text-muted);
}

.gs-font-preview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 16px 18px;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-panel-muted);
  color: var(--app-text-strong);
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* font-size + font-family are bound inline so the preview reflects the live
     slider value and chosen family in real time. */
}

.gs-font-preview-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Slider — macOS-style: a thin track with a filled portion, a circular thumb,
   and labelled recommended ticks (小/中/大) at 14/16/18px. The input itself is
   transparent; the track fill is drawn via ::-webkit-slider-runnable-track
   reading --gs-font-slider-progress. */
.gs-font-slider {
  position: relative;
  padding: 6px 0 0;
}

.gs-font-slider-input {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 28px;
  background: transparent;
  cursor: pointer;
  margin: 0;
}

.gs-font-slider-input:focus {
  outline: none;
}

.gs-font-slider-input::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    var(--app-accent) 0%,
    var(--app-accent) var(--gs-font-slider-progress, 50%),
    rgba(148, 163, 184, 0.28) var(--gs-font-slider-progress, 50%),
    rgba(148, 163, 184, 0.28) 100%
  );
}

.gs-font-slider-input::-moz-range-track {
  height: 4px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.28);
}

.gs-font-slider-input::-moz-range-progress {
  height: 4px;
  border-radius: 999px;
  background: var(--app-accent);
}

.gs-font-slider-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  margin-top: -7px;
  border-radius: 999px;
  background: #fff;
  border: 1px solid rgba(148, 163, 184, 0.4);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.22);
  transition: transform 0.12s ease;
}

.gs-font-slider-input:hover::-webkit-slider-thumb {
  transform: scale(1.08);
}

.gs-font-slider-input::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: #fff;
  border: 1px solid rgba(148, 163, 184, 0.4);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.22);
}

.gs-font-slider-input:disabled {
  opacity: 0.6;
  cursor: default;
}

/* Tick marks sit on the track; labels hang below. Only the recommended points
   (14/16/18) get a label. */
.gs-font-slider-ticks {
  position: relative;
  height: 0;
  margin-top: 2px;
}

.gs-font-slider-tick {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  pointer-events: none;
}

.gs-font-slider-tick-mark {
  width: 2px;
  height: 7px;
  border-radius: 1px;
  background: rgba(148, 163, 184, 0.5);
  transition: background 0.12s ease;
}

.gs-font-slider-tick.active .gs-font-slider-tick-mark {
  background: var(--app-accent);
}

.gs-font-slider-tick-label {
  font-size: 0.74em;
  color: var(--app-text-muted);
  white-space: nowrap;
}

.gs-font-slider-tick.active .gs-font-slider-tick-label {
  color: var(--app-accent);
  font-weight: 600;
}

.gs-font-slider-scale {
  display: flex;
  justify-content: space-between;
  margin-top: 22px;
  font-size: 0.72em;
  color: var(--app-text-faint);
  font-variant-numeric: tabular-nums;
}
</style>

<!-- Non-scoped: the font dropdown is Teleport-ed to <body>, so these rules must
     not be scoped or they would not match the teleported nodes. Class names are
     prefixed (gs-font-*) to avoid collisions. -->
<style>
.gs-font-backdrop {
  position: fixed;
  inset: 0;
  z-index: calc(var(--multi-select-panel-z-index, 10000) - 1);
}

.gs-font-panel {
  z-index: var(--multi-select-panel-z-index, 10000);
  display: flex;
  flex-direction: column;
  max-height: 320px;
  overflow: hidden;
  border: 1px solid var(--app-border-strong);
  border-radius: 14px;
  background: var(--app-panel-strong);
  box-shadow: var(--app-shadow);
}

.gs-font-search {
  margin: 8px;
  padding: 8px 10px;
  border: 1px solid var(--app-input-border);
  border-radius: 10px;
  background: var(--app-input-bg);
  color: var(--app-text);
  font-size: 0.88em;
  outline: none;
}

.gs-font-search:focus {
  border-color: var(--app-accent-glow);
}

.gs-font-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 8px 8px;
  overflow-y: auto;
}

.gs-font-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--app-text);
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}

.gs-font-item:hover {
  background: var(--app-panel-muted);
}

.gs-font-item.active {
  background: rgba(94, 123, 255, 0.16);
}

.gs-font-item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.9em;
}

.gs-font-item-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.gs-font-item-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.72em;
  color: var(--app-text-faint);
  line-height: 1.2;
}

.gs-font-item-default {
  color: var(--app-text-muted);
  font-style: italic;
}

.gs-font-status {
  padding: 12px;
  color: var(--app-text-muted);
  font-size: 0.84em;
  text-align: center;
}
</style>
