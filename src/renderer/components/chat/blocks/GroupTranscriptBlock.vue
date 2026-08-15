<script setup lang="ts">
import { computed, ref } from 'vue'
import { renderMarkdown } from '../markdown'
import type { AgentGroupTranscriptEntry } from '../../../../shared/agent-workspace-types.js'
import type { ChatMessageBlock } from '../types'

type EnrichedEntry = AgentGroupTranscriptEntry & { html: string }

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
  const roundMap = new Map<number, EnrichedEntry[]>()

  for (const entry of transcript.value.entries) {
    const bucket = roundMap.get(entry.round) || []
    bucket.push({
      ...entry,
      html: renderMarkdown(entry.content)
    })
    roundMap.set(entry.round, bucket)
  }

  return Array.from(roundMap.entries())
    .sort(([leftRound], [rightRound]) => leftRound - rightRound)
    .map(([round, entries]) => ({ round, entries }))
})

function toggleExpanded (): void {
  if (!canExpand.value) return
  expanded.value = !expanded.value
}
</script>

<template>
  <section class="group-transcript-card">
    <div class="group-transcript-header">
      <div class="group-transcript-header-main">
        <span class="group-transcript-label">{{ $t('chatUi.groupTranscriptLabel') }}</span>
        <h4 class="group-transcript-title">{{ transcript.groupName }}</h4>
        <div class="group-transcript-meta">
          <span>{{ $t('chatUi.groupRoundCount', { count: transcript.roundCount }) }}</span>
          <span>{{ $t('chatUi.groupWorkNoteCount', { count: transcript.entryCount }) }}</span>
          <span>{{ canExpand ? $t('chatUi.groupTranscriptExpandable') : $t('chatUi.groupTranscriptSummaryOnly') }}</span>
        </div>
        <div v-if="transcript.request" class="group-transcript-request">
          <span class="group-transcript-request-label">{{ $t('chatUi.groupDiscussionContent') }}</span>
          <p>{{ transcript.request }}</p>
        </div>
      </div>

      <button
        v-if="canExpand"
        class="group-transcript-toggle"
        type="button"
        @click="toggleExpanded"
      >
        {{ expanded ? $t('chatUi.groupCollapseTranscript') : $t('chatUi.groupExpandTranscript') }}
      </button>
    </div>

    <div class="group-transcript-summary markdown-body" v-html="summaryHtml" />

    <div v-if="expanded && canExpand" class="group-transcript-rounds">
      <section
        v-for="round in rounds"
        :key="`${transcript.groupId}-round-${round.round}`"
        class="group-transcript-round"
      >
        <div class="group-transcript-round-header">{{ $t('chatUi.groupRoundTitle', { round: round.round }) }}</div>

        <article
          v-for="entry in round.entries"
          :key="entry.id"
          class="group-transcript-entry"
          :class="{ 'direct-reply': entry.directReply }"
        >
          <div class="group-transcript-entry-head">
            <div class="group-transcript-entry-agent">{{ entry.agentName }}</div>
            <span v-if="entry.directReply" class="group-transcript-entry-tag direct">{{ $t('chatUi.groupDirectReplyLabel') }}</span>
            <span v-if="entry.boardFields && entry.boardFields.length" class="group-transcript-entry-tag board">{{ entry.boardFields.join(', ') }}</span>
            <span class="group-transcript-entry-round">{{ $t('chatUi.groupRoundTitle', { round: round.round }) }}</span>
          </div>
          <div class="group-transcript-entry-body markdown-body" v-html="entry.html" />
          <div v-if="entry.toolCalls && entry.toolCalls.length" class="group-transcript-tools">
            <span class="group-transcript-tools-label">{{ $t('chatUi.groupTranscriptTools') }}</span>
            <span v-for="(tool, index) in entry.toolCalls" :key="`tool-${entry.id}-${index}`" class="group-transcript-tool-chip" :data-status="tool.status">{{ tool.name }}</span>
          </div>
          <div v-if="entry.peerMessages && entry.peerMessages.length" class="group-transcript-peers">
            <div v-for="(peer, index) in entry.peerMessages" :key="`peer-${entry.id}-${index}`" class="group-transcript-peer">
              <span class="group-transcript-peer-route">-> {{ peer.toAgentName }}</span>
              <span class="group-transcript-peer-request">{{ peer.request }}</span>
            </div>
          </div>
        </article>
      </section>
    </div>
  </section>
</template>

<style scoped>
.group-transcript-card {
  width: 100%;
  padding: 2px 0 0;
  color: var(--app-text);
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
  color: var(--app-accent-strong);
  font-size: 0.72em;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.group-transcript-title {
  margin: 6px 0 0;
  font-size: 0.98em;
  color: var(--app-text-strong);
}

.group-transcript-meta {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--app-text-muted);
  font-size: 0.76em;
}

.group-transcript-toggle {
  flex-shrink: 0;
  border: 1px solid var(--app-border);
  background: transparent;
  color: var(--app-text);
  border-radius: 999px;
  padding: 5px 11px;
  cursor: pointer;
  font-size: 0.78em;
}

.group-transcript-summary {
  margin-top: 12px;
  padding: 12px 0 0;
  border-top: 1px solid color-mix(in srgb, var(--app-accent) 20%, var(--app-border));
}

.group-transcript-request {
  margin-top: 12px;
  padding: 12px 0 0;
  border-top: 1px solid var(--app-border);
}

.group-transcript-request-label {
  display: inline-flex;
  align-items: center;
  color: var(--app-accent-strong);
  font-size: 0.72em;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.group-transcript-request p {
  margin: 8px 0 0;
  color: var(--app-text);
  font-size: 0.8em;
  line-height: 1.55;
  white-space: pre-wrap;
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
  font-size: 0.82em;
  font-weight: 700;
  color: var(--app-text-strong);
}

.group-transcript-entry {
  padding: 12px 0 0;
  border-top: 1px solid var(--app-border);
}

.group-transcript-entry.direct-reply {
  border-top-color: color-mix(in srgb, var(--app-accent) 30%, var(--app-border));
}

.group-transcript-entry-head {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.group-transcript-entry-tag {
  font-size: 0.64em;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  letter-spacing: 0.04em;
}

.group-transcript-entry-tag.direct {
  background: color-mix(in srgb, var(--app-accent) 15%, transparent);
  color: var(--app-accent-strong);
}

.group-transcript-entry-tag.board {
  background: var(--app-border);
  color: var(--app-text-muted);
}

.group-transcript-tools {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.group-transcript-tools-label {
  font-size: 0.66em;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--app-text-muted);
}

.group-transcript-tool-chip {
  font-family: var(--app-mono, monospace);
  font-size: 0.68em;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--app-border);
  color: var(--app-text);
}

.group-transcript-tool-chip[data-status="failed"] {
  border-color: #b25a1e;
  color: #b25a1e;
}

.group-transcript-peers {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.group-transcript-peer {
  font-size: 0.74em;
  color: var(--app-text-muted);
  display: flex;
  gap: 6px;
  align-items: baseline;
}

.group-transcript-peer-route {
  font-weight: 700;
  color: var(--app-accent-strong);
  flex-shrink: 0;
}

.group-transcript-peer-request {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-transcript-entry-agent {
  font-size: 0.78em;
  font-weight: 700;
  color: var(--app-accent-strong);
}

.group-transcript-entry-round {
  flex-shrink: 0;
  color: var(--app-text-muted);
  font-size: 0.7em;
  font-weight: 700;
}

.group-transcript-entry-body,
.group-transcript-summary {
  color: var(--app-text);
  font-size: 0.82em;
  line-height: 1.6;
}

.group-transcript-summary :deep(img),
.group-transcript-entry-body :deep(img) {
  display: block;
  width: auto;
  max-width: min(100%, 420px);
  max-height: 420px;
  margin-top: 10px;
  border-radius: 12px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel);
  object-fit: contain;
}

@media (max-width: 760px) {
  .group-transcript-header {
    flex-direction: column;
  }

  .group-transcript-toggle {
    width: 100%;
  }
}
</style>
