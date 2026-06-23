<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
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
  showPin?: boolean
  compact?: boolean
  renaming?: boolean
  renameInput?: string
}>(), {
  draggable: false,
  isDragging: false,
  dropClass: null,
  nested: false,
  deleteTitle: '',
  showDelete: false,
  showPin: false,
  compact: false,
  renaming: false,
  renameInput: ''
})

const emit = defineEmits<{
  (e: 'click'): void
  (e: 'contextmenu', event: MouseEvent): void
  (e: 'delete'): void
  (e: 'pin'): void
  (e: 'update:renameInput', value: string): void
  (e: 'commitRename'): void
  (e: 'cancelRename'): void
  (e: 'dragstart', event: DragEvent): void
  (e: 'dragover', event: DragEvent): void
  (e: 'dragleave', event: DragEvent): void
  (e: 'drop', event: DragEvent): void
  (e: 'dragend'): void
}>()

const itemIsPinned = computed(() => props.showPin && 'isPinned' in props.item && Boolean(props.item.isPinned))
const isCompactConversation = computed(() => props.compact && props.variant === 'conversation')
const renameInputEl = ref<HTMLInputElement | null>(null)

watch(
  () => props.renaming,
  async (renaming) => {
    if (!renaming) return
    await nextTick()
    renameInputEl.value?.focus()
    renameInputEl.value?.select()
  }
)
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
        pinned: itemIsPinned,
        'conversation-item-nested': nested,
        'conversation-item-compact': isCompactConversation,
        'has-actions': showPin || showDelete,
        'has-dual-actions': showPin && showDelete
      }
    ]"
    :draggable="draggable && !renaming"
    @click="emit('click')"
    @contextmenu="emit('contextmenu', $event)"
    @dragstart="emit('dragstart', $event)"
    @dragover="emit('dragover', $event)"
    @dragleave="emit('dragleave', $event)"
    @drop="emit('drop', $event)"
    @dragend="emit('dragend')"
  >
    <div class="conv-main">
      <span v-if="!isCompactConversation" :class="['conv-avatar-shell', variant]">
        <span :class="['conv-icon', variant]">{{ item.icon }}</span>
      </span>
      <div class="conv-copy">
        <div :class="['conv-title-row', { 'conv-title-row-compact': isCompactConversation }]">
          <div class="conv-title-stack">
            <input
              v-if="renaming && isCompactConversation"
              ref="renameInputEl"
              :value="renameInput"
              class="conv-title-rename-input"
              type="text"
              autofocus
              @input="emit('update:renameInput', ($event.target as HTMLInputElement).value)"
              @keydown.enter.prevent="emit('commitRename')"
              @keydown.escape.stop="emit('cancelRename')"
              @blur="emit('commitRename')"
              @click.stop
              @mousedown.stop
              @dragstart.stop.prevent
            >
            <span v-else class="conv-title">{{ item.title }}</span>
          </div>
          <span
            v-if="item.pendingAuthCount > 0"
            :class="['conv-status', 'auth', { compact: isCompactConversation }]"
            :title="item.pendingAuthCount > 1 ? $t('chatUi.waitingAuthCount', { count: item.pendingAuthCount }) : $t('chatUi.waitingAuth')"
          >
            <span class="conv-status-dot"></span>
            <template v-if="!isCompactConversation">
              {{ $t('chatUi.pendingAuthShort') }}<span v-if="item.pendingAuthCount > 1" class="conv-status-count">{{ item.pendingAuthCount }}</span>
            </template>
            <span v-else-if="item.pendingAuthCount > 1" class="conv-status-count">{{ item.pendingAuthCount }}</span>
          </span>
          <span
            v-else-if="item.isStreaming"
            :class="['conv-status', 'streaming', { compact: isCompactConversation }]"
            :title="$t('chatUi.generating')"
          >
            <span class="conv-status-dot"></span>
            <template v-if="!isCompactConversation">{{ $t('chatUi.runningShort') }}</template>
          </span>
          <span
            v-else-if="item.unreadCount > 0"
            :class="['conv-status', 'unread', { compact: isCompactConversation }]"
            :title="$t('chatUi.unreadReply')"
          >
            <span class="conv-status-dot"></span>
            <template v-if="!isCompactConversation">{{ $t('chatUi.unread') }}</template>
          </span>
        </div>
        <span v-if="!isCompactConversation" class="conv-subtitle">{{ item.subtitle }}</span>
      </div>
    </div>
    <div v-if="showPin || showDelete" class="conv-actions">
      <button
        v-if="showPin"
        class="conv-pin"
        :class="{ active: itemIsPinned }"
        type="button"
        :title="itemIsPinned ? $t('chatUi.unpin') : $t('chatUi.pin')"
        :aria-label="itemIsPinned ? $t('chatUi.unpin') : $t('chatUi.pin')"
        @click.stop="emit('pin')"
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M9.5 2.5L13.5 6.5L10.5 7.5L8.5 11.5L7 10L4.5 12.5L6 8.5L4.5 7L8.5 5L9.5 2.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
        </svg>
      </button>
      <button v-if="showDelete" class="conv-delete" type="button" :title="deleteTitle || $t('common.delete')" @click.stop="emit('delete')">×</button>
    </div>
  </div>
</template>

<style scoped>
.conv-item {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
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
  overflow: visible;
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
.conv-item.drop-after::after,
.conv-item.drop-merge::after {
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

.conv-item.drop-merge::after {
  left: 10px;
  right: 10px;
  bottom: -3px;
}

.conv-item.drop-merge {
  border-color: color-mix(in srgb, var(--app-accent-glow) 66%, transparent);
  background: color-mix(in srgb, var(--app-accent-soft) 30%, transparent);
}

.conversation-item-compact.drop-before::after {
  top: 0;
}

.conversation-item-compact.drop-after::after,
.conversation-item-compact.drop-merge::after {
  bottom: 0;
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

.conversation-item-compact {
  align-items: center;
  width: 100%;
  max-width: 100%;
  min-height: 30px;
  padding: 3px 5px 3px 10px;
  border-color: transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text-soft);
  overflow: hidden;
}

.conversation-item-compact:hover {
  background: color-mix(in srgb, var(--app-panel-muted) 72%, transparent);
  border-color: transparent;
}

.conversation-item-compact.active {
  background: color-mix(in srgb, var(--app-accent-soft) 34%, transparent);
  border-color: transparent;
}

.conversation-item-compact.waitingAuth {
  border-color: transparent;
  background: rgba(245, 158, 11, 0.08);
}

.conversation-item-compact.streaming {
  border-color: transparent;
}

.conversation-item-compact.drop-merge {
  background: color-mix(in srgb, var(--app-accent-soft) 34%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-accent-glow) 58%, transparent);
}

.conversation-item-nested {
  margin-left: 14px;
}

.conversation-item-compact.conversation-item-nested {
  margin-left: 0;
}

.conv-main {
  display: flex;
  gap: 9px;
  min-width: 0;
  flex: 1;
}

.conversation-item-compact .conv-main {
  align-items: center;
  gap: 0;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
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
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.conversation-item-compact .conv-copy {
  flex: 1;
  min-width: 0;
  max-width: 100%;
  gap: 0;
  overflow: hidden;
}

.conv-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.conv-title-row-compact {
  min-width: 0;
  max-width: 100%;
  width: 100%;
  overflow: hidden;
}

.conv-title-stack {
  min-width: 0;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow: hidden;
}

.conv-title-row-compact .conv-title-stack {
  flex: 1;
  min-width: 0;
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
  display: block;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--app-text-strong);
}

.conversation-item-compact .conv-title {
  font-size: 0.76rem;
  font-weight: 500;
  color: var(--app-text-soft);
}

.conversation-item-compact.active .conv-title {
  font-weight: 650;
  color: var(--app-text-strong);
}

.conv-title-rename-input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 24px;
  padding: 2px 7px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 36%, var(--app-border));
  border-radius: 6px;
  background: var(--app-input-bg);
  color: var(--app-text);
  font: inherit;
  font-size: 0.76rem;
  outline: none;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-accent-soft) 34%, transparent);
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

.conv-actions {
  /* Non-compact (agent/group) cards keep the buttons as inline flex children. */
  display: contents;
}

.conv-pin {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: none;
  background: transparent;
  color: var(--app-text-faint);
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  opacity: 0;
  transform: translateY(2px) scale(0.94);
  transition: opacity 0.18s ease, transform 0.18s ease, color 0.18s ease, background 0.18s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.conversation-item-compact .conv-pin {
  position: relative;
  z-index: 1;
  width: 20px;
  height: 20px;
  opacity: 0;
  pointer-events: none;
  transform: translateX(7px);
  transition: opacity 0.2s ease, transform 0.26s cubic-bezier(0.22, 1, 0.36, 1), color 0.16s ease, background 0.16s ease;
}

.conv-pin svg {
  width: 13px;
  height: 13px;
}

.conversation-item-compact .conv-pin svg {
  width: 12px;
  height: 12px;
}

.conv-pin.active {
  opacity: 1;
  transform: translateY(0) scale(1);
  color: var(--app-accent);
}

.conv-pin.active svg path {
  fill: var(--app-accent);
}

.conv-item:hover .conv-pin {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.conv-pin:hover {
  background: color-mix(in srgb, var(--app-accent-soft) 36%, transparent);
  color: var(--app-accent);
}

.conv-item.pinned {
  border-color: color-mix(in srgb, var(--app-accent) 18%, var(--app-border));
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

.conversation-item-compact .conv-delete {
  position: relative;
  z-index: 1;
  width: 20px;
  height: 20px;
  max-width: 0;
  padding: 0;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transform: translateX(7px);
  transition: max-width 0.24s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease, transform 0.26s cubic-bezier(0.22, 1, 0.36, 1), color 0.16s ease, background 0.16s ease;
}

.conv-item:hover .conv-delete,
.conv-item.active:not(.conversation-item-compact) .conv-delete {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.conv-delete:hover {
  background: rgba(239, 68, 68, 0.08);
  color: var(--app-danger);
}

.conversation-item-compact .conv-actions {
  position: relative;
  flex: 0 0 22px;
  width: 22px;
  min-width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  gap: 1px;
  margin-left: 4px;
  z-index: 2;
  justify-content: flex-end;
  pointer-events: none;
}

.conversation-item-compact.has-dual-actions .conv-actions {
  flex-basis: 42px;
  width: 42px;
  min-width: 42px;
}

.conversation-item-compact .conv-actions::before {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-panel) 38%, transparent);
  -webkit-backdrop-filter: blur(8px) saturate(118%);
  backdrop-filter: blur(8px) saturate(118%);
  opacity: 0;
  transform: scale(0.9);
  transform-origin: right center;
  transition: opacity 0.22s ease, transform 0.26s cubic-bezier(0.22, 1, 0.36, 1);
  pointer-events: none;
}

.conversation-item-compact:hover .conv-actions::before,
.conversation-item-compact.active .conv-actions::before,
.conversation-item-compact:focus-within .conv-actions::before {
  opacity: 1;
  transform: scale(1);
}

.conversation-item-compact:hover .conv-pin,
.conversation-item-compact:hover .conv-delete,
.conversation-item-compact.active .conv-pin,
.conversation-item-compact.active .conv-delete,
.conversation-item-compact:focus-within .conv-pin,
.conversation-item-compact:focus-within .conv-delete {
  opacity: 1;
  pointer-events: auto;
  transform: translateX(0);
}

.conversation-item-compact:hover .conv-delete,
.conversation-item-compact.active .conv-delete,
.conversation-item-compact:focus-within .conv-delete {
  max-width: 20px;
  transition-delay: 0.04s;
}

/* Pinned rows keep the pin visible as a standalone frosted chip when idle. */
.conversation-item-compact .conv-pin.active {
  opacity: 1;
  pointer-events: auto;
  transform: translateX(0);
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-panel) 34%, transparent);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
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

.conv-status.compact {
  gap: 0;
  padding: 0;
  min-width: 7px;
  background: transparent;
}

.conv-status.streaming {
  color: var(--app-accent-strong);
  background: color-mix(in srgb, var(--app-accent-soft) 82%, transparent);
}

.conv-status.auth {
  color: #b45309;
  background: rgba(245, 158, 11, 0.16);
}

.conv-status.unread {
  color: var(--app-danger);
  background: color-mix(in srgb, var(--app-danger) 14%, transparent);
}

.conv-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: currentColor;
}

.conv-status.compact .conv-status-dot {
  width: 6px;
  height: 6px;
}

.conv-status.compact .conv-status-count {
  margin-left: 4px;
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

  .conv-item.conversation-item-compact {
    flex-direction: row;
  }

  .conv-delete {
    opacity: 1;
    transform: none;
  }
}
</style>
