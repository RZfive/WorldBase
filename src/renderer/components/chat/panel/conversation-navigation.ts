import type { ComputedRef, Ref } from 'vue'
import type { ComposerTranslation } from 'vue-i18n'
import { generateId } from './message-blocks'
import { getPinnedAgentConversation, getPinnedGroupConversation } from './provider-utils'
import { DEFAULT_REASONING_STRENGTH } from './shared-state'
import type {
  AgentDefinition,
  AgentGroupDefinition,
  AIExecutionAuthMode,
  BackgroundStreamState,
  ChatMessage,
  ConversationSummary,
  PendingAttachment,
  PendingImage,
  ReasoningStrength
} from './types'
import type { SaveConversationOptions } from './conversation-storage'

interface ChatConversationNavigationOptions {
  t: ComposerTranslation
  messages: Ref<ChatMessage[]>
  inputText: Ref<string>
  conversations: Ref<ConversationSummary[]>
  currentConversationId: Ref<string | null>
  targetProjectId: Ref<string | null>
  currentAuthMode: Ref<AIExecutionAuthMode>
  reasoningStrength: Ref<ReasoningStrength>
  conversationTemperature: Ref<number | null>
  selectedLongTermGoalId: Ref<string | null>
  selectedAgentId: Ref<string>
  selectedGroupId: Ref<string>
  selectedChannelBindingId: Ref<string>
  pendingImages: Ref<PendingImage[]>
  pendingFiles: Ref<PendingAttachment[]>
  uploadFeedback: Ref<string>
  activeProviderId: Ref<string>
  selectedModel: Ref<string>
  streamingConversationIds: Set<string>
  backgroundStreamMessages: Map<string, BackgroundStreamState>
  activeStreamSessionIds: Map<string, string>
  conversationTargets: Map<string, string | null>
  agentsById: ComputedRef<Map<string, AgentDefinition>>
  groupsById: ComputedRef<Map<string, AgentGroupDefinition>>
  shouldUseConversationProviderOverride: ComputedRef<boolean>
  getDefaultAgentId: () => string
  clearConversationUnread: (conversationId: string | null | undefined) => void
  syncProviderSelectionForAgent: (agentId: string) => void
  loadProviders: (preferredProviderId?: string | null, preferredModelId?: string | null) => Promise<void>
  loadConversations: () => Promise<void>
  saveConversation: (conversationId: string, messages: ChatMessage[], options?: SaveConversationOptions) => Promise<void>
  setConversationTarget: (conversationId: string, projectId: string | null | undefined) => void
  applyDocumentWorkspaceState: (state?: ConversationDocumentWorkspaceState | null) => void
  applyFolderWorkspaceState: (state?: ConversationFolderWorkspaceState | null) => void
  buildCurrentDocumentWorkspaceState: () => ConversationDocumentWorkspaceState | undefined
  buildCurrentFolderWorkspaceState: () => ConversationFolderWorkspaceState | undefined
  resetDocumentWorkspaceState: () => void
  resetFolderWorkspaceState: () => void
  resetTransientStreamState: () => void
}

export function createChatConversationNavigation (options: ChatConversationNavigationOptions) {
  const {
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
    selectedAgentId,
    selectedGroupId,
    selectedChannelBindingId,
    pendingImages,
    pendingFiles,
    uploadFeedback,
    activeProviderId,
    selectedModel,
    streamingConversationIds,
    backgroundStreamMessages,
    activeStreamSessionIds,
    conversationTargets,
    agentsById,
    groupsById,
    shouldUseConversationProviderOverride,
    getDefaultAgentId,
    clearConversationUnread,
    syncProviderSelectionForAgent,
    loadProviders,
    loadConversations,
    saveConversation,
    setConversationTarget,
    applyDocumentWorkspaceState,
    applyFolderWorkspaceState,
    buildCurrentDocumentWorkspaceState,
    buildCurrentFolderWorkspaceState,
    resetDocumentWorkspaceState,
    resetFolderWorkspaceState,
    resetTransientStreamState
  } = options

  function resetConversationComposerState (): void {
    messages.value = []
    targetProjectId.value = null
    currentAuthMode.value = 'strict'
    reasoningStrength.value = DEFAULT_REASONING_STRENGTH
    conversationTemperature.value = null
    inputText.value = ''
    resetTransientStreamState()
    pendingImages.value = []
    pendingFiles.value = []
    uploadFeedback.value = ''
    resetDocumentWorkspaceState()
    resetFolderWorkspaceState()
  }

  function resolveConversationAgentSelection (value: {
    agentId?: string | null
    groupId?: string | null
    channelBindingId?: string | null
  }): string {
    if (value.groupId || value.channelBindingId) return value.agentId || ''
    return value.agentId || getDefaultAgentId()
  }

  function stashCurrentConversationForNavigation (): void {
    const conversationId = currentConversationId.value
    if (!conversationId || !streamingConversationIds.has(conversationId)) return

    backgroundStreamMessages.set(conversationId, {
      messages: messages.value,
      assistantIdx: messages.value.length - 1,
      targetProjectId: targetProjectId.value,
      authMode: currentAuthMode.value,
      providerId: shouldUseConversationProviderOverride.value ? (activeProviderId.value || null) : null,
      selectedModel: shouldUseConversationProviderOverride.value ? (selectedModel.value || null) : null,
      reasoningStrength: reasoningStrength.value,
      temperature: conversationTemperature.value,
      agentId: selectedAgentId.value || null,
      groupId: selectedGroupId.value || null,
      channelBindingId: selectedChannelBindingId.value || null,
      documentWorkspace: buildCurrentDocumentWorkspaceState(),
      folderWorkspace: buildCurrentFolderWorkspaceState()
    })
    void saveConversation(conversationId, messages.value, { targetProjectId: targetProjectId.value })
  }

  async function createWorkspaceConversation (context: {
    agentId?: string
    groupId?: string
    channelBindingId?: string
    title: string
  }): Promise<void> {
    const conversationId = generateId()

    stashCurrentConversationForNavigation()
    selectedLongTermGoalId.value = null
    currentConversationId.value = conversationId
    resetConversationComposerState()
    selectedAgentId.value = context.agentId || ''
    selectedGroupId.value = context.groupId || ''
    selectedChannelBindingId.value = context.channelBindingId || ''

    await saveConversation(conversationId, [], {
      titleOverride: context.title,
      targetProjectId: null,
      allowEmpty: true
    })
  }

  async function openAgentWorkspaceConversation (agentId: string): Promise<void> {
    const existingConversation = getPinnedAgentConversation(conversations.value, agentId)
    if (existingConversation) {
      await loadConversation(existingConversation.id)
      return
    }

    const agent = agentsById.value.get(agentId)
    if (!agent) return

    await createWorkspaceConversation({ agentId: agent.id, title: agent.name })
  }

  async function openGroupWorkspaceConversation (groupId: string): Promise<void> {
    const existingConversation = getPinnedGroupConversation(conversations.value, groupId)
    if (existingConversation) {
      await loadConversation(existingConversation.id)
      return
    }

    const group = groupsById.value.get(groupId)
    if (!group) return

    await createWorkspaceConversation({ groupId: group.id, title: group.name })
  }

  async function startOptimizationConversation (context: Record<string, unknown>): Promise<void> {
    const projectId = typeof context.id === 'string' ? context.id : null
    const name = String(context.name || context.id || t('chatUi.unknownProject'))
    const projectRef = projectId ? `[[project:${projectId}|${name}]]` : ''
    const conversationId = generateId()

    stashCurrentConversationForNavigation()
    currentConversationId.value = conversationId
    selectedLongTermGoalId.value = null
    messages.value = []
    targetProjectId.value = projectId
    currentAuthMode.value = 'strict'
    reasoningStrength.value = DEFAULT_REASONING_STRENGTH
    conversationTemperature.value = null
    selectedAgentId.value = getDefaultAgentId()
    selectedGroupId.value = ''
    selectedChannelBindingId.value = ''
    syncProviderSelectionForAgent(selectedAgentId.value)
    inputText.value = `${projectRef}${projectRef ? '\n' : ''}${t('chatUi.optimizationInitialPrompt')}`
    pendingImages.value = []
    pendingFiles.value = []
    uploadFeedback.value = ''
    resetTransientStreamState()
    resetDocumentWorkspaceState()
    resetFolderWorkspaceState()
    setConversationTarget(conversationId, projectId)

    await saveConversation(conversationId, [], {
      titleOverride: t('chatUi.optimizationConversationTitle', { name }),
      targetProjectId: projectId
    })
  }

  function newConversation (): void {
    stashCurrentConversationForNavigation()
    selectedLongTermGoalId.value = null
    currentConversationId.value = null
    resetConversationComposerState()
    selectedAgentId.value = getDefaultAgentId()
    selectedGroupId.value = ''
    selectedChannelBindingId.value = ''
    syncProviderSelectionForAgent(selectedAgentId.value)
  }

  async function loadConversation (conversationId: string): Promise<void> {
    if (!window.electronAPI) return

    if (currentConversationId.value && currentConversationId.value !== conversationId) {
      stashCurrentConversationForNavigation()
    }

    selectedLongTermGoalId.value = null
    clearConversationUnread(conversationId)

    const backgroundState = backgroundStreamMessages.get(conversationId)
    if (backgroundState) {
      currentConversationId.value = conversationId
      messages.value = backgroundState.messages
      targetProjectId.value = backgroundState.targetProjectId
      currentAuthMode.value = backgroundState.authMode
      reasoningStrength.value = backgroundState.reasoningStrength
      conversationTemperature.value = backgroundState.temperature ?? null
      selectedAgentId.value = resolveConversationAgentSelection(backgroundState)
      selectedGroupId.value = backgroundState.groupId || ''
      selectedChannelBindingId.value = backgroundState.channelBindingId || ''
      applyDocumentWorkspaceState(backgroundState.documentWorkspace)
      applyFolderWorkspaceState(backgroundState.folderWorkspace)
      setConversationTarget(conversationId, backgroundState.targetProjectId)
      backgroundStreamMessages.delete(conversationId)
      resetTransientStreamState()
      pendingFiles.value = []
      pendingImages.value = []
      uploadFeedback.value = ''
      await loadProviders(backgroundState.providerId || null, backgroundState.selectedModel || null)
      return
    }

    const conversation = await window.electronAPI.getConversation(conversationId)
    if (!conversation) return

    currentConversationId.value = conversation.id
    messages.value = conversation.messages
    targetProjectId.value = conversation.targetProjectId || null
    currentAuthMode.value = conversation.authMode === 'auto' ? 'auto' : 'strict'
    reasoningStrength.value = conversation.reasoningStrength || DEFAULT_REASONING_STRENGTH
    conversationTemperature.value = typeof conversation.temperature === 'number' ? conversation.temperature : null
    selectedAgentId.value = resolveConversationAgentSelection(conversation)
    selectedGroupId.value = conversation.groupId || ''
    selectedChannelBindingId.value = conversation.channelBindingId || ''
    applyDocumentWorkspaceState(conversation.documentWorkspace)
    applyFolderWorkspaceState(conversation.folderWorkspace)
    setConversationTarget(conversation.id, conversation.targetProjectId || null)
    resetTransientStreamState()
    pendingFiles.value = []
    pendingImages.value = []
    uploadFeedback.value = ''
    await loadProviders(conversation.providerId || null, conversation.selectedModel || null)
  }

  function prepareLongTermGoalWorkspace (): void {
    stashCurrentConversationForNavigation()
    currentConversationId.value = null
    messages.value = []
    inputText.value = ''
    resetTransientStreamState()
    pendingFiles.value = []
    pendingImages.value = []
    uploadFeedback.value = ''
    resetDocumentWorkspaceState()
    resetFolderWorkspaceState()
  }

  async function deleteConversation (conversationId: string): Promise<void> {
    if (!window.electronAPI) return

    await window.electronAPI.deleteConversation(conversationId)
    conversationTargets.delete(conversationId)
    backgroundStreamMessages.delete(conversationId)
    activeStreamSessionIds.delete(conversationId)
    if (currentConversationId.value === conversationId) newConversation()
    await loadConversations()
  }

  function updateDocumentWorkspaceState (state: ConversationDocumentWorkspaceState): void {
    applyDocumentWorkspaceState(state)
    if (!currentConversationId.value) return
    void saveConversation(currentConversationId.value, messages.value, {
      targetProjectId: targetProjectId.value,
      allowEmpty: true
    })
  }

  function updateFolderWorkspaceState (state: ConversationFolderWorkspaceState | null): void {
    applyFolderWorkspaceState(state)
    if (!currentConversationId.value) return
    void saveConversation(currentConversationId.value, messages.value, {
      targetProjectId: targetProjectId.value,
      allowEmpty: true
    })
  }

  return {
    deleteConversation,
    loadConversation,
    newConversation,
    openAgentWorkspaceConversation,
    openGroupWorkspaceConversation,
    prepareLongTermGoalWorkspace,
    startOptimizationConversation,
    updateDocumentWorkspaceState,
    updateFolderWorkspaceState
  }
}
