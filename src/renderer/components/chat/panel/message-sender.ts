import type { Ref } from 'vue'
import type { ComposerTranslation } from 'vue-i18n'
import {
  buildUploadedFilesPrompt,
  extractCodeTagRefs,
  extractDocumentTagRefs,
  extractProjectTagRefs
} from './attachment-utils'
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
  upsertAgentSidechatBlock,
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
  messages: Ref<ChatMessage[]>
  inputText: Ref<string>
  currentConversationId: Ref<string | null>
  targetProjectId: Ref<string | null>
  currentAuthMode: Ref<AIExecutionAuthMode>
  reasoningStrength: Ref<ReasoningStrength>
  conversationTemperature: Ref<number | null>
  pendingImages: Ref<PendingImage[]>
  pendingFiles: Ref<PendingAttachment[]>
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
  backgroundStreamMessages: Map<string, BackgroundStreamState>
  unreadConversationIds: Set<string>
  setConversationTarget: (conversationId: string, projectId: string | null | undefined) => void
  resolveAssistantSpeakerName: (sourceText: string) => string
  buildOutgoingMessagesWithDocumentWorkspaceContext: (sourceMessages: ChatMessage[]) => Promise<Array<{ role: string; content: ChatMessage['content'] }>>
  buildCurrentFolderWorkspaceState: () => ConversationFolderWorkspaceState | undefined
  saveConversation: (conversationId: string, messages: ChatMessage[]) => Promise<void>
  resetTransientStreamState: () => void
}

const DOCUMENT_TAG_PATTERN = /\[\[doc:([A-Za-z0-9_-]+)(?:\|([^\]]*))?\]\]/g
const PROJECT_TAG_PATTERN = /\[\[project:([^\]|]+)(?:\|([^\]]*))?\]\]/g
const CODE_TAG_PATTERN = /\[\[code:([^\]#|]+)#L(\d+)(?:-L?(\d+))?(?:\|([^\]]*))?\]\]/g
const LEGACY_FILE_PREVIEW_STAGE = '\u6587\u4ef6\u9884\u89c8'
const STREAM_RENDER_FLUSH_INTERVAL_MS = 50

export function createChatMessageSender (options: ChatMessageSenderOptions) {
  const {
    t,
    getActivePageContext,
    messages,
    inputText,
    currentConversationId,
    targetProjectId,
    currentAuthMode,
    reasoningStrength,
    conversationTemperature,
    pendingImages,
    pendingFiles,
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
    backgroundStreamMessages,
    unreadConversationIds,
    setConversationTarget,
    resolveAssistantSpeakerName,
    buildOutgoingMessagesWithDocumentWorkspaceContext,
    buildCurrentFolderWorkspaceState,
    saveConversation: doSaveConversation,
    resetTransientStreamState
  } = options

  const getAssistantStopCopy = (): AssistantStopCopy => ({
    stage: t('chatUi.toolStageStopped'),
    detail: t('chatUi.generationStoppedByUser'),
    content: t('chatUi.stoppedMessage')
  })
  const getNoResponseText = () => t('chatUi.noResponse')

  function releaseStreamSession (convId: string, sessionId: string): void {
    const cleanup = activeCleanups.get(sessionId)
    if (cleanup) {
      cleanup()
      activeCleanups.delete(sessionId)
    }

    activeStreamSessionIds.delete(convId)
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

  async function stopCurrentStream () {
    if (!window.electronAPI || !currentConversationId.value) return
    const convId = currentConversationId.value
    const targetMessages = messages.value
    const sessionId = activeStreamSessionIds.get(convId)
    if (!sessionId) return

    try {
      await window.electronAPI.stopChatStream(sessionId)
    } catch (err) {
      console.warn('[chat] Failed to request stream stop:', (err as Error).message)
    }

    if (!streamingConvIds.has(convId)) return

    const assistantMessage = findLatestAssistantMessage(targetMessages)
    if (assistantMessage) {
      markAssistantMessageStopped(assistantMessage, getAssistantStopCopy())
    }

    releaseStreamSession(convId, sessionId)
    if (currentConversationId.value === convId) {
      resetTransientStreamState()
    }
    void doSaveConversation(convId, targetMessages)
  }

  async function sendMessage () {
    const text = inputText.value.trim()
    if ((!text && pendingImages.value.length === 0 && pendingFiles.value.length === 0) || isLoading.value || isUploadingFiles.value) return

    let messageContent: ChatMessage['content']
    const filePrompt = buildUploadedFilesPrompt(pendingFiles.value)
    const { projectId: taggedProjectId, normalizedText: textAfterProject } = extractProjectTagRefs(text, PROJECT_TAG_PATTERN)
    if (taggedProjectId && !targetProjectId.value) {
      targetProjectId.value = taggedProjectId
      setConversationTarget(currentConversationId.value || '', taggedProjectId)
    }
    const { regionIds: referencedDocumentRegionIds, normalizedText: textAfterDocuments } = extractDocumentTagRefs(textAfterProject, DOCUMENT_TAG_PATTERN)
    const { normalizedText } = extractCodeTagRefs(textAfterDocuments, CODE_TAG_PATTERN)

    let docSelectionsPrompt = ''
    if (referencedDocumentRegionIds.length > 0 && window.electronAPI?.buildDocumentSelectionsPrompt) {
      try {
        docSelectionsPrompt = await window.electronAPI.buildDocumentSelectionsPrompt(referencedDocumentRegionIds)
      } catch { /* ignore */ }
    }

    const combinedText = [normalizedText, filePrompt, docSelectionsPrompt].filter(Boolean).join('\n\n')
    const userBlocks: ChatMessageBlock[] = []

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

    const convId = currentConversationId.value || generateId()
    currentConversationId.value = convId

    messages.value.push({
      role: 'user',
      content: messageContent,
      blocks: userBlocks.length > 0 ? userBlocks : undefined
    })
    inputText.value = ''
    pendingImages.value = []
    pendingFiles.value = []
    uploadFeedback.value = ''
    resetTransientStreamState()

    const assistantSpeakerName = resolveAssistantSpeakerName(text)

    messages.value.push({
      role: 'assistant',
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

    try {
      if (window.electronAPI) {
        const cleanup = window.electronAPI.onStreamEvent(sessionId, (event) => {
          const isForeground = currentConversationId.value === convId
          const finishSession = (saveConversation = false) => {
            flushPendingStreamText()
            releaseStreamSession(convId, sessionId)
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
              ensureBlocks(assistantMessage).push(createFilePreviewBlock(event.filePath))
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
            } else if (event.type === 'group_progress' && event.groupProgress) {
              flushPendingStreamText()
              upsertGroupProgressBlock(assistantMessage, event.groupProgress)
            } else if (event.type === 'agent_sidechat' && event.sidechat) {
              flushPendingStreamText()
              upsertAgentSidechatBlock(assistantMessage, event.sidechat)
            } else if (event.type === 'group_transcript' && event.transcript) {
              flushPendingStreamText()
              upsertGroupTranscriptBlock(assistantMessage, event.transcript)
            } else if (event.type === 'tool_start' && event.name) {
              flushPendingStreamText()
              hadToolSinceLastThinking = true
              const toolRun = createToolRun(event.name)
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
                activeToolRun.status = 'completed'
                syncAssistantToolRuns()
              }
            } else if (event.type === 'done') {
              try {
                flushPendingStreamText()
                for (const toolRun of toolRuns) {
                  if (toolRun.status === 'running') {
                    toolRun.status = 'completed'
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
                const activeToolRun = findLastRunningToolRun(toolRuns)
                if (activeToolRun) {
                  activeToolRun.status = 'failed'
                  activeToolRun.progress.push({ stage: t('chatUi.toolStageError'), detail: event.error })
                  syncAssistantToolRuns()
                }
                finalizePendingAuthBlocks(assistantMessage)
                setAssistantErrorState(assistantMessage, event.error || t('chatUi.streamFailedUnknown'), getMessageTextContent)
              } finally {
                finishSession()
              }
            } else if (event.type === 'stopped') {
              try {
                flushPendingStreamText()
                markAssistantMessageStopped(assistantMessage, getAssistantStopCopy())
                syncAssistantToolRuns()
              } finally {
                finishSession(true)
              }
            }
          } catch (err) {
            flushPendingStreamText()
            console.error('[chat] Failed to handle stream event:', event, err)

            const activeToolRun = findLastRunningToolRun(toolRuns)
            if (activeToolRun) {
              activeToolRun.status = 'failed'
              activeToolRun.progress.push({ stage: t('chatUi.toolStageRenderError'), detail: (err as Error).message })
              syncAssistantToolRuns()
            }

            finalizePendingAuthBlocks(assistantMessage)
            setAssistantErrorState(assistantMessage, (err as Error).message, getMessageTextContent)
            finishSession(true)
          }
        })

        activeCleanups.set(sessionId, cleanup)

        const chatMessages = JSON.parse(JSON.stringify(await buildOutgoingMessagesWithDocumentWorkspaceContext(targetMessages.slice(0, -1))))
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
          buildCurrentFolderWorkspaceState()?.rootPath
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
        streamingConvIds.delete(convId)
        void doSaveConversation(convId, targetMessages)
        if (currentConversationId.value === convId) {
          resetTransientStreamState()
        }
      }
    } catch (err) {
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
    stopCurrentStream
  }
}
