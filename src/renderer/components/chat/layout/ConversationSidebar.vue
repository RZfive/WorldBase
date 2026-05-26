<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
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
}>()

const emit = defineEmits<{
  (e: 'newConversation'): void
  (e: 'selectConversation', id: string): void
  (e: 'openAgent', agentId: string): void
  (e: 'openGroup', groupId: string): void
  (e: 'deleteConversation', id: string): void
}>()

const searchQuery = ref('')
const collapsedSections = reactive<Record<ConversationSidebarSectionKey, boolean>>({
  agents: false,
  groups: false,
  conversations: false
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
} = useConversationSidebarFolders(computed(() => props.conversationItems), searchQuery, normalizeSearchValue)

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
            <ConversationSidebarItemCard
              v-for="item in filteredAgentItems"
              :key="`agent-${item.id}`"
              :item="item"
              variant="agent"
              :show-delete="Boolean(item.conversationId)"
              delete-title="删除该 Agent 会话"
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
            <ConversationSidebarItemCard
              v-for="item in filteredGroupItems"
              :key="`group-${item.id}`"
              :item="item"
              variant="group"
              :show-delete="Boolean(item.conversationId)"
              delete-title="删除该群组会话"
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
              <span class="conv-section-title">对话</span>
              <span class="conv-section-hint">自由聊天记录</span>
            </span>
            <span class="conv-section-meta">{{ filteredConversationCount }}/{{ props.conversationItems.length }}</span>
          </button>
          <button class="conv-folder-add-btn" type="button" title="新建空文件夹" @click.stop="createEmptyFolder">
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
                :draggable="!isSearching"
                :is-dragging="dragItem?.type === 'conversation' && dragItem.id === entry.item.id"
                :drop-class="topLevelDropClass(entry.item.id, 'conversation')"
                show-delete
                delete-title="删除"
                @click="emit('selectConversation', entry.item.id)"
                @delete="emit('deleteConversation', entry.item.id)"
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
                @update:rename-input="renameInput = $event"
                @toggle="toggleFolderCollapsed(entry.folder.id)"
                @start-rename="startRenameFolder(entry.folder)"
                @commit-rename="commitRenameFolder(entry.folder.id)"
                @cancel-rename="cancelRenameFolder"
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

.conv-section-toggle-shell {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--app-border) 88%, transparent);
  background: color-mix(in srgb, var(--app-panel-muted) 54%, transparent);
  transition: border-color 0.18s ease, background 0.18s ease;
}

.conv-section-toggle-shell:hover {
  border-color: color-mix(in srgb, var(--app-accent) 22%, var(--app-border));
  background: color-mix(in srgb, var(--app-panel-muted) 72%, transparent);
}

.conv-section-toggle-embedded {
  padding-right: 4px;
  border: none;
  background: transparent;
}

.conv-section-toggle:hover {
  border-color: color-mix(in srgb, var(--app-accent) 22%, var(--app-border));
  background: color-mix(in srgb, var(--app-panel-muted) 72%, transparent);
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
  width: 28px;
  height: 28px;
  margin-right: 0;
  padding: 0;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--app-text-soft);
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease, color 0.18s ease;
}

.conv-folder-add-btn svg {
  width: 15px;
  height: 15px;
}

.conv-folder-add-btn:hover {
  border-color: color-mix(in srgb, var(--app-accent) 30%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 36%, transparent);
  color: var(--app-text);
}

.conv-section-caret-btn {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  margin-right: 4px;
  padding: 0;
  border-radius: 8px;
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

.conv-section-caret-shell {
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

.conv-section-body-conversations {
  position: relative;
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
