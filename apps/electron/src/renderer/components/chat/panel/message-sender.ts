import type { Ref } from 'vue'
import type { ComposerTranslation } from 'vue-i18n'
import {
  buildUploadedFilesPrompt,
  extractCodeTagRefs,
  extractDocumentTagRefs,
  extractProjectTagRefs
} from './attachment-utils'
import { extractDocfileTagRefs } from '../../../../shared/document-context-tag.js'
import type { ActiveCodeViewContext } from '../../../../shared/folder-workspace-types.js'
import {
  getSelectionQuoteText,
  pruneSelectionQuotes,
  SELECTION_QUOTE_TAG_PATTERN
} from './selection-quote-state'
import {
  buildWebQuotesPrompt,
  extractWebQuoteRefs,
  pruneWebQuotes,
  WEB_QUOTE_TAG_PATTERN
} from './web-quote-state'
import {
  appendFinalContentBlock,
  createAttachmentBlock,
  createContentBlock,
  createFilePreviewBlock,
  createThinkingBlock,
  createToolBlock,
  createToolRun,
  createWebFetchBlock,
  createWebSearchBlock,
  closeOpenThinkingBlocks,
  ensureBlocks,
  ensureStreamingContentBlock,
  ensureThinkingBlock,
  findLastRunningToolRun,
  generateId,
  getLastActivePreviewBlock,
  positionGroupMetaBlocks,
  setAssistantErrorState,
  syncLegacyToolRuns,
  syncTodoBlock,
  appendGroupDirectReplyBlock,
  appendGroupPeerMessageBlock,
  appendGroupUserInjectionBlock,
  upsertAgentSidechatBlock,
  upsertGroupBoardBlock,
  upsertGroupCollaborationPlanBlock,
  upsertGroupProgressBlock,
  upsertGroupTranscriptBlock
} from './message-blocks'
import {
  finalizePendingAuthBlocks,
  findLatestAssistantMessage,
  getMessageTextContent,
  hasRenderableContent,
  markAssistantMessageStopped,
  type AssistantStopCopy
} from './message-runtime'
import {
  buildCurrentFolderWorkspaceState,
  buildOutgoingMessagesWithDocumentWorkspaceContext
} from '../../workspace/workspace-store'
import { codingStatusForCancelledRun, type CodingDiffState, type CodingStatus } from '../../../../shared/coding-status-types.js'
import {
  flushCodingStateSave,
  saveCodingStateNow,
  scheduleCodingStateSave
} from './coding-status-storage'
import type {
  AIExecutionAuthMode,
  BackgroundStreamState,
  ChatMessage,
  ChatMessageBlock,
  ChatPanelProps,
  FilePreviewState,
  PendingAttachment,
  PendingImage,
  ReasoningStrength,
  ToolRun,
  WebFetchResultEntry
} from './types'

interface ChatMessageSenderOptions {
  t: ComposerTranslation
  getActivePageContext: () => ChatPanelProps['activePageContext']
  getActiveTerminalContext: () => ChatPanelProps['activeTerminalContext']
  /** 当前代码查看上下文（文件 + 勾选行区间），随请求带给 AI。 */
  getActiveCodeContext: () => ActiveCodeViewContext | null
  messages: Ref<ChatMessage[]>
  inputText: Ref<string>
  currentConversationId: Ref<string | null>
  targetProjectId: Ref<string | null>
  currentAuthMode: Ref<AIExecutionAuthMode>
  reasoningStrength: Ref<ReasoningStrength>
  conversationTemperature: Ref<number | null>
  pendingImages: Ref<PendingImage[]>
  pendingFiles: Ref<PendingAttachment[]>
  computerUseEnabled: Ref<boolean>
  isUploadingFiles: Ref<boolean>
  uploadFeedback: Ref<string>
  filePreview: Ref<FilePreviewState>
  selectedAgentId: Ref<string>
  selectedGroupId: Ref<string>
  selectedChannelBindingId: Ref<string>
  activeProviderId: Ref<string>
  selectedModel: Ref<string>
  isLoading: Readonly<Ref<boolean>>
  shouldUseConversationProviderOverride: Readonly<Ref<boolean>>
  currentModelLabel: Readonly<Ref<string>>
  streamingConversationIds: Set<string>
  activeCleanups: Map<string, () => void>
  activeStreamSessionIds: Map<string, string>
  activeGroupSessionIds: Set<string>
  backgroundStreamMessages: Map<string, BackgroundStreamState>
  unreadConversationIds: Set<string>
  codingStatusByConversation: Map<string, CodingStatus>
  codingDiffByConversation: Map<string, CodingDiffState>
  setConversationTarget: (conversationId: string, projectId: string | null | undefined) => void
  resolveAssistantSpeakerName: (sourceText: string) => string
  saveConversation: (conversationId: string, messages: ChatMessage[], options?: { refreshSidebar?: boolean }) => Promise<void>
  resetTransientStreamState: () => void
  /** Drops ask-user panels that can no longer be answered once a stream ends. */
  clearPendingAskUserRequests: (conversationId?: string | null) => void
}

const DOCUMENT_TAG_PATTERN = /\[\[doc:([A-Za-z0-9_-]+)(?:\|([^\]]*))?\]\]/g
const PROJECT_TAG_PATTERN = /\[\[project:([^\]|]+)(?:\|([^\]]*))?\]\]/g
const CODE_TAG_PATTERN = /\[\[code:([^\]#|]+)#L(\d+)(?:-L?(\d+))?(?:\|([^\]]*))?\]\]/g
const LEGACY_FILE_PREVIEW_STAGE = '\u6587\u4ef6\u9884\u89c8'
const STREAM_RENDER_FLUSH_INTERVAL_MS = 50

/**
 * A user message built outside the composer - used by edit & resend, so the
 * edited message re-enters the exact same streaming pipeline as a fresh send.
 */
export interface PreparedUserMessage {
  /** Stable message id (editing reuses the original anchor id). */
  id: string
  /** Model-visible content (string, or parts when images are present). */
  content: ChatMessage['content']
  /** Display blocks for the user bubble. */
  blocks?: ChatMessageBlock[]
  /** Plain text used for assistant speaker-name resolution. */
  text: string
}

export interface SendMessageOptions {
  /** Optional coding root for this run; work mode itself is chosen by the model. */
  codingWorkspaceRoot?: string | null
}

export function extractSelectionQuoteRefs (text: string, pattern: RegExp): { quoteIds: string[]; normalizedText: string } {
  const quoteIds: string[] = []
  const normalizedText = text.replace(pattern, (_match, quoteId: string, rawLabel?: string) => {
    if (!quoteIds.includes(quoteId)) quoteIds.push(quoteId)
    const label = rawLabel?.trim() || '对话引用'
    return `对话引用「${label}」`
  }).replace(/\n{3,}/g, '\n\n')

  return { quoteIds, normalizedText }
}

/** Builds the prompt block that carries quoted conversation text into the model context. */
export function buildSelectionQuotesPrompt (quoteIds: string[]): string {
  const blocks: string[] = []
  for (const id of quoteIds) {
    const text = getSelectionQuoteText(id)
    if (!text) continue
    blocks.push(`【引用的对话片段】\n${text}\n【引用片段结束】`)
  }
  return blocks.join('\n\n')
}

export function createChatMessageSender (options: ChatMessageSenderOptions) {
  const {
    t,
    getActivePageContext,
    getActiveTerminalContext,
    getActiveCodeContext,
    messages,
    inputText,
    currentConversationId,
    targetProjectId,
    currentAuthMode,
    reasoningStrength,
    conversationTemperature,
    pendingImages,
    pendingFiles,
    computerUseEnabled,
    isUploadingFiles,
    uploadFeedback,
    filePreview,
    selectedAgentId,
    selectedGroupId,
    selectedChannelBindingId,
    activeProviderId,
    selectedModel,
    isLoading,
    shouldUseConversationProviderOverride,
    currentModelLabel,
    streamingConversationIds: streamingConvIds,
    activeCleanups,
    activeStreamSessionIds,
    activeGroupSessionIds,
    backgroundStreamMessages,
    unreadConversationIds,
    codingStatusByConversation,
    codingDiffByConversation,
    setConversationTarget,
    resolveAssistantSpeakerName,
    saveConversation: doSaveConversation,
    resetTransientStreamState,
    clearPendingAskUserRequests
  } = options

  const getAssistantStopCopy = (): AssistantStopCopy => ({
    stage: t('chatUi.toolStageStopped'),
    detail: t('chatUi.generationStoppedByUser'),
    content: t('chatUi.stoppedMessage')
  })
  const getNoResponseText = () => t('chatUi.noResponse')

  const persistCodingState = (convId: string): void => {
    scheduleCodingStateSave(convId, {
      status: codingStatusByConversation.get(convId) ?? null,
      diff: codingDiffByConversation.get(convId) ?? null
    })
  }

  function releaseStreamSession (convId: string, sessionId: string): void {
    const cleanup = activeCleanups.get(sessionId)
    if (cleanup) {
      cleanup()
      activeCleanups.delete(sessionId)
    }

    if (activeStreamSessionIds.get(convId) !== sessionId) return
    activeStreamSessionIds.delete(convId)
    activeGroupSessionIds.delete(sessionId)
    streamingConvIds.delete(convId)
    backgroundStreamMessages.delete(convId)
    // If a stream wraps up while the user is looking at a different conversation,
    // surface an unread badge on the originating conversation so they notice that
    // it has new output. Streaming sessions tied to the active conversation are
    // already visible, so we don't badge those.
    if (currentConversationId.value !== convId) {
      unreadConversationIds.add(convId)
    }
  }

  async function stopCurrentStream (conversationId?: string) {
    const convId = conversationId || currentConversationId.value
    if (!window.electronAPI || !convId) return
    const sessionId = activeStreamSessionIds.get(convId)
    if (!sessionId) return
    const isForeground = currentConversationId.value === convId
    const targetMessages = isForeground ? messages.value : null

    try {
      await window.electronAPI.stopChatStream(sessionId)
    } catch (err) {
      console.warn('[chat] Failed to request stream stop:', (err as Error).message)
    }

    // Reflect the user's stop immediately; the harness may emit its own
    // cancelled status after the listener has already been torn down.
    const currentStatus = codingStatusByConversation.get(convId)
    const cancelledStatus = codingStatusForCancelledRun(currentStatus)
    if (cancelledStatus && cancelledStatus !== currentStatus) {
      codingStatusByConversation.set(convId, cancelledStatus)
    }
    if (cancelledStatus) {
      saveCodingStateNow(convId, {
        status: cancelledStatus,
        diff: codingDiffByConversation.get(convId) ?? null
      })
    }

    if (!streamingConvIds.has(convId)) return
    // Background streams finalize through their own event handler, which owns
    // the assistant message object and its save target.
    if (!isForeground || !targetMessages) return

    const assistantMessage = findLatestAssistantMessage(targetMessages)
    if (assistantMessage) {
      markAssistantMessageStopped(assistantMessage, getAssistantStopCopy())
    }

    releaseStreamSession(convId, sessionId)
    resetTransientStreamState()
    void doSaveConversation(convId, targetMessages)
  }

  /**
   * Retry the last coding request through the normal send path: truncate the
   * failed turn, then re-send the same user message so the runner starts a
   * fresh stream instead of inventing a second runtime.
   */
  async function retryLastUserMessage (conversationId?: string): Promise<void> {
    const convId = conversationId || currentConversationId.value
    if (!convId || convId !== currentConversationId.value) return
    if (isLoading.value || isUploadingFiles.value) return

    let lastUserIndex = -1
    for (let index = messages.value.length - 1; index >= 0; index -= 1) {
      if (messages.value[index].role === 'user') {
        lastUserIndex = index
        break
      }
    }
    if (lastUserIndex < 0) return

    const original = messages.value[lastUserIndex]
    const prepared: PreparedUserMessage = {
      id: original.id || generateId(),
      content: original.content,
      blocks: original.blocks && original.blocks.length > 0 ? original.blocks : undefined,
      text: getMessageTextContent(original.content)
    }
    const snapshot = [...messages.value]
    messages.value = messages.value.slice(0, lastUserIndex)

    try {
      await doSaveConversation(convId, messages.value)
      await sendMessage(prepared)
    } catch (err) {
      console.warn('[chat] Retry failed, restoring previous messages:', (err as Error).message)
      messages.value = snapshot
      await doSaveConversation(convId, snapshot)
    }
  }

  async function sendMessage (prepared?: PreparedUserMessage, sendOptions?: SendMessageOptions) {
    if (isLoading.value || isUploadingFiles.value) return

    let messageContent: ChatMessage['content']
    let text: string
    const userBlocks: ChatMessageBlock[] = []

    if (prepared) {
      messageContent = prepared.content
      if (prepared.blocks && prepared.blocks.length > 0) {
        userBlocks.push(...prepared.blocks)
      }
      text = prepared.text
    } else {
      const composerText = inputText.value.trim()
      if (!composerText && pendingImages.value.length === 0 && pendingFiles.value.length === 0) return

      const filePrompt = buildUploadedFilesPrompt(pendingFiles.value)
      const { projectId: taggedProjectId, normalizedText: textAfterProject } = extractProjectTagRefs(composerText, PROJECT_TAG_PATTERN)
      if (taggedProjectId && !targetProjectId.value) {
        targetProjectId.value = taggedProjectId
        setConversationTarget(currentConversationId.value || '', taggedProjectId)
      }
      const { regionIds: referencedDocumentRegionIds, normalizedText: textAfterDocuments } = extractDocumentTagRefs(textAfterProject, DOCUMENT_TAG_PATTERN)
      const docfileExtract = extractDocfileTagRefs(textAfterDocuments)
      const codeExtract = extractCodeTagRefs(docfileExtract.normalizedText, CODE_TAG_PATTERN)
      const quoteExtract = extractSelectionQuoteRefs(codeExtract.normalizedText, SELECTION_QUOTE_TAG_PATTERN)
      const webQuoteExtract = extractWebQuoteRefs(quoteExtract.normalizedText, WEB_QUOTE_TAG_PATTERN)
      const normalizedText = webQuoteExtract.normalizedText

      let docSelectionsPrompt = ''
      if (referencedDocumentRegionIds.length > 0 && window.electronAPI?.buildDocumentSelectionsPrompt) {
        try {
          docSelectionsPrompt = await window.electronAPI.buildDocumentSelectionsPrompt(referencedDocumentRegionIds)
        } catch { /* ignore */ }
      }

      let docfileContextPrompt = ''
      if (docfileExtract.artifactIds.length > 0 && window.electronAPI?.buildDocumentFileContextPrompt) {
        try {
          docfileContextPrompt = await window.electronAPI.buildDocumentFileContextPrompt(docfileExtract.artifactIds)
        } catch { /* ignore */ }
      }

      const quotesPrompt = buildSelectionQuotesPrompt(quoteExtract.quoteIds)
      pruneSelectionQuotes([])

      const webQuotesPrompt = buildWebQuotesPrompt(webQuoteExtract.quoteIds)
      pruneWebQuotes([])

      const combinedText = [quotesPrompt, webQuotesPrompt, normalizedText, filePrompt, docSelectionsPrompt, docfileContextPrompt].filter(Boolean).join('\n\n')

      if (normalizedText) {
        userBlocks.push(createContentBlock(normalizedText))
      }
      for (const file of pendingFiles.value) {
        userBlocks.push(createAttachmentBlock(file))
      }

      if (pendingImages.value.length > 0) {
        const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
        if (combinedText) {
          parts.push({ type: 'text', text: combinedText })
        }
        for (const img of pendingImages.value) {
          parts.push({ type: 'image_url', image_url: { url: img.base64 } })
        }
        messageContent = parts
        userBlocks.push(createContentBlock(parts.filter(part => part.type === 'image_url')))
      } else {
        messageContent = combinedText
      }

      text = normalizedText
    }

    const convId = currentConversationId.value || generateId()
    currentConversationId.value = convId

    messages.value.push({
      role: 'user',
      id: prepared?.id ?? generateId(),
      content: messageContent,
      blocks: userBlocks.length > 0 ? userBlocks : undefined
    })
    if (!prepared) {
      inputText.value = ''
      pendingImages.value = []
      pendingFiles.value = []
      uploadFeedback.value = ''
    }
    resetTransientStreamState()

    const assistantSpeakerName = resolveAssistantSpeakerName(text)

    messages.value.push({
      role: 'assistant',
      id: generateId(),
      content: '',
      thinking: '',
      speakerName: assistantSpeakerName,
      modelLabel: currentModelLabel.value,
      toolRuns: [],
      blocks: []
    })

    const targetMessages = messages.value
    const assistantMessage = targetMessages[targetMessages.length - 1]
    const sessionId = generateId()
    let thinkingAccum = ''
    let contentAccum = ''
    const toolRuns: ToolRun[] = []
    let pendingThinkingText = ''
    let pendingContentText = ''
    let streamFlushTimer: number | null = null
    // Persist the assistant turn incrementally while streaming: the turn used
    // to be saved only when the stream ended cleanly, so quitting or reloading
    // mid-run discarded everything generated after the user message.
    const STREAM_SAVE_INTERVAL_MS = 3000
    let streamSaveTimer: number | null = null
    let streamSaveDirty = false

    const clearPendingStreamSave = () => {
      if (streamSaveTimer != null) {
        window.clearTimeout(streamSaveTimer)
        streamSaveTimer = null
      }
      streamSaveDirty = false
    }

    const scheduleStreamingSave = () => {
      streamSaveDirty = true
      if (streamSaveTimer != null) return
      streamSaveTimer = window.setTimeout(() => {
        streamSaveTimer = null
        if (!streamSaveDirty || !streamingConvIds.has(convId)) return
        streamSaveDirty = false
        flushPendingStreamText()
        void doSaveConversation(convId, targetMessages, { refreshSidebar: false })
      }, STREAM_SAVE_INTERVAL_MS)
    }

    const syncAssistantToolRuns = () => {
      syncLegacyToolRuns(assistantMessage, toolRuns)
    }

    const clearPendingStreamFlush = () => {
      if (streamFlushTimer != null) {
        window.clearTimeout(streamFlushTimer)
        streamFlushTimer = null
      }
    }

    let hadToolSinceLastThinking = false

    const flushPendingStreamText = () => {
      clearPendingStreamFlush()

      if (pendingThinkingText) {
        // When thinking arrives after tool calls, start a new thinking block
        // for the current iteration instead of appending to the previous one.
        if (hadToolSinceLastThinking) {
          thinkingAccum = ''
          hadToolSinceLastThinking = false
        }
        thinkingAccum += pendingThinkingText
        assistantMessage.thinking = thinkingAccum
        const thinkingBlock = ensureThinkingBlock(assistantMessage)
        thinkingBlock.text = thinkingAccum
        pendingThinkingText = ''
      }

      if (pendingContentText) {
        contentAccum += pendingContentText
        assistantMessage.content = contentAccum
        const contentBlock = ensureStreamingContentBlock(assistantMessage)
        const existingBlockContent = typeof contentBlock.content === 'string' ? contentBlock.content : ''
        contentBlock.content = `${existingBlockContent}${pendingContentText}`
        pendingContentText = ''
      }
    }

    const schedulePendingStreamFlush = () => {
      if (streamFlushTimer != null) return

      streamFlushTimer = window.setTimeout(() => {
        streamFlushTimer = null
        flushPendingStreamText()
      }, STREAM_RENDER_FLUSH_INTERVAL_MS)
    }

    const enqueueThinkingText = (chunk: string) => {
      pendingThinkingText += chunk
      schedulePendingStreamFlush()
    }

    const enqueueContentText = (chunk: string) => {
      pendingContentText += chunk
      schedulePendingStreamFlush()
    }

    const ensureActiveToolRun = (name = t('chatUi.toolStageRunning')) => {
      const existing = findLastRunningToolRun(toolRuns, name) || findLastRunningToolRun(toolRuns)
      if (existing) return existing
      const created = createToolRun(name)
      toolRuns.push(created)
      syncAssistantToolRuns()
      return created
    }

    streamingConvIds.add(convId)
    activeStreamSessionIds.set(convId, sessionId)

    // Persist the user message right away so a brand-new conversation shows up
    // in the sidebar while the response is still streaming, not only after the
    // run finishes. The empty assistant placeholder is excluded from this save;
    // the stream's final save owns the assistant turn.
    void doSaveConversation(convId, targetMessages.slice(0, -1))

    try {
      if (window.electronAPI) {
        const cleanup = window.electronAPI.onStreamEvent(sessionId, (event) => {
          const isForeground = currentConversationId.value === convId
          scheduleStreamingSave()
          const finishSession = (saveConversation = false) => {
            flushPendingStreamText()
            clearPendingStreamSave()
            flushCodingStateSave(convId)
            releaseStreamSession(convId, sessionId)
            // No pending panel of this conversation can be answered by the
            // model anymore; keep stale panels from stacking above the input.
            clearPendingAskUserRequests(convId)
            if (saveConversation) {
              void doSaveConversation(convId, targetMessages)
            }
            if (isForeground) {
              resetTransientStreamState()
            }
          }

          try {
            if (event.type === 'thinking' && event.content) {
              enqueueThinkingText(event.content)
            } else if (event.type === 'reset') {
              flushPendingStreamText()
              thinkingAccum = ''
              contentAccum = typeof assistantMessage.content === 'string' ? assistantMessage.content : ''
              if (isForeground) {
                resetTransientStreamState()
              }
            } else if (event.type === 'token' && event.content) {
              enqueueContentText(event.content)
            } else if (event.type === 'file_preview_start' && event.filePath) {
              flushPendingStreamText()
              const filePreviewStage = t('chatUi.toolStageFilePreview')
              const activeToolRun = ensureActiveToolRun(t('chatUi.toolStageFileGeneration'))
              const alreadyLogged = activeToolRun.progress.some(step => (step.stage === filePreviewStage || step.stage === LEGACY_FILE_PREVIEW_STAGE) && step.detail === event.filePath)
              if (!alreadyLogged) {
                activeToolRun.progress.push({ stage: filePreviewStage, detail: event.filePath })
                syncAssistantToolRuns()
              }
              const messageBlocks = ensureBlocks(assistantMessage)
              const lastBlock = messageBlocks[messageBlocks.length - 1]
              if (lastBlock && lastBlock.kind === 'file_preview' && lastBlock.filePath === event.filePath) {
                // Consecutive writes to the same file update the card in place
                // instead of stacking duplicate rows.
                lastBlock.active = true
                lastBlock.lineCount = 0
                lastBlock.added = 0
                lastBlock.removed = 0
              } else {
                messageBlocks.push(createFilePreviewBlock(event.filePath))
              }
              if (isForeground) {
                filePreview.value = {
                  active: true,
                  filePath: event.filePath,
                  lineCount: 0,
                  added: 0,
                  removed: 0
                }
              }
            } else if (event.type === 'file_preview_end') {
              const lineCount = Number(event.lineCount ?? 0)
              const added = Number(event.added ?? 0)
              const removed = Number(event.removed ?? 0)
              const previewBlock = getLastActivePreviewBlock(assistantMessage, event.filePath)
              if (previewBlock) {
                previewBlock.active = false
                previewBlock.lineCount = lineCount
                previewBlock.added = added
                previewBlock.removed = removed
              }
              if (isForeground && filePreview.value.filePath === event.filePath) {
                filePreview.value = {
                  ...filePreview.value,
                  active: false,
                  lineCount,
                  added,
                  removed
                }
              }
            } else if (event.type === 'web_search_result' && event.query) {
              flushPendingStreamText()
              ensureBlocks(assistantMessage).push(createWebSearchBlock(event.query, event.engine || 'web', Array.isArray(event.results) ? event.results : []))
            } else if (event.type === 'web_fetch_result' && event.result) {
              flushPendingStreamText()
              ensureBlocks(assistantMessage).push(createWebFetchBlock(event.result as WebFetchResultEntry, event.query))
            } else if (event.type === 'group_collaboration_plan' && event.plan) {
              flushPendingStreamText()
              upsertGroupCollaborationPlanBlock(assistantMessage, event.plan)
            } else if (event.type === 'group_session_state' && event.groupId) {
              flushPendingStreamText()
              if (event.active) activeGroupSessionIds.add(sessionId)
              else activeGroupSessionIds.delete(sessionId)
            } else if (event.type === 'group_progress' && event.groupProgress) {
              flushPendingStreamText()
              upsertGroupProgressBlock(assistantMessage, event.groupProgress)
            } else if (event.type === 'agent_sidechat' && event.sidechat) {
              flushPendingStreamText()
              upsertAgentSidechatBlock(assistantMessage, event.sidechat)
            } else if (event.type === 'group_transcript' && event.transcript) {
              flushPendingStreamText()
              upsertGroupTranscriptBlock(assistantMessage, event.transcript)
            } else if (event.type === 'group_board' && event.board) {
              flushPendingStreamText()
              upsertGroupBoardBlock(assistantMessage, event.board)
            } else if (event.type === 'group_direct_reply' && event.directReply) {
              flushPendingStreamText()
              appendGroupDirectReplyBlock(assistantMessage, event.directReply)
            } else if (event.type === 'group_user_injection' && event.injection) {
              flushPendingStreamText()
              appendGroupUserInjectionBlock(assistantMessage, event.injection)
            } else if (event.type === 'group_peer_message' && event.peerMessage) {
              flushPendingStreamText()
              appendGroupPeerMessageBlock(assistantMessage, event.peerMessage)
            } else if (event.type === 'coding_status' && event.codingStatus) {
              codingStatusByConversation.set(convId, event.codingStatus)
              persistCodingState(convId)
            } else if (event.type === 'coding_diff' && event.codingDiff) {
              codingDiffByConversation.set(convId, event.codingDiff)
              persistCodingState(convId)
            } else if (event.type === 'tool_start' && event.name) {
              flushPendingStreamText()
              hadToolSinceLastThinking = true
              closeOpenThinkingBlocks(assistantMessage)
              const toolRun = createToolRun(event.name, event.filePath)
              if (event.summary) toolRun.summary = event.summary
              toolRuns.push(toolRun)
              ensureBlocks(assistantMessage).push(createToolBlock(toolRun))
              syncAssistantToolRuns()
            } else if (event.type === 'todo_update' && Array.isArray(event.items)) {
              flushPendingStreamText()
              syncTodoBlock(assistantMessage, event.items)
            } else if (event.type === 'progress' && event.stage) {
              flushPendingStreamText()
              const activeToolRun = ensureActiveToolRun()
              activeToolRun.progress.push({ stage: event.stage, detail: event.detail })
              syncAssistantToolRuns()
            } else if (event.type === 'tool_end') {
              flushPendingStreamText()
              const activeToolRun = findLastRunningToolRun(toolRuns, event.name) || findLastRunningToolRun(toolRuns)
              if (activeToolRun) {
                if (event.error) {
                  activeToolRun.status = 'failed'
                  activeToolRun.progress.push({ stage: 'error', detail: event.error })
                } else {
                  activeToolRun.status = 'completed'
                }
                activeToolRun.endedAt = Date.now()
                syncAssistantToolRuns()
              }
            } else if (event.type === 'done') {
              try {
                flushPendingStreamText()
                closeOpenThinkingBlocks(assistantMessage)
                for (const toolRun of toolRuns) {
                  if (toolRun.status === 'running') {
                    toolRun.status = 'completed'
                    toolRun.endedAt = Date.now()
                  }
                }
                finalizePendingAuthBlocks(assistantMessage)
                syncAssistantToolRuns()

                if (event.message?.content !== undefined) {
                  assistantMessage.content = event.message.content
                  contentAccum = typeof event.message.content === 'string' ? event.message.content : ''
                  appendFinalContentBlock(assistantMessage, event.message.content)
                }
                if (!hasRenderableContent(assistantMessage)) {
                  const noResponseText = getNoResponseText()
                  assistantMessage.content = noResponseText
                  contentAccum = noResponseText
                  ensureBlocks(assistantMessage).push(createContentBlock(noResponseText))
                }
                if (event.thinking && !assistantMessage.thinking) {
                  assistantMessage.thinking = event.thinking
                  thinkingAccum = event.thinking
                  ensureBlocks(assistantMessage).push(createThinkingBlock(event.thinking))
                }
                positionGroupMetaBlocks(assistantMessage)
              } finally {
                finishSession(true)
              }
            } else if (event.type === 'error') {
              try {
                flushPendingStreamText()
                closeOpenThinkingBlocks(assistantMessage)
                const activeToolRun = findLastRunningToolRun(toolRuns)
                if (activeToolRun) {
                  activeToolRun.status = 'failed'
                  activeToolRun.endedAt = Date.now()
                  activeToolRun.progress.push({ stage: t('chatUi.toolStageError'), detail: event.error })
                  syncAssistantToolRuns()
                }
                finalizePendingAuthBlocks(assistantMessage)
                setAssistantErrorState(assistantMessage, event.error || t('chatUi.streamFailedUnknown'), getMessageTextContent)
              } finally {
                // Save the partially generated turn plus the error state:
                // losing streamed content on a failed stream reads as data
                // loss after a reload.
                finishSession(true)
              }
            } else if (event.type === 'stopped') {
              try {
                flushPendingStreamText()
                closeOpenThinkingBlocks(assistantMessage)
                markAssistantMessageStopped(assistantMessage, getAssistantStopCopy())
                syncAssistantToolRuns()
              } finally {
                finishSession(true)
              }
            }
          } catch (err) {
            flushPendingStreamText()
            closeOpenThinkingBlocks(assistantMessage)
            console.error('[chat] Failed to handle stream event:', event, err)

            const activeToolRun = findLastRunningToolRun(toolRuns)
            if (activeToolRun) {
              activeToolRun.status = 'failed'
              activeToolRun.endedAt = Date.now()
              activeToolRun.progress.push({ stage: t('chatUi.toolStageRenderError'), detail: (err as Error).message })
              syncAssistantToolRuns()
            }

            finalizePendingAuthBlocks(assistantMessage)
            setAssistantErrorState(assistantMessage, (err as Error).message, getMessageTextContent)
            finishSession(true)
          }
        })

        activeCleanups.set(sessionId, cleanup)
        activeGroupSessionIds.delete(sessionId)

        const chatMessages = JSON.parse(JSON.stringify(await buildOutgoingMessagesWithDocumentWorkspaceContext(targetMessages.slice(0, -1))))
        if (activeStreamSessionIds.get(convId) !== sessionId || !streamingConvIds.has(convId)) {
          cleanup()
          activeCleanups.delete(sessionId)
          return
        }
        await window.electronAPI.chatStream(
          chatMessages,
          sessionId,
          convId,
          shouldUseConversationProviderOverride.value ? (activeProviderId.value || undefined) : undefined,
          shouldUseConversationProviderOverride.value ? (selectedModel.value || undefined) : undefined,
          targetProjectId.value ?? undefined,
          currentAuthMode.value,
          reasoningStrength.value,
          selectedAgentId.value || undefined,
          selectedGroupId.value || undefined,
          selectedChannelBindingId.value || undefined,
          getActivePageContext() ?? undefined,
          conversationTemperature.value ?? undefined,
          buildCurrentFolderWorkspaceState()?.rootPath,
          computerUseEnabled.value,
          getActiveTerminalContext() ?? undefined,
          getActiveCodeContext() ?? undefined,
          sendOptions?.codingWorkspaceRoot ?? undefined
        )

        if (streamingConvIds.has(convId)) {
          releaseStreamSession(convId, sessionId)
          if (!hasRenderableContent(assistantMessage)) {
            const noResponseText = getNoResponseText()
            assistantMessage.content = noResponseText
            ensureBlocks(assistantMessage).push(createContentBlock(noResponseText))
          }
          finalizePendingAuthBlocks(assistantMessage)
          void doSaveConversation(convId, targetMessages)
          if (currentConversationId.value === convId) {
            resetTransientStreamState()
          }
        }
      } else {
        const chatMessages = JSON.parse(JSON.stringify(await buildOutgoingMessagesWithDocumentWorkspaceContext(targetMessages.slice(0, -1))))
        const res = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: chatMessages })
        })
        const response = await res.json() as { content?: string }
        assistantMessage.content = response.content || getNoResponseText()
        ensureBlocks(assistantMessage).push(createContentBlock(assistantMessage.content))
        finalizePendingAuthBlocks(assistantMessage)
        activeStreamSessionIds.delete(convId)
        activeGroupSessionIds.delete(sessionId)
        streamingConvIds.delete(convId)
        void doSaveConversation(convId, targetMessages)
        if (currentConversationId.value === convId) {
          resetTransientStreamState()
        }
      }
    } catch (err) {
      flushCodingStateSave(convId)
      releaseStreamSession(convId, sessionId)
      setAssistantErrorState(assistantMessage, (err as Error).message, getMessageTextContent)
      finalizePendingAuthBlocks(assistantMessage)
      if (currentConversationId.value === convId) {
        resetTransientStreamState()
      }
    }
  }

  return {
    sendMessage,
    stopCurrentStream,
    retryLastUserMessage
  }
}
