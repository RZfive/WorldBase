<script setup lang="ts">
import type {
  AgentSidebarItem,
  ConversationSidebarItem,
  GroupSidebarItem
} from './ConversationSidebar.types'

type SidebarCardVariant = 'agent' | 'group' | 'conversation'

const props = withDefaults(defineProps<{
  item: AgentSidebarItem | GroupSidebarItem | ConversationSidebarItem
  variant: SidebarCardVariant
  draggable?: boolean
  isDragging?: boolean
  dropClass?: string | null
  nested?: boolean
  deleteTitle?: string
  showDelete?: boolean
}>(), {
  draggable: false,
  isDragging: false,
  dropClass: null,
  nested: false,
  deleteTitle: '删除',
  showDelete: false
})

const emit = defineEmits<{
  (e: 'click'): void
  (e: 'delete'): void
  (e: 'dragstart', event: DragEvent): void
  (e: 'dragover', event: DragEvent): void
  (e: 'dragleave', event: DragEvent): void
  (e: 'drop', event: DragEvent): void
  (e: 'dragend'): void
}>()
</script>

<template>
  <div
    :class="[
      'conv-item',
      `${variant}-item`,
      dropClass,
      {
        active: item.isActive,
        streaming: item.isStreaming,
        waitingAuth: item.pendingAuthCount > 0,
        dragging: isDragging,
        'conversation-item-nested': nested
      }
    ]"
    :draggable="draggable"
    @click="emit('click')"
    @dragstart="emit('dragstart', $event)"
    @dragover="emit('dragover', $event)"
    @dragleave="emit('dragleave', $event)"
    @drop="emit('drop', $event)"
    @dragend="emit('dragend')"
  >
    <div class="conv-main">
      <span :class="['conv-avatar-shell', variant]">
        <span :class="['conv-icon', variant]">{{ item.icon }}</span>
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
    <button v-if="showDelete" class="conv-delete" type="button" :title="deleteTitle" @click.stop="emit('delete')">×</button>
  </div>
</template>

<style scoped>
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
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease, transform 0.16s ease;
  overflow: hidden;
}

.conv-item::before,
.conv-item::after {
  content: '';
  position: absolute;
  pointer-events: none;
}

.conv-item::before {
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

.conv-item.dragging {
  opacity: 0.62;
}

.conv-item.drop-before::after,
.conv-item.drop-after::after {
  left: 0;
  right: 0;
  height: 2px;
  border-radius: 999px;
  background: var(--app-accent-strong);
}

.conv-item.drop-before::after {
  top: -3px;
}

.conv-item.drop-after::after {
  bottom: -3px;
}

.conv-item.drop-merge {
  border-color: color-mix(in srgb, var(--app-accent-glow) 66%, transparent);
  background: color-mix(in srgb, var(--app-accent-soft) 30%, transparent);
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

@keyframes pulse-dot {
  0%, 100% { transform: scale(0.85); opacity: 0.72; }
  50% { transform: scale(1.15); opacity: 1; }
}

@media (max-width: 880px) {
  .conv-item {
    flex-direction: column;
  }

  .conv-delete {
    opacity: 1;
    transform: none;
  }
}
</style>
