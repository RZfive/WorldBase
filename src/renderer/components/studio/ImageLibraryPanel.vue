<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ImageLibraryEntry } from '../../../shared/image-studio-types'

const props = defineProps<{
  entries: ImageLibraryEntry[]
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'delete', ids: string[]): void
  (e: 'regenerate', entry: ImageLibraryEntry): void
  (e: 'load', entry: ImageLibraryEntry): void
  (e: 'useAsInput', entry: ImageLibraryEntry): void
  (e: 'saveToFile', entry: ImageLibraryEntry): void
}>()

const selectMode = ref(false)
const selectedIds = ref<Set<string>>(new Set())
const lightbox = ref<ImageLibraryEntry | null>(null)

const selectedCount = computed(() => selectedIds.value.size)

function toggleSelectMode () {
  selectMode.value = !selectMode.value
  if (!selectMode.value) selectedIds.value = new Set()
}

function toggleSelect (id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selectedIds.value = next
}

function selectAll () {
  selectedIds.value = new Set(props.entries.map(entry => entry.id))
}

function clearSelection () {
  selectedIds.value = new Set()
}

function deleteSelected () {
  if (selectedIds.value.size === 0) return
  emit('delete', [...selectedIds.value])
  selectedIds.value = new Set()
  selectMode.value = false
}

function onCardClick (entry: ImageLibraryEntry) {
  if (selectMode.value) {
    toggleSelect(entry.id)
  } else {
    lightbox.value = entry
  }
}

function formatTime (iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
    })
  } catch {
    return iso
  }
}
</script>

<template>
  <section class="lib">
    <header class="lib-header">
      <div class="lib-title">
        <span>🖼️ 图片库</span>
        <span class="lib-count">{{ props.entries.length }}</span>
      </div>
      <div class="lib-actions">
        <button class="lib-btn" type="button" :disabled="props.loading" @click="emit('refresh')">↻ 刷新</button>
        <button
          class="lib-btn"
          type="button"
          :class="{ active: selectMode }"
          :disabled="props.entries.length === 0"
          @click="toggleSelectMode"
        >{{ selectMode ? '取消多选' : '多选' }}</button>
      </div>
    </header>

    <div v-if="selectMode" class="lib-select-bar">
      <span>已选 {{ selectedCount }} 项</span>
      <div class="lib-select-actions">
        <button class="lib-btn" type="button" @click="selectAll">全选</button>
        <button class="lib-btn" type="button" :disabled="selectedCount === 0" @click="clearSelection">清空</button>
        <button class="lib-btn lib-btn-danger" type="button" :disabled="selectedCount === 0" @click="deleteSelected">删除所选</button>
      </div>
    </div>

    <div v-if="props.entries.length === 0" class="lib-empty">
      <p>还没有生成任何图片</p>
      <span>在上方输入提示词并生成，结果会自动保存到这里</span>
    </div>

    <div v-else class="lib-grid">
      <div
        v-for="entry in props.entries"
        :key="entry.id"
        class="lib-card"
        :class="{ selected: selectedIds.has(entry.id) }"
        @click="onCardClick(entry)"
      >
        <img :src="entry.dataUrl" :alt="entry.prompt" class="lib-thumb" loading="lazy" />
        <span class="lib-badge">{{ entry.mode === 'edit' ? '编辑' : '生成' }}</span>
        <span v-if="selectMode" class="lib-check" :class="{ on: selectedIds.has(entry.id) }">✓</span>

        <div v-if="!selectMode" class="lib-card-actions" @click.stop>
          <button class="lib-mini" title="重新生成" @click="emit('regenerate', entry)">↻</button>
          <button class="lib-mini" title="载入参数修改" @click="emit('load', entry)">✎</button>
          <button class="lib-mini" title="作为编辑输入" @click="emit('useAsInput', entry)">⇲</button>
          <button class="lib-mini" title="保存到文件" @click="emit('saveToFile', entry)">⤓</button>
          <button class="lib-mini lib-mini-danger" title="删除" @click="emit('delete', [entry.id])">🗑</button>
        </div>

        <div class="lib-card-caption">{{ entry.prompt || '（无提示词）' }}</div>
      </div>
    </div>

    <!-- Lightbox -->
    <Teleport to="body">
      <div v-if="lightbox" class="lib-lightbox-overlay" @click.self="lightbox = null">
        <div class="lib-lightbox">
          <button class="lib-lightbox-close" type="button" @click="lightbox = null">✕</button>
          <div class="lib-lightbox-body">
            <img :src="lightbox.dataUrl" :alt="lightbox.prompt" class="lib-lightbox-img" />
            <div class="lib-meta">
              <div class="lib-meta-row"><span class="lib-meta-key">模式</span><span>{{ lightbox.mode === 'edit' ? '图片编辑' : '文生图' }}</span></div>
              <div class="lib-meta-row"><span class="lib-meta-key">模型</span><span>{{ lightbox.model }}</span></div>
              <div class="lib-meta-row"><span class="lib-meta-key">尺寸</span><span>{{ lightbox.size }}<template v-if="lightbox.aspectRatio"> · {{ lightbox.aspectRatio }}</template></span></div>
              <div class="lib-meta-row"><span class="lib-meta-key">时间</span><span>{{ formatTime(lightbox.createdAt) }}</span></div>
              <div class="lib-meta-block">
                <span class="lib-meta-key">提示词</span>
                <p class="lib-meta-text">{{ lightbox.prompt || '（无）' }}</p>
              </div>
              <div v-if="lightbox.negativePrompt" class="lib-meta-block">
                <span class="lib-meta-key">负向提示词</span>
                <p class="lib-meta-text">{{ lightbox.negativePrompt }}</p>
              </div>
              <div v-if="lightbox.sourceDataUrls?.length" class="lib-meta-block">
                <span class="lib-meta-key">编辑输入图</span>
                <div class="lib-source-row">
                  <img v-for="(src, i) in lightbox.sourceDataUrls" :key="i" :src="src" class="lib-source-thumb" alt="" />
                </div>
              </div>
              <div class="lib-lightbox-actions">
                <button class="lib-btn" type="button" @click="emit('regenerate', lightbox!); lightbox = null">↻ 重新生成</button>
                <button class="lib-btn" type="button" @click="emit('load', lightbox!); lightbox = null">✎ 载入参数</button>
                <button class="lib-btn" type="button" @click="emit('useAsInput', lightbox!); lightbox = null">⇲ 作为编辑输入</button>
                <button class="lib-btn" type="button" @click="emit('saveToFile', lightbox!)">⤓ 保存到文件</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.lib {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 10px;
}

.lib-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.lib-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--app-text-strong);
}

.lib-count {
  font-size: 0.72em;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
}

.lib-actions { display: flex; gap: 8px; }

.lib-btn {
  padding: 6px 12px;
  border-radius: 9px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  font-size: 0.8em;
  cursor: pointer;
  transition: all 0.12s ease;
}

.lib-btn:hover:not(:disabled) {
  background: var(--app-accent-soft);
  color: var(--app-text-strong);
}

.lib-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.lib-btn.active { background: var(--app-accent-soft); border-color: var(--app-accent-glow); color: var(--app-text-strong); }
.lib-btn-danger { color: var(--app-danger); }
.lib-btn-danger:hover:not(:disabled) { background: rgba(220, 38, 38, 0.9); color: #fff; }

.lib-select-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--app-panel-muted);
  font-size: 0.82em;
  color: var(--app-text-soft);
}

.lib-select-actions { display: flex; gap: 8px; }

.lib-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 40px 16px;
  color: var(--app-text-faint);
  text-align: center;
}

.lib-empty p { margin: 0; font-size: 0.95em; color: var(--app-text-muted); }
.lib-empty span { font-size: 0.8em; }

.lib-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
  overflow-y: auto;
  min-height: 0;
  padding-bottom: 4px;
}

.lib-card {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--app-border);
  background: var(--app-panel);
  cursor: pointer;
  transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
}

.lib-card:hover {
  transform: translateY(-2px);
  border-color: var(--app-border-strong);
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.22);
}

.lib-card.selected {
  border-color: var(--app-accent);
  box-shadow: 0 0 0 2px var(--app-accent-glow);
}

.lib-thumb {
  width: 100%;
  aspect-ratio: 1 / 1;
  object-fit: cover;
  display: block;
  background: var(--app-panel-subtle);
}

.lib-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  font-size: 0.66em;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.74);
  color: #fff;
}

.lib-check {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  border: 2px solid #fff;
  background: rgba(15, 23, 42, 0.5);
  color: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7em;
  font-weight: 700;
}

.lib-check.on { background: var(--app-accent); color: #fff; }

.lib-card-actions {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.14s ease;
}

.lib-card:hover .lib-card-actions { opacity: 1; }

.lib-mini {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.8);
  color: #fff;
  font-size: 0.82em;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s ease;
}

.lib-mini:hover { background: var(--app-accent); }
.lib-mini-danger:hover { background: var(--app-danger); }

.lib-card-caption {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 14px 8px 6px;
  font-size: 0.72em;
  color: #f1f5f9;
  background: linear-gradient(180deg, transparent, rgba(15, 23, 42, 0.82));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Lightbox */
.lib-lightbox-overlay {
  position: fixed;
  inset: 0;
  z-index: 10200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(6px);
  padding: 24px;
}

.lib-lightbox {
  position: relative;
  width: min(900px, 96vw);
  max-height: 90vh;
  overflow: hidden;
  border-radius: 18px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-strong);
  box-shadow: var(--app-shadow);
}

.lib-lightbox-close {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 2;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.7);
  color: #fff;
  cursor: pointer;
}

.lib-lightbox-body {
  display: flex;
  gap: 18px;
  padding: 20px;
  max-height: 90vh;
  overflow: auto;
}

.lib-lightbox-img {
  flex: 1;
  min-width: 0;
  max-width: 520px;
  align-self: flex-start;
  border-radius: 12px;
  background: var(--app-panel-subtle);
  object-fit: contain;
}

.lib-meta {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 0.84em;
}

.lib-meta-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--app-text-soft);
}

.lib-meta-key { color: var(--app-text-muted); font-size: 0.9em; }
.lib-meta-block { display: flex; flex-direction: column; gap: 4px; }
.lib-meta-text {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  white-space: pre-wrap;
  word-break: break-word;
}

.lib-source-row { display: flex; gap: 6px; flex-wrap: wrap; }
.lib-source-thumb { width: 54px; height: 54px; object-fit: cover; border-radius: 8px; border: 1px solid var(--app-border); }

.lib-lightbox-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }

@media (max-width: 720px) {
  .lib-lightbox-body { flex-direction: column; }
  .lib-meta { width: 100%; }
  .lib-lightbox-img { max-width: 100%; }
}
</style>
