<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import SidebarIcon from './SidebarIcon.vue'
import type {
  AgentSidebarItem,
  ConversationSidebarItem,
  GroupSidebarItem,
  LongTermGoalSidebarItem
} from './ConversationSidebar.types'

type SidebarCardVariant = 'agent' | 'group' | 'conversation'

const props = withDefaults(defineProps<{
  item: AgentSidebarItem | GroupSidebarItem | ConversationSidebarItem | LongTermGoalSidebarItem
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
const showForkBadge = computed(() => props.variant === 'conversation' && (props.item as ConversationSidebarItem).isFork === true && !props.renaming)
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
            <span
              v-if="showForkBadge"
              class="conv-fork-badge"
              :title="$t('chatUi.forkedConversationBadge')"
            ><SidebarIcon name="fork" :size="11" /></span>
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
            :title="$t('chatUi.conversationCompletedReply')"
          >
            <span class="conv-status-dot"></span>
            <template v-if="!isCompactConversation">{{ $t('chatUi.conversationCompleted') }}</template>
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
        <SidebarIcon name="pin" :size="12" />
      </button>
      <button v-if="showDelete" class="conv-delete" type="button" :title="deleteTitle || $t('common.delete')" @click.stop="emit('delete')">
        <SidebarIcon name="close" :size="11" />
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Flat, uniform list rows (design v1.7): one container language — no bordered
   cards, active state = accent wash + 2.5px signature-gradient indicator. */
.conv-item {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-height: 30px;
  padding: 4px 8px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--app-text-soft);
  border: none;
  background: transparent;
  transition: background 0.16s ease, color 0.16s ease;
  overflow: visible;
}

.conv-item::before,
.conv-item::after {
  content: '';
  position: absolute;
  pointer-events: none;
}

.conv-item::before {
  inset: 6px auto 6px -8px;
  width: 2.5px;
  border-radius: 3px;
  background: transparent;
  transition: background 0.18s ease;
}

.conv-item:hover {
  background: color-mix(in srgb, var(--app-panel-muted) 72%, transparent);
  color: var(--app-text);
}

.conv-item.active {
  /* Softened wash: keep the accent identity without a saturated block of
     indigo in the light theme (design v1.7 sidebar pass). */
  background: color-mix(in srgb, var(--app-accent-wash, color-mix(in srgb, var(--app-accent) 16%, transparent)) 60%, transparent);
  color: var(--app-text-strong);
}

.conv-item.active::before {
  background: var(--app-sig);
  box-shadow: 0 0 8px var(--app-accent-glow);
}

.conv-item.dragging {
  opacity: 0.62;
}

.conv-item.waitingAuth {
  background: var(--app-warning-soft);
}

.conv-item.waitingAuth.active {
  background: color-mix(in srgb, var(--app-warning-soft) 55%, var(--app-accent-wash, color-mix(in srgb, var(--app-accent) 16%, transparent)));
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
  top: 0;
}

.conv-item.drop-after::after {
  bottom: 0;
}

.conv-item.drop-merge::after {
  left: 10px;
  right: 10px;
  bottom: 0;
}

.conv-item.drop-merge {
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
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.conv-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
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
  flex-direction: row;
  align-items: center;
  gap: 4px;
  overflow: hidden;
}

.conv-title-row-compact .conv-title-stack {
  flex: 1;
  min-width: 0;
}

.conv-fork-badge {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  color: var(--app-accent-strong);
  opacity: 0.85;
}

.conv-title {
  display: block;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--app-text-soft);
}

.conv-item.active .conv-title,
.conversation-item-compact.active .conv-title {
  font-weight: 650;
  color: var(--app-text-strong);
}

.conv-title-rename-input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 22px;
  padding: 2px 7px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 36%, var(--app-border));
  border-radius: 6px;
  background: var(--app-input-bg);
  color: var(--app-text);
  font: inherit;
  font-size: 0.74rem;
  outline: none;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-accent-soft) 34%, transparent);
}

.conv-subtitle {
  color: var(--app-text-muted);
  font-size: 0.68rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
}

/* Agent rows repeat the provider·model line on every card; keep it as faint
   plain text so the model name doesn't compete with the title. */
.agent-item .conv-subtitle {
  color: var(--app-text-faint);
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transform: translateY(2px) scale(0.94);
  transition: none;
}

.conversation-item-compact .conv-pin {
  position: relative;
  z-index: 1;
  width: 20px;
  height: 20px;
  opacity: 0;
  pointer-events: none;
  transform: translateX(7px);
  transition: none;
}

.conv-pin.active {
  opacity: 1;
  transform: translateY(0) scale(1);
  color: var(--app-accent);
}

.conv-item:hover .conv-pin {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.conv-pin:hover {
  background: color-mix(in srgb, var(--app-accent-soft) 36%, transparent);
  color: var(--app-accent);
}

.conv-item.pinned .conv-title {
  color: var(--app-text);
}

.conversation-item-compact .conv-pin.active {
  opacity: 1;
  pointer-events: auto;
  transform: translateX(0);
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-chat-list-raised) 34%, transparent);
}

.conv-delete {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: none;
  background: transparent;
  color: var(--app-text-faint);
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transform: translateY(2px) scale(0.94);
  transition: none;
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
.conv-item.active .conv-delete {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.conv-delete:hover {
  background: var(--app-danger-soft);
  color: var(--app-danger);
}

.conversation-item-compact .conv-actions {
  position: absolute;
  top: 50%;
  right: 4px;
  width: auto;
  min-width: 0;
  height: 22px;
  display: flex;
  align-items: center;
  gap: 1px;
  z-index: 2;
  justify-content: flex-end;
  pointer-events: none;
  transform: translateY(-50%);
}

.conversation-item-compact .conv-actions::before {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 999px;
  background: var(--app-chat-list-raised);
  opacity: 0;
  transform: scale(0.9);
  transform-origin: right center;
  transition: none;
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

/* Status as plain light text, not a pill chip — the colored dot carries the
   state, so a tinted capsule behind the label is visual noise. */
.conv-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.62rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  flex-shrink: 0;
}

.conv-status.compact {
  gap: 0;
  min-width: 7px;
}

.conv-status.streaming {
  color: var(--app-accent-strong);
}

.conv-status.auth {
  color: var(--app-warning-strong);
}

.conv-status.unread {
  color: var(--app-warning-strong);
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

@media (prefers-reduced-motion: reduce) {
  .conv-status-dot {
    animation: none;
  }
}

@media (max-width: 880px) {
  .conv-item {
    flex-direction: column;
    align-items: stretch;
  }

  .conv-item.conversation-item-compact {
    flex-direction: row;
    align-items: center;
  }

  .conv-delete {
    opacity: 1;
    transform: none;
  }
}
</style>
