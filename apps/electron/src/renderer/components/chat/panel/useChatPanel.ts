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
import { getLatestVisibleTodoItems } from './message-runtime'
import { sharedChatPanelState } from './shared-state'
import { createChatSidebarState } from './sidebar-state'
import { createChatWorkspaceOptionsState } from './workspace-options-state'
import { createChatWorkspaceState } from './workspace-state'
import type { ChatPanelProps } from './types'

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
    syncingProviderOptions,
    documentDockVisible,
    documentWorkspaceDocuments,
    documentWorkspaceActiveFilePath,
    documentWorkspaceWidth,
    folderWorkspaceVisible,
    folderWorkspaceRootPath,
    folderWorkspaceRootName,
    folderWorkspaceActiveFilePath,
    folderWorkspaceWidth
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
    conversationTargets
  } = sharedChatPanelState
  const {
    applyDocumentWorkspaceState,
    applyFolderWorkspaceState,
    buildCurrentDocumentWorkspaceState,
    buildCurrentFolderWorkspaceState,
    buildOutgoingMessagesWithDocumentWorkspaceContext,
    resetDocumentWorkspaceState,
    resetFolderWorkspaceState
  } = createChatWorkspaceState({
    documentDockVisible,
    documentWorkspaceDocuments,
    documentWorkspaceActiveFilePath,
    documentWorkspaceWidth,
    folderWorkspaceRootPath,
    folderWorkspaceRootName,
    folderWorkspaceActiveFilePath,
    folderWorkspaceWidth
  })

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
    getPendingAuthCount,
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
    if (id) clearConversationUnread(id)
  })

  const activeTodoItems = computed(() => getLatestVisibleTodoItems(messages.value, isLoading.value))

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
    saveConversationMetadata,
    saveConversation: doSaveConversation,
    setConversationTarget
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
    getPinnedContextTitle,
    buildCurrentDocumentWorkspaceState,
    buildCurrentFolderWorkspaceState
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

  const {
    conversationDetailError,
    conversationDetailState,
    deleteConversation,
    loadConversation,
    newConversation,
    openAgentWorkspaceConversation,
    openGroupWorkspaceConversation,
    prepareLongTermGoalWorkspace,
    startOptimizationConversation,
    updateDocumentWorkspaceState,
    updateFolderWorkspaceState
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
    applyDocumentWorkspaceState,
    applyFolderWorkspaceState,
    buildCurrentDocumentWorkspaceState,
    buildCurrentFolderWorkspaceState,
    resetDocumentWorkspaceState,
    resetFolderWorkspaceState,
    resetTransientStreamState
  })

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

  const { sendMessage, stopCurrentStream } = createChatMessageSender({
    t,
    getActivePageContext: () => props.activePageContext,
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
    setConversationTarget,
    resolveAssistantSpeakerName,
    buildOutgoingMessagesWithDocumentWorkspaceContext,
    buildCurrentFolderWorkspaceState,
    saveConversation: (conversationId, chatMessages) => doSaveConversation(conversationId, chatMessages),
    resetTransientStreamState
  })

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
    currentConversationId,
    currentLongTermGoal,
    currentPendingAuthCount,
    currentPendingAuthRequest,
    currentPendingSudoPasswordCount,
    currentSudoPasswordRequest,
    deleteConversation,
    deleteLongTermGoal,
    cancelEditMessage,
    documentDockVisible,
    documentWorkspaceActiveFilePath,
    documentWorkspaceDocuments,
    documentWorkspaceWidth,
    folderWorkspaceActiveFilePath,
    folderWorkspaceRootName,
    folderWorkspaceRootPath,
    folderWorkspaceVisible,
    folderWorkspaceWidth,
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
    togglePlanMode,
    toggleComputerUse,
    toggleSkill,
    clearSkills,
    updateDocumentWorkspaceState,
    updateFolderWorkspaceState,
    uploadFeedback,
    addAttachments
  }
}
