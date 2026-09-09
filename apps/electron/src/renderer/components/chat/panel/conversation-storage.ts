import type { ComputedRef, Ref } from 'vue'
import type { ComposerTranslation } from 'vue-i18n'
import { getConversationTitleText } from './message-runtime'
import type {
  AIExecutionAuthMode,
  ChatMessage,
  ConversationSummary,
  ReasoningStrength
} from './types'

export interface SaveConversationOptions {
  titleOverride?: string
  targetProjectId?: string | null
  allowEmpty?: boolean
}

interface ChatConversationStorageOptions {
  t: ComposerTranslation
  formatAttachmentConversationTitle: (attachmentNames: string[]) => string
  conversations: Ref<ConversationSummary[]>
  conversationsLoaded: Ref<boolean>
  currentAuthMode: Ref<AIExecutionAuthMode>
  activeProviderId: Ref<string>
  selectedModel: Ref<string>
  reasoningStrength: Ref<ReasoningStrength>
  conversationTemperature: Ref<number | null>
  selectedAgentId: Ref<string>
  selectedGroupId: Ref<string>
  selectedChannelBindingId: Ref<string>
  shouldUseConversationProviderOverride: ComputedRef<boolean>
  conversationTargets: Map<string, string | null>
  getPinnedContextTitle: () => string | null
  buildCurrentDocumentWorkspaceState: () => ConversationDocumentWorkspaceState | undefined
  buildCurrentFolderWorkspaceState: () => ConversationFolderWorkspaceState | undefined
}

export function createChatConversationStorage (options: ChatConversationStorageOptions) {
  const {
    t,
    formatAttachmentConversationTitle,
    conversations,
    conversationsLoaded,
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
  } = options

  function setConversationTarget (conversationId: string, projectId: string | null | undefined): void {
    if (!projectId) {
      conversationTargets.delete(conversationId)
      return
    }
    conversationTargets.set(conversationId, projectId)
  }

  function getConversationTarget (conversationId: string | null | undefined): string | null {
    if (!conversationId) return null
    return conversationTargets.get(conversationId) ?? null
  }

  function getConversationCreatedAt (conversationId: string): string {
    return conversations.value.find(conversation => conversation.id === conversationId)?.createdAt || new Date().toISOString()
  }

  async function loadConversations (): Promise<void> {
    if (!window.electronAPI) {
      conversationsLoaded.value = true
      return
    }

    try {
      conversations.value = await window.electronAPI.listConversations()
    } catch {
      /* ignore */
    } finally {
      conversationsLoaded.value = true
    }
  }

  async function saveConversation (
    conversationId: string,
    messages: ChatMessage[],
    saveOptions?: SaveConversationOptions
  ): Promise<void> {
    if (!window.electronAPI) return

    const existingConversation = conversations.value.find(conversation => conversation.id === conversationId)
    if (messages.length === 0 && !saveOptions?.titleOverride && !saveOptions?.allowEmpty && !existingConversation) return

    const firstUserMessage = messages.find(message => message.role === 'user')
    const titleText = getConversationTitleText(firstUserMessage, { attachmentTitle: formatAttachmentConversationTitle })
    const shouldKeepManualTitle = Boolean(existingConversation?.manualTitle && !saveOptions?.titleOverride)
    const resolvedTitle = saveOptions?.titleOverride
      || (shouldKeepManualTitle ? existingConversation?.title : '')
      || getPinnedContextTitle()
      || (titleText
        ? (titleText.length > 40 ? titleText.substring(0, 40) + '...' : titleText)
        : (existingConversation?.title || t('chatUi.newConversation')))
    const resolvedTargetProjectId = saveOptions && Object.prototype.hasOwnProperty.call(saveOptions, 'targetProjectId')
      ? (saveOptions.targetProjectId ?? null)
      : getConversationTarget(conversationId)

    setConversationTarget(conversationId, resolvedTargetProjectId)

    await window.electronAPI.saveConversation(JSON.parse(JSON.stringify({
      id: conversationId,
      title: resolvedTitle,
      messages,
      createdAt: getConversationCreatedAt(conversationId),
      updatedAt: new Date().toISOString(),
      manualTitle: shouldKeepManualTitle || undefined,
      authMode: currentAuthMode.value,
      providerId: shouldUseConversationProviderOverride.value ? (activeProviderId.value || undefined) : undefined,
      selectedModel: shouldUseConversationProviderOverride.value ? (selectedModel.value || undefined) : undefined,
      reasoningStrength: reasoningStrength.value,
      temperature: conversationTemperature.value ?? undefined,
      targetProjectId: resolvedTargetProjectId || undefined,
      agentId: selectedAgentId.value || undefined,
      groupId: selectedGroupId.value || undefined,
      channelBindingId: selectedChannelBindingId.value || undefined,
      documentWorkspace: buildCurrentDocumentWorkspaceState(),
      folderWorkspace: buildCurrentFolderWorkspaceState()
    })))

    await loadConversations()
  }

  async function renameConversation (conversationId: string, title: string): Promise<boolean> {
    const nextTitle = title.trim()
    if (!window.electronAPI || !nextTitle) return false

    const result = await window.electronAPI.renameConversation(conversationId, nextTitle)
    if (!result.success) return false

    conversations.value = conversations.value.map(conversation => (
      conversation.id === conversationId
        ? { ...conversation, title: nextTitle, manualTitle: true }
        : conversation
    ))
    return true
  }

  return {
    loadConversations,
    renameConversation,
    saveConversation,
    setConversationTarget
  }
}
