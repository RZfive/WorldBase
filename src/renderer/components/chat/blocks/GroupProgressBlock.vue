<script setup lang="ts">
import { computed } from 'vue'
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'group_progress' }>
}>()

const snapshot = computed(() => props.block.snapshot)

const orderedItems = computed(() => {
  const rank: Record<typeof snapshot.value.items[number]['status'], number> = {
    running: 0,
    queued: 1,
    failed: 2,
    completed: 3
  }

  return [...snapshot.value.items].sort((left, right) => {
    const statusDelta = rank[left.status] - rank[right.status]
    if (statusDelta !== 0) return statusDelta
    return left.agentName.localeCompare(right.agentName, 'zh-Hans-CN')
  })
})

function getStatusLabel (status: typeof snapshot.value.status | typeof snapshot.value.items[number]['status']): string {
  if (status === 'running') return '进行中'
  if (status === 'queued') return '排队中'
  if (status === 'failed') return '失败'
  return '已完成'
}

function getProgressPercent (item: typeof snapshot.value.items[number]): number {
  if (item.totalRounds <= 0) return 0
  const completed = Math.min(item.completedRounds, item.totalRounds)
  if (item.status === 'running' && item.currentRound > completed) {
    return Math.min(100, ((completed + 0.5) / item.totalRounds) * 100)
  }
  return Math.min(100, (completed / item.totalRounds) * 100)
}

function getRecentProgressText (item: typeof snapshot.value.items[number]): string {
  const steps = item.progress.slice(-2)
  return steps
    .map(step => step.detail ? `${step.stage}：${step.detail}` : step.stage)
    .join(' / ')
}
</script>

<template>
  <section class="group-progress-card">
    <div class="group-progress-header">
      <div class="group-progress-header-main">
        <span class="group-progress-label">子 Agent 进度</span>
        <h4 class="group-progress-title">{{ snapshot.groupName }}</h4>
        <div class="group-progress-meta">
          <span>状态：{{ getStatusLabel(snapshot.status) }}</span>
          <span>轮次 {{ Math.max(snapshot.activeRound, snapshot.status === 'running' ? 1 : snapshot.totalRounds) }}/{{ snapshot.totalRounds }}</span>
          <span>并发上限 {{ snapshot.maxParallelWorkers }}</span>
          <span>{{ snapshot.items.length }} 个子 Agent</span>
        </div>
        <div v-if="snapshot.request" class="group-progress-request">
          <span class="group-progress-request-label">讨论内容</span>
          <p>{{ snapshot.request }}</p>
        </div>
      </div>

      <div class="group-progress-counters">
        <span class="group-progress-counter running">进行中 {{ snapshot.runningCount }}</span>
        <span class="group-progress-counter queued">排队 {{ snapshot.queuedCount }}</span>
        <span class="group-progress-counter completed">完成 {{ snapshot.completedCount }}</span>
        <span class="group-progress-counter failed">失败 {{ snapshot.failedCount }}</span>
      </div>
    </div>

    <div class="group-progress-list">
      <article
        v-for="item in orderedItems"
        :key="item.id"
        class="group-progress-item"
        :class="item.status"
      >
        <div class="group-progress-item-top">
          <div class="group-progress-item-copy">
            <div class="group-progress-item-name">{{ item.agentName }}</div>
            <div class="group-progress-item-meta">
              第 {{ item.currentRound || 0 }}/{{ item.totalRounds }} 轮 · 已完成 {{ item.completedRounds }} 轮
            </div>
          </div>

          <span class="group-progress-item-status" :class="item.status">{{ getStatusLabel(item.status) }}</span>
        </div>

        <div class="group-progress-track" aria-hidden="true">
          <div class="group-progress-bar" :style="{ width: `${getProgressPercent(item)}%` }" />
        </div>

        <div class="group-progress-stage">
          {{ item.stage }}<span v-if="item.detail"> · {{ item.detail }}</span>
        </div>

        <div v-if="item.summary" class="group-progress-summary">{{ item.summary }}</div>
        <div v-if="item.progress.length > 0" class="group-progress-recent">{{ getRecentProgressText(item) }}</div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.group-progress-card {
  width: 100%;
  padding: 2px 0 0;
  color: var(--app-text);
}

.group-progress-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.group-progress-header-main {
  min-width: 0;
}

.group-progress-label {
  display: inline-flex;
  align-items: center;
  color: #0369a1;
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.group-progress-title {
  margin: 6px 0 0;
  font-size: 0.98rem;
  color: var(--app-text-strong);
}

.group-progress-meta {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--app-text-muted);
  font-size: 0.76rem;
}

.group-progress-counters {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.group-progress-request {
  margin-top: 12px;
  padding: 12px 0 0;
  border-top: 1px solid var(--app-border);
}

.group-progress-request-label {
  display: inline-flex;
  align-items: center;
  color: #0369a1;
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.group-progress-request p {
  margin: 8px 0 0;
  color: var(--app-text);
  font-size: 0.8rem;
  line-height: 1.55;
  white-space: pre-wrap;
}

.group-progress-counter {
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 0.74rem;
  font-weight: 700;
  background: transparent;
  border: 1px solid var(--app-border);
}

.group-progress-counter.running {
  color: #0369a1;
}

.group-progress-counter.queued {
  color: #6b7280;
}

.group-progress-counter.completed {
  color: #0f766e;
}

.group-progress-counter.failed {
  color: #b91c1c;
}

.group-progress-list {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.group-progress-item {
  padding: 13px 0;
  border-top: 1px solid var(--app-border);
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.group-progress-item.running {
  border-top-color: color-mix(in srgb, #0ea5e9 28%, var(--app-border));
}

.group-progress-item.failed {
  border-top-color: color-mix(in srgb, #ef4444 28%, var(--app-border));
}

.group-progress-item.completed {
  border-top-color: color-mix(in srgb, #10b981 26%, var(--app-border));
}

.group-progress-item-top {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: flex-start;
}

.group-progress-item-copy {
  min-width: 0;
}

.group-progress-item-name {
  font-size: 0.84rem;
  font-weight: 700;
  color: var(--app-text-strong);
}

.group-progress-item-meta {
  margin-top: 4px;
  font-size: 0.75rem;
  color: var(--app-text-muted);
}

.group-progress-item-status {
  flex-shrink: 0;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 700;
  background: transparent;
  border: 1px solid var(--app-border);
}

.group-progress-item-status.running {
  color: #0369a1;
}

.group-progress-item-status.queued {
  color: #6b7280;
}

.group-progress-item-status.completed {
  color: #0f766e;
}

.group-progress-item-status.failed {
  color: #b91c1c;
}

.group-progress-track {
  height: 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-border) 64%, transparent);
  overflow: hidden;
}

.group-progress-bar {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #0ea5e9, #22c55e);
  transition: width 180ms ease;
}

.group-progress-stage {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--app-text-strong);
}

.group-progress-summary,
.group-progress-recent {
  font-size: 0.77rem;
  line-height: 1.55;
  color: var(--app-text);
}

.group-progress-recent {
  color: var(--app-text-muted);
}

@media (max-width: 760px) {
  .group-progress-header {
    flex-direction: column;
  }

  .group-progress-counters {
    justify-content: flex-start;
  }
}
</style>
