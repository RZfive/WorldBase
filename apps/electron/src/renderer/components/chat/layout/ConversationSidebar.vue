<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ConversationSidebarFolder from './ConversationSidebarFolder.vue'
import ConversationSidebarItemCard from './ConversationSidebarItemCard.vue'
import SidebarIcon from './SidebarIcon.vue'
import {
  type AgentSidebarItem,
  type ConversationGroupingMode,
  type ConversationSidebarSectionKey,
  type ConversationSidebarItem,
  type GroupSidebarItem,
  type LongTermGoalSidebarItem
} from './ConversationSidebar.types'
import { useConversationSidebarFolders } from './useConversationSidebarFolders'
import { useConversationSidebarGrouping, type SidebarProjectInfo } from './useConversationSidebarGrouping'

const props = defineProps<{
  agentItems: AgentSidebarItem[]
  groupItems: GroupSidebarItem[]
  longTermGoalItems: LongTermGoalSidebarItem[]
  conversationItems: ConversationSidebarItem[]
  conversationListLoaded: boolean
  projectItems?: SidebarProjectInfo[]
  groupingMode?: ConversationGroupingMode
}>()

const emit = defineEmits<{
  (e: 'newConversation'): void
  (e: 'toggleCollapse'): void
  (e: 'selectConversation', id: string): void
  (e: 'openAgent', agentId: string): void
  (e: 'openGroup', groupId: string): void
  (e: 'openLongTermGoal', goalId: string): void
  (e: 'newLongTermGoal'): void
  (e: 'deleteLongTermGoal', goalId: string): void
  (e: 'deleteConversation', id: string): void
  (e: 'renameConversation', id: string, title: string): void
  (e: 'pinConversation', id: string): void
  (e: 'update:groupingMode', mode: ConversationGroupingMode): void
  (e: 'assignConversationProject', conversationId: string, projectId: string | null): void
  (e: 'newConversationInProject', projectId: string, rootPath: string | null): void
  (e: 'newConversationInWorkspace', rootPath: string, name: string): void
  (e: 'addProjectFolder'): void
  (e: 'openProject', projectId: string): void
  (e: 'newConversationInFolder', folderId: string): void
  (e: 'organizeConversations'): void
}>()

const { t, locale } = useI18n()
const searchQuery = ref('')
const searchInputEl = ref<HTMLInputElement | null>(null)
const renamingConversationId = ref<string | null>(null)
const conversationRenameInput = ref('')
const defaultFolderName = computed(() => t('launchpad.newFolder'))

// ⌘K / Ctrl+K focuses the list search — the hint is rendered in the search
// shell, so the shortcut must exist wherever the hint shows.
function onSearchShortcut (event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K')) {
    event.preventDefault()
    void nextTick(() => searchInputEl.value?.focus())
  }
}

onMounted(() => {
  window.addEventListener('keydown', onSearchShortcut)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onSearchShortcut)
})

function focusSearch (): void {
  searchInputEl.value?.focus()
}

const SECTION_COLLAPSE_STORAGE_KEY = 'conversation-sidebar-sections'

function loadCollapsedSections (): Record<ConversationSidebarSectionKey, boolean> {
  const fallback: Record<ConversationSidebarSectionKey, boolean> = {
    agents: false,
    groups: false,
    longTermGoals: false,
    conversations: false
  }
  if (typeof window === 'undefined') return fallback

  try {
    const raw = window.localStorage.getItem(SECTION_COLLAPSE_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<Record<ConversationSidebarSectionKey, unknown>>
    return {
      agents: parsed.agents === true,
      groups: parsed.groups === true,
      longTermGoals: parsed.longTermGoals === true,
      conversations: parsed.conversations === true
    }
  } catch {
    return fallback
  }
}

// Restore the last expand/collapse state so the list opens as the user left it.
const collapsedSections = reactive<Record<ConversationSidebarSectionKey, boolean>>(loadCollapsedSections())

watch(collapsedSections, () => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SECTION_COLLAPSE_STORAGE_KEY, JSON.stringify({
      agents: collapsedSections.agents,
      groups: collapsedSections.groups,
      longTermGoals: collapsedSections.longTermGoals,
      conversations: collapsedSections.conversations
    }))
  } catch {
    // Ignore local persistence failures.
  }
})

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

const filteredAgentItems = computed(() => filterItems(props.agentItems))
const filteredGroupItems = computed(() => filterItems(props.groupItems))
const filteredLongTermGoalItems = computed(() => filterItems(props.longTermGoalItems))

const {
  conversationEntries,
  conversationFolders,
  isSearching,
  renamingFolderId,
  renameInput,
  dragItem,
  pinnedIds: pinnedIdsRef,
  createEmptyFolder,
  ensureFolder,
  appendConversationToFolderEnd,
  startRenameFolder,
  commitRenameFolder,
  cancelRenameFolder,
  toggleFolderCollapsed,
  ungroupFolder,
  deleteFolder,
  isFolderExpanded,
  togglePinConversation,
  togglePinFolder,
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
} = useConversationSidebarFolders(
  computed(() => props.conversationItems),
  searchQuery,
  normalizeSearchValue,
  toRef(props, 'conversationListLoaded'),
  defaultFolderName
)

// ── Grouping modes (time / project / folders) ──────────────────────────────
// The mode lives here but is mirrored to the parent (collapsed-capsule flyout
// needs it too); the parent may also set it (Launchpad "view conversations").
const groupingLabels = reactive({
  today: t('chatUi.groupToday'),
  yesterday: t('chatUi.groupYesterday'),
  last7Days: t('chatUi.groupLast7Days'),
  last30Days: t('chatUi.groupLast30Days'),
  older: t('chatUi.groupOlder'),
  ungrouped: t('chatUi.groupUngrouped'),
  deletedProjects: t('chatUi.groupDeletedProjects')
})
watch(() => locale.value, () => {
  Object.assign(groupingLabels, {
    today: t('chatUi.groupToday'),
    yesterday: t('chatUi.groupYesterday'),
    last7Days: t('chatUi.groupLast7Days'),
    last30Days: t('chatUi.groupLast30Days'),
    older: t('chatUi.groupOlder'),
    ungrouped: t('chatUi.groupUngrouped'),
    deletedProjects: t('chatUi.groupDeletedProjects')
  })
})

const {
  groupingMode,
  setGroupingMode: applyGroupingMode,
  groupedEntries,
  toggleGroupCollapsed
} = useConversationSidebarGrouping({
  conversationItems: computed(() => props.conversationItems),
  searchQuery,
  normalizeSearchValue,
  conversationListLoaded: toRef(props, 'conversationListLoaded'),
  folderEntries: conversationEntries,
  pinnedIds: pinnedIdsRef,
  projects: computed(() => props.projectItems || []),
  labels: groupingLabels
})

watch(() => props.groupingMode, (mode) => {
  if (mode && mode !== groupingMode.value) applyGroupingMode(mode)
}, { immediate: true })

function requestGroupingMode (mode: ConversationGroupingMode): void {
  applyGroupingMode(mode)
  emit('update:groupingMode', mode)
}

const groupingModes = computed(() => [
  { key: 'time' as const, icon: 'clock', title: t('chatUi.groupingModeTime') },
  { key: 'project' as const, icon: 'cube', title: t('chatUi.groupingModeProject') },
  { key: 'folders' as const, icon: 'folder', title: t('chatUi.groupingModeFolders') }
])

function projectInitial (name: string): string {
  const trimmed = (name || '').trim()
  return trimmed ? Array.from(trimmed)[0].toUpperCase() : '?'
}

// ── Row context menu: pin / move-to-project / rename / delete ──────────────
interface ContextMenuState {
  conversationId: string | null
  view: 'main' | 'projects'
  x: number
  y: number
}
const contextMenuState = ref<ContextMenuState | null>(null)

function contextMenuItem (): ConversationSidebarItem | null {
  const id = contextMenuState.value?.conversationId
  if (!id) return null
  return props.conversationItems.find(item => item.id === id) || null
}

function openConversationMenu (event: MouseEvent, item: ConversationSidebarItem): void {
  contextMenuState.value = {
    conversationId: item.id,
    view: 'main',
    x: event.clientX,
    y: event.clientY
  }
}

function closeConversationMenu (): void {
  contextMenuState.value = null
}

const contextMenuStyle = computed(() => {
  const state = contextMenuState.value
  if (!state) return {}
  const menuWidth = 176
  const menuHeight = state.view === 'projects' ? 220 : 172
  const x = Math.max(6, Math.min(state.x, window.innerWidth - menuWidth - 8))
  const y = Math.max(6, Math.min(state.y, window.innerHeight - menuHeight - 8))
  return { left: `${x}px`, top: `${y}px` }
})

function menuTogglePin (): void {
  const item = contextMenuItem()
  if (item) emit('pinConversation', item.id)
  closeConversationMenu()
}

function startMenuRename (): void {
  const item = contextMenuItem()
  if (item) startRenameConversation(item)
  closeConversationMenu()
}

function menuDelete (): void {
  const item = contextMenuItem()
  if (item) emit('deleteConversation', item.id)
  closeConversationMenu()
}

function menuAssignProject (projectId: string | null): void {
  const state = contextMenuState.value
  if (state?.conversationId) emit('assignConversationProject', state.conversationId, projectId)
  closeConversationMenu()
}

// ── Imperative helpers for the shell (folder-attached creation, AI organize) ──
function addConversationToFolder (conversationId: string, folderId: string): void {
  appendConversationToFolderEnd({ id: conversationId, type: 'conversation', source: 'top-level' }, folderId)
}

function getUnfiledConversations (): ConversationSidebarItem[] {
  const filed = new Set(conversationFolders.value.flatMap(folder => folder.conversationIds))
  return props.conversationItems.filter(item => !filed.has(item.id))
}

function getFolderNames (): Array<{ id: string; name: string }> {
  return conversationFolders.value.map(folder => ({ id: folder.id, name: folder.name }))
}

defineExpose({
  addConversationToFolder,
  ensureFolder: (name: string) => ensureFolder(name)?.id ?? null,
  getUnfiledConversations,
  getFolderNames
})

const hasVisibleItems = computed(() => {
  return filteredAgentItems.value.length > 0 || filteredGroupItems.value.length > 0 || filteredLongTermGoalItems.value.length > 0 || groupedEntries.value.length > 0
})

function toggleSection (key: ConversationSidebarSectionKey) {
  collapsedSections[key] = !collapsedSections[key]
}

function isSectionExpanded (key: ConversationSidebarSectionKey, itemsCount: number): boolean {
  if (isSearching.value) {
    return itemsCount > 0
  }
  return !collapsedSections[key]
}

function startRenameConversation (item: ConversationSidebarItem) {
  renamingConversationId.value = item.id
  conversationRenameInput.value = item.title
}

function commitRenameConversation (id: string) {
  if (renamingConversationId.value !== id) return

  const nextTitle = conversationRenameInput.value.trim()
  const currentTitle = props.conversationItems.find(item => item.id === id)?.title || ''

  renamingConversationId.value = null
  conversationRenameInput.value = ''

  if (!nextTitle || nextTitle === currentTitle) return
  emit('renameConversation', id, nextTitle)
}

function cancelRenameConversation () {
  renamingConversationId.value = null
  conversationRenameInput.value = ''
}
</script>

<template>
  <div class="conv-sidebar">
    <div class="conv-toolbar">
      <div class="conv-toolbar-row">
        <button
          class="conv-tool-btn"
          type="button"
          :title="$t('chatUi.collapseConversationList')"
          :aria-label="$t('chatUi.collapseConversationList')"
          @click="emit('toggleCollapse')"
        >
          <SidebarIcon name="panel" :size="15" />
        </button>
        <label class="conv-search-shell" @click="focusSearch">
          <SidebarIcon class="conv-search-icon" name="search" :size="12" />
          <input
            ref="searchInputEl"
            v-model="searchQuery"
            class="conv-search-input"
            type="search"
            :placeholder="$t('chatUi.searchConversationsPlaceholder')"
          >
          <button
            v-if="searchQuery"
            class="conv-search-clear"
            type="button"
            :title="$t('chatUi.clearSearch')"
            @click.prevent.stop="searchQuery = ''"
          >
            <SidebarIcon name="close" :size="10" />
          </button>
          <kbd v-else class="conv-search-kbd">⌘K</kbd>
        </label>
        <button
          class="conv-new-btn"
          type="button"
          :title="$t('chatUi.newConversation')"
          :aria-label="$t('chatUi.newConversation')"
          @click="emit('newConversation')"
        >
          <SidebarIcon name="plus" :size="14" />
        </button>
      </div>
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
            <ConversationSidebarItemCard
              v-for="item in filteredAgentItems"
              :key="`agent-${item.id}`"
              :item="item"
              variant="agent"
              :show-delete="Boolean(item.conversationId)"
              :delete-title="$t('chatUi.deleteAgentConversation')"
              @click="emit('openAgent', item.id)"
              @delete="item.conversationId && emit('deleteConversation', item.conversationId)"
            />
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
            <span class="conv-section-title">{{ $t('chatUi.groups') }}</span>
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
            <ConversationSidebarItemCard
              v-for="item in filteredGroupItems"
              :key="`group-${item.id}`"
              :item="item"
              variant="group"
              :show-delete="Boolean(item.conversationId)"
              :delete-title="$t('chatUi.deleteGroupConversation')"
              @click="emit('openGroup', item.id)"
              @delete="item.conversationId && emit('deleteConversation', item.conversationId)"
            />
          </div>
        </div>
      </section>

      <section class="conv-section">
        <div class="conv-section-toggle-shell">
          <button
            class="conv-section-toggle conv-section-toggle-embedded"
            :class="{ collapsed: !isSectionExpanded('longTermGoals', filteredLongTermGoalItems.length) }"
            type="button"
            @click="toggleSection('longTermGoals')"
          >
            <span class="conv-section-toggle-copy">
              <span class="conv-section-title">{{ $t('chatUi.longTermGoalsShort') }}</span>
            </span>
            <span class="conv-section-meta">{{ filteredLongTermGoalItems.length }}/{{ props.longTermGoalItems.length }}</span>
          </button>
          <button class="conv-folder-add-btn" type="button" :title="$t('chatUi.newLongTermGoal')" @click.stop="emit('newLongTermGoal')">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </button>
          <button
            class="conv-section-caret-btn"
            :class="{ collapsed: !isSectionExpanded('longTermGoals', filteredLongTermGoalItems.length) }"
            type="button"
            aria-hidden="true"
            @click="toggleSection('longTermGoals')"
          >
            <span class="conv-section-caret-shell">
              <svg class="conv-section-caret" viewBox="0 0 16 16" fill="none">
                <path d="M4.5 6.25L8 9.75L11.5 6.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
          </button>
        </div>
        <div
          class="conv-section-body"
          :class="{ collapsed: !isSectionExpanded('longTermGoals', filteredLongTermGoalItems.length) }"
        >
          <div class="conv-section-body-inner">
            <ConversationSidebarItemCard
              v-for="item in filteredLongTermGoalItems"
              :key="`goal-${item.id}`"
              :item="item"
              variant="conversation"
              compact
              show-delete
              :delete-title="$t('chatUi.deleteLongTermGoal')"
              @click="emit('openLongTermGoal', item.id)"
              @delete="emit('deleteLongTermGoal', item.id)"
            />
            <button
              v-if="props.longTermGoalItems.length === 0"
              class="conv-empty-action"
              type="button"
              @click="emit('newLongTermGoal')"
            >
              {{ $t('chatUi.createFirstLongTermGoal') }}
            </button>
          </div>
        </div>
      </section>

      <section v-if="props.conversationItems.length > 0 || groupedEntries.length > 0" class="conv-section">
        <div class="conv-section-toggle-shell">
          <button
            class="conv-section-toggle conv-section-toggle-embedded"
            :class="{ collapsed: !isSectionExpanded('conversations', groupedEntries.length) }"
            type="button"
            @click="toggleSection('conversations')"
          >
            <span class="conv-section-toggle-copy">
              <span class="conv-section-title">{{ $t('appShell.chat') }}</span>
            </span>
          </button>
          <button
            v-if="groupingMode === 'folders'"
            class="conv-folder-add-btn"
            type="button"
            :data-tip="$t('chatUi.newEmptyFolder')"
            @click.stop="createEmptyFolder"
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2.25 4.75A1.5 1.5 0 0 1 3.75 3.25H6.2a1 1 0 0 1 .77.36l.57.7a1 1 0 0 0 .77.36h3.94a1.5 1.5 0 0 1 1.5 1.5v4.08a1.5 1.5 0 0 1-1.5 1.5H3.75a1.5 1.5 0 0 1-1.5-1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              <path d="M8 6.15v3.7M6.15 8h3.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <button
            v-if="groupingMode === 'folders'"
            class="conv-folder-add-btn"
            type="button"
            :data-tip="$t('chatUi.organizeConversations')"
            :aria-label="$t('chatUi.organizeConversations')"
            @click.stop="emit('organizeConversations')"
          >
            <SidebarIcon name="wand" :size="14" />
          </button>
          <button
            v-if="groupingMode === 'project'"
            class="conv-folder-add-btn"
            type="button"
            :data-tip="$t('chatUi.addProjectFolder')"
            :aria-label="$t('chatUi.addProjectFolder')"
            @click.stop="emit('addProjectFolder')"
          >
            <SidebarIcon name="folderPlus" :size="14" />
          </button>
          <div class="conv-mode-switch" role="group" :aria-label="$t('chatUi.groupingModeTime')">
            <button
              v-for="mode in groupingModes"
              :key="mode.key"
              class="conv-mode-btn"
              :class="{ active: groupingMode === mode.key }"
              type="button"
              :data-tip="mode.title"
              :aria-label="mode.title"
              :aria-pressed="groupingMode === mode.key"
              @click.stop="requestGroupingMode(mode.key)"
            >
              <SidebarIcon :name="mode.icon" :size="13" />
            </button>
          </div>
          <button
            class="conv-section-caret-btn"
            :class="{ collapsed: !isSectionExpanded('conversations', groupedEntries.length) }"
            type="button"
            aria-hidden="true"
            @click="toggleSection('conversations')"
          >
            <span class="conv-section-caret-shell">
              <svg class="conv-section-caret" viewBox="0 0 16 16" fill="none">
                <path d="M4.5 6.25L8 9.75L11.5 6.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
          </button>
        </div>
        <div
          class="conv-section-body"
          :class="{ collapsed: !isSectionExpanded('conversations', groupedEntries.length) }"
        >
          <div
            :class="['conv-section-body-inner', 'conv-section-body-conversations', conversationSectionDropClass()]"
            @dragover.self="onConversationSectionDragOver"
            @dragleave.self="onDragLeave"
            @drop.self="onConversationSectionDrop"
          >
            <template v-for="entry in groupedEntries" :key="entry.kind === 'group' ? `group-${entry.groupId}` : entry.kind === 'folder' ? `folder-${entry.folder.id}` : entry.item.id">
              <ConversationSidebarItemCard
                v-if="entry.kind === 'conversation'"
                :item="entry.item"
                variant="conversation"
                compact
                :draggable="!isSearching"
                :is-dragging="dragItem?.type === 'conversation' && dragItem.id === entry.item.id"
                :drop-class="topLevelDropClass(entry.item.id, 'conversation')"
                :renaming="renamingConversationId === entry.item.id"
                :rename-input="conversationRenameInput"
                show-delete
                show-pin
                :delete-title="$t('common.delete')"
                @click="emit('selectConversation', entry.item.id)"
                @contextmenu.prevent="openConversationMenu($event, entry.item)"
                @update:rename-input="conversationRenameInput = $event"
                @commit-rename="commitRenameConversation(entry.item.id)"
                @cancel-rename="cancelRenameConversation"
                @delete="emit('deleteConversation', entry.item.id)"
                @pin="togglePinConversation(entry.item.id)"
                @dragstart="onConversationDragStart($event, entry.item.id)"
                @dragover="onTopLevelDragOver($event, entry.item.id, 'conversation')"
                @dragleave="onDragLeave"
                @drop="onTopLevelDrop($event, entry.item.id, 'conversation')"
                @dragend="resetDragState"
              />

              <ConversationSidebarFolder
                v-else-if="entry.kind === 'folder'"
                :entry="entry"
                :is-expanded="isFolderExpanded(entry.folder, entry.visibleItems.length)"
                :is-searching="isSearching"
                :renaming-folder-id="renamingFolderId"
                :rename-input="renameInput"
                :folder-drop-class="topLevelDropClass(entry.folder.id, 'folder')"
                :folder-body-drop-class="folderBodyDropClass(entry.folder.id)"
                :drag-item="dragItem"
                :conversation-drop-class="(conversationId) => topLevelDropClass(conversationId, 'conversation')"
                :renaming-conversation-id="renamingConversationId"
                :conversation-rename-input="conversationRenameInput"
                @update:rename-input="renameInput = $event"
                @update:conversation-rename-input="conversationRenameInput = $event"
                @toggle="toggleFolderCollapsed(entry.folder.id)"
                @start-rename="startRenameFolder(entry.folder)"
                @toggle-pin="togglePinFolder(entry.folder.id)"
                @start-rename-conversation="startRenameConversation"
                @commit-rename="commitRenameFolder(entry.folder.id)"
                @commit-conversation-rename="commitRenameConversation"
                @cancel-rename="cancelRenameFolder"
                @cancel-conversation-rename="cancelRenameConversation"
                @dragstart-folder="onFolderDragStart($event, entry.folder.id)"
                @dragover-folder="onTopLevelDragOver($event, entry.folder.id, 'folder')"
                @dragleave="onDragLeave"
                @drop-folder="onTopLevelDrop($event, entry.folder.id, 'folder')"
                @dragend="resetDragState"
                @dragover-body="onFolderBodyDragOver($event, entry.folder.id)"
                @drop-body="onFolderBodyDrop(entry.folder.id)"
                @select-conversation="emit('selectConversation', $event)"
                @delete-conversation="emit('deleteConversation', $event)"
                @add-conversation="emit('newConversationInFolder', entry.folder.id)"
                @ungroup="ungroupFolder(entry.folder.id)"
                @delete-folder="deleteFolder(entry.folder.id)"
                @dragstart-conversation="onConversationDragStart($event.event, $event.conversationId, 'folder', entry.folder.id)"
                @dragover-conversation="onFolderConversationDragOver($event.event, $event.conversationId, entry.folder.id)"
                @drop-conversation="onFolderConversationDrop($event.event, $event.conversationId, entry.folder.id)"
              />

              <div v-else class="conv-group" :class="{ collapsed: entry.collapsed }">
                <div
                  class="conv-group-head"
                  :class="{ 'conv-group-head-project': entry.groupKind === 'project' }"
                  role="button"
                  tabindex="0"
                  :aria-expanded="!entry.collapsed"
                  @click="toggleGroupCollapsed(entry.groupId)"
                  @keydown.enter.prevent="toggleGroupCollapsed(entry.groupId)"
                  @keydown.space.prevent="toggleGroupCollapsed(entry.groupId)"
                >
                  <span class="conv-group-caret" aria-hidden="true"><SidebarIcon name="chevron" :size="12" /></span>
                  <span
                    v-if="entry.project || entry.groupKind === 'workspace'"
                    class="conv-group-avatar"
                    :class="{ 'conv-group-avatar-ws': !entry.project }"
                    aria-hidden="true"
                  >{{ projectInitial(entry.label) }}</span>
                  <span class="conv-group-name" :title="entry.label">{{ entry.label }}</span>
                  <span class="conv-group-count">{{ entry.items.length }}</span>
                  <template v-if="entry.groupKind === 'project' && entry.project">
                    <button
                      class="conv-group-btn"
                      type="button"
                      :data-tip="$t('chatUi.newConversationInProject')"
                      :aria-label="$t('chatUi.newConversationInProject')"
                      @click.stop="emit('newConversationInProject', entry.project.id, entry.project.rootPath || null)"
                    >
                      <SidebarIcon name="plus" :size="11" />
                    </button>
                    <button
                      v-if="!entry.project.rootPath"
                      class="conv-group-btn"
                      type="button"
                      :data-tip="$t('chatUi.openProject')"
                      :aria-label="$t('chatUi.openProject')"
                      @click.stop="emit('openProject', entry.project.id)"
                    >
                      <SidebarIcon name="arrowUpRight" :size="11" />
                    </button>
                  </template>
                  <button
                    v-else-if="entry.groupKind === 'workspace' && entry.workspaceRoot"
                    class="conv-group-btn"
                    type="button"
                    :data-tip="$t('chatUi.newConversationInWorkspace')"
                    :aria-label="$t('chatUi.newConversationInWorkspace')"
                    @click.stop="emit('newConversationInWorkspace', entry.workspaceRoot, entry.label)"
                  >
                    <SidebarIcon name="plus" :size="11" />
                  </button>
                </div>
                <div v-if="!entry.collapsed" class="conv-group-body">
                  <ConversationSidebarItemCard
                    v-for="groupedItem in entry.items"
                    :key="groupedItem.id"
                    :item="groupedItem"
                    variant="conversation"
                    compact
                    show-delete
                    show-pin
                    :delete-title="$t('common.delete')"
                    @click="emit('selectConversation', groupedItem.id)"
                    @contextmenu.prevent="openConversationMenu($event, groupedItem)"
                    @delete="emit('deleteConversation', groupedItem.id)"
                    @pin="togglePinConversation(groupedItem.id)"
                  />
                  <div v-if="entry.items.length === 0" class="conv-group-empty">{{ $t('chatUi.groupEmpty') }}</div>
                </div>
              </div>
            </template>
          </div>
        </div>
      </section>

      <div v-if="!hasVisibleItems" class="conv-empty">{{ isSearching ? $t('chatUi.noMatchingConversations') : $t('chatUi.noConversationRecords') }}</div>
    </div>

    <teleport to="body">
      <div
        v-if="contextMenuState"
        class="conv-ctx-overlay"
        @click="closeConversationMenu"
        @contextmenu.prevent="closeConversationMenu"
      >
        <div class="conv-ctx-menu" :style="contextMenuStyle" role="menu" @click.stop>
          <template v-if="contextMenuState.view === 'main'">
            <button class="conv-ctx-item" type="button" role="menuitem" @click="menuTogglePin">
              <SidebarIcon name="pin" :size="12" />
              {{ contextMenuItem()?.isPinned ? $t('chatUi.unpin') : $t('chatUi.pin') }}
            </button>
            <button class="conv-ctx-item" type="button" role="menuitem" @click="contextMenuState.view = 'projects'">
              <SidebarIcon name="folder" :size="12" />
              {{ $t('chatUi.moveToProject') }}
            </button>
            <button class="conv-ctx-item" type="button" role="menuitem" @click="startMenuRename">
              <SidebarIcon name="pencil" :size="12" />
              {{ $t('common.rename') }}
            </button>
            <div class="conv-ctx-sep" />
            <button class="conv-ctx-item conv-ctx-danger" type="button" role="menuitem" @click="menuDelete">
              <SidebarIcon name="close" :size="12" />
              {{ $t('common.delete') }}
            </button>
          </template>
          <template v-else>
            <div class="conv-ctx-label">{{ $t('chatUi.moveToProject') }}</div>
            <button
              v-for="project in projectItems || []"
              :key="project.id"
              class="conv-ctx-item"
              type="button"
              role="menuitem"
              @click="menuAssignProject(project.id)"
            >
              <span class="conv-ctx-avatar" aria-hidden="true">{{ projectInitial(project.name) }}</span>
              <span class="conv-ctx-name">{{ project.name }}</span>
              <span v-if="contextMenuItem()?.projectId === project.id" class="conv-ctx-check" aria-hidden="true">✓</span>
            </button>
            <div class="conv-ctx-sep" />
            <button
              class="conv-ctx-item"
              type="button"
              role="menuitem"
              :disabled="!contextMenuItem()?.projectId"
              @click="menuAssignProject(null)"
            >
              {{ $t('chatUi.removeFromProject') }}
            </button>
          </template>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.conv-sidebar {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--app-chat-list-surface);
  border-right: 1px solid var(--app-border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.conv-toolbar {
  padding: 10px 8px 8px;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 84%, transparent);
}

/* Single-row toolbar (design v1.7): collapse / search ⌘K / new conversation. */
.conv-toolbar-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.conv-tool-btn {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: var(--app-chat-list-raised);
  color: var(--app-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.18s ease, border-color 0.18s ease, color 0.18s ease;
}

.conv-tool-btn:hover {
  border-color: color-mix(in srgb, var(--app-accent) 28%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 36%, var(--app-chat-list-raised));
  color: var(--app-text);
}

.conv-new-btn {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: none;
  background: var(--app-accent);
  color: var(--app-on-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.18s ease, transform 0.18s ease;
}

.conv-new-btn:hover {
  background: var(--app-accent-strong);
}

.conv-new-btn:active {
  transform: scale(0.96);
}

.conv-search-shell {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  min-height: 30px;
  min-width: 0;
  cursor: text;
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: var(--app-input-bg);
}

.conv-search-shell:focus-within {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
  box-shadow: 0 0 0 1px var(--app-accent-soft);
}

.conv-search-icon {
  color: var(--app-text-faint);
  flex-shrink: 0;
  display: inline-flex;
}

.conv-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--app-text);
  font-size: 0.76rem;
  outline: none;
}

.conv-search-input::placeholder {
  color: var(--app-text-faint);
}

.conv-search-input::-webkit-search-cancel-button {
  display: none;
}

.conv-search-kbd {
  flex-shrink: 0;
  font-family: inherit;
  font-size: 0.58rem;
  color: var(--app-text-faint);
  border: 1px solid var(--app-border);
  border-radius: 4px;
  padding: 1px 4px;
  line-height: 1.3;
}

.conv-search-clear {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--app-text-faint);
  cursor: pointer;
  padding: 0;
}

.conv-search-clear:hover {
  color: var(--app-danger);
  background: var(--app-danger-soft);
}

.conv-list {
  flex: 1 1 0;
  width: 100%;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px 0;
  scrollbar-gutter: stable;
  overflow-anchor: none;
}

/* Horizontal inset lives on the section (not the list) so the active row's
   signature-gradient indicator at -8px stays inside .conv-section-body's
   padding box and survives its overflow:hidden collapse clip. */
.conv-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
  min-width: 0;
  max-width: 100%;
  padding: 0 8px;
}

.conv-section-toggle {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 4px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  transition: background 0.18s ease, color 0.18s ease;
}

.conv-section-toggle-shell {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  transition: background 0.18s ease;
}

.conv-section-toggle-shell:hover {
  background: color-mix(in srgb, var(--app-panel-muted) 50%, transparent);
}

.conv-section-toggle-embedded {
  flex: 1;
  min-width: 0;
  padding-right: 0;
  border: none;
  background: transparent;
}

.conv-section-toggle:hover {
  background: color-mix(in srgb, var(--app-panel-muted) 50%, transparent);
}

.conv-section-toggle-embedded:hover {
  border-color: transparent;
  background: transparent;
}

.conv-section-toggle.collapsed {
  background: transparent;
}

.conv-folder-add-btn {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  margin-right: 0;
  padding: 0;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--app-text-soft);
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease, color 0.18s ease;
}

.conv-folder-add-btn svg {
  width: 14px;
  height: 14px;
}

.conv-folder-add-btn:hover {
  border-color: color-mix(in srgb, var(--app-accent) 30%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 36%, transparent);
  color: var(--app-text);
}

.conv-section-caret-btn {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  margin-right: 0;
  padding: 0;
  border-radius: 7px;
  border: none;
  background: transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.conv-section-caret-btn .conv-section-caret {
  transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}

.conv-section-caret-btn.collapsed .conv-section-caret {
  transform: rotate(-90deg);
}

.conv-section-toggle-copy {
  flex: 1;
  display: flex;
  align-items: center;
  min-width: 0;
}

.conv-section-title {
  color: var(--app-text-faint);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.conv-section-meta {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--app-text-faint);
  font-size: 0.66rem;
  font-weight: 600;
  padding: 0;
  border-radius: 0;
  background: transparent;
}

.conv-section-caret-shell {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--app-text-muted);
  flex-shrink: 0;
}

.conv-section-caret {
  width: 14px;
  height: 14px;
  transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}

.conv-section-toggle.collapsed .conv-section-caret {
  transform: rotate(-90deg);
}

.conv-section-body {
  display: block;
  min-width: 0;
  /* margin -8px re-extends the body over the section padding so rows line up
     with the toolbar; max-width must stay off or it cancels the margins. */
  margin: 0 -8px;
  padding: 0 8px;
}

.conv-section-body.collapsed {
  display: none;
}

.conv-section-body-inner {
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: opacity 0.2s ease;
  width: 100%;
}

.conv-section-body-conversations {
  position: relative;
  gap: 2px;
  padding-bottom: 6px;
}

.conv-section-body-conversations::after {
  content: '';
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 0;
  height: 2px;
  border-radius: 999px;
  background: transparent;
  pointer-events: none;
  transition: background 0.18s ease, opacity 0.18s ease;
  opacity: 0;
}

.conv-section-body-conversations.drop-append::after {
  opacity: 1;
  background: var(--app-accent-strong);
}

.conv-empty {
  text-align: center;
  color: var(--app-text-faint);
  font-size: 0.8em;
  padding: 20px 12px;
  margin: 0 8px;
  border: 1px dashed color-mix(in srgb, var(--app-border) 68%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-panel-muted) 42%, transparent);
}

/* ── Grouping-mode switcher (time / project / folders) ──
   Compact by design: the header row must keep the same height in every mode
   so switching modes never reflows the section header. */
.conv-mode-switch {
  flex-shrink: 0;
  display: inline-flex;
  gap: 1px;
  padding: 2px;
  border-radius: 7px;
  border: 1px solid var(--app-border);
  background: var(--app-input-bg);
}

.conv-mode-btn {
  width: 22px;
  height: 20px;
  border-radius: 5px;
  border: none;
  background: transparent;
  color: var(--app-text-faint);
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.16s ease, color 0.16s ease;
}

.conv-mode-btn:hover {
  background: var(--app-panel-muted);
  color: var(--app-text);
}

.conv-mode-btn.active {
  background: var(--app-accent-soft);
  color: var(--app-accent-strong);
}

/* ── Time / project groups ──
   Group heads sit on the section's 2px row rhythm (no extra padding) so a
   mode switch changes only which rows exist, not the spacing between them. */
.conv-group {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.conv-group-head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-height: 22px;
  padding: 1px 4px;
  border-radius: 7px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--app-text-faint);
  text-align: left;
  transition: background 0.16s ease;
}

.conv-group-head:hover {
  background: color-mix(in srgb, var(--app-panel-muted) 55%, transparent);
}

.conv-group-head:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--app-accent) 45%, transparent);
}

.conv-group-caret {
  display: inline-flex;
  flex-shrink: 0;
}

.conv-group-caret svg {
  transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}

.conv-group.collapsed .conv-group-caret svg {
  transform: rotate(-90deg);
}

.conv-group-avatar {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.55rem;
  font-weight: 700;
  background: color-mix(in srgb, var(--app-accent) 20%, transparent);
  color: var(--app-accent-strong);
}

.conv-group-avatar-ws {
  background: color-mix(in srgb, var(--app-accent) 10%, var(--app-panel-muted));
  color: var(--app-text-muted);
}

.conv-group-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.conv-group-head-project .conv-group-name {
  font-weight: 650;
  letter-spacing: 0.02em;
  text-transform: none;
  font-size: 0.72rem;
  color: var(--app-text-soft);
}

.conv-group-count {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 0.66rem;
  font-weight: 600;
  color: var(--app-text-faint);
}

.conv-group-btn {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  padding: 0;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--app-text-soft);
  cursor: pointer;
  display: none;
  align-items: center;
  justify-content: center;
}

.conv-group-head:hover .conv-group-btn {
  display: inline-flex;
}

.conv-group-btn:hover {
  background: color-mix(in srgb, var(--app-accent-soft) 36%, transparent);
  color: var(--app-accent);
}

.conv-group-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 0 2px 8px;
  /* Same indent rhythm as folder children so every grouping mode reads the
     same hierarchy: head, then rows tucked under a hairline guide. */
  margin-left: 13px;
  border-left: 1px solid color-mix(in srgb, var(--app-border) 78%, transparent);
}

.conv-group.collapsed .conv-group-body {
  display: none;
}

.conv-group-empty {
  color: var(--app-text-faint);
  font-size: 0.7rem;
  padding: 6px 10px;
}

/* ── Row context menu (pin / move-to-project / rename / delete) ── */
.conv-ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
}

.conv-ctx-menu {
  position: fixed;
  min-width: 168px;
  max-width: 220px;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  box-shadow: var(--shadow-2);
}

.conv-ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text-soft);
  font-size: 0.74rem;
  cursor: pointer;
  text-align: left;
}

.conv-ctx-item:hover:not(:disabled) {
  background: var(--app-panel-muted);
  color: var(--app-text);
}

.conv-ctx-item:disabled {
  opacity: 0.45;
  cursor: default;
}

.conv-ctx-item svg {
  flex-shrink: 0;
  color: var(--app-text-faint);
}

.conv-ctx-danger,
.conv-ctx-danger svg {
  color: var(--app-danger);
}

.conv-ctx-danger:hover {
  background: var(--app-danger-soft);
}

.conv-ctx-label {
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--app-text-faint);
  padding: 5px 8px 3px;
}

.conv-ctx-avatar {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.55rem;
  font-weight: 700;
  background: color-mix(in srgb, var(--app-accent) 20%, transparent);
  color: var(--app-accent-strong);
}

.conv-ctx-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-ctx-check {
  flex-shrink: 0;
  color: var(--app-accent-strong);
  font-size: 0.7rem;
}

.conv-ctx-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--app-border);
}

.conv-empty-action {
  width: 100%;
  min-height: 38px;
  border-radius: 8px;
  border: 1px dashed color-mix(in srgb, var(--app-accent) 36%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 24%, transparent);
  color: var(--app-text);
  cursor: pointer;
  font-size: 0.78rem;
}

.conv-empty-action:hover {
  border-style: solid;
  background: color-mix(in srgb, var(--app-accent-soft) 42%, transparent);
}

/* Instant hover tooltips for icon-only chrome (native title has a long
   delay; users can't tell what each switcher glyph does). */
[data-tip] {
  position: relative;
}

[data-tip]::after {
  content: attr(data-tip);
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 45;
  white-space: nowrap;
  padding: 4px 9px;
  border-radius: 7px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text);
  font-size: 0.68rem;
  font-weight: 400;
  letter-spacing: normal;
  text-transform: none;
  box-shadow: var(--shadow-1);
  opacity: 0;
  pointer-events: none;
  transform: translateY(-2px);
  transition: opacity 0.14s ease 0.18s, transform 0.14s ease 0.18s;
}

[data-tip]:hover::after,
[data-tip]:focus-visible::after {
  opacity: 1;
  transform: translateY(0);
}

@media (max-width: 880px) {
  .conv-sidebar {
    width: 100%;
  }

  .conv-section-toggle-shell {
    width: 100%;
  }

  .conv-folder-add-btn {
    width: 30px;
    height: 30px;
  }
}
</style>
