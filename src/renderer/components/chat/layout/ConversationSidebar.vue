<script setup lang="ts">
import { computed, reactive, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ConversationSidebarFolder from './ConversationSidebarFolder.vue'
import ConversationSidebarItemCard from './ConversationSidebarItemCard.vue'
import {
  type AgentSidebarItem,
  type ConversationSidebarSectionKey,
  type ConversationSidebarItem,
  type GroupSidebarItem
} from './ConversationSidebar.types'
import { useConversationSidebarFolders } from './useConversationSidebarFolders'

const props = defineProps<{
  agentItems: AgentSidebarItem[]
  groupItems: GroupSidebarItem[]
  conversationItems: ConversationSidebarItem[]
  conversationListLoaded: boolean
}>()

const emit = defineEmits<{
  (e: 'newConversation'): void
  (e: 'toggleCollapse'): void
  (e: 'selectConversation', id: string): void
  (e: 'openAgent', agentId: string): void
  (e: 'openGroup', groupId: string): void
  (e: 'deleteConversation', id: string): void
  (e: 'renameConversation', id: string, title: string): void
  (e: 'pinConversation', id: string): void
}>()

const { t } = useI18n()
const searchQuery = ref('')
const renamingConversationId = ref<string | null>(null)
const conversationRenameInput = ref('')
const defaultFolderName = computed(() => t('launchpad.newFolder'))

const SECTION_COLLAPSE_STORAGE_KEY = 'conversation-sidebar-sections'

function loadCollapsedSections (): Record<ConversationSidebarSectionKey, boolean> {
  const fallback: Record<ConversationSidebarSectionKey, boolean> = {
    agents: false,
    groups: false,
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

const {
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

const hasVisibleItems = computed(() => {
  return filteredAgentItems.value.length > 0 || filteredGroupItems.value.length > 0 || conversationEntries.value.length > 0
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
        <button class="new-conv-btn" type="button" @click="emit('newConversation')">+ {{ $t('chatUi.newConversation') }}</button>
        <button
          class="conv-collapse-btn"
          type="button"
          :title="$t('chatUi.collapseConversationList')"
          :aria-label="$t('chatUi.collapseConversationList')"
          @click="emit('toggleCollapse')"
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M12.5 5L7.5 10L12.5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
      <label class="conv-search-shell">
        <span class="conv-search-icon">⌕</span>
        <input
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
            <span class="conv-section-hint">{{ $t('chatUi.agentSectionHint') }}</span>
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
            <span class="conv-section-hint">{{ $t('chatUi.groupSectionHint') }}</span>
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

      <section v-if="props.conversationItems.length > 0 || conversationEntries.length > 0" class="conv-section">
        <div class="conv-section-toggle-shell">
          <button
            class="conv-section-toggle conv-section-toggle-embedded"
            :class="{ collapsed: !isSectionExpanded('conversations', conversationEntries.length) }"
            type="button"
            @click="toggleSection('conversations')"
          >
            <span class="conv-section-toggle-copy">
              <span class="conv-section-title">{{ $t('appShell.chat') }}</span>
              <span class="conv-section-hint">{{ $t('chatUi.conversationSectionHint') }}</span>
            </span>
            <span class="conv-section-meta">{{ filteredConversationCount }}/{{ props.conversationItems.length }}</span>
          </button>
          <button class="conv-folder-add-btn" type="button" :title="$t('chatUi.newEmptyFolder')" @click.stop="createEmptyFolder">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2.25 4.75A1.5 1.5 0 0 1 3.75 3.25H6.2a1 1 0 0 1 .77.36l.57.7a1 1 0 0 0 .77.36h3.94a1.5 1.5 0 0 1 1.5 1.5v4.08a1.5 1.5 0 0 1-1.5 1.5H3.75a1.5 1.5 0 0 1-1.5-1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              <path d="M8 6.15v3.7M6.15 8h3.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <button
            class="conv-section-caret-btn"
            :class="{ collapsed: !isSectionExpanded('conversations', conversationEntries.length) }"
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
          :class="{ collapsed: !isSectionExpanded('conversations', conversationEntries.length) }"
        >
          <div
            :class="['conv-section-body-inner', 'conv-section-body-conversations', conversationSectionDropClass()]"
            @dragover.self="onConversationSectionDragOver"
            @dragleave.self="onDragLeave"
            @drop.self="onConversationSectionDrop"
          >
            <template v-for="entry in conversationEntries" :key="entry.kind === 'folder' ? `folder-${entry.folder.id}` : entry.item.id">
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
                @contextmenu.prevent="startRenameConversation(entry.item)"
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
                v-else
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
                @ungroup="ungroupFolder(entry.folder.id)"
                @delete-folder="deleteFolder(entry.folder.id)"
                @dragstart-conversation="onConversationDragStart($event.event, $event.conversationId, 'folder', entry.folder.id)"
                @dragover-conversation="onFolderConversationDragOver($event.event, $event.conversationId, entry.folder.id)"
                @drop-conversation="onFolderConversationDrop($event.event, $event.conversationId, entry.folder.id)"
              />
            </template>
          </div>
        </div>
      </section>

      <div v-if="!hasVisibleItems" class="conv-empty">{{ isSearching ? $t('chatUi.noMatchingConversations') : $t('chatUi.noConversationRecords') }}</div>
    </div>
  </div>
</template>

<style scoped>
.conv-sidebar {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
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

.conv-toolbar-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.new-conv-btn {
  flex: 1;
  min-width: 0;
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

.conv-collapse-btn {
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--app-border) 84%, transparent);
  background: color-mix(in srgb, var(--app-panel-strong) 86%, transparent);
  color: var(--app-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.18s ease, border-color 0.18s ease, color 0.18s ease;
}

.conv-collapse-btn svg {
  width: 18px;
  height: 18px;
}

.conv-collapse-btn:hover {
  border-color: color-mix(in srgb, var(--app-accent) 28%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 36%, var(--app-panel));
  color: var(--app-text);
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
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px 14px 12px 12px;
  scrollbar-gutter: stable;
}

.conv-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
  min-width: 0;
  max-width: 100%;
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
  flex-direction: row;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.conv-section-title {
  color: var(--app-text-soft);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.conv-section-hint {
  color: var(--app-text-faint);
  font-size: 0.68rem;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.28s cubic-bezier(0.22, 1, 0.36, 1);
  overflow: hidden;
  min-width: 0;
  max-width: 100%;
}

.conv-section-body.collapsed {
  grid-template-rows: 0fr;
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

.conv-section-body.collapsed .conv-section-body-inner {
  opacity: 0;
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

  .conv-section-toggle-shell {
    width: 100%;
  }

  .conv-folder-add-btn {
    width: 30px;
    height: 30px;
  }
}
</style>
