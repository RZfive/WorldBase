<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import ContextMenu from './ContextMenu.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import LaunchpadGrid from './LaunchpadGrid.vue'
import FolderBubble from './FolderBubble.vue'
import type { LaunchFolder, Project, ProjectRuntime } from './types'

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

const emit = defineEmits<{
  (e: 'select', project: Project): void
  (e: 'viewSource', project: Project): void
  (e: 'optimizeInChat', project: Project): void
  (e: 'appStarted'): void
  (e: 'close'): void
}>()

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const projects = ref<Project[]>([])
const folders = ref<LaunchFolder[]>([])
const isLoading = ref(false)
const error = ref<string | null>(null)
const searchQuery = ref('')
const searchRef = ref<HTMLInputElement | null>(null)

// Folder popup
const openFolderId = ref<string | null>(null)
const folderPopupAnchor = ref<{ x: number; y: number }>({ x: 0, y: 0 })

// Drag state
const dragItem = ref<{ id: string; type: 'project' } | null>(null)
const dropTarget = ref<{ id: string; type: 'project' | 'folder' } | null>(null)
const dragOverlay = ref<{ x: number; y: number; label: string } | null>(null)

// Context menu
const ctxMenu = ref<{ visible: boolean; x: number; y: number; target: Project | LaunchFolder | null; kind: 'project' | 'folder' | 'blank' }>({
  visible: false, x: 0, y: 0, target: null, kind: 'blank'
})

// Rename state
const renamingId = ref<string | null>(null)
const renameInput = ref('')

// Confirm dialog
const confirmDialog = ref<{ visible: boolean; message: string; onConfirm: (() => void) | null }>({
  visible: false, message: '', onConfirm: null
})

let projectChangedCleanup: (() => void) | null = null

/* ------------------------------------------------------------------ */
/* Computed                                                            */
/* ------------------------------------------------------------------ */

const folderedIds = computed(() => {
  const s = new Set<string>()
  folders.value.forEach(f => f.projectIds.forEach(id => s.add(id)))
  return s
})

const unfolderedProjects = computed(() =>
  projects.value.filter(p => !folderedIds.value.has(p.id))
)

const filteredUnfoldered = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return unfolderedProjects.value
  return unfolderedProjects.value.filter(p =>
    (p.name || p.id).toLowerCase().includes(q) || (p.type || '').toLowerCase().includes(q)
  )
})

const filteredFolders = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return folders.value
  return folders.value.filter(f => {
    if (f.name.toLowerCase().includes(q)) return true
    return f.projectIds.some(id => {
      const p = projects.value.find(pr => pr.id === id)
      return p && (p.name || p.id).toLowerCase().includes(q)
    })
  })
})

/** All items in display order: folders first, then unfoldered projects */
const gridItems = computed(() => {
  const items: Array<{ kind: 'folder'; data: LaunchFolder } | { kind: 'project'; data: Project }> = []
  filteredFolders.value.forEach(f => items.push({ kind: 'folder', data: f }))
  filteredUnfoldered.value.forEach(p => items.push({ kind: 'project', data: p }))
  return items
})

const openFolderData = computed(() => {
  if (!openFolderId.value) return null
  return folders.value.find(f => f.id === openFolderId.value) || null
})

const openFolderProjects = computed(() => {
  if (!openFolderData.value) return []
  return openFolderData.value.projectIds
    .map(id => projects.value.find(p => p.id === id))
    .filter(Boolean) as Project[]
})

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

async function loadProjects () {
  isLoading.value = true
  error.value = null
  try {
    if (window.electronAPI) {
      projects.value = await window.electronAPI.listProjects() as Project[]
    }
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    isLoading.value = false
  }
}

function saveFolders () {
  try { localStorage.setItem('launchpad-folders', JSON.stringify(folders.value)) } catch { /* ignore */ }
}

function loadFolders () {
  try {
    const raw = localStorage.getItem('launchpad-folders')
    if (raw) folders.value = JSON.parse(raw)
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* Folder CRUD                                                         */
/* ------------------------------------------------------------------ */

function createFolderWith (projIdA: string, projIdB: string) {
  const sourceFolderIds = folders.value
    .filter(f => f.projectIds.includes(projIdA) || f.projectIds.includes(projIdB))
    .map(f => f.id)
  const name = '新文件夹'
  const id = 'folder_' + Date.now().toString(36)
  folders.value.forEach(f => {
    f.projectIds = f.projectIds.filter(pid => pid !== projIdA && pid !== projIdB)
  })
  folders.value.push({ id, name, projectIds: [projIdA, projIdB] })
  sourceFolderIds.forEach(cleanupFolderAfterMove)
  saveFolders()
  openFolderId.value = id
  renamingId.value = id
  renameInput.value = name
  return id
}

function createEmptyFolder () {
  const id = 'folder_' + Date.now().toString(36)
  folders.value.push({ id, name: '新文件夹', projectIds: [] })
  saveFolders()
  // Start renaming
  renamingId.value = id
  renameInput.value = '新文件夹'
}

function deleteFolder (folderId: string) {
  folders.value = folders.value.filter(f => f.id !== folderId)
  saveFolders()
  openFolderId.value = null
}

function startRenameFolder (folder: LaunchFolder) {
  renamingId.value = folder.id
  renameInput.value = folder.name
}

function commitRename (folderId: string) {
  const folder = folders.value.find(f => f.id === folderId)
  if (folder && renameInput.value.trim()) {
    folder.name = renameInput.value.trim()
    saveFolders()
  }
  renamingId.value = null
}

function cleanupFolderAfterMove (folderId: string) {
  const folder = folders.value.find(f => f.id === folderId)
  if (!folder || folder.projectIds.length > 1) return
  folders.value = folders.value.filter(f => f.id !== folderId)
  if (openFolderId.value === folderId) openFolderId.value = null
}

function moveToFolder (projectId: string, folderId: string) {
  const sourceFolderIds = folders.value
    .filter(f => f.projectIds.includes(projectId))
    .map(f => f.id)
  folders.value.forEach(f => { f.projectIds = f.projectIds.filter(id => id !== projectId) })
  const folder = folders.value.find(f => f.id === folderId)
  if (folder && !folder.projectIds.includes(projectId)) folder.projectIds.push(projectId)
  sourceFolderIds
    .filter(id => id !== folderId)
    .forEach(cleanupFolderAfterMove)
  saveFolders()
}

function removeFromFolder (projectId: string) {
  const sourceFolderIds = folders.value
    .filter(f => f.projectIds.includes(projectId))
    .map(f => f.id)
  folders.value.forEach(f => { f.projectIds = f.projectIds.filter(id => id !== projectId) })
  sourceFolderIds.forEach(cleanupFolderAfterMove)
  saveFolders()
}

/* ------------------------------------------------------------------ */
/* Project actions                                                     */
/* ------------------------------------------------------------------ */

function getIcon (type?: string) {
  if (type === 'frontend') return '🎨'
  if (type === 'backend') return '⚙️'
  if (type === 'fullstack') return '🚀'
  return '📦'
}

async function startProject (project: Project) {
  if (!window.electronAPI) return
  try {
    await window.electronAPI.startProject(project.id)
    emit('appStarted')
    await loadProjects()
  } catch (err) { console.error('Failed to start project:', err) }
}

async function stopProject (project: Project) {
  if (!window.electronAPI) return
  try {
    await window.electronAPI.stopProject(project.id)
    await loadProjects()
  } catch (err) { console.error('Failed to stop project:', err) }
}

async function openInWindow (project: Project) {
  if (!window.electronAPI) return
  const status = await window.electronAPI.getProjectStatus(project.id) as { status: string }
  if (status.status !== 'running') {
    await window.electronAPI.startProject(project.id)
    emit('appStarted')
    await loadProjects()
  }
  await window.electronAPI.openProjectWindow(project.id)
}

function openSourceCode (project: Project) {
  emit('viewSource', project)
}

async function deleteProject (project: Project) {
  confirmDialog.value = {
    visible: true,
    message: `确定删除项目「${project.name || project.id}」？此操作不可撤销。`,
    onConfirm: async () => {
      if (window.electronAPI?.deleteProject) {
        try { await window.electronAPI.deleteProject(project.id) } catch (err) { console.error('Failed to delete project:', err) }
      }
      removeFromFolder(project.id)
      await loadProjects()
      confirmDialog.value.visible = false
    }
  }
}

function confirmDialogCancel () {
  confirmDialog.value.visible = false
  confirmDialog.value.onConfirm = null
}

/* ------------------------------------------------------------------ */
/* Drag & Drop — merge into folder                                     */
/* ------------------------------------------------------------------ */

function onDragStart (e: DragEvent, projectId: string) {
  dragItem.value = { id: projectId, type: 'project' }
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', projectId)
  }
}

function onDragOver (e: DragEvent, targetId: string, targetType: 'project' | 'folder') {
  e.preventDefault()
  if (!dragItem.value || dragItem.value.id === targetId) {
    dropTarget.value = null
    return
  }
  dropTarget.value = { id: targetId, type: targetType }
}

function onDragLeave () {
  dropTarget.value = null
}

function onDrop (e: DragEvent, targetId: string, targetType: 'project' | 'folder') {
  e.preventDefault()
  if (!dragItem.value || dragItem.value.id === targetId) {
    dragItem.value = null
    dropTarget.value = null
    return
  }

  const draggedId = dragItem.value.id

  if (targetType === 'folder') {
    // Drop project into existing folder
    moveToFolder(draggedId, targetId)
  } else {
    // Drop project onto another project — create new folder
    createFolderWith(draggedId, targetId)
  }

  dragItem.value = null
  dropTarget.value = null
}

function onDragEnd () {
  dragItem.value = null
  dropTarget.value = null
}

/* ------------------------------------------------------------------ */
/* Context Menu                                                        */
/* ------------------------------------------------------------------ */

function showCtxMenu (e: MouseEvent, target: Project | LaunchFolder | null, kind: 'project' | 'folder' | 'blank') {
  e.preventDefault()
  e.stopPropagation()
  ctxMenu.value = { visible: true, x: e.clientX, y: e.clientY, target, kind }
}

function hideCtxMenu () { ctxMenu.value.visible = false }

/* ------------------------------------------------------------------ */
/* Folder overlay                                                      */
/* ------------------------------------------------------------------ */

function openFolder (folder: LaunchFolder, e: MouseEvent) {
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  folderPopupAnchor.value = { x: rect.left + rect.width / 2, y: rect.top }
  openFolderId.value = folder.id
}

function closeFolder () { openFolderId.value = null }

function cancelRename () {
  renamingId.value = null
}

function onFolderOverlayDragOver (e: DragEvent) {
  if (!dragItem.value || !openFolderData.value) return
  if (!openFolderData.value.projectIds.includes(dragItem.value.id)) return
  e.preventDefault()
}

function onFolderOverlayDrop (e: DragEvent) {
  if (e.target !== e.currentTarget || !dragItem.value || !openFolderData.value) return
  if (!openFolderData.value.projectIds.includes(dragItem.value.id)) return
  e.preventDefault()
  removeFromFolder(dragItem.value.id)
  dragItem.value = null
  dropTarget.value = null
  closeFolder()
}

/* ------------------------------------------------------------------ */
/* Keyboard / Lifecycle                                                */
/* ------------------------------------------------------------------ */

function onKeydown (e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (confirmDialog.value.visible) { confirmDialogCancel(); return }
    if (openFolderId.value) { closeFolder(); return }
    if (ctxMenu.value.visible) { hideCtxMenu(); return }
    emit('close')
  }
}

function onDocClick () { hideCtxMenu() }

onMounted(() => {
  loadFolders()
  loadProjects()
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKeydown)
  nextTick(() => searchRef.value?.focus())
  if (window.electronAPI?.onProjectChanged) {
    projectChangedCleanup = window.electronAPI.onProjectChanged(() => loadProjects())
  }
})

onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKeydown)
  projectChangedCleanup?.()
})
</script>

<template>
  <!-- Full-screen overlay like macOS Launchpad -->
  <div class="lp-overlay" @click.self="emit('close')">
    <div class="lp-content" @click.self="emit('close')">
      <!-- Search bar -->
      <div class="lp-search-bar">
        <div class="lp-search-box">
          <span class="lp-search-icon">🔍</span>
          <input
            ref="searchRef"
            v-model="searchQuery"
            type="text"
            placeholder="搜索应用…"
            class="lp-search-input"
            @click.stop
          />
        </div>
      </div>

      <!-- Loading -->
      <div v-if="isLoading && projects.length === 0" class="lp-status">
        <span class="lp-spinner">⏳</span> 加载中…
      </div>
      <div v-else-if="error" class="lp-status lp-error">❌ {{ error }}</div>

      <!-- Grid -->
      <div v-else class="lp-grid-container" @contextmenu="showCtxMenu($event, null, 'blank')">
        <div v-if="gridItems.length === 0" class="lp-empty">
          <div class="lp-empty-icon">🚀</div>
          <p>还没有应用</p>
          <p class="lp-empty-hint">在 AI 对话中输入需求即可创建新应用</p>
        </div>

        <LaunchpadGrid
          v-else
          :grid-items="gridItems"
          :projects="projects"
          :drop-target="dropTarget"
          :renaming-id="renamingId"
          :rename-input="renameInput"
          @dragstart="onDragStart($event.event, $event.projectId)"
          @dragover="onDragOver($event.event, $event.targetId, $event.targetType)"
          @dragleave="onDragLeave"
          @drop="onDrop($event.event, $event.targetId, $event.targetType)"
          @dragend="onDragEnd"
          @open-folder="openFolder($event.folder, $event.event)"
          @select-project="emit('select', $event)"
          @show-menu="showCtxMenu($event.event, $event.target, $event.kind)"
          @update:rename-input="renameInput = $event"
          @commit-rename="commitRename"
          @cancel-rename="cancelRename"
        />
      </div>

      <!-- Page dots (decorative) -->
      <div class="lp-page-dots">
        <span class="lp-dot active"></span>
      </div>
    </div>

    <FolderBubble
      :open-folder-data="openFolderData"
      :open-folder-projects="openFolderProjects"
      :folder-popup-anchor="folderPopupAnchor"
      :renaming-id="renamingId"
      :rename-input="renameInput"
      @close="closeFolder"
      @dragover-overlay="onFolderOverlayDragOver"
      @drop-overlay="onFolderOverlayDrop"
      @dragstart="onDragStart($event.event, $event.projectId)"
      @dragend="onDragEnd"
      @select-project="emit('select', $event)"
      @show-menu="showCtxMenu($event.event, $event.target, $event.kind)"
      @update:rename-input="renameInput = $event"
      @commit-rename="commitRename"
      @cancel-rename="cancelRename"
      @start-rename="startRenameFolder"
    />

    <!-- Context Menu -->
    <ContextMenu
      :visible="ctxMenu.visible"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :target="ctxMenu.target"
      :kind="ctxMenu.kind"
      :folders="folders"
      :foldered-ids="folderedIds"
      @hide="hideCtxMenu"
      @open-project="emit('select', $event)"
      @view-source="openSourceCode($event)"
      @open-in-window="openInWindow($event)"
      @start-project="startProject($event)"
      @stop-project="stopProject($event)"
      @optimize-in-chat="emit('optimizeInChat', $event)"
      @move-to-folder="(projectId, folderId) => moveToFolder(projectId, folderId)"
      @remove-from-folder="removeFromFolder($event)"
      @delete-project="deleteProject($event)"
      @rename-folder="startRenameFolder($event)"
      @delete-folder="deleteFolder($event)"
      @create-folder="createEmptyFolder"
      @refresh="loadProjects"
    />

    <!-- Confirm dialog -->
    <ConfirmDialog
      :visible="confirmDialog.visible"
      :message="confirmDialog.message"
      @confirm="confirmDialog.onConfirm?.()"
      @cancel="confirmDialogCancel"
    />
  </div>
</template>

<style>
/* ============ Full-screen overlay ============ */
.lp-overlay {
  --lp-accent: #38bdf8;
  --lp-accent-soft: rgba(56, 189, 248, 0.16);
  --lp-accent-strong: rgba(14, 165, 233, 0.42);
  --lp-folder-soft: rgba(245, 158, 11, 0.18);
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 5000;
  background:
    radial-gradient(circle at 18% 18%, rgba(56, 189, 248, 0.14), transparent 24%),
    radial-gradient(circle at 82% 12%, rgba(245, 158, 11, 0.12), transparent 20%),
    linear-gradient(180deg, rgba(6, 10, 16, 0.78), rgba(4, 7, 12, 0.94));
  backdrop-filter: blur(40px) saturate(1.2);
  display: flex;
  flex-direction: column;
  animation: lp-fade-in 0.25s ease;
}

@keyframes lp-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.lp-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 55px; /* below titlebar */
  overflow: hidden;
}

/* ============ Search ============ */
.lp-search-bar {
  flex-shrink: 0;
  margin-bottom: 32px;
}
.lp-search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  padding: 8px 16px;
  width: 300px;
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.2);
  transition: all 0.2s ease;
}
.lp-search-box:focus-within {
  border-color: var(--lp-accent-strong);
  background: rgba(255, 255, 255, 0.1);
  width: 360px;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.24), 0 0 0 1px var(--lp-accent-soft);
}
.lp-search-icon { font-size: 0.85em; opacity: 0.5; }
.lp-search-input {
  flex: 1;
  background: none;
  border: none;
  color: #e4e4e7;
  font-size: 0.9em;
  outline: none;
}
.lp-search-input::placeholder { color: rgba(255, 255, 255, 0.3); }

/* ============ Status / empty ============ */
.lp-status {
  color: #71717a;
  font-size: 0.92em;
  margin-top: 80px;
}
.lp-error { color: #f87171; }
.lp-spinner { animation: spin 1s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }

.lp-empty {
  text-align: center;
  margin-top: 100px;
  color: #71717a;
}
.lp-empty-icon { font-size: 3em; margin-bottom: 16px; }
.lp-empty-hint { font-size: 0.82em; color: #52525b; margin-top: 8px; }

/* ============ Grid container ============ */
.lp-grid-container {
  flex: 1;
  width: 100%;
  max-width: 840px;
  padding: 0 40px;
  overflow-y: auto;
  overflow-x: hidden;
}
.lp-grid-container::-webkit-scrollbar { width: 4px; }
.lp-grid-container::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }

.lp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 24px 20px;
  justify-items: center;
}

/* ============ Grid cell (shared) ============ */
.lp-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 12px 8px;
  border-radius: 16px;
  transition: all 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
  user-select: none;
  position: relative;
  width: 96px;
}
.lp-cell:hover {
  background: rgba(255, 255, 255, 0.06);
  transform: translateY(-3px) scale(1.06);
}
.lp-cell:active {
  transform: scale(0.96);
}
.lp-cell.drop-hover {
  background: var(--lp-accent-soft);
  box-shadow: 0 0 0 2px var(--lp-accent-strong);
  transform: scale(1.08);
}

/* ============ App icon ============ */
.lp-app-icon {
  position: relative;
  width: 64px;
  height: 64px;
  background: linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255,255,255,0.05);
  transition: all 0.18s;
}
.lp-cell:hover .lp-app-icon {
  border-color: rgba(56, 189, 248, 0.28);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.34), 0 0 0 1px rgba(56, 189, 248, 0.18);
}
.lp-app-emoji { font-size: 1.8em; }
.lp-running-badge {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #22c55e;
  border: 2px solid #0f0f10;
  box-shadow: 0 0 8px #22c55e80;
}

.lp-cell-name {
  font-size: 0.75em;
  color: rgba(255, 255, 255, 0.8);
  text-align: center;
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
}

/* ============ Folder icon ============ */
.lp-folder-icon {
  width: 64px;
  height: 64px;
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.18) 0%, rgba(251, 191, 36, 0.08) 100%);
  border: 1px solid rgba(245, 158, 11, 0.18);
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  transition: all 0.18s;
}
.lp-cell:hover .lp-folder-icon {
  border-color: rgba(245, 158, 11, 0.32);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(245, 158, 11, 0.14);
}

.folder-mini-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  width: 100%;
  height: 100%;
}
.folder-mini {
  font-size: 0.7em;
  display: flex;
  align-items: center;
  justify-content: center;
}
.folder-mini.empty { opacity: 0; }

.lp-rename-input {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid var(--lp-accent-strong);
  border-radius: 6px;
  color: #e4e4e7;
  padding: 3px 8px;
  font-size: 0.75em;
  outline: none;
  width: 80px;
  text-align: center;
}

/* ============ Page dots ============ */
.lp-page-dots {
  flex-shrink: 0;
  padding: 16px 0 24px;
  display: flex;
  gap: 6px;
  justify-content: center;
}
.lp-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
}
.lp-dot.active { background: rgba(255, 255, 255, 0.6); }

/* ============ Folder popup bubble ============ */
.folder-bubble-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 6000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.folder-bubble {
  position: relative;
  background: rgba(13, 18, 26, 0.94);
  backdrop-filter: blur(30px);
  border: 1px solid rgba(148, 163, 184, 0.14);
  border-radius: 24px;
  width: 420px;
  max-height: 50vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255,255,255,0.03);
  transform-origin: var(--anchor-x, 50%) var(--anchor-y, 50%);
}

.folder-bubble-arrow {
  position: absolute;
  top: -8px;
  left: 50%;
  transform: translateX(-50%);
  width: 16px;
  height: 8px;
  overflow: hidden;
}
.folder-bubble-arrow::before {
  content: '';
  display: block;
  width: 12px;
  height: 12px;
  background: rgba(13, 18, 26, 0.94);
  border: 1px solid rgba(148, 163, 184, 0.14);
  transform: rotate(45deg);
  margin: 4px auto 0;
}

.folder-bubble-header {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px 20px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.folder-bubble-title {
  margin: 0;
  font-size: 0.95em;
  font-weight: 600;
  color: #e4e4e7;
  cursor: text;
}
.folder-rename-input {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--lp-accent-strong);
  border-radius: 8px;
  color: #e4e4e7;
  padding: 6px 12px;
  font-size: 0.95em;
  outline: none;
  text-align: center;
}

.folder-bubble-body {
  padding: 16px 20px 20px;
  overflow-y: auto;
}
.folder-empty {
  text-align: center;
  color: #52525b;
  font-size: 0.85em;
  padding: 20px 0;
}
.folder-bubble-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  justify-items: center;
}

/* Folder popup transition */
.folder-pop-enter-active {
  animation: folder-pop-in 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.folder-pop-leave-active {
  animation: folder-pop-out 0.18s ease-in;
}
@keyframes folder-pop-in {
  from { opacity: 0; transform: scale(0.7); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes folder-pop-out {
  from { opacity: 1; transform: scale(1); }
  to { opacity: 0; transform: scale(0.7); }
}
</style>
