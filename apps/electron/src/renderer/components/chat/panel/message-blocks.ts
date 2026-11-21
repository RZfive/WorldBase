import type { AgentGroupMessage, AgentGroupUserInjection } from '../../../../shared/agent-workspace-types.js'
import type {
  AgentGroupProgressSnapshot,
  AuthRequestPayload,
  ChatMessage,
  ChatMessageBlock,
  MessageContent,
  PendingAttachment,
  TodoItem,
  ToolRun,
  WebFetchResultEntry,
  WebSearchResultItem
} from './types'

export function generateId (): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  const randomBytes = new Uint32Array(2)
  globalThis.crypto.getRandomValues(randomBytes)
  return `${Date.now().toString(36)}_${Array.from(randomBytes, value => value.toString(36)).join('')}`
}

function createBlockId (prefix: string): string {
  return `${prefix}_${generateId()}`
}

export function cloneToolRuns (toolRuns: ToolRun[]): ToolRun[] {
  return toolRuns.map(toolRun => ({
    ...toolRun,
    progress: toolRun.progress.map(step => ({ ...step }))
  }))
}

export function createToolRun (name: string, filePath?: string): ToolRun {
  return {
    id: generateId(),
    name,
    status: 'running',
    progress: [],
    startedAt: Date.now(),
    ...(filePath ? { filePath } : {})
  }
}

export function ensureBlocks (message: ChatMessage): ChatMessageBlock[] {
  if (!Array.isArray(message.blocks)) {
    message.blocks = []
  }
  return message.blocks
}

export function createContentBlock (content: MessageContent = ''): ChatMessageBlock {
  return {
    id: createBlockId('content'),
    kind: 'content',
    content,
    startedAt: Date.now()
  }
}

export function createErrorBlock (message: string): ChatMessageBlock {
  return {
    id: createBlockId('error'),
    kind: 'error',
    message
  }
}

export function createThinkingBlock (text = ''): ChatMessageBlock {
  return {
    id: createBlockId('thinking'),
    kind: 'thinking',
    text,
    startedAt: Date.now()
  }
}

/**
 * Stamp endedAt on any thinking blocks still open, so their "已思考 · N 秒"
 * duration freezes once visible output (content / tool calls / done) follows.
 */
export function closeOpenThinkingBlocks (message: ChatMessage): void {
  const blocks = ensureBlocks(message)
  const now = Date.now()
  for (const block of blocks) {
    if (block.kind === 'thinking' && block.endedAt == null) {
      block.endedAt = now
    }
  }
}

export function createToolBlock (toolRun: ToolRun): ChatMessageBlock {
  return {
    id: createBlockId('tool'),
    kind: 'tool',
    toolRun
  }
}

export function createTodoBlock (items: TodoItem[]): ChatMessageBlock {
  return {
    id: createBlockId('todo'),
    kind: 'todo',
    items: items.map(item => ({ ...item }))
  }
}

export function createFilePreviewBlock (filePath: string): ChatMessageBlock {
  return {
    id: createBlockId('preview'),
    kind: 'file_preview',
    filePath,
    lineCount: 0,
    added: 0,
    removed: 0,
    active: true
  }
}

function cloneGroupProgressSnapshot (snapshot: AgentGroupProgressSnapshot): AgentGroupProgressSnapshot {
  return {
    ...snapshot,
    items: snapshot.items.map(item => ({
      ...item,
      progress: item.progress.map(step => ({ ...step }))
    }))
  }
}

export function createGroupProgressBlock (snapshot: AgentGroupProgressSnapshot): ChatMessageBlock {
  return {
    id: createBlockId('group_progress'),
    kind: 'group_progress',
    snapshot: cloneGroupProgressSnapshot(snapshot)
  }
}

export function createWebSearchBlock (query: string, engine: string, results: WebSearchResultItem[]): ChatMessageBlock {
  return {
    id: createBlockId('websearch'),
    kind: 'web_search',
    query,
    engine,
    results
  }
}

export function createWebFetchBlock (result: WebFetchResultEntry, query?: string): ChatMessageBlock {
  return {
    id: createBlockId('webfetch'),
    kind: 'web_fetch',
    query,
    result
  }
}

export function createAttachmentBlock (file: PendingAttachment): ChatMessageBlock {
  return {
    id: createBlockId('attachment'),
    kind: 'attachment',
    fileName: file.name,
    fileType: file.fileType,
    fileSizeLabel: file.fileSizeLabel,
    previewText: file.previewText
  }
}

export function createAuthRequestBlock (request: AuthRequestPayload): ChatMessageBlock {
  return {
    id: createBlockId('auth'),
    kind: 'auth_request',
    requestId: request.requestId,
    title: request.title,
    detail: request.detail,
    ...(request.purpose ? { purpose: request.purpose } : {}),
    status: 'pending'
  }
}

export function createSudoPasswordRequestBlock (requestId: string, command: string): ChatMessageBlock {
  return {
    id: createBlockId('sudo'),
    kind: 'sudo_password_request',
    requestId,
    command,
    status: 'pending'
  }
}

export function positionGroupMetaBlocks (message: ChatMessage): void {
  const blocks = ensureBlocks(message)
  const progressBlocks = blocks.filter((block): block is Extract<ChatMessageBlock, { kind: 'group_progress' }> => {
    return block.kind === 'group_progress'
  })
  if (progressBlocks.length === 0) return

  const reorderedBlocks: ChatMessageBlock[] = blocks.filter((block) => {
    return block.kind !== 'group_progress'
  })
  let insertIndex = reorderedBlocks.length
  for (let index = 0; index < reorderedBlocks.length; index++) {
    if (reorderedBlocks[index].kind === 'content') {
      insertIndex = index
      break
    }
  }

  reorderedBlocks.splice(insertIndex, 0, ...progressBlocks)

  blocks.splice(0, blocks.length, ...reorderedBlocks)
}

export function upsertGroupProgressBlock (message: ChatMessage, snapshot: AgentGroupProgressSnapshot): void {
  const blocks = ensureBlocks(message)
  const existing = blocks.find((block): block is Extract<ChatMessageBlock, { kind: 'group_progress' }> => {
    return block.kind === 'group_progress'
  })

  if (existing) {
    existing.snapshot = cloneGroupProgressSnapshot(snapshot)
  } else {
    blocks.push(createGroupProgressBlock(snapshot))
  }

  positionGroupMetaBlocks(message)
}

export function appendGroupUserInjectionBlock (message: ChatMessage, injection: AgentGroupUserInjection): void {
  const blocks = ensureBlocks(message)
  const existing = blocks.find((block): block is Extract<ChatMessageBlock, { kind: 'group_user_injection' }> => {
    return block.kind === 'group_user_injection' && block.injection.id === injection.id
  })
  if (existing) {
    existing.injection = { ...injection }
  } else {
    blocks.push({ id: createBlockId('group_injection'), kind: 'group_user_injection', injection: { ...injection } })
  }
  positionGroupMetaBlocks(message)
}

export function appendGroupPeerMessageBlock (message: ChatMessage, peerMessage: AgentGroupMessage): void {
  const blocks = ensureBlocks(message)
  const existing = blocks.find((block): block is Extract<ChatMessageBlock, { kind: 'group_peer_message' }> => {
    return block.kind === 'group_peer_message' && block.peerMessage.id === peerMessage.id
  })
  if (existing) {
    existing.peerMessage = { ...peerMessage }
  } else {
    blocks.push({ id: createBlockId('group_peer'), kind: 'group_peer_message', peerMessage: { ...peerMessage } })
  }
  positionGroupMetaBlocks(message)
}

function getLastBlock (blocks: ChatMessageBlock[]): ChatMessageBlock | null {
  return blocks.length > 0 ? blocks[blocks.length - 1] : null
}

export function ensureStreamingContentBlock (message: ChatMessage): Extract<ChatMessageBlock, { kind: 'content' }> {
  const blocks = ensureBlocks(message)
  const lastBlock = getLastBlock(blocks)
  if (lastBlock?.kind === 'content' && typeof lastBlock.content === 'string') {
    return lastBlock
  }

  // Visible text starts here — close any open thinking block so its
  // elapsed-time pill freezes at this moment.
  closeOpenThinkingBlocks(message)
  const created = createContentBlock('') as Extract<ChatMessageBlock, { kind: 'content' }>
  blocks.push(created)
  return created
}

export function ensureThinkingBlock (message: ChatMessage): Extract<ChatMessageBlock, { kind: 'thinking' }> {
  const blocks = ensureBlocks(message)
  const lastBlock = getLastBlock(blocks)
  if (lastBlock?.kind === 'thinking' && lastBlock.endedAt == null) {
    return lastBlock
  }

  const created = createThinkingBlock('') as Extract<ChatMessageBlock, { kind: 'thinking' }>
  blocks.push(created)
  return created
}

export function getLastActivePreviewBlock (message: ChatMessage, filePath?: string): Extract<ChatMessageBlock, { kind: 'file_preview' }> | null {
  const blocks = ensureBlocks(message)
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (block.kind !== 'file_preview' || !block.active) continue
    if (!filePath || block.filePath === filePath) {
      return block
    }
  }
  return null
}

export function syncLegacyToolRuns (message: ChatMessage, toolRuns: ToolRun[]): void {
  message.toolRuns = cloneToolRuns(toolRuns)
}

export function appendFinalContentBlock (message: ChatMessage, finalContent: MessageContent | undefined): void {
  if (finalContent === undefined) return

  const blocks = ensureBlocks(message)

  if (typeof finalContent === 'string') {
    const textBlocks = blocks.filter((block): block is Extract<ChatMessageBlock, { kind: 'content' }> => {
      return block.kind === 'content' && typeof block.content === 'string'
    })

    if (textBlocks.length === 0) {
      if (finalContent.trim().length > 0) {
        blocks.push(createContentBlock(finalContent))
      }
      return
    }

    // Providers can deliver answer text only in the final event. If the last
    // content block sits before tool/web work, folding the answer into it
    // would hide the answer inside the work summary — append a new trailing
    // block so it is released outside after the turn settles.
    const lastContentBlock = [...blocks].reverse().find((block): block is Extract<ChatMessageBlock, { kind: 'content' }> => block.kind === 'content')
    if (lastContentBlock) {
      const lastContentIndex = blocks.indexOf(lastContentBlock)
      const hasWorkAfter = blocks.slice(lastContentIndex + 1).some(block => {
        return block.kind === 'tool' || block.kind === 'web_search' || block.kind === 'web_fetch'
      })
      if (hasWorkAfter) {
        if (finalContent.trim().length > 0) {
          blocks.push(createContentBlock(finalContent))
        }
        return
      }
    }

    if (textBlocks.length === 1) {
      textBlocks[0].content = finalContent
      return
    }

    const renderedText = textBlocks
      .map(block => block.content)
      .join('')

    if (renderedText === finalContent) {
      return
    }

    if (finalContent.startsWith(renderedText)) {
      const trailingText = finalContent.slice(renderedText.length)
      if (trailingText.length > 0) {
        const lastTextBlock = textBlocks[textBlocks.length - 1]
        lastTextBlock.content += trailingText
      }
    }
    return
  }

  const hasContentBlock = blocks.some(block => block.kind === 'content' && (typeof block.content === 'string'
    ? block.content.trim().length > 0
    : block.content.length > 0))

  if (!hasContentBlock) {
    blocks.push(createContentBlock(finalContent))
    return
  }

  if (Array.isArray(finalContent)) {
    const imageParts = finalContent.filter(part => part.type === 'image_url')
    if (imageParts.length > 0) {
      blocks.push(createContentBlock(imageParts))
    }
  }
}

export function upsertErrorBlock (message: ChatMessage, errorMessage: string): void {
  const blocks = ensureBlocks(message)
  const existing = [...blocks].reverse().find((block): block is Extract<ChatMessageBlock, { kind: 'error' }> => block.kind === 'error')
  if (existing) {
    existing.message = errorMessage
    return
  }
  blocks.push(createErrorBlock(errorMessage))
}

export function setAssistantErrorState (
  message: ChatMessage,
  errorMessage: string,
  getMessageTextContent: (content: MessageContent) => string
): void {
  if (getMessageTextContent(message.content).length === 0) {
    message.content = errorMessage
  }
  upsertErrorBlock(message, errorMessage)
}

export function findLastRunningToolRun (toolRuns: ToolRun[], preferredName?: string): ToolRun | null {
  for (let index = toolRuns.length - 1; index >= 0; index--) {
    const toolRun = toolRuns[index]
    if (toolRun.status !== 'running') continue
    if (!preferredName || toolRun.name === preferredName) {
      return toolRun
    }
  }
  return null
}

export function findLastRunningToolBlock (message: ChatMessage): Extract<ChatMessageBlock, { kind: 'tool' }> | null {
  const blocks = ensureBlocks(message)
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (block.kind === 'tool' && block.toolRun.status === 'running') {
      return block
    }
  }
  return null
}

export function getLatestTodoBlock (message: ChatMessage): Extract<ChatMessageBlock, { kind: 'todo' }> | null {
  const blocks = Array.isArray(message.blocks) ? message.blocks : []
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (block.kind === 'todo') {
      return block
    }
  }
  return null
}

export function syncTodoBlock (message: ChatMessage, items: TodoItem[]): void {
  const blocks = ensureBlocks(message)
  const nextItems = items.map(item => ({ ...item }))
  const existing = getLatestTodoBlock(message)
  if (nextItems.length === 0) {
    if (!existing) return
    const blockIndex = blocks.findIndex(block => block.id === existing.id)
    if (blockIndex >= 0) {
      blocks.splice(blockIndex, 1)
    }
    return
  }

  if (existing) {
    existing.items = nextItems
    return
  }

  blocks.push(createTodoBlock(nextItems))
}
