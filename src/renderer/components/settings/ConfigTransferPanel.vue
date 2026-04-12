<script setup lang="ts">
import { ref } from 'vue'

const FEEDBACK_DISPLAY_DURATION_MS = 2200

const exporting = ref(false)
const importing = ref(false)
const feedback = ref('')

function setFeedback (message: string) {
  feedback.value = message
  window.setTimeout(() => {
    if (feedback.value === message) {
      feedback.value = ''
    }
  }, FEEDBACK_DISPLAY_DURATION_MS)
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
</script>

<template>
  <div class="ctp-root">
    <div class="ctp-header">
      <h3 class="ctp-title">配置迁移</h3>
      <p class="ctp-desc">快速复制当前基座配置。导出的配置包不是明文 JSON，内容会被应用私有格式加密后保存。</p>
      <span v-if="feedback" class="ctp-feedback">{{ feedback }}</span>
    </div>

    <div class="ctp-separator" />

    <div class="ctp-actions">
      <button class="ctp-primary" :disabled="exporting || importing" @click="exportConfig">
        {{ exporting ? '正在导出…' : '导出加密配置' }}
      </button>
      <button class="ctp-secondary" :disabled="exporting || importing" @click="importConfig">
        {{ importing ? '正在导入…' : '导入加密配置' }}
      </button>
    </div>

    <div class="ctp-separator" />

    <div class="ctp-note">
      <span class="ctp-note-title">包含内容</span>
      <p>模型服务配置、主题偏好、执行通知、启动台布局、网页快捷方式，以及项目打开方式偏好。</p>
    </div>

    <div class="ctp-note">
      <span class="ctp-note-title">说明</span>
      <p>导入会覆盖当前本地配置，不会导入聊天记录、项目源码或文档工作台里的已导入文件。</p>
    </div>
  </div>
</template>

<style scoped>
.ctp-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 20px 28px;
  overflow-y: auto;
  color: var(--app-text);
}

.ctp-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ctp-title {
  margin: 0;
  font-size: 1.1em;
  color: var(--app-text-strong);
}

.ctp-desc {
  margin: 0;
  font-size: 0.85em;
  color: var(--app-text-muted);
  line-height: 1.6;
}

.ctp-feedback {
  font-size: 0.8em;
  color: var(--app-accent);
  margin-top: 2px;
}

.ctp-separator {
  height: 1px;
  background: var(--app-border);
  margin: 16px 0;
}

.ctp-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.ctp-primary,
.ctp-secondary {
  min-width: 160px;
  padding: 10px 16px;
  border-radius: 10px;
  border: 1px solid var(--app-border);
  cursor: pointer;
  font-size: 0.86em;
  transition: transform 0.12s, background 0.12s, border-color 0.12s;
}

.ctp-primary {
  background: var(--app-accent);
  color: #fff;
  border-color: transparent;
}

.ctp-primary:hover:not(:disabled) {
  transform: translateY(-1px);
  background: var(--app-accent-strong);
}

.ctp-secondary {
  background: var(--app-panel-subtle);
  color: var(--app-text);
}

.ctp-secondary:hover:not(:disabled) {
  transform: translateY(-1px);
  background: var(--app-panel-muted);
}

.ctp-primary:disabled,
.ctp-secondary:disabled {
  opacity: 0.65;
  cursor: default;
  transform: none;
}

.ctp-note {
  font-size: 0.82em;
  color: var(--app-text-muted);
  line-height: 1.6;
  margin-bottom: 14px;
}

.ctp-note-title {
  font-weight: 600;
  color: var(--app-text-soft);
  margin-bottom: 4px;
  display: block;
}

.ctp-note p {
  margin: 0;
}
</style>