<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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
  (e: 'updateFolder', ids: string[], folder: string | undefined): void
  (e: 'updateTags', id: string, tags: string[]): void
}>()

const selectMode = ref(false)
const selectedIds = ref<Set<string>>(new Set())
const lightbox = ref<ImageLibraryEntry | null>(null)

// Folder filtering
const activeFolder = ref<string | null>(null) // null = all images
const showFolderPanel = ref(false)
const newFolderName = ref('')

// Tag/search filtering
const searchQuery = ref('')

// Image zoom state
const zoomLevel = ref(1)
const MIN_ZOOM = 0.5
const MAX_ZOOM = 4

// Tag editing in lightbox
const editingTags = ref(false)
const tagInput = ref('')

const selectedCount = computed(() => selectedIds.value.size)

// Compute unique folders from entries
const folders = computed(() => {
  const map = new Map<string, number>()
  for (const entry of props.entries) {
    if (entry.folder) {
      map.set(entry.folder, (map.get(entry.folder) ?? 0) + 1)
    }
  }
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name))
})

// Compute unique tags from entries
const allTags = computed(() => {
  const tagSet = new Set<string>()
  for (const entry of props.entries) {
    if (entry.tags) {
      entry.tags.forEach(t => tagSet.add(t))
    }
  }
  return Array.from(tagSet).sort()
})

// Filtered entries based on folder + search/tag query
const filteredEntries = computed(() => {
  let list = props.entries

  // Filter by active folder
  if (activeFolder.value !== null) {
    if (activeFolder.value === '') {
      // Show unfiled entries (no folder assigned)
      list = list.filter(entry => !entry.folder)
    } else {
      list = list.filter(entry => entry.folder === activeFolder.value)
    }
  }

  // Filter by search query (matches prompt, tags, negativePrompt)
  const q = searchQuery.value.trim().toLowerCase()
  if (q) {
    list = list.filter(entry => {
      if (entry.prompt.toLowerCase().includes(q)) return true
      if (entry.negativePrompt?.toLowerCase().includes(q)) return true
      if (entry.tags?.some(t => t.toLowerCase().includes(q))) return true
      if (entry.folder?.toLowerCase().includes(q)) return true
      return false
    })
  }

  return list
})

// Unfiled count
const unfiledCount = computed(() => props.entries.filter(e => !e.folder).length)

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
  selectedIds.value = new Set(filteredEntries.value.map(entry => entry.id))
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

function moveSelectedToFolder (folder: string | undefined) {
  if (selectedIds.value.size === 0) return
  emit('updateFolder', [...selectedIds.value], folder)
  selectedIds.value = new Set()
  selectMode.value = false
}

function createFolder () {
  const name = newFolderName.value.trim()
  if (!name || selectedIds.value.size === 0) return
  emit('updateFolder', [...selectedIds.value], name)
  newFolderName.value = ''
  selectedIds.value = new Set()
  selectMode.value = false
}

function onCardClick (entry: ImageLibraryEntry) {
  if (selectMode.value) {
    toggleSelect(entry.id)
  } else {
    lightbox.value = entry
    zoomLevel.value = 1
    editingTags.value = false
    tagInput.value = entry.tags?.join(', ') ?? ''
  }
}

// Zoom controls
function zoomIn () {
  zoomLevel.value = Math.min(MAX_ZOOM, zoomLevel.value + 0.25)
}

function zoomOut () {
  zoomLevel.value = Math.max(MIN_ZOOM, zoomLevel.value - 0.25)
}

function zoomReset () {
  zoomLevel.value = 1
}

function onWheel (event: WheelEvent) {
  event.preventDefault()
  if (event.deltaY < 0) {
    zoomIn()
  } else {
    zoomOut()
  }
}

// Tag editing
function startEditTags () {
  editingTags.value = true
  tagInput.value = lightbox.value?.tags?.join(', ') ?? ''
}

function saveTags () {
  if (!lightbox.value) return
  const tags = tagInput.value
    .split(/[,，]/)
    .map(t => t.trim())
    .filter(t => t.length > 0)
  emit('updateTags', lightbox.value.id, tags)
  lightbox.value = { ...lightbox.value, tags: tags.length ? tags : undefined }
  editingTags.value = false
}

function cancelEditTags () {
  editingTags.value = false
  tagInput.value = lightbox.value?.tags?.join(', ') ?? ''
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

// Reset zoom when lightbox changes
watch(lightbox, () => {
  zoomLevel.value = 1
})
</script>

<template>
  <section class="lib">
    <header class="lib-header">
      <div class="lib-title">
        <span>🖼️ 图片库</span>
        <span class="lib-count">{{ filteredEntries.length }}<template v-if="filteredEntries.length !== props.entries.length"> / {{ props.entries.length }}</template></span>
      </div>
      <div class="lib-actions">
        <input
          v-model="searchQuery"
          class="lib-search"
          type="text"
          placeholder="搜索提示词 / 标签…"
        />
        <button class="lib-btn" type="button" :class="{ active: showFolderPanel }" @click="showFolderPanel = !showFolderPanel">📁 分组</button>
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

    <!-- Folder panel -->
    <div v-if="showFolderPanel" class="lib-folder-panel">
      <div class="lib-folder-list">
        <button
          class="lib-folder-item"
          :class="{ active: activeFolder === null }"
          type="button"
          @click="activeFolder = null"
        >
          <span>📂 全部</span>
          <span class="lib-folder-count">{{ props.entries.length }}</span>
        </button>
        <button
          class="lib-folder-item"
          :class="{ active: activeFolder === '' }"
          type="button"
          @click="activeFolder = ''"
        >
          <span>📄 未分组</span>
          <span class="lib-folder-count">{{ unfiledCount }}</span>
        </button>
        <button
          v-for="folder in folders"
          :key="folder.name"
          class="lib-folder-item"
          :class="{ active: activeFolder === folder.name }"
          type="button"
          @click="activeFolder = folder.name"
        >
          <span>📁 {{ folder.name }}</span>
          <span class="lib-folder-count">{{ folder.count }}</span>
        </button>
      </div>
      <div v-if="selectMode && selectedCount > 0" class="lib-folder-assign">
        <input v-model="newFolderName" class="lib-folder-input" type="text" placeholder="输入新文件夹名…" @keydown.enter="createFolder" />
        <button class="lib-btn" type="button" :disabled="!newFolderName.trim()" @click="createFolder">移入</button>
        <button v-if="folders.length > 0" class="lib-btn" type="button" @click="moveSelectedToFolder(undefined)">移出分组</button>
      </div>
    </div>

    <div v-if="selectMode" class="lib-select-bar">
      <span>已选 {{ selectedCount }} 项</span>
      <div class="lib-select-actions">
        <button class="lib-btn" type="button" @click="selectAll">全选</button>
        <button class="lib-btn" type="button" :disabled="selectedCount === 0" @click="clearSelection">清空</button>
        <button class="lib-btn lib-btn-danger" type="button" :disabled="selectedCount === 0" @click="deleteSelected">删除所选</button>
      </div>
    </div>

    <div v-if="filteredEntries.length === 0" class="lib-empty">
      <template v-if="props.entries.length === 0">
        <p>还没有生成任何图片</p>
        <span>在上方输入提示词并生成，结果会自动保存到这里</span>
      </template>
      <template v-else>
        <p>没有匹配的图片</p>
        <span>尝试修改搜索条件或选择其他分组</span>
      </template>
    </div>

    <div v-else class="lib-grid">
      <div
        v-for="entry in filteredEntries"
        :key="entry.id"
        class="lib-card"
        :class="{ selected: selectedIds.has(entry.id) }"
        @click="onCardClick(entry)"
      >
        <img :src="entry.dataUrl" :alt="entry.prompt" class="lib-thumb" loading="lazy" />
        <span class="lib-badge">{{ entry.mode === 'edit' ? '编辑' : '生成' }}</span>
        <span v-if="entry.folder" class="lib-folder-badge">📁 {{ entry.folder }}</span>
        <span v-if="selectMode" class="lib-check" :class="{ on: selectedIds.has(entry.id) }">✓</span>

        <div v-if="!selectMode" class="lib-card-actions" @click.stop>
          <button class="lib-mini" title="重新生成" @click="emit('regenerate', entry)">↻</button>
          <button class="lib-mini" title="载入参数修改" @click="emit('load', entry)">✎</button>
          <button class="lib-mini" title="作为编辑输入" @click="emit('useAsInput', entry)">⇲</button>
          <button class="lib-mini" title="保存到文件" @click="emit('saveToFile', entry)">⤓</button>
          <button class="lib-mini lib-mini-danger" title="删除" @click="emit('delete', [entry.id])">🗑</button>
        </div>

        <div class="lib-card-caption">
          <span v-if="entry.tags?.length" class="lib-card-tags">{{ entry.tags.join(' · ') }}</span>
          <span v-else>{{ entry.prompt || '（无提示词）' }}</span>
        </div>
      </div>
    </div>

    <!-- Lightbox with Zoom -->
    <Teleport to="body">
      <div v-if="lightbox" class="lib-lightbox-overlay" @click.self="lightbox = null">
        <div class="lib-lightbox">
          <button class="lib-lightbox-close" type="button" @click="lightbox = null">✕</button>
          <div class="lib-lightbox-body">
            <div class="lib-lightbox-img-wrapper" @wheel="onWheel">
              <img
                :src="lightbox.dataUrl"
                :alt="lightbox.prompt"
                class="lib-lightbox-img"
                :style="{ transform: `scale(${zoomLevel})` }"
              />
              <div class="lib-zoom-controls">
                <button class="lib-zoom-btn" type="button" @click="zoomOut" :disabled="zoomLevel <= MIN_ZOOM">−</button>
                <span class="lib-zoom-label" @click="zoomReset">{{ Math.round(zoomLevel * 100) }}%</span>
                <button class="lib-zoom-btn" type="button" @click="zoomIn" :disabled="zoomLevel >= MAX_ZOOM">+</button>
              </div>
            </div>
            <div class="lib-meta">
              <div class="lib-meta-row"><span class="lib-meta-key">模式</span><span>{{ lightbox.mode === 'edit' ? '图片编辑' : '文生图' }}</span></div>
              <div class="lib-meta-row"><span class="lib-meta-key">模型</span><span>{{ lightbox.model }}</span></div>
              <div class="lib-meta-row"><span class="lib-meta-key">尺寸</span><span>{{ lightbox.size }}<template v-if="lightbox.aspectRatio"> · {{ lightbox.aspectRatio }}</template></span></div>
              <div class="lib-meta-row"><span class="lib-meta-key">时间</span><span>{{ formatTime(lightbox.createdAt) }}</span></div>
              <div v-if="lightbox.folder" class="lib-meta-row"><span class="lib-meta-key">分组</span><span>📁 {{ lightbox.folder }}</span></div>
              <div class="lib-meta-block">
                <span class="lib-meta-key">提示词</span>
                <p class="lib-meta-text">{{ lightbox.prompt || '（无）' }}</p>
              </div>
              <div v-if="lightbox.negativePrompt" class="lib-meta-block">
                <span class="lib-meta-key">负向提示词</span>
                <p class="lib-meta-text">{{ lightbox.negativePrompt }}</p>
              </div>
              <!-- Tags section -->
              <div class="lib-meta-block">
                <span class="lib-meta-key">
                  标签
                  <button v-if="!editingTags" class="lib-tag-edit-btn" type="button" @click="startEditTags">✎</button>
                </span>
                <div v-if="editingTags" class="lib-tag-editor">
                  <input v-model="tagInput" class="lib-tag-input" type="text" placeholder="逗号分隔多个标签…" @keydown.enter="saveTags" />
                  <div class="lib-tag-editor-actions">
                    <button class="lib-btn" type="button" @click="saveTags">保存</button>
                    <button class="lib-btn" type="button" @click="cancelEditTags">取消</button>
                  </div>
                </div>
                <div v-else class="lib-tags-display">
                  <span v-if="lightbox.tags?.length" v-for="tag in lightbox.tags" :key="tag" class="lib-tag-chip">{{ tag }}</span>
                  <span v-else class="lib-tag-empty">无标签，点击 ✎ 添加</span>
                </div>
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
  flex-wrap: wrap;
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

.lib-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

.lib-search {
  padding: 6px 12px;
  border-radius: 9px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-subtle);
  color: var(--app-text);
  font-size: 0.8em;
  width: 180px;
}

.lib-search:focus {
  outline: none;
  border-color: var(--app-accent);
  box-shadow: 0 0 0 2px var(--app-accent-glow);
}

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

/* Folder panel */
.lib-folder-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--app-panel-muted);
  border: 1px solid var(--app-border);
}

.lib-folder-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.lib-folder-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
  color: var(--app-text-soft);
  font-size: 0.78em;
  cursor: pointer;
  transition: all 0.12s ease;
}

.lib-folder-item:hover { border-color: var(--app-accent); color: var(--app-text-strong); }
.lib-folder-item.active { background: var(--app-accent-soft); border-color: var(--app-accent-glow); color: var(--app-text-strong); }

.lib-folder-count {
  font-size: 0.85em;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-faint);
}

.lib-folder-assign {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-top: 6px;
  border-top: 1px solid var(--app-border);
}

.lib-folder-input {
  flex: 1;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-subtle);
  color: var(--app-text);
  font-size: 0.8em;
}

.lib-folder-input:focus { outline: none; border-color: var(--app-accent); }

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

.lib-folder-badge {
  position: absolute;
  top: 6px;
  left: 50px;
  font-size: 0.62em;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.74);
  color: #e2e8f0;
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

.lib-card-tags { color: #93c5fd; }

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
  width: min(960px, 96vw);
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

.lib-lightbox-img-wrapper {
  flex: 1;
  min-width: 0;
  max-width: 560px;
  align-self: flex-start;
  position: relative;
  overflow: hidden;
  border-radius: 12px;
  background: var(--app-panel-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
}

.lib-lightbox-img {
  width: 100%;
  object-fit: contain;
  transition: transform 0.15s ease;
  transform-origin: center center;
}

.lib-zoom-controls {
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.8);
  backdrop-filter: blur(6px);
}

.lib-zoom-btn {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: #fff;
  font-size: 1.1em;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s ease;
}

.lib-zoom-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.15); }
.lib-zoom-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.lib-zoom-label {
  font-size: 0.72em;
  color: #e2e8f0;
  min-width: 40px;
  text-align: center;
  cursor: pointer;
}

.lib-zoom-label:hover { color: #fff; text-decoration: underline; }

.lib-meta {
  width: 300px;
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

.lib-meta-key { color: var(--app-text-muted); font-size: 0.9em; display: flex; align-items: center; gap: 6px; }
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

/* Tags */
.lib-tag-edit-btn {
  border: none;
  background: transparent;
  color: var(--app-text-faint);
  cursor: pointer;
  font-size: 0.9em;
  padding: 2px 4px;
  border-radius: 4px;
}
.lib-tag-edit-btn:hover { color: var(--app-accent); background: var(--app-accent-soft); }

.lib-tag-editor { display: flex; flex-direction: column; gap: 6px; }
.lib-tag-input {
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-subtle);
  color: var(--app-text);
  font-size: 0.9em;
}
.lib-tag-input:focus { outline: none; border-color: var(--app-accent); }
.lib-tag-editor-actions { display: flex; gap: 6px; }

.lib-tags-display { display: flex; flex-wrap: wrap; gap: 4px; }
.lib-tag-chip {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--app-accent-soft);
  color: var(--app-text-strong);
  font-size: 0.82em;
}
.lib-tag-empty { font-size: 0.82em; color: var(--app-text-faint); }

.lib-source-row { display: flex; gap: 6px; flex-wrap: wrap; }
.lib-source-thumb { width: 54px; height: 54px; object-fit: cover; border-radius: 8px; border: 1px solid var(--app-border); }

.lib-lightbox-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }

@media (max-width: 720px) {
  .lib-lightbox-body { flex-direction: column; }
  .lib-meta { width: 100%; }
  .lib-lightbox-img-wrapper { max-width: 100%; }
}
</style>
