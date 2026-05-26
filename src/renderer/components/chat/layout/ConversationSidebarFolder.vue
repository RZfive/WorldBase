<script setup lang="ts">
import ConversationSidebarItemCard from './ConversationSidebarItemCard.vue'
import type {
  ConversationDragItem,
  ConversationSidebarEntry
} from './ConversationSidebar.types'

const props = defineProps<{
  entry: Extract<ConversationSidebarEntry, { kind: 'folder' }>
  isExpanded: boolean
  isSearching: boolean
  renamingFolderId: string | null
  renameInput: string
  folderDropClass: string | null
  folderBodyDropClass: string | null
  dragItem: ConversationDragItem | null
  conversationDropClass: (conversationId: string) => string | null
}>()

const emit = defineEmits<{
  (e: 'update:renameInput', value: string): void
  (e: 'toggle'): void
  (e: 'startRename'): void
  (e: 'commitRename'): void
  (e: 'cancelRename'): void
  (e: 'ungroup'): void
  (e: 'deleteFolder'): void
  (e: 'dragstartFolder', event: DragEvent): void
  (e: 'dragoverFolder', event: DragEvent): void
  (e: 'dragleave', event: DragEvent): void
  (e: 'dropFolder', event: DragEvent): void
  (e: 'dragend'): void
  (e: 'dragoverBody', event: DragEvent): void
  (e: 'dropBody'): void
  (e: 'selectConversation', id: string): void
  (e: 'deleteConversation', id: string): void
  (e: 'dragstartConversation', payload: { event: DragEvent; conversationId: string }): void
  (e: 'dragoverConversation', payload: { event: DragEvent; conversationId: string }): void
  (e: 'dropConversation', payload: { event: DragEvent; conversationId: string }): void
}>()
</script>

<template>
  <div
    :class="[
      'conv-folder',
      folderDropClass,
      folderBodyDropClass,
      { expanded: isExpanded, dragging: dragItem?.type === 'folder' && dragItem.id === entry.folder.id }
    ]"
  >
    <div
      class="conv-folder-shell"
      :draggable="!isSearching"
      @dragstart="emit('dragstartFolder', $event)"
      @dragover="emit('dragoverFolder', $event)"
      @dragleave="emit('dragleave', $event)"
      @drop="emit('dropFolder', $event)"
      @dragend="emit('dragend')"
    >
      <button class="conv-folder-toggle" type="button" @click="emit('toggle')">
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
                  @input="emit('update:renameInput', ($event.target as HTMLInputElement).value)"
                  @keydown.enter.prevent="emit('commitRename')"
                  @keydown.escape="emit('cancelRename')"
                  @blur="emit('commitRename')"
                  @click.stop
                >
                <span
                  v-else
                  class="conv-title conv-folder-title"
                  title="双击重命名文件夹"
                  @dblclick.stop="emit('startRename')"
                >{{ entry.folder.name }}</span>
                <span class="conv-folder-meta">{{ entry.items.length }} 个对话</span>
              </div>
              <span class="conv-folder-caret-shell" aria-hidden="true">
                <svg class="conv-folder-caret" viewBox="0 0 16 16" fill="none">
                  <path d="M4.5 6.25L8 9.75L11.5 6.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </span>
            </div>
          </div>
        </div>
      </button>
      <div class="conv-folder-actions">
        <button class="conv-folder-action-btn" type="button" title="解散文件夹（对话保留）" @click.stop="emit('ungroup')">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 4h10M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M6.5 7v4M9.5 7v4M4 4l.7 8.4a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </div>

    <div
      v-if="isExpanded"
      :class="['conv-folder-children', folderBodyDropClass]"
      @dragover.self="emit('dragoverBody', $event)"
      @dragleave.self="emit('dragleave', $event)"
      @drop.self="emit('dropBody')"
    >
      <div
        v-if="entry.visibleItems.length === 0"
        class="conv-folder-empty"
      >空文件夹，拖拽对话到这里</div>
      <ConversationSidebarItemCard
        v-for="item in entry.visibleItems"
        :key="`${entry.folder.id}-${item.id}`"
        :item="item"
        variant="conversation"
        :draggable="!isSearching"
        :is-dragging="dragItem?.type === 'conversation' && dragItem.id === item.id"
        :drop-class="conversationDropClass(item.id)"
        nested
        show-delete
        delete-title="删除"
        @click="emit('selectConversation', item.id)"
        @delete="emit('deleteConversation', item.id)"
        @dragstart="emit('dragstartConversation', { event: $event, conversationId: item.id })"
        @dragover="emit('dragoverConversation', { event: $event, conversationId: item.id })"
        @dragleave="emit('dragleave', $event)"
        @drop="emit('dropConversation', { event: $event, conversationId: item.id })"
        @dragend="emit('dragend')"
      />
    </div>
  </div>
</template>

<style scoped>
.conv-folder {
  position: relative;
}

.conv-folder::before,
.conv-folder::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  pointer-events: none;
}

.conv-folder.dragging .conv-folder-shell {
  opacity: 0.62;
}

.conv-folder.drop-before::before,
.conv-folder.drop-after::after {
  height: 2px;
  border-radius: 999px;
  background: var(--app-accent-strong);
}

.conv-folder.drop-before::before {
  top: -3px;
}

.conv-folder.drop-after::after {
  bottom: -3px;
}

.conv-folder.drop-into-folder .conv-folder-shell,
.conv-folder.drop-append .conv-folder-shell {
  border-color: color-mix(in srgb, var(--app-accent-glow) 66%, transparent);
  background: color-mix(in srgb, var(--app-accent-soft) 30%, transparent);
}

.conv-folder.expanded .conv-folder-caret {
  transform: rotate(180deg);
}

.conv-folder-shell {
  display: flex;
  align-items: center;
  background: var(--app-panel);
  border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  border-radius: 12px;
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
}

.conv-folder-shell:hover {
  background: color-mix(in srgb, var(--app-panel-muted) 72%, transparent);
  border-color: color-mix(in srgb, var(--app-accent) 12%, var(--app-border));
  color: var(--app-text);
}

.conv-folder-toggle {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  padding: 6px 9px;
  cursor: pointer;
  text-align: left;
}

.conv-main {
  display: flex;
  gap: 9px;
  min-width: 0;
  flex: 1;
}

.conv-folder-main {
  align-items: flex-start;
}

.conv-avatar-shell {
  position: relative;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: inline-flex;
  flex-shrink: 0;
  border: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
  background: color-mix(in srgb, var(--app-panel-muted) 78%, var(--app-panel));
}

.conv-folder-avatar-shell {
  align-items: center;
  justify-content: center;
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

.conv-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.conv-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.conv-folder-title-row {
  justify-content: space-between;
}

.conv-title-stack {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
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

.conv-folder-title {
  max-width: 132px;
}

.conv-folder-meta {
  color: var(--app-text-faint);
  font-size: 0.64rem;
}

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

.conv-folder-caret {
  width: 14px;
  height: 14px;
  transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}

.conv-folder-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-right: 6px;
  opacity: 0;
  transition: opacity 0.18s ease;
}

.conv-folder-shell:hover .conv-folder-actions {
  opacity: 1;
}

.conv-folder-action-btn {
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--app-text-faint);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.16s ease, color 0.16s ease;
}

.conv-folder-action-btn svg {
  width: 13px;
  height: 13px;
}

.conv-folder-action-btn:hover {
  background: rgba(239, 68, 68, 0.08);
  color: var(--app-danger);
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
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
  margin-left: 14px;
  padding: 8px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--app-border) 74%, transparent);
  background: color-mix(in srgb, var(--app-panel-muted) 50%, transparent);
}

.conv-folder-children::after {
  content: '';
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 6px;
  height: 2px;
  border-radius: 999px;
  background: transparent;
  pointer-events: none;
  transition: background 0.18s ease, opacity 0.18s ease;
  opacity: 0;
}

.conv-folder-children.drop-append::after {
  opacity: 1;
  background: var(--app-accent-strong);
}

.conv-folder-empty {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px dashed color-mix(in srgb, var(--app-border) 74%, transparent);
  background: color-mix(in srgb, var(--app-panel) 78%, transparent);
  color: var(--app-text-faint);
  font-size: 0.7rem;
}

@media (max-width: 880px) {
  .conv-folder-shell {
    flex-direction: column;
  }

  .conv-folder-actions {
    opacity: 1;
  }
}
</style>
