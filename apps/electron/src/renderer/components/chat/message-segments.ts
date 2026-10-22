import type { ChatMessageBlock } from './types'

/**
 * Codex-style work summary segmentation: consecutive thinking + tool + web
 * runs collapse into ONE collapsible group, and settled "已写入" file-preview
 * rows fold in too — so a long run of tool calls stays one compact row.
 *
 * Assistant text is never folded in: every content block keeps rendering as a
 * visible paragraph in the message flow, at its original position. Only the
 * execution trace (thinking pills, tool rows, web result cards, written-file
 * rows) is summarized. Message rows without any work (plain user text) are
 * never grouped. Purely a render-level transform, so stored/legacy
 * conversations group the same way as live ones.
 */

export type WorkBurstBlock = Extract<ChatMessageBlock, { kind: 'thinking' | 'tool' | 'web_search' | 'web_fetch' | 'file_preview' }>

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

function joinsWorkGroup (block: ChatMessageBlock): boolean {
  if (GROUPABLE_KINDS.has(block.kind)) return true
  // Settled written-file rows fold into the trace; the row still being
  // written stays visible while it streams.
  if (block.kind === 'file_preview') return !block.active
  return false
}

function hasRenderableBurstBlock (block: WorkBurstBlock): boolean {
  if (block.kind === 'thinking') return block.text.trim().length > 0
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
      // Lone thinking pills / stray file rows stay standalone rows.
      for (const entry of renderable) {
        segments.push({ type: 'single', key: entry.block.id, block: entry.block, blockIndex: entry.blockIndex, groupEntries: [] })
      }
    }
    run = []
  }

  blocks.forEach((block, blockIndex) => {
    if (joinsWorkGroup(block)) {
      run.push({ block: block as WorkBurstBlock, blockIndex })
      return
    }
    flushRun()
    segments.push({ type: 'single', key: block.id, block, blockIndex, groupEntries: [] })
  })
  flushRun()
  return segments
}
