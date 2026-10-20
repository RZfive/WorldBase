import type { MessageContent, ChatContentPart, ChatMessage, ChatMessageBlock, FilePreviewState } from './types'

export function getContentParts (content: MessageContent): ChatContentPart[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  return content
}

/**
 * Human elapsed-time label for work/thinking summaries ("45 秒" / "3 分 20 秒").
 * Takes the i18n translate function so components stay locale-reactive.
 */
export function formatElapsedDuration (
  seconds: number,
  translate: (key: string, values?: Record<string, unknown>) => string
): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total < 60) return translate('chatUi.durationSeconds', { count: total })
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return translate('chatUi.durationMinSec', { minutes, seconds: rest })
}

export function getContentText (content: MessageContent): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(part => part.type === 'text')
      .map(part => part.text || '')
      .join('')
  }
  return ''
}

export function getContentExcerpt (content: MessageContent, limit = 80): string {
  if (typeof content === 'string') return content.slice(0, limit)
  if (!Array.isArray(content)) return ''
  let result = ''
  for (const part of content) {
    if (part.type !== 'text') continue
    result += (part.text || '').slice(0, Math.max(0, limit - result.length))
    if (result.length >= limit) break
  }
  return result
}

export function hasRenderableContent (content: MessageContent): boolean {
  return getContentParts(content).some(part => {
    if (part.type === 'text') return Boolean(part.text?.length)
    return Boolean(part.image_url?.url)
  })
}

export function collapseWhitespace (text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export type WorkGroupStatus = 'running' | 'completed' | 'failed'

export interface WorkGroupToolCounts {
  running: number
  completed: number
  failed: number
}

/**
 * Status for a collapsed work-summary group. A turn folds every tool call into
 * one group, so marking the group failed on any single failure painted whole
 * conversations red: 54 successful runs plus 5 failures must read as a
 * completed turn with a failure count, not as an error. The group is failed
 * only when every finished tool failed; mixed results stay completed and are
 * surfaced through the separate failure badge.
 */
export function deriveWorkGroupStatus (counts: WorkGroupToolCounts): WorkGroupStatus {
  if (counts.running > 0) return 'running'
  if (counts.failed > 0 && counts.completed === 0) return 'failed'
  return 'completed'
}

/**
 * Row title for a tool run. MCP tool names embed the server, the tool and a
 * per-session random suffix (`mcp__mcp_chrome_dev__evaluate_script__4tz2u5`);
 * display the meaningful parts joined, without the opaque suffix. A trailing
 * short mixed-alphanumeric segment is only treated as a suffix when it
 * contains a digit, so real names like `mcp__server__tool` survive intact.
 */
export function getToolRunDisplayName (name: string): string {
  if (name === 'long_term_goal_propose_update') return '生成待确认目标变更'
  if (name === 'long_term_goal_get_context') return '读取长期目标状态'
  if (name === 'long_term_goal_update_schedule') return '更新长期目标排期'
  if (name === 'long_term_goal_record_run_result') return '记录长期目标执行结果'
  if (name.startsWith('mcp__')) {
    const segments = name.slice('mcp__'.length).split('__').filter(Boolean)
    const last = segments[segments.length - 1] || ''
    const looksLikeSuffix = segments.length >= 3 && /^[a-z0-9]{4,8}$/i.test(last) && /\d/.test(last)
    if (looksLikeSuffix) segments.pop()
    return segments.join(' · ')
  }
  return name
}

/**
 * Older in-place edits put the edited text into the same content block as the
 * images, so the resent bubble rendered the image but dropped the text. The
 * send path now builds separate text/image blocks; this repairs already
 * persisted messages at render time by re-adding a text block when the user's
 * content text is not covered by any existing content block.
 */
function ensureUserTextBlocks (
  blocks: ChatMessageBlock[],
  content: MessageContent,
  index: number
): ChatMessageBlock[] {
  if (!Array.isArray(content)) return blocks

  const textParts = content
    .filter(part => part.type === 'text')
    .map(part => (part.text || '').trim())
    .filter(Boolean)
  if (textParts.length === 0) return blocks

  const blockText = blocks
    .filter(block => block.kind === 'content')
    .map(block => getContentText(block.content).trim())
    .filter(Boolean)
    .join('\n\n')

  const missing = textParts.filter(text => {
    if (!blockText) return true
    // A fresh send packs quoting prefixes into the same content text part, so
    // accept either containment direction before treating the text as lost.
    return !blockText.includes(text) && !text.includes(blockText)
  })
  if (missing.length === 0) return blocks

  const textBlock: ChatMessageBlock = {
    id: `heal-user-text-${index}`,
    kind: 'content',
    content: missing.join('\n\n')
  }

  const repaired = [...blocks]
  const firstContent = repaired.findIndex(block => block.kind === 'content')
  if (firstContent < 0) {
    repaired.push(textBlock)
  } else {
    repaired.splice(firstContent, 0, textBlock)
  }
  return repaired
}

/**
 * Build the ordered list of message blocks for a given message.
 * Mirrors the legacy `getMessageBlocks` logic from MessageList.vue.
 */
export function buildMessageBlocks (
  msg: ChatMessage,
  index: number,
  filePreview: FilePreviewState,
  latestAssistantMessageIndex: number,
  isLoading: boolean
): ChatMessageBlock[] {
  if (Array.isArray(msg.blocks) && msg.blocks.length > 0) {
    return msg.role === 'user' ? ensureUserTextBlocks(msg.blocks, msg.content, index) : msg.blocks
  }

  const blocks: ChatMessageBlock[] = []
  const isStreaming = isLoading && msg.role === 'assistant' && index === latestAssistantMessageIndex

  if (msg.role === 'assistant' && msg.thinking) {
    blocks.push({ id: `legacy-thinking-${index}`, kind: 'thinking', text: msg.thinking })
  }

  if (msg.role === 'assistant' && Array.isArray(msg.toolRuns)) {
    for (const toolRun of msg.toolRuns) {
      blocks.push({ id: `legacy-tool-${toolRun.id}`, kind: 'tool', toolRun })
    }
  }

  if (hasRenderableContent(msg.content) || isStreaming) {
    blocks.push({ id: `legacy-content-${index}`, kind: 'content', content: msg.content })
  }

  const shouldShowFilePreview =
    msg.role === 'assistant' && index === latestAssistantMessageIndex && filePreview.active
  if (shouldShowFilePreview) {
    blocks.push({
      id: `legacy-preview-${index}`,
      kind: 'file_preview',
      filePath: filePreview.filePath,
      lineCount: filePreview.lineCount,
      added: filePreview.added,
      removed: filePreview.removed,
      active: filePreview.active
    })
  }

  return blocks
}
