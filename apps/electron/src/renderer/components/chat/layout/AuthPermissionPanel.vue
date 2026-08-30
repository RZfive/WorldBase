<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AuthRequestPayload } from '../panel/types'
import { translateAuthDetail, translateAuthTitle } from '../auth-i18n'

const props = defineProps<{
  request: AuthRequestPayload
  pendingCount: number
}>()

const emit = defineEmits<{
  (e: 'respond', requestId: string, approved: boolean): void
}>()

const collapsed = ref(false)
const { t } = useI18n()
const translatedTitle = computed(() => translateAuthTitle(props.request.title, t))
const translatedDetail = computed(() => translateAuthDetail(props.request.detail, t))

// Reset to expanded whenever a brand-new request takes the foreground so the user
// always sees the action they need to approve without an extra click.
watch(
  () => props.request.requestId,
  () => {
    collapsed.value = false
  },
  { immediate: true }
)

function approve () {
  emit('respond', props.request.requestId, true)
}

function deny () {
  emit('respond', props.request.requestId, false)
}

function toggleCollapsed (): void {
  collapsed.value = !collapsed.value
}
</script>

<template>
  <section class="auth-shell" :aria-label="$t('chatUi.pendingToolAuth')">
    <div class="auth-float" :class="{ expanded: !collapsed }">
      <Transition name="auth-expand">
        <div v-if="!collapsed" class="auth-detail">
          <div class="auth-detail-head">
            <span>{{ $t('chatUi.operationAuth') }}</span>
            <span v-if="props.pendingCount > 1">{{ $t('chatUi.pendingQueue', { count: props.pendingCount }) }}</span>
            <span v-else>{{ $t('chatUi.waitingAuth') }}</span>
          </div>

          <div class="auth-detail-title">{{ translatedTitle }}</div>
          <pre class="auth-detail-body">{{ translatedDetail }}</pre>

          <div class="auth-actions">
            <button class="auth-btn deny" type="button" @click="deny">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
              {{ $t('chatUi.deny') }}
            </button>
            <button class="auth-btn allow" type="button" @click="approve">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              {{ $t('chatUi.allowExecution') }}
            </button>
          </div>
        </div>
      </Transition>

      <button
        class="auth-strip"
        type="button"
        :aria-expanded="!collapsed"
        @click="toggleCollapsed"
      >
        <span class="auth-strip-status">{{ $t('chatUi.waitingAuth') }}</span>
        <span class="auth-strip-title">{{ translatedTitle }}</span>
        <span v-if="props.pendingCount > 1" class="auth-strip-count">{{ props.pendingCount }}</span>
        <span class="auth-toggle" :class="{ collapsed }" aria-hidden="true">
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
.auth-shell {
  --auth-panel-max-width: 560px;
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

.auth-float {
  position: absolute;
  left: 50%;
  bottom: max(0px, calc(var(--chat-input-overlap, 56px) - 10px));
  width: min(
    var(--auth-panel-max-width),
    var(--chat-message-track-max, 980px),
    calc(100% - var(--chat-message-gutter, 28px) - var(--chat-message-gutter, 28px))
  );
  max-width: calc(100% - 16px);
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: stretch;
  box-sizing: border-box;
  pointer-events: auto;
  transform: translateX(-50%);
}

.auth-strip {
  width: 100%;
  height: 36px;
  min-width: 0;
  padding: 0 8px 0 10px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  border: 1px solid color-mix(in srgb, #f59e0b 38%, var(--app-border-strong));
  border-bottom: 0;
  border-radius: 10px 10px 0 0;
  background: color-mix(in srgb, var(--app-panel) 96%, transparent);
  box-shadow: 0 -10px 28px rgba(0, 0, 0, 0.16);
  color: var(--app-text);
  cursor: pointer;
  text-align: left;
  backdrop-filter: blur(14px) saturate(130%);
  -webkit-backdrop-filter: blur(14px) saturate(130%);
  animation: auth-strip-pulse 2s ease-in-out infinite;
}

.auth-strip:hover {
  border-color: color-mix(in srgb, #f59e0b 56%, var(--app-border-strong));
  background: color-mix(in srgb, rgba(245, 158, 11, 0.18) 60%, var(--app-panel));
}

@keyframes auth-strip-pulse {
  0%, 100% { box-shadow: 0 -10px 28px rgba(0, 0, 0, 0.16), 0 0 0 0 rgba(245, 158, 11, 0); }
  50% { box-shadow: 0 -10px 28px rgba(0, 0, 0, 0.16), 0 0 0 3px rgba(245, 158, 11, 0.16); }
}

.auth-strip-status {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 7px;
  border-radius: 7px;
  border: 1px solid color-mix(in srgb, #f59e0b 36%, var(--app-border-strong));
  background: rgba(245, 158, 11, 0.16);
  color: #b45309;
  font-size: 0.68rem;
  font-weight: 800;
  white-space: nowrap;
}

:global(:root[data-theme='dark'] .auth-strip-status) {
  color: #fbbf24;
}

.auth-strip-title {
  min-width: 0;
  color: var(--app-text-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.8rem;
  font-weight: 700;
}

.auth-strip-count {
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

.auth-toggle {
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

.auth-toggle.collapsed {
  transform: rotate(180deg);
}

.auth-detail {
  padding: 12px;
  border: 1px solid color-mix(in srgb, #f59e0b 32%, var(--app-border-strong));
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-panel) 97%, transparent);
  box-shadow: var(--app-shadow);
  overflow: hidden;
  backdrop-filter: blur(14px) saturate(130%);
  -webkit-backdrop-filter: blur(14px) saturate(130%);
}

.auth-detail-head {
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

.auth-detail-title {
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--app-text-strong);
  line-height: 1.5;
  margin-bottom: 8px;
}

.auth-detail-body {
  margin: 0;
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
  max-height: min(180px, 32vh);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.auth-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--app-border);
}

.auth-btn {
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

.auth-btn.deny {
  background: var(--app-panel);
  color: var(--app-text);
}

.auth-btn.deny:hover {
  border-color: var(--app-danger, #ef4444);
  color: var(--app-danger, #ef4444);
  background: rgba(239, 68, 68, 0.08);
}

.auth-btn.allow {
  background: var(--app-accent);
  border-color: var(--app-accent);
  color: #ffffff;
}

.auth-btn.allow:hover {
  background: var(--app-accent-strong);
  border-color: var(--app-accent-strong);
}

.auth-expand-enter-active,
.auth-expand-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
  transform-origin: bottom center;
}

.auth-expand-enter-from,
.auth-expand-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

</style>
