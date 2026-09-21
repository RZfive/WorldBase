<script setup lang="ts">
import { ref } from 'vue'
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'sudo_password_request' }>
}>()

const emit = defineEmits<{
  (e: 'respondSudoPassword', requestId: string, password: string | null): void
}>()

const passwordInput = ref('')
const localStatus = ref<'pending' | 'submitted' | 'canceled'>(props.block.status)

function onConfirm () {
  if (localStatus.value !== 'pending') return
  localStatus.value = 'submitted'
  emit('respondSudoPassword', props.block.requestId, passwordInput.value)
  passwordInput.value = ''
}

function onCancel () {
  if (localStatus.value !== 'pending') return
  localStatus.value = 'canceled'
  emit('respondSudoPassword', props.block.requestId, null)
}

/** Display a truncated command — avoids showing very long strings in the block. */
function truncate (str: string, max = 120): string {
  return str.length > max ? str.slice(0, max) + '…' : str
}
</script>

<template>
  <div
    class="message-event-card sudo-password-card"
    :class="localStatus"
  >
    <div class="sudo-icon-row">
      <div class="sudo-icon" :class="localStatus">
        <!-- Key icon for pending -->
        <svg v-if="localStatus === 'pending'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
        </svg>
        <!-- Check icon for submitted -->
        <svg v-else-if="localStatus === 'submitted'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <!-- X icon for canceled -->
        <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="15" y1="9" x2="9" y2="15"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
      </div>
      <div class="sudo-label-group">
        <span class="sudo-badge">{{ $t('chatUi.sudoPassword') }}</span>
        <span class="sudo-status" :class="localStatus">
          {{ localStatus === 'submitted' ? $t('chatUi.sudoSubmitted') : (localStatus === 'canceled' ? $t('chatUi.sudoCanceled') : $t('chatUi.sudoWaitingInput')) }}
        </span>
      </div>
    </div>

    <div class="sudo-command-label">{{ $t('chatUi.sudoCommandRequiresPermissionColon') }}</div>
    <pre class="sudo-command-preview">{{ truncate(props.block.command) }}</pre>

    <template v-if="localStatus === 'pending'">
      <div class="sudo-input-row">
        <input
          v-model="passwordInput"
          class="sudo-password-input"
          type="password"
          :placeholder="$t('chatUi.sudoPasswordPlaceholder')"
          autocomplete="current-password"
          @keydown.enter="onConfirm"
          @keydown.esc="onCancel"
        />
      </div>
      <div class="sudo-actions">
        <button class="sudo-btn cancel" type="button" @click="onCancel">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          {{ $t('common.cancel') }}
        </button>
        <button class="sudo-btn confirm" type="button" @click="onConfirm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          {{ $t('common.confirm') }}
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.message-event-card {
  width: min(100%, var(--chat-event-card-max, 1080px));
  border: 1px solid var(--app-border-strong);
  border-radius: 18px;
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);
  overflow: hidden;
}

.sudo-password-card {
  position: relative;
  padding: 18px 20px;
  border-color: rgba(245, 158, 11, 0.35);
  transition: border-color 0.3s ease;
}

.sudo-password-card.pending {
  border-color: rgba(245, 158, 11, 0.45);
  box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.08), 0 12px 30px rgba(15, 23, 42, 0.08);
}

/* Pulse ring: animates opacity on a static inset ring instead of `box-shadow`,
   so the breath runs on the compositor rather than re-blurring every frame. */
.sudo-password-card.pending::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 0 2px rgba(245, 158, 11, 0.14);
  pointer-events: none;
  animation: sudo-pulse 2s ease-in-out infinite;
}

.sudo-password-card.submitted {
  border-color: rgba(34, 197, 94, 0.3);
}

.sudo-password-card.canceled {
  border-color: rgba(239, 68, 68, 0.25);
  opacity: 0.75;
}

@keyframes sudo-pulse {
  0%, 100% { opacity: 0; }
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .sudo-password-card.pending::after { animation: none; opacity: 0.6; }
}

.sudo-icon-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.sudo-icon {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.sudo-icon.pending {
  background: rgba(245, 158, 11, 0.12);
  color: #f59e0b;
}

.sudo-icon.submitted {
  background: rgba(34, 197, 94, 0.12);
  color: #22c55e;
}

.sudo-icon.canceled {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}

.sudo-label-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sudo-badge {
  display: inline-flex;
  align-items: center;
  font-size: 0.82em;
  font-weight: 700;
  color: var(--app-text-strong);
}

.sudo-status {
  font-size: 0.74em;
}

.sudo-status.pending { color: #f59e0b; font-weight: 600; }
.sudo-status.submitted { color: #22c55e; }
.sudo-status.canceled { color: #ef4444; }

.sudo-command-label {
  margin-top: 14px;
  font-size: 0.82em;
  color: var(--app-text-soft);
}

.sudo-command-preview {
  margin: 8px 0 0;
  padding: 10px 14px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel-subtle);
  color: var(--app-text-soft);
  font-size: 0.80em;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.sudo-input-row {
  margin-top: 14px;
}

.sudo-password-input {
  width: 100%;
  height: 40px;
  padding: 0 14px;
  border: 1px solid var(--app-border-strong);
  border-radius: 10px;
  background: var(--app-panel-subtle);
  color: var(--app-text);
  font-size: 0.88em;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.sudo-password-input:focus {
  border-color: rgba(245, 158, 11, 0.5);
  box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.12);
}

.sudo-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}

.sudo-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 90px;
  height: 38px;
  padding: 0 16px;
  border: none;
  border-radius: 10px;
  font-size: 0.84em;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.sudo-btn.cancel {
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  border: 1px solid var(--app-border-strong);
}

.sudo-btn.cancel:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.3);
}

.sudo-btn.confirm {
  background: linear-gradient(135deg, #f59e0b, #d97706);
  color: #ffffff;
  border: 1px solid transparent;
}

.sudo-btn.confirm:hover {
  background: linear-gradient(135deg, #d97706, #b45309);
  box-shadow: 0 4px 15px rgba(245, 158, 11, 0.35);
}
</style>
