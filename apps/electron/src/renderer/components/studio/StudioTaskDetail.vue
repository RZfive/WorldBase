<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ImageLibraryEntry, ImageStudioTask } from '../../../shared/image-studio-types'
import ImagePreview from './ImagePreview.vue'

const props = defineProps<{
  task: ImageStudioTask | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saveToFile', entry: ImageLibraryEntry): void
  (e: 'useAsInput', entry: ImageLibraryEntry): void
  (e: 'retry', id: string): void
}>()

const activeResultIndex = ref(0)
const { t } = useI18n()

function statusLabel (status: ImageStudioTask['status']): string {
  switch (status) {
    case 'queued': return t('studioUi.statusQueued')
    case 'running': return t('studioUi.statusRunning')
    case 'success': return t('studioUi.statusSuccess')
    case 'error': return t('studioUi.statusError')
  }
}

const activeEntry = computed<ImageLibraryEntry | null>(() => {
  const entries = props.task?.entries ?? []
  return entries[activeResultIndex.value] ?? entries[0] ?? null
})

function entryFullSrc (entry: ImageLibraryEntry): string {
  return entry.fullUrl || entry.dataUrl || ''
}

function entryThumbSrc (entry: ImageLibraryEntry): string {
  return entry.thumbUrl || entry.fullUrl || entry.dataUrl || ''
}

// Reset the selected result whenever a different task is opened.
watch(() => props.task?.id, () => {
  activeResultIndex.value = 0
})
</script>

<template>
  <Teleport to="body">
    <div v-if="task" class="detail-overlay" @click.self="emit('close')">
      <div class="detail">
        <header class="detail-header">
          <div class="detail-heading">
            <span class="detail-title">{{ task.request.mode === 'edit' ? $t('studioUi.imageEditTask') : $t('studioUi.textToImageTask') }}</span>
            <span class="detail-status" :class="`status-${task.status}`">{{ statusLabel(task.status) }}</span>
          </div>
          <button class="detail-close" type="button" @click="emit('close')">{{ $t('common.close') }}</button>
        </header>

        <div class="detail-body">
          <!-- Preview / state -->
          <div class="detail-preview-col">
            <div v-if="task.status === 'success' && activeEntry" class="detail-preview-wrap">
              <ImagePreview class="detail-preview" :src="entryFullSrc(activeEntry)" :alt="activeEntry.prompt" />
            </div>
            <div v-else-if="task.status === 'error'" class="detail-state detail-state-error">
              <p>{{ $t('studioUi.generationFailed') }}</p>
              <pre v-if="task.error" class="detail-error-text">{{ task.error }}</pre>
              <button class="detail-btn" type="button" @click="emit('retry', task.id)">↻ {{ $t('common.retry') }}</button>
            </div>
            <div v-else class="detail-state">
              <span class="detail-spinner">⏳</span>
              <p>{{ task.status === 'running' ? $t('studioUi.generating') : $t('studioUi.waitingSlot') }}</p>
            </div>

            <!-- Result thumbnails when multiple images -->
            <div v-if="task.status === 'success' && task.entries.length > 1" class="detail-thumbs">
              <button
                v-for="(entry, i) in task.entries"
                :key="entry.id"
                type="button"
                class="detail-thumb"
                :class="{ active: i === activeResultIndex }"
                @click="activeResultIndex = i"
              >
                <img :src="entryThumbSrc(entry)" alt="" />
              </button>
            </div>

            <div v-if="task.status === 'success' && activeEntry" class="detail-actions">
              <button class="detail-btn" type="button" @click="emit('saveToFile', activeEntry!)">⤓ {{ $t('studioUi.saveToFile') }}</button>
              <button class="detail-btn" type="button" @click="emit('useAsInput', activeEntry!)">⇲ {{ $t('studioUi.useAsInput') }}</button>
            </div>
          </div>

          <!-- Parameters -->
          <div class="detail-meta">
            <div class="detail-row"><span class="detail-key">{{ $t('studioUi.mode') }}</span><span>{{ task.request.mode === 'edit' ? $t('studioUi.imageEdit') : $t('studioUi.textToImage') }}</span></div>
            <div class="detail-row"><span class="detail-key">{{ $t('studioUi.model') }}</span><span>{{ task.request.model }}</span></div>
            <div class="detail-row"><span class="detail-key">{{ $t('studioUi.size') }}</span><span>{{ task.request.size }}<template v-if="task.request.aspectRatio"> · {{ task.request.aspectRatio }}</template></span></div>
            <div v-if="task.request.quality || task.request.outputFormat" class="detail-row"><span class="detail-key">{{ $t('studioUi.quality') }}</span><span><template v-if="task.request.quality">{{ $t(`studioUi.quality_${task.request.quality}`) }}</template><template v-if="task.request.quality && task.request.outputFormat"> · </template><template v-if="task.request.outputFormat">{{ task.request.outputFormat.toUpperCase() }}</template></span></div>
            <div class="detail-row"><span class="detail-key">{{ $t('studioUi.count') }}</span><span>{{ task.request.n ?? 1 }}</span></div>
            <div class="detail-block">
              <span class="detail-key">{{ $t('studioUi.prompt') }}</span>
              <p class="detail-text">{{ task.request.prompt || $t('studioUi.none') }}</p>
            </div>
            <div v-if="task.request.negativePrompt" class="detail-block">
              <span class="detail-key">{{ $t('studioUi.negativePrompt') }}</span>
              <p class="detail-text">{{ task.request.negativePrompt }}</p>
            </div>
            <div v-if="task.request.inputImages?.length" class="detail-block">
              <span class="detail-key">{{ $t('studioUi.inputImages') }}</span>
              <div class="detail-source-row">
                <img v-for="(src, i) in task.request.inputImages" :key="i" :src="src" class="detail-source-thumb" alt="" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.detail-overlay {
  --detail-top-offset: var(--app-titlebar-height, 38px);
  position: fixed;
  inset: var(--detail-top-offset) 0 0 0;
  z-index: 10200;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 16px 24px 24px;
}

.detail-overlay::before {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(4px);
  pointer-events: none;
}

.detail {
  position: relative;
  width: min(1320px, calc(100vw - 48px));
  height: min(820px, calc(100vh - var(--detail-top-offset) - 40px));
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-radius: 22px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-strong);
  box-shadow: var(--app-shadow);
  isolation: isolate;
}

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--app-border);
}

.detail-heading { display: flex; align-items: center; gap: 10px; }
.detail-title { font-size: 0.96rem; font-weight: 600; color: var(--app-text-strong); }

.detail-status {
  font-size: 0.72rem;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
}

.detail-status.status-success { color: var(--app-success); }
.detail-status.status-error { color: var(--app-danger); }
.detail-status.status-running { color: var(--app-accent); }

.detail-close {
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--app-border-strong);
  border-radius: 999px;
  background: var(--app-panel-subtle);
  color: var(--app-text-strong);
  cursor: pointer;
}

.detail-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 20px;
  padding: 20px;
  overflow: hidden;
}

.detail-preview-col {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.detail-preview-wrap {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.detail-preview {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.detail-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border-radius: 16px;
  background: var(--app-panel-subtle);
  color: var(--app-text-muted);
}

.detail-state p { margin: 0; font-size: 0.9em; }
.detail-state span { font-size: 0.8em; color: var(--app-text-faint); max-width: 80%; text-align: center; }
.detail-state-error { align-items: stretch; }
.detail-state-error p { color: var(--app-danger); margin: 0 0 8px; text-align: center; }
.detail-error-text {
  margin: 0 0 12px;
  padding: 12px 14px;
  max-width: 100%;
  max-height: 60vh;
  overflow: auto;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel);
  color: var(--app-danger);
  font-family: var(--app-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.8em;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  text-align: left;
}
.detail-state-error .detail-btn { align-self: center; }
.detail-spinner { display: inline-block; font-size: 1.6em; animation: detail-spin 1.2s linear infinite; }
@keyframes detail-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

.detail-thumbs { display: flex; gap: 8px; flex-wrap: wrap; }
.detail-thumb {
  width: 56px;
  height: 56px;
  padding: 0;
  border-radius: 8px;
  overflow: hidden;
  border: 2px solid transparent;
  background: none;
  cursor: pointer;
}
.detail-thumb.active { border-color: var(--app-accent); }
.detail-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }

.detail-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.detail-btn {
  padding: 7px 14px;
  border-radius: 9px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  font-size: 0.82em;
  cursor: pointer;
  transition: all 0.12s ease;
}

.detail-btn:hover { background: var(--app-accent-soft); color: var(--app-text-strong); }

.detail-meta {
  min-width: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 0.84em;
}

.detail-row { display: flex; justify-content: space-between; gap: 12px; color: var(--app-text-soft); }
.detail-key { color: var(--app-text-muted); font-size: 0.9em; }
.detail-block { display: flex; flex-direction: column; gap: 4px; }
.detail-text {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  white-space: pre-wrap;
  word-break: break-word;
}

.detail-source-row { display: flex; gap: 6px; flex-wrap: wrap; }
.detail-source-thumb { width: 54px; height: 54px; object-fit: cover; border-radius: 8px; border: 1px solid var(--app-border); }

@media (max-width: 980px) {
  .detail-body { grid-template-columns: minmax(0, 1fr); overflow: auto; }
  .detail-meta { overflow: visible; }
}
</style>
