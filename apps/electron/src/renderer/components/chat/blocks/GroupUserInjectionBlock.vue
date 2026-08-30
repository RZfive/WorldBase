<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderMarkdown } from '../markdown'
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'group_user_injection' }>
}>()

const { t } = useI18n()
const injection = computed(() => props.block.injection)
const contentHtml = computed(() => renderMarkdown(injection.value.content))
const targetLabel = computed(() => {
  if (injection.value.targetAgentIds.length === 0) return t('chatUi.groupInjectionTargetAll')
  return injection.value.targetAgentIds.join(', ')
})
</script>

<template>
  <section class="user-injection-card">
    <div class="user-injection-header">
      <span class="user-injection-badge">{{ $t('chatUi.groupInjectionLabel') }}</span>
      <span class="user-injection-target">{{ $t('chatUi.groupInjectionTarget', { names: targetLabel }) }}</span>
    </div>
    <div class="markdown-body user-injection-body" v-html="contentHtml" />
  </section>
</template>

<style scoped>
.user-injection-card {
  width: 100%;
  padding: 10px 14px;
  border-left: 3px solid var(--app-accent);
  background: color-mix(in srgb, var(--app-accent) 8%, var(--app-panel));
  border-radius: 6px;
  color: var(--app-text);
}
.user-injection-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.user-injection-badge {
  font-size: 0.68em;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--app-accent-strong);
}
.user-injection-target {
  font-size: 0.74em;
  color: var(--app-text-muted);
}
.user-injection-body {
  font-size: 0.86em;
  line-height: 1.55;
}
</style>
