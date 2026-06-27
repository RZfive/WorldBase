<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ImageStudioTask } from '../../../shared/image-studio-types'

const props = defineProps<{
  tasks: ImageStudioTask[]
}>()

const emit = defineEmits<{
  (e: 'open', task: ImageStudioTask): void
  (e: 'remove', id: string): void
  (e: 'retry', id: string): void
  (e: 'clearFinished'): void
}>()

const hasFinished = computed(() => props.tasks.some(t => t.status === 'success' || t.status === 'error'))
const { t } = useI18n()

function statusLabel (status: ImageStudioTask['status']): string {
  switch (status) {
    case 'queued': return t('studioUi.statusQueued')
    case 'running': return t('studioUi.statusRunning')
    case 'success': return t('studioUi.statusSuccess')
    case 'error': return t('studioUi.statusError')
  }
}

function taskEntryThumbSrc (task: ImageStudioTask): string {
  const entry = task.entries[0]
  return entry?.thumbUrl || entry?.fullUrl || entry?.dataUrl || ''
}
</script>

<template>
  <div class="queue">
    <header class="queue-header">
      <span class="queue-title">{{ $t('studioUi.taskQueue') }}</span>
      <button v-if="hasFinished" class="queue-clear" type="button" @click="emit('clearFinished')">{{ $t('studioUi.clearFinished') }}</button>
    </header>

    <p v-if="tasks.length === 0" class="queue-empty">{{ $t('studioUi.emptyQueue') }}</p>

    <ul v-else class="queue-list">
      <li
        v-for="task in tasks"
        :key="task.id"
        class="queue-item"
        :class="`is-${task.status}`"
        @click="emit('open', task)"
      >
        <img v-if="task.inputPreview" :src="task.inputPreview" class="queue-thumb" alt="" />
        <img v-else-if="task.entries[0]" :src="taskEntryThumbSrc(task)" class="queue-thumb" alt="" />
        <span v-else class="queue-thumb queue-thumb-placeholder">{{ task.request.mode === 'edit' ? '✎' : '🎨' }}</span>

        <div class="queue-body">
          <span class="queue-label" :title="task.label">{{ task.label || $t('studioUi.noPrompt') }}</span>
          <span class="queue-status" :class="`status-${task.status}`">
            <span v-if="task.createdByAgent" class="queue-agent-tag" :title="$t('studioUi.createdByAi')">AI</span>
            <span v-if="task.status === 'running'" class="queue-spinner">⏳</span>
            {{ task.request.mode === 'edit' ? $t('studioUi.editModeShort') : $t('studioUi.generateModeShort') }} · {{ statusLabel(task.status) }}
          </span>
          <span
            v-if="task.status === 'error' && task.error"
            class="queue-error"
            :title="task.error"
            @click.stop="emit('open', task)"
          >{{ task.error }}</span>
        </div>

        <button
          v-if="task.status === 'error'"
          class="queue-icon-btn"
          type="button"
          :title="$t('common.retry')"
          @click.stop="emit('retry', task.id)"
        >↻</button>
        <button
          v-if="task.status !== 'running'"
          class="queue-icon-btn"
          type="button"
          :title="$t('studioUi.remove')"
          @click.stop="emit('remove', task.id)"
        >✕</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.queue { display: flex; flex-direction: column; gap: 8px; }

.queue-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.queue-title { font-size: 0.84rem; font-weight: 600; color: var(--app-text-strong); }

.queue-clear {
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  font-size: 0.74em;
  padding: 4px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.12s ease;
}

.queue-clear:hover { background: var(--app-accent-soft); color: var(--app-text-strong); }

.queue-empty {
  margin: 0;
  padding: 20px 8px;
  text-align: center;
  font-size: 0.8em;
  color: var(--app-text-faint);
}

.queue-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 380px;
  overflow-y: auto;
}

.queue-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: 10px;
  border: 1px solid var(--app-border);
  background: var(--app-panel);
  cursor: pointer;
  transition: all 0.12s ease;
}

.queue-item:hover { border-color: var(--app-border-strong); background: var(--app-panel-muted); }
.queue-item.is-error { border-color: rgba(220, 38, 38, 0.4); }
.queue-item.is-running { border-color: var(--app-accent-glow); }

.queue-thumb {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
}

.queue-thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.1em;
}

.queue-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }

.queue-label {
  font-size: 0.82em;
  color: var(--app-text-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.queue-status {
  font-size: 0.72em;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--app-text-muted);
}

.queue-status.status-success { color: var(--app-success); }
.queue-status.status-error { color: var(--app-danger); }
.queue-status.status-running { color: var(--app-accent); }

.queue-error {
  margin-top: 2px;
  font-size: 0.72em;
  line-height: 1.35;
  color: var(--app-danger);
  cursor: pointer;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: break-word;
  white-space: pre-wrap;
}
.queue-error:hover { text-decoration: underline; }

.queue-agent-tag {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--app-accent-soft);
  color: var(--app-text-strong);
  font-size: 0.92em;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.queue-icon-btn {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 7px;
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8em;
  transition: all 0.12s ease;
}

.queue-icon-btn:hover { background: var(--app-accent-soft); color: var(--app-text-strong); }

.queue-spinner { display: inline-block; animation: queue-spin 1.2s linear infinite; }
@keyframes queue-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
</style>
