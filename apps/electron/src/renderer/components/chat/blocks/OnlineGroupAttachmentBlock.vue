<script setup lang="ts">
import { ref } from 'vue'
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'online_group_attachment' }>
}>()

const downloading = ref(false)
const error = ref('')

function formatSize (bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function download (): Promise<void> {
  if (downloading.value || !window.electronAPI?.readOnlineGroupAttachment) return
  downloading.value = true
  error.value = ''
  try {
    const data = await window.electronAPI.readOnlineGroupAttachment(props.block.groupId, props.block.attachment.id)
    const binary = atob(data.dataBase64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const url = URL.createObjectURL(new Blob([bytes], { type: data.mimeType }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = data.name
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    downloading.value = false
  }
}
</script>

<template>
  <div class="online-attachment-block">
    <button class="online-attachment-card" type="button" :disabled="downloading" @click="download">
      <span class="online-attachment-icon" aria-hidden="true">📎</span>
      <span class="online-attachment-copy">
        <strong>{{ block.attachment.name }}</strong>
        <small>{{ formatSize(block.attachment.size) }} · {{ downloading ? $t('onlineGroups.downloading') : $t('onlineGroups.download') }}</small>
      </span>
    </button>
    <p v-if="error" class="online-attachment-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.online-attachment-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.online-attachment-card {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  max-width: 360px;
  padding: 9px 11px;
  border: 1px solid var(--app-border);
  border-radius: 11px;
  background: var(--app-panel);
  color: var(--app-text);
  text-align: left;
  cursor: pointer;
}
.online-attachment-card:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--app-accent) 44%, var(--app-border));
  background: var(--app-accent-soft);
}
.online-attachment-card:disabled {
  opacity: 0.65;
  cursor: wait;
}
.online-attachment-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: 9px;
  background: var(--app-panel-muted);
}
.online-attachment-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.online-attachment-copy strong {
  overflow: hidden;
  font-size: 0.8em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.online-attachment-copy small {
  color: var(--app-text-faint);
  font-size: 0.68em;
}
.online-attachment-error {
  margin: 0;
  color: var(--app-danger);
  font-size: 0.72em;
}
</style>
