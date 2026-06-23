<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ImageLibraryItem } from '../../../shared/image-studio-types'
import ImagePreview from './ImagePreview.vue'

const props = defineProps<{
  entries: ImageLibraryItem[]
  loading: boolean
  /** Persisted folder names (includes empty folders). */
  folderNames?: string[]
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'delete', ids: string[]): void
  (e: 'regenerate', entry: ImageLibraryItem): void
  (e: 'load', entry: ImageLibraryItem): void
  (e: 'useAsInput', entry: ImageLibraryItem): void
  (e: 'saveToFile', entry: ImageLibraryItem): void
  (e: 'updateFolder', ids: string[], folder: string | undefined): void
  (e: 'updateTags', id: string, tags: string[]): void
  (e: 'createFolder', name: string): void
  (e: 'exportFolder', name: string): void
  (e: 'renameFolder', oldName: string, newName: string): void
  (e: 'deleteFolder', name: string): void
}>()

const { t, locale } = useI18n()

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

const lightbox = ref<ImageLibraryItem | null>(null)
/** Source/input images (edit mode) for the open lightbox, fetched on demand. */
const lightboxSources = ref<string[]>([])
const editingTags = ref(false)
const tagInput = ref('')

const selectedCount = computed(() => selectedIds.value.size)

/** Map of folder name → entries inside it. */
const entriesByFolder = computed(() => {
  const map = new Map<string, ImageLibraryItem[]>()
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
      covers: list.slice(0, 4).map(e => e.thumbUrl)
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
})

const allFolderNames = computed(() => folderCards.value.map(f => f.name))

const unfiledEntries = computed(() => props.entries.filter(e => !e.folder))

function matchesQuery (entry: ImageLibraryItem, q: string): boolean {
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
  resetScroll()
}

function goRoot () {
  currentFolder.value = null
  selectedIds.value = new Set()
  resetScroll()
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
function onImageClick (entry: ImageLibraryItem, event: MouseEvent) {
  if (suppressClick) return // a marquee just ended; ignore its trailing click
  if (event.metaKey || event.ctrlKey) {
    toggleSelection(entry.id)
  } else {
    openLightbox(entry)
  }
}

/** The always-visible corner checkbox toggles selection without opening the preview. */
function onCheckClick (entry: ImageLibraryItem) {
  toggleSelection(entry.id)
}

function clearSelection () {
  selectedIds.value = new Set()
}

/** Click on empty grid space (viewport or sizer background) clears the selection. */
function onViewportClick (event: MouseEvent) {
  if (suppressClick) return
  if (isGridBackground(event.target)) {
    clearSelection()
    closeContextMenu()
  }
}

function onViewportContextMenu (event: MouseEvent) {
  if (!isGridBackground(event.target)) return // cards handle their own menus
  event.preventDefault()
  openBlankMenu(event)
}

/* ---- Select all (button + ⌘/Ctrl-A) ---- */

/** True when every image in the current view is already selected. */
const allVisibleSelected = computed(() =>
  visibleEntries.value.length > 0 && visibleEntries.value.every(e => selectedIds.value.has(e.id))
)

function selectAllVisible () {
  selectedIds.value = new Set(visibleEntries.value.map(e => e.id))
}

function toggleSelectAll () {
  if (allVisibleSelected.value) clearSelection()
  else selectAllVisible()
}

/* ---- Virtualized grid ---- */

/** Layout constants — must match the card sizing in CSS. */
const GAP = 12
const MIN_COL_W = 150
const OVERSCAN_ROWS = 2

const viewportRef = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportWidth = ref(0)
const viewportHeight = ref(0)
let resizeObserver: ResizeObserver | null = null

function clamp (value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

/** A single grid cell: the new-folder editor, a folder card, or an image card. */
interface GridCell {
  kind: 'new-folder' | 'folder' | 'image'
  key: string
  folder?: { name: string; count: number; covers: string[] }
  entry?: ImageLibraryItem
}

/** Folders (root view only) followed by the current view's images, as one flat list. */
const gridCells = computed<GridCell[]>(() => {
  const cells: GridCell[] = []
  if (showFolders.value) {
    if (editingFolder.value && editingFolder.value.original === null) {
      cells.push({ kind: 'new-folder', key: '__new_folder__' })
    }
    for (const folder of folderCards.value) {
      cells.push({ kind: 'folder', key: `folder-${folder.name}`, folder })
    }
  }
  for (const entry of visibleEntries.value) {
    cells.push({ kind: 'image', key: entry.id, entry })
  }
  return cells
})

const cols = computed(() => {
  const w = viewportWidth.value
  if (w <= 0) return 1
  return Math.max(1, Math.floor((w + GAP) / (MIN_COL_W + GAP)))
})
/** Actual square side of each card given the column count. */
const colW = computed(() => {
  const w = viewportWidth.value
  if (w <= 0) return MIN_COL_W
  return Math.max(1, (w - (cols.value - 1) * GAP) / cols.value)
})
/** Distance from one cell's edge to the next (square side + gap), used for both axes. */
const pitch = computed(() => colW.value + GAP)
const totalRows = computed(() => Math.ceil(gridCells.value.length / cols.value))
const totalHeight = computed(() => Math.max(0, totalRows.value * pitch.value - GAP))

const startRow = computed(() => Math.max(0, Math.floor(scrollTop.value / pitch.value) - OVERSCAN_ROWS))
const endRow = computed(() => {
  const rowsInView = Math.ceil(viewportHeight.value / pitch.value) + OVERSCAN_ROWS * 2 + 1
  return Math.min(totalRows.value, startRow.value + rowsInView)
})

interface PositionedCell { cell: GridCell; top: number; left: number }

/** Only the cells inside the window [startRow, endRow), each with its absolute offset. */
const visibleCells = computed<PositionedCell[]>(() => {
  const c = cols.value
  const p = pitch.value
  const cells = gridCells.value
  const out: PositionedCell[] = []
  const from = startRow.value * c
  const to = Math.min(cells.length, endRow.value * c)
  for (let i = from; i < to; i++) {
    out.push({ cell: cells[i], top: Math.floor(i / c) * p, left: (i % c) * p })
  }
  return out
})

function cellStyle (pc: PositionedCell): Record<string, string> {
  const side = `${colW.value}px`
  return { top: `${pc.top}px`, left: `${pc.left}px`, width: side, height: side }
}

function onScroll (event: Event) {
  scrollTop.value = (event.target as HTMLElement).scrollTop
}

function measureViewport () {
  const el = viewportRef.value
  if (!el) return
  viewportWidth.value = el.clientWidth
  viewportHeight.value = el.clientHeight
}

function resetScroll () {
  scrollTop.value = 0
  if (viewportRef.value) viewportRef.value.scrollTop = 0
}

/* ---- Marquee (box) selection ---- */

const marquee = reactive({ active: false, x0: 0, y0: 0, x1: 0, y1: 0 })
let marqueePending = false
let marqueeStartClientX = 0
let marqueeStartClientY = 0
let marqueePointerX = 0
let marqueePointerY = 0
let marqueeBase = new Set<string>()
let marqueeRaf = 0
/** Set briefly when a marquee ends so the trailing click doesn't open/clear. */
let suppressClick = false

/** Rectangle in content (scrolled) coordinates. */
const marqueeRect = computed(() => ({
  left: Math.min(marquee.x0, marquee.x1),
  top: Math.min(marquee.y0, marquee.y1),
  width: Math.abs(marquee.x1 - marquee.x0),
  height: Math.abs(marquee.y1 - marquee.y0)
}))

/** True only for the scroll container itself or the sizer backdrop (not a card). */
function isGridBackground (target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el === viewportRef.value || el.classList.contains('lib-grid-sizer')
}

function onGridMouseDown (event: MouseEvent) {
  if (event.button !== 0 || !isGridBackground(event.target)) return
  const el = viewportRef.value
  if (!el) return
  event.preventDefault() // suppress native text/selection drag
  const rect = el.getBoundingClientRect()
  const x = clamp(event.clientX - rect.left, 0, el.clientWidth)
  const y = clamp(event.clientY - rect.top + el.scrollTop, 0, totalHeight.value)
  marquee.x0 = marquee.x1 = x
  marquee.y0 = marquee.y1 = y
  marquee.active = false
  marqueePending = true
  marqueeStartClientX = event.clientX
  marqueeStartClientY = event.clientY
  marqueePointerX = event.clientX
  marqueePointerY = event.clientY
  // Shift / ⌘ / Ctrl add to the existing selection; a plain drag replaces it.
  marqueeBase = (event.shiftKey || event.metaKey || event.ctrlKey) ? new Set(selectedIds.value) : new Set()
  window.addEventListener('mousemove', onMarqueeMouseMove)
  window.addEventListener('mouseup', onMarqueeMouseUp)
  marqueeRaf = requestAnimationFrame(marqueeTick)
}

function onMarqueeMouseMove (event: MouseEvent) {
  marqueePointerX = event.clientX
  marqueePointerY = event.clientY
  if (marqueePending && !marquee.active &&
    (Math.abs(event.clientX - marqueeStartClientX) > 4 || Math.abs(event.clientY - marqueeStartClientY) > 4)) {
    marquee.active = true
  }
}

/** Per-frame: edge auto-scroll + recompute the rectangle and its hit set. */
function marqueeTick () {
  const el = viewportRef.value
  if (!el || (!marquee.active && !marqueePending)) { marqueeRaf = 0; return }
  if (marquee.active) {
    const rect = el.getBoundingClientRect()
    const EDGE = 48
    const MAX_SPEED = 24
    if (marqueePointerY < rect.top + EDGE) {
      el.scrollTop -= MAX_SPEED * Math.min(1, (rect.top + EDGE - marqueePointerY) / EDGE)
    } else if (marqueePointerY > rect.bottom - EDGE) {
      el.scrollTop += MAX_SPEED * Math.min(1, (marqueePointerY - (rect.bottom - EDGE)) / EDGE)
    }
    scrollTop.value = el.scrollTop
    marquee.x1 = clamp(marqueePointerX - rect.left, 0, el.clientWidth)
    marquee.y1 = clamp(marqueePointerY - rect.top + el.scrollTop, 0, totalHeight.value)
    applyMarqueeSelection()
  }
  marqueeRaf = requestAnimationFrame(marqueeTick)
}

/** Select every image card whose box intersects the marquee rectangle. */
function applyMarqueeSelection () {
  const r = marqueeRect.value
  const minX = r.left, maxX = r.left + r.width
  const minY = r.top, maxY = r.top + r.height
  const c = cols.value
  const p = pitch.value
  const side = colW.value
  const cells = gridCells.value
  const next = new Set(marqueeBase)
  const colA = clamp(Math.floor(minX / p), 0, c - 1)
  const colB = clamp(Math.floor(maxX / p), 0, c - 1)
  const rowA = Math.max(0, Math.floor(minY / p))
  const rowB = Math.floor(maxY / p)
  for (let row = rowA; row <= rowB; row++) {
    const top = row * p
    if (top > maxY || top + side < minY) continue
    for (let col = colA; col <= colB; col++) {
      const left = col * p
      if (left > maxX || left + side < minX) continue
      const idx = row * c + col
      if (idx >= cells.length) continue
      const cell = cells[idx]
      if (cell.kind === 'image' && cell.entry) next.add(cell.entry.id)
    }
  }
  selectedIds.value = next
}

function onMarqueeMouseUp () {
  window.removeEventListener('mousemove', onMarqueeMouseMove)
  window.removeEventListener('mouseup', onMarqueeMouseUp)
  if (marqueeRaf) { cancelAnimationFrame(marqueeRaf); marqueeRaf = 0 }
  const wasActive = marquee.active
  marquee.active = false
  marqueePending = false
  if (wasActive) {
    suppressClick = true
    setTimeout(() => { suppressClick = false }, 0)
  }
}

/* ---- Drag images into folders ---- */

function effectiveIds (entryId: string): string[] {
  return selectedIds.value.has(entryId) ? [...selectedIds.value] : [entryId]
}

function onImageDragStart (entry: ImageLibraryItem, event: DragEvent) {
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

function uniqueFolderName (base = t('launchpad.newFolder')): string {
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
  resetScroll() // the editor card sits at the top of the grid
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
  if (window.confirm(t('studioUi.deleteFolderConfirm', { name }))) {
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

function openImageMenu (entry: ImageLibraryItem, event: MouseEvent) {
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
const menuSingleEntry = computed<ImageLibraryItem | null>(() => {
  if (selectedIds.value.size !== 1) return null
  const id = [...selectedIds.value][0]
  return props.entries.find(e => e.id === id) ?? null
})
/** Folders an image can be moved to (exclude the current one). */
const moveTargets = computed(() => allFolderNames.value.filter(n => n !== currentFolder.value))

/* ---- Lightbox ---- */

/** Show an image in the lightbox, (re)fetching its edit-mode source images on demand. */
function setLightbox (entry: ImageLibraryItem) {
  lightbox.value = entry
  editingTags.value = false
  tagInput.value = entry.tags?.join(', ') ?? ''
  // Edit-mode source images are not part of the lightweight item; fetch on demand.
  lightboxSources.value = []
  if (entry.mode === 'edit' && window.electronAPI?.getImageLibraryData) {
    const targetId = entry.id
    void window.electronAPI.getImageLibraryData(targetId).then((data) => {
      if (lightbox.value?.id === targetId) {
        lightboxSources.value = data?.sourceDataUrls ?? []
      }
    }).catch(() => { /* ignore */ })
  }
}

function openLightbox (entry: ImageLibraryItem) {
  setLightbox(entry)
}

function closeLightbox () {
  lightbox.value = null
}

/* ---- Lightbox prev/next within the current view (same folder / search / unfiled) ---- */

const lightboxIndex = computed(() =>
  lightbox.value ? visibleEntries.value.findIndex(e => e.id === lightbox.value!.id) : -1
)
const hasPrevImage = computed(() => lightboxIndex.value > 0)
const hasNextImage = computed(() =>
  lightboxIndex.value >= 0 && lightboxIndex.value < visibleEntries.value.length - 1
)

function showPrevImage () {
  if (hasPrevImage.value) setLightbox(visibleEntries.value[lightboxIndex.value - 1])
}

function showNextImage () {
  if (hasNextImage.value) setLightbox(visibleEntries.value[lightboxIndex.value + 1])
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
    return new Date(iso).toLocaleString(locale.value, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

/** The panel is detached (clientWidth 0) while cached by <KeepAlive>; ignore global keys then. */
function isPanelVisible (): boolean {
  return !!viewportRef.value && viewportRef.value.clientWidth > 0
}

function onWindowKeydown (event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (contextMenu.value) { closeContextMenu(); return }
    if (lightbox.value) { closeLightbox(); return }
    if (selectedIds.value.size) clearSelection()
    return
  }
  // Arrow keys page through images while the lightbox is open.
  if (lightbox.value) {
    if (event.key === 'ArrowRight') { event.preventDefault(); showNextImage() }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); showPrevImage() }
    return
  }
  // ⌘/Ctrl-A selects every image in the current view (only when the panel is visible
  // and the user isn't typing in a field).
  if ((event.metaKey || event.ctrlKey) && (event.key === 'a' || event.key === 'A')) {
    if (!isPanelVisible() || visibleEntries.value.length === 0) return
    const target = event.target as HTMLElement | null
    const tag = target?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
    event.preventDefault()
    selectAllVisible()
  }
}

// Reset scroll when the search query changes the result set.
watch(() => searchQuery.value, () => { resetScroll() })

// If the browsed folder disappears (renamed/deleted upstream), fall back to root.
watch(() => props.folderNames, (names) => {
  if (currentFolder.value !== null && names && !names.includes(currentFolder.value)) {
    currentFolder.value = null
  }
})

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('click', closeContextMenu)
  measureViewport()
  if (viewportRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => measureViewport())
    resizeObserver.observe(viewportRef.value)
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('click', closeContextMenu)
  window.removeEventListener('mousemove', onMarqueeMouseMove)
  window.removeEventListener('mouseup', onMarqueeMouseUp)
  if (marqueeRaf) cancelAnimationFrame(marqueeRaf)
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <section class="lib">
    <header class="lib-header">
      <div class="lib-title">
        <button v-if="currentFolder !== null" class="lib-back" type="button" :title="$t('common.back')" @click="goRoot">←</button>
        <span>🖼️ {{ $t('studioUi.imageLibrary') }}</span>
        <span class="lib-count">{{ visibleEntries.length }}</span>
      </div>
      <div class="lib-actions">
        <input v-model="searchQuery" class="lib-search" type="text" :placeholder="$t('studioUi.librarySearchPlaceholder')" />
        <button
          class="lib-btn"
          type="button"
          :disabled="visibleEntries.length === 0"
          :title="allVisibleSelected ? $t('studioUi.cancelSelectAll') : $t('studioUi.selectAllCurrentView')"
          @click="toggleSelectAll"
        >
          {{ allVisibleSelected ? $t('studioUi.cancelSelectAllWithIcon') : $t('studioUi.selectAllWithIcon') }}
          <span v-if="selectedCount" class="lib-sel-count">{{ selectedCount }}</span>
        </button>
        <button class="lib-btn" type="button" @click="startCreateFolder">＋ {{ $t('launchpad.newFolder') }}</button>
        <button class="lib-btn" type="button" :disabled="props.loading" @click="emit('refresh')">↻ {{ $t('launchpad.refresh') }}</button>
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
      >📂 {{ $t('studioUi.allImages') }}</button>
      <template v-if="isSearching">
        <span class="lib-crumb-sep">/</span>
        <span class="lib-crumb-current">{{ $t('studioUi.searchResults') }}</span>
      </template>
      <template v-else-if="currentFolder !== null">
        <span class="lib-crumb-sep">/</span>
        <span class="lib-crumb-current">📁 {{ currentFolder }} <span class="lib-crumb-count">{{ currentFolderCount }}</span></span>
      </template>
    </nav>

    <div
      ref="viewportRef"
      class="lib-grid-viewport"
      @scroll="onScroll"
      @mousedown="onGridMouseDown"
      @click="onViewportClick"
      @contextmenu="onViewportContextMenu"
      @dragover.prevent
      @drop.prevent="dropOnFolder(currentFolder ?? undefined)"
    >
      <div class="lib-grid-sizer" :style="{ height: `${totalHeight}px` }">
        <template v-for="pc in visibleCells" :key="pc.cell.key">
          <!-- New folder being created (inline name input) -->
          <div
            v-if="pc.cell.kind === 'new-folder'"
            class="lib-cell lib-folder-card editing"
            :style="cellStyle(pc)"
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
                  :placeholder="$t('studioUi.folderNamePlaceholder')"
                  @click.stop
                  @keydown.enter.stop.prevent="commitFolderEdit"
                  @keydown.esc.stop.prevent="cancelFolderEdit"
                  @blur="commitFolderEdit"
                />
              </div>
            </div>
          </div>

          <!-- Folder card -->
          <div
            v-else-if="pc.cell.kind === 'folder'"
            class="lib-cell lib-folder-card"
            :class="{ 'drag-over': dragOverKey === pc.cell.folder!.name, editing: isEditingFolder(pc.cell.folder!.name) }"
            :style="cellStyle(pc)"
            @click="isEditingFolder(pc.cell.folder!.name) ? null : openFolder(pc.cell.folder!.name)"
            @contextmenu.prevent.stop="openFolderMenu(pc.cell.folder!.name, $event)"
            @dragover.prevent="onFolderDragOver(pc.cell.folder!.name)"
            @dragleave="onFolderDragLeave(pc.cell.folder!.name)"
            @drop.prevent.stop="dropOnFolder(pc.cell.folder!.name)"
          >
            <div class="lib-folder-cover">
              <template v-if="pc.cell.folder!.covers.length">
                <img v-for="(src, i) in pc.cell.folder!.covers" :key="i" :src="src" alt="" draggable="false" />
              </template>
              <div v-else class="lib-folder-cover-empty">📁</div>
              <div class="lib-folder-meta">
                <input
                  v-if="isEditingFolder(pc.cell.folder!.name)"
                  v-model="editingFolderName"
                  v-focus
                  class="lib-folder-name-input"
                  type="text"
                  maxlength="40"
                  :placeholder="$t('studioUi.folderNamePlaceholder')"
                  @click.stop
                  @keydown.enter.stop.prevent="commitFolderEdit"
                  @keydown.esc.stop.prevent="cancelFolderEdit"
                  @blur="commitFolderEdit"
                />
                <span v-else class="lib-folder-name" :title="pc.cell.folder!.name">📁 {{ pc.cell.folder!.name }}</span>
                <span class="lib-folder-num">{{ pc.cell.folder!.count }}</span>
              </div>
            </div>
          </div>

          <!-- Image card -->
          <div
            v-else
            class="lib-cell lib-card"
            :class="{ selected: selectedIds.has(pc.cell.entry!.id), dragging: draggingIds.includes(pc.cell.entry!.id) }"
            :style="cellStyle(pc)"
            draggable="true"
            @click.stop="onImageClick(pc.cell.entry!, $event)"
            @contextmenu.prevent.stop="openImageMenu(pc.cell.entry!, $event)"
            @dragstart="onImageDragStart(pc.cell.entry!, $event)"
            @dragend="onImageDragEnd"
          >
            <img :src="pc.cell.entry!.thumbUrl" :alt="pc.cell.entry!.prompt" class="lib-thumb" decoding="async" draggable="false" />
            <span class="lib-badge">{{ pc.cell.entry!.mode === 'edit' ? $t('studioUi.editModeShort') : $t('studioUi.generateModeShort') }}</span>
            <span v-if="pc.cell.entry!.folder && isSearching" class="lib-folder-badge">📁 {{ pc.cell.entry!.folder }}</span>
            <button
              class="lib-check"
              :class="{ on: selectedIds.has(pc.cell.entry!.id) }"
              type="button"
              :title="selectedIds.has(pc.cell.entry!.id) ? $t('studioUi.cancelSelection') : $t('studioUi.select')"
              @click.stop="onCheckClick(pc.cell.entry!)"
              @dblclick.stop
            >✓</button>
            <div class="lib-card-caption">
              <span v-if="pc.cell.entry!.tags?.length" class="lib-card-tags">{{ pc.cell.entry!.tags!.join(' · ') }}</span>
              <span v-else>{{ pc.cell.entry!.prompt || $t('studioUi.noPrompt') }}</span>
            </div>
          </div>
        </template>

        <!-- Marquee (box) selection rectangle -->
        <div
          v-if="marquee.active"
          class="lib-marquee"
          :style="{ left: `${marqueeRect.left}px`, top: `${marqueeRect.top}px`, width: `${marqueeRect.width}px`, height: `${marqueeRect.height}px` }"
        ></div>
      </div>

      <!-- Empty state -->
      <div v-if="gridCells.length === 0" class="lib-empty">
        <template v-if="props.entries.length === 0">
          <p>{{ $t('studioUi.libraryEmptyTitle') }}</p>
          <span>{{ $t('studioUi.libraryEmptyHint') }}</span>
        </template>
        <template v-else-if="isSearching">
          <p>{{ $t('studioUi.noMatchingImages') }}</p>
          <span>{{ $t('studioUi.adjustSearchHint') }}</span>
        </template>
        <template v-else>
          <p>{{ $t('studioUi.folderEmptyTitle') }}</p>
          <span>{{ $t('studioUi.folderEmptyHint') }}</span>
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
          <button v-if="menuSingleEntry" class="lib-menu-item" type="button" @click="openLightbox(menuSingleEntry!); closeContextMenu()">🔍 {{ $t('studioUi.view') }}</button>
          <button class="lib-menu-item" type="button" @click="cutSelection(menuIds)">✂ {{ $t('studioUi.cut') }}</button>
          <div class="lib-menu-sub">
            <button class="lib-menu-item" type="button">➦ {{ $t('studioUi.moveTo') }} ▸</button>
            <div class="lib-menu-flyout">
              <button v-if="currentFolder !== null" class="lib-menu-item" type="button" @click="moveTo(menuIds, undefined)">📂 {{ $t('studioUi.allImagesMoveOut') }}</button>
              <button v-for="name in moveTargets" :key="name" class="lib-menu-item" type="button" @click="moveTo(menuIds, name)">📁 {{ name }}</button>
              <span v-if="moveTargets.length === 0 && currentFolder === null" class="lib-menu-hint">{{ $t('studioUi.noOtherFolders') }}</span>
            </div>
          </div>
          <button v-if="menuSingleEntry" class="lib-menu-item" type="button" @click="emit('useAsInput', menuSingleEntry!); closeContextMenu()">⇲ {{ $t('studioUi.useAsInput') }}</button>
          <button v-if="menuSingleEntry" class="lib-menu-item" type="button" @click="emit('saveToFile', menuSingleEntry!); closeContextMenu()">⤓ {{ $t('studioUi.saveToFile') }}</button>
          <div class="lib-menu-divider"></div>
          <button class="lib-menu-item danger" type="button" @click="deleteImages(menuIds)">🗑 {{ selectedCount > 1 ? $t('studioUi.deleteCount', { count: selectedCount }) : $t('common.delete') }}</button>
        </template>

        <!-- Folder menu -->
        <template v-else-if="contextMenu.kind === 'folder'">
          <button class="lib-menu-item" type="button" @click="openFolder(contextMenu.folderName!)">📂 {{ $t('common.open') }}</button>
          <button class="lib-menu-item" type="button" @click="startRenameFolder(contextMenu.folderName!)">✎ {{ $t('common.rename') }}</button>
          <button class="lib-menu-item" type="button" @click="exportFolder(contextMenu.folderName!)">⤓ {{ $t('studioUi.exportZip') }}</button>
          <div class="lib-menu-divider"></div>
          <button class="lib-menu-item danger" type="button" @click="deleteFolder(contextMenu.folderName!)">🗑 {{ $t('launchpad.deleteFolder') }}</button>
        </template>

        <!-- Blank menu -->
        <template v-else>
          <button class="lib-menu-item" type="button" @click="startCreateFolder">📁 {{ $t('launchpad.newFolder') }}</button>
          <button class="lib-menu-item" type="button" :disabled="!canPaste" @click="paste">📋 {{ canPaste ? $t('studioUi.pasteCount', { count: clipboard.length }) : $t('studioUi.paste') }}</button>
          <button class="lib-menu-item" type="button" @click="emit('refresh'); closeContextMenu()">↻ {{ $t('launchpad.refresh') }}</button>
        </template>
      </div>
    </Teleport>

    <!-- Lightbox -->
    <Teleport to="body">
      <div v-if="lightbox" class="lib-lightbox-overlay" @click.self="closeLightbox">
        <div class="lib-lightbox" @click.stop>
          <header class="lib-lightbox-header">
            <div class="lib-lightbox-heading">
              <span class="lib-lightbox-title">{{ $t('studioUi.imageDetails') }}</span>
              <span class="lib-lightbox-subtitle">
                <span v-if="lightboxIndex >= 0" class="lib-lightbox-pos">{{ lightboxIndex + 1 }} / {{ visibleEntries.length }}</span>
                {{ lightbox.size }}<template v-if="lightbox.aspectRatio"> · {{ lightbox.aspectRatio }}</template>
              </span>
            </div>
            <div class="lib-lightbox-toolbar">
              <button class="lib-lightbox-close" type="button" @click="closeLightbox">{{ $t('common.close') }}</button>
            </div>
          </header>
          <div class="lib-lightbox-body">
            <div class="lib-lightbox-stage">
              <ImagePreview class="lib-lightbox-preview" :src="lightbox.fullUrl" :alt="lightbox.prompt" />
              <button
                v-if="hasPrevImage"
                class="lib-lightbox-nav prev"
                type="button"
                :title="$t('studioUi.previousImageShortcut')"
                @click.stop="showPrevImage"
              >‹</button>
              <button
                v-if="hasNextImage"
                class="lib-lightbox-nav next"
                type="button"
                :title="$t('studioUi.nextImageShortcut')"
                @click.stop="showNextImage"
              >›</button>
            </div>
            <div class="lib-meta">
              <div class="lib-meta-row"><span class="lib-meta-key">{{ $t('studioUi.mode') }}</span><span>{{ lightbox.mode === 'edit' ? $t('studioUi.imageEdit') : $t('studioUi.textToImage') }}</span></div>
              <div class="lib-meta-row"><span class="lib-meta-key">{{ $t('studioUi.model') }}</span><span>{{ lightbox.model }}</span></div>
              <div class="lib-meta-row"><span class="lib-meta-key">{{ $t('studioUi.size') }}</span><span>{{ lightbox.size }}<template v-if="lightbox.aspectRatio"> · {{ lightbox.aspectRatio }}</template></span></div>
              <div class="lib-meta-row"><span class="lib-meta-key">{{ $t('studioUi.time') }}</span><span>{{ formatTime(lightbox.createdAt) }}</span></div>
              <div v-if="lightbox.folder" class="lib-meta-row"><span class="lib-meta-key">{{ $t('studioUi.folder') }}</span><span>📁 {{ lightbox.folder }}</span></div>
              <div class="lib-meta-block">
                <span class="lib-meta-key">{{ $t('studioUi.prompt') }}</span>
                <p class="lib-meta-text">{{ lightbox.prompt || $t('studioUi.none') }}</p>
              </div>
              <div v-if="lightbox.negativePrompt" class="lib-meta-block">
                <span class="lib-meta-key">{{ $t('studioUi.negativePrompt') }}</span>
                <p class="lib-meta-text">{{ lightbox.negativePrompt }}</p>
              </div>
              <div class="lib-meta-block">
                <span class="lib-meta-key">
                  {{ $t('studioUi.tags') }}
                  <button v-if="!editingTags" class="lib-tag-edit-btn" type="button" @click="startEditTags">✎</button>
                </span>
                <div v-if="editingTags" class="lib-tag-editor">
                  <input v-model="tagInput" class="lib-tag-input" type="text" :placeholder="$t('studioUi.tagInputPlaceholder')" @keydown.enter="saveTags" />
                  <div class="lib-tag-editor-actions">
                    <button class="lib-btn" type="button" @click="saveTags">{{ $t('common.save') }}</button>
                    <button class="lib-btn" type="button" @click="cancelEditTags">{{ $t('common.cancel') }}</button>
                  </div>
                </div>
                <div v-else class="lib-tags-display">
                  <template v-if="lightbox.tags?.length">
                    <span v-for="tag in lightbox.tags" :key="tag" class="lib-tag-chip">{{ tag }}</span>
                  </template>
                  <span v-else class="lib-tag-empty">{{ $t('studioUi.noTagsAddHint') }}</span>
                </div>
              </div>
              <div v-if="lightboxSources.length" class="lib-meta-block">
                <span class="lib-meta-key">{{ $t('studioUi.editInputImages') }}</span>
                <div class="lib-source-row">
                  <img v-for="(src, i) in lightboxSources" :key="i" :src="src" class="lib-source-thumb" alt="" />
                </div>
              </div>
              <div class="lib-lightbox-actions">
                <button class="lib-btn" type="button" @click="emit('regenerate', lightbox!); closeLightbox()">↻ {{ $t('studioUi.regenerate') }}</button>
                <button class="lib-btn" type="button" @click="emit('load', lightbox!); closeLightbox()">✎ {{ $t('studioUi.loadParams') }}</button>
                <button class="lib-btn" type="button" @click="emit('useAsInput', lightbox!); closeLightbox()">⇲ {{ $t('studioUi.useAsInput') }}</button>
                <button class="lib-btn" type="button" @click="emit('saveToFile', lightbox!)">⤓ {{ $t('studioUi.saveToFile') }}</button>
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

.lib-sel-count {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--app-accent);
  color: #fff;
  font-size: 0.86em;
}

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

/*
 * Virtualized grid. The viewport scrolls; the sizer is a full-height spacer whose
 * children are absolutely positioned, so only the windowed cells (≈ a screenful +
 * overscan) ever exist in the DOM regardless of library size. Each cell is an exact
 * square laid out by JS — no CSS grid, so positions never drift across rows.
 */
.lib-grid-viewport {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-bottom: 4px;
}

.lib-grid-sizer {
  position: relative;
  width: 100%;
}

.lib-cell {
  position: absolute;
  box-sizing: border-box;
}

/* Marquee (box) selection rectangle, drawn in content coordinates. */
.lib-marquee {
  position: absolute;
  z-index: 6;
  border: 1px solid var(--app-accent);
  background: var(--app-accent-soft);
  opacity: 0.55;
  border-radius: 4px;
  pointer-events: none;
}

/* Folder cards — same size / shape as image cards */
.lib-folder-card {
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--app-border);
  background: var(--app-panel);
  cursor: pointer;
  transition: transform 0.14s ease, border-color 0.14s ease;
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
  height: 100%;
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
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--app-border);
  background: var(--app-panel);
  cursor: pointer;
  transition: transform 0.14s ease, border-color 0.14s ease;
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
  height: 100%;
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
  --lib-lightbox-top-offset: var(--app-titlebar-height, 38px);
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

/* Prev/next image navigation, flanking the image inside the preview stage. */
.lib-lightbox-stage {
  position: relative;
  min-width: 0;
  min-height: 0;
}

.lib-lightbox-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  /* Resting state: bare translucent glyph, no chrome, to stay out of the way. */
  background: transparent;
  color: #fff;
  font-size: 1.9em;
  line-height: 1;
  cursor: pointer;
  opacity: 0.5;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.55);
  transition: opacity 0.16s ease, background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
}
/* Hover: reveal a semi-transparent frosted-glass button. */
.lib-lightbox-nav:hover {
  opacity: 1;
  background: rgba(15, 23, 42, 0.42);
  border-color: rgba(255, 255, 255, 0.22);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  text-shadow: none;
}
.lib-lightbox-nav.prev { left: 10px; }
.lib-lightbox-nav.next { right: 10px; }

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
.lib-lightbox-pos {
  margin-right: 8px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
}
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
