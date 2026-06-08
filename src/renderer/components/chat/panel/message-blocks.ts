import type { AgentGroupCollaborationPlan } from '../../../../shared/agent-workspace-types.js'
import type {
  AgentGroupProgressSnapshot,
  AgentGroupTranscript,
  AgentSidechatSession,
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

export function createToolRun (name: string): ToolRun {
  return {
    id: generateId(),
    name,
    status: 'running',
    progress: []
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
    content
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
    text
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

function cloneGroupCollaborationPlan (plan: AgentGroupCollaborationPlan): AgentGroupCollaborationPlan {
  return {
    ...plan,
    planner: { ...plan.planner },
    mentionedParticipants: plan.mentionedParticipants.map((participant: AgentGroupCollaborationPlan['mentionedParticipants'][number]) => ({ ...participant })),
    candidateParticipants: plan.candidateParticipants.map((participant: AgentGroupCollaborationPlan['candidateParticipants'][number]) => ({ ...participant })),
    invitedParticipants: plan.invitedParticipants.map((participant: AgentGroupCollaborationPlan['invitedParticipants'][number]) => ({ ...participant }))
  }
}

export function createGroupCollaborationPlanBlock (plan: AgentGroupCollaborationPlan): ChatMessageBlock {
  return {
    id: createBlockId('groupplan'),
    kind: 'group_collaboration_plan',
    plan: cloneGroupCollaborationPlan(plan)
  }
}

function cloneAgentSidechatSession (session: AgentSidechatSession): AgentSidechatSession {
  return {
    ...session,
    progress: session.progress.map(step => ({ ...step }))
  }
}

export function createAgentSidechatBlock (session: AgentSidechatSession): ChatMessageBlock {
  return {
    id: createBlockId('sidechat'),
    kind: 'agent_sidechat',
    session: cloneAgentSidechatSession(session)
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

function cloneGroupTranscript (transcript: AgentGroupTranscript): AgentGroupTranscript {
  return {
    ...transcript,
    entries: transcript.entries.map(entry => ({ ...entry }))
  }
}

export function createGroupTranscriptBlock (transcript: AgentGroupTranscript): ChatMessageBlock {
  return {
    id: createBlockId('group_transcript'),
    kind: 'group_transcript',
    transcript: cloneGroupTranscript(transcript)
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
  const collaborationPlanBlocks = blocks.filter((block): block is Extract<ChatMessageBlock, { kind: 'group_collaboration_plan' }> => {
    return block.kind === 'group_collaboration_plan'
  })
  const sidechatBlocks = blocks.filter((block): block is Extract<ChatMessageBlock, { kind: 'agent_sidechat' }> => {
    return block.kind === 'agent_sidechat'
  })
  const progressBlocks = blocks.filter((block): block is Extract<ChatMessageBlock, { kind: 'group_progress' }> => {
    return block.kind === 'group_progress'
  })
  const transcriptBlocks = blocks.filter((block): block is Extract<ChatMessageBlock, { kind: 'group_transcript' }> => {
    return block.kind === 'group_transcript'
  })

  if (collaborationPlanBlocks.length === 0 && sidechatBlocks.length === 0 && progressBlocks.length === 0 && transcriptBlocks.length === 0) return

  const reorderedBlocks: ChatMessageBlock[] = blocks.filter((block) => {
    return block.kind !== 'group_collaboration_plan' && block.kind !== 'agent_sidechat' && block.kind !== 'group_progress' && block.kind !== 'group_transcript'
  })
  let insertIndex = reorderedBlocks.length
  for (let index = 0; index < reorderedBlocks.length; index++) {
    if (reorderedBlocks[index].kind === 'content') {
      insertIndex = index
      break
    }
  }

  reorderedBlocks.splice(insertIndex, 0, ...collaborationPlanBlocks, ...progressBlocks, ...sidechatBlocks, ...transcriptBlocks)

  blocks.splice(0, blocks.length, ...reorderedBlocks)
}

export function upsertGroupCollaborationPlanBlock (message: ChatMessage, plan: AgentGroupCollaborationPlan): void {
  const blocks = ensureBlocks(message)
  const existing = blocks.find((block): block is Extract<ChatMessageBlock, { kind: 'group_collaboration_plan' }> => {
    return block.kind === 'group_collaboration_plan'
  })

  if (existing) {
    existing.plan = cloneGroupCollaborationPlan(plan)
  } else {
    blocks.push(createGroupCollaborationPlanBlock(plan))
  }

  positionGroupMetaBlocks(message)
}

export function upsertAgentSidechatBlock (message: ChatMessage, session: AgentSidechatSession): void {
  const blocks = ensureBlocks(message)
  const existing = blocks.find((block): block is Extract<ChatMessageBlock, { kind: 'agent_sidechat' }> => {
    return block.kind === 'agent_sidechat' && block.session.id === session.id
  })

  if (existing) {
    existing.session = cloneAgentSidechatSession(session)
  } else {
    blocks.push(createAgentSidechatBlock(session))
  }
  positionGroupMetaBlocks(message)
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

export function upsertGroupTranscriptBlock (message: ChatMessage, transcript: AgentGroupTranscript): void {
  const blocks = ensureBlocks(message)
  const existing = blocks.find((block): block is Extract<ChatMessageBlock, { kind: 'group_transcript' }> => {
    return block.kind === 'group_transcript'
  })

  if (existing) {
    existing.transcript = cloneGroupTranscript(transcript)
  } else {
    blocks.push(createGroupTranscriptBlock(transcript))
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

  const created = createContentBlock('') as Extract<ChatMessageBlock, { kind: 'content' }>
  blocks.push(created)
  return created
}

export function ensureThinkingBlock (message: ChatMessage): Extract<ChatMessageBlock, { kind: 'thinking' }> {
  const blocks = ensureBlocks(message)
  const lastBlock = getLastBlock(blocks)
  if (lastBlock?.kind === 'thinking') {
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
