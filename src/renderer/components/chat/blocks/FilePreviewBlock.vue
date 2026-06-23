<script setup lang="ts">
import { computed } from 'vue'
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'file_preview' }>
}>()

const fileName = computed(() => {
  const segments = props.block.filePath.split('/')
  return segments[segments.length - 1] || props.block.filePath
})

const hasDelta = computed(() => props.block.added > 0 || props.block.removed > 0)
</script>

<template>
  <div class="file-write-row" :class="{ active: props.block.active }">
    <span class="fw-icon">{{ props.block.active ? '✏️' : '📄' }}</span>
    <span class="fw-label">{{ props.block.active ? $t('chatUi.filePreviewWriting') : $t('chatUi.filePreviewWritten') }}</span>
    <span class="fw-path" :title="props.block.filePath">{{ fileName }}</span>
    <span class="fw-stat">
      <template v-if="hasDelta">
        <span v-if="props.block.added > 0" class="fw-add">+{{ props.block.added }}</span>
        <span v-if="props.block.removed > 0" class="fw-del">-{{ props.block.removed }}</span>
      </template>
      <span v-else-if="props.block.lineCount > 0" class="fw-lines">{{ $t('chatUi.lineCount', { count: props.block.lineCount }) }}</span>
    </span>
  </div>
</template>

<style scoped>
.file-write-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: min(100%, var(--chat-event-card-max, 1080px));
  padding: 6px 12px;
  border: 1px solid var(--app-border-strong);
  border-radius: 10px;
  background: var(--app-panel);
  font-size: 0.8em;
  color: var(--app-text-soft);
}

.file-write-row.active {
  border-color: var(--app-accent-glow);
}

.fw-icon {
  flex-shrink: 0;
}

.fw-label {
  color: var(--app-text-muted);
  flex-shrink: 0;
}

.fw-path {
  font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fw-stat {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
}

.fw-add {
  color: #16a34a;
}

.fw-del {
  color: #dc2626;
}

.fw-lines {
  color: var(--app-text-muted);
}
</style>
