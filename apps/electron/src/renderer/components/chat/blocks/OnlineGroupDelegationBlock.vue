<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'online_group_delegation' }>
}>()

const { t } = useI18n()
const delegation = computed(() => props.block.delegation)
const active = computed(() => (
  delegation.value.status === 'pending_owner_approval'
  || delegation.value.status === 'approved'
  || delegation.value.status === 'running'
))
const statusLabel = computed(() => {
  switch (delegation.value.status) {
    case 'pending_owner_approval':
      return props.block.ownerName
        ? t('onlineGroups.delegationWaitingOwner', { name: props.block.ownerName })
        : t('onlineGroups.delegationStatus.pending_owner_approval')
    case 'approved':
      return t('onlineGroups.delegationStarting')
    case 'running':
      return t('onlineGroups.delegationThinking')
    case 'failed':
      return t('onlineGroups.delegationStatus.failed')
    case 'rejected':
      return t('onlineGroups.delegationStatus.rejected')
    default:
      return t('onlineGroups.delegationStatus.completed')
  }
})
const sourceLabel = computed(() => {
  if (delegation.value.fromAgentName) {
    return t('onlineGroups.delegationFrom', {
      name: `${delegation.value.fromAgentName} · ${delegation.value.fromName}`
    })
  }
  return t('onlineGroups.delegationFrom', { name: delegation.value.fromName })
})
</script>

<template>
  <section
    class="online-delegation-card"
    :class="[delegation.status, { active }]"
    :data-status="delegation.status"
  >
    <span class="online-delegation-avatar" aria-hidden="true">{{ block.targetIcon || '🤖' }}</span>
    <div class="online-delegation-copy">
      <div class="online-delegation-heading">
        <strong>{{ delegation.toAgentName }}</strong>
        <span class="online-delegation-status">
          <span class="online-delegation-dot" aria-hidden="true" />
          {{ statusLabel }}
        </span>
      </div>
      <p>{{ delegation.task }}</p>
      <small>{{ sourceLabel }}</small>
      <small v-if="delegation.error" class="online-delegation-error">{{ delegation.error }}</small>
    </div>
  </section>
</template>

<style scoped>
.online-delegation-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  max-width: 620px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--app-border) 88%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-panel-muted) 62%, transparent);
  color: var(--app-text);
}
.online-delegation-card.active {
  border-color: color-mix(in srgb, var(--app-accent) 32%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 48%, var(--app-panel));
}
.online-delegation-card.failed,
.online-delegation-card.rejected {
  border-color: color-mix(in srgb, var(--app-danger, #d33d49) 36%, var(--app-border));
}
.online-delegation-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  background: var(--app-panel);
  font-size: 15px;
}
.online-delegation-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}
.online-delegation-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.online-delegation-heading strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.76rem;
  color: var(--app-text-strong);
}
.online-delegation-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  color: var(--app-text-muted);
  font-size: 0.66rem;
}
.online-delegation-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.online-delegation-card.active .online-delegation-status {
  color: var(--app-accent-strong);
}
.online-delegation-card.active .online-delegation-dot {
  animation: online-delegation-pulse 1.4s ease-in-out infinite;
}
.online-delegation-card.failed .online-delegation-status,
.online-delegation-card.rejected .online-delegation-status {
  color: var(--app-danger, #d33d49);
}
.online-delegation-copy p {
  margin: 0;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  color: var(--app-text-soft);
  font-size: 0.72rem;
  line-height: 1.5;
}
.online-delegation-copy small {
  color: var(--app-text-faint);
  font-size: 0.63rem;
}
.online-delegation-copy small.online-delegation-error {
  color: var(--app-danger, #d33d49);
}
@keyframes online-delegation-pulse {
  0%, 100% { opacity: 0.45; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1.08); }
}
</style>
