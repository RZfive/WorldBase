import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { computerUsePermissions } from '../../../utils/computer-use-permissions'
import { createChatAttachmentState } from './attachment-state'
import { createChatAuthorizationState } from './authorization-state'
import { createChatConversationNavigation } from './conversation-navigation'
import { createChatConversationStorage } from './conversation-storage'
import { ensureSharedChatPanelLifecycleBindings } from './lifecycle-bindings'
import { createLongTermGoalState } from './long-term-goal-state'
import { createChatMessageSender } from './message-sender'
import { createChatMessageBranching } from './message-branching'
import { createChatProviderState } from './provider-state'
import { clearCodingState } from './coding-status-storage'
import { getLatestVisibleTodoItems } from './message-runtime'
import { addSelectionQuote } from './selection-quote-state'
import { hydrateCodingStateForConversation, sharedChatPanelState } from './shared-state'
import { createChatSidebarState } from './sidebar-state'
import { createChatWorkspaceOptionsState } from './workspace-options-state'
import { buildActiveCodeViewContext } from '../../workspace/workspace-store'
import type { ChatPanelProps } from './types'
import type { MessageAnnotationLocator, MessageAnnotationTurn } from '../types'

interface UseChatPanelBindings {
  onContextConsumed: () => void
}

export function useChatPanel (props: ChatPanelProps, bindings: UseChatPanelBindings) {
  const { t, locale } = useI18n()
  const formatAttachmentConversationTitle = (attachmentNames: string[]) => {
    const names = attachmentNames.join(t('chatUi.attachmentNameSeparator'))
    return t('chatUi.attachmentConversationTitle', { names })
  }
  const {
    messages,
    inputText,
    conversations,
    conversationsLoaded,
    currentConversationId,
    targetProjectId,
    providers,
    providersConfig,
    activeProviderId,
    selectedModel,
    reasoningStrength,
    conversationTemperature,
    currentAuthMode,
    pendingImages,
    pendingFiles,
    isUploadingFiles,
    uploadFeedback,
    filePreview,
    availableSkills,
    activeSkillIds,
    availableAgents,
    availableAgentGroups,
    availableChannelBindings,
    longTermGoals,
    longTermGoalSnapshot,
    selectedLongTermGoalId,
    longTermGoalWorkspaceActive,
    selectedAgentId,
    selectedGroupId,
    selectedChannelBindingId,
    showSkillPicker,
    planModeActive,
    computerUseEnabled,
    computerUsePermissionGranted,
    syncingProviderOptions
  } = sharedChatPanelState

  const {
    streamingConversationIds: streamingConvIds,
    pendingAuthRequestsByConversation,
    pendingSudoPasswordRequestsByConversation,
    pendingAskUserRequestsByConversation,
    unreadConversationIds,
    backgroundStreamMessages,
    activeCleanups,
    activeStreamSessionIds,
    activeGroupSessionIds,
    codingStatusByConversation,
    codingDiffByConversation,
    conversationTargets
  } = sharedChatPanelState
  const isLoading = computed(() => {
    return currentConversationId.value ? streamingConvIds.has(currentConversationId.value) : false
  })
  const activeGroupSessionId = computed(() => {
    if (!isLoading.value || !currentConversationId.value) return undefined
    const sessionId = activeStreamSessionIds.get(currentConversationId.value)
    return sessionId && activeGroupSessionIds.has(sessionId) ? sessionId : undefined
  })

  const {
    currentAskUserRequest,
    currentPendingAuthCount,
    currentPendingAuthRequest,
    currentPendingSudoPasswordCount,
    currentSudoPasswordRequest,
    clearPendingAskUserRequests,
    getPendingAuthCount,
    handleAskUserCancellation,
    handleAskUserRequest,
    handleAuthRequest,
    handleAuthResolution,
    handleSudoPasswordRequest,
    respondToAskUserRequest,
    respondToAuthRequest,
    respondToSudoPasswordRequest
  } = createChatAuthorizationState({
    currentConversationId,
    messages,
    activeStreamSessionIds,
    backgroundStreamMessages,
    pendingAuthRequestsByConversation,
    pendingSudoPasswordRequestsByConversation,
    pendingAskUserRequestsByConversation,
    unreadConversationIds
  })

  function getUnreadCount (conversationId?: string | null): number {
    if (!conversationId) return 0
    return unreadConversationIds.has(conversationId) ? 1 : 0
  }

  function clearConversationUnread (conversationId: string | null | undefined): void {
    if (!conversationId) return
    unreadConversationIds.delete(conversationId)
  }

  // Whenever the user navigates into a conversation (via load, open, etc.) we clear
  // any unread badge. Hooked here as a backstop for code paths that bypass loadConversation.
  watch(currentConversationId, (id) => {
    if (id) {
      clearConversationUnread(id)
      hydrateCodingStateForConversation(id)
    }
  }, { immediate: true })

  const activeTodoItems = computed(() => getLatestVisibleTodoItems(messages.value, isLoading.value))
  const currentCodingStatus = computed(() => {
    const id = currentConversationId.value
    return id ? codingStatusByConversation.get(id) || null : null
  })
  const currentCodingDiff = computed(() => {
    const id = currentConversationId.value
    return id ? codingDiffByConversation.get(id) || null : null
  })

  const {
    agentSelectorValue,
    agentSidebarItems,
    agentsById,
    conversationSidebarItems,
    currentAgentDefinition,
    currentAssistantIcon,
    currentAssistantName,
    currentContextDetail,
    currentContextLabel,
    currentGroupDefinition,
    currentLongTermGoal,
    currentModelLabel,
    getDefaultAgentId,
    groupMentionHints,
    groupSidebarItems,
    groupsById,
    isGroupConversation,
    longTermGoalSidebarItems,
    nonDefaultAgents,
    providersById,
    resolveAssistantSpeakerName,
    shouldUseConversationProviderOverride
  } = createChatSidebarState({
    t,
    locale,
    conversations,
    providers,
    providersConfig,
    activeProviderId,
    selectedModel,
    availableAgents,
    availableAgentGroups,
    longTermGoals,
    selectedLongTermGoalId,
    selectedAgentId,
    selectedGroupId,
    selectedChannelBindingId,
    currentConversationId,
    streamingConversationIds: streamingConvIds,
    getPendingAuthCount,
    getUnreadCount
  })

  function getPinnedContextTitle (): string | null {
    if (currentGroupDefinition.value) {
      return currentGroupDefinition.value.name
    }

    if (selectedAgentId.value && selectedAgentId.value !== getDefaultAgentId() && currentAgentDefinition.value) {
      return currentAgentDefinition.value.name
    }

    return null
  }

  const {
    loadConversations,
    renameConversation,
    rememberConversationContext,
    updateBackgroundConversationWorkspace,
    saveConversationMetadata,
    saveConversation: doSaveConversation,
    setConversationTarget,
    getConversationProject,
    setConversationProject,
    assignConversationProject
  } = createChatConversationStorage({
    t,
    formatAttachmentConversationTitle,
    conversations,
    conversationsLoaded,
    currentConversationId,
    currentAuthMode,
    activeProviderId,
    selectedModel,
    reasoningStrength,
    conversationTemperature,
    selectedAgentId,
    selectedGroupId,
    selectedChannelBindingId,
    shouldUseConversationProviderOverride,
    conversationTargets,
    getPinnedContextTitle
  })

  const {
    applyProvidersConfig,
    handleAgentSelectionChange,
    handleAuthModeChange,
    handleChannelBindingSelectionChange,
    handleGroupSelectionChange,
    handleModelSelectionChange,
    handleProviderSelectionChange,
    handleProviderModelSelectionChange,
    handleReasoningStrengthChange,
    handleTemperatureChange,
    loadProviders,
    providerDefaultTemperature,
    selectConversationProvider,
    syncProviderSelectionForAgent,
    togglePlanMode
  } = createChatProviderState({
    conversations,
    currentConversationId,
    providers,
    providersConfig,
    activeProviderId,
    selectedModel,
    reasoningStrength,
    conversationTemperature,
    currentAuthMode,
    selectedAgentId,
    selectedGroupId,
    selectedChannelBindingId,
    syncingProviderOptions,
    planModeActive,
    activeStreamSessionIds,
    agentsById,
    providersById,
    getDefaultAgentId,
    saveConversationMetadata
  })

  const {
    addAttachments,
    insertDocumentTag,
    removeFile,
    removeImage
  } = createChatAttachmentState({
    t,
    inputText,
    pendingImages,
    pendingFiles,
    isUploadingFiles,
    uploadFeedback
  })

  const {
    clearSkills,
    loadAgentWorkspaceOptions,
    loadSkills,
    selectAllSkills,
    toggleSkill
  } = createChatWorkspaceOptionsState({
    availableSkills,
    activeSkillIds,
    availableAgents,
    availableAgentGroups,
    availableChannelBindings,
    selectedAgentId,
    selectedGroupId,
    selectedChannelBindingId,
    currentConversationId,
    getDefaultAgentId,
    syncProviderSelectionForAgent
  })

  function resetTransientStreamState () {
    filePreview.value = {
      active: false,
      filePath: '',
      lineCount: 0,
      added: 0,
      removed: 0
    }
  }

  /** Parks the selected conversation text and appends its quote tag to the draft. */
  function addSelectionQuoteToInput (text: string): void {
    const tag = addSelectionQuote(text)
    const current = inputText.value
    inputText.value = current.trim().length > 0 ? `${current.trimEnd()} ${tag}` : tag
  }

  function findMessageForAnnotation (messageId: string | null, messageIndex: number) {
    if (messageId) {
      const byId = messages.value.find(message => message.id === messageId)
      if (byId) return byId
    }
    return messageIndex >= 0 && messageIndex < messages.value.length ? messages.value[messageIndex] : undefined
  }

  function persistAnnotationChange (): void {
    const conversationId = currentConversationId.value
    // While a stream is running its final save owns the file; annotating a
    // settled message is the normal path, so saving here would only race.
    if (!conversationId || streamingConvIds.has(conversationId)) return
    void doSaveConversation(conversationId, messages.value)
  }

  /** Creates the annotation on first ask, then appends/replaces its thread.
      Writes are immutable (new arrays) so annotation consumers re-render
      reliably. Pending ('generating') turns are created with persist=false so
      an app exit mid-flight never persists a stuck generating turn. */
  function upsertAnnotationTurns (payload: { messageId: string | null; messageIndex: number; annotationId: string; text: string; locator?: MessageAnnotationLocator; turns: MessageAnnotationTurn[] }, persist = true): void {
    const message = findMessageForAnnotation(payload.messageId, payload.messageIndex)
    if (!message) return
    const annotations = message.annotations || []
    const nextAnnotations = annotations.some(item => item.id === payload.annotationId)
      ? annotations.map(item => item.id === payload.annotationId
          ? { ...item, text: item.text || payload.text, locator: item.locator || payload.locator, turns: payload.turns }
          : item)
      : [...annotations, {
          id: payload.annotationId,
          text: payload.text,
          locator: payload.locator,
          turns: payload.turns,
          createdAt: Date.now()
        }]
    message.annotations = nextAnnotations
    if (persist) persistAnnotationChange()
  }

  function removeMessageAnnotation (payload: { messageId: string | null; messageIndex: number; annotationId: string }): void {
    const message = findMessageForAnnotation(payload.messageId, payload.messageIndex)
    if (!message?.annotations) return
    message.annotations = message.annotations.filter(item => item.id !== payload.annotationId)
    persistAnnotationChange()
  }

  const {
    conversationDetailError,
    conversationDetailState,
    deleteConversation: deleteConversationRecord,
    loadConversation,
    newConversation,
    startBlankConversation,
    openAgentWorkspaceConversation,
    openGroupWorkspaceConversation,
    prepareLongTermGoalWorkspace,
    startOptimizationConversation,
    startProjectConversation,
    updateFolderWorkspaceState,
    updateWorkspaceTabState
  } = createChatConversationNavigation({
    t,
    messages,
    inputText,
    conversations,
    currentConversationId,
    targetProjectId,
    currentAuthMode,
    reasoningStrength,
    conversationTemperature,
    selectedLongTermGoalId,
    longTermGoalWorkspaceActive,
    selectedAgentId,
    selectedGroupId,
    selectedChannelBindingId,
    pendingImages,
    pendingFiles,
    uploadFeedback,
    activeProviderId,
    selectedModel,
    streamingConversationIds: streamingConvIds,
    backgroundStreamMessages,
    activeStreamSessionIds,
    conversationTargets,
    agentsById,
    groupsById,
    shouldUseConversationProviderOverride,
    getDefaultAgentId,
    clearConversationUnread,
    syncProviderSelectionForAgent,
    selectConversationProvider,
    rememberConversationContext,
    loadConversations,
    saveConversation: doSaveConversation,
    setConversationTarget,
    setConversationProject,
    resetTransientStreamState
  })

  async function deleteConversation (conversationId: string): Promise<void> {
    await deleteConversationRecord(conversationId)
    clearCodingState(conversationId)
    codingStatusByConversation.delete(conversationId)
    codingDiffByConversation.delete(conversationId)
  }

  const {
    answerLongTermGoalIntervention,
    applyLongTermGoalChangeSet,
    applyLongTermGoalCreation,
    archiveLongTermGoal,
    cancelLongTermGoalChangeSet,
    cancelLongTermGoalCreation,
    clearGoalAutoOpenRunId,
    compactLongTermGoalMemory,
    createConversationHistory,
    createLongTermGoal,
    deleteLongTermGoal,
    deleteLongTermGoalMemory,
    goalAutoOpenRunId,
    loadLongTermGoals,
    loadLongTermGoalSnapshot,
    memoryCompaction,
    mergeGoalTitleState,
    openLongTermGoal,
    pauseLongTermGoal,
    pendingCreationConfirm,
    resetLongTermGoalCreation,
    resumeLongTermGoal,
    runLongTermGoalNow,
    saveLongTermGoalPatch,
    sendLongTermGoalMessage,
    startLongTermGoalCreation,
    streamingAdjust,
    streamingCreate,
    streamingReplan,
    streamingRun
  } = createLongTermGoalState({
    t,
    longTermGoals,
    longTermGoalSnapshot,
    selectedLongTermGoalId,
    activeProviderId,
    selectedModel,
    prepareGoalWorkspace: prepareLongTermGoalWorkspace,
    startNewConversation: newConversation
  })

  const { sendMessage, stopCurrentStream, retryLastUserMessage } = createChatMessageSender({
    t,
    getActivePageContext: () => props.activePageContext,
    getActiveTerminalContext: () => props.activeTerminalContext,
    getActiveCodeContext: () => buildActiveCodeViewContext(),
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
    saveConversation: (conversationId, chatMessages, options) => doSaveConversation(conversationId, chatMessages, options),
    resetTransientStreamState,
    clearPendingAskUserRequests
  })

  // Workspace diagnostic tabs live outside this composable; expose the same
  // stop/retry path through shared state instead of duplicating stream logic.
  watch(
    currentConversationId,
    (conversationId) => {
      if (!conversationId) return
      sharedChatPanelState.codingRunActionsByConversation.set(conversationId, {
        cancel: () => stopCurrentStream(conversationId),
        retry: () => retryLastUserMessage(conversationId)
      })
    },
    { immediate: true }
  )

  const {
    editingMessageId,
    cancelEditMessage,
    forkFromMessage,
    startEditMessage,
    submitEdit
  } = createChatMessageBranching({
    t,
    messages,
    currentConversationId,
    conversations,
    streamingConversationIds: streamingConvIds,
    loadConversation,
    loadConversations,
    saveConversation: (conversationId, chatMessages) => doSaveConversation(conversationId, chatMessages),
    sendMessage
  })

  watch(() => props.projectContext, (ctx) => {
    if (!ctx) return

    void startOptimizationConversation(ctx).finally(() => {
      bindings.onContextConsumed()
    })
  }, { immediate: true })

  onMounted(async () => {
    // Bind configuration updates before startup reads can complete out of order.
    ensureSharedChatPanelLifecycleBindings({
      activeProviderId,
      selectedModel,
      longTermGoals,
      longTermGoalSnapshot,
      selectedLongTermGoalId,
      streamingRun,
      applyProvidersConfig,
      handleAuthRequest,
      handleSudoPasswordRequest,
      handleAskUserRequest,
      handleAskUserCancellation,
      handleAuthResolution,
      loadSkills,
      loadAgentWorkspaceOptions,
      loadLongTermGoals,
      loadLongTermGoalSnapshot,
      mergeGoalTitleState
    })
    // These startup snapshots are independent. Loading them in parallel avoids
    // making the renderer appear blank while each store waits for the previous
    // native read to finish.
    await Promise.all([
      loadConversations(),
      loadLongTermGoals(),
      loadProviders(),
      loadSkills(),
      loadAgentWorkspaceOptions()
    ])
  })

  let disposed = false
  let togglingComputerUse = false
  onUnmounted(() => { disposed = true })

  async function toggleComputerUse (): Promise<void> {
    if (computerUseEnabled.value) {
      computerUseEnabled.value = false
      if (isLoading.value) await stopCurrentStream()
      return
    }
    if (togglingComputerUse) return
    togglingComputerUse = true
    try {
      // Await the already-loaded startup snapshot, never a fresh native probe.
      const status = await computerUsePermissions.initialize()
      if (!status || disposed) return
      if (!status.granted) {
        await computerUsePermissions.request()
        return
      }
      if (!disposed) computerUseEnabled.value = true
    } finally {
      togglingComputerUse = false
    }
  }

  return {
    activeGroupSessionId,
    activeProviderId,
    activeSkillIds,
    activeTodoItems,
    agentSelectorValue,
    agentSidebarItems,
    availableAgents,
    availableChannelBindings,
    availableSkills,
    conversationsLoaded,
    conversationSidebarItems,
    conversationDetailError,
    conversationDetailState,
    createLongTermGoal,
    currentAuthMode,
    currentAssistantIcon,
    currentAssistantName,
    currentContextDetail,
    currentContextLabel,
    currentCodingDiff,
    currentCodingStatus,
    currentConversationId,
    currentLongTermGoal,
    currentPendingAuthCount,
    currentPendingAuthRequest,
    currentPendingSudoPasswordCount,
    currentSudoPasswordRequest,
    deleteConversation,
    deleteLongTermGoal,
    cancelEditMessage,
    editUserMessage: submitEdit,
    editingMessageId,
    filePreview,
    forkFromMessage,
    groupMentionHints,
    groupSidebarItems,
    longTermGoalSidebarItems,
    longTermGoalSnapshot,
    streamingAdjust,
    streamingCreate,
    streamingRun,
    streamingReplan,
    memoryCompaction,
    createConversationHistory,
    goalAutoOpenRunId,
    handleAgentSelectionChange,
    handleAuthModeChange,
    handleChannelBindingSelectionChange,
    handleModelSelectionChange,
    handleProviderSelectionChange,
    handleProviderModelSelectionChange,
    handleReasoningStrengthChange,
    handleTemperatureChange,
    inputText,
    insertDocumentTag,
    isGroupConversation,
    isLoading,
    isUploadingFiles,
    loadConversation,
    longTermGoalWorkspaceActive,
    openLongTermGoal,
    messages,
    newConversation,
    nonDefaultAgents,
    openAgentWorkspaceConversation,
    openGroupWorkspaceConversation,
    pauseLongTermGoal,
    pendingFiles,
    pendingImages,
    planModeActive,
    computerUseEnabled,
    computerUsePermissionGranted,
    providers,
    providersConfig,
    providerDefaultTemperature,
    conversationTemperature,
    reasoningStrength,
    renameConversation,
    removeFile,
    removeImage,
    resumeLongTermGoal,
    runLongTermGoalNow,
    clearGoalAutoOpenRunId,
    archiveLongTermGoal,
    saveLongTermGoalPatch,
    respondToAuthRequest,
    respondToSudoPasswordRequest,
    respondToAskUserRequest,
    currentAskUserRequest,
    selectedChannelBindingId,
    selectedGroupId,
    selectedModel,
    selectAllSkills,
    sendMessage,
    sendLongTermGoalMessage,
    startLongTermGoalCreation,
    compactLongTermGoalMemory,
    deleteLongTermGoalMemory,
    applyLongTermGoalChangeSet,
    cancelLongTermGoalChangeSet,
    applyLongTermGoalCreation,
    cancelLongTermGoalCreation,
    resetLongTermGoalCreation,
    pendingCreationConfirm,
    answerLongTermGoalIntervention,
    shouldUseConversationProviderOverride,
    showSkillPicker,
    startEditUserMessage: startEditMessage,
    stopCurrentStream,
    retryLastUserMessage,
    togglePlanMode,
    toggleComputerUse,
    toggleSkill,
    clearSkills,
    updateFolderWorkspaceState,
    updateWorkspaceTabState,
    uploadFeedback,
    addAttachments,
    addSelectionQuoteToInput,
    upsertAnnotationTurns,
    removeMessageAnnotation,
    getConversationProject,
    assignConversationProject,
    startProjectConversation,
    startBlankConversation,
    startOptimizationConversation,
    backgroundStreamMessages,
    updateBackgroundConversationWorkspace
  }
}
