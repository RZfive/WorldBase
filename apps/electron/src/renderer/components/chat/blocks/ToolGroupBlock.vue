<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ChatMessageBlock } from '../types'
import { formatElapsedDuration } from '../message-utils'
import ExecutionDisclosure from './ExecutionDisclosure.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolRunBlock from './ToolRunBlock.vue'
import WebSearchBlock from './WebSearchBlock.vue'
import WebFetchBlock from './WebFetchBlock.vue'

type ThinkingBlockModel = Extract<ChatMessageBlock, { kind: 'thinking' }>
type ToolBlockModel = Extract<ChatMessageBlock, { kind: 'tool' }>
type WebSearchBlockModel = Extract<ChatMessageBlock, { kind: 'web_search' }>
type WebFetchBlockModel = Extract<ChatMessageBlock, { kind: 'web_fetch' }>
type GroupBlock = ThinkingBlockModel | ToolBlockModel | WebSearchBlockModel | WebFetchBlockModel

const props = withDefaults(defineProps<{
  blocks: GroupBlock[]
  /** Whether the owning message is the currently streaming one. */
  messageStreaming?: boolean
}>(), {
  messageStreaming: false
})

const { t } = useI18n()

// Codex-style work summary: consecutive thinking + tool + web result runs
// collapse into ONE row — live seconds while working, frozen total once
// settled — expanding to the full trace (thinking pills, per-tool rows and
// web result cards) underneath.

const hasRunningTool = computed(() => {
  return props.blocks.some(block => block.kind === 'tool' && block.toolRun.status === 'running')
})

const hasOpenThinking = computed(() => {
  return props.blocks.some(block => block.kind === 'thinking' && block.endedAt == null)
})

const isActive = computed(() => props.messageStreaming && (hasRunningTool.value || hasOpenThinking.value))

const hasFailedTool = computed(() => {
  return props.blocks.some(block => block.kind === 'tool' && block.toolRun.status === 'failed')
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
  const startedValues = props.blocks
    .map(block => (block.kind === 'tool' ? block.toolRun.startedAt : block.kind === 'thinking' ? block.startedAt : undefined))
    .filter((value): value is number => typeof value === 'number')
  const endedValues = props.blocks
    .map(block => (block.kind === 'tool' ? block.toolRun.endedAt : block.kind === 'thinking' ? block.endedAt : undefined))
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
  return getToolVerbKey(block.toolRun.name)
}

const summaryText = computed(() => {
  const verbCounts = new Map<string, number>()
  for (const block of props.blocks) {
    const verbKey = getBlockVerbKey(block)
    verbCounts.set(verbKey, (verbCounts.get(verbKey) || 0) + 1)
  }
  const parts: string[] = []
  for (const [verbKey, count] of verbCounts) {
    parts.push(`${t(verbKey)} ${count}`)
  }
  return parts.join(' · ')
})

const statusClass = computed(() => {
  if (hasFailedTool.value) return 'failed' as const
  if (isActive.value) return 'running' as const
  return 'completed' as const
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
  return index === props.blocks.length - 1
}
</script>

<template>
  <ExecutionDisclosure
    :title="elapsedLabel ? $t('chatUi.workingElapsed', { time: elapsedLabel }) : $t('chatUi.workSummaryShort')"
    :meta="summaryText"
    :status="statusClass"
    :default-expanded="hasFailedTool"
    class="tool-group"
  >
    <div class="tool-group-body">
      <template v-for="(block, index) in props.blocks" :key="block.id">
        <ThinkingBlock
          v-if="block.kind === 'thinking'"
          :block="block"
          :is-streaming="isInnerThinkingStreaming(block, index)"
          :is-collapsed="isThinkingCollapsed(block)"
          class="tool-group-item"
          @toggle="toggleThinking(block.id)"
        />
        <WebSearchBlock
          v-else-if="block.kind === 'web_search'"
          :block="block"
          class="tool-group-item"
        />
        <WebFetchBlock
          v-else-if="block.kind === 'web_fetch'"
          :block="block"
          class="tool-group-item"
        />
        <ToolRunBlock
          v-else
          :block="block"
          class="tool-group-item"
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
</style>
