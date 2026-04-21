<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { loadAIExecutionPreferences, persistAIExecutionPreferences } from '../../utils/ai-execution-preferences'

const FEEDBACK_DISPLAY_DURATION_MS = 1800
const executionPreferences = ref<AIExecutionPreferences>({
  notifyOnTaskComplete: true,
  enableAiLogging: false
})
const loading = ref(true)
const saving = ref(false)
const feedback = ref('')

async function loadPreferences () {
  loading.value = true
  try {
    executionPreferences.value = await loadAIExecutionPreferences()
  } catch {
    executionPreferences.value = {
      notifyOnTaskComplete: true,
      enableAiLogging: false
    }
  } finally {
    loading.value = false
  }
}

async function savePreferences (notifyOnTaskComplete: boolean) {
  if (saving.value) return

  const previousNotifyOnTaskComplete = executionPreferences.value.notifyOnTaskComplete
  executionPreferences.value = {
    ...executionPreferences.value,
    notifyOnTaskComplete
  }

  saving.value = true
  feedback.value = ''

  try {
    await persistAIExecutionPreferences(executionPreferences.value)
    feedback.value = '通知偏好已保存'
  } catch (err) {
    executionPreferences.value = {
      ...executionPreferences.value,
      notifyOnTaskComplete: previousNotifyOnTaskComplete
    }
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
      <h3 class="ep-title">任务通知</h3>
      <p class="ep-desc">这里只保留任务结束后的系统通知。AI 日志开关已移到“日志中心”。</p>
      <span v-if="feedback" class="ep-feedback">{{ feedback }}</span>
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
          :checked="executionPreferences.notifyOnTaskComplete"
          :disabled="loading || saving"
          @change="savePreferences(($event.target as HTMLInputElement).checked)"
        >
      </label>

      <div class="ep-separator" />

      <div class="ep-note">
        <span class="ep-note-title">说明</span>
        <p>每个对话都可以在聊天窗口顶部单独切换严格授权或自动执行，不再共享全局授权模式。日志记录请到“日志中心”管理。</p>
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
