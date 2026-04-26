<script setup lang="ts">
interface AgentSidebarItem {
  id: string
  conversationId: string | null
  title: string
  subtitle: string
  icon: string
  modelId: string
  providerName: string
  modelOptions: string[]
  isStreaming: boolean
  isActive: boolean
}

interface GroupSidebarItem {
  id: string
  conversationId: string | null
  title: string
  subtitle: string
  icon: string
  isStreaming: boolean
  isActive: boolean
}

interface ConversationSidebarItem {
  id: string
  title: string
  subtitle: string
  icon: string
  isStreaming: boolean
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
</script>

<template>
  <div class="conv-sidebar">
    <button class="new-conv-btn" @click="emit('newConversation')">+ 新对话</button>
    <div class="conv-list">
      <section v-if="props.agentItems.length > 0" class="conv-section">
        <div class="conv-section-title">Agent</div>
        <div
          v-for="item in props.agentItems"
          :key="`agent-${item.id}`"
          :class="['conv-item', 'agent-item', { active: item.isActive }]"
          @click="emit('openAgent', item.id)"
        >
          <div class="conv-main">
            <span class="conv-icon">{{ item.icon }}</span>
            <div class="conv-copy">
              <div class="conv-title-row">
                <span class="conv-title">{{ item.title }}</span>
                <span v-if="item.isStreaming" class="conv-streaming" title="生成中">⟳</span>
              </div>
              <span class="conv-subtitle">{{ item.subtitle }}</span>
            </div>
          </div>

          <button
            v-if="item.conversationId"
            class="conv-delete"
            title="删除该 Agent 会话"
            @click.stop="emit('deleteConversation', item.conversationId)"
          >×</button>
        </div>
      </section>

      <section v-if="props.groupItems.length > 0" class="conv-section">
        <div class="conv-section-title">群组</div>
        <div
          v-for="item in props.groupItems"
          :key="`group-${item.id}`"
          :class="['conv-item', 'group-item', { active: item.isActive }]"
          @click="emit('openGroup', item.id)"
        >
          <div class="conv-main">
            <span class="conv-icon group">{{ item.icon }}</span>
            <div class="conv-copy">
              <div class="conv-title-row">
                <span class="conv-title">{{ item.title }}</span>
                <span v-if="item.isStreaming" class="conv-streaming" title="生成中">⟳</span>
              </div>
              <span class="conv-subtitle">{{ item.subtitle }}</span>
            </div>
          </div>
          <button
            v-if="item.conversationId"
            class="conv-delete"
            title="删除该群组会话"
            @click.stop="emit('deleteConversation', item.conversationId)"
          >×</button>
        </div>
      </section>

      <section v-if="props.conversationItems.length > 0" class="conv-section">
        <div class="conv-section-title">对话</div>
        <div
          v-for="conv in props.conversationItems"
          :key="conv.id"
          :class="['conv-item', 'conversation-item', { active: conv.isActive }]"
          @click="emit('selectConversation', conv.id)"
        >
          <div class="conv-main">
            <span class="conv-icon conversation">{{ conv.icon }}</span>
            <div class="conv-copy">
              <div class="conv-title-row">
                <span class="conv-title">{{ conv.title }}</span>
                <span v-if="conv.isStreaming" class="conv-streaming" title="生成中">⟳</span>
              </div>
              <span class="conv-subtitle">{{ conv.subtitle }}</span>
            </div>
          </div>
          <button class="conv-delete" @click.stop="emit('deleteConversation', conv.id)" title="删除">×</button>
        </div>
      </section>

      <div v-if="props.agentItems.length === 0 && props.groupItems.length === 0 && props.conversationItems.length === 0" class="conv-empty">暂无对话记录</div>
    </div>
  </div>
</template>

<style scoped>
.conv-sidebar {
  width: 220px;
  background: var(--app-panel);
  border-right: 1px solid var(--app-border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.new-conv-btn {
  margin: 12px;
  padding: 8px 0;
  background: var(--app-accent);
  color: #ffffff;
  border: none;
  border-radius: 8px;
  font-size: 0.85em;
  cursor: pointer;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.12);
  transition: background 0.18s ease, transform 0.18s ease;
}

.new-conv-btn:hover {
  background: var(--app-accent-strong);
  transform: translateY(-1px);
}

.conv-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 12px;
}

.conv-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}

.conv-section-title {
  padding: 0 6px;
  color: var(--app-text-faint);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.conv-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 10px;
  border-radius: 12px;
  cursor: pointer;
  color: var(--app-text-muted);
  font-size: 0.82em;
  border: 1px solid transparent;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, transform 0.15s ease;
}

.conv-item:hover {
  background: var(--app-panel-muted);
  border-color: var(--app-border);
  color: var(--app-text);
  transform: translateY(-1px);
}

.conv-item.active {
  background: var(--app-accent-soft);
  border-color: var(--app-accent-glow);
  color: var(--app-text-strong);
}

.agent-item {
  background: color-mix(in srgb, var(--app-panel) 86%, var(--app-accent-soft) 14%);
}

.group-item {
  background: color-mix(in srgb, var(--app-panel) 84%, #14b8a6 10%);
}

.conversation-item {
  background: var(--app-panel);
}

.conv-main {
  display: flex;
  gap: 10px;
  min-width: 0;
  flex: 1;
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

.conv-icon {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--app-accent) 12%, var(--app-panel));
  flex-shrink: 0;
  font-size: 1rem;
}

.conv-icon.group {
  background: color-mix(in srgb, #14b8a6 16%, var(--app-panel));
}

.conv-icon.conversation {
  background: color-mix(in srgb, var(--app-border) 48%, var(--app-panel));
}

.conv-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 700;
}

.conv-subtitle {
  color: var(--app-text-faint);
  font-size: 0.74rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-delete {
  background: none;
  border: none;
  color: var(--app-text-faint);
  font-size: 1.1em;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  flex-shrink: 0;
}

.conv-delete:hover {
  color: var(--app-danger);
}

.conv-streaming {
  flex-shrink: 0;
  font-size: 0.85em;
  color: var(--app-accent);
  animation: spin 1.2s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.conv-empty {
  text-align: center;
  color: var(--app-text-faint);
  font-size: 0.8em;
  padding: 20px 0;
}

@media (max-width: 880px) {
  .conv-item {
    flex-direction: column;
  }
}
</style>
