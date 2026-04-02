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
  background: #111113;
  border-right: 1px solid #27272a;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.new-conv-btn {
  margin: 12px;
  padding: 8px 0;
  background: #3b82f6;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 0.85em;
  cursor: pointer;
}

.new-conv-btn:hover {
  background: #2563eb;
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
  color: #a1a1aa;
  font-size: 0.82em;
  margin-bottom: 2px;
}

.conv-item:hover {
  background: #1e1e22;
  color: #e4e4e7;
}

.conv-item.active {
  background: #27272a;
  color: #ffffff;
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
  color: #52525b;
  font-size: 1.1em;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  flex-shrink: 0;
}

.conv-delete:hover {
  color: #ef4444;
}

.conv-streaming {
  flex-shrink: 0;
  font-size: 0.85em;
  color: #3b82f6;
  animation: spin 1.2s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.conv-empty {
  text-align: center;
  color: #52525b;
  font-size: 0.8em;
  padding: 20px 0;
}
</style>
