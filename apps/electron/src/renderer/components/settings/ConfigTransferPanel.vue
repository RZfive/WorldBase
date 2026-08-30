<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const FEEDBACK_DISPLAY_DURATION_MS = 2200
const { t } = useI18n()

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
    setFeedback(result.success
      ? t('settings.configTransferPanel.exportDone', { path: result.filePath || t('settings.configTransferPanel.targetFile') })
      : t('settings.configTransferPanel.exportIncomplete'))
  } catch (error) {
    setFeedback(t('settings.configTransferPanel.exportFailed', { message: (error as Error).message }))
  } finally {
    exporting.value = false
  }
}

async function importConfig () {
  if (!window.electronAPI?.importAppConfig || exporting.value || importing.value) return
  if (!window.confirm(t('settings.configTransferPanel.importConfirm'))) return

  importing.value = true
  feedback.value = ''
  try {
    const result = await window.electronAPI.importAppConfig()
    if (result.canceled) return
    setFeedback(t('settings.configTransferPanel.importDone'))
    if (result.requiresReload) {
      window.setTimeout(() => {
        window.location.reload()
      }, 500)
    }
  } catch (error) {
    setFeedback(t('settings.configTransferPanel.importFailed', { message: (error as Error).message }))
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <div class="ctp-root">
    <div class="ctp-header">
      <h3 class="ctp-title">{{ $t('settings.configTransferPanel.title') }}</h3>
      <p class="ctp-desc">{{ $t('settings.configTransferPanel.description') }}</p>
      <span v-if="feedback" class="ctp-feedback">{{ feedback }}</span>
    </div>

    <div class="ctp-separator" />

    <div class="ctp-actions">
      <button class="ctp-primary" :disabled="exporting || importing" @click="exportConfig">
        {{ exporting ? $t('settings.configTransferPanel.exportActionBusy') : $t('settings.configTransferPanel.exportAction') }}
      </button>
      <button class="ctp-secondary" :disabled="exporting || importing" @click="importConfig">
        {{ importing ? $t('settings.configTransferPanel.importActionBusy') : $t('settings.configTransferPanel.importAction') }}
      </button>
    </div>

    <div class="ctp-separator" />

    <div class="ctp-note">
      <span class="ctp-note-title">{{ $t('settings.configTransferPanel.includedTitle') }}</span>
      <p>{{ $t('settings.configTransferPanel.includedText') }}</p>
    </div>

    <div class="ctp-note">
      <span class="ctp-note-title">{{ $t('settings.configTransferPanel.noteTitle') }}</span>
      <p>{{ $t('settings.configTransferPanel.noteText') }}</p>
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
