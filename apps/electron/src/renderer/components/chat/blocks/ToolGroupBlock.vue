<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AnnotationAnchor, ChatMessageBlock, MessageAnnotation } from '../types'
import {
  collapseWhitespace,
  deriveWorkGroupStatus,
  formatElapsedDuration,
  getContentText,
  getToolRunDisplayName,
  type WorkGroupToolCounts
} from '../message-utils'
import type { WorkBurstEntry } from '../message-segments'
import { formatProgressEntry } from '../progress-i18n'
import ExecutionDisclosure from './ExecutionDisclosure.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolRunBlock from './ToolRunBlock.vue'
import WebSearchBlock from './WebSearchBlock.vue'
import WebFetchBlock from './WebFetchBlock.vue'
import FilePreviewBlock from './FilePreviewBlock.vue'
import ContentBlock from './ContentBlock.vue'
import WorkActivityTicker from './WorkActivityTicker.vue'

type ThinkingBlockModel = Extract<ChatMessageBlock, { kind: 'thinking' }>
type ToolBlockModel = Extract<ChatMessageBlock, { kind: 'tool' }>
type WebSearchBlockModel = Extract<ChatMessageBlock, { kind: 'web_search' }>
type WebFetchBlockModel = Extract<ChatMessageBlock, { kind: 'web_fetch' }>
type FilePreviewBlockModel = Extract<ChatMessageBlock, { kind: 'file_preview' }>
type ContentBlockModel = Extract<ChatMessageBlock, { kind: 'content' }>
type GroupBlock = ThinkingBlockModel | ToolBlockModel | WebSearchBlockModel | WebFetchBlockModel | FilePreviewBlockModel | ContentBlockModel

const props = withDefaults(defineProps<{
  /** Work-summary members with their original block index (for image/annotation anchoring). */
  entries: WorkBurstEntry[]
  /** Whether the owning message is the currently streaming one. */
  messageStreaming?: boolean
  role?: string
  messageIndex?: number
  messageText?: string
  annotations?: MessageAnnotation[]
}>(), {
  messageStreaming: false,
  role: 'assistant',
  messageIndex: -1,
  messageText: '',
  annotations: undefined
})

const emit = defineEmits<{
  (e: 'openLightbox', messageIndex: number, blockIndex: number, partIndex: number): void
  (e: 'openMermaidPreview', code: string): void
  (e: 'removeAnnotation', annotationId: string): void
  (e: 'openAnnotationThread', payload: { annotationId: string; anchor: AnnotationAnchor }): void
  (e: 'openFilePath', filePath: string): void
}>()

const { t } = useI18n()

// Codex-style work summary: consecutive thinking + tool + web result runs —
// plus the narration between tool calls — collapse into ONE row — live
// seconds while working, frozen total once settled — expanding to the full
// trace (narration paragraphs, thinking pills, per-tool rows and web result
// cards) underneath. The collapsed row's only live signal is the activity
// ticker: the current tool call or the streaming narration text.
const MAX_ACTIVITY_TEXT_LENGTH = 320

// The parent only marks the trailing group of the streaming message as live,
// so the whole final work row keeps its live timer until the turn settles.
const isActive = computed(() => props.messageStreaming && props.entries.length > 0)

// Status counts drive the summary color: one failed call inside a large
// successful turn must not paint the whole trace red (see
// `deriveWorkGroupStatus`). The row intentionally shows no failure count;
// expanded tool rows keep their own per-call status.
const toolCounts = computed<WorkGroupToolCounts>(() => {
  const counts: WorkGroupToolCounts = { running: 0, completed: 0, failed: 0 }
  for (const { block } of props.entries) {
    if (block.kind !== 'tool') continue
    if (block.toolRun.status === 'running') counts.running += 1
    else if (block.toolRun.status === 'failed') counts.failed += 1
    else counts.completed += 1
  }
  return counts
})

const nowTick = ref(Date.now())
let tickTimer: number | null = null

watch(isActive, (active) => {
  if (active && tickTimer == null) {
    nowTick.value = Date.now()
    tickTimer = window.setInterval(() => {
      nowTick.value = Date.now()
    }, 1000)
  } else if (!active && tickTimer != null) {
    window.clearInterval(tickTimer)
    tickTimer = null
  }
}, { immediate: true })

onBeforeUnmount(() => {
  if (tickTimer != null) {
    window.clearInterval(tickTimer)
    tickTimer = null
  }
})

function getBlockStartedAt (block: GroupBlock): number | undefined {
  if (block.kind === 'tool') return block.toolRun.startedAt
  if (block.kind === 'thinking') return block.startedAt
  if (block.kind === 'content') return block.startedAt
  return undefined
}

function getBlockEndedAt (block: GroupBlock): number | undefined {
  if (block.kind === 'tool') return block.toolRun.endedAt
  if (block.kind === 'thinking') return block.endedAt
  return undefined
}

const elapsedLabel = computed(() => {
  const startedValues = props.entries
    .map(({ block }) => getBlockStartedAt(block))
    .filter((value): value is number => typeof value === 'number')
  const endedValues = props.entries
    .map(({ block }) => getBlockEndedAt(block))
    .filter((value): value is number => typeof value === 'number')

  if (startedValues.length === 0) return ''
  const startedAt = Math.min(...startedValues)

  let seconds: number
  if (isActive.value) {
    seconds = (nowTick.value - startedAt) / 1000
  } else {
    const endedAt = endedValues.length > 0 ? Math.max(...endedValues) : null
    if (endedAt == null || endedAt < startedAt) return ''
    seconds = (endedAt - startedAt) / 1000
  }
  if (seconds < 1) return ''
  return formatElapsedDuration(seconds, t)
})

function toolLabel (block: ToolBlockModel): string {
  const display = getToolRunDisplayName(block.toolRun.name)
  const summary = block.toolRun.summary?.trim()
  if (summary) return `${display} · ${summary}`
  const latestProgress = block.toolRun.progress[block.toolRun.progress.length - 1]
  if (latestProgress) {
    const progressText = formatProgressEntry(latestProgress, t, ' · ')
    if (progressText) return progressText
  }
  return display
}

// Collapsed-row activity: the running call first, then the freshest narration,
// then the most recent settled action. Streaming text is capped so a long
// paragraph does not force a giant marquee.
const activityText = computed(() => {
  for (let index = props.entries.length - 1; index >= 0; index -= 1) {
    const block = props.entries[index].block
    if (block.kind === 'tool' && block.toolRun.status === 'running') return toolLabel(block)
  }

  const lastBlock = props.entries[props.entries.length - 1]?.block
  if (lastBlock?.kind === 'thinking' && lastBlock.endedAt == null) {
    return t('chatUi.thinkingStreaming')
  }

  for (let index = props.entries.length - 1; index >= 0; index -= 1) {
    const block = props.entries[index].block
    if (block.kind !== 'content') continue
    const text = collapseWhitespace(getContentText(block.content)).trim()
    if (!text) continue
    if (text.length <= MAX_ACTIVITY_TEXT_LENGTH) return text
    // Live output must keep moving after it passes the cap; settled rows read
    // better from the beginning of the narration.
    return isActive.value
      ? `…${text.slice(-MAX_ACTIVITY_TEXT_LENGTH)}`
      : `${text.slice(0, MAX_ACTIVITY_TEXT_LENGTH)}…`
  }

  for (let index = props.entries.length - 1; index >= 0; index -= 1) {
    const block = props.entries[index].block
    if (block.kind === 'thinking' || block.kind === 'content') continue
    if (block.kind === 'web_search') return `${t('chatUi.toolVerbWebSearch')} ${block.query}`.trim()
    if (block.kind === 'web_fetch') return `${t('chatUi.toolVerbFetch')} ${block.result.url || block.query || ''}`.trim()
    if (block.kind === 'file_preview') return `${t('chatUi.toolVerbWrite')} ${block.filePath}`.trim()
    return toolLabel(block)
  }

  return isActive.value ? t('chatUi.toolStatusRunning') : ''
})

const statusClass = computed(() => {
  if (isActive.value) return 'running' as const
  return deriveWorkGroupStatus(toolCounts.value)
})

// Historical conversations must open with every summary collapsed — a stored
// failure should not turn every old conversation into a wall of open traces.
// While the message is actively streaming, a fresh failure still pops the
// group open once so the error is seen as it happens.
const shouldAutoExpand = computed(() => {
  return props.messageStreaming &&
    props.entries.some(({ block }) => block.kind === 'tool' && block.toolRun.status === 'failed')
})

// Inner thinking blocks manage their own collapse locally — the shared
// collapsedThinking map in the parent only knows top-level block ids.
const localCollapsed = ref<Record<string, boolean>>({})

function isThinkingCollapsed (block: ThinkingBlockModel): boolean {
  return localCollapsed.value[block.id] !== false
}

function toggleThinking (blockId: string): void {
  localCollapsed.value[blockId] = !isThinkingCollapsedById(blockId)
}

function isThinkingCollapsedById (blockId: string): boolean {
  return localCollapsed.value[blockId] !== false
}

function isInnerThinkingStreaming (block: ThinkingBlockModel, index: number): boolean {
  if (!props.messageStreaming) return false
  if (block.endedAt != null) return false
  return index === props.entries.length - 1
}

function isInnerContentStreaming (block: ContentBlockModel, index: number): boolean {
  return props.messageStreaming && block.kind === 'content' && index === props.entries.length - 1
}
</script>

<template>
  <ExecutionDisclosure
    :title="elapsedLabel ? $t('chatUi.workingElapsed', { time: elapsedLabel }) : $t('chatUi.workSummaryShort')"
    :status="statusClass"
    :default-expanded="shouldAutoExpand"
    class="tool-group"
  >
    <template #meta>
      <span v-if="activityText" class="tool-group-ticker-sep" aria-hidden="true">·</span>
      <WorkActivityTicker class="tool-group-ticker" :text="activityText" :active="isActive" />
    </template>

    <div class="tool-group-body">
      <template v-for="(entry, index) in props.entries" :key="entry.block.id">
        <ThinkingBlock
          v-if="entry.block.kind === 'thinking'"
          :block="entry.block"
          :is-streaming="isInnerThinkingStreaming(entry.block, index)"
          :is-collapsed="isThinkingCollapsed(entry.block)"
          class="tool-group-item"
          @toggle="toggleThinking(entry.block.id)"
        />
        <WebSearchBlock
          v-else-if="entry.block.kind === 'web_search'"
          :block="entry.block"
          class="tool-group-item"
        />
        <WebFetchBlock
          v-else-if="entry.block.kind === 'web_fetch'"
          :block="entry.block"
          class="tool-group-item"
        />
        <FilePreviewBlock
          v-else-if="entry.block.kind === 'file_preview'"
          :block="entry.block"
          class="tool-group-item"
        />
        <!-- ContentBlock has a fragment root (output + teleport), so it cannot
             inherit the narration class directly; wrap it to keep the muted
             trace styling. -->
        <div
          v-else-if="entry.block.kind === 'content'"
          class="tool-group-item tool-group-narration"
        >
          <ContentBlock
            :block="entry.block"
            :role="role"
            :message-index="messageIndex"
            :block-index="entry.blockIndex"
            :is-streaming-block="isInnerContentStreaming(entry.block, index)"
            :message-text="messageText"
            :annotations="annotations"
            @open-lightbox="(mi, bi, pi) => emit('openLightbox', mi, bi, pi)"
            @open-mermaid-preview="(code) => emit('openMermaidPreview', code)"
            @remove-annotation="(annotationId) => emit('removeAnnotation', annotationId)"
            @open-annotation-thread="(payload) => emit('openAnnotationThread', payload)"
          />
        </div>
        <ToolRunBlock
          v-else
          :block="entry.block"
          class="tool-group-item"
          @open-file-path="filePath => emit('openFilePath', filePath)"
        />
      </template>
    </div>
  </ExecutionDisclosure>
</template>

<style scoped>
.tool-group-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tool-group-item {
  margin: 0;
}

.tool-group-ticker-sep {
  flex: 0 0 auto;
  color: var(--app-text-faint);
}

.tool-group-ticker {
  flex: 1 1 auto;
  min-width: 0;
}

/* Narration folded into the trace reads as commentary, not as the answer —
   keep it visually quieter than the trailing content block outside. */
.tool-group-narration {
  font-size: 0.92em;
  color: var(--app-text-muted);
}

/* Narration snippets are not standalone answers; per-paragraph export
   actions would clutter the expanded trace. */
.tool-group-narration :deep(.message-export-bar) {
  display: none;
}
</style>
