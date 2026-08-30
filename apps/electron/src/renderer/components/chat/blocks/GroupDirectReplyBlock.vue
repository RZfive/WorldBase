<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '../markdown'
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'group_direct_reply' }>
}>()

const reply = computed(() => props.block.directReply)
const contentHtml = computed(() => renderMarkdown(reply.value.content))
</script>

<template>
  <section class="direct-reply-card">
    <div class="direct-reply-header">
      <span class="direct-reply-badge">{{ $t('chatUi.groupDirectReplyLabel') }}</span>
      <span class="direct-reply-agent">{{ reply.agentName }}</span>
      <span v-if="!reply.endorsed" class="direct-reply-unsupported">{{ $t('chatUi.groupDirectReplyUnendorsed') }}</span>
    </div>
    <div class="markdown-body direct-reply-body" v-html="contentHtml" />
  </section>
</template>

<style scoped>
.direct-reply-card {
  width: 100%;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 30%, var(--app-border));
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-accent) 6%, var(--app-panel));
  color: var(--app-text);
}
.direct-reply-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.direct-reply-badge {
  font-size: 0.68em;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--app-accent-strong);
}
.direct-reply-agent {
  font-size: 0.86em;
  font-weight: 700;
  color: var(--app-text-strong);
}
.direct-reply-unsupported {
  font-size: 0.68em;
  color: var(--app-text-muted);
  font-style: italic;
}
.direct-reply-body {
  font-size: 0.88em;
  line-height: 1.6;
}
</style>
