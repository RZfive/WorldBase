import type { ComputedRef, Ref } from 'vue'
import type { ConversationMetadataPatch } from '../../../../shared/conversation-metadata'
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
  currentConversationId: Ref<string | null>
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
  } = options

  function currentMetadata (): ConversationMetadataPatch {
    return {
      authMode: currentAuthMode.value,
      providerId: shouldUseConversationProviderOverride.value ? (activeProviderId.value || null) : null,
      selectedModel: shouldUseConversationProviderOverride.value ? (selectedModel.value || null) : null,
      reasoningStrength: reasoningStrength.value,
      temperature: conversationTemperature.value,
      targetProjectId: currentConversationId.value ? getConversationTarget(currentConversationId.value) : null,
      agentId: selectedAgentId.value || null,
      groupId: selectedGroupId.value || null,
      channelBindingId: selectedChannelBindingId.value || null
    }
  }

  function captureContext () {
    return {
      ...currentMetadata(),
      documentWorkspace: buildCurrentDocumentWorkspaceState(),
      folderWorkspace: buildCurrentFolderWorkspaceState(),
      pinnedTitle: getPinnedContextTitle()
    }
  }
  const backgroundContexts = new Map<string, ReturnType<typeof captureContext>>()
  // A stream writes the same conversation twice: once after the user turn is
  // accepted and once after the assistant turn finishes. Keep those writes in
  // order so a slow first save cannot overwrite the completed conversation.
  const saveQueues = new Map<string, Promise<void>>()
  // A startup list read can race the first optimistic save. Preserve rows that
  // have not yet been confirmed by the catalog.
  const pendingSummaries = new Map<string, ConversationSummary>()
  function rememberConversationContext (id: string): void {
    backgroundContexts.set(id, captureContext())
  }

  function applySummary (summary: ConversationSummary): void {
    const next = conversations.value.filter(item => item.id !== summary.id)
    // listConversations returns descending timestamps. Insert the changed
    // summary without sorting (and reformatting) the entire catalog again.
    let low = 0
    let high = next.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (next[middle].updatedAt >= summary.updatedAt) low = middle + 1
      else high = middle
    }
    next.splice(low, 0, summary)
    conversations.value = next
  }

  async function saveConversationMetadata (id: string): Promise<void> {
    const api = window.electronAPI
    if (!api?.updateConversationMetadata) return
    // This payload never traverses messages, screenshots or document contents.
    const result = await api.updateConversationMetadata(id, currentMetadata())
    if (result.summary) applySummary(result.summary)
  }

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
      const loaded = await window.electronAPI.listConversations()
      const confirmed = new Set(loaded.map(conversation => conversation.id))
      for (const id of confirmed) pendingSummaries.delete(id)
      conversations.value = [...loaded, ...Array.from(pendingSummaries.values()).filter(summary => !confirmed.has(summary.id))]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    } catch {
      /* ignore */
    } finally {
      conversationsLoaded.value = true
    }
  }

  async function saveConversationNow (
    conversationId: string,
    messages: ChatMessage[],
    saveOptions?: SaveConversationOptions
  ): Promise<void> {
    if (!window.electronAPI) return

    const existingConversation = conversations.value.find(conversation => conversation.id === conversationId)
    if (messages.length === 0 && !saveOptions?.titleOverride && !saveOptions?.allowEmpty && !existingConversation) return

    const context = currentConversationId.value === conversationId
      ? captureContext()
      : backgroundContexts.get(conversationId)
    const firstUserMessage = messages.find(message => message.role === 'user')
    const titleText = getConversationTitleText(firstUserMessage, { attachmentTitle: formatAttachmentConversationTitle })
    const shouldKeepManualTitle = Boolean(existingConversation?.manualTitle && !saveOptions?.titleOverride)
    const resolvedTitle = saveOptions?.titleOverride
      || (shouldKeepManualTitle ? existingConversation?.title : '')
      || context?.pinnedTitle
      || (titleText
        ? (titleText.length > 40 ? titleText.substring(0, 40) + '...' : titleText)
        : (existingConversation?.title || t('chatUi.newConversation')))
    const resolvedTargetProjectId = saveOptions && Object.prototype.hasOwnProperty.call(saveOptions, 'targetProjectId')
      ? (saveOptions.targetProjectId ?? null)
      : getConversationTarget(conversationId)

    setConversationTarget(conversationId, resolvedTargetProjectId)

    const metadata: ConversationMetadataPatch = context || existingConversation || {}
    const optimisticSummary: ConversationSummary = {
      id: conversationId,
      title: resolvedTitle,
      createdAt: getConversationCreatedAt(conversationId),
      updatedAt: new Date().toISOString(),
      ...(titleText ? { previewText: titleText.length > 96 ? `${titleText.slice(0, 96)}...` : titleText } : {}),
      ...(shouldKeepManualTitle ? { manualTitle: true } : {}),
      ...(metadata.authMode ? { authMode: metadata.authMode } : {}),
      ...(metadata.providerId ? { providerId: metadata.providerId } : {}),
      ...(metadata.selectedModel ? { selectedModel: metadata.selectedModel } : {}),
      ...(metadata.reasoningStrength ? { reasoningStrength: metadata.reasoningStrength } : {}),
      ...(typeof metadata.temperature === 'number' ? { temperature: metadata.temperature } : {}),
      ...(resolvedTargetProjectId ? { targetProjectId: resolvedTargetProjectId } : {}),
      ...(metadata.agentId ? { agentId: metadata.agentId } : {}),
      ...(metadata.groupId ? { groupId: metadata.groupId } : {}),
      ...(metadata.channelBindingId ? { channelBindingId: metadata.channelBindingId } : {})
    }
    // Update the renderer catalog before the IPC round trip completes. This is
    // what makes a just-submitted first turn visible while its response runs.
    applySummary(optimisticSummary)
    pendingSummaries.set(conversationId, optimisticSummary)

    const result = await window.electronAPI.saveConversation(JSON.parse(JSON.stringify({
      id: conversationId,
      title: resolvedTitle,
      messages,
      createdAt: getConversationCreatedAt(conversationId),
      updatedAt: new Date().toISOString(),
      manualTitle: shouldKeepManualTitle || undefined,
      authMode: metadata.authMode ?? undefined,
      providerId: metadata.providerId ?? undefined,
      selectedModel: metadata.selectedModel ?? undefined,
      reasoningStrength: metadata.reasoningStrength ?? undefined,
      temperature: metadata.temperature ?? undefined,
      targetProjectId: resolvedTargetProjectId || undefined,
      agentId: metadata.agentId ?? undefined,
      groupId: metadata.groupId ?? undefined,
      channelBindingId: metadata.channelBindingId ?? undefined,
      documentWorkspace: context?.documentWorkspace,
      folderWorkspace: context?.folderWorkspace
    })))

    if (result.summary) {
      pendingSummaries.delete(conversationId)
      applySummary(result.summary)
    }
    else await loadConversations() // Older preload compatibility only.
  }

  function saveConversation (
    conversationId: string,
    messages: ChatMessage[],
    saveOptions?: SaveConversationOptions
  ): Promise<void> {
    const previous = saveQueues.get(conversationId)
    // Start the first save synchronously. `saveConversationNow` applies the
    // optimistic catalog row before its first IPC await, so the caller sees a
    // new conversation in the same turn as the submitted message.
    const next = previous
      ? previous.catch(() => {}).then(() => saveConversationNow(conversationId, messages, saveOptions))
      : saveConversationNow(conversationId, messages, saveOptions)
    saveQueues.set(conversationId, next)
    void next.then(
      () => { if (saveQueues.get(conversationId) === next) saveQueues.delete(conversationId) },
      () => { if (saveQueues.get(conversationId) === next) saveQueues.delete(conversationId) }
    )
    return next
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
    rememberConversationContext,
    saveConversationMetadata,
    saveConversation,
    setConversationTarget
  }
}
