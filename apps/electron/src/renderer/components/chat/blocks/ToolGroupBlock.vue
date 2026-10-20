<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AnnotationAnchor, ChatMessageBlock, MessageAnnotation } from '../types'
import { deriveWorkGroupStatus, formatElapsedDuration, type WorkGroupToolCounts } from '../message-utils'
import type { WorkBurstEntry } from '../message-segments'
import ExecutionDisclosure from './ExecutionDisclosure.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolRunBlock from './ToolRunBlock.vue'
import WebSearchBlock from './WebSearchBlock.vue'
import WebFetchBlock from './WebFetchBlock.vue'
import FilePreviewBlock from './FilePreviewBlock.vue'
import ContentBlock from './ContentBlock.vue'

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
// cards) underneath.

const hasRunningTool = computed(() => {
  return props.entries.some(({ block }) => block.kind === 'tool' && block.toolRun.status === 'running')
})

const hasActiveFilePreview = computed(() => {
  return props.entries.some(({ block }) => block.kind === 'file_preview' && block.active)
})

const hasOpenThinking = computed(() => {
  return props.entries.some(({ block }) => block.kind === 'thinking' && block.endedAt == null)
})

const isActive = computed(() => props.messageStreaming && (hasRunningTool.value || hasActiveFilePreview.value || hasOpenThinking.value))

// Status counts drive the summary color: one failed call inside a large
// successful turn must not paint the whole trace red (see
// `deriveWorkGroupStatus`). The failure count is shown as its own badge.
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

const hasFailedTool = computed(() => toolCounts.value.failed > 0)

const failureLabel = computed(() => {
  return hasFailedTool.value ? t('chatUi.toolFailuresCount', { count: toolCounts.value.failed }) : ''
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

const elapsedLabel = computed(() => {
  const startedValues = props.entries
    .map(({ block }) => {
      if (block.kind === 'tool') return block.toolRun.startedAt
      if (block.kind === 'thinking') return block.startedAt
      return undefined
    })
    .filter((value): value is number => typeof value === 'number')
  const endedValues = props.entries
    .map(({ block }) => {
      if (block.kind === 'tool') return block.toolRun.endedAt
      if (block.kind === 'thinking') return block.endedAt
      return undefined
    })
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

// Executed-work summary, e.g. "思考 1 · 检索 2 · 搜索 4".
function getToolVerbKey (name: string): string {
  const normalized = name.toLowerCase()
  if (normalized.includes('todo')) return 'chatUi.toolVerbTodo'
  if (normalized.includes('search') || normalized.includes('glob') || normalized.includes('grep') || normalized.includes('list')) return 'chatUi.toolVerbSearch'
  if (normalized.includes('read')) return 'chatUi.toolVerbRead'
  if (normalized.includes('edit') || normalized.includes('write') || normalized.includes('patch')) return 'chatUi.toolVerbEdit'
  if (normalized.includes('fetch')) return 'chatUi.toolVerbFetch'
  if (normalized.includes('subagent')) return 'chatUi.toolVerbSubagent'
  return 'chatUi.toolVerbRun'
}

function getBlockVerbKey (block: GroupBlock): string {
  if (block.kind === 'thinking') return 'chatUi.toolVerbThink'
  if (block.kind === 'web_search') return 'chatUi.toolVerbWebSearch'
  if (block.kind === 'web_fetch') return 'chatUi.toolVerbFetch'
  if (block.kind === 'file_preview') return 'chatUi.toolVerbWrite'
  if (block.kind === 'content') return 'chatUi.toolVerbRun'
  return getToolVerbKey(block.toolRun.name)
}

const summaryText = computed(() => {
  const verbCounts = new Map<string, number>()
  for (const { block } of props.entries) {
    // Narration is context, not an executed action — it stays out of the verb summary.
    if (block.kind === 'content') continue
    const verbKey = getBlockVerbKey(block)
    verbCounts.set(verbKey, (verbCounts.get(verbKey) || 0) + 1)
  }
  const parts: string[] = []
  for (const [verbKey, count] of verbCounts) {
    parts.push(`${t(verbKey)} ${count}`)
  }
  return parts.join(' · ')
})

const statusClass = computed(() => deriveWorkGroupStatus(toolCounts.value))

// Historical conversations must open with every summary collapsed — a stored
// failure is already visible via the red failure badge, so auto-expanding on
// mount turned every old conversation into a wall of open traces. While the
// message is actively streaming, a fresh failure still pops the group open
// once so the error is seen as it happens.
const shouldAutoExpand = computed(() => props.messageStreaming && hasFailedTool.value)

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
</script>

<template>
  <ExecutionDisclosure
    :title="elapsedLabel ? $t('chatUi.workingElapsed', { time: elapsedLabel }) : $t('chatUi.workSummaryShort')"
    :meta="summaryText"
    :failure-label="failureLabel"
    :status="statusClass"
    :default-expanded="shouldAutoExpand"
    class="tool-group"
  >
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
        <ContentBlock
          v-else-if="entry.block.kind === 'content'"
          :block="entry.block"
          :role="role"
          :message-index="messageIndex"
          :block-index="entry.blockIndex"
          :is-streaming-block="false"
          :message-text="messageText"
          :annotations="annotations"
          class="tool-group-item tool-group-narration"
          @open-lightbox="(mi, bi, pi) => emit('openLightbox', mi, bi, pi)"
          @open-mermaid-preview="(code) => emit('openMermaidPreview', code)"
          @remove-annotation="(annotationId) => emit('removeAnnotation', annotationId)"
          @open-annotation-thread="(payload) => emit('openAnnotationThread', payload)"
        />
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

/* Narration folded into the trace reads as commentary, not as the answer —
   keep it visually quieter than the trailing content block outside. */
.tool-group-narration {
  font-size: 0.92em;
  color: var(--app-text-muted);
}
</style>
