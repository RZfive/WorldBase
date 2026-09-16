<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  title: string
  meta?: string
  detail?: string
  status?: 'running' | 'completed' | 'failed' | 'neutral'
  defaultExpanded?: boolean
}>(), {
  meta: '',
  detail: '',
  status: 'neutral',
  defaultExpanded: false
})

const expanded = ref(props.defaultExpanded)
const slots = defineSlots<{
  default?: () => unknown
}>()
const hasDetails = computed(() => Boolean(slots.default))

function toggleExpanded (): void {
  if (!hasDetails.value) return
  expanded.value = !expanded.value
}

watch(
  () => props.defaultExpanded,
  (shouldExpand) => {
    if (shouldExpand) expanded.value = true
  }
)
</script>

<template>
  <section class="execution-disclosure" :class="[props.status, { expanded }]">
    <button
      class="execution-summary"
      type="button"
      :disabled="!hasDetails"
      :aria-expanded="expanded"
      @click="toggleExpanded"
    >
      <span class="execution-dot" aria-hidden="true" />
      <span class="execution-title">{{ props.title }}</span>
      <span v-if="props.meta" class="execution-meta">{{ props.meta }}</span>
      <span v-if="props.detail" class="execution-detail">{{ props.detail }}</span>
      <span v-if="hasDetails" class="execution-chevron" aria-hidden="true">›</span>
    </button>

    <div v-if="expanded && hasDetails" class="execution-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.execution-disclosure {
  box-sizing: border-box;
  width: min(100%, var(--chat-event-card-max, 1080px));
  max-width: 100%;
  min-width: 0;
  color: var(--app-text-muted);
}

.execution-summary {
  width: 100%;
  min-height: 32px;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 9px;
  border: 1px solid var(--app-border);
  border-radius: 9px;
  background: var(--app-panel);
  color: inherit;
  font: inherit;
  font-size: 0.78em;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
  box-shadow: var(--shadow-1);
}

.execution-summary:disabled { cursor: default; }
.execution-summary:hover:not(:disabled) { border-color: var(--app-border-strong); }
.execution-summary:hover:not(:disabled) .execution-title,
.execution-summary:hover:not(:disabled) .execution-detail { color: var(--app-text); }
.execution-summary:hover:not(:disabled) .execution-chevron,
.execution-summary:focus-visible:not(:disabled) .execution-chevron,
.execution-disclosure.expanded .execution-chevron { opacity: 1; }

.execution-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  flex: 0 0 auto;
  background: var(--app-border-strong);
}
.execution-disclosure.running .execution-dot { background: var(--app-accent); }
.execution-disclosure.completed .execution-dot { background: var(--app-success); }
.execution-disclosure.failed .execution-dot { background: var(--app-danger); }
.execution-title {
  flex: 0 0 auto;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-text-strong);
  font-weight: 600;
}
.execution-meta { flex: 0 0 auto; color: var(--app-text-muted); white-space: nowrap; }
.execution-meta::before { content: '·'; margin-right: 7px; }
.execution-detail {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-text-muted);
}
.execution-chevron {
  margin-left: auto;
  flex: 0 0 auto;
  color: var(--app-text-faint);
  font-size: 1.18em;
  opacity: 0.8;
  transform: rotate(0deg);
}
.execution-disclosure.expanded .execution-chevron { transform: rotate(90deg); }
.execution-body {
  margin-top: 6px;
  padding: 10px 10px 11px 13px;
  border: 1px solid var(--app-border);
  border-radius: 9px;
  background: var(--app-panel);
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  box-shadow: var(--shadow-1);
}
.execution-disclosure.failed .execution-title { color: var(--app-danger-strong); }
</style>