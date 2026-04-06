<script setup lang="ts">
interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  providerId?: string
}

const props = defineProps<{
  conversations: ConversationSummary[]
  currentConversationId: string | null
  streamingConvIds: Set<string>
}>()

const emit = defineEmits<{
  (e: 'newConversation'): void
  (e: 'selectConversation', id: string): void
  (e: 'deleteConversation', id: string): void
}>()
</script>

<template>
  <div class="conv-sidebar">
    <button class="new-conv-btn" @click="emit('newConversation')">+ 新对话</button>
    <div class="conv-list">
      <div
        v-for="conv in props.conversations"
        :key="conv.id"
        :class="['conv-item', { active: conv.id === props.currentConversationId }]"
        @click="emit('selectConversation', conv.id)"
      >
        <span class="conv-title">{{ conv.title }}</span>
        <span v-if="props.streamingConvIds.has(conv.id)" class="conv-streaming" title="生成中">⟳</span>
        <button class="conv-delete" @click.stop="emit('deleteConversation', conv.id)" title="删除">×</button>
      </div>
      <div v-if="props.conversations.length === 0" class="conv-empty">暂无对话记录</div>
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
  padding: 0 8px;
}

.conv-item {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--app-text-muted);
  font-size: 0.82em;
  margin-bottom: 2px;
  border: 1px solid transparent;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.conv-item:hover {
  background: var(--app-panel-muted);
  border-color: var(--app-border);
  color: var(--app-text);
}

.conv-item.active {
  background: var(--app-accent-soft);
  border-color: var(--app-accent-glow);
  color: var(--app-text-strong);
}

.conv-title {
  flex: 1;
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
</style>
