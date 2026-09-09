<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderMarkdown } from '../markdown'
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'group_peer_message' }>
}>()

const { t } = useI18n()
const msg = computed(() => props.block.peerMessage)
const requestHtml = computed(() => renderMarkdown(msg.value.request))
const responseHtml = computed(() => renderMarkdown(msg.value.response || (msg.value.status === 'pending' ? t('chatUi.groupPeerPending') : t('chatUi.groupPeerNoReply'))))
const statusLabel = computed(() => {
  if (msg.value.status === 'completed') return t('chatUi.groupStatusCompleted')
  if (msg.value.status === 'failed') return t('chatUi.groupStatusFailed')
  if (msg.value.status === 'timeout') return t('chatUi.groupStatusFailed')
  if (msg.value.status === 'rejected') return t('chatUi.groupStatusFailed')
  return t('chatUi.groupStatusRunning')
})
</script>

<template>
  <section class="peer-message-card" :class="msg.status">
    <div class="peer-message-header">
      <span class="peer-message-badge">{{ $t('chatUi.groupPeerLabel') }}</span>
      <span class="peer-message-route">{{ msg.fromAgentName }} → {{ msg.toAgentName }}</span>
      <span class="peer-message-status" :data-status="msg.status">{{ statusLabel }}</span>
    </div>
    <div class="peer-message-exchange">
      <div class="peer-message-turn">
        <div class="peer-message-turn-label">{{ msg.fromAgentName }}</div>
        <div class="markdown-body peer-message-turn-body" v-html="requestHtml" />
      </div>
      <div v-if="msg.response || msg.status !== 'pending'" class="peer-message-turn response">
        <div class="peer-message-turn-label">{{ msg.toAgentName }}</div>
        <div class="markdown-body peer-message-turn-body" v-html="responseHtml" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.peer-message-card {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-2, var(--app-panel));
  color: var(--app-text);
}
.peer-message-card.failed,
.peer-message-card.timeout,
.peer-message-card.rejected {
  border-color: color-mix(in srgb, #b25a1e 40%, var(--app-border));
}
.peer-message-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.peer-message-badge {
  font-size: 0.66em;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--app-accent-strong);
}
.peer-message-route {
  font-size: 0.8em;
  font-weight: 700;
  color: var(--app-text-strong);
}
.peer-message-status {
  font-size: 0.68em;
  color: var(--app-text-muted);
}
.peer-message-status[data-status="completed"] { color: #2f7a4a; }
.peer-message-exchange {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.peer-message-turn {
  padding: 8px 0 0;
  border-top: 1px solid var(--app-border);
}
.peer-message-turn.response {
  border-top-color: color-mix(in srgb, var(--app-accent) 25%, var(--app-border));
}
.peer-message-turn-label {
  font-size: 0.72em;
  font-weight: 700;
  color: var(--app-accent-strong);
  margin-bottom: 4px;
}
.peer-message-turn-body {
  font-size: 0.8em;
  line-height: 1.55;
}
</style>
