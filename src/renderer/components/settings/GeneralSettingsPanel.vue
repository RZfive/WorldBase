<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { loadAIExecutionPreferences, persistAIExecutionPreferences } from '../../utils/ai-execution-preferences'
import type { ThemePreference } from '../../utils/theme'
import { applyThemePreference, resolveThemePreference, watchSystemThemeChange } from '../../utils/theme'

type GeneralSectionId = 'appearance' | 'execution' | 'transfer'

interface ThemeOption {
  id: ThemePreference
  label: string
  description: string
  previewTone: 'light' | 'dark' | 'system'
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

const themeOptions: ThemeOption[] = [
  {
    id: 'system',
    label: '跟随系统',
    description: '自动匹配当前系统外观，适合在不同工作环境间切换。',
    previewTone: 'system'
  },
  {
    id: 'light',
    label: '浅色模式',
    description: '层次更清晰，适合白天或长时间阅读。',
    previewTone: 'light'
  },
  {
    id: 'dark',
    label: '深色模式',
    description: '更聚焦，适合夜间或低亮环境。',
    previewTone: 'dark'
  }
]

const activeSectionId = ref<GeneralSectionId>('appearance')
const themePreference = ref<ThemePreference>('system')
const executionPreferences = ref<AIExecutionPreferences>({
  notifyOnTaskComplete: true,
  enableAiLogging: false
})
const savingTheme = ref(false)
const savingExecution = ref(false)
const exporting = ref(false)
const importing = ref(false)
const feedback = ref('')

let stopThemeWatcher: (() => void) | null = null

const currentThemeOption = computed(() => {
  return themeOptions.find(option => option.id === themePreference.value) || themeOptions[0]
})

const effectiveThemeLabel = computed(() => {
  const resolved = resolveThemePreference(themePreference.value)
  return resolved === 'dark' ? '当前实际为深色' : '当前实际为浅色'
})

const sections = computed<GeneralSection[]>(() => {
  const themeSummary = currentThemeOption.value.label
  const executionSummary = executionPreferences.value.notifyOnTaskComplete ? '系统通知已开启' : '系统通知已关闭'
  const transferSummary = exporting.value
    ? '正在导出配置包'
    : importing.value
      ? '正在导入配置包'
      : '导入与导出加密配置'

  return [
    {
      id: 'appearance',
      icon: '◐',
      label: '显示设置',
      summary: themeSummary,
      status: effectiveThemeLabel.value,
      title: '显示设置',
      description: '切换浅色、深色与跟随系统，并立即预览界面外观。'
    },
    {
      id: 'execution',
      icon: '◎',
      label: '执行通知',
      summary: executionSummary,
      status: '授权模式已移到聊天顶部',
      title: '执行通知',
      description: '这里只保留任务结束提醒，日志开关已迁移到日志中心。'
    },
    {
      id: 'transfer',
      icon: '⇄',
      label: '配置迁移',
      summary: transferSummary,
      status: '配置包使用应用私有格式加密',
      title: '配置迁移',
      description: '导出或导入通用配置快照，适合在多台设备间同步设置。'
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
    setFeedback('主题偏好已保存')
  } catch (err) {
    themePreference.value = previousPreference
    applyThemePreference(previousPreference)
    setFeedback(`保存失败：${(err as Error).message}`)
  } finally {
    savingTheme.value = false
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
    setFeedback('通知偏好已保存')
  } catch (err) {
    executionPreferences.value = {
      ...executionPreferences.value,
      notifyOnTaskComplete: previousValue
    }
    setFeedback(`保存失败：${(err as Error).message}`)
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
    setFeedback(result.success ? `配置已导出到 ${result.filePath || '目标文件'}` : '配置导出未完成')
  } catch (error) {
    setFeedback(`导出失败：${(error as Error).message}`)
  } finally {
    exporting.value = false
  }
}

async function importConfig () {
  if (!window.electronAPI?.importAppConfig || exporting.value || importing.value) return
  if (!window.confirm('导入会覆盖当前本地配置，并在完成后刷新当前窗口。是否继续？')) return

  importing.value = true
  feedback.value = ''
  try {
    const result = await window.electronAPI.importAppConfig()
    if (result.canceled) return
    setFeedback('配置已导入，正在刷新窗口…')
    if (result.requiresReload) {
      window.setTimeout(() => {
        window.location.reload()
      }, 500)
    }
  } catch (error) {
    setFeedback(`导入失败：${(error as Error).message}`)
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
                <span v-if="themePreference === option.id" class="gs-theme-badge">当前使用</span>
              </div>
              <div class="gs-theme-card-body">
                <span class="gs-theme-label">{{ option.label }}</span>
                <span class="gs-theme-hint">{{ option.description }}</span>
              </div>
            </button>
          </div>
        </template>

        <template v-else-if="activeSectionId === 'execution'">
          <section class="gs-control-card">
            <div class="gs-control-copy">
              <span class="gs-control-title">任务结束后发送系统通知</span>
              <p class="gs-control-hint">任务完成、失败或被停止时，通知中心会显示任务名称和状态，适合后台执行场景。</p>
            </div>
            <button
              type="button"
              class="gs-switch-row"
              :disabled="savingExecution"
              role="switch"
              :aria-checked="executionPreferences.notifyOnTaskComplete"
              :aria-label="executionPreferences.notifyOnTaskComplete ? '关闭任务结束通知' : '开启任务结束通知'"
              @click="toggleTaskNotificationPreference"
            >
              <span class="gs-switch-track" :class="{ on: executionPreferences.notifyOnTaskComplete }">
                <span class="gs-switch-thumb" />
              </span>
            </button>
          </section>
        </template>

        <template v-else>

          <div class="gs-transfer-grid">
            <button class="gs-transfer-card primary" :disabled="exporting || importing" @click="exportConfig">
              <span class="gs-transfer-kicker">Export</span>
              <strong class="gs-transfer-title">导出加密配置</strong>
              <p class="gs-transfer-text">把当前本地设置打包为可迁移配置文件。</p>
              <span class="gs-transfer-action">{{ exporting ? '正在导出…' : '开始导出' }}</span>
            </button>

            <button class="gs-transfer-card secondary" :disabled="exporting || importing" @click="importConfig">
              <span class="gs-transfer-kicker">Import</span>
              <strong class="gs-transfer-title">导入加密配置</strong>
              <p class="gs-transfer-text">覆盖本地设置并刷新窗口，快速同步到当前设备。</p>
              <span class="gs-transfer-action">{{ importing ? '正在导入…' : '开始导入' }}</span>
            </button>
          </div>

          <div class="gs-note-grid">
            <article class="gs-note-card">
              <span class="gs-note-title">包含内容</span>
              <p>模型服务配置、模型定价、主题偏好、任务通知、启动台布局、网页快捷方式，以及项目打开方式偏好。</p>
            </article>
            <article class="gs-note-card">
              <span class="gs-note-title">不会导入</span>
              <p>聊天记录、项目源码和文档工作台里的已导入文件不会被带入目标设备。</p>
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
