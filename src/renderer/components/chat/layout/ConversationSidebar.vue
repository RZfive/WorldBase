<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'

interface AgentSidebarItem {
  id: string
  conversationId: string | null
  title: string
  subtitle: string
  searchText: string
  icon: string
  modelId: string
  providerName: string
  modelOptions: string[]
  isStreaming: boolean
  pendingAuthCount: number
  isActive: boolean
}

interface GroupSidebarItem {
  id: string
  conversationId: string | null
  title: string
  subtitle: string
  searchText: string
  icon: string
  isStreaming: boolean
  pendingAuthCount: number
  isActive: boolean
}

interface ConversationSidebarItem {
  id: string
  title: string
  subtitle: string
  searchText: string
  icon: string
  isStreaming: boolean
  pendingAuthCount: number
  isActive: boolean
}

interface ConversationFolderLayout {
  id: string
  name: string
  conversationIds: string[]
  collapsed: boolean
}

interface ConversationSidebarLayout {
  folders: ConversationFolderLayout[]
  topLevelOrder: string[]
}

interface ConversationDragItem {
  id: string
  type: 'conversation' | 'folder'
  source: 'top-level' | 'folder'
  folderId?: string | null
}

interface ConversationDropTarget {
  id: string
  type: 'conversation' | 'folder' | 'section' | 'folder-body'
  action: 'before' | 'after' | 'merge' | 'into-folder' | 'append'
  folderId?: string | null
}

type ConversationSidebarEntry =
  | { kind: 'conversation'; item: ConversationSidebarItem }
  | {
    kind: 'folder'
    folder: ConversationFolderLayout
    items: ConversationSidebarItem[]
    visibleItems: ConversationSidebarItem[]
    previewItems: ConversationSidebarItem[]
  }

const props = defineProps<{
  agentItems: AgentSidebarItem[]
  groupItems: GroupSidebarItem[]
  conversationItems: ConversationSidebarItem[]
}>()

const emit = defineEmits<{
  (e: 'newConversation'): void
  (e: 'selectConversation', id: string): void
  (e: 'openAgent', agentId: string): void
  (e: 'openGroup', groupId: string): void
  (e: 'deleteConversation', id: string): void
}>()

const CONVERSATION_LAYOUT_STORAGE_KEY = 'conversation-sidebar-layout'
const DEFAULT_FOLDER_NAME = '新文件夹'
const TOP_LEVEL_EDGE_RATIO = 0.24
const FOLDER_ID_PREFIX = 'folder_'

const searchQuery = ref('')
const collapsedSections = reactive({
  agents: false,
  groups: false,
  conversations: false
})
const renamingFolderId = ref<string | null>(null)
const renameInput = ref('')
const dragItem = ref<ConversationDragItem | null>(null)
const dropTarget = ref<ConversationDropTarget | null>(null)

function normalizeSearchValue (value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function filterItems<T extends { title: string; subtitle: string; searchText: string }> (items: T[]): T[] {
  const query = normalizeSearchValue(searchQuery.value)
  if (!query) {
    return items
  }

  return items.filter((item) => {
    const haystack = normalizeSearchValue([item.title, item.subtitle, item.searchText].join(' '))
    return haystack.includes(query)
  })
}

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

const initialConversationLayout = loadConversationLayout()
const conversationFolders = ref<ConversationFolderLayout[]>(initialConversationLayout.folders)
const conversationTopLevelOrder = ref<string[]>(initialConversationLayout.topLevelOrder)

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
  const validConversationIds = new Set(props.conversationItems.map(item => item.id))
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
  props.conversationItems.forEach((item) => {
    if (!seenConversationIds.has(item.id)) {
      validTopLevelKeys.add(conversationKey(item.id))
    }
  })

  const nextTopLevelOrder = conversationTopLevelOrder.value.filter((entry) => {
    return validTopLevelKeys.has(entry)
  })

  normalizedFolders.forEach((folder) => {
    const key = folderKey(folder.id)
    if (!nextTopLevelOrder.includes(key)) {
      nextTopLevelOrder.push(key)
    }
  })

  props.conversationItems.forEach((item) => {
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
  () => props.conversationItems,
  () => {
    applyNormalizedConversationLayout()
  },
  { immediate: true, deep: true }
)

const isSearching = computed(() => normalizeSearchValue(searchQuery.value).length > 0)
const filteredAgentItems = computed(() => filterItems(props.agentItems))
const filteredGroupItems = computed(() => filterItems(props.groupItems))
const conversationItemsById = computed(() => {
  return new Map(props.conversationItems.map(item => [item.id, item]))
})

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
  return props.conversationItems.filter(item => matchesConversationQuery(item)).length
})

const hasVisibleItems = computed(() => {
  return filteredAgentItems.value.length > 0 || filteredGroupItems.value.length > 0 || conversationEntries.value.length > 0
})

function toggleSection (key: 'agents' | 'groups' | 'conversations') {
  collapsedSections[key] = !collapsedSections[key]
}

function isSectionExpanded (key: 'agents' | 'groups' | 'conversations', itemsCount: number): boolean {
  if (isSearching.value) {
    return itemsCount > 0
  }
  return !collapsedSections[key]
}

function isFolderExpanded (folder: ConversationFolderLayout, visibleCount: number): boolean {
  if (isSearching.value) {
    return visibleCount > 0
  }
  return !folder.collapsed
}

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
  const currentDragItem = dragItem.value
  appendToTopLevel(currentDragItem)
  resetDragState()
}

function onFolderBodyDrop (folderId: string) {
  if (!dragItem.value || dragItem.value.type !== 'conversation' || isSearching.value) return
  const currentDragItem = dragItem.value
  appendConversationToFolderEnd(currentDragItem, folderId)
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

// ── Collapse/expand ──────────────────────────────────────────────────────────
// Uses CSS grid-template-rows transition (0fr ↔ 1fr) to avoid layout thrashing
// that occurs when animating height on every frame.
</script>

<template>
  <div class="conv-sidebar">
    <div class="conv-toolbar">
      <button class="new-conv-btn" type="button" @click="emit('newConversation')">+ 新对话</button>
      <label class="conv-search-shell">
        <span class="conv-search-icon">⌕</span>
        <input
          v-model="searchQuery"
          class="conv-search-input"
          type="search"
          placeholder="搜索 Agent、群聊、文件夹或对话内容"
        >
        <button
          v-if="searchQuery"
          class="conv-search-clear"
          type="button"
          title="清空搜索"
          @click="searchQuery = ''"
        >×</button>
      </label>
    </div>
    <div class="conv-list">
      <section v-if="props.agentItems.length > 0" class="conv-section">
        <button
          class="conv-section-toggle"
          :class="{ collapsed: !isSectionExpanded('agents', filteredAgentItems.length) }"
          type="button"
          @click="toggleSection('agents')"
        >
          <span class="conv-section-toggle-copy">
            <span class="conv-section-title">Agent</span>
            <span class="conv-section-hint">专属工作流</span>
          </span>
          <span class="conv-section-meta">{{ filteredAgentItems.length }}/{{ props.agentItems.length }}</span>
          <span class="conv-section-caret-shell" aria-hidden="true">
            <svg class="conv-section-caret" viewBox="0 0 16 16" fill="none">
              <path d="M4.5 6.25L8 9.75L11.5 6.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
        </button>
        <div
          class="conv-section-body"
          :class="{ collapsed: !isSectionExpanded('agents', filteredAgentItems.length) }"
        >
          <div class="conv-section-body-inner">
            <div
              v-for="item in filteredAgentItems"
              :key="`agent-${item.id}`"
              :class="['conv-item', 'agent-item', { active: item.isActive, streaming: item.isStreaming, waitingAuth: item.pendingAuthCount > 0 }]"
              @click="emit('openAgent', item.id)"
            >
              <div class="conv-main">
                <span class="conv-avatar-shell agent">
                  <span class="conv-icon">{{ item.icon }}</span>
                </span>
                <div class="conv-copy">
                  <div class="conv-title-row">
                    <div class="conv-title-stack">
                      <span class="conv-title">{{ item.title }}</span>
                    </div>
                    <span v-if="item.pendingAuthCount > 0" class="conv-status auth" :title="`等待授权${item.pendingAuthCount > 1 ? ` ${item.pendingAuthCount} 项` : ''}`">
                      <span class="conv-status-dot"></span>
                      待授权<span v-if="item.pendingAuthCount > 1" class="conv-status-count">{{ item.pendingAuthCount }}</span>
                    </span>
                    <span v-else-if="item.isStreaming" class="conv-status streaming" title="生成中">
                      <span class="conv-status-dot"></span>
                      运行中
                    </span>
                  </div>
                  <span class="conv-subtitle">{{ item.subtitle }}</span>
                </div>
              </div>

              <button
                v-if="item.conversationId"
                class="conv-delete"
                type="button"
                title="删除该 Agent 会话"
                @click.stop="emit('deleteConversation', item.conversationId)"
              >×</button>
            </div>
          </div>
        </div>
      </section>

      <section v-if="props.groupItems.length > 0" class="conv-section">
        <button
          class="conv-section-toggle"
          :class="{ collapsed: !isSectionExpanded('groups', filteredGroupItems.length) }"
          type="button"
          @click="toggleSection('groups')"
        >
          <span class="conv-section-toggle-copy">
            <span class="conv-section-title">群组</span>
            <span class="conv-section-hint">多 Agent 协作</span>
          </span>
          <span class="conv-section-meta">{{ filteredGroupItems.length }}/{{ props.groupItems.length }}</span>
          <span class="conv-section-caret-shell" aria-hidden="true">
            <svg class="conv-section-caret" viewBox="0 0 16 16" fill="none">
              <path d="M4.5 6.25L8 9.75L11.5 6.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
        </button>
        <div
          class="conv-section-body"
          :class="{ collapsed: !isSectionExpanded('groups', filteredGroupItems.length) }"
        >
          <div class="conv-section-body-inner">
            <div
              v-for="item in filteredGroupItems"
              :key="`group-${item.id}`"
              :class="['conv-item', 'group-item', { active: item.isActive, streaming: item.isStreaming, waitingAuth: item.pendingAuthCount > 0 }]"
              @click="emit('openGroup', item.id)"
            >
              <div class="conv-main">
                <span class="conv-avatar-shell group">
                  <span class="conv-icon group">{{ item.icon }}</span>
                </span>
                <div class="conv-copy">
                  <div class="conv-title-row">
                    <div class="conv-title-stack">
                      <span class="conv-title">{{ item.title }}</span>
                    </div>
                    <span v-if="item.pendingAuthCount > 0" class="conv-status auth" :title="`等待授权${item.pendingAuthCount > 1 ? ` ${item.pendingAuthCount} 项` : ''}`">
                      <span class="conv-status-dot"></span>
                      待授权<span v-if="item.pendingAuthCount > 1" class="conv-status-count">{{ item.pendingAuthCount }}</span>
                    </span>
                    <span v-else-if="item.isStreaming" class="conv-status streaming" title="生成中">
                      <span class="conv-status-dot"></span>
                      运行中
                    </span>
                  </div>
                  <span class="conv-subtitle">{{ item.subtitle }}</span>
                </div>
              </div>
              <button
                v-if="item.conversationId"
                class="conv-delete"
                type="button"
                title="删除该群组会话"
                @click.stop="emit('deleteConversation', item.conversationId)"
              >×</button>
            </div>
          </div>
        </div>
      </section>

      <section v-if="props.conversationItems.length > 0 || conversationEntries.length > 0" class="conv-section">
        <div class="conv-section-header-row">
          <button
            class="conv-section-toggle"
            :class="{ collapsed: !isSectionExpanded('conversations', conversationEntries.length) }"
            type="button"
            @click="toggleSection('conversations')"
          >
            <span class="conv-section-toggle-copy">
              <span class="conv-section-title">对话</span>
              <span class="conv-section-hint">自由聊天记录</span>
            </span>
            <span class="conv-section-meta">{{ filteredConversationCount }}/{{ props.conversationItems.length }}</span>
            <span class="conv-section-caret-shell" aria-hidden="true">
              <svg class="conv-section-caret" viewBox="0 0 16 16" fill="none">
                <path d="M4.5 6.25L8 9.75L11.5 6.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
          </button>
          <button class="conv-folder-add-btn" type="button" title="新建空文件夹" @click="createEmptyFolder">+ 文件夹</button>
        </div>
        <div
          class="conv-section-body"
          :class="{ collapsed: !isSectionExpanded('conversations', conversationEntries.length) }"
        >
          <div
            :class="['conv-section-body-inner', 'conv-section-body-conversations', conversationSectionDropClass()]"
            @dragover="onConversationSectionDragOver"
            @dragleave="onDragLeave"
            @drop="onConversationSectionDrop"
          >
            <template v-for="entry in conversationEntries" :key="entry.kind === 'folder' ? `folder-${entry.folder.id}` : entry.item.id">
              <div
                v-if="entry.kind === 'conversation'"
                :class="[
                  'conv-item',
                  'conversation-item',
                  topLevelDropClass(entry.item.id, 'conversation'),
                  { active: entry.item.isActive, streaming: entry.item.isStreaming, waitingAuth: entry.item.pendingAuthCount > 0, dragging: dragItem?.type === 'conversation' && dragItem.id === entry.item.id }
                ]"
                :draggable="!isSearching"
                @dragstart="onConversationDragStart($event, entry.item.id)"
                @dragover="onTopLevelDragOver($event, entry.item.id, 'conversation')"
                @dragleave="onDragLeave"
                @drop="onTopLevelDrop($event, entry.item.id, 'conversation')"
                @dragend="resetDragState"
                @click="emit('selectConversation', entry.item.id)"
              >
                <div class="conv-main">
                  <span class="conv-avatar-shell conversation">
                    <span class="conv-icon conversation">{{ entry.item.icon }}</span>
                  </span>
                  <div class="conv-copy">
                    <div class="conv-title-row">
                      <div class="conv-title-stack">
                        <span class="conv-title">{{ entry.item.title }}</span>
                      </div>
                      <span v-if="entry.item.pendingAuthCount > 0" class="conv-status auth" :title="`等待授权${entry.item.pendingAuthCount > 1 ? ` ${entry.item.pendingAuthCount} 项` : ''}`">
                        <span class="conv-status-dot"></span>
                        待授权<span v-if="entry.item.pendingAuthCount > 1" class="conv-status-count">{{ entry.item.pendingAuthCount }}</span>
                      </span>
                      <span v-else-if="entry.item.isStreaming" class="conv-status streaming" title="生成中">
                        <span class="conv-status-dot"></span>
                        运行中
                      </span>
                    </div>
                    <span class="conv-subtitle">{{ entry.item.subtitle }}</span>
                  </div>
                </div>
                <button class="conv-delete" type="button" title="删除" @click.stop="emit('deleteConversation', entry.item.id)">×</button>
              </div>

              <div
                v-else
                :class="[
                  'conv-folder',
                  topLevelDropClass(entry.folder.id, 'folder'),
                  folderBodyDropClass(entry.folder.id),
                  { expanded: isFolderExpanded(entry.folder, entry.visibleItems.length), dragging: dragItem?.type === 'folder' && dragItem.id === entry.folder.id }
                ]"
              >
                <div
                  class="conv-folder-shell"
                  :draggable="!isSearching"
                  @dragstart="onFolderDragStart($event, entry.folder.id)"
                  @dragover="onTopLevelDragOver($event, entry.folder.id, 'folder')"
                  @dragleave="onDragLeave"
                  @drop="onTopLevelDrop($event, entry.folder.id, 'folder')"
                  @dragend="resetDragState"
                >
                  <button class="conv-folder-toggle" type="button" @click="toggleFolderCollapsed(entry.folder.id)">
                    <div class="conv-main conv-folder-main">
                      <span class="conv-avatar-shell conversation conv-folder-avatar-shell">
                        <span class="conv-icon conversation">📁</span>
                      </span>
                      <div class="conv-copy conv-folder-copy">
                        <div class="conv-title-row conv-folder-title-row">
                          <div class="conv-title-stack conv-folder-title-stack">
                            <input
                              v-if="renamingFolderId === entry.folder.id"
                              :value="renameInput"
                              class="conv-folder-rename-input"
                              autofocus
                              @input="renameInput = ($event.target as HTMLInputElement).value"
                              @keydown.enter.prevent="commitRenameFolder(entry.folder.id)"
                              @keydown.escape="cancelRenameFolder"
                              @blur="commitRenameFolder(entry.folder.id)"
                              @click.stop
                            >
                            <span
                              v-else
                              class="conv-title conv-folder-title"
                              title="双击重命名文件夹"
                              @dblclick.stop="startRenameFolder(entry.folder)"
                            >{{ entry.folder.name }}</span>
                            <span class="conv-folder-meta">{{ entry.items.length }} 个对话</span>
                          </div>
                          <span class="conv-folder-caret-shell" aria-hidden="true">
                            <svg class="conv-folder-caret" viewBox="0 0 16 16" fill="none">
                              <path d="M4.5 6.25L8 9.75L11.5 6.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                            </svg>
                          </span>
                        </div>
                        <div class="conv-folder-preview" :class="{ empty: entry.previewItems.length === 0 }">
                          <span v-if="entry.previewItems.length === 0" class="conv-folder-pill empty">空文件夹，拖拽对话到这里</span>
                          <span v-for="item in entry.previewItems" :key="`${entry.folder.id}-${item.id}`" class="conv-folder-pill">
                            {{ item.title }}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                </div>

                <div
                  v-if="isFolderExpanded(entry.folder, entry.visibleItems.length)"
                  :class="['conv-folder-children', folderBodyDropClass(entry.folder.id)]"
                  @dragover="onFolderBodyDragOver($event, entry.folder.id)"
                  @dragleave="onDragLeave"
                  @drop="onFolderBodyDrop(entry.folder.id)"
                >
                  <div
                    v-if="entry.visibleItems.length === 0"
                    class="conv-folder-empty"
                  >空文件夹，拖拽对话到这里</div>
                  <div
                    v-for="item in entry.visibleItems"
                    :key="`${entry.folder.id}-${item.id}`"
                    :class="[
                      'conv-item',
                      'conversation-item',
                      'conversation-item-nested',
                      topLevelDropClass(item.id, 'conversation'),
                      { active: item.isActive, streaming: item.isStreaming, waitingAuth: item.pendingAuthCount > 0, dragging: dragItem?.type === 'conversation' && dragItem.id === item.id }
                    ]"
                    :draggable="!isSearching"
                    @dragstart="onConversationDragStart($event, item.id, 'folder', entry.folder.id)"
                    @dragover="onFolderConversationDragOver($event, item.id, entry.folder.id)"
                    @dragleave="onDragLeave"
                    @drop="onFolderConversationDrop($event, item.id, entry.folder.id)"
                    @dragend="resetDragState"
                    @click="emit('selectConversation', item.id)"
                  >
                    <div class="conv-main">
                      <span class="conv-avatar-shell conversation">
                        <span class="conv-icon conversation">{{ item.icon }}</span>
                      </span>
                      <div class="conv-copy">
                        <div class="conv-title-row">
                          <div class="conv-title-stack">
                            <span class="conv-title">{{ item.title }}</span>
                          </div>
                          <span v-if="item.pendingAuthCount > 0" class="conv-status auth" :title="`等待授权${item.pendingAuthCount > 1 ? ` ${item.pendingAuthCount} 项` : ''}`">
                            <span class="conv-status-dot"></span>
                            待授权<span v-if="item.pendingAuthCount > 1" class="conv-status-count">{{ item.pendingAuthCount }}</span>
                          </span>
                          <span v-else-if="item.isStreaming" class="conv-status streaming" title="生成中">
                            <span class="conv-status-dot"></span>
                            运行中
                          </span>
                        </div>
                        <span class="conv-subtitle">{{ item.subtitle }}</span>
                      </div>
                    </div>
                    <button class="conv-delete" type="button" title="删除" @click.stop="emit('deleteConversation', item.id)">×</button>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
      </section>

      <div v-if="!hasVisibleItems" class="conv-empty">{{ isSearching ? '没有找到匹配的对话内容' : '暂无对话记录' }}</div>
    </div>
  </div>
</template>

<style scoped>
.conv-sidebar {
  width: 252px;
  background: var(--app-panel);
  border-right: 1px solid var(--app-border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.conv-toolbar {
  padding: 12px 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 84%, transparent);
}

.new-conv-btn {
  padding: 9px 0;
  background: var(--app-accent);
  color: #ffffff;
  border: none;
  border-radius: 10px;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  transition: background 0.18s ease, border-color 0.18s ease;
}

.new-conv-btn:hover {
  background: var(--app-accent-strong);
}

.conv-search-shell {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  min-height: 38px;
  border-radius: 10px;
  border: 1px solid var(--app-border);
  background: var(--app-input-bg);
}

.conv-search-shell:focus-within {
  border-color: var(--app-accent);
  box-shadow: 0 0 0 1px var(--app-accent-soft);
}

.conv-search-icon {
  color: var(--app-text-faint);
  font-size: 0.84rem;
  flex-shrink: 0;
}

.conv-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--app-text);
  font-size: 0.8rem;
  outline: none;
}

.conv-search-input::placeholder {
  color: var(--app-text-faint);
}

.conv-search-clear {
  border: none;
  background: transparent;
  color: var(--app-text-faint);
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  padding: 0;
}

.conv-search-clear:hover {
  color: var(--app-danger);
}

.conv-list {
  flex: 1;
  overflow-y: auto;
  padding: 10px 8px 12px;
}

.conv-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.conv-section-header-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
}

.conv-section-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--app-border) 88%, transparent);
  background: color-mix(in srgb, var(--app-panel-muted) 54%, transparent);
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease;
}

.conv-section-toggle:hover {
  border-color: color-mix(in srgb, var(--app-accent) 22%, var(--app-border));
  background: color-mix(in srgb, var(--app-panel-muted) 72%, transparent);
}

.conv-section-toggle.collapsed {
  background: transparent;
}

.conv-folder-add-btn {
  flex-shrink: 0;
  min-width: 70px;
  padding: 0 10px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--app-border) 88%, transparent);
  background: color-mix(in srgb, var(--app-panel-muted) 54%, transparent);
  color: var(--app-text-soft);
  font-size: 0.72rem;
  font-weight: 700;
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease, color 0.18s ease;
}

.conv-folder-add-btn:hover {
  border-color: color-mix(in srgb, var(--app-accent) 30%, var(--app-border));
  background: color-mix(in srgb, var(--app-panel-muted) 76%, transparent);
  color: var(--app-text);
}

.conv-section-toggle-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
}

.conv-section-title {
  color: var(--app-text-soft);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.conv-section-hint {
  color: var(--app-text-faint);
  font-size: 0.64rem;
  line-height: 1.2;
}

.conv-section-meta {
  margin-left: auto;
  color: var(--app-text-faint);
  font-size: 0.66rem;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-panel-muted) 62%, transparent);
}

.conv-section-caret-shell,
.conv-folder-caret-shell {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
  background: transparent;
  color: var(--app-text-muted);
  flex-shrink: 0;
}

.conv-section-caret,
.conv-folder-caret {
  width: 14px;
  height: 14px;
  transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}

.conv-section-toggle.collapsed .conv-section-caret {
  transform: rotate(-90deg);
}

.conv-folder.expanded .conv-folder-caret {
  transform: rotate(180deg);
}

.conv-section-body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.28s cubic-bezier(0.22, 1, 0.36, 1);
  overflow: hidden;
}

.conv-section-body.collapsed {
  grid-template-rows: 0fr;
}

.conv-section-body-inner {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: opacity 0.2s ease;
  width: 229px;
}

.conv-section-body-conversations.drop-append {
  border: 1px dashed color-mix(in srgb, var(--app-accent) 44%, var(--app-border));
  border-radius: 12px;
  padding: 6px;
  background: color-mix(in srgb, var(--app-accent-soft) 24%, transparent);
}

.conv-section-body.collapsed .conv-section-body-inner {
  opacity: 0;
}

.conv-item,
.conv-folder {
  position: relative;
}

.conv-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
  padding: 8px 9px;
  border-radius: 10px;
  cursor: pointer;
  color: var(--app-text-soft);
  font-size: 0.8em;
  border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease, transform 0.16s ease;
  overflow: hidden;
}

.conv-item::before,
.conv-folder::before,
.conv-folder::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  pointer-events: none;
}

.conv-item::before {
  inset: 0 auto 0 0;
  width: 2px;
  border-radius: 999px;
  background: transparent;
  transition: background 0.18s ease;
}

.conv-item:hover,
.conv-folder-shell:hover {
  background: color-mix(in srgb, var(--app-panel-muted) 72%, transparent);
  border-color: color-mix(in srgb, var(--app-accent) 12%, var(--app-border));
  color: var(--app-text);
}

.conv-item.active {
  background: color-mix(in srgb, var(--app-accent-soft) 42%, transparent);
  border-color: color-mix(in srgb, var(--app-accent-glow) 60%, transparent);
  color: var(--app-text-strong);
}

.conv-item.active::before {
  background: var(--app-accent-strong);
}

.conv-item.streaming {
  border-color: color-mix(in srgb, var(--app-accent-glow) 60%, transparent);
}

.conv-item.waitingAuth {
  border-color: rgba(245, 158, 11, 0.38);
}

.conv-item.dragging,
.conv-folder.dragging .conv-folder-shell {
  opacity: 0.62;
}

.conv-item.drop-before::after,
.conv-item.drop-after::after,
.conv-folder.drop-before::before,
.conv-folder.drop-after::after {
  height: 2px;
  border-radius: 999px;
  background: var(--app-accent-strong);
}

.conv-item.drop-before::after,
.conv-folder.drop-before::before {
  top: -3px;
}

.conv-item.drop-after::after,
.conv-folder.drop-after::after {
  bottom: -3px;
}

.conv-item.drop-merge,
.conv-folder.drop-into-folder .conv-folder-shell,
.conv-folder-children.drop-append,
.conv-folder.drop-append .conv-folder-shell {
  border-color: color-mix(in srgb, var(--app-accent-glow) 66%, transparent);
  background: color-mix(in srgb, var(--app-accent-soft) 30%, transparent);
}

.agent-item {
  background: color-mix(in srgb, var(--app-panel) 94%, var(--app-accent-soft) 6%);
}

.group-item {
  background: color-mix(in srgb, var(--app-panel) 94%, #14b8a6 5%);
}

.conversation-item,
.conv-folder-shell {
  background: var(--app-panel);
}

.conversation-item-nested {
  margin-left: 14px;
}

.conv-main {
  display: flex;
  gap: 9px;
  min-width: 0;
  flex: 1;
}

.conv-avatar-shell {
  position: relative;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: inline-flex;
  flex-shrink: 0;
  border: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
  background: color-mix(in srgb, var(--app-panel-muted) 70%, transparent);
}

.conv-avatar-shell.agent {
  background: color-mix(in srgb, var(--app-accent-soft) 32%, var(--app-panel));
}

.conv-avatar-shell.group {
  background: rgba(20, 184, 166, 0.12);
}

.conv-avatar-shell.conversation {
  background: color-mix(in srgb, var(--app-panel-muted) 78%, var(--app-panel));
}

.conv-folder-avatar-shell {
  align-items: center;
  justify-content: center;
}

.conv-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.conv-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.conv-title-stack {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.conv-icon {
  width: 100%;
  height: 100%;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  flex-shrink: 0;
  font-size: 0.92rem;
}

.conv-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--app-text-strong);
}

.conv-subtitle {
  color: var(--app-text-muted);
  font-size: 0.7rem;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  line-clamp: 2;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.3;
}

.conv-delete {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: none;
  background: transparent;
  color: var(--app-text-faint);
  font-size: 0.92rem;
  cursor: pointer;
  padding: 0;
  line-height: 1;
  flex-shrink: 0;
  opacity: 0;
  transform: translateY(2px) scale(0.94);
  transition: opacity 0.18s ease, transform 0.18s ease, color 0.18s ease, border-color 0.18s ease, background 0.18s ease;
}

.conv-item:hover .conv-delete,
.conv-item.active .conv-delete {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.conv-delete:hover {
  background: rgba(239, 68, 68, 0.08);
  color: var(--app-danger);
}

.conv-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.01em;
  flex-shrink: 0;
}

.conv-status.streaming {
  color: var(--app-accent-strong);
  background: color-mix(in srgb, var(--app-accent-soft) 82%, transparent);
}

.conv-status.auth {
  color: #b45309;
  background: rgba(245, 158, 11, 0.16);
}

.conv-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: currentColor;
}

.conv-status.streaming .conv-status-dot {
  animation: pulse-dot 1.15s ease-in-out infinite;
}

.conv-status.auth .conv-status-dot {
  animation: pulse-dot 1.45s ease-in-out infinite;
}

.conv-status-count {
  font-size: 0.64rem;
  opacity: 0.86;
}

.conv-folder-shell {
  display: flex;
  border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  border-radius: 12px;
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
}

.conv-folder-toggle {
  width: 100%;
  border: none;
  background: transparent;
  padding: 8px 9px;
  cursor: pointer;
  text-align: left;
}

.conv-folder-main {
  align-items: flex-start;
}

.conv-folder-copy {
  gap: 5px;
}

.conv-folder-title-row {
  justify-content: space-between;
}

.conv-folder-title-stack {
  gap: 1px;
}

.conv-folder-title {
  max-width: 132px;
}

.conv-folder-meta {
  color: var(--app-text-faint);
  font-size: 0.64rem;
}

.conv-folder-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.conv-folder-pill {
  max-width: 100%;
  padding: 2px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-panel-muted) 82%, transparent);
  color: var(--app-text-muted);
  font-size: 0.64rem;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-folder-pill.empty {
  border: 1px dashed color-mix(in srgb, var(--app-border) 76%, transparent);
  background: transparent;
}

.conv-folder-rename-input {
  width: 100%;
  min-width: 0;
  padding: 3px 7px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 28%, var(--app-border));
  border-radius: 8px;
  background: var(--app-input-bg);
  color: var(--app-text);
  font-size: 0.74rem;
  outline: none;
}

.conv-folder-children {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
  padding: 6px 6px 6px 0;
  border-radius: 12px;
}

.conv-folder-empty {
  margin-left: 14px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px dashed color-mix(in srgb, var(--app-border) 74%, transparent);
  background: color-mix(in srgb, var(--app-panel-muted) 48%, transparent);
  color: var(--app-text-faint);
  font-size: 0.7rem;
}

@keyframes pulse-dot {
  0%, 100% { transform: scale(0.85); opacity: 0.72; }
  50% { transform: scale(1.15); opacity: 1; }
}

.conv-empty {
  text-align: center;
  color: var(--app-text-faint);
  font-size: 0.8em;
  padding: 20px 12px;
  border: 1px dashed color-mix(in srgb, var(--app-border) 68%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-panel-muted) 42%, transparent);
}

@media (max-width: 880px) {
  .conv-sidebar {
    width: 100%;
  }

  .conv-item,
  .conv-folder-shell {
    flex-direction: column;
  }

  .conv-delete {
    opacity: 1;
    transform: none;
  }

  .conv-section-header-row {
    flex-direction: column;
  }

  .conv-folder-add-btn {
    min-height: 38px;
  }
}
</style>
