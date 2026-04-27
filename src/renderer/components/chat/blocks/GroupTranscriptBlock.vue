<script setup lang="ts">
import { computed, ref } from 'vue'
import { renderMarkdown } from '../markdown'
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'group_transcript' }>
}>()

const expanded = ref(false)

const transcript = computed(() => props.block.transcript)
const canExpand = computed(() => {
  return transcript.value.visibility === 'expandable_internal_transcript' && transcript.value.entries.length > 0
})
const summaryHtml = computed(() => renderMarkdown(transcript.value.summary))
const rounds = computed(() => {
  const roundMap = new Map<number, Array<{ id: string; agentName: string; content: string; html: string }>>()

  for (const entry of transcript.value.entries) {
    const bucket = roundMap.get(entry.round) || []
    bucket.push({
      id: entry.id,
      agentName: entry.agentName,
      content: entry.content,
      html: renderMarkdown(entry.content)
    })
    roundMap.set(entry.round, bucket)
  }

  return Array.from(roundMap.entries())
    .sort(([leftRound], [rightRound]) => leftRound - rightRound)
    .map(([round, entries]) => ({ round, entries }))
})

function getAgentAvatar (name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'AI'
  return trimmed.length <= 2 ? trimmed : trimmed.slice(0, 2)
}

function toggleExpanded (): void {
  if (!canExpand.value) return
  expanded.value = !expanded.value
}
</script>

<template>
  <div class="message-event-card group-transcript-card">
    <div class="group-transcript-header">
      <div class="group-transcript-header-main">
        <span class="group-transcript-label">Agent 协作摘要</span>
        <h4 class="group-transcript-title">{{ transcript.groupName }}</h4>
        <div class="group-transcript-meta">
          <span>{{ transcript.roundCount }} 轮</span>
          <span>{{ transcript.entryCount }} 条工作笔记</span>
          <span>{{ canExpand ? '可展开 transcript' : '仅摘要可见' }}</span>
        </div>
      </div>

      <button
        v-if="canExpand"
        class="group-transcript-toggle"
        type="button"
        @click="toggleExpanded"
      >
        {{ expanded ? '收起 transcript' : '展开 transcript' }}
      </button>
    </div>

    <div class="group-transcript-summary markdown-body" v-html="summaryHtml" />

    <div v-if="expanded && canExpand" class="group-transcript-rounds">
      <section
        v-for="round in rounds"
        :key="`${transcript.groupId}-round-${round.round}`"
        class="group-transcript-round"
      >
        <div class="group-transcript-round-header">第 {{ round.round }} 轮</div>

        <article
          v-for="entry in round.entries"
          :key="entry.id"
          class="group-transcript-entry"
        >
          <div class="group-transcript-entry-avatar">{{ getAgentAvatar(entry.agentName) }}</div>
          <div class="group-transcript-entry-bubble">
            <div class="group-transcript-entry-head">
              <div class="group-transcript-entry-agent">{{ entry.agentName }}</div>
              <span class="group-transcript-entry-round">第 {{ round.round }} 轮</span>
            </div>
            <div class="group-transcript-entry-body markdown-body" v-html="entry.html" />
          </div>
        </article>
      </section>
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

.group-transcript-card {
  padding: 14px 16px 16px;
  border-color: color-mix(in srgb, var(--app-accent) 18%, var(--app-border-strong));
}

.group-transcript-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.group-transcript-header-main {
  min-width: 0;
}

.group-transcript-label {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--app-accent-soft);
  color: var(--app-accent-strong);
  font-size: 0.74rem;
  font-weight: 700;
}

.group-transcript-title {
  margin: 10px 0 0;
  font-size: 0.94rem;
  color: var(--app-text-strong);
}

.group-transcript-meta {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--app-text-muted);
  font-size: 0.76rem;
}

.group-transcript-toggle {
  flex-shrink: 0;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text);
  border-radius: 999px;
  padding: 7px 12px;
  cursor: pointer;
  font-size: 0.78rem;
}

.group-transcript-summary {
  margin-top: 12px;
  padding: 12px 13px;
  border-radius: 14px;
  background: var(--app-panel-strong);
}

.group-transcript-rounds {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.group-transcript-round {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.group-transcript-round-header {
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--app-text-strong);
}

.group-transcript-entry {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  gap: 10px;
  align-items: flex-start;
}

.group-transcript-entry-avatar {
  width: 40px;
  height: 40px;
  border-radius: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--app-accent) 18%, var(--app-panel-strong));
  color: var(--app-accent-strong);
  font-size: 0.76rem;
  font-weight: 800;
}

.group-transcript-entry-bubble {
  padding: 12px 13px;
  border-radius: 16px;
  border: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel) 68%, white 32%);
}

.group-transcript-entry-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.group-transcript-entry-agent {
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--app-accent-strong);
}

.group-transcript-entry-round {
  flex-shrink: 0;
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--app-panel-strong);
  color: var(--app-text-muted);
  font-size: 0.7rem;
  font-weight: 700;
}

.group-transcript-entry-body,
.group-transcript-summary {
  color: var(--app-text);
  font-size: 0.82rem;
  line-height: 1.6;
}

@media (max-width: 760px) {
  .group-transcript-header {
    flex-direction: column;
  }

  .group-transcript-toggle {
    width: 100%;
  }

  .group-transcript-entry {
    grid-template-columns: 1fr;
  }
}
</style>
