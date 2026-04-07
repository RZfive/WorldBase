<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import type { ChatMessageBlock } from './types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'file_preview' }>
}>()

const previewBodyRef = ref<HTMLElement | null>(null)

watch(
  () => props.block.previewContent,
  () => {
    nextTick(() => {
      if (previewBodyRef.value) {
        previewBodyRef.value.scrollTop = previewBodyRef.value.scrollHeight
      }
    })
  }
)
</script>

<template>
  <div
    class="message-event-card file-preview-panel"
    :class="{ active: props.block.active }"
  >
    <div class="file-preview-header">
      <span class="file-preview-label">正在生成</span>
      <span class="file-preview-path">{{ props.block.filePath }}</span>
      <span v-if="props.block.truncated" class="file-preview-truncated">预览已截断</span>
    </div>
    <pre ref="previewBodyRef" class="file-preview-body">{{ props.block.previewContent }}</pre>
  </div>
</template>

<style scoped>
.message-event-card {
  width: min(100%, 760px);
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);
  overflow: hidden;
}

.file-preview-panel {
  border: 1px solid var(--app-border-strong);
  border-radius: 14px;
  background: var(--app-panel);
  overflow: hidden;
}

.file-preview-panel.active {
  border-color: var(--app-accent-glow);
}

.file-preview-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--app-border-strong);
  background: var(--app-panel-muted);
  font-size: 0.78rem;
  color: var(--app-text-soft);
}

.file-preview-label {
  color: var(--app-text-muted);
  flex-shrink: 0;
}

.file-preview-path {
  font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-preview-truncated {
  margin-left: auto;
  color: #d97706;
  flex-shrink: 0;
}

.file-preview-body {
  margin: 0;
  padding: 12px 14px;
  background: var(--app-panel-strong);
  color: var(--app-text-soft);
  font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
  font-size: 0.83rem;
  line-height: 1.45;
  max-height: calc(1.45em * 6 + 28px);
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-width: thin;
}
</style>
