<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { emitAuthResolution, onAuthResolution } from '../../utils/auth-events'

interface AuthRequest {
  requestId: string
  title: string
  detail: string
}

const currentRequest = ref<AuthRequest | null>(null)
const queuedRequests = ref<AuthRequest[]>([])
let cleanup: (() => void) | null = null
let responseCleanup: (() => void) | null = null

function handleAuthRequest (request: AuthRequest) {
  if (currentRequest.value?.requestId === request.requestId) return
  if (queuedRequests.value.some(item => item.requestId === request.requestId)) return

  if (!currentRequest.value) {
    currentRequest.value = request
    return
  }

  queuedRequests.value.push(request)
}

function handleAuthResolution (payload: { requestId: string }) {
  if (currentRequest.value?.requestId === payload.requestId) {
    currentRequest.value = queuedRequests.value.shift() ?? null
    return
  }

  queuedRequests.value = queuedRequests.value.filter(item => item.requestId !== payload.requestId)
}

function respond (approved: boolean) {
  const requestId = currentRequest.value?.requestId
  if (!requestId) return

  emitAuthResolution({ requestId, approved })
  window.electronAPI?.respondAuth(requestId, approved)
}

onMounted(() => {
  if (window.electronAPI?.onAuthRequest) {
    cleanup = window.electronAPI.onAuthRequest(handleAuthRequest)
  }

  responseCleanup = onAuthResolution(handleAuthResolution)
})

onUnmounted(() => {
  cleanup?.()
  responseCleanup?.()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="auth-fade">
      <div v-if="currentRequest" class="auth-overlay" @click.self="respond(false)">
        <div class="auth-dialog">
          <div class="auth-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <h3 class="auth-title">{{ currentRequest.title }}</h3>
          <pre class="auth-detail">{{ currentRequest.detail }}</pre>
          <div class="auth-actions">
            <button class="auth-btn deny" @click="respond(false)">
              拒绝
            </button>
            <button class="auth-btn allow" @click="respond(true)">
              允许
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.auth-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.auth-dialog {
  background: var(--color-bg-primary, #1e1e2e);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  border-radius: 16px;
  padding: 28px 32px;
  max-width: 440px;
  width: 90%;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.auth-icon {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: rgba(245, 158, 11, 0.12);
  color: #f59e0b;
  display: flex;
  align-items: center;
  justify-content: center;
}

.auth-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--color-text-primary, #e2e8f0);
  text-align: center;
}

.auth-detail {
  margin: 0;
  padding: 14px 16px;
  background: var(--color-bg-secondary, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.06));
  border-radius: 10px;
  font-size: 13px;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  color: var(--color-text-secondary, #94a3b8);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
  width: 100%;
  line-height: 1.6;
}

.auth-actions {
  display: flex;
  gap: 12px;
  width: 100%;
  margin-top: 4px;
}

.auth-btn {
  flex: 1;
  padding: 10px 20px;
  border: none;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  letter-spacing: 0.02em;
}

.auth-btn.deny {
  background: var(--color-bg-secondary, rgba(255, 255, 255, 0.06));
  color: var(--color-text-secondary, #94a3b8);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
}

.auth-btn.deny:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.3);
}

.auth-btn.allow {
  background: linear-gradient(135deg, #3b82f6, #6366f1);
  color: #fff;
  border: 1px solid transparent;
}

.auth-btn.allow:hover {
  background: linear-gradient(135deg, #2563eb, #4f46e5);
  box-shadow: 0 4px 15px rgba(99, 102, 241, 0.35);
}

/* Transition */
.auth-fade-enter-active,
.auth-fade-leave-active {
  transition: opacity 0.2s ease;
}

.auth-fade-enter-active .auth-dialog,
.auth-fade-leave-active .auth-dialog {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.auth-fade-enter-from,
.auth-fade-leave-to {
  opacity: 0;
}

.auth-fade-enter-from .auth-dialog,
.auth-fade-leave-to .auth-dialog {
  transform: scale(0.95) translateY(10px);
  opacity: 0;
}

/* Light theme */
@media (prefers-color-scheme: light) {
  :root:not([data-theme='dark']) .auth-dialog {
    background: #ffffff;
    border-color: rgba(0, 0, 0, 0.1);
  }

  :root:not([data-theme='dark']) .auth-title {
    color: #1e293b;
  }

  :root:not([data-theme='dark']) .auth-detail {
    background: #f8fafc;
    border-color: rgba(0, 0, 0, 0.08);
    color: #475569;
  }

  :root:not([data-theme='dark']) .auth-btn.deny {
    background: #f1f5f9;
    color: #64748b;
    border-color: rgba(0, 0, 0, 0.08);
  }
}

[data-theme='dark'] .auth-dialog {
  background: #1e1e2e;
}

[data-theme='light'] .auth-dialog {
  background: #ffffff;
  border-color: rgba(0, 0, 0, 0.1);
}

[data-theme='light'] .auth-title {
  color: #1e293b;
}

[data-theme='light'] .auth-detail {
  background: #f8fafc;
  border-color: rgba(0, 0, 0, 0.08);
  color: #475569;
}

[data-theme='light'] .auth-btn.deny {
  background: #f1f5f9;
  color: #64748b;
  border-color: rgba(0, 0, 0, 0.08);
}
</style>
