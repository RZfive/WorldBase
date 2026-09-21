<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ChatMessageBlock } from '../types'
import { translateAuthDetail, translateAuthTitle } from '../auth-i18n'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'auth_request' }>
}>()

const emit = defineEmits<{
  (e: 'respondAuth', requestId: string, approved: boolean): void
}>()

const { t } = useI18n()

const translatedTitle = computed(() => translateAuthTitle(props.block.title, t))
const translatedDetail = computed(() => translateAuthDetail(props.block.detail, t))

const statusText = computed(() => {
  if (props.block.status === 'approved') return `✓ ${t('chatUi.allowed')}`
  if (props.block.status === 'denied') return `✕ ${t('chatUi.denied')}`
  return `⏳ ${t('chatUi.waitingAuth')}`
})
</script>

<template>
  <div
    class="message-event-card auth-request-card"
    :class="props.block.status"
  >
    <div class="auth-request-icon-row">
      <div class="auth-request-icon" :class="props.block.status">
        <svg v-if="props.block.status === 'pending'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
        <svg v-else-if="props.block.status === 'approved'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="15" y1="9" x2="9" y2="15"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
      </div>
      <div class="auth-request-label-group">
        <span class="auth-request-badge">{{ $t('chatUi.operationAuth') }}</span>
        <span class="auth-request-status" :class="props.block.status">
          {{ statusText }}
        </span>
      </div>
    </div>
    <div class="auth-request-title">{{ translatedTitle }}</div>
    <pre class="auth-request-detail">{{ translatedDetail }}</pre>
    <div v-if="props.block.status === 'pending'" class="auth-request-actions">
      <button class="auth-request-btn deny" type="button" @click="emit('respondAuth', props.block.requestId, false)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
        {{ $t('chatUi.deny') }}
      </button>
      <button class="auth-request-btn allow" type="button" @click="emit('respondAuth', props.block.requestId, true)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        {{ $t('chatUi.allowExecution') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.message-event-card {
  width: min(100%, var(--chat-event-card-max, 1080px));
  border: 1px solid var(--app-border-strong);
  border-radius: 13px;
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);
  overflow: hidden;
}

.auth-request-card {
  position: relative;
  padding: 10px 12px;
  border-color: rgba(245, 158, 11, 0.35);
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  transition: border-color 0.3s ease;
}

.auth-request-card.pending {
  border-color: rgba(245, 158, 11, 0.45);
  box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.08), 0 12px 30px rgba(15, 23, 42, 0.08);
}

/* Pulse ring: animates opacity on a static inset ring instead of `box-shadow`,
   so the breath runs on the compositor rather than re-blurring every frame. */
.auth-request-card.pending::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 0 2px rgba(245, 158, 11, 0.14);
  pointer-events: none;
  animation: auth-pulse 2s ease-in-out infinite;
}

.auth-request-card.approved {
  border-color: rgba(34, 197, 94, 0.3);
}

.auth-request-card.denied {
  border-color: rgba(239, 68, 68, 0.25);
  opacity: 0.75;
}

@keyframes auth-pulse {
  0%, 100% { opacity: 0; }
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .auth-request-card.pending::after { animation: none; opacity: 0.6; }
}

.auth-request-icon-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.auth-request-icon {
  width: 42px;
  height: 42px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.auth-request-icon.pending {
  background: rgba(245, 158, 11, 0.12);
  color: #f59e0b;
}

.auth-request-icon.approved {
  background: rgba(34, 197, 94, 0.12);
  color: var(--app-success);
}

.auth-request-icon.denied {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}

.auth-request-label-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.auth-request-badge {
  display: inline-flex;
  align-items: center;
  font-size: 0.82em;
  font-weight: 700;
  color: var(--app-text-strong);
}

.auth-request-status {
  font-size: 0.74em;
}

.auth-request-status.pending { color: #f59e0b; font-weight: 600; }
.auth-request-status.approved { color: var(--app-success); }
.auth-request-status.denied { color: #ef4444; }

.auth-request-title {
  margin-top: 14px;
  font-size: 0.88em;
}

.auth-request-detail {
  margin: 10px 0 0;
  padding: 12px 14px;
  border: 1px solid var(--app-border);
  border-radius: 9px;
  background: var(--app-panel-subtle);
  color: var(--app-text-soft);
  font-size: 0.82em;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}

.auth-request-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}

.auth-request-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 100px;
  height: 40px;
  padding: 0 18px;
  border: none;
  border-radius: 9px;
  font-size: 0.86em;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.auth-request-btn.deny {
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  border: 1px solid var(--app-border-strong);
}

.auth-request-btn.deny:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.3);
}

.auth-request-btn.allow {
  background: linear-gradient(135deg, #3b82f6, #6366f1);
  color: #ffffff;
  border: 1px solid transparent;
}

.auth-request-btn.allow:hover {
  background: linear-gradient(135deg, #2563eb, #4f46e5);
  box-shadow: 0 4px 15px rgba(99, 102, 241, 0.35);
}
</style>
