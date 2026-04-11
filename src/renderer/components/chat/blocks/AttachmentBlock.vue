<script setup lang="ts">
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'attachment' }>
}>()
</script>

<template>
  <div class="message-event-card attachment-card">
    <div class="attachment-card-header">
      <span class="attachment-card-icon">📎</span>
      <div class="attachment-card-meta">
        <div class="attachment-card-name">{{ props.block.fileName }}</div>
        <div class="attachment-card-detail">{{ props.block.fileType.toUpperCase() }} · {{ props.block.fileSizeLabel }}</div>
      </div>
    </div>
    <div v-if="props.block.previewText" class="attachment-card-preview">{{ props.block.previewText }}</div>
  </div>
</template>

<style scoped>
.message-event-card {
  width: min(100%, var(--chat-event-card-max, 1080px));
  border: 1px solid var(--app-border-strong);
  border-radius: 18px;
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);
  overflow: hidden;
}

.attachment-card {
  padding: 14px 16px;
}

.attachment-card-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.attachment-card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  background: var(--app-accent-soft);
  flex-shrink: 0;
}

.attachment-card-meta {
  min-width: 0;
}

.attachment-card-name {
  color: var(--app-text-strong);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.attachment-card-detail {
  font-size: 0.78rem;
  color: var(--app-text-muted);
}

.attachment-card-preview {
  margin-top: 10px;
  color: var(--app-text-soft);
  font-size: 0.86rem;
  line-height: 1.6;
  word-break: break-word;
}
</style>
