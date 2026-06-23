<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderMarkdown } from '../markdown'
import type { AgentSidechatSession } from '../../../../shared/agent-workspace-types.js'
import type { ChatMessageBlock } from '../types'
import { formatProgressEntry } from '../progress-i18n'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'agent_sidechat' }>
}>()

const { t } = useI18n()
const session = computed(() => props.block.session)
const requestHtml = computed(() => renderMarkdown(session.value.request || t('chatUi.agentSidechatNoRequest')))
const responseHtml = computed(() => renderMarkdown(session.value.response || (session.value.status === 'running' ? t('chatUi.agentSidechatProcessing') : t('chatUi.agentSidechatNoReply'))))
const recentProgress = computed(() => session.value.progress.slice(-3))

function getStatusLabel (status: AgentSidechatSession['status']): string {
  if (status === 'running') return t('chatUi.groupStatusRunning')
  if (status === 'failed') return t('chatUi.groupStatusFailed')
  return t('chatUi.groupStatusCompleted')
}

function getModeLabel (mode: AgentSidechatSession['mode']): string {
  if (mode === 'group_deliberation') return t('chatUi.agentSidechatModeGroup')
  if (mode === 'coordinator_assigned') return t('chatUi.agentSidechatModeCoordinator')
  return t('chatUi.agentSidechatModeUser')
}

function getProgressText (step: AgentSidechatSession['progress'][number]): string {
  return formatProgressEntry(step, t, t('chatUi.progressDotSeparator'))
}
</script>

<template>
  <section class="sidechat-card" :class="session.status">
    <div class="sidechat-header">
      <div class="sidechat-copy">
        <span class="sidechat-label">{{ $t('chatUi.agentSidechatLabel') }}</span>
        <h4 class="sidechat-title">{{ session.agentName }}</h4>
        <div class="sidechat-meta">
          <span>{{ getModeLabel(session.mode) }}</span>
          <span>{{ session.initiatedByName }} → {{ session.agentName }} → {{ session.reportToName }}</span>
          <span>{{ $t('chatUi.groupRoundTitle', { round: session.round }) }}</span>
        </div>
      </div>

      <span class="sidechat-status" :class="session.status">{{ getStatusLabel(session.status) }}</span>
    </div>

    <div class="sidechat-body">
      <section class="sidechat-entry initiator">
        <div class="sidechat-entry-title">{{ session.initiatedByName }}</div>
        <div class="markdown-body" v-html="requestHtml" />
      </section>

      <section class="sidechat-entry agent">
        <div class="sidechat-entry-title">{{ session.agentName }}</div>
        <div class="markdown-body" v-html="responseHtml" />
      </section>
    </div>

    <div v-if="recentProgress.length > 0 || session.error" class="sidechat-footer">
      <div v-for="(step, index) in recentProgress" :key="`${session.id}-progress-${index}`" class="sidechat-progress-chip">
        {{ getProgressText(step) }}
      </div>
      <div v-if="session.error" class="sidechat-error">{{ session.error }}</div>
    </div>
  </section>
</template>

<style scoped>
.sidechat-card {
  width: 100%;
  padding: 2px 0 0;
  color: var(--app-text);
}

.sidechat-card.failed {
  color: var(--app-text);
}

.sidechat-header {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  align-items: flex-start;
}

.sidechat-copy {
  min-width: 0;
}

.sidechat-label {
  display: inline-flex;
  align-items: center;
  color: var(--app-accent-strong);
  font-size: 0.72em;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.sidechat-title {
  margin: 6px 0 0;
  font-size: 0.98em;
  color: var(--app-text-strong);
}

.sidechat-meta {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--app-text-muted);
  font-size: 0.76em;
}

.sidechat-status {
  flex-shrink: 0;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--app-border);
  background: transparent;
  color: var(--app-text-muted);
  font-size: 0.72em;
  font-weight: 700;
}

.sidechat-status.running {
  color: #0369a1;
}

.sidechat-status.completed {
  color: #0f766e;
}

.sidechat-status.failed {
  color: #b91c1c;
}

.sidechat-body {
  margin-top: 12px;
  display: grid;
  gap: 12px;
}

.sidechat-entry {
  padding: 12px 0 0;
  border-top: 1px solid var(--app-border);
}

.sidechat-entry.agent {
  border-top-color: color-mix(in srgb, var(--app-accent) 20%, var(--app-border));
}

.sidechat-entry-title {
  margin-bottom: 8px;
  font-size: 0.78em;
  font-weight: 700;
  color: var(--app-text-strong);
}

.sidechat-footer {
  margin-top: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.sidechat-progress-chip,
.sidechat-error {
  padding: 3px 9px;
  border-radius: 999px;
  background: transparent;
  border: 1px solid var(--app-border);
  font-size: 0.74em;
  color: var(--app-text-muted);
}

.sidechat-error {
  color: #b91c1c;
}

@media (max-width: 760px) {
  .sidechat-header {
    flex-direction: column;
  }
}
</style>
