import type { MessageContent, ChatContentPart, ChatMessage, ChatMessageBlock, FilePreviewState } from './types'

export function getContentParts (content: MessageContent): ChatContentPart[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  return content
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

export function hasRenderableContent (content: MessageContent): boolean {
  return getContentParts(content).some(part => {
    if (part.type === 'text') return Boolean(part.text?.length)
    return Boolean(part.image_url?.url)
  })
}

export function collapseWhitespace (text: string): string {
  return text.replace(/\s+/g, ' ').trim()
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
    return msg.blocks
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
