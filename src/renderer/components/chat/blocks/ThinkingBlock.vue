<script setup lang="ts">
import { renderMarkdown } from '../markdown'
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'thinking' }>
  isStreaming: boolean
  isCollapsed: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle'): void
}>()
</script>

<template>
  <div class="thinking-card message-event-card">
    <button class="thinking-header" type="button" @click="emit('toggle')">
      <span class="thinking-header-left">
        <span v-if="props.isStreaming" class="thinking-dot-icon" aria-hidden="true">
          <span class="thinking-dot"></span>
          <span class="thinking-dot"></span>
          <span class="thinking-dot"></span>
        </span>
        <svg v-else class="thinking-brain-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 2a5 5 0 0 1 5 5c0 1.07-.34 2.06-.9 2.88A4 4 0 0 1 20 14a4 4 0 0 1-4 4h-1v2a1 1 0 0 1-2 0v-2H8a4 4 0 0 1-4-4 4 4 0 0 1 3.9-3.12A5 5 0 0 1 7 7a5 5 0 0 1 5-5z"/>
        </svg>
        <span class="thinking-header-label">{{ props.isStreaming ? '思考中…' : '思考过程' }}</span>
        <span v-if="!props.isStreaming" class="thinking-char-count">{{ props.block.text.length.toLocaleString() }} 字</span>
      </span>
      <span class="thinking-chevron" :class="{ expanded: !props.isCollapsed }" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </span>
    </button>
    <div class="thinking-body-wrapper" :class="{ collapsed: props.isCollapsed }">
      <div class="thinking-body">
        <div class="thinking-body-inner message-event-body markdown-body" v-html="renderMarkdown(props.block.text)"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Base event card styles */
.message-event-card {
  width: min(100%, var(--chat-event-card-max, 1080px));
  border: 1px solid var(--app-border-strong);
  border-radius: 18px;
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);
  overflow: hidden;
}

.thinking-card {
  border-color: rgba(139, 92, 246, 0.2);
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
}

.thinking-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 11px 16px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  gap: 10px;
  transition: background 0.15s ease;
  border-radius: 18px;
}

.thinking-header:hover {
  background: var(--app-panel-muted);
}

.thinking-header-left {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.thinking-brain-icon {
  color: rgba(139, 92, 246, 0.7);
  flex-shrink: 0;
}

.thinking-header-label {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--app-text-strong);
}

.thinking-char-count {
  font-size: 0.75rem;
  color: var(--app-text-muted);
  white-space: nowrap;
}

.thinking-chevron {
  color: var(--app-text-muted);
  flex-shrink: 0;
  transform: rotate(-90deg);
  transition: transform 0.22s ease;
  display: flex;
  align-items: center;
}

.thinking-chevron.expanded {
  transform: rotate(0deg);
}

/* Smooth expand/collapse via grid-template-rows trick */
.thinking-body-wrapper {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.25s ease;
}

.thinking-body-wrapper.collapsed {
  grid-template-rows: 0fr;
}

.thinking-body {
  overflow: hidden;
  min-height: 0;
}

.thinking-body-inner {
  border-top: 1px solid var(--app-border);
}

.message-event-body {
  padding: 14px 16px 16px;
  color: var(--app-text-muted);
  line-height: 1.68;
}

/* Animated dots for streaming */
.thinking-dot-icon {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}

.thinking-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(139, 92, 246, 0.7);
  animation: thinking-bounce 1.2s ease-in-out infinite;
}

.thinking-dot:nth-child(1) { animation-delay: 0s; }
.thinking-dot:nth-child(2) { animation-delay: 0.2s; }
.thinking-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes thinking-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}
</style>
