import {
  createAuthRequestBlock,
  createContentBlock,
  ensureBlocks,
  findLastRunningToolBlock,
  getLatestTodoBlock
} from './message-blocks'
import type { AuthRequestPayload, ChatMessage, ChatMessageBlock, MessageContent, TodoItem, ToolRun } from './types'

export interface AssistantStopCopy {
  stage: string
  detail: string
  content: string
}

interface ConversationTitleFormatters {
  attachmentTitle?: (attachmentNames: string[]) => string
}

const LEGACY_STOPPED_STAGE = '\u5df2\u505c\u6b62'
const LEGACY_STOPPED_CONTENT = '(\u5df2\u505c\u6b62)'
const DEFAULT_STOP_COPY: AssistantStopCopy = {
  stage: 'Stopped',
  detail: 'The user stopped this generation',
  content: '(Stopped)'
}

function isStoppedStage (stage: string, stoppedStage = DEFAULT_STOP_COPY.stage): boolean {
  return stage === stoppedStage || stage === DEFAULT_STOP_COPY.stage || stage === LEGACY_STOPPED_STAGE
}

function includesStoppedContent (content: string, stoppedContent = DEFAULT_STOP_COPY.content): boolean {
  return content.includes(stoppedContent) || content.includes(DEFAULT_STOP_COPY.content) || content.includes(LEGACY_STOPPED_CONTENT)
}

export function findLatestAssistantMessage (chatMessages: ChatMessage[]): ChatMessage | null {
  for (let index = chatMessages.length - 1; index >= 0; index--) {
    if (chatMessages[index].role === 'assistant') {
      return chatMessages[index]
    }
  }
  return null
}

export function getMessageTextContent (content: MessageContent): string {
  if (typeof content === 'string') {
    return content.trim()
  }

  return content
    .filter(part => part.type === 'text')
    .map(part => part.text || '')
    .join(' ')
    .trim()
}

export function getMessageText (msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(part => part.type === 'text')
      .map(part => part.text || '')
      .join('')
  }
  return ''
}

export function hasRenderableContent (msg: ChatMessage): boolean {
  if (typeof msg.content === 'string') {
    return msg.content.trim().length > 0
  }

  return msg.content.some(part => {
    if (part.type === 'text') {
      return Boolean(part.text?.trim())
    }
    return Boolean(part.image_url?.url)
  })
}

export function getConversationTitleText (msg?: ChatMessage, formatters: ConversationTitleFormatters = {}): string {
  if (!msg) return ''

  if (Array.isArray(msg.blocks) && msg.blocks.length > 0) {
    const contentText = msg.blocks
      .filter((block): block is Extract<ChatMessageBlock, { kind: 'content' }> => block.kind === 'content')
      .flatMap(block => typeof block.content === 'string'
        ? [{ type: 'text', text: block.content }]
        : block.content)
      .filter(part => part.type === 'text')
      .map(part => part.text || '')
      .join(' ')
      .trim()

    if (contentText) return contentText

    const attachmentNames = msg.blocks
      .filter((block): block is Extract<ChatMessageBlock, { kind: 'attachment' }> => block.kind === 'attachment')
      .map(block => block.fileName)

    if (attachmentNames.length > 0) {
      return formatters.attachmentTitle?.(attachmentNames) || `Attachments: ${attachmentNames.join(', ')}`
    }
  }

  return getMessageText(msg)
}

export function getLatestVisibleTodoItems (chatMessages: ChatMessage[], loading: boolean): TodoItem[] {
  const latestAssistant = findLatestAssistantMessage(chatMessages)
  if (!latestAssistant) {
    return []
  }

  const todoBlock = getLatestTodoBlock(latestAssistant)
  if (!todoBlock) {
    return []
  }

  if (!loading && todoBlock.items.length > 0 && todoBlock.items.every(item => item.status === 'completed')) {
    return []
  }

  return todoBlock.items.map(item => ({ ...item }))
}

export function finalizePendingAuthBlocks (message: ChatMessage): void {
  for (const block of ensureBlocks(message)) {
    if (block.kind === 'auth_request' && block.status === 'pending') {
      block.status = 'denied'
    }
    if (block.kind === 'sudo_password_request' && block.status === 'pending') {
      block.status = 'canceled'
    }
  }
}

export function markToolRunStopped (toolRun: ToolRun, copy: AssistantStopCopy = DEFAULT_STOP_COPY): void {
  toolRun.status = 'completed'
  const alreadyMarked = toolRun.progress.some(step => isStoppedStage(step.stage, copy.stage))
  if (!alreadyMarked) {
    toolRun.progress.push({ stage: copy.stage, detail: copy.detail })
  }
}

export function markAssistantMessageStopped (message: ChatMessage, copy: AssistantStopCopy = DEFAULT_STOP_COPY): void {
  for (const toolRun of message.toolRuns || []) {
    if (toolRun.status === 'running') {
      markToolRunStopped(toolRun, copy)
    }
  }

  for (const block of ensureBlocks(message)) {
    if (block.kind === 'tool' && block.toolRun.status === 'running') {
      markToolRunStopped(block.toolRun, copy)
    }
  }

  finalizePendingAuthBlocks(message)

  if (!hasRenderableContent(message)) {
    message.content = copy.content
    ensureBlocks(message).push(createContentBlock(copy.content))
  }
}

export function isAssistantMessageStopped (message: ChatMessage, copy: AssistantStopCopy = DEFAULT_STOP_COPY): boolean {
  if (includesStoppedContent(getMessageTextContent(message.content), copy.content)) {
    return true
  }

  const toolRuns = Array.isArray(message.toolRuns) && message.toolRuns.length > 0
    ? message.toolRuns
    : (Array.isArray(message.blocks)
        ? message.blocks.filter((block): block is Extract<ChatMessageBlock, { kind: 'tool' }> => block.kind === 'tool').map(block => block.toolRun)
        : [])

  return toolRuns.some(toolRun => toolRun.progress.some(step => isStoppedStage(step.stage, copy.stage)))
}

export function buildInterruptedRunSummary (history: ChatMessage[]): string | null {
  const latestAssistant = findLatestAssistantMessage(history)
  if (!latestAssistant || !isAssistantMessageStopped(latestAssistant)) {
    return null
  }

  const lines = [
    '以下是上一轮被用户手动终止时的执行进度。如果用户是在继续同一个任务，请把这些内容视为已经完成或已知状态，不要要求用户重复说明，也不要重复已完成的步骤。'
  ]

  const todoBlock = getLatestTodoBlock(latestAssistant)
  if (todoBlock && todoBlock.items.length > 0) {
    lines.push('当前 Todo 状态：')
    for (const item of todoBlock.items) {
      const statusLabel = item.status === 'completed'
        ? '已完成'
        : item.status === 'in-progress'
          ? '进行中'
          : '未开始'
      lines.push(`- [${statusLabel}] ${item.id}. ${item.title}`)
    }
  }

  const toolRuns = Array.isArray(latestAssistant.toolRuns) && latestAssistant.toolRuns.length > 0
    ? latestAssistant.toolRuns
    : (Array.isArray(latestAssistant.blocks)
        ? latestAssistant.blocks.filter((block): block is Extract<ChatMessageBlock, { kind: 'tool' }> => block.kind === 'tool').map(block => block.toolRun)
        : [])

  if (toolRuns.length > 0) {
    lines.push('上一轮工具执行进度：')
    for (const toolRun of toolRuns) {
      const statusLabel = toolRun.status === 'failed'
        ? '失败'
        : toolRun.progress.some(step => isStoppedStage(step.stage))
          ? '已中断'
          : toolRun.status === 'completed'
            ? '已完成'
            : '执行中'
      const recentProgress = toolRun.progress.slice(-3).map(step => step.detail ? `${step.stage}: ${step.detail}` : step.stage)
      lines.push(`- ${toolRun.name} [${statusLabel}]${recentProgress.length > 0 ? ` -> ${recentProgress.join(' | ')}` : ''}`)
    }
  }

  const authBlocks = Array.isArray(latestAssistant.blocks)
    ? latestAssistant.blocks.filter((block): block is Extract<ChatMessageBlock, { kind: 'auth_request' }> => block.kind === 'auth_request')
    : []
  if (authBlocks.length > 0) {
    lines.push('授权记录：')
    for (const block of authBlocks) {
      const statusLabel = block.status === 'approved' ? '已允许' : block.status === 'denied' ? '已拒绝' : '等待中'
      lines.push(`- ${statusLabel}: ${block.title}`)
    }
  }

  const previewBlocks = Array.isArray(latestAssistant.blocks)
    ? latestAssistant.blocks.filter((block): block is Extract<ChatMessageBlock, { kind: 'file_preview' }> => block.kind === 'file_preview')
    : []
  if (previewBlocks.length > 0) {
    lines.push('已生成或查看过的文件预览：')
    for (const block of previewBlocks.slice(-3)) {
      lines.push(`- ${block.filePath}`)
    }
  }

  return lines.join('\n')
}

export function buildOutgoingChatMessages (sourceMessages: ChatMessage[]): Array<{ role: string; content: MessageContent }> {
  const outgoingMessages = sourceMessages.map(message => ({
    role: message.role,
    content: message.content
  }))

  if (sourceMessages.length === 0) {
    return outgoingMessages
  }

  const summary = buildInterruptedRunSummary(sourceMessages.slice(0, -1))
  if (!summary) {
    return outgoingMessages
  }

  const insertIndex = Math.max(outgoingMessages.length - 1, 0)
  outgoingMessages.splice(insertIndex, 0, {
    role: 'system',
    content: summary
  })

  return outgoingMessages
}

export function ensureAuthRequestBlockInMessages (targetMessages: ChatMessage[], request: AuthRequestPayload): void {
  let assistantMessage = findLatestAssistantMessage(targetMessages)

  if (!assistantMessage) {
    const placeholder: ChatMessage = {
      role: 'assistant',
      content: '',
      blocks: []
    }
    targetMessages.push(placeholder)
    assistantMessage = placeholder
  }

  const blocks = ensureBlocks(assistantMessage)
  const existing = blocks.find((block): block is Extract<ChatMessageBlock, { kind: 'auth_request' }> => {
    return block.kind === 'auth_request' && block.requestId === request.requestId
  })
  if (existing) return

  const toolBlock = findLastRunningToolBlock(assistantMessage)
  if (toolBlock) {
    const alreadyLogged = toolBlock.toolRun.progress.some(step => step.stage === '等待授权' && step.detail === request.title)
    if (!alreadyLogged) {
      toolBlock.toolRun.progress.push({ stage: '等待授权', detail: request.title })
    }
  }

  blocks.push(createAuthRequestBlock(request))
}
