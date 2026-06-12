<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '../markdown'
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'group_collaboration_plan' }>
}>()

const plan = computed(() => props.block.plan)
const originalRequestHtml = computed(() => renderMarkdown(plan.value.originalRequest || '(无请求内容)'))
const normalizedRequestHtml = computed(() => renderMarkdown(plan.value.normalizedRequest || '(无执行摘要)'))

function getPhaseLabel (phase: typeof plan.value.phase): string {
  if (phase === 'planning') return '协作规划中'
  if (phase === 'executing') return '协作执行中'
  return '协作已完成'
}

function getModeLabel (mode: typeof plan.value.mode): string {
  if (mode === 'coordinator_only') return '协调者独立处理'
  if (mode === 'coordinator_decides') return '主 Agent 决定是否拉群'
  if (mode === 'mentioned_agent_decides') return '被点名成员决定是否拉人'
  if (mode === 'discussion') return '群组讨论'
  return '定向回复'
}

function getParticipantKey (agentId: string, index: number): string {
  return `${agentId}_${index}`
}
</script>

<template>
  <section class="collaboration-plan-card">
    <div class="collaboration-plan-header">
      <div class="collaboration-plan-header-main">
        <span class="collaboration-plan-label">协作计划</span>
        <h4 class="collaboration-plan-title">{{ plan.groupName }}</h4>
        <div class="collaboration-plan-meta">
          <span>{{ getModeLabel(plan.mode) }}</span>
          <span>{{ getPhaseLabel(plan.phase) }}</span>
          <span>决策人：{{ plan.planner.agentName }}</span>
          <span>汇总到：{{ plan.reportToName }}</span>
          <span v-if="plan.round">第 {{ plan.round }} 轮</span>
        </div>
      </div>
    </div>

    <div class="collaboration-plan-reason markdown-body" v-html="renderMarkdown(plan.reason)" />

    <div class="collaboration-plan-requests">
      <section class="collaboration-plan-request-card">
        <div class="collaboration-plan-request-title">原始请求</div>
        <div class="markdown-body" v-html="originalRequestHtml" />
      </section>

      <section v-if="plan.normalizedRequest && plan.normalizedRequest !== plan.originalRequest" class="collaboration-plan-request-card normalized">
        <div class="collaboration-plan-request-title">执行摘要</div>
        <div class="markdown-body" v-html="normalizedRequestHtml" />
      </section>
    </div>

    <div class="collaboration-plan-sections">
      <section class="collaboration-plan-section">
        <div class="collaboration-plan-section-title">用户点名</div>
        <div v-if="plan.mentionedParticipants.length > 0" class="collaboration-plan-chip-list">
          <span v-for="(participant, index) in plan.mentionedParticipants" :key="getParticipantKey(participant.agentId, index)" class="collaboration-plan-chip mention">
            {{ participant.agentName }}
          </span>
        </div>
        <p v-else class="collaboration-plan-empty">未点名具体成员，按群组规则决定范围。</p>
      </section>

      <section class="collaboration-plan-section">
        <div class="collaboration-plan-section-title">候选协作者</div>
        <div v-if="plan.candidateParticipants.length > 0" class="collaboration-plan-chip-list">
          <span v-for="(participant, index) in plan.candidateParticipants" :key="getParticipantKey(participant.agentId, index)" class="collaboration-plan-chip candidate">
            {{ participant.agentName }}
          </span>
        </div>
        <p v-else class="collaboration-plan-empty">当前没有额外候选协作者。</p>
      </section>

      <section class="collaboration-plan-section">
        <div class="collaboration-plan-section-title">当前邀请</div>
        <div v-if="plan.invitedParticipants.length > 0" class="collaboration-plan-chip-list">
          <span v-for="(participant, index) in plan.invitedParticipants" :key="getParticipantKey(participant.agentId, index)" class="collaboration-plan-chip invited">
            {{ participant.agentName }}
          </span>
        </div>
        <p v-else class="collaboration-plan-empty">暂未扩群，先由 {{ plan.planner.agentName }} 判断是否需要其他成员加入。</p>
      </section>
    </div>
  </section>
</template>

<style scoped>
.collaboration-plan-card {
  width: 100%;
  padding: 2px 0 0;
  color: var(--app-text);
}

.collaboration-plan-header-main {
  min-width: 0;
}

.collaboration-plan-label {
  display: inline-flex;
  align-items: center;
  color: var(--app-accent-strong);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.collaboration-plan-title {
  margin: 6px 0 0;
  font-size: 0.98rem;
  color: var(--app-text-strong);
}

.collaboration-plan-meta {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--app-text-muted);
  font-size: 0.76rem;
}

.collaboration-plan-reason {
  margin-top: 12px;
  padding: 12px 0 0;
  border-top: 1px solid color-mix(in srgb, var(--app-accent) 20%, var(--app-border));
}

.collaboration-plan-requests {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}

.collaboration-plan-request-card {
  padding: 12px 0 0;
  border-top: 1px solid var(--app-border);
}

.collaboration-plan-request-card.normalized {
  border-top-color: color-mix(in srgb, #0ea5e9 20%, var(--app-border));
}

.collaboration-plan-request-title,
.collaboration-plan-section-title {
  font-size: 0.76rem;
  font-weight: 700;
  color: var(--app-text-strong);
}

.collaboration-plan-sections {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.collaboration-plan-section {
  padding: 12px 0 0;
  border-top: 1px solid var(--app-border);
}

.collaboration-plan-chip-list {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.collaboration-plan-chip {
  display: inline-flex;
  align-items: center;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 0.74rem;
  font-weight: 700;
  border: 1px solid var(--app-border);
  background: transparent;
  color: var(--app-text);
}

.collaboration-plan-chip.mention {
  color: #7c2d12;
}

.collaboration-plan-chip.candidate {
  color: #334155;
}

.collaboration-plan-chip.invited {
  color: #0369a1;
}

.collaboration-plan-empty {
  margin: 10px 0 0;
  color: var(--app-text-muted);
  font-size: 0.78rem;
  line-height: 1.5;
}
</style>
