<script setup lang="ts">
import { ref, watch } from 'vue'
import type { SudoPasswordRequestPayload } from '../panel/types'

const props = defineProps<{
  request: SudoPasswordRequestPayload
  pendingCount: number
}>()

const emit = defineEmits<{
  (e: 'respond', requestId: string, password: string | null): void
}>()

const collapsed = ref(false)
const passwordInput = ref('')

// Reset to expanded + clear any stale input whenever a new request takes the foreground.
watch(
  () => props.request.requestId,
  () => {
    collapsed.value = false
    passwordInput.value = ''
  },
  { immediate: true }
)

function truncate (str: string, max = 160): string {
  return str.length > max ? str.slice(0, max) + '…' : str
}

function confirm () {
  if (!passwordInput.value) return
  emit('respond', props.request.requestId, passwordInput.value)
  passwordInput.value = ''
}

function cancel () {
  emit('respond', props.request.requestId, null)
  passwordInput.value = ''
}

function toggleCollapsed (): void {
  collapsed.value = !collapsed.value
}
</script>

<template>
  <section class="sudo-shell" aria-label="待授权的 sudo 命令">
    <div class="sudo-float" :class="{ expanded: !collapsed }">
      <Transition name="sudo-expand">
        <div v-if="!collapsed" class="sudo-detail">
          <div class="sudo-detail-head">
            <span>sudo 密码</span>
            <span v-if="props.pendingCount > 1">{{ props.pendingCount }} 项排队</span>
            <span v-else>等待输入</span>
          </div>

          <div class="sudo-detail-title">执行命令需要 sudo 权限</div>
          <pre class="sudo-detail-body">{{ truncate(props.request.command) }}</pre>

          <div class="sudo-input-row">
            <input
              v-model="passwordInput"
              class="sudo-password-input"
              type="password"
              placeholder="输入 sudo 密码…"
              autocomplete="current-password"
              @keydown.enter="confirm"
              @keydown.esc="cancel"
            />
          </div>

          <div class="sudo-actions">
            <button class="sudo-btn cancel" type="button" @click="cancel">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
              取消
            </button>
            <button
              class="sudo-btn confirm"
              type="button"
              :disabled="!passwordInput"
              @click="confirm"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              确认
            </button>
          </div>
        </div>
      </Transition>

      <button
        class="sudo-strip"
        type="button"
        :aria-expanded="!collapsed"
        @click="toggleCollapsed"
      >
        <span class="sudo-strip-status">sudo 密码</span>
        <span class="sudo-strip-title">{{ truncate(props.request.command, 60) }}</span>
        <span v-if="props.pendingCount > 1" class="sudo-strip-count">{{ props.pendingCount }}</span>
        <span class="sudo-toggle" :class="{ collapsed }" aria-hidden="true">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.sudo-shell {
  position: relative;
  z-index: 11;
  height: 0;
  width: 100%;
  max-width: var(--chat-message-track-max, 980px);
  margin: 0 auto;
  padding: 0 var(--chat-message-gutter, 28px);
  box-sizing: border-box;
  pointer-events: none;
}

.sudo-float {
  position: absolute;
  left: 50%;
  bottom: max(0px, calc(var(--chat-input-overlap, 56px) - 10px));
  width: min(560px, calc(100% - 32px));
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: stretch;
  pointer-events: auto;
  transform: translateX(-50%);
}

.sudo-strip {
  width: 100%;
  height: 36px;
  min-width: 0;
  padding: 0 8px 0 10px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  border: 1px solid color-mix(in srgb, #ef4444 42%, var(--app-border-strong));
  border-bottom: 0;
  border-radius: 10px 10px 0 0;
  background: color-mix(in srgb, var(--app-panel) 96%, transparent);
  box-shadow: 0 -10px 28px rgba(0, 0, 0, 0.16);
  color: var(--app-text);
  cursor: pointer;
  text-align: left;
  backdrop-filter: blur(14px) saturate(130%);
  -webkit-backdrop-filter: blur(14px) saturate(130%);
  animation: sudo-strip-pulse 2s ease-in-out infinite;
}

.sudo-strip:hover {
  border-color: color-mix(in srgb, #ef4444 60%, var(--app-border-strong));
  background: color-mix(in srgb, rgba(239, 68, 68, 0.14) 60%, var(--app-panel));
}

@keyframes sudo-strip-pulse {
  0%, 100% { box-shadow: 0 -10px 28px rgba(0, 0, 0, 0.16), 0 0 0 0 rgba(239, 68, 68, 0); }
  50% { box-shadow: 0 -10px 28px rgba(0, 0, 0, 0.16), 0 0 0 3px rgba(239, 68, 68, 0.18); }
}

.sudo-strip-status {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 7px;
  border-radius: 7px;
  border: 1px solid color-mix(in srgb, #ef4444 40%, var(--app-border-strong));
  background: rgba(239, 68, 68, 0.16);
  color: #b91c1c;
  font-size: 0.68rem;
  font-weight: 800;
  white-space: nowrap;
}

:global(:root[data-theme='dark'] .sudo-strip-status) {
  color: #fca5a5;
}

.sudo-strip-title {
  min-width: 0;
  color: var(--app-text-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.78rem;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-weight: 700;
}

.sudo-strip-count {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 7px;
  border-radius: 7px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text-muted);
  font-size: 0.68rem;
  font-weight: 800;
  white-space: nowrap;
}

.sudo-toggle {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text-muted);
  transition:
    transform 0.18s ease,
    color 0.18s ease,
    border-color 0.18s ease;
}

.sudo-toggle.collapsed {
  transform: rotate(180deg);
}

.sudo-detail {
  padding: 12px;
  border: 1px solid color-mix(in srgb, #ef4444 38%, var(--app-border-strong));
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-panel) 97%, transparent);
  box-shadow: var(--app-shadow);
  overflow: hidden;
  backdrop-filter: blur(14px) saturate(130%);
  -webkit-backdrop-filter: blur(14px) saturate(130%);
}

.sudo-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
  color: var(--app-text-muted);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.sudo-detail-title {
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--app-text-strong);
  line-height: 1.5;
  margin-bottom: 8px;
}

.sudo-detail-body {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  font-size: 0.78rem;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: min(140px, 28vh);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.sudo-input-row {
  margin-bottom: 12px;
}

.sudo-password-input {
  width: 100%;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--app-border-strong);
  border-radius: 10px;
  background: var(--app-panel-muted);
  color: var(--app-text);
  font-size: 0.84rem;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.sudo-password-input:focus {
  border-color: #ef4444;
  box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.16);
}

.sudo-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--app-border);
}

.sudo-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 96px;
  height: 32px;
  padding: 0 14px;
  border-radius: 8px;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  border: 1px solid var(--app-border-strong);
}

.sudo-btn.cancel {
  background: var(--app-panel);
  color: var(--app-text);
}

.sudo-btn.cancel:hover {
  border-color: #ef4444;
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
}

.sudo-btn.confirm {
  background: #ef4444;
  border-color: #ef4444;
  color: #ffffff;
}

.sudo-btn.confirm:hover:not(:disabled) {
  background: #dc2626;
  border-color: #dc2626;
}

.sudo-btn.confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sudo-expand-enter-active,
.sudo-expand-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
  transform-origin: bottom center;
}

.sudo-expand-enter-from,
.sudo-expand-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

@media (max-width: 860px) {
  .sudo-shell {
    padding: 0 16px;
  }

  .sudo-float {
    width: calc(100% - 16px);
  }
}
</style>
