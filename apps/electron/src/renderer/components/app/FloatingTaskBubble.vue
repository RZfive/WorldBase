<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  isLoading: boolean
  pendingAuthCount: number
  activeTodoCount: number
}>()

const emit = defineEmits<{
  (e: 'open'): void
}>()

const { t } = useI18n()

const bubbleState = computed(() => {
  if (props.pendingAuthCount > 0) return 'attention'
  if (props.isLoading) return 'working'
  if (props.activeTodoCount > 0) return 'ready'
  return 'idle'
})

const statusLabel = computed(() => {
  if (props.pendingAuthCount > 0) {
    return t('appShell.waitingAuth')
  }

  if (props.isLoading) {
    return t('appShell.running')
  }

  if (props.activeTodoCount > 0) {
    return t('appShell.pendingContinue')
  }

  return t('appShell.idle')
})

const titleText = computed(() => t('appShell.aiStatusTitle', { status: statusLabel.value }))
const ariaText = computed(() => t('appShell.aiStatusAria', { status: statusLabel.value }))
</script>

<template>
  <button
    :class="['task-bubble', `task-bubble-${bubbleState}`]"
    type="button"
    :title="titleText"
    :aria-label="ariaText"
    @click="emit('open')"
  >
    <span class="task-bubble-orb">
      <span class="task-bubble-core">AI</span>
      <span class="task-bubble-dot" aria-hidden="true"></span>
    </span>
  </button>
</template>

<style scoped>
.task-bubble {
  position: absolute;
  right: clamp(16px, 2.4vw, 30px);
  bottom: clamp(16px, 2.8vw, 32px);
  z-index: 36;
  width: 76px;
  height: 76px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
  transition: transform 0.16s ease, filter 0.16s ease;
}

.task-bubble:hover {
  transform: translateY(-2px);
  filter: saturate(1.06);
}

.task-bubble-orb {
  position: relative;
  width: 68px;
  height: 68px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: 50%;
  padding: 6px;
  border: 1px solid color-mix(in srgb, var(--app-border-strong) 74%, transparent);
  background: color-mix(in srgb, var(--app-panel-strong) 92%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--app-text-strong) 12%, transparent),
    0 12px 30px color-mix(in srgb, var(--app-shadow) 78%, transparent);
}

.task-bubble-core {
  width: 100%;
  height: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 0.9rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: var(--task-bubble-ink, var(--app-text-strong));
  background: var(--task-bubble-fill, linear-gradient(135deg, var(--app-accent), var(--app-accent-strong)));
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--app-text-strong) 16%, transparent);
}

.task-bubble-orb::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: inherit;
  border: 2px solid var(--task-bubble-ring, transparent);
  opacity: 0;
}

.task-bubble-dot {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 14px;
  height: 14px;
  display: inline-flex;
  border-radius: 999px;
  border: 2px solid var(--app-panel-strong);
  background: var(--task-bubble-dot, var(--app-text-muted));
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--task-bubble-dot, var(--app-text-muted)) 18%, transparent);
}

.task-bubble-idle {
  --task-bubble-fill: linear-gradient(135deg, var(--app-panel), color-mix(in srgb, var(--app-panel-muted) 78%, var(--app-panel)));
  --task-bubble-ink: var(--app-text-strong);
  --task-bubble-dot: var(--app-text-muted);
  --task-bubble-ring: transparent;
}

.task-bubble-working {
  --task-bubble-fill: linear-gradient(135deg, var(--app-accent), color-mix(in srgb, var(--app-accent-strong) 72%, var(--app-panel)));
  --task-bubble-ink: var(--app-text-strong);
  --task-bubble-dot: var(--app-accent-strong);
  --task-bubble-ring: color-mix(in srgb, var(--app-accent-glow) 88%, transparent);
}

.task-bubble-working .task-bubble-orb::after,
.task-bubble-attention .task-bubble-orb::after {
  animation: task-bubble-pulse 1.6s ease-out infinite;
  opacity: 1;
}

.task-bubble-attention {
  --task-bubble-fill: linear-gradient(135deg, #f59e0b, color-mix(in srgb, #b45309 78%, var(--app-panel)));
  --task-bubble-ink: #fff7ed;
  --task-bubble-dot: #fbbf24;
  --task-bubble-ring: color-mix(in srgb, #f59e0b 34%, transparent);
}

.task-bubble-ready {
  --task-bubble-fill: linear-gradient(135deg, var(--app-success), color-mix(in srgb, var(--app-success) 58%, var(--app-panel)));
  --task-bubble-ink: #f0fdf4;
  --task-bubble-dot: var(--app-success);
  --task-bubble-ring: transparent;
}

@keyframes task-bubble-pulse {
  0% {
    transform: scale(0.94);
    opacity: 0.72;
  }

  100% {
    transform: scale(1.12);
    opacity: 0;
  }
}

@media (max-width: 720px) {
  .task-bubble {
    right: 12px;
    bottom: 12px;
  }
}
</style>
