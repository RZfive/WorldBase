import type { ChatMessageBlock } from './types'
import { hasRenderableContent } from './message-utils'

/**
 * Codex-style work summary segmentation: consecutive thinking + tool + web
 * runs collapse into ONE collapsible group, and settled "已写入" file-preview
 * rows fold in too — so a long run of tool calls stays one compact row.
 *
 * Assistant narration joins the group when more work follows it, so text
 * emitted between tool calls does not break the trace apart. While a message
 * is streaming, output also defaults into the summary: text that is still
 * waiting for a possible tool call avoids rendering outside and then jumping
 * into the group. Once the message settles, trailing text without later work
 * renders as its own visible paragraph. Message rows without any work (plain
 * user text) are never grouped. Purely a render-level transform, so
 * stored/legacy conversations group the same way as live ones.
 */

export interface BuildRenderSegmentsOptions {
  streaming?: boolean
}

export type WorkBurstBlock = Extract<ChatMessageBlock, { kind: 'thinking' | 'tool' | 'web_search' | 'web_fetch' | 'file_preview' | 'content' }>

export interface WorkBurstEntry {
  block: WorkBurstBlock
  blockIndex: number
}

export interface MessageRenderSegment {
  type: 'single' | 'group'
  key: string
  block: ChatMessageBlock
  blockIndex: number
  groupEntries: WorkBurstEntry[]
}

const GROUPABLE_KINDS = new Set<ChatMessageBlock['kind']>(['thinking', 'tool', 'web_search', 'web_fetch'])

const WORK_KINDS = new Set<ChatMessageBlock['kind']>(['tool', 'web_search', 'web_fetch'])

function joinsWorkGroup (
  block: ChatMessageBlock,
  hasWorkAfter: boolean,
  options: BuildRenderSegmentsOptions
): boolean {
  if (GROUPABLE_KINDS.has(block.kind)) return true
  // Settled written-file rows fold into the trace; the row still being
  // written stays visible while it streams.
  if (block.kind === 'file_preview') return !block.active
  if (block.kind === 'content') {
    // Live output defaults into the summary so it does not render outside and
    // then jump into the group when the next tool call starts.
    if (options.streaming) return true
    // Settled narration between work steps belongs to the same group.
    return hasWorkAfter
  }
  return false
}

function hasRenderableBurstBlock (block: WorkBurstBlock): boolean {
  if (block.kind === 'thinking') return block.text.trim().length > 0
  if (block.kind === 'content') return hasRenderableContent(block.content)
  return true
}

export function buildRenderSegments (
  blocks: ChatMessageBlock[],
  options: BuildRenderSegmentsOptions = {}
): MessageRenderSegment[] {
  const segments: MessageRenderSegment[] = []
  let run: WorkBurstEntry[] = []

  // Suffix scan keeps segmentation linear while long streams re-render on
  // every token; slicing the tail per content block was quadratic.
  const workAfter = new Array<boolean>(blocks.length).fill(false)
  let seenWork = false
  for (let index = blocks.length - 1; index >= 0; index--) {
    workAfter[index] = seenWork
    if (WORK_KINDS.has(blocks[index].kind)) seenWork = true
  }

  const flushRun = () => {
    if (run.length === 0) return
    const renderable = run.filter(entry => hasRenderableBurstBlock(entry.block))
    const hasWork = renderable.some(entry => WORK_KINDS.has(entry.block.kind))
    const hasStreamingContent = options.streaming && renderable.some(entry => entry.block.kind === 'content')
    // A splitter (todo/error/auth/...) can end a narration-only run while more
    // work still follows it; keep that narration folded instead of releasing
    // it outside and snapping it back into the next group on settle.
    const hasWorkAhead = renderable.some(entry => {
      return entry.block.kind === 'content' && workAfter[entry.blockIndex]
    })
    if (hasWork || hasStreamingContent || hasWorkAhead) {
      // Key from the first run member, not the first renderable one: a content
      // block can start empty then become renderable on the first token, and
      // the group must not remount when that happens.
      const keyBlock = run[0].block
      segments.push({
        type: 'group',
        key: `group-${keyBlock.id}`,
        block: keyBlock,
        blockIndex: run[0].blockIndex,
        groupEntries: renderable
      })
    } else {
      // Lone thinking pills / stray file rows stay standalone rows.
      for (const entry of renderable) {
        segments.push({ type: 'single', key: entry.block.id, block: entry.block, blockIndex: entry.blockIndex, groupEntries: [] })
      }
    }
    run = []
  }

  blocks.forEach((block, blockIndex) => {
    if (joinsWorkGroup(block, workAfter[blockIndex], options)) {
      run.push({ block: block as WorkBurstBlock, blockIndex })
      return
    }
    flushRun()
    segments.push({ type: 'single', key: block.id, block, blockIndex, groupEntries: [] })
  })
  flushRun()
  return segments
}
