<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ChatMessageBlock } from '../types'
import ExecutionDisclosure from './ExecutionDisclosure.vue'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'file_preview' }>
}>()

const { t } = useI18n()

const fileName = computed(() => {
  const segments = props.block.filePath.split('/')
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
</script>

<template>
  <ExecutionDisclosure
    :title="props.block.active ? $t('chatUi.filePreviewWriting') : $t('chatUi.filePreviewWritten')"
    :meta="changeLabel"
    :detail="fileName"
    :status="props.block.active ? 'running' : 'completed'"
  >
    <div class="file-write-detail">
      <div class="fw-path" :title="props.block.filePath">{{ props.block.filePath }}</div>
      <div class="fw-stat">
      <template v-if="hasDelta">
        <span v-if="props.block.added > 0" class="fw-add">+{{ props.block.added }}</span>
        <span v-if="props.block.removed > 0" class="fw-del">-{{ props.block.removed }}</span>
      </template>
      <span v-else-if="props.block.lineCount > 0" class="fw-lines">{{ $t('chatUi.lineCount', { count: props.block.lineCount }) }}</span>
      </div>
    </div>
  </ExecutionDisclosure>
</template>

<style scoped>
.file-write-detail {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.78em;
  color: var(--app-text-soft);
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
