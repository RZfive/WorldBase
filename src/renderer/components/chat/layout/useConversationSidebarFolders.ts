import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type {
  ConversationDragItem,
  ConversationDropTarget,
  ConversationFolderLayout,
  ConversationSidebarEntry,
  ConversationSidebarItem,
  ConversationSidebarLayout
} from './ConversationSidebar.types'

const CONVERSATION_LAYOUT_STORAGE_KEY = 'conversation-sidebar-layout'
const DEFAULT_FOLDER_NAME = '新文件夹'
const TOP_LEVEL_EDGE_RATIO = 0.24
const FOLDER_ID_PREFIX = 'folder_'

function filterConversationIds (value: unknown): string[] {
  const seenConversationIds = new Set<string>()
  return Array.isArray(value)
    ? value
      .filter((conversationId): conversationId is string => typeof conversationId === 'string' && conversationId.trim().length > 0)
      .map(conversationId => conversationId.trim())
      .filter((conversationId) => {
        if (seenConversationIds.has(conversationId)) return false
        seenConversationIds.add(conversationId)
        return true
      })
    : []
}

function normalizeConversationFolders (value: unknown): ConversationFolderLayout[] {
  const seenFolderIds = new Set<string>()
  return Array.isArray(value)
    ? value
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null
        const record = entry as Record<string, unknown>
        const id = typeof record.id === 'string' ? record.id.trim() : ''
        if (!id || seenFolderIds.has(id)) return null
        seenFolderIds.add(id)
        const name = typeof record.name === 'string' && record.name.trim().length > 0
          ? record.name.trim()
          : DEFAULT_FOLDER_NAME
        return {
          id,
          name,
          conversationIds: filterConversationIds(record.conversationIds),
          collapsed: record.collapsed === true
        }
      })
      .filter((entry): entry is ConversationFolderLayout => Boolean(entry))
    : []
}

function normalizeTopLevelOrder (value: unknown): string[] {
  const seenKeys = new Set<string>()
  return Array.isArray(value)
    ? value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map(entry => entry.trim())
      .filter((entry) => {
        if (seenKeys.has(entry)) return false
        seenKeys.add(entry)
        return true
      })
    : []
}

function loadConversationLayout (): ConversationSidebarLayout {
  if (typeof window === 'undefined') {
    return { folders: [], topLevelOrder: [] }
  }

  try {
    const raw = window.localStorage.getItem(CONVERSATION_LAYOUT_STORAGE_KEY)
    if (!raw) {
      return { folders: [], topLevelOrder: [] }
    }
    const parsed = JSON.parse(raw) as { folders?: unknown; topLevelOrder?: unknown }
    return {
      folders: normalizeConversationFolders(parsed.folders),
      topLevelOrder: normalizeTopLevelOrder(parsed.topLevelOrder)
    }
  } catch {
    return { folders: [], topLevelOrder: [] }
  }
}

function conversationKey (conversationId: string): string {
  return `conversation:${conversationId}`
}

function folderKey (folderId: string): string {
  return `folder:${folderId}`
}

function parseConversationKey (key: string): { type: 'conversation' | 'folder'; id: string } | null {
  if (key.startsWith('conversation:')) {
    return { type: 'conversation', id: key.slice('conversation:'.length) }
  }
  if (key.startsWith('folder:')) {
    return { type: 'folder', id: key.slice('folder:'.length) }
  }
  return null
}

export function useConversationSidebarFolders (
  conversationItems: ComputedRef<ConversationSidebarItem[]>,
  searchQuery: Ref<string>,
  normalizeSearchValue: (value: string) => string
) {
  const initialConversationLayout = loadConversationLayout()
  const conversationFolders = ref<ConversationFolderLayout[]>(initialConversationLayout.folders)
  const conversationTopLevelOrder = ref<string[]>(initialConversationLayout.topLevelOrder)
  const renamingFolderId = ref<string | null>(null)
  const renameInput = ref('')
  const dragItem = ref<ConversationDragItem | null>(null)
  const dropTarget = ref<ConversationDropTarget | null>(null)

  function persistConversationLayout () {
    if (typeof window === 'undefined') return

    try {
      window.localStorage.setItem(CONVERSATION_LAYOUT_STORAGE_KEY, JSON.stringify({
        folders: conversationFolders.value.map((folder) => ({
          id: folder.id,
          name: folder.name,
          conversationIds: [...folder.conversationIds],
          collapsed: folder.collapsed
        })),
        topLevelOrder: [...conversationTopLevelOrder.value]
      }))
    } catch {
      // Ignore local persistence failures.
    }
  }

  function applyNormalizedConversationLayout () {
    const validConversationIds = new Set(conversationItems.value.map(item => item.id))
    const seenConversationIds = new Set<string>()

    const normalizedFolders = conversationFolders.value.map((folder) => {
      const conversationIds = folder.conversationIds.filter((conversationId) => {
        if (!validConversationIds.has(conversationId) || seenConversationIds.has(conversationId)) {
          return false
        }
        seenConversationIds.add(conversationId)
        return true
      })

      return {
        id: folder.id,
        name: folder.name.trim() || DEFAULT_FOLDER_NAME,
        conversationIds,
        collapsed: folder.collapsed === true
      }
    })

    const validTopLevelKeys = new Set<string>()
    normalizedFolders.forEach(folder => validTopLevelKeys.add(folderKey(folder.id)))
    conversationItems.value.forEach((item) => {
      if (!seenConversationIds.has(item.id)) {
        validTopLevelKeys.add(conversationKey(item.id))
      }
    })

    const nextTopLevelOrder = conversationTopLevelOrder.value.filter(entry => validTopLevelKeys.has(entry))

    normalizedFolders.forEach((folder) => {
      const key = folderKey(folder.id)
      if (!nextTopLevelOrder.includes(key)) {
        nextTopLevelOrder.push(key)
      }
    })

    conversationItems.value.forEach((item) => {
      if (seenConversationIds.has(item.id)) return
      const key = conversationKey(item.id)
      if (!nextTopLevelOrder.includes(key)) {
        nextTopLevelOrder.push(key)
      }
    })

    const previousLayout = JSON.stringify({
      folders: conversationFolders.value,
      topLevelOrder: conversationTopLevelOrder.value
    })
    const nextLayout = JSON.stringify({
      folders: normalizedFolders,
      topLevelOrder: nextTopLevelOrder
    })

    if (previousLayout !== nextLayout) {
      conversationFolders.value = normalizedFolders
      conversationTopLevelOrder.value = nextTopLevelOrder
      persistConversationLayout()
    }
  }

  watch(
    conversationItems,
    () => {
      applyNormalizedConversationLayout()
    },
    { immediate: true, deep: true }
  )

  const isSearching = computed(() => normalizeSearchValue(searchQuery.value).length > 0)
  const conversationItemsById = computed(() => new Map(conversationItems.value.map(item => [item.id, item])))

  function matchesConversationQuery (item: ConversationSidebarItem, query = normalizeSearchValue(searchQuery.value)): boolean {
    if (!query) return true
    const haystack = normalizeSearchValue([item.title, item.subtitle, item.searchText].join(' '))
    return haystack.includes(query)
  }

  const conversationEntries = computed<ConversationSidebarEntry[]>(() => {
    const query = normalizeSearchValue(searchQuery.value)
    const folderEntries = new Map<string, ConversationSidebarEntry>()

    conversationFolders.value.forEach((folder) => {
      const items = folder.conversationIds
        .map(id => conversationItemsById.value.get(id))
        .filter(Boolean) as ConversationSidebarItem[]
      const matchedItems = query ? items.filter(item => matchesConversationQuery(item, query)) : items
      const folderNameMatches = query ? normalizeSearchValue(folder.name).includes(query) : true
      const visibleItems = query ? (folderNameMatches ? items : matchedItems) : items

      if (!query || folderNameMatches || matchedItems.length > 0) {
        folderEntries.set(folder.id, {
          kind: 'folder',
          folder,
          items,
          visibleItems,
          previewItems: items.slice(0, 3)
        })
      }
    })

    const entries: ConversationSidebarEntry[] = []
    conversationTopLevelOrder.value.forEach((key) => {
      const parsedKey = parseConversationKey(key)
      if (!parsedKey) return

      if (parsedKey.type === 'conversation') {
        const item = conversationItemsById.value.get(parsedKey.id)
        if (!item || !matchesConversationQuery(item, query)) return
        entries.push({ kind: 'conversation', item })
        return
      }

      const folderEntry = folderEntries.get(parsedKey.id)
      if (folderEntry) {
        entries.push(folderEntry)
      }
    })

    return entries
  })

  const filteredConversationCount = computed(() => {
    return conversationItems.value.filter(item => matchesConversationQuery(item)).length
  })

  function getFolderById (folderId: string): ConversationFolderLayout | null {
    return conversationFolders.value.find(folder => folder.id === folderId) || null
  }

  function getFolderByConversationId (conversationId: string): ConversationFolderLayout | null {
    return conversationFolders.value.find(folder => folder.conversationIds.includes(conversationId)) || null
  }

  function finalizeConversationLayout () {
    applyNormalizedConversationLayout()
    persistConversationLayout()
  }

  function isFolderExpanded (folder: ConversationFolderLayout, visibleCount: number): boolean {
    if (isSearching.value) {
      return visibleCount > 0
    }
    return !folder.collapsed
  }

  function createEmptyFolder () {
    const id = `${FOLDER_ID_PREFIX}${Date.now().toString(36)}`
    conversationFolders.value.push({
      id,
      name: DEFAULT_FOLDER_NAME,
      conversationIds: [],
      collapsed: false
    })
    conversationTopLevelOrder.value = [...conversationTopLevelOrder.value, folderKey(id)]
    renamingFolderId.value = id
    renameInput.value = DEFAULT_FOLDER_NAME
    finalizeConversationLayout()
  }

  function startRenameFolder (folder: ConversationFolderLayout) {
    renamingFolderId.value = folder.id
    renameInput.value = folder.name
  }

  function commitRenameFolder (folderId: string) {
    const folder = getFolderById(folderId)
    if (folder) {
      folder.name = renameInput.value.trim() || folder.name || DEFAULT_FOLDER_NAME
      finalizeConversationLayout()
    }
    renamingFolderId.value = null
  }

  function cancelRenameFolder () {
    renamingFolderId.value = null
    renameInput.value = ''
  }

  function toggleFolderCollapsed (folderId: string) {
    const folder = getFolderById(folderId)
    if (!folder) return
    folder.collapsed = !folder.collapsed
    finalizeConversationLayout()
  }

  function detachConversationFromCurrentLocation (conversationId: string) {
    const sourceFolder = getFolderByConversationId(conversationId)
    if (sourceFolder) {
      sourceFolder.conversationIds = sourceFolder.conversationIds.filter(id => id !== conversationId)
      return
    }

    conversationTopLevelOrder.value = conversationTopLevelOrder.value.filter(key => key !== conversationKey(conversationId))
  }

  function reorderTopLevelItem (
    item: ConversationDragItem,
    targetId: string,
    targetType: 'conversation' | 'folder',
    position: 'before' | 'after'
  ) {
    const movingKey = item.type === 'folder' ? folderKey(item.id) : conversationKey(item.id)
    const targetKey = targetType === 'folder' ? folderKey(targetId) : conversationKey(targetId)
    if (movingKey === targetKey) return

    if (item.type === 'conversation' && item.source === 'folder' && item.folderId) {
      const sourceFolder = getFolderById(item.folderId)
      if (sourceFolder) {
        sourceFolder.conversationIds = sourceFolder.conversationIds.filter(id => id !== item.id)
      }
    }

    const nextOrder = conversationTopLevelOrder.value.filter(key => key !== movingKey)
    let targetIndex = nextOrder.indexOf(targetKey)
    if (targetIndex === -1) targetIndex = nextOrder.length
    if (position === 'after') targetIndex += 1
    nextOrder.splice(targetIndex, 0, movingKey)
    conversationTopLevelOrder.value = nextOrder
    finalizeConversationLayout()
  }

  function reorderConversationWithinFolder (
    item: ConversationDragItem,
    targetConversationId: string,
    folderId: string,
    position: 'before' | 'after'
  ) {
    if (item.type !== 'conversation') return

    const targetFolder = getFolderById(folderId)
    if (!targetFolder) return

    if (item.source === 'folder' && item.folderId === folderId) {
      const nextIds = targetFolder.conversationIds.filter(id => id !== item.id)
      let targetIndex = nextIds.indexOf(targetConversationId)
      if (targetIndex === -1) targetIndex = nextIds.length
      if (position === 'after') targetIndex += 1
      nextIds.splice(targetIndex, 0, item.id)
      targetFolder.conversationIds = nextIds
      finalizeConversationLayout()
      return
    }

    detachConversationFromCurrentLocation(item.id)

    const nextIds = targetFolder.conversationIds.filter(id => id !== item.id)
    let targetIndex = nextIds.indexOf(targetConversationId)
    if (targetIndex === -1) targetIndex = nextIds.length
    if (position === 'after') targetIndex += 1
    nextIds.splice(targetIndex, 0, item.id)
    targetFolder.conversationIds = nextIds
    targetFolder.collapsed = false
    finalizeConversationLayout()
  }

  function appendToTopLevel (item: ConversationDragItem) {
    const movingKey = item.type === 'folder' ? folderKey(item.id) : conversationKey(item.id)

    if (item.type === 'conversation' && item.source === 'folder' && item.folderId) {
      const sourceFolder = getFolderById(item.folderId)
      if (sourceFolder) {
        sourceFolder.conversationIds = sourceFolder.conversationIds.filter(id => id !== item.id)
      }
    }

    const nextOrder = conversationTopLevelOrder.value.filter(key => key !== movingKey)
    nextOrder.push(movingKey)
    conversationTopLevelOrder.value = nextOrder
    finalizeConversationLayout()
  }

  function appendConversationToFolderEnd (item: ConversationDragItem, folderId: string) {
    if (item.type !== 'conversation') return

    const targetFolder = getFolderById(folderId)
    if (!targetFolder) return

    if (item.source === 'folder' && item.folderId === folderId) {
      targetFolder.conversationIds = targetFolder.conversationIds.filter(id => id !== item.id)
      targetFolder.conversationIds.push(item.id)
      finalizeConversationLayout()
      return
    }

    detachConversationFromCurrentLocation(item.id)
    targetFolder.conversationIds = targetFolder.conversationIds.filter(id => id !== item.id)
    targetFolder.conversationIds.push(item.id)
    targetFolder.collapsed = false
    finalizeConversationLayout()
  }

  function createFolderWith (draggedConversationId: string, targetConversationId: string) {
    const targetKey = conversationKey(targetConversationId)
    const targetIndex = conversationTopLevelOrder.value.indexOf(targetKey)
    const id = `${FOLDER_ID_PREFIX}${Date.now().toString(36)}`

    detachConversationFromCurrentLocation(draggedConversationId)
    conversationTopLevelOrder.value = conversationTopLevelOrder.value.filter(key => key !== targetKey)
    conversationFolders.value.push({
      id,
      name: DEFAULT_FOLDER_NAME,
      conversationIds: [targetConversationId, draggedConversationId],
      collapsed: false
    })

    const nextOrder = [...conversationTopLevelOrder.value]
    const insertIndex = targetIndex >= 0 ? Math.min(targetIndex, nextOrder.length) : nextOrder.length
    nextOrder.splice(insertIndex, 0, folderKey(id))
    conversationTopLevelOrder.value = nextOrder
    renamingFolderId.value = id
    renameInput.value = DEFAULT_FOLDER_NAME
    finalizeConversationLayout()
  }

  function resetDragState () {
    dragItem.value = null
    dropTarget.value = null
  }

  function onConversationDragStart (
    event: DragEvent,
    conversationId: string,
    source: 'top-level' | 'folder' = 'top-level',
    folderId: string | null = null
  ) {
    if (isSearching.value) return

    dragItem.value = {
      id: conversationId,
      type: 'conversation',
      source,
      folderId
    }
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', conversationId)
    }
  }

  function onFolderDragStart (event: DragEvent, folderId: string) {
    if (isSearching.value) return

    dragItem.value = {
      id: folderId,
      type: 'folder',
      source: 'top-level'
    }
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', folderId)
    }
  }

  function resolveTopLevelDropTarget (event: DragEvent, targetId: string, targetType: 'conversation' | 'folder'): ConversationDropTarget | null {
    if (!dragItem.value) return null
    if (dragItem.value.id === targetId && dragItem.value.type === targetType) return null

    const element = event.currentTarget as HTMLElement | null
    if (!element) return null
    const rect = element.getBoundingClientRect()
    const relativeY = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5

    if (relativeY <= TOP_LEVEL_EDGE_RATIO) {
      return { id: targetId, type: targetType, action: 'before' }
    }

    if (relativeY >= 1 - TOP_LEVEL_EDGE_RATIO) {
      return { id: targetId, type: targetType, action: 'after' }
    }

    if (dragItem.value.type === 'conversation') {
      return {
        id: targetId,
        type: targetType,
        action: targetType === 'folder' ? 'into-folder' : 'merge'
      }
    }

    return {
      id: targetId,
      type: targetType,
      action: relativeY < 0.5 ? 'before' : 'after'
    }
  }

  function resolveFolderConversationDropTarget (event: DragEvent, targetConversationId: string, folderId: string): ConversationDropTarget | null {
    if (!dragItem.value || dragItem.value.type !== 'conversation') return null
    if (dragItem.value.id === targetConversationId && dragItem.value.folderId === folderId) return null

    const element = event.currentTarget as HTMLElement | null
    if (!element) return null
    const rect = element.getBoundingClientRect()
    const relativeY = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5

    return {
      id: targetConversationId,
      type: 'conversation',
      action: relativeY < 0.5 ? 'before' : 'after',
      folderId
    }
  }

  function onTopLevelDragOver (event: DragEvent, targetId: string, targetType: 'conversation' | 'folder') {
    if (!dragItem.value || isSearching.value) return
    event.preventDefault()
    dropTarget.value = resolveTopLevelDropTarget(event, targetId, targetType)
  }

  function onFolderConversationDragOver (event: DragEvent, targetConversationId: string, folderId: string) {
    if (!dragItem.value || isSearching.value) return
    event.preventDefault()
    dropTarget.value = resolveFolderConversationDropTarget(event, targetConversationId, folderId)
  }

  function onConversationSectionDragOver (event: DragEvent) {
    if (!dragItem.value || isSearching.value) return
    event.preventDefault()
    dropTarget.value = { id: '__section__', type: 'section', action: 'append' }
  }

  function onFolderBodyDragOver (event: DragEvent, folderId: string) {
    if (!dragItem.value || dragItem.value.type !== 'conversation' || isSearching.value) return
    event.preventDefault()
    dropTarget.value = { id: folderId, type: 'folder-body', action: 'append', folderId }
  }

  function onDragLeave (event: DragEvent) {
    const nextTarget = event.relatedTarget as Node | null
    const currentTarget = event.currentTarget as HTMLElement | null
    if (nextTarget && currentTarget?.contains(nextTarget)) {
      return
    }
    dropTarget.value = null
  }

  function onTopLevelDrop (event: DragEvent, targetId: string, targetType: 'conversation' | 'folder') {
    if (!dragItem.value || isSearching.value) return
    event.preventDefault()

    const nextDropTarget = resolveTopLevelDropTarget(event, targetId, targetType)
    const currentDragItem = dragItem.value
    if (!nextDropTarget) {
      resetDragState()
      return
    }

    if (nextDropTarget.action === 'before' || nextDropTarget.action === 'after') {
      reorderTopLevelItem(currentDragItem, targetId, targetType, nextDropTarget.action)
    } else if (nextDropTarget.action === 'merge' && currentDragItem.type === 'conversation' && targetType === 'conversation') {
      createFolderWith(currentDragItem.id, targetId)
    } else if (nextDropTarget.action === 'into-folder' && currentDragItem.type === 'conversation' && targetType === 'folder') {
      appendConversationToFolderEnd(currentDragItem, targetId)
    }

    resetDragState()
  }

  function onFolderConversationDrop (event: DragEvent, targetConversationId: string, folderId: string) {
    if (!dragItem.value || dragItem.value.type !== 'conversation' || isSearching.value) return
    event.preventDefault()

    const nextDropTarget = resolveFolderConversationDropTarget(event, targetConversationId, folderId)
    const currentDragItem = dragItem.value
    if (nextDropTarget && (nextDropTarget.action === 'before' || nextDropTarget.action === 'after')) {
      reorderConversationWithinFolder(currentDragItem, targetConversationId, folderId, nextDropTarget.action)
    }

    resetDragState()
  }

  function onConversationSectionDrop () {
    if (!dragItem.value || isSearching.value) return
    appendToTopLevel(dragItem.value)
    resetDragState()
  }

  function onFolderBodyDrop (folderId: string) {
    if (!dragItem.value || dragItem.value.type !== 'conversation' || isSearching.value) return
    appendConversationToFolderEnd(dragItem.value, folderId)
    resetDragState()
  }

  function topLevelDropClass (targetId: string, targetType: 'conversation' | 'folder'): string | null {
    if (!dropTarget.value || dropTarget.value.id !== targetId || dropTarget.value.type !== targetType) return null
    return `drop-${dropTarget.value.action}`
  }

  function folderBodyDropClass (folderId: string): string | null {
    if (!dropTarget.value || dropTarget.value.type !== 'folder-body' || dropTarget.value.id !== folderId) return null
    return 'drop-append'
  }

  function conversationSectionDropClass (): string | null {
    if (!dropTarget.value || dropTarget.value.type !== 'section') return null
    return 'drop-append'
  }

  return {
    conversationEntries,
    filteredConversationCount,
    isSearching,
    renamingFolderId,
    renameInput,
    dragItem,
    createEmptyFolder,
    startRenameFolder,
    commitRenameFolder,
    cancelRenameFolder,
    toggleFolderCollapsed,
    isFolderExpanded,
    onConversationDragStart,
    onFolderDragStart,
    onTopLevelDragOver,
    onFolderConversationDragOver,
    onConversationSectionDragOver,
    onFolderBodyDragOver,
    onDragLeave,
    onTopLevelDrop,
    onFolderConversationDrop,
    onConversationSectionDrop,
    onFolderBodyDrop,
    topLevelDropClass,
    folderBodyDropClass,
    conversationSectionDropClass,
    resetDragState
  }
}
