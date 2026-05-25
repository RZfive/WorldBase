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
      v-if="isExpanded"
      :class="['conv-folder-children', folderBodyDropClass]"
      @dragover="emit('dragoverBody', $event)"
      @dragleave="emit('dragleave', $event)"
      @drop="emit('dropBody')"
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
.conv-folder.drop-append .conv-folder-shell,
.conv-folder-children.drop-append {
  border-color: color-mix(in srgb, var(--app-accent-glow) 66%, transparent);
  background: color-mix(in srgb, var(--app-accent-soft) 30%, transparent);
}

.conv-folder.expanded .conv-folder-caret {
  transform: rotate(180deg);
}

.conv-folder-shell {
  display: flex;
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
  width: 100%;
  border: none;
  background: transparent;
  padding: 8px 9px;
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

@media (max-width: 880px) {
  .conv-folder-shell {
    flex-direction: column;
  }
}
</style>
