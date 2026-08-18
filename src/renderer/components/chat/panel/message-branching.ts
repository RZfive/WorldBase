import { ref, type Ref } from 'vue'
import type { ComposerTranslation } from 'vue-i18n'
import { generateId } from './message-blocks'
import { getMessageTextContent } from './message-runtime'
import type { PreparedUserMessage } from './message-sender'
import type { ChatMessage, ChatMessageBlock, ConversationSummary } from './types'

/** One-shot interactive blocks that have no meaning in a copied branch (PRD R6). */
const DROPPED_BLOCK_KINDS = new Set(['auth_request', 'sudo_password_request'])

/**
 * Backfill stable ids onto legacy messages that predate message identity.
 * Runs in-memory on every conversation load; ids persist on the next save so
 * branching (which anchors on ids) works on old conversations too.
 */
export function ensureMessageIds (messages: ChatMessage[]): ChatMessage[] {
  for (const message of messages) {
    if (!message.id) {
      message.id = generateId()
    }
  }
  return messages
}

export type EditResendMode = 'fork' | 'inplace'

interface ChatMessageBranchingOptions {
  t: ComposerTranslation
  messages: Ref<ChatMessage[]>
  currentConversationId: Ref<string | null>
  conversations: Ref<ConversationSummary[]>
  streamingConversationIds: Set<string>
  loadConversation: (conversationId: string) => Promise<void>
  loadConversations: () => Promise<void>
  saveConversation: (conversationId: string, messages: ChatMessage[]) => Promise<void>
  sendMessage: (prepared?: PreparedUserMessage) => Promise<void>
}

/**
 * Message-level branching (PRD docs/message-fork-edit-prd.md): fork a new
 * conversation from any user message, or edit a sent user message and resend
 * it - either as a fork (source preserved) or in place (tail truncated).
 */
export function createChatMessageBranching (options: ChatMessageBranchingOptions) {
  const {
    t,
    messages,
    currentConversationId,
    conversations,
    streamingConversationIds,
    loadConversation,
    loadConversations,
    saveConversation,
    sendMessage
  } = options

  /** Message id currently open in the inline editor, if any. */
  const editingMessageId = ref<string | null>(null)

  function isMessageBranchable (message: ChatMessage): boolean {
    return message.role === 'user' && Boolean(message.id)
  }

  function isBranchingBlocked (): boolean {
    const conversationId = currentConversationId.value
    return !conversationId || streamingConversationIds.has(conversationId)
  }

  function resolveMessageIndexById (messageId: string): number {
    return messages.value.findIndex(message => message.id === messageId)
  }

  /** Editable text for the inline editor: the model-visible text of the message. */
  function getMessageEditableText (message: ChatMessage): string {
    return getMessageTextContent(message.content)
  }

  function startEditMessage (messageId: string): void {
    if (isBranchingBlocked()) return
    const index = resolveMessageIndexById(messageId)
    if (index < 0 || !isMessageBranchable(messages.value[index])) return
    editingMessageId.value = messageId
  }

  function cancelEditMessage (): void {
    editingMessageId.value = null
  }

  /** Strip one-shot interactive blocks from a copied message list. */
  function sanitizeCopiedMessages (source: ChatMessage[]): ChatMessage[] {
    return source.map(message => {
      if (!Array.isArray(message.blocks) || message.blocks.length === 0) {
        return { ...message }
      }
      return {
        ...message,
        blocks: message.blocks.filter(block => !DROPPED_BLOCK_KINDS.has(block.kind))
      }
    })
  }

  /**
   * Fork a new conversation from the given user message: copy the prefix
   * (anchor message included) plus all conversation metadata, record lineage,
   * then switch the panel to the new conversation. The source is untouched.
   * Returns the new conversation id, or null when forking is not possible.
   */
  async function forkFromMessage (messageId: string): Promise<string | null> {
    const sourceId = currentConversationId.value
    if (!sourceId || streamingConversationIds.has(sourceId)) return null
    if (!window.electronAPI) return null

    const source = await window.electronAPI.getConversation(sourceId)
    if (!source) return null

    const anchorIndex = source.messages.findIndex(message => message.id === messageId)
    if (anchorIndex < 0 || source.messages[anchorIndex].role !== 'user') return null

    const newId = generateId()
    const now = new Date().toISOString()
    await window.electronAPI.saveConversation(JSON.parse(JSON.stringify({
      id: newId,
      title: `${source.title} · ${t('chatUi.forkTitleSuffix')}`,
      messages: sanitizeCopiedMessages(source.messages.slice(0, anchorIndex + 1) as ChatMessage[]),
      createdAt: now,
      updatedAt: now,
      manualTitle: true,
      authMode: source.authMode,
      providerId: source.providerId,
      selectedModel: source.selectedModel,
      reasoningStrength: source.reasoningStrength,
      temperature: source.temperature,
      targetProjectId: source.targetProjectId,
      agentId: source.agentId,
      // Forks are plain conversations - group/channel runtime identity is not inherited.
      documentWorkspace: source.documentWorkspace,
      folderWorkspace: source.folderWorkspace,
      forkedFromConversationId: sourceId,
      forkedFromMessageId: messageId,
      rootConversationId: source.rootConversationId ?? sourceId,
      forkDepth: (source.forkDepth ?? 0) + 1,
      forkedAt: now
    })))

    await loadConversations()
    await loadConversation(newId)
    return newId
  }

  /** Build the prepared resend from an edited text, preserving images/attachments. */
  function buildPreparedFromEdited (original: ChatMessage, editedText: string): PreparedUserMessage {
    const imageParts = Array.isArray(original.content)
      ? original.content.filter(part => part.type === 'image_url' && part.image_url)
      : []

    const content = imageParts.length > 0
      ? [{ type: 'text', text: editedText } as { type: string; text?: string; image_url?: { url: string } }, ...imageParts]
      : editedText

    // Keep display-only blocks (attachments); refresh the text content block.
    const preservedBlocks = (original.blocks || []).filter(block => block.kind !== 'content')
    const displayContent = imageParts.length > 0 ? [...imageParts] : editedText
    const contentBlock: ChatMessageBlock = {
      id: generateId(),
      kind: 'content',
      content: displayContent as ChatMessage['content']
    }

    return {
      id: original.id || generateId(),
      content: content as ChatMessage['content'],
      blocks: [contentBlock, ...preservedBlocks],
      text: editedText
    }
  }

  /**
   * Apply an edit and resend: 'fork' keeps the source conversation and runs
   * the edited message in a new branch; 'inplace' truncates the current
   * conversation at the anchor and reruns there.
   */
  async function submitEdit (messageId: string, editedText: string, mode: EditResendMode): Promise<void> {
    const trimmed = editedText.trim()
    if (!trimmed) return
    if (isBranchingBlocked()) return

    const anchorIndex = resolveMessageIndexById(messageId)
    if (anchorIndex < 0) return
    const original = messages.value[anchorIndex]
    if (!isMessageBranchable(original)) return

    editingMessageId.value = null
    const prepared = buildPreparedFromEdited(original, trimmed)

    if (mode === 'fork') {
      // Fork copies the prefix including the ORIGINAL anchor message; drop it
      // so the resend appends the edited version instead.
      const newId = await forkFromMessage(messageId)
      if (!newId) return
      const lastMessage = messages.value[messages.value.length - 1]
      if (lastMessage && lastMessage.id === messageId) {
        messages.value.pop()
      }
      await sendMessage(prepared)
      return
    }

    // In-place: destructive, confirm first. File/command side effects that
    // already happened in the truncated tail are NOT rolled back.
    const conversationId = currentConversationId.value
    if (!conversationId) return
    const removedCount = messages.value.length - anchorIndex
    const replyCount = messages.value.slice(anchorIndex + 1).filter(message => message.role === 'assistant').length
    if (!window.confirm(t('chatUi.editInPlaceConfirm', { messages: removedCount, replies: replyCount }))) {
      return
    }

    const snapshot = [...messages.value]
    messages.value = messages.value.slice(0, anchorIndex)
    // Persist the truncation before the new stream starts so a crash cannot
    // resurrect the removed tail.
    await saveConversation(conversationId, messages.value)
    try {
      await sendMessage(prepared)
    } catch (err) {
      console.warn('[chat] In-place resend failed, restoring previous messages:', (err as Error).message)
      messages.value = snapshot
      await saveConversation(conversationId, snapshot)
    }
  }

  /** Number of direct forks of a conversation (sidebar badge, PRD R2). */
  function getConversationForkCount (conversationId: string | null | undefined): number {
    if (!conversationId) return 0
    return conversations.value.filter(conversation => conversation.forkedFromConversationId === conversationId).length
  }

  return {
    editingMessageId,
    cancelEditMessage,
    forkFromMessage,
    getConversationForkCount,
    getMessageEditableText,
    isBranchingBlocked,
    isMessageBranchable,
    resolveMessageIndexById,
    startEditMessage,
    submitEdit
  }
}
