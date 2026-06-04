<script setup lang="ts">
import { computed } from 'vue'
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

const STATUS_LABELS: Record<ImageStudioTask['status'], string> = {
  queued: '排队中',
  running: '生成中',
  success: '完成',
  error: '失败'
}
</script>

<template>
  <div class="queue">
    <header class="queue-header">
      <span class="queue-title">任务队列</span>
      <button v-if="hasFinished" class="queue-clear" type="button" @click="emit('clearFinished')">清除已完成</button>
    </header>

    <p v-if="tasks.length === 0" class="queue-empty">暂无任务，去工作台生成或编辑图片吧</p>

    <ul v-else class="queue-list">
      <li
        v-for="task in tasks"
        :key="task.id"
        class="queue-item"
        :class="`is-${task.status}`"
        @click="emit('open', task)"
      >
        <img v-if="task.inputPreview" :src="task.inputPreview" class="queue-thumb" alt="" />
        <img v-else-if="task.entries[0]" :src="task.entries[0].dataUrl" class="queue-thumb" alt="" />
        <span v-else class="queue-thumb queue-thumb-placeholder">{{ task.request.mode === 'edit' ? '✎' : '🎨' }}</span>

        <div class="queue-body">
          <span class="queue-label" :title="task.label">{{ task.label || '（无提示词）' }}</span>
          <span class="queue-status" :class="`status-${task.status}`">
            <span v-if="task.status === 'running'" class="queue-spinner">⏳</span>
            {{ task.request.mode === 'edit' ? '编辑' : '生成' }} · {{ STATUS_LABELS[task.status] }}
          </span>
        </div>

        <button
          v-if="task.status === 'error'"
          class="queue-icon-btn"
          type="button"
          title="重试"
          @click.stop="emit('retry', task.id)"
        >↻</button>
        <button
          v-if="task.status !== 'running'"
          class="queue-icon-btn"
          type="button"
          title="移除"
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
