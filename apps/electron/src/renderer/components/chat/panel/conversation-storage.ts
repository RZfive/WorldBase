import type { ComputedRef, Ref } from 'vue'
import type { ConversationMetadataPatch } from '../../../../shared/conversation-metadata'
import type { ComposerTranslation } from 'vue-i18n'
import { getConversationTitleText } from './message-runtime'
import {
  buildCurrentDocumentWorkspaceState,
  buildCurrentFolderWorkspaceState,
  buildCurrentWorkspaceState
} from '../../workspace/workspace-store'
import type {
  AIExecutionAuthMode,
  ChatMessage,
  ConversationSummary,
  ReasoningStrength
} from './types'

export interface SaveConversationOptions {
  titleOverride?: string
  targetProjectId?: string | null
  projectId?: string | null
  allowEmpty?: boolean
  /** Persist without replacing/reordering the live sidebar row. */
  refreshSidebar?: boolean
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
    getPinnedContextTitle
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
      workspace: buildCurrentWorkspaceState(),
      pinnedTitle: getPinnedContextTitle()
    }
  }
  const backgroundContexts = new Map<string, ReturnType<typeof captureContext>>()
  const conversationProjects = new Map<string, string>()
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

  /**
   * Applies an AI workspace-tab change to a background conversation's
   * persistence context (captured at stash time). Without this the stream's
   * saves keep writing the stale snapshot and a remotely opened tab vanishes
   * once the run finishes. Legacy mirrors stay coherent: they win over an
   * empty workspace on restore.
   */
  function updateBackgroundConversationWorkspace (id: string, workspace: ConversationWorkspaceState | undefined): void {
    const context = backgroundContexts.get(id)
    if (!context) return
    context.workspace = workspace

    const folderEntry = workspace?.tabs?.find(tab => tab.kind === 'folder')
    const documentEntries = (workspace?.tabs || []).filter(tab =>
      tab.kind === 'document' && typeof tab.state?.filePath === 'string' && tab.state.filePath
    )
    if (folderEntry && typeof folderEntry.state?.rootPath === 'string' && folderEntry.state.rootPath) {
      const rootPath = folderEntry.state.rootPath
      context.folderWorkspace = {
        rootPath,
        rootName: typeof folderEntry.state.rootName === 'string' && folderEntry.state.rootName
          ? folderEntry.state.rootName
          : rootPath.split(/[\\/]/).filter(Boolean).pop() || rootPath,
        ...(typeof folderEntry.state.activeFilePath === 'string' && folderEntry.state.activeFilePath
          ? { activeFilePath: folderEntry.state.activeFilePath }
          : {}),
        ...(workspace?.width ? { width: workspace.width } : {})
      }
    } else {
      context.folderWorkspace = undefined
    }
    if (documentEntries.length > 0) {
      const activeIsDocument = workspace?.activeTabId
        ? documentEntries.some(entry => entry.id === workspace.activeTabId)
        : false
      const documentFileName = (entry: ConversationWorkspaceTabState): string => {
        const raw = typeof entry.state?.fileName === 'string' && entry.state.fileName ? entry.state.fileName : ''
        if (raw) return raw
        const filePath = String(entry.state?.filePath)
        return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath
      }
      context.documentWorkspace = {
        documents: documentEntries.map(entry => ({
          filePath: String(entry.state?.filePath),
          fileName: documentFileName(entry)
        })),
        activeFilePath: activeIsDocument
          ? String(documentEntries.find(entry => entry.id === workspace?.activeTabId)?.state?.filePath)
          : String(documentEntries[0].state?.filePath),
        ...(workspace?.width ? { width: workspace.width } : {})
      }
    } else {
      context.documentWorkspace = undefined
    }
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

  // Grouping ownership (R2): separate from the optimization target above.
  // Unset entries fall through to the catalog row so patch-based assignments
  // made anywhere survive reloads without a second write.
  function getConversationProject (conversationId: string | null | undefined): string | null {
    if (!conversationId) return null
    return conversationProjects.get(conversationId)
      ?? conversations.value.find(conversation => conversation.id === conversationId)?.projectId
      ?? null
  }

  function setConversationProject (conversationId: string, projectId: string | null | undefined): void {
    if (projectId == null) {
      conversationProjects.delete(conversationId)
      return
    }
    conversationProjects.set(conversationId, projectId)
  }

  /** Manual/auto assignment of the grouping project. Null clears ownership. */
  async function assignConversationProject (conversationId: string, projectId: string | null): Promise<boolean> {
    const api = window.electronAPI
    if (!api?.updateConversationMetadata) return false
    setConversationProject(conversationId, projectId)
    try {
      const result = await api.updateConversationMetadata(conversationId, { projectId })
      if (result.summary) applySummary(result.summary)
      return result.success
    } catch {
      setConversationProject(conversationId, projectId === null ? undefined : projectId)
      return false
    }
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
    const resolvedProjectId = saveOptions && Object.prototype.hasOwnProperty.call(saveOptions, 'projectId')
      ? (saveOptions.projectId ?? null)
      : getConversationProject(conversationId)

    setConversationTarget(conversationId, resolvedTargetProjectId)
    setConversationProject(conversationId, resolvedProjectId)

    const metadata: ConversationMetadataPatch = context || existingConversation || {}
    // Keep the grouping root visible across the IPC round trip: without it the
    // optimistic row drops out of its project group until the real summary
    // lands from the storage worker.
    const optimisticRootPath = context?.folderWorkspace?.rootPath?.trim() || existingConversation?.workspaceRootPath
    const optimisticRootName = context?.folderWorkspace?.rootName || existingConversation?.workspaceRootName
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
      ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
      ...(optimisticRootPath ? {
        workspaceRootPath: optimisticRootPath,
        ...(optimisticRootName ? { workspaceRootName: optimisticRootName } : {})
      } : {}),
      ...(metadata.agentId ? { agentId: metadata.agentId } : {}),
      ...(metadata.groupId ? { groupId: metadata.groupId } : {}),
      ...(metadata.channelBindingId ? { channelBindingId: metadata.channelBindingId } : {})
    }
    // Update the renderer catalog before the IPC round trip completes. This is
    // what makes a just-submitted first turn visible while its response runs.
    // Periodic saves during streaming opt out: replacing the summary on every
    // flush changes updatedAt, reorders the list, and makes the whole grouped
    // sidebar repaint while the user is reading the response.
    const refreshSidebar = saveOptions?.refreshSidebar !== false
    if (refreshSidebar) {
      applySummary(optimisticSummary)
      pendingSummaries.set(conversationId, optimisticSummary)
    }

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
      projectId: resolvedProjectId || undefined,
      agentId: metadata.agentId ?? undefined,
      groupId: metadata.groupId ?? undefined,
      channelBindingId: metadata.channelBindingId ?? undefined,
      documentWorkspace: context?.documentWorkspace,
      folderWorkspace: context?.folderWorkspace,
      workspace: context?.workspace
    })))

    if (result.summary) {
      if (refreshSidebar) {
        pendingSummaries.delete(conversationId)
        applySummary(result.summary)
      }
    }
    else if (refreshSidebar) await loadConversations() // Older preload compatibility only.
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
    updateBackgroundConversationWorkspace,
    saveConversationMetadata,
    saveConversation,
    setConversationTarget,
    getConversationProject,
    setConversationProject,
    assignConversationProject
  }
}
