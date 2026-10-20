import type { ChatMessageBlock } from './types'
import { hasRenderableContent } from './message-utils'

/**
 * Codex-style work summary segmentation: consecutive thinking + tool + web
 * runs collapse into ONE collapsible group, narration content blocks
 * written between tool calls (typically describing the file writes/edits just
 * performed) fold into that same group instead of rendering as full paragraphs
 * between tool rows, and settled "已写入" file-preview rows fold in too — so a
 * long run of file writes stays one compact row.
 *
 * Two things always stay outside the group: the message's trailing content
 * (the actual answer, i.e. a content block with no work block after it) and
 * the file-preview row that is still being written (active) during streaming —
 * it drops into the group automatically once it settles. Message rows without
 * any work (plain user text) are never grouped. Purely a render-level
 * transform, so stored/legacy conversations group the same way as live ones.
 */

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

function joinsWorkGroup (block: ChatMessageBlock, blocks: ChatMessageBlock[], blockIndex: number): boolean {
  if (GROUPABLE_KINDS.has(block.kind)) return true
  // Settled written-file rows fold into the trace; the row still being
  // written stays visible while it streams.
  if (block.kind === 'file_preview') return !block.active
  return block.kind === 'content' && hasWorkAfter(blocks, blockIndex)
}

function hasWorkAfter (blocks: ChatMessageBlock[], fromIndex: number): boolean {
  for (let index = fromIndex + 1; index < blocks.length; index++) {
    if (WORK_KINDS.has(blocks[index].kind)) return true
  }
  return false
}

function hasRenderableBurstBlock (block: WorkBurstBlock): boolean {
  if (block.kind === 'thinking') return block.text.trim().length > 0
  if (block.kind === 'content') return hasRenderableContent(block.content)
  return true
}

export function buildRenderSegments (blocks: ChatMessageBlock[]): MessageRenderSegment[] {
  const segments: MessageRenderSegment[] = []
  let run: WorkBurstEntry[] = []

  const flushRun = () => {
    if (run.length === 0) return
    const renderable = run.filter(entry => hasRenderableBurstBlock(entry.block))
    const hasWork = renderable.some(entry => WORK_KINDS.has(entry.block.kind))
    if (hasWork) {
      segments.push({
        type: 'group',
        key: `group-${renderable[0].block.id}`,
        block: renderable[0].block,
        blockIndex: renderable[0].blockIndex,
        groupEntries: renderable
      })
    } else {
      // Lone thinking pills / stray narration stay standalone rows.
      for (const entry of renderable) {
        segments.push({ type: 'single', key: entry.block.id, block: entry.block, blockIndex: entry.blockIndex, groupEntries: [] })
      }
    }
    run = []
  }

  blocks.forEach((block, blockIndex) => {
    if (joinsWorkGroup(block, blocks, blockIndex)) {
      run.push({ block: block as WorkBurstBlock, blockIndex })
      return
    }
    flushRun()
    segments.push({ type: 'single', key: block.id, block, blockIndex, groupEntries: [] })
  })
  flushRun()
  return segments
}
