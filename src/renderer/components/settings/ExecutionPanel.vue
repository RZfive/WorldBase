<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

type AIExecutionAuthMode = 'strict' | 'auto'

interface ExecutionModeOption {
  id: AIExecutionAuthMode
  label: string
  description: string
  icon: string
}

const FEEDBACK_DISPLAY_DURATION_MS = 1800

const modeOptions: ExecutionModeOption[] = [
  {
    id: 'strict',
    label: '严格模式',
    description: '每次读取本地文件、写入文件或执行命令时，都需要你手动授权。',
    icon: '🛡️'
  },
  {
    id: 'auto',
    label: '自动执行',
    description: 'AI 会自动通过授权卡片并继续执行，适合你确认环境安全后的连续任务。',
    icon: '⚡'
  }
]

const authMode = ref<AIExecutionAuthMode>('strict')
const notifyOnTaskComplete = ref(true)
const loading = ref(true)
const saving = ref(false)
const feedback = ref('')

const selectedModeDescription = computed(() => {
  return modeOptions.find(option => option.id === authMode.value)?.description || ''
})

async function loadPreferences () {
  loading.value = true
  try {
    const preferences = await window.electronAPI?.getAIExecutionPreferences?.()
    authMode.value = preferences?.authMode === 'auto' ? 'auto' : 'strict'
    notifyOnTaskComplete.value = preferences?.notifyOnTaskComplete ?? true
  } catch {
    authMode.value = 'strict'
    notifyOnTaskComplete.value = true
  } finally {
    loading.value = false
  }
}

async function savePreferences (next: { authMode?: AIExecutionAuthMode; notifyOnTaskComplete?: boolean }) {
  if (!window.electronAPI?.saveAIExecutionPreferences || saving.value) return

  const previous = {
    authMode: authMode.value,
    notifyOnTaskComplete: notifyOnTaskComplete.value
  }

  if (next.authMode !== undefined) authMode.value = next.authMode
  if (next.notifyOnTaskComplete !== undefined) notifyOnTaskComplete.value = next.notifyOnTaskComplete

  saving.value = true
  feedback.value = ''

  try {
    await window.electronAPI.saveAIExecutionPreferences({
      authMode: authMode.value,
      notifyOnTaskComplete: notifyOnTaskComplete.value
    })
    feedback.value = '执行偏好已保存'
  } catch (err) {
    authMode.value = previous.authMode
    notifyOnTaskComplete.value = previous.notifyOnTaskComplete
    feedback.value = `保存失败：${(err as Error).message}`
  } finally {
    saving.value = false
    window.setTimeout(() => {
      feedback.value = ''
    }, FEEDBACK_DISPLAY_DURATION_MS)
  }
}

onMounted(async () => {
  await loadPreferences()
})
</script>

<template>
  <div class="ep-root">
    <div class="ep-header">
      <h3 class="ep-title">AI 执行授权</h3>
      <p class="ep-desc">选择本地敏感操作的授权方式，并决定任务完成后是否发送系统通知。</p>
      <span v-if="feedback" class="ep-feedback">{{ feedback }}</span>
    </div>

    <div class="ep-separator" />

    <div class="ep-list" :aria-busy="loading">
      <button
        v-for="option in modeOptions"
        :key="option.id"
        :class="['ep-item', { active: authMode === option.id }]"
        :disabled="loading || saving"
        @click="savePreferences({ authMode: option.id })"
      >
        <div class="ep-item-left">
          <span class="ep-item-icon">{{ option.icon }}</span>
          <div class="ep-item-text">
            <span class="ep-item-label">{{ option.label }}</span>
            <span class="ep-item-hint">{{ option.description }}</span>
          </div>
        </div>
        <span v-if="authMode === option.id" class="ep-check">✓</span>
      </button>
    </div>

    <div class="ep-separator" />

    <label class="ep-toggle">
      <div class="ep-toggle-copy">
        <span class="ep-toggle-title">任务结束后发送系统通知</span>
        <span class="ep-toggle-hint">通知中心会显示任务名称和当前状态，适合后台执行时提醒你查看结果。</span>
      </div>
      <input
        type="checkbox"
        class="ep-toggle-input"
        :checked="notifyOnTaskComplete"
        :disabled="loading || saving"
        @change="savePreferences({ notifyOnTaskComplete: ($event.target as HTMLInputElement).checked })"
      >
    </label>

    <div class="ep-separator" />

    <div class="ep-note">
      <span class="ep-note-title">当前模式</span>
      <p>{{ selectedModeDescription }}</p>
    </div>
  </div>
</template>

<style scoped>
.ep-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 20px 28px;
  overflow-y: auto;
  color: var(--app-text);
}

.ep-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ep-title {
  margin: 0;
  font-size: 1.1em;
  color: var(--app-text-strong);
}

.ep-desc {
  margin: 0;
  font-size: 0.85em;
  color: var(--app-text-muted);
}

.ep-feedback {
  font-size: 0.8em;
  color: var(--app-accent);
  margin-top: 2px;
}

.ep-separator {
  height: 1px;
  background: var(--app-border);
  margin: 16px 0;
}

.ep-list {
  display: flex;
  flex-direction: column;
}

.ep-item {
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

.ep-item:last-child {
  border-bottom: none;
}

.ep-item:hover:not(:disabled),
.ep-item.active {
  background: var(--app-panel-muted);
}

.ep-item:disabled {
  cursor: default;
  opacity: 0.7;
}

.ep-item-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ep-item-icon {
  width: 32px;
  text-align: center;
  font-size: 1.25em;
  flex-shrink: 0;
}

.ep-item-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ep-item-label {
  font-size: 0.92em;
  font-weight: 500;
  color: var(--app-text);
}

.ep-item-hint {
  font-size: 0.78em;
  color: var(--app-text-faint);
}

.ep-check {
  font-size: 1em;
  color: var(--app-accent);
  font-weight: 600;
  flex-shrink: 0;
  margin-right: 4px;
}

.ep-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.ep-toggle-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ep-toggle-title {
  font-size: 0.92em;
  font-weight: 500;
  color: var(--app-text);
}

.ep-toggle-hint {
  font-size: 0.78em;
  color: var(--app-text-faint);
  line-height: 1.5;
}

.ep-toggle-input {
  width: 18px;
  height: 18px;
  accent-color: var(--app-accent);
  flex-shrink: 0;
}

.ep-note {
  font-size: 0.82em;
  color: var(--app-text-muted);
  line-height: 1.5;
}

.ep-note-title {
  font-weight: 600;
  color: var(--app-text-soft);
  margin-bottom: 4px;
  display: block;
}

.ep-note p {
  margin: 0;
}
</style>
