<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ImageLibraryEntry } from '../../../shared/image-studio-types'
import ImagePreview from './ImagePreview.vue'

const props = defineProps<{
  entries: ImageLibraryEntry[]
  loading: boolean
  /** Persisted folder names (includes empty folders). */
  folderNames?: string[]
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
  (e: 'createFolder', name: string): void
  (e: 'exportFolder', name: string): void
  (e: 'renameFolder', oldName: string, newName: string): void
  (e: 'deleteFolder', name: string): void
}>()

/** Current folder being browsed; null = root (folders + unfiled images). */
const currentFolder = ref<string | null>(null)
const searchQuery = ref('')

/** Image selection (ids). Cleared when navigating. */
const selectedIds = ref<Set<string>>(new Set())
/** Cut clipboard — paste moves these into the current folder. */
const clipboard = ref<string[]>([])

/** Drag state: ids being dragged, and the folder key currently hovered as drop target. */
const draggingIds = ref<string[]>([])
const dragOverKey = ref<string | null>(null) // folder name, '' for root/unfiled

/** Right-click context menu. */
type MenuKind = 'image' | 'folder' | 'blank'
const contextMenu = ref<{ kind: MenuKind; x: number; y: number; folderName?: string } | null>(null)

const lightbox = ref<ImageLibraryEntry | null>(null)
const editingTags = ref(false)
const tagInput = ref('')

const selectedCount = computed(() => selectedIds.value.size)

/** Map of folder name → entries inside it. */
const entriesByFolder = computed(() => {
  const map = new Map<string, ImageLibraryEntry[]>()
  for (const name of props.folderNames ?? []) map.set(name, [])
  for (const entry of props.entries) {
    if (!entry.folder) continue
    const list = map.get(entry.folder) ?? []
    list.push(entry)
    map.set(entry.folder, list)
  }
  return map
})

/** Folder cards (root view): name, count, up-to-4 cover thumbnails. */
const folderCards = computed(() => {
  return Array.from(entriesByFolder.value.entries())
    .map(([name, list]) => ({
      name,
      count: list.length,
      covers: list.slice(0, 4).map(e => e.dataUrl)
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
})

const allFolderNames = computed(() => folderCards.value.map(f => f.name))

const unfiledEntries = computed(() => props.entries.filter(e => !e.folder))

function matchesQuery (entry: ImageLibraryEntry, q: string): boolean {
  if (entry.prompt.toLowerCase().includes(q)) return true
  if (entry.negativePrompt?.toLowerCase().includes(q)) return true
  if (entry.tags?.some(t => t.toLowerCase().includes(q))) return true
  if (entry.folder?.toLowerCase().includes(q)) return true
  return false
}

const isSearching = computed(() => searchQuery.value.trim().length > 0)

/** Images shown in the current view. */
const visibleEntries = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (q) return props.entries.filter(e => matchesQuery(e, q)) // flat search across everything
  if (currentFolder.value === null) return unfiledEntries.value
  return entriesByFolder.value.get(currentFolder.value) ?? []
})

/** Folder grid is only shown at the root and when not searching. */
const showFolders = computed(() => currentFolder.value === null && !isSearching.value)

const currentFolderCount = computed(() =>
  currentFolder.value === null ? 0 : (entriesByFolder.value.get(currentFolder.value)?.length ?? 0)
)

/* ---- Navigation ---- */

function openFolder (name: string) {
  currentFolder.value = name
  selectedIds.value = new Set()
  closeContextMenu()
}

function goRoot () {
  currentFolder.value = null
  selectedIds.value = new Set()
}

/* ---- Selection ---- */

function selectOnly (id: string) {
  selectedIds.value = new Set([id])
}

function toggleSelection (id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

/** Plain click opens the preview; ⌘/Ctrl-click toggles selection (multi-select). */
function onImageClick (entry: ImageLibraryEntry, event: MouseEvent) {
  if (event.metaKey || event.ctrlKey) {
    toggleSelection(entry.id)
  } else {
    openLightbox(entry)
  }
}

/** The always-visible corner checkbox toggles selection without opening the preview. */
function onCheckClick (entry: ImageLibraryEntry) {
  toggleSelection(entry.id)
}

function clearSelection () {
  selectedIds.value = new Set()
}

function onBlankClick () {
  clearSelection()
  closeContextMenu()
}

/* ---- Drag images into folders ---- */

function effectiveIds (entryId: string): string[] {
  return selectedIds.value.has(entryId) ? [...selectedIds.value] : [entryId]
}

function onImageDragStart (entry: ImageLibraryEntry, event: DragEvent) {
  const ids = effectiveIds(entry.id)
  if (!selectedIds.value.has(entry.id)) selectOnly(entry.id)
  draggingIds.value = ids
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', ids.join(','))
  }
}

function onImageDragEnd () {
  draggingIds.value = []
  dragOverKey.value = null
}

function onFolderDragOver (key: string) {
  if (draggingIds.value.length === 0) return
  dragOverKey.value = key
}

function onFolderDragLeave (key: string) {
  if (dragOverKey.value === key) dragOverKey.value = null
}

function dropOnFolder (folder: string | undefined) {
  if (draggingIds.value.length > 0) {
    emit('updateFolder', [...draggingIds.value], folder)
    selectedIds.value = new Set()
  }
  draggingIds.value = []
  dragOverKey.value = null
}

/* ---- Folder operations ---- */

function uniqueFolderName (base = '新建文件夹'): string {
  const names = new Set(allFolderNames.value)
  if (!names.has(base)) return base
  let i = 2
  while (names.has(`${base} (${i})`)) i += 1
  return `${base} (${i})`
}

/** Inline folder-name editing. `original === null` ⇒ creating a new folder. */
const editingFolder = ref<{ original: string | null } | null>(null)
/** Text bound to the inline rename/create input (kept separate so v-model is never null). */
const editingFolderName = ref('')

/** Autofocus + select the inline input when it mounts. */
const vFocus = {
  mounted: (el: HTMLInputElement) => { el.focus(); el.select() }
}

function isEditingFolder (name: string): boolean {
  return editingFolder.value?.original === name
}

function startCreateFolder () {
  closeContextMenu()
  // New folders live at the root; leave any folder/search view so the editing card shows.
  currentFolder.value = null
  searchQuery.value = ''
  editingFolderName.value = uniqueFolderName()
  editingFolder.value = { original: null }
}

function startRenameFolder (name: string) {
  closeContextMenu()
  editingFolderName.value = name
  editingFolder.value = { original: name }
}

function commitFolderEdit () {
  const edit = editingFolder.value
  if (!edit) return // already committed/cancelled (e.g. blur after Enter/Esc)
  editingFolder.value = null
  const next = editingFolderName.value.trim()
  if (!next) return
  if (edit.original === null) {
    if (!allFolderNames.value.includes(next)) emit('createFolder', next)
  } else if (next !== edit.original) {
    emit('renameFolder', edit.original, next)
    if (currentFolder.value === edit.original) currentFolder.value = next
  }
}

function cancelFolderEdit () {
  editingFolder.value = null
}

function deleteFolder (name: string) {
  if (window.confirm(`删除文件夹「${name}」？组内图片会移到未分组，不会被删除。`)) {
    emit('deleteFolder', name)
    if (currentFolder.value === name) currentFolder.value = null
  }
  closeContextMenu()
}

function exportFolder (name: string) {
  emit('exportFolder', name)
  closeContextMenu()
}

/* ---- Cut / paste (move) ---- */

function cutSelection (ids: string[]) {
  clipboard.value = [...ids]
  closeContextMenu()
}

const canPaste = computed(() => clipboard.value.length > 0)

function paste () {
  if (clipboard.value.length === 0) return
  emit('updateFolder', [...clipboard.value], currentFolder.value ?? undefined)
  clipboard.value = []
  selectedIds.value = new Set()
  closeContextMenu()
}

function moveTo (ids: string[], folder: string | undefined) {
  emit('updateFolder', ids, folder)
  selectedIds.value = new Set()
  closeContextMenu()
}

function deleteImages (ids: string[]) {
  if (ids.length === 0) return
  emit('delete', ids)
  selectedIds.value = new Set()
  closeContextMenu()
}

/* ---- Context menu ---- */

function openImageMenu (entry: ImageLibraryEntry, event: MouseEvent) {
  if (!selectedIds.value.has(entry.id)) selectOnly(entry.id)
  contextMenu.value = { kind: 'image', x: event.clientX, y: event.clientY }
}

function openFolderMenu (name: string, event: MouseEvent) {
  contextMenu.value = { kind: 'folder', x: event.clientX, y: event.clientY, folderName: name }
}

function openBlankMenu (event: MouseEvent) {
  contextMenu.value = { kind: 'blank', x: event.clientX, y: event.clientY }
}

function closeContextMenu () {
  contextMenu.value = null
}

/** Menu helpers operating on the current selection. */
const menuIds = computed(() => [...selectedIds.value])
const menuSingleEntry = computed<ImageLibraryEntry | null>(() => {
  if (selectedIds.value.size !== 1) return null
  const id = [...selectedIds.value][0]
  return props.entries.find(e => e.id === id) ?? null
})
/** Folders an image can be moved to (exclude the current one). */
const moveTargets = computed(() => allFolderNames.value.filter(n => n !== currentFolder.value))

/* ---- Lightbox ---- */

function openLightbox (entry: ImageLibraryEntry) {
  lightbox.value = entry
  editingTags.value = false
  tagInput.value = entry.tags?.join(', ') ?? ''
}

function closeLightbox () {
  lightbox.value = null
}

function startEditTags () {
  editingTags.value = true
  tagInput.value = lightbox.value?.tags?.join(', ') ?? ''
}

function saveTags () {
  if (!lightbox.value) return
  const tags = tagInput.value.split(/[,，]/).map(t => t.trim()).filter(t => t.length > 0)
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
    return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

function onWindowKeydown (event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (contextMenu.value) { closeContextMenu(); return }
    if (lightbox.value) { closeLightbox(); return }
    if (selectedIds.value.size) clearSelection()
  }
}

// If the browsed folder disappears (renamed/deleted upstream), fall back to root.
watch(() => props.folderNames, (names) => {
  if (currentFolder.value !== null && names && !names.includes(currentFolder.value)) {
    currentFolder.value = null
  }
})

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('click', closeContextMenu)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('click', closeContextMenu)
})
</script>

<template>
  <section class="lib">
    <header class="lib-header">
      <div class="lib-title">
        <button v-if="currentFolder !== null" class="lib-back" type="button" title="返回" @click="goRoot">←</button>
        <span>🖼️ 图片库</span>
        <span class="lib-count">{{ visibleEntries.length }}</span>
      </div>
      <div class="lib-actions">
        <input v-model="searchQuery" class="lib-search" type="text" placeholder="搜索提示词 / 标签…" />
        <button class="lib-btn" type="button" @click="startCreateFolder">＋ 新建文件夹</button>
        <button class="lib-btn" type="button" :disabled="props.loading" @click="emit('refresh')">↻ 刷新</button>
      </div>
    </header>

    <!-- Breadcrumb -->
    <nav class="lib-breadcrumb">
      <button
        class="lib-crumb"
        :class="{ active: currentFolder === null && !isSearching, 'drag-over': dragOverKey === '' }"
        type="button"
        @click="goRoot"
        @dragover.prevent="onFolderDragOver('')"
        @dragleave="onFolderDragLeave('')"
        @drop.prevent="dropOnFolder(undefined)"
      >📂 全部图片</button>
      <template v-if="isSearching">
        <span class="lib-crumb-sep">/</span>
        <span class="lib-crumb-current">搜索结果</span>
      </template>
      <template v-else-if="currentFolder !== null">
        <span class="lib-crumb-sep">/</span>
        <span class="lib-crumb-current">📁 {{ currentFolder }} <span class="lib-crumb-count">{{ currentFolderCount }}</span></span>
      </template>
    </nav>

    <div
      class="lib-grid"
      @click.self="onBlankClick"
      @contextmenu.self.prevent="openBlankMenu($event)"
      @dragover.prevent
      @drop.prevent="dropOnFolder(currentFolder ?? undefined)"
    >
      <!-- Folder cards (root, non-search) -->
      <template v-if="showFolders">
        <!-- New folder being created (inline name input) -->
        <div
          v-if="editingFolder && editingFolder.original === null"
          class="lib-folder-card editing"
        >
          <div class="lib-folder-cover">
            <div class="lib-folder-cover-empty">📁</div>
            <div class="lib-folder-meta">
              <input
                v-model="editingFolderName"
                v-focus
                class="lib-folder-name-input"
                type="text"
                maxlength="40"
                placeholder="文件夹名称"
                @click.stop
                @keydown.enter.stop.prevent="commitFolderEdit"
                @keydown.esc.stop.prevent="cancelFolderEdit"
                @blur="commitFolderEdit"
              />
            </div>
          </div>
        </div>

        <div
          v-for="folder in folderCards"
          :key="`folder-${folder.name}`"
          class="lib-folder-card"
          :class="{ 'drag-over': dragOverKey === folder.name, editing: isEditingFolder(folder.name) }"
          @click="isEditingFolder(folder.name) ? null : openFolder(folder.name)"
          @contextmenu.prevent.stop="openFolderMenu(folder.name, $event)"
          @dragover.prevent="onFolderDragOver(folder.name)"
          @dragleave="onFolderDragLeave(folder.name)"
          @drop.prevent.stop="dropOnFolder(folder.name)"
        >
          <div class="lib-folder-cover">
            <template v-if="folder.covers.length">
              <img v-for="(src, i) in folder.covers" :key="i" :src="src" alt="" draggable="false" />
            </template>
            <div v-else class="lib-folder-cover-empty">📁</div>
            <div class="lib-folder-meta">
              <input
                v-if="isEditingFolder(folder.name)"
                v-model="editingFolderName"
                v-focus
                class="lib-folder-name-input"
                type="text"
                maxlength="40"
                placeholder="文件夹名称"
                @click.stop
                @keydown.enter.stop.prevent="commitFolderEdit"
                @keydown.esc.stop.prevent="cancelFolderEdit"
                @blur="commitFolderEdit"
              />
              <span v-else class="lib-folder-name" :title="folder.name">📁 {{ folder.name }}</span>
              <span class="lib-folder-num">{{ folder.count }}</span>
            </div>
          </div>
        </div>
      </template>

      <!-- Image cards -->
      <div
        v-for="entry in visibleEntries"
        :key="entry.id"
        class="lib-card"
        :class="{ selected: selectedIds.has(entry.id), dragging: draggingIds.includes(entry.id) }"
        draggable="true"
        @click.stop="onImageClick(entry, $event)"
        @contextmenu.prevent.stop="openImageMenu(entry, $event)"
        @dragstart="onImageDragStart(entry, $event)"
        @dragend="onImageDragEnd"
      >
        <img :src="entry.dataUrl" :alt="entry.prompt" class="lib-thumb" loading="lazy" draggable="false" />
        <span class="lib-badge">{{ entry.mode === 'edit' ? '编辑' : '生成' }}</span>
        <span v-if="entry.folder && isSearching" class="lib-folder-badge">📁 {{ entry.folder }}</span>
        <button
          class="lib-check"
          :class="{ on: selectedIds.has(entry.id) }"
          type="button"
          :title="selectedIds.has(entry.id) ? '取消选择' : '选择'"
          @click.stop="onCheckClick(entry)"
          @dblclick.stop
        >✓</button>
        <div class="lib-card-caption">
          <span v-if="entry.tags?.length" class="lib-card-tags">{{ entry.tags.join(' · ') }}</span>
          <span v-else>{{ entry.prompt || '（无提示词）' }}</span>
        </div>
      </div>

      <!-- Empty state -->
      <div v-if="visibleEntries.length === 0 && !editingFolder && (!showFolders || folderCards.length === 0)" class="lib-empty">
        <template v-if="props.entries.length === 0">
          <p>还没有生成任何图片</p>
          <span>在工作台输入提示词并生成，结果会自动保存到这里</span>
        </template>
        <template v-else-if="isSearching">
          <p>没有匹配的图片</p>
          <span>尝试修改搜索条件</span>
        </template>
        <template v-else>
          <p>这里还没有图片</p>
          <span>把图片拖进来，或右键粘贴已剪切的图片</span>
        </template>
      </div>
    </div>

    <!-- Context menu -->
    <Teleport to="body">
      <div
        v-if="contextMenu"
        class="lib-menu"
        :style="{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }"
        @click.stop
        @contextmenu.prevent
      >
        <!-- Image menu -->
        <template v-if="contextMenu.kind === 'image'">
          <button v-if="menuSingleEntry" class="lib-menu-item" type="button" @click="openLightbox(menuSingleEntry!); closeContextMenu()">🔍 查看</button>
          <button class="lib-menu-item" type="button" @click="cutSelection(menuIds)">✂ 剪切</button>
          <div class="lib-menu-sub">
            <button class="lib-menu-item" type="button">➦ 移动到 ▸</button>
            <div class="lib-menu-flyout">
              <button v-if="currentFolder !== null" class="lib-menu-item" type="button" @click="moveTo(menuIds, undefined)">📂 全部图片（移出）</button>
              <button v-for="name in moveTargets" :key="name" class="lib-menu-item" type="button" @click="moveTo(menuIds, name)">📁 {{ name }}</button>
              <span v-if="moveTargets.length === 0 && currentFolder === null" class="lib-menu-hint">暂无其他文件夹</span>
            </div>
          </div>
          <button v-if="menuSingleEntry" class="lib-menu-item" type="button" @click="emit('useAsInput', menuSingleEntry!); closeContextMenu()">⇲ 作为编辑输入</button>
          <button v-if="menuSingleEntry" class="lib-menu-item" type="button" @click="emit('saveToFile', menuSingleEntry!); closeContextMenu()">⤓ 保存到文件</button>
          <div class="lib-menu-divider"></div>
          <button class="lib-menu-item danger" type="button" @click="deleteImages(menuIds)">🗑 删除{{ selectedCount > 1 ? `（${selectedCount}）` : '' }}</button>
        </template>

        <!-- Folder menu -->
        <template v-else-if="contextMenu.kind === 'folder'">
          <button class="lib-menu-item" type="button" @click="openFolder(contextMenu.folderName!)">📂 打开</button>
          <button class="lib-menu-item" type="button" @click="startRenameFolder(contextMenu.folderName!)">✎ 重命名</button>
          <button class="lib-menu-item" type="button" @click="exportFolder(contextMenu.folderName!)">⤓ 导出为 ZIP</button>
          <div class="lib-menu-divider"></div>
          <button class="lib-menu-item danger" type="button" @click="deleteFolder(contextMenu.folderName!)">🗑 删除文件夹</button>
        </template>

        <!-- Blank menu -->
        <template v-else>
          <button class="lib-menu-item" type="button" @click="startCreateFolder">📁 新建文件夹</button>
          <button class="lib-menu-item" type="button" :disabled="!canPaste" @click="paste">📋 粘贴{{ canPaste ? `（${clipboard.length}）` : '' }}</button>
          <button class="lib-menu-item" type="button" @click="emit('refresh'); closeContextMenu()">↻ 刷新</button>
        </template>
      </div>
    </Teleport>

    <!-- Lightbox -->
    <Teleport to="body">
      <div v-if="lightbox" class="lib-lightbox-overlay" @click.self="closeLightbox">
        <div class="lib-lightbox" @click.stop>
          <header class="lib-lightbox-header">
            <div class="lib-lightbox-heading">
              <span class="lib-lightbox-title">图片详情</span>
              <span class="lib-lightbox-subtitle">{{ lightbox.size }}<template v-if="lightbox.aspectRatio"> · {{ lightbox.aspectRatio }}</template></span>
            </div>
            <div class="lib-lightbox-toolbar">
              <button class="lib-lightbox-close" type="button" @click="closeLightbox">关闭</button>
            </div>
          </header>
          <div class="lib-lightbox-body">
            <ImagePreview class="lib-lightbox-preview" :src="lightbox.dataUrl" :alt="lightbox.prompt" />
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
                  <template v-if="lightbox.tags?.length">
                    <span v-for="tag in lightbox.tags" :key="tag" class="lib-tag-chip">{{ tag }}</span>
                  </template>
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
                <button class="lib-btn" type="button" @click="emit('regenerate', lightbox!); closeLightbox()">↻ 重新生成</button>
                <button class="lib-btn" type="button" @click="emit('load', lightbox!); closeLightbox()">✎ 载入参数</button>
                <button class="lib-btn" type="button" @click="emit('useAsInput', lightbox!); closeLightbox()">⇲ 作为编辑输入</button>
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

.lib-back {
  width: 26px;
  height: 26px;
  border: 1px solid var(--app-border-strong);
  border-radius: 8px;
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  cursor: pointer;
}
.lib-back:hover { background: var(--app-accent-soft); color: var(--app-text-strong); }

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

.lib-btn:hover:not(:disabled) { background: var(--app-accent-soft); color: var(--app-text-strong); }
.lib-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.lib-btn-danger { color: var(--app-danger); }
.lib-btn-danger:hover:not(:disabled) { background: rgba(220, 38, 38, 0.9); color: #fff; }

/* Breadcrumb */
.lib-breadcrumb { display: flex; align-items: center; gap: 8px; font-size: 0.82em; }
.lib-crumb {
  border: 1px solid transparent;
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  padding: 4px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.12s ease;
}
.lib-crumb:hover { color: var(--app-text-strong); }
.lib-crumb.active { color: var(--app-text-strong); }
.lib-crumb.drag-over { border-color: var(--app-accent); background: var(--app-accent-soft); color: var(--app-text-strong); }
.lib-crumb-sep { color: var(--app-text-faint); }
.lib-crumb-current { color: var(--app-text-strong); display: flex; align-items: center; gap: 6px; }
.lib-crumb-count { font-size: 0.85em; color: var(--app-text-faint); }

.lib-empty {
  grid-column: 1 / -1;
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
  align-content: start;
}

/* Folder cards — same size / shape as image cards */
.lib-folder-card {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--app-border);
  background: var(--app-panel);
  cursor: pointer;
  transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
}
.lib-folder-card:hover {
  transform: translateY(-2px);
  border-color: var(--app-border-strong);
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.22);
}
.lib-folder-card.drag-over {
  border-color: var(--app-accent);
  box-shadow: 0 0 0 2px var(--app-accent-glow);
}

.lib-folder-cover {
  aspect-ratio: 1 / 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 6px;
  padding: 16px;
  background: var(--app-panel-subtle);
}
.lib-folder-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}
.lib-folder-cover img:only-child {
  grid-column: 1 / -1;
  grid-row: 1 / -1;
}
.lib-folder-cover-empty {
  grid-column: 1 / -1;
  grid-row: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 2.4em;
  opacity: 0.5;
}

.lib-folder-meta {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 14px 8px 6px;
  background: linear-gradient(180deg, transparent, rgba(15, 23, 42, 0.82));
}
.lib-folder-name {
  font-size: 0.72em;
  color: #f1f5f9;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.lib-folder-num {
  flex-shrink: 0;
  font-size: 0.66em;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  color: #e2e8f0;
}

.lib-folder-card.editing { cursor: default; }
.lib-folder-card.editing:hover { transform: none; box-shadow: none; border-color: var(--app-accent); }

.lib-folder-name-input {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  border-radius: 6px;
  border: 1px solid var(--app-accent);
  background: rgba(15, 23, 42, 0.86);
  color: #f1f5f9;
  font-size: 0.72em;
  font-family: inherit;
}
.lib-folder-name-input:focus {
  outline: none;
  box-shadow: 0 0 0 2px var(--app-accent-glow);
}

/* Image cards */
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
.lib-card.selected { border-color: var(--app-accent); box-shadow: 0 0 0 2px var(--app-accent-glow); }
.lib-card.dragging { opacity: 0.5; }

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
  padding: 0;
  border-radius: 999px;
  border: 2px solid #fff;
  background: rgba(15, 23, 42, 0.5);
  color: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7em;
  font-weight: 700;
  cursor: pointer;
  /* Always visible so images can be multi-selected without a modifier key. */
  opacity: 0.85;
  transition: opacity 0.12s ease, background 0.12s ease, border-color 0.12s ease;
}
.lib-check:hover { opacity: 1; border-color: var(--app-accent); }
.lib-check.on { background: var(--app-accent); border-color: var(--app-accent); color: #fff; opacity: 1; }
.lib-card:hover .lib-check { opacity: 1; }

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

/* Context menu */
.lib-menu {
  position: fixed;
  z-index: 10300;
  min-width: 170px;
  padding: 6px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  box-shadow: var(--app-shadow);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.lib-menu-item {
  position: relative;
  text-align: left;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text-soft);
  font-size: 0.82em;
  cursor: pointer;
  transition: all 0.12s ease;
}
.lib-menu-item:hover:not(:disabled) { background: var(--app-accent-soft); color: var(--app-text-strong); }
.lib-menu-item:disabled { opacity: 0.4; cursor: not-allowed; }
.lib-menu-item.danger { color: var(--app-danger); }
.lib-menu-item.danger:hover { background: rgba(220, 38, 38, 0.16); }
.lib-menu-divider { height: 1px; margin: 4px 6px; background: var(--app-border); }

.lib-menu-sub { position: relative; }
.lib-menu-flyout {
  display: none;
  position: absolute;
  top: 0;
  left: 100%;
  min-width: 170px;
  max-height: 320px;
  overflow-y: auto;
  margin-left: 4px;
  padding: 6px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  box-shadow: var(--app-shadow);
  flex-direction: column;
  gap: 2px;
}
.lib-menu-sub:hover .lib-menu-flyout { display: flex; }
.lib-menu-hint { padding: 6px 10px; font-size: 0.76em; color: var(--app-text-faint); }

/* Lightbox */
.lib-lightbox-overlay {
  --lib-lightbox-top-offset: var(--app-titlebar-height, 46px);
  position: fixed;
  inset: var(--lib-lightbox-top-offset) 0 0 0;
  z-index: 10200;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 16px 24px 24px;
}

.lib-lightbox-overlay::before {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(4px);
  pointer-events: none;
}

.lib-lightbox {
  position: relative;
  width: min(1320px, calc(100vw - 48px));
  height: min(820px, calc(100vh - var(--lib-lightbox-top-offset) - 40px));
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-radius: 22px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-strong);
  box-shadow: var(--app-shadow);
  isolation: isolate;
}

.lib-lightbox-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--app-border);
}
.lib-lightbox-heading { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.lib-lightbox-title { font-size: 0.96rem; font-weight: 600; color: var(--app-text-strong); }
.lib-lightbox-subtitle { font-size: 0.78rem; color: var(--app-text-muted); }
.lib-lightbox-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lib-lightbox-close {
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--app-border-strong);
  border-radius: 999px;
  background: var(--app-panel-subtle);
  color: var(--app-text-strong);
  cursor: pointer;
}

.lib-lightbox-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 20px;
  padding: 20px;
  overflow: hidden;
}

.lib-lightbox-preview { min-width: 0; min-height: 0; }

.lib-meta {
  min-width: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 0.84em;
}
.lib-meta-row { display: flex; justify-content: space-between; gap: 12px; color: var(--app-text-soft); }
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

@media (max-width: 980px) {
  .lib-lightbox-body { grid-template-columns: minmax(0, 1fr); overflow: auto; }
  .lib-meta { overflow: visible; }
}

@media (max-width: 720px) {
  .lib-lightbox-overlay { padding: 12px; }
  .lib-lightbox {
    width: min(100vw - 24px, 1320px);
    height: calc(100vh - var(--lib-lightbox-top-offset) - 24px);
  }
  .lib-lightbox-header { align-items: flex-start; }
}
</style>
