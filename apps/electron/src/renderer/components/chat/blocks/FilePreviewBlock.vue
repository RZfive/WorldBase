<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'file_preview' }>
}>()

const { t } = useI18n()

const fileName = computed(() => {
  const segments = props.block.filePath.split(/[\\/]/)
  return segments[segments.length - 1] || props.block.filePath
})

const hasDelta = computed(() => props.block.added > 0 || props.block.removed > 0)

const changeLabel = computed(() => {
  if (hasDelta.value) {
    return [
      props.block.added > 0 ? `+${props.block.added}` : '',
      props.block.removed > 0 ? `-${props.block.removed}` : ''
    ].filter(Boolean).join(' ')
  }
  if (props.block.lineCount > 0) return t('chatUi.lineCount', { count: props.block.lineCount })
  return ''
})

// The whole row is the open affordance; while the write is still streaming
// the file is not ready to view, so the row stays inert.
const openTargetPath = computed(() => props.block.active ? null : props.block.filePath)
</script>

<template>
  <button
    type="button"
    class="file-preview-row"
    :class="[props.block.active ? 'running' : 'completed']"
    :title="`${props.block.filePath} · ${$t('chatUi.clickToOpenHint')}`"
    :data-file-path="openTargetPath"
    :disabled="props.block.active"
  >
    <span class="fp-dot" aria-hidden="true" />
    <span class="fp-title">{{ props.block.active ? $t('chatUi.filePreviewWriting') : $t('chatUi.filePreviewWritten') }}</span>
    <span v-if="changeLabel" class="fp-meta">{{ changeLabel }}</span>
    <span class="fp-detail">{{ fileName }}</span>
    <span class="fp-open" aria-hidden="true">↗</span>
  </button>
</template>

<style scoped>
.file-preview-row {
  box-sizing: border-box;
  width: min(100%, var(--chat-event-card-max, 1080px));
  max-width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  padding: 6px 9px;
  border: 1px solid color-mix(in srgb, var(--app-border) 62%, transparent);
  border-radius: 9px;
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
  font: inherit;
  font-size: 0.78em;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
}

.file-preview-row:disabled { cursor: default; }
.file-preview-row:hover:not(:disabled) {
  border-color: var(--app-border-strong);
  background: color-mix(in srgb, var(--app-panel) 78%, transparent);
}
.file-preview-row:hover:not(:disabled) .fp-detail,
.file-preview-row:focus-visible .fp-detail { color: var(--app-accent); text-decoration: underline; }

.fp-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  flex: 0 0 auto;
  background: var(--app-border-strong);
}
.file-preview-row.running .fp-dot {
  background: var(--app-accent);
  animation: fp-dot-pulse 1.15s ease-in-out infinite;
}
.file-preview-row.completed .fp-dot { background: var(--app-success); }

@keyframes fp-dot-pulse {
  0%, 100% { transform: scale(0.85); opacity: 0.7; }
  50% { transform: scale(1.2); opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .file-preview-row.running .fp-dot {
    animation: none;
  }
}

.fp-title {
  flex: 0 0 auto;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-text-strong);
  font-weight: 600;
}

.fp-meta {
  flex: 0 0 auto;
  color: var(--app-text-muted);
  white-space: nowrap;
  font-family: 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
}
.fp-meta::before { content: '·'; margin-right: 7px; }
.fp-meta:empty { display: none; }

.fp-detail {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-text-muted);
}

.fp-open {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--app-text-faint);
  font-size: 1.05em;
  opacity: 0.75;
}
.file-preview-row:hover:not(:disabled) .fp-open { opacity: 1; color: var(--app-accent); }
</style>
