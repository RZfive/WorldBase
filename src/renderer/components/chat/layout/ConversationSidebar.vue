<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

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
const collapsedSections = reactive({
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

const isSearching = computed(() => normalizeSearchValue(searchQuery.value).length > 0)
const filteredAgentItems = computed(() => filterItems(props.agentItems))
const filteredGroupItems = computed(() => filterItems(props.groupItems))
const filteredConversationItems = computed(() => filterItems(props.conversationItems))
const hasVisibleItems = computed(() => {
  return filteredAgentItems.value.length > 0 || filteredGroupItems.value.length > 0 || filteredConversationItems.value.length > 0
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
          placeholder="搜索 Agent、群聊或对话内容"
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
        <Transition name="conv-collapse">
          <div v-if="isSectionExpanded('agents', filteredAgentItems.length)" class="conv-section-body">
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
        </Transition>
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
        <Transition name="conv-collapse">
          <div v-if="isSectionExpanded('groups', filteredGroupItems.length)" class="conv-section-body">
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
        </Transition>
      </section>

      <section v-if="props.conversationItems.length > 0" class="conv-section">
        <button
          class="conv-section-toggle"
          :class="{ collapsed: !isSectionExpanded('conversations', filteredConversationItems.length) }"
          type="button"
          @click="toggleSection('conversations')"
        >
          <span class="conv-section-toggle-copy">
            <span class="conv-section-title">对话</span>
            <span class="conv-section-hint">自由聊天记录</span>
          </span>
          <span class="conv-section-meta">{{ filteredConversationItems.length }}/{{ props.conversationItems.length }}</span>
          <span class="conv-section-caret-shell" aria-hidden="true">
            <svg class="conv-section-caret" viewBox="0 0 16 16" fill="none">
              <path d="M4.5 6.25L8 9.75L11.5 6.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
        </button>
        <Transition name="conv-collapse">
          <div v-if="isSectionExpanded('conversations', filteredConversationItems.length)" class="conv-section-body">
          <div
            v-for="conv in filteredConversationItems"
            :key="conv.id"
            :class="['conv-item', 'conversation-item', { active: conv.isActive, streaming: conv.isStreaming, waitingAuth: conv.pendingAuthCount > 0 }]"
            @click="emit('selectConversation', conv.id)"
          >
            <div class="conv-main">
              <span class="conv-avatar-shell conversation">
                <span class="conv-icon conversation">{{ conv.icon }}</span>
              </span>
              <div class="conv-copy">
                <div class="conv-title-row">
                  <div class="conv-title-stack">
                    <span class="conv-title">{{ conv.title }}</span>
                  </div>
                  <span v-if="conv.pendingAuthCount > 0" class="conv-status auth" :title="`等待授权${conv.pendingAuthCount > 1 ? ` ${conv.pendingAuthCount} 项` : ''}`">
                    <span class="conv-status-dot"></span>
                    待授权<span v-if="conv.pendingAuthCount > 1" class="conv-status-count">{{ conv.pendingAuthCount }}</span>
                  </span>
                  <span v-else-if="conv.isStreaming" class="conv-status streaming" title="生成中">
                    <span class="conv-status-dot"></span>
                    运行中
                  </span>
                </div>
                <span class="conv-subtitle">{{ conv.subtitle }}</span>
              </div>
            </div>
            <button class="conv-delete" type="button" @click.stop="emit('deleteConversation', conv.id)" title="删除">×</button>
          </div>
          </div>
        </Transition>
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

.conv-section-toggle:hover {
  border-color: color-mix(in srgb, var(--app-accent) 22%, var(--app-border));
  background: color-mix(in srgb, var(--app-panel-muted) 72%, transparent);
}

.conv-section-toggle.collapsed {
  background: transparent;
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
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.conv-collapse-enter-active,
.conv-collapse-leave-active {
  overflow: hidden;
  transition: max-height 0.28s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease, transform 0.22s ease;
}

.conv-collapse-enter-from,
.conv-collapse-leave-to {
  max-height: 0;
  opacity: 0;
  transform: translateY(-8px);
}

.conv-collapse-enter-to,
.conv-collapse-leave-from {
  max-height: 960px;
  opacity: 1;
  transform: translateY(0);
}

.conv-item {
  position: relative;
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
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
  overflow: hidden;
}

.conv-item::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 2px;
  border-radius: 999px;
  background: transparent;
  transition: background 0.18s ease;
}

.conv-item:hover {
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

.agent-item {
  background: color-mix(in srgb, var(--app-panel) 94%, var(--app-accent-soft) 6%);
}

.group-item {
  background: color-mix(in srgb, var(--app-panel) 94%, #14b8a6 5%);
}

.conversation-item {
  background: var(--app-panel);
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

.conv-type-chip {
  width: fit-content;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--app-text-faint);
  background: color-mix(in srgb, var(--app-panel-muted) 76%, transparent);
}

.conv-type-chip.agent {
  color: color-mix(in srgb, var(--app-accent-strong) 88%, black 12%);
  background: color-mix(in srgb, var(--app-accent-soft) 82%, white 18%);
}

.conv-type-chip.group {
  color: #0f766e;
  background: rgba(20, 184, 166, 0.18);
}

.conv-type-chip.conversation {
  color: var(--app-text-muted);
  background: color-mix(in srgb, var(--app-panel-muted) 80%, white 20%);
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

  .conv-item {
    flex-direction: column;
  }

  .conv-delete {
    opacity: 1;
    transform: none;
  }
}
</style>
