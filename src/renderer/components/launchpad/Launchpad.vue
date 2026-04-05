<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import ContextMenu from './ContextMenu.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import LaunchpadGrid from './LaunchpadGrid.vue'
import FolderBubble from './FolderBubble.vue'
import ProjectAppearanceDialog from './ProjectAppearanceDialog.vue'
import type {
  LaunchFolder,
  LaunchpadDragItem,
  LaunchpadDropTarget,
  LaunchpadGridItem,
  Project
} from './types'

const emit = defineEmits<{
  (e: 'select', project: Project): void
  (e: 'viewSource', project: Project): void
  (e: 'optimizeInChat', project: Project): void
  (e: 'appStarted'): void
  (e: 'close'): void
}>()

const projects = ref<Project[]>([])
const folders = ref<LaunchFolder[]>([])
const topLevelOrder = ref<string[]>([])
const isLoading = ref(false)
const error = ref<string | null>(null)
const searchQuery = ref('')
const searchRef = ref<HTMLInputElement | null>(null)

const openFolderId = ref<string | null>(null)
const folderPopupAnchor = ref<{ x: number; y: number }>({ x: 0, y: 0 })

const dragItem = ref<LaunchpadDragItem | null>(null)
const dropTarget = ref<LaunchpadDropTarget | null>(null)

const ctxMenu = ref<{ visible: boolean; x: number; y: number; target: Project | LaunchFolder | null; kind: 'project' | 'folder' | 'blank' }>({
  visible: false, x: 0, y: 0, target: null, kind: 'blank'
})

const renamingId = ref<string | null>(null)
const renameInput = ref('')

const confirmDialog = ref<{ visible: boolean; message: string; onConfirm: (() => void) | null }>({
  visible: false, message: '', onConfirm: null
})

const appearanceDialog = ref<{ visible: boolean; project: Project | null }>({
  visible: false,
  project: null
})

let projectChangedCleanup: (() => void) | null = null

function projectKey (projectId: string): string {
  return `project:${projectId}`
}

function folderKey (folderId: string): string {
  return `folder:${folderId}`
}

function getFolderById (folderId: string): LaunchFolder | null {
  return folders.value.find(folder => folder.id === folderId) || null
}

function getFolderByProject (projectId: string): LaunchFolder | null {
  return folders.value.find(folder => folder.projectIds.includes(projectId)) || null
}

function sameArray (left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function dedupeOrder (order: string[]): string[] {
  const seen = new Set<string>()
  return order.filter((key) => {
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const folderedIds = computed(() => {
  const ids = new Set<string>()
  folders.value.forEach(folder => folder.projectIds.forEach(projectId => ids.add(projectId)))
  return ids
})

const orderedTopLevelItems = computed<LaunchpadGridItem[]>(() => {
  const items = new Map<string, LaunchpadGridItem>()
  const unfolderedProjects = projects.value.filter(project => !folderedIds.value.has(project.id))

  folders.value.forEach(folder => {
    items.set(folderKey(folder.id), { kind: 'folder', data: folder })
  })

  unfolderedProjects.forEach(project => {
    items.set(projectKey(project.id), { kind: 'project', data: project })
  })

  const ordered: LaunchpadGridItem[] = []
  const used = new Set<string>()

  topLevelOrder.value.forEach((key) => {
    const item = items.get(key)
    if (!item) return
    ordered.push(item)
    used.add(key)
  })

  folders.value.forEach((folder) => {
    const key = folderKey(folder.id)
    if (used.has(key)) return
    ordered.push({ kind: 'folder', data: folder })
  })

  unfolderedProjects.forEach((project) => {
    const key = projectKey(project.id)
    if (used.has(key)) return
    ordered.push({ kind: 'project', data: project })
  })

  return ordered
})

function matchesProjectQuery (project: Project, query: string): boolean {
  return (project.name || project.id).toLowerCase().includes(query) || (project.type || '').toLowerCase().includes(query)
}

function matchesFolderQuery (folder: LaunchFolder, query: string): boolean {
  if (folder.name.toLowerCase().includes(query)) return true
  return folder.projectIds.some((projectId) => {
    const project = projects.value.find(entry => entry.id === projectId)
    return project ? matchesProjectQuery(project, query) : false
  })
}

const gridItems = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return orderedTopLevelItems.value
  return orderedTopLevelItems.value.filter((item) => {
    return item.kind === 'folder'
      ? matchesFolderQuery(item.data, query)
      : matchesProjectQuery(item.data, query)
  })
})

const openFolderData = computed(() => {
  if (!openFolderId.value) return null
  return getFolderById(openFolderId.value)
})

const openFolderProjects = computed(() => {
  if (!openFolderData.value) return []
  return openFolderData.value.projectIds
    .map(projectId => projects.value.find(project => project.id === projectId))
    .filter(Boolean) as Project[]
})

function persistLayout () {
  const layout = {
    folders: folders.value.map(folder => ({
      id: folder.id,
      name: folder.name,
      projectIds: [...folder.projectIds]
    })),
    topLevelOrder: [...topLevelOrder.value]
  }

  try {
    localStorage.setItem('launchpad-layout', JSON.stringify(layout))
    localStorage.setItem('launchpad-folders', JSON.stringify(layout.folders))
  } catch {
    // Ignore local persistence failures.
  }

  if (window.electronAPI?.saveLaunchpadLayout) {
    void window.electronAPI.saveLaunchpadLayout(layout).catch((err) => {
      console.error('Failed to persist launchpad layout:', err)
    })
  }
}

async function loadLayout () {
  if (window.electronAPI?.getLaunchpadLayout) {
    try {
      const layout = await window.electronAPI.getLaunchpadLayout()
      folders.value = Array.isArray(layout?.folders) ? layout.folders : []
      topLevelOrder.value = Array.isArray(layout?.topLevelOrder) ? layout.topLevelOrder : []
      if (folders.value.length > 0 || topLevelOrder.value.length > 0) {
        return
      }
    } catch (err) {
      console.error('Failed to load launchpad layout:', err)
    }
  }

  try {
    const rawLayout = localStorage.getItem('launchpad-layout')
    if (rawLayout) {
      const layout = JSON.parse(rawLayout) as { folders?: LaunchFolder[]; topLevelOrder?: string[] }
      folders.value = Array.isArray(layout.folders) ? layout.folders : []
      topLevelOrder.value = Array.isArray(layout.topLevelOrder) ? layout.topLevelOrder : []
      return
    }

    const rawFolders = localStorage.getItem('launchpad-folders')
    if (rawFolders) {
      folders.value = JSON.parse(rawFolders) as LaunchFolder[]
      topLevelOrder.value = []
      persistLayout()
    }
  } catch {
    folders.value = []
    topLevelOrder.value = []
  }
}

function syncLayoutWithProjects (nextProjects: Project[]) {
  const validIds = new Set(nextProjects.map(project => project.id))
  const assigned = new Set<string>()
  let changed = false

  const nextFolders = folders.value.map((folder) => {
    const nextProjectIds = folder.projectIds.filter((projectId) => {
      if (!validIds.has(projectId) || assigned.has(projectId)) {
        changed = true
        return false
      }
      assigned.add(projectId)
      return true
    })

    if (nextProjectIds.length !== folder.projectIds.length) {
      changed = true
    }

    return {
      ...folder,
      projectIds: nextProjectIds
    }
  })

  folders.value = nextFolders

  if (openFolderId.value && !folders.value.some(folder => folder.id === openFolderId.value)) {
    openFolderId.value = null
  }

  const nextFolderedIds = new Set<string>()
  folders.value.forEach(folder => folder.projectIds.forEach(projectId => nextFolderedIds.add(projectId)))

  const validTopLevelKeys = new Set<string>()
  folders.value.forEach(folder => validTopLevelKeys.add(folderKey(folder.id)))
  nextProjects.forEach((project) => {
    if (!nextFolderedIds.has(project.id)) {
      validTopLevelKeys.add(projectKey(project.id))
    }
  })

  const nextOrder = topLevelOrder.value.filter(key => validTopLevelKeys.has(key))
  const seen = new Set(nextOrder)

  folders.value.forEach((folder) => {
    const key = folderKey(folder.id)
    if (!seen.has(key)) {
      nextOrder.push(key)
      seen.add(key)
      changed = true
    }
  })

  nextProjects.forEach((project) => {
    if (nextFolderedIds.has(project.id)) return
    const key = projectKey(project.id)
    if (!seen.has(key)) {
      nextOrder.push(key)
      seen.add(key)
      changed = true
    }
  })

  const dedupedOrder = dedupeOrder(nextOrder)
  if (!sameArray(topLevelOrder.value, dedupedOrder)) {
    topLevelOrder.value = dedupedOrder
    changed = true
  }

  if (changed) persistLayout()
}

async function loadProjects () {
  isLoading.value = true
  error.value = null
  try {
    if (!window.electronAPI) return
    const nextProjects = await window.electronAPI.listProjects() as Project[]
    projects.value = nextProjects
    syncLayoutWithProjects(nextProjects)
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    isLoading.value = false
  }
}

function cleanupFolderAfterMove (folderId: string): { collapsed: boolean; remainingProjectIds: string[] } {
  const folder = getFolderById(folderId)
  if (!folder || folder.projectIds.length > 1) {
    return { collapsed: false, remainingProjectIds: folder ? [...folder.projectIds] : [] }
  }

  const remainingProjectIds = [...folder.projectIds]
  const key = folderKey(folderId)
  const orderIndex = topLevelOrder.value.indexOf(key)
  folders.value = folders.value.filter(entry => entry.id !== folderId)

  const nextOrder = topLevelOrder.value.filter(entryKey => entryKey !== key)
  if (remainingProjectIds.length === 1) {
    const remainingKey = projectKey(remainingProjectIds[0])
    if (!nextOrder.includes(remainingKey)) {
      const insertIndex = orderIndex >= 0 ? Math.min(orderIndex, nextOrder.length) : nextOrder.length
      nextOrder.splice(insertIndex, 0, remainingKey)
    }
  }

  topLevelOrder.value = dedupeOrder(nextOrder)

  if (openFolderId.value === folderId) {
    openFolderId.value = null
  }

  return { collapsed: true, remainingProjectIds }
}

function detachProjectFromCurrentLocation (projectId: string) {
  const sourceFolder = getFolderByProject(projectId)
  if (sourceFolder) {
    sourceFolder.projectIds = sourceFolder.projectIds.filter(id => id !== projectId)
    cleanupFolderAfterMove(sourceFolder.id)
    return
  }

  topLevelOrder.value = topLevelOrder.value.filter(key => key !== projectKey(projectId))
}

function createFolderWith (draggedProjectId: string, targetProjectId: string) {
  const targetKey = projectKey(targetProjectId)
  const targetIndex = topLevelOrder.value.indexOf(targetKey)
  const id = 'folder_' + Date.now().toString(36)
  const name = '新文件夹'

  detachProjectFromCurrentLocation(draggedProjectId)

  topLevelOrder.value = topLevelOrder.value.filter(key => key !== targetKey)
  folders.value.push({ id, name, projectIds: [targetProjectId, draggedProjectId] })

  const nextOrder = [...topLevelOrder.value]
  const insertIndex = targetIndex >= 0 ? Math.min(targetIndex, nextOrder.length) : nextOrder.length
  nextOrder.splice(insertIndex, 0, folderKey(id))
  topLevelOrder.value = dedupeOrder(nextOrder)

  persistLayout()
  openFolderId.value = id
  renamingId.value = id
  renameInput.value = name
}

function createEmptyFolder () {
  const id = 'folder_' + Date.now().toString(36)
  folders.value.push({ id, name: '新文件夹', projectIds: [] })
  topLevelOrder.value = dedupeOrder([...topLevelOrder.value, folderKey(id)])
  persistLayout()
  renamingId.value = id
  renameInput.value = '新文件夹'
}

function deleteFolder (folderId: string) {
  const folder = getFolderById(folderId)
  if (!folder) return

  const key = folderKey(folderId)
  const orderIndex = topLevelOrder.value.indexOf(key)
  folders.value = folders.value.filter(entry => entry.id !== folderId)

  const nextOrder = topLevelOrder.value.filter(entryKey => entryKey !== key)
  const projectKeys = folder.projectIds
    .map(projectId => projectKey(projectId))
    .filter(entryKey => !nextOrder.includes(entryKey))
  const insertIndex = orderIndex >= 0 ? Math.min(orderIndex, nextOrder.length) : nextOrder.length
  nextOrder.splice(insertIndex, 0, ...projectKeys)
  topLevelOrder.value = dedupeOrder(nextOrder)

  persistLayout()
  openFolderId.value = null
}

function startRenameFolder (folder: LaunchFolder) {
  renamingId.value = folder.id
  renameInput.value = folder.name
}

function commitRename (folderId: string) {
  const folder = getFolderById(folderId)
  if (folder && renameInput.value.trim()) {
    folder.name = renameInput.value.trim()
    persistLayout()
  }
  renamingId.value = null
}

function moveToFolder (projectId: string, folderId: string) {
  const targetFolder = getFolderById(folderId)
  if (!targetFolder) return

  const sourceFolder = getFolderByProject(projectId)
  if (sourceFolder?.id === folderId) {
    if (targetFolder.projectIds[targetFolder.projectIds.length - 1] !== projectId) {
      targetFolder.projectIds = targetFolder.projectIds.filter(id => id !== projectId)
      targetFolder.projectIds.push(projectId)
      persistLayout()
    }
    return
  }

  if (sourceFolder) {
    sourceFolder.projectIds = sourceFolder.projectIds.filter(id => id !== projectId)
    cleanupFolderAfterMove(sourceFolder.id)
  } else {
    topLevelOrder.value = topLevelOrder.value.filter(key => key !== projectKey(projectId))
  }

  targetFolder.projectIds = targetFolder.projectIds.filter(id => id !== projectId)
  targetFolder.projectIds.push(projectId)
  persistLayout()
}

function removeFromFolder (projectId: string) {
  const sourceFolder = getFolderByProject(projectId)
  if (!sourceFolder) return

  const sourceOrderIndex = topLevelOrder.value.indexOf(folderKey(sourceFolder.id))
  const nextCount = sourceFolder.projectIds.filter(id => id !== projectId).length

  sourceFolder.projectIds = sourceFolder.projectIds.filter(id => id !== projectId)
  cleanupFolderAfterMove(sourceFolder.id)

  const nextOrder = [...topLevelOrder.value]
  const entryKey = projectKey(projectId)
  if (!nextOrder.includes(entryKey)) {
    const insertIndex = sourceOrderIndex >= 0
      ? Math.min(sourceOrderIndex + (nextCount > 0 ? 1 : 0), nextOrder.length)
      : nextOrder.length
    nextOrder.splice(insertIndex, 0, entryKey)
    topLevelOrder.value = dedupeOrder(nextOrder)
  }

  persistLayout()
}

async function startProject (project: Project) {
  if (!window.electronAPI) return
  try {
    await window.electronAPI.startProject(project.id)
    emit('appStarted')
    await loadProjects()
  } catch (err) {
    console.error('Failed to start project:', err)
  }
}

async function stopProject (project: Project) {
  if (!window.electronAPI) return
  try {
    await window.electronAPI.stopProject(project.id)
    await loadProjects()
  } catch (err) {
    console.error('Failed to stop project:', err)
  }
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
        try {
          await window.electronAPI.deleteProject(project.id)
        } catch (err) {
          console.error('Failed to delete project:', err)
        }
      }
      removeFromFolder(project.id)
      topLevelOrder.value = topLevelOrder.value.filter(key => key !== projectKey(project.id))
      await loadProjects()
      confirmDialog.value.visible = false
    }
  }
}

function openEditProject (project: Project) {
  appearanceDialog.value = {
    visible: true,
    project
  }
}

function closeEditProject () {
  appearanceDialog.value = {
    visible: false,
    project: null
  }
}

async function saveProjectAppearance (payload: { projectId: string; name: string; icon: string }) {
  if (!window.electronAPI?.updateProjectAppearance) return
  try {
    await window.electronAPI.updateProjectAppearance(payload.projectId, {
      name: payload.name,
      icon: payload.icon
    })
    await loadProjects()
  } catch (err) {
    console.error('Failed to update project appearance:', err)
  } finally {
    closeEditProject()
  }
}

function confirmDialogCancel () {
  confirmDialog.value.visible = false
  confirmDialog.value.onConfirm = null
}

function resolveTopLevelDropTarget (e: DragEvent, targetId: string, targetType: 'project' | 'folder'): LaunchpadDropTarget | null {
  if (!dragItem.value) return null
  if (dragItem.value.id === targetId && dragItem.value.type === targetType) return null

  const element = e.currentTarget as HTMLElement | null
  if (!element) return null
  const rect = element.getBoundingClientRect()
  const relativeX = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5

  if (relativeX <= 0.24) {
    return { id: targetId, type: targetType, action: 'before' }
  }

  if (relativeX >= 0.76) {
    return { id: targetId, type: targetType, action: 'after' }
  }

  if (dragItem.value.type === 'project') {
    return {
      id: targetId,
      type: targetType,
      action: targetType === 'folder' ? 'into-folder' : 'merge'
    }
  }

  return {
    id: targetId,
    type: targetType,
    action: relativeX < 0.5 ? 'before' : 'after'
  }
}

function resolveFolderDropTarget (e: DragEvent, targetProjectId: string, folderId: string): LaunchpadDropTarget | null {
  if (!dragItem.value || dragItem.value.type !== 'project') return null
  if (dragItem.value.id === targetProjectId && dragItem.value.folderId === folderId) return null

  const element = e.currentTarget as HTMLElement | null
  if (!element) return null
  const rect = element.getBoundingClientRect()
  const relativeX = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5

  return {
    id: targetProjectId,
    type: 'project',
    action: relativeX < 0.5 ? 'before' : 'after',
    folderId
  }
}

function reorderTopLevelItem (item: LaunchpadDragItem, targetId: string, targetType: 'project' | 'folder', position: 'before' | 'after') {
  const movingKey = item.type === 'folder' ? folderKey(item.id) : projectKey(item.id)
  const targetKey = targetType === 'folder' ? folderKey(targetId) : projectKey(targetId)
  if (movingKey === targetKey) return

  if (item.type === 'project' && item.source === 'folder' && item.folderId) {
    const sourceFolder = getFolderById(item.folderId)
    if (!sourceFolder) return
    sourceFolder.projectIds = sourceFolder.projectIds.filter(projectId => projectId !== item.id)
    cleanupFolderAfterMove(sourceFolder.id)
  }

  const nextOrder = topLevelOrder.value.filter(key => key !== movingKey)
  let targetIndex = nextOrder.indexOf(targetKey)
  if (targetIndex === -1) targetIndex = nextOrder.length
  if (position === 'after') targetIndex += 1
  nextOrder.splice(targetIndex, 0, movingKey)
  topLevelOrder.value = dedupeOrder(nextOrder)
  persistLayout()
}

function reorderProjectWithinFolder (item: LaunchpadDragItem, targetProjectId: string, folderId: string, position: 'before' | 'after') {
  if (item.type !== 'project') return

  const targetFolder = getFolderById(folderId)
  if (!targetFolder) return

  if (item.source === 'folder' && item.folderId === folderId) {
    const reorderedIds = targetFolder.projectIds.filter(projectId => projectId !== item.id)
    let targetIndex = reorderedIds.indexOf(targetProjectId)
    if (targetIndex === -1) targetIndex = reorderedIds.length
    if (position === 'after') targetIndex += 1
    reorderedIds.splice(targetIndex, 0, item.id)
    targetFolder.projectIds = reorderedIds
    persistLayout()
    return
  }

  if (item.source === 'folder' && item.folderId) {
    const sourceFolder = getFolderById(item.folderId)
    if (!sourceFolder) return
    sourceFolder.projectIds = sourceFolder.projectIds.filter(projectId => projectId !== item.id)
    cleanupFolderAfterMove(sourceFolder.id)
  } else {
    topLevelOrder.value = topLevelOrder.value.filter(key => key !== projectKey(item.id))
  }

  const nextIds = targetFolder.projectIds.filter(projectId => projectId !== item.id)
  let targetIndex = nextIds.indexOf(targetProjectId)
  if (targetIndex === -1) targetIndex = nextIds.length
  if (position === 'after') targetIndex += 1
  nextIds.splice(targetIndex, 0, item.id)
  targetFolder.projectIds = nextIds
  persistLayout()
}

function appendToTopLevel (item: LaunchpadDragItem) {
  const key = item.type === 'folder' ? folderKey(item.id) : projectKey(item.id)

  if (item.type === 'project' && item.source === 'folder' && item.folderId) {
    const sourceFolder = getFolderById(item.folderId)
    if (!sourceFolder) return
    sourceFolder.projectIds = sourceFolder.projectIds.filter(projectId => projectId !== item.id)
    cleanupFolderAfterMove(sourceFolder.id)
  }

  const nextOrder = topLevelOrder.value.filter(entryKey => entryKey !== key)
  nextOrder.push(key)
  topLevelOrder.value = dedupeOrder(nextOrder)
  persistLayout()
}

function appendProjectToFolderEnd (item: LaunchpadDragItem, folderId: string) {
  if (item.type !== 'project') return

  const targetFolder = getFolderById(folderId)
  if (!targetFolder) return

  if (item.source === 'folder' && item.folderId === folderId) {
    targetFolder.projectIds = targetFolder.projectIds.filter(projectId => projectId !== item.id)
    targetFolder.projectIds.push(item.id)
    persistLayout()
    return
  }

  if (item.source === 'folder' && item.folderId) {
    const sourceFolder = getFolderById(item.folderId)
    if (!sourceFolder) return
    sourceFolder.projectIds = sourceFolder.projectIds.filter(projectId => projectId !== item.id)
    cleanupFolderAfterMove(sourceFolder.id)
  } else {
    topLevelOrder.value = topLevelOrder.value.filter(key => key !== projectKey(item.id))
  }

  targetFolder.projectIds = targetFolder.projectIds.filter(projectId => projectId !== item.id)
  targetFolder.projectIds.push(item.id)
  persistLayout()
}

function resetDragState () {
  dragItem.value = null
  dropTarget.value = null
}

function onDragStart (e: DragEvent, itemId: string, itemType: 'project' | 'folder', source: 'top-level' | 'folder' = 'top-level', folderId: string | null = null) {
  dragItem.value = { id: itemId, type: itemType, source, folderId }
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', itemId)
  }
}

function onGridContainerDragOver (e: DragEvent) {
  if (!dragItem.value) return
  e.preventDefault()
  dropTarget.value = { id: '__grid__', type: 'grid', action: 'append' }
}

function onGridContainerDrop (e: DragEvent) {
  if (!dragItem.value) return
  e.preventDefault()
  appendToTopLevel(dragItem.value)
  resetDragState()
}

function onDragOver (e: DragEvent, targetId: string, targetType: 'project' | 'folder') {
  e.preventDefault()
  e.stopPropagation()
  dropTarget.value = resolveTopLevelDropTarget(e, targetId, targetType)
}

function onFolderProjectDragOver (e: DragEvent, targetProjectId: string, folderId: string) {
  e.preventDefault()
  e.stopPropagation()
  dropTarget.value = resolveFolderDropTarget(e, targetProjectId, folderId)
}

function onDragLeave () {
  dropTarget.value = null
}

function onDrop (e: DragEvent, targetId: string, targetType: 'project' | 'folder') {
  if (!dragItem.value) return
  e.preventDefault()
  e.stopPropagation()

  const target = dropTarget.value && dropTarget.value.id === targetId
    ? dropTarget.value
    : resolveTopLevelDropTarget(e, targetId, targetType)

  if (!target) {
    resetDragState()
    return
  }

  switch (target.action) {
    case 'before':
    case 'after':
      reorderTopLevelItem(dragItem.value, targetId, targetType, target.action)
      break
    case 'into-folder':
      moveToFolder(dragItem.value.id, targetId)
      break
    case 'merge':
      if (dragItem.value.type === 'project' && targetType === 'project') {
        createFolderWith(dragItem.value.id, targetId)
      }
      break
  }

  resetDragState()
}

function onFolderProjectDrop (e: DragEvent, targetProjectId: string, folderId: string) {
  if (!dragItem.value) return
  e.preventDefault()
  e.stopPropagation()

  const target = dropTarget.value && dropTarget.value.id === targetProjectId
    ? dropTarget.value
    : resolveFolderDropTarget(e, targetProjectId, folderId)

  if (!target || (target.action !== 'before' && target.action !== 'after')) {
    resetDragState()
    return
  }

  reorderProjectWithinFolder(dragItem.value, targetProjectId, folderId, target.action)
  resetDragState()
}

function onFolderBodyDragOver (e: DragEvent) {
  if (!dragItem.value || !openFolderData.value || dragItem.value.type !== 'project') return
  e.preventDefault()
  e.stopPropagation()
  dropTarget.value = {
    id: openFolderData.value.id,
    type: 'folder',
    action: 'append',
    folderId: openFolderData.value.id
  }
}

function onFolderBodyDrop (e: DragEvent) {
  if (!dragItem.value || !openFolderData.value || dragItem.value.type !== 'project') return
  e.preventDefault()
  e.stopPropagation()
  appendProjectToFolderEnd(dragItem.value, openFolderData.value.id)
  resetDragState()
}

function onDragEnd () {
  resetDragState()
}

function showCtxMenu (e: MouseEvent, target: Project | LaunchFolder | null, kind: 'project' | 'folder' | 'blank') {
  e.preventDefault()
  e.stopPropagation()
  ctxMenu.value = { visible: true, x: e.clientX, y: e.clientY, target, kind }
}

function hideCtxMenu () {
  ctxMenu.value.visible = false
}

function openFolder (folder: LaunchFolder, e: MouseEvent) {
  const element = e.currentTarget as HTMLElement
  const rect = element.getBoundingClientRect()
  folderPopupAnchor.value = { x: rect.left + rect.width / 2, y: rect.top }
  openFolderId.value = folder.id
}

function closeFolder () {
  openFolderId.value = null
}

function cancelRename () {
  renamingId.value = null
}

function onFolderOverlayDragOver (e: DragEvent) {
  if (!dragItem.value || !openFolderData.value || dragItem.value.type !== 'project') return
  if (!openFolderData.value.projectIds.includes(dragItem.value.id)) return
  e.preventDefault()
}

function onFolderOverlayDrop (e: DragEvent) {
  if (e.target !== e.currentTarget || !dragItem.value || !openFolderData.value) return
  if (dragItem.value.type !== 'project') return
  if (!openFolderData.value.projectIds.includes(dragItem.value.id)) return

  e.preventDefault()
  removeFromFolder(dragItem.value.id)
  resetDragState()
  closeFolder()
}

function onKeydown (e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (appearanceDialog.value.visible) {
      closeEditProject()
      return
    }
    if (confirmDialog.value.visible) {
      confirmDialogCancel()
      return
    }
    if (openFolderId.value) {
      closeFolder()
      return
    }
    if (ctxMenu.value.visible) {
      hideCtxMenu()
      return
    }
    emit('close')
  }
}

function onDocClick () {
  hideCtxMenu()
}

async function initializeLaunchpad () {
  await loadLayout()
  await loadProjects()
  await nextTick()
  searchRef.value?.focus()
}

onMounted(() => {
  void initializeLaunchpad()
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKeydown)
  if (window.electronAPI?.onProjectChanged) {
    projectChangedCleanup = window.electronAPI.onProjectChanged(() => {
      void loadProjects()
    })
  }
})

onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKeydown)
  projectChangedCleanup?.()
})
</script>

<template>
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
      <div
        v-else
        class="lp-grid-container"
        @contextmenu="showCtxMenu($event, null, 'blank')"
        @dragover="onGridContainerDragOver"
        @drop="onGridContainerDrop"
      >
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
          @dragstart="onDragStart($event.event, $event.itemId, $event.itemType)"
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
      :drop-target="dropTarget"
      :renaming-id="renamingId"
      :rename-input="renameInput"
      @close="closeFolder"
      @dragover-overlay="onFolderOverlayDragOver"
      @drop-overlay="onFolderOverlayDrop"
      @dragstart="onDragStart($event.event, $event.itemId, $event.itemType, $event.source, $event.folderId)"
      @dragover-project="onFolderProjectDragOver($event.event, $event.targetProjectId, $event.folderId)"
      @drop-project="onFolderProjectDrop($event.event, $event.targetProjectId, $event.folderId)"
      @dragover-body="onFolderBodyDragOver"
      @drop-body="onFolderBodyDrop"
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
      @edit-project="openEditProject($event)"
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

    <ProjectAppearanceDialog
      :visible="appearanceDialog.visible"
      :project="appearanceDialog.project"
      @save="saveProjectAppearance"
      @cancel="closeEditProject"
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
.lp-overlay {
  --lp-accent: #38bdf8;
  --lp-accent-soft: rgba(56, 189, 248, 0.16);
  --lp-accent-strong: rgba(14, 165, 233, 0.42);
  --lp-folder-soft: rgba(245, 158, 11, 0.18);
  position: absolute;
  inset: 0;
  z-index: 20;
  background:
    radial-gradient(circle at 18% 18%, rgba(56, 189, 248, 0.14), transparent 24%),
    radial-gradient(circle at 82% 12%, rgba(245, 158, 11, 0.12), transparent 20%),
    linear-gradient(180deg, rgba(6, 10, 16, 0.78), rgba(4, 7, 12, 0.94));
  backdrop-filter: blur(40px) saturate(1.2);
  display: flex;
  flex-direction: column;
  animation: lp-fade-in 0.25s ease;
  overflow: hidden;
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
  padding: 24px 24px 16px;
  box-sizing: border-box;
  overflow: hidden;
}

/* ============ Search ============ */
.lp-search-bar {
  flex-shrink: 0;
  margin-bottom: 20px;
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
  margin-top: 40px;
}
.lp-error { color: #f87171; }
.lp-spinner { animation: spin 1s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }

.lp-empty {
  text-align: center;
  margin-top: 40px;
  color: #71717a;
}
.lp-empty-icon { font-size: 3em; margin-bottom: 16px; }
.lp-empty-hint { font-size: 0.82em; color: #52525b; margin-top: 8px; }

/* ============ Grid container ============ */
.lp-grid-container {
  flex: 1;
  width: 100%;
  max-width: 100%;
  padding: 0 8px 8px;
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
.lp-cell.drop-merge,
.lp-cell.drop-into-folder {
  background: var(--lp-accent-soft);
  box-shadow: 0 0 0 2px var(--lp-accent-strong);
  transform: scale(1.08);
}
.lp-cell.drop-before::before,
.lp-cell.drop-after::after {
  content: '';
  position: absolute;
  top: 10px;
  bottom: 10px;
  width: 4px;
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(125, 211, 252, 0.95), rgba(14, 165, 233, 0.95));
  box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.22), 0 0 14px rgba(56, 189, 248, 0.35);
}
.lp-cell.drop-before::before {
  left: -8px;
}
.lp-cell.drop-after::after {
  right: -8px;
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
  padding: 12px 0 8px;
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
