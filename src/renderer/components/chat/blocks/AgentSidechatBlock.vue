<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '../markdown'
import type { AgentSidechatSession } from '../../../../shared/agent-workspace-types.js'
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'agent_sidechat' }>
}>()

const session = computed(() => props.block.session)
const requestHtml = computed(() => renderMarkdown(session.value.request || '(无请求内容)'))
const responseHtml = computed(() => renderMarkdown(session.value.response || (session.value.status === 'running' ? '处理中…' : '(暂无回复)')))
const recentProgress = computed(() => session.value.progress.slice(-3))

function getStatusLabel (status: AgentSidechatSession['status']): string {
  if (status === 'running') return '进行中'
  if (status === 'failed') return '失败'
  return '已完成'
}

function getModeLabel (mode: AgentSidechatSession['mode']): string {
  if (mode === 'group_deliberation') return '群内分工'
  if (mode === 'coordinator_assigned') return '主 Agent 指派'
  return '用户定向'
}
</script>

<template>
  <div class="message-event-card sidechat-card" :class="session.status">
    <div class="sidechat-header">
      <div class="sidechat-copy">
        <span class="sidechat-label">Agent 单聊</span>
        <h4 class="sidechat-title">{{ session.agentName }}</h4>
        <div class="sidechat-meta">
          <span>{{ getModeLabel(session.mode) }}</span>
          <span>{{ session.initiatedByName }} → {{ session.agentName }} → {{ session.reportToName }}</span>
          <span>第 {{ session.round }} 轮</span>
        </div>
      </div>

      <span class="sidechat-status" :class="session.status">{{ getStatusLabel(session.status) }}</span>
    </div>

    <div class="sidechat-body">
      <section class="sidechat-bubble initiator">
        <div class="sidechat-bubble-title">{{ session.initiatedByName }}</div>
        <div class="markdown-body" v-html="requestHtml" />
      </section>

      <section class="sidechat-bubble agent">
        <div class="sidechat-bubble-title">{{ session.agentName }}</div>
        <div class="markdown-body" v-html="responseHtml" />
      </section>
    </div>

    <div v-if="recentProgress.length > 0 || session.error" class="sidechat-footer">
      <div v-for="(step, index) in recentProgress" :key="`${session.id}-progress-${index}`" class="sidechat-progress-chip">
        {{ step.stage }}<span v-if="step.detail"> · {{ step.detail }}</span>
      </div>
      <div v-if="session.error" class="sidechat-error">{{ session.error }}</div>
    </div>
  </div>
</template>

<style scoped>
.message-event-card {
  width: min(100%, var(--chat-event-card-max, 1080px));
  border: 1px solid var(--app-border-strong);
  border-radius: 18px;
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);
  overflow: hidden;
}

.sidechat-card {
  padding: 14px 16px 16px;
  border-color: color-mix(in srgb, var(--app-accent) 20%, var(--app-border-strong));
}

.sidechat-card.failed {
  border-color: color-mix(in srgb, #ef4444 24%, var(--app-border-strong));
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
  padding: 4px 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent) 12%, var(--app-panel-strong));
  color: var(--app-accent-strong);
  font-size: 0.74rem;
  font-weight: 700;
}

.sidechat-title {
  margin: 10px 0 0;
  font-size: 0.94rem;
  color: var(--app-text-strong);
}

.sidechat-meta {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--app-text-muted);
  font-size: 0.76rem;
}

.sidechat-status {
  flex-shrink: 0;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-strong);
  color: var(--app-text-muted);
  font-size: 0.74rem;
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
  gap: 10px;
}

.sidechat-bubble {
  padding: 12px 13px;
  border-radius: 16px;
  border: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel) 70%, white 30%);
}

.sidechat-bubble.agent {
  background: color-mix(in srgb, var(--app-accent-soft) 28%, var(--app-panel));
}

.sidechat-bubble-title {
  margin-bottom: 8px;
  font-size: 0.78rem;
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
  padding: 6px 10px;
  border-radius: 999px;
  background: var(--app-panel-strong);
  border: 1px solid var(--app-border);
  font-size: 0.74rem;
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
