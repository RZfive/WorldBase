import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { emitAuthResolution, onAuthResolution, type AuthResolutionPayload } from '../../../utils/auth-events'
import {
  MAX_IMAGE_ATTACHMENT_SIZE_BYTES,
  buildUploadedFilesPrompt,
  extractCodeTagRefs,
  extractDocumentTagRefs,
  extractProjectTagRefs,
  formatFileSize,
  getElectronFilePath,
  isImageAttachment,
  readFileAsDataUrl,
  readUploadedAttachment,
  trimPreviewText
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
  buildOutgoingChatMessages,
  finalizePendingAuthBlocks,
  findLatestAssistantMessage,
  getConversationTitleText,
  getLatestVisibleTodoItems,
  getMessageTextContent,
  hasRenderableContent,
  markAssistantMessageStopped,
  type AssistantStopCopy
} from './message-runtime'
import {
  formatConversationSubtitle,
  getAgentIcon,
  getAgentModelSelection,
  getEnabledProviders,
  getGroupIcon,
  getPinnedAgentConversation,
  getPinnedGroupConversation,
  resolveConversationIcon
} from './provider-utils'
import type {
  AgentDefinition,
  AgentGroupDefinition,
  AIExecutionAuthMode,
  BackgroundStreamState,
  AuthRequestPayload,
  AskUserAnswerPayload,
  AskUserRequestPayload,
  SudoPasswordRequestPayload,
  ChannelBinding,
  ChatMessage,
  ChatMessageBlock,
  ChatPanelProps,
  ConversationSummary,
  FilePreviewState,
  GroupMentionHint,
  PendingAttachment,
  PendingImage,
  ProviderOption,
  ProvidersConfig,
  ReasoningStrength,
  SidebarAgentItem,
  SidebarConversationItem,
  SidebarGroupItem,
  SidebarLongTermGoalItem,
  SkillItem,
  ToolRun,
  WebFetchResultEntry
} from './types'

interface UseChatPanelBindings {
  onContextConsumed: () => void
}

const sharedMessages = ref<ChatMessage[]>([])
const sharedInputText = ref('')
const sharedConversations = ref<ConversationSummary[]>([])
const sharedConversationsLoaded = ref(false)
const sharedCurrentConversationId = ref<string | null>(null)
const sharedTargetProjectId = ref<string | null>(null)
const sharedProviders = ref<ProviderOption[]>([])
const sharedProvidersConfig = ref<ProvidersConfig>({
  providers: [],
  activeProviderId: '',
  enabledProviderIds: []
})
const sharedActiveProviderId = ref('')
const sharedSelectedModel = ref('')
const DEFAULT_REASONING_STRENGTH: ReasoningStrength = 'max'
const sharedReasoningStrength = ref<ReasoningStrength>(DEFAULT_REASONING_STRENGTH)
// Per-conversation temperature override. null = follow the provider default.
const sharedConversationTemperature = ref<number | null>(null)
const sharedCurrentAuthMode = ref<AIExecutionAuthMode>('strict')
const sharedPendingImages = ref<PendingImage[]>([])
const sharedPendingFiles = ref<PendingAttachment[]>([])
const sharedIsUploadingFiles = ref(false)
const sharedUploadFeedback = ref('')
const sharedFilePreview = ref<FilePreviewState>({
  active: false,
  filePath: '',
  lineCount: 0,
  added: 0,
  removed: 0
})
const sharedAvailableSkills = ref<SkillItem[]>([])
const sharedActiveSkillIds = ref<Set<string>>(new Set())
const sharedAvailableAgents = ref<AgentDefinition[]>([])
const sharedAvailableAgentGroups = ref<AgentGroupDefinition[]>([])
const sharedAvailableChannelBindings = ref<ChannelBinding[]>([])
const sharedLongTermGoals = ref<LongTermGoalDefinition[]>([])
const sharedLongTermGoalSnapshot = ref<LongTermGoalSnapshot | null>(null)
const sharedSelectedLongTermGoalId = ref<string | null>(null)
const pendingGoalTitleOverrides = new Map<string, string>()
const pendingGoalStatusOverrides = new Map<string, LongTermGoalDefinition['status']>()
const sharedSelectedAgentId = ref('')
const sharedSelectedGroupId = ref('')
const sharedSelectedChannelBindingId = ref('')
const sharedShowSkillPicker = ref(false)
const sharedPlanModeActive = ref(false)
const sharedSyncingProviderOptions = ref(false)
const sharedDocumentDockVisible = ref(false)
const DEFAULT_DOCUMENT_WORKSPACE_WIDTH = 900
const sharedDocumentWorkspaceDocuments = ref<ConversationDocumentReference[]>([])
const sharedDocumentWorkspaceActiveFilePath = ref<string | null>(null)
const sharedDocumentWorkspaceWidth = ref(DEFAULT_DOCUMENT_WORKSPACE_WIDTH)
const sharedFolderWorkspaceVisible = ref(false)
const DEFAULT_FOLDER_WORKSPACE_WIDTH = 980
const sharedFolderWorkspaceRootPath = ref<string | null>(null)
const sharedFolderWorkspaceRootName = ref<string | null>(null)
const sharedFolderWorkspaceActiveFilePath = ref<string | null>(null)
const sharedFolderWorkspaceWidth = ref(DEFAULT_FOLDER_WORKSPACE_WIDTH)
const sharedStreamingConvIds = reactive(new Set<string>())
const sharedPendingAuthRequestsByConversation = reactive(new Map<string, AuthRequestPayload[]>())
const sharedPendingSudoPasswordRequestsByConversation = reactive(new Map<string, SudoPasswordRequestPayload[]>())
const sharedPendingAskUserRequestsByConversation = reactive(new Map<string, AskUserRequestPayload[]>())
const sharedUnreadConversationIds = reactive(new Set<string>())
const sharedBackgroundStreamMessages = new Map<string, BackgroundStreamState>()
const sharedActiveCleanups = new Map<string, () => void>()
const sharedActiveStreamSessionIds = new Map<string, string>()
const sharedConversationTargets = new Map<string, string | null>()
const LEGACY_FILE_PREVIEW_STAGE = '\u6587\u4ef6\u9884\u89c8'
let sharedProviderChangeCleanup: (() => void) | null = null
let sharedAuthRequestCleanup: (() => void) | null = null
let sharedSudoPasswordRequestCleanup: (() => void) | null = null
let sharedAskUserRequestCleanup: (() => void) | null = null
let sharedAuthResponseCleanup: (() => void) | null = null
let sharedAuthResolvedCleanup: (() => void) | null = null
let sharedSkillsChangedCleanup: (() => void) | null = null
let sharedAgentWorkspaceChangeCleanup: (() => void) | null = null
let sharedLongTermGoalsCleanup: (() => void) | null = null
let sharedLongTermGoalSnapshotCleanup: (() => void) | null = null
let sharedLongTermGoalInterventionCleanup: (() => void) | null = null
let sharedLongTermGoalRunProgressCleanup: (() => void) | null = null
let sharedLifecycleBindingsReady = false
let sharedBeforeUnloadCleanupRegistered = false

function cleanupSharedChatPanelResources (): void {
  for (const cleanup of sharedActiveCleanups.values()) {
    cleanup()
  }
  sharedActiveCleanups.clear()
  sharedActiveStreamSessionIds.clear()
  sharedProviderChangeCleanup?.()
  sharedProviderChangeCleanup = null
  sharedAuthRequestCleanup?.()
  sharedAuthRequestCleanup = null
  sharedSudoPasswordRequestCleanup?.()
  sharedSudoPasswordRequestCleanup = null
  sharedAskUserRequestCleanup?.()
  sharedAskUserRequestCleanup = null
  sharedAuthResolvedCleanup?.()
  sharedAuthResolvedCleanup = null
  sharedSkillsChangedCleanup?.()
  sharedSkillsChangedCleanup = null
  sharedAgentWorkspaceChangeCleanup?.()
  sharedAgentWorkspaceChangeCleanup = null
  sharedLongTermGoalsCleanup?.()
  sharedLongTermGoalsCleanup = null
  sharedLongTermGoalSnapshotCleanup?.()
  sharedLongTermGoalSnapshotCleanup = null
  sharedLongTermGoalInterventionCleanup?.()
  sharedLongTermGoalInterventionCleanup = null
  sharedLongTermGoalRunProgressCleanup?.()
  sharedLongTermGoalRunProgressCleanup = null
  sharedAuthResponseCleanup?.()
  sharedAuthResponseCleanup = null
  sharedLifecycleBindingsReady = false
  sharedBeforeUnloadCleanupRegistered = false
}

export function useChatPanel (props: ChatPanelProps, bindings: UseChatPanelBindings) {
  const { t, locale } = useI18n()
  const getAssistantStopCopy = (): AssistantStopCopy => ({
    stage: t('chatUi.toolStageStopped'),
    detail: t('chatUi.generationStoppedByUser'),
    content: t('chatUi.stoppedMessage')
  })
  const formatAttachmentConversationTitle = (attachmentNames: string[]) => {
    const names = attachmentNames.join(t('chatUi.attachmentNameSeparator'))
    return t('chatUi.attachmentConversationTitle', { names })
  }
  const getNoResponseText = () => t('chatUi.noResponse')
  const messages = sharedMessages
  const inputText = sharedInputText
  const conversations = sharedConversations
  const conversationsLoaded = sharedConversationsLoaded
  const currentConversationId = sharedCurrentConversationId
  const targetProjectId = sharedTargetProjectId
  const providers = sharedProviders
  const providersConfig = sharedProvidersConfig
  const activeProviderId = sharedActiveProviderId
  const selectedModel = sharedSelectedModel
  const reasoningStrength = sharedReasoningStrength
  const conversationTemperature = sharedConversationTemperature
  const currentAuthMode = sharedCurrentAuthMode
  const pendingImages = sharedPendingImages
  const pendingFiles = sharedPendingFiles
  const isUploadingFiles = sharedIsUploadingFiles
  const uploadFeedback = sharedUploadFeedback
  const filePreview = sharedFilePreview

  const availableSkills = sharedAvailableSkills
  const activeSkillIds = sharedActiveSkillIds
  const availableAgents = sharedAvailableAgents
  const availableAgentGroups = sharedAvailableAgentGroups
  const availableChannelBindings = sharedAvailableChannelBindings
  const longTermGoals = sharedLongTermGoals
  const longTermGoalSnapshot = sharedLongTermGoalSnapshot
  const streamingAdjust = ref<{ userContent: string; message: ChatMessage } | null>(null)
  const streamingCreate = ref<{ userContent: string; message: ChatMessage } | null>(null)
  const streamingRun = ref<{ goalId: string; run: LongTermGoalRun } | null>(null)
  const streamingReplan = ref<{ goalId: string; message: ChatMessage } | null>(null)
  const createConversationHistory = ref<ChatMessage[]>([])
  const pendingCreationConfirm = ref<{ changeSet: LongTermGoalChangeSet; proposal: NonNullable<LongTermGoalMessageResult['proposal']> } | null>(null)
  const goalAutoOpenRunId = ref<string | null>(null)

  watch(sharedSelectedLongTermGoalId, () => {
    // 切换目标时丢弃上一个目标的流式状态，避免旧消息串到新目标的对话框。
    streamingAdjust.value = null
    streamingRun.value = null
    streamingReplan.value = null
    streamingCreate.value = null
    createConversationHistory.value = []
    pendingCreationConfirm.value = null
  })
  const selectedLongTermGoalId = sharedSelectedLongTermGoalId
  const selectedAgentId = sharedSelectedAgentId
  const selectedGroupId = sharedSelectedGroupId
  const selectedChannelBindingId = sharedSelectedChannelBindingId
  const showSkillPicker = sharedShowSkillPicker
  const planModeActive = sharedPlanModeActive
  const syncingProviderOptions = sharedSyncingProviderOptions
  const documentDockVisible = sharedDocumentDockVisible
  const documentWorkspaceDocuments = sharedDocumentWorkspaceDocuments
  const documentWorkspaceActiveFilePath = sharedDocumentWorkspaceActiveFilePath
  const documentWorkspaceWidth = sharedDocumentWorkspaceWidth
  const folderWorkspaceVisible = sharedFolderWorkspaceVisible
  const folderWorkspaceRootPath = sharedFolderWorkspaceRootPath
  const folderWorkspaceRootName = sharedFolderWorkspaceRootName
  const folderWorkspaceActiveFilePath = sharedFolderWorkspaceActiveFilePath
  const folderWorkspaceWidth = sharedFolderWorkspaceWidth
  const DOCUMENT_TAG_PATTERN = /\[\[doc:([A-Za-z0-9_-]+)(?:\|([^\]]*))?\]\]/g
  const PROJECT_TAG_PATTERN = /\[\[project:([^\]|]+)(?:\|([^\]]*))?\]\]/g
  const CODE_TAG_PATTERN = /\[\[code:([^\]#|]+)#L(\d+)(?:-L?(\d+))?(?:\|([^\]]*))?\]\]/g

  const streamingConvIds = sharedStreamingConvIds
  const pendingAuthRequestsByConversation = sharedPendingAuthRequestsByConversation
  const pendingSudoPasswordRequestsByConversation = sharedPendingSudoPasswordRequestsByConversation
  const pendingAskUserRequestsByConversation = sharedPendingAskUserRequestsByConversation
  const unreadConversationIds = sharedUnreadConversationIds
  const backgroundStreamMessages = sharedBackgroundStreamMessages
  const activeCleanups = sharedActiveCleanups
  const activeStreamSessionIds = sharedActiveStreamSessionIds
  const conversationTargets = sharedConversationTargets
  const STREAM_RENDER_FLUSH_INTERVAL_MS = 50

  const isLoading = computed(() => {
    return currentConversationId.value ? streamingConvIds.has(currentConversationId.value) : false
  })

  function getPendingAuthRequests (conversationId?: string | null): AuthRequestPayload[] {
    if (!conversationId) {
      return []
    }

    return pendingAuthRequestsByConversation.get(conversationId) ?? []
  }

  const currentPendingAuthCount = computed(() => {
    return currentConversationId.value ? getPendingAuthRequests(currentConversationId.value).length : 0
  })

  const currentPendingAuthRequest = computed<AuthRequestPayload | null>(() => {
    if (!currentConversationId.value) return null
    const list = getPendingAuthRequests(currentConversationId.value)
    return list.length > 0 ? list[0] : null
  })

  function getPendingSudoPasswordRequests (conversationId?: string | null): SudoPasswordRequestPayload[] {
    if (!conversationId) return []
    return pendingSudoPasswordRequestsByConversation.get(conversationId) ?? []
  }

  const currentPendingSudoPasswordCount = computed(() => {
    return currentConversationId.value ? getPendingSudoPasswordRequests(currentConversationId.value).length : 0
  })

  const currentSudoPasswordRequest = computed<SudoPasswordRequestPayload | null>(() => {
    if (!currentConversationId.value) return null
    const list = getPendingSudoPasswordRequests(currentConversationId.value)
    return list.length > 0 ? list[0] : null
  })

  function trackPendingSudoPasswordRequest (req: SudoPasswordRequestPayload): SudoPasswordRequestPayload | null {
    const conversationId = resolveAuthConversationId(req)
    if (!conversationId) return null

    const normalized: SudoPasswordRequestPayload = { ...req, conversationId }
    const currentRequests = getPendingSudoPasswordRequests(conversationId)
    if (!currentRequests.some(item => item.requestId === normalized.requestId)) {
      pendingSudoPasswordRequestsByConversation.set(conversationId, [...currentRequests, normalized])
    }
    return normalized
  }

  function clearPendingSudoPasswordRequest (requestId: string): void {
    for (const [conversationId, requests] of pendingSudoPasswordRequestsByConversation.entries()) {
      const nextRequests = requests.filter(item => item.requestId !== requestId)
      if (nextRequests.length === requests.length) continue

      if (nextRequests.length > 0) {
        pendingSudoPasswordRequestsByConversation.set(conversationId, nextRequests)
      } else {
        pendingSudoPasswordRequestsByConversation.delete(conversationId)
      }
      return
    }
  }

  function getPendingAskUserRequests (conversationId?: string | null): AskUserRequestPayload[] {
    if (!conversationId) {
      return []
    }
    return pendingAskUserRequestsByConversation.get(conversationId) ?? []
  }

  const currentAskUserRequest = computed<AskUserRequestPayload | null>(() => {
    if (!currentConversationId.value) return null
    const list = getPendingAskUserRequests(currentConversationId.value)
    return list.length > 0 ? list[0] : null
  })

  function getUnreadCount (conversationId?: string | null): number {
    if (!conversationId) return 0
    return unreadConversationIds.has(conversationId) ? 1 : 0
  }

  function markConversationUnread (conversationId: string | null | undefined): void {
    if (!conversationId) return
    if (currentConversationId.value === conversationId) return
    unreadConversationIds.add(conversationId)
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
  const isGroupConversation = computed(() => Boolean(selectedGroupId.value))

  const shouldUseConversationProviderOverride = computed(() => {
    if (selectedGroupId.value || selectedChannelBindingId.value) return false
    if (!currentConversationId.value) return true
    const defaultId = getDefaultAgentId()
    return !selectedAgentId.value || selectedAgentId.value === defaultId
  })

  const nonDefaultAgents = computed(() => {
    const defaultId = getDefaultAgentId()
    return availableAgents.value.filter(agent => agent.id !== defaultId)
  })

  const agentSelectorValue = computed(() => {
    const defaultId = getDefaultAgentId()
    return selectedAgentId.value === defaultId ? '' : selectedAgentId.value
  })

  const providersById = computed(() => {
    return new Map(providersConfig.value.providers.map(provider => [provider.id, provider]))
  })

  function mergeGoalTitleState (incomingGoal: LongTermGoalDefinition, existingGoal?: LongTermGoalDefinition): LongTermGoalDefinition {
    const pendingStatus = pendingGoalStatusOverrides.get(incomingGoal.id)
    const pendingTitle = pendingGoalTitleOverrides.get(incomingGoal.id)
    const mergedGoal = pendingStatus ? { ...incomingGoal, status: pendingStatus } : { ...incomingGoal }
    if (pendingTitle) {
      mergedGoal.title = pendingTitle
    }
    return mergedGoal
  }

  const agentsById = computed(() => {
    return new Map(availableAgents.value.map(agent => [agent.id, agent]))
  })

  const groupsById = computed(() => {
    return new Map(availableAgentGroups.value.map(group => [group.id, group]))
  })

  const currentAgentDefinition = computed(() => {
    return selectedAgentId.value ? agentsById.value.get(selectedAgentId.value) || null : null
  })

  const currentGroupDefinition = computed(() => {
    return selectedGroupId.value ? groupsById.value.get(selectedGroupId.value) || null : null
  })

  function buildSidebarSearchText (parts: Array<string | null | undefined>): string {
    return parts
      .filter((value): value is string => Boolean(value && value.trim()))
      .join('\n')
  }

  const agentSidebarItems = computed<SidebarAgentItem[]>(() => {
    const defaultAgentId = getDefaultAgentId()

    return availableAgents.value
      .filter(agent => agent.id !== defaultAgentId)
      .map((agent) => {
        const conversation = getPinnedAgentConversation(conversations.value, agent.id)
        const selection = getAgentModelSelection(agent, providersById.value, activeProviderId.value, t('chatUi.unconfiguredProvider'))

        return {
          id: agent.id,
          conversationId: conversation?.id || null,
          title: agent.name,
          subtitle: `${selection.providerName} · ${selection.modelId || t('chatUi.unconfiguredModel')}`,
          searchText: buildSidebarSearchText([
            agent.name,
            selection.providerName,
            selection.modelId,
            conversation?.title,
            conversation?.previewText,
            conversation?.searchText
          ]),
          icon: getAgentIcon(agent),
          modelId: selection.modelId,
          providerName: selection.providerName,
          modelOptions: selection.modelOptions,
          isStreaming: conversation ? streamingConvIds.has(conversation.id) : false,
          pendingAuthCount: conversation ? getPendingAuthRequests(conversation.id).length : 0,
          unreadCount: conversation ? getUnreadCount(conversation.id) : 0,
          isActive: Boolean(conversation && currentConversationId.value === conversation.id)
        }
      })
  })

  const groupSidebarItems = computed<SidebarGroupItem[]>(() => {
    return availableAgentGroups.value.map((group) => {
      const conversation = getPinnedGroupConversation(conversations.value, group.id)
      const coordinatorName = group.coordinatorAgentId
        ? agentsById.value.get(group.coordinatorAgentId)?.name || t('chatUi.unsetCoordinatorAgent')
        : t('chatUi.unsetCoordinatorAgent')

      return {
        id: group.id,
        conversationId: conversation?.id || null,
        title: group.name,
        subtitle: t('chatUi.groupSidebarSubtitle', { count: group.memberAgentIds.length, coordinator: coordinatorName }),
        searchText: buildSidebarSearchText([
          group.name,
          coordinatorName,
          conversation?.title,
          conversation?.previewText,
          conversation?.searchText
        ]),
        icon: getGroupIcon(group),
        isStreaming: conversation ? streamingConvIds.has(conversation.id) : false,
        pendingAuthCount: conversation ? getPendingAuthRequests(conversation.id).length : 0,
        unreadCount: conversation ? getUnreadCount(conversation.id) : 0,
        isActive: Boolean(conversation && currentConversationId.value === conversation.id)
      }
    })
  })

  function formatGoalSubtitle (goal: LongTermGoalDefinition): string {
    if (goal.status === 'paused') {
      return t('chatUi.longTermGoalPaused')
    }
    if (goal.openInterventions.length > 0) {
      return t('chatUi.goalSidebarNeedsInput', { count: goal.openInterventions.length })
    }
    if (goal.lastRunStatus === 'running') {
      return goal.currentPhase || t('chatUi.longTermGoalRunning')
    }
    const nextRun = goal.nextRunAt
      ? formatConversationSubtitle(goal.nextRunAt, locale.value)
      : t('chatUi.notScheduled')
    const statusPrefix = goal.nextRunAt ? t('chatUi.longTermGoalReady') : t('chatUi.longTermGoalActive')
    return goal.progressSummary
      ? `${statusPrefix} · ${nextRun} · ${goal.progressSummary}`
      : `${statusPrefix} · ${nextRun}`
  }

  const currentLongTermGoal = computed(() => {
    if (!selectedLongTermGoalId.value) return null
    return longTermGoals.value.find(goal => goal.id === selectedLongTermGoalId.value) || null
  })

  const longTermGoalSidebarItems = computed<SidebarLongTermGoalItem[]>(() => {
    return longTermGoals.value.map((goal) => {
      const needsUserInput = goal.openInterventions.some(item => item.status === 'open')
      const isPausedGoal = goal.status === 'paused'
      const isRunningGoal = !isPausedGoal && goal.lastRunStatus === 'running'
      return {
        id: goal.id,
        title: goal.title,
        subtitle: formatGoalSubtitle(goal),
        searchText: buildSidebarSearchText([
          goal.title,
          goal.objective,
          goal.progressSummary,
          goal.gapSummary,
          goal.currentPhase
        ]),
        icon: isPausedGoal ? 'Ⅱ' : needsUserInput ? '▲' : isRunningGoal ? '⏳' : '◎',
        status: goal.status,
        isRunning: isRunningGoal,
        needsUserInput,
        isStreaming: isRunningGoal,
        pendingAuthCount: needsUserInput ? goal.openInterventions.length : 0,
        unreadCount: needsUserInput ? 1 : 0,
        isActive: selectedLongTermGoalId.value === goal.id
      }
    })
  })

  const conversationSidebarItems = computed<SidebarConversationItem[]>(() => {
    const defaultAgentId = getDefaultAgentId()
    const pinnedConversationIds = new Set<string>([
      ...agentSidebarItems.value.map(item => item.conversationId).filter((value): value is string => Boolean(value)),
      ...groupSidebarItems.value.map(item => item.conversationId).filter((value): value is string => Boolean(value))
    ])

    return conversations.value
      .filter((conversation) => {
        if (pinnedConversationIds.has(conversation.id)) {
          return false
        }

        if (conversation.groupId && groupsById.value.has(conversation.groupId)) {
          return false
        }

        if (conversation.agentId && conversation.agentId !== defaultAgentId && agentsById.value.has(conversation.agentId)) {
          return false
        }

        return true
      })
      .map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        subtitle: conversation.previewText
          ? `${formatConversationSubtitle(conversation.updatedAt, locale.value)} · ${conversation.previewText}`
          : formatConversationSubtitle(conversation.updatedAt, locale.value),
        searchText: buildSidebarSearchText([
          conversation.title,
          conversation.previewText,
          conversation.searchText,
          formatConversationSubtitle(conversation.updatedAt, locale.value)
        ]),
        icon: resolveConversationIcon(conversation, groupsById.value, agentsById.value),
        isStreaming: streamingConvIds.has(conversation.id),
        pendingAuthCount: getPendingAuthRequests(conversation.id).length,
        unreadCount: getUnreadCount(conversation.id),
        isActive: currentConversationId.value === conversation.id
      }))
  })

  const currentContextLabel = computed(() => {
    if (currentLongTermGoal.value) {
      return `◎ ${currentLongTermGoal.value.title}`
    }

    if (currentGroupDefinition.value) {
      return `${getGroupIcon(currentGroupDefinition.value)} ${currentGroupDefinition.value.name}`
    }

    if (currentAgentDefinition.value) {
      return `${getAgentIcon(currentAgentDefinition.value)} ${currentAgentDefinition.value.name}`
    }

    return `💬 ${t('chatUi.newConversation')}`
  })

  const currentAssistantIcon = computed(() => {
    if (currentLongTermGoal.value) return '◎'
    if (currentGroupDefinition.value) return getGroupIcon(currentGroupDefinition.value)
    if (currentAgentDefinition.value) return getAgentIcon(currentAgentDefinition.value)
    return '🤖'
  })

  const currentAssistantName = computed(() => {
    if (currentLongTermGoal.value) return currentLongTermGoal.value.title
    if (currentGroupDefinition.value) return currentGroupDefinition.value.name
    if (currentAgentDefinition.value) return currentAgentDefinition.value.name
    return 'The World AI'
  })

  const currentModelLabel = computed(() => {
    if (currentGroupDefinition.value) {
      return t('chatUi.groupCollaborationLabel', { name: currentGroupDefinition.value.name })
    }

    const defaultAgentId = getDefaultAgentId()
    const isNonDefaultAgent = Boolean(selectedAgentId.value) && selectedAgentId.value !== defaultAgentId
    if (currentAgentDefinition.value && isNonDefaultAgent) {
      const selection = getAgentModelSelection(currentAgentDefinition.value, providersById.value, activeProviderId.value, t('chatUi.unconfiguredProvider'))
      const labelParts = [selection.modelId, selection.providerName].filter(Boolean)
      return labelParts.length > 0 ? labelParts.join(' · ') : currentAgentDefinition.value.name
    }

    const provider = providers.value.find(item => item.id === activeProviderId.value)
    const labelParts = [selectedModel.value, provider?.name].filter(Boolean)
    return labelParts.length > 0 ? labelParts.join(' · ') : 'The World AI'
  })

  const currentContextDetail = computed(() => {
    if (currentLongTermGoal.value) {
      if (currentLongTermGoal.value.status === 'paused') return t('chatUi.longTermGoalPaused')
      if (currentLongTermGoal.value.openInterventions.length > 0) return t('chatUi.longTermGoalNeedsInput')
      if (currentLongTermGoal.value.lastRunStatus === 'running') return t('chatUi.longTermGoalRunning')
      return currentLongTermGoal.value.nextRunAt
        ? t('chatUi.longTermGoalReady')
        : (currentLongTermGoal.value.progressSummary || t('chatUi.longTermGoalAutoAdvancing'))
    }

    if (currentGroupDefinition.value) {
      return t('chatUi.groupContextDetail', { count: currentGroupDefinition.value.memberAgentIds.length })
    }

    return currentModelLabel.value
  })

  function normalizeMentionToken (value: string): string {
    return value
      .replace(/^@+/, '')
      .replace(/[【】\[\]（）(){}<>《》「」『』"'“”‘’`~!?,.:;，。！？、：；]/g, '')
      .replace(/\s+/g, '')
      .trim()
      .toLowerCase()
  }

  function resolveKnownMentionMatch (candidate: string, normalizedKnownMentions: string[]): string | null {
    for (const token of normalizedKnownMentions) {
      for (let endOffset = 1; endOffset <= candidate.length; endOffset++) {
        if (normalizeMentionToken(candidate.slice(0, endOffset)) === token) {
          return token
        }
      }
    }

    return null
  }

  function extractMentionTokens (value: string, knownMentions: Iterable<string> = []): string[] {
    const normalizedKnownMentions = Array.from(new Set(Array.from(knownMentions)
      .map(token => normalizeMentionToken(token))
      .filter(Boolean)))
      .sort((left, right) => right.length - left.length)

    if (normalizedKnownMentions.length === 0) {
      const matches = value.match(/@([^\s@]+)/g) || []
      return matches.map(token => normalizeMentionToken(token))
    }

    const matches: string[] = []
    for (let index = 0; index < value.length; index++) {
      if (value[index] !== '@') continue

      const nextAt = value.indexOf('@', index + 1)
      const candidateEnd = nextAt >= 0 ? nextAt : value.length
      const candidate = value.slice(index + 1, candidateEnd)
      const resolved = resolveKnownMentionMatch(candidate, normalizedKnownMentions)
      if (!resolved) continue

      matches.push(resolved)
      index = Math.max(index, candidateEnd - 1)
    }

    return matches
  }

  const groupMentionHints = computed<GroupMentionHint[]>(() => {
    const group = currentGroupDefinition.value
    if (!group) return []

    const hints: GroupMentionHint[] = []
    const coordinator = group.coordinatorAgentId
      ? agentsById.value.get(group.coordinatorAgentId) || null
      : null
    if (coordinator || group.coordinatorAgentId) {
      hints.push({
        token: '@主Agent',
        label: coordinator?.name || t('chatUi.mainAgentFallback'),
        aliases: [
          '主Agent',
          '主协调',
          '协调Agent',
          'coordinator',
          'mainagent',
          coordinator?.name || '',
          group.coordinatorAgentId || ''
        ].filter(Boolean)
      })
    }

    hints.push({
      token: '@all',
      label: t('chatUi.groupAllDiscussionLabel', { name: group.name }),
      aliases: ['all', 'everyone', '全组', '全员', '全部agent', '所有agent']
    })

    const seenTokens = new Set(hints.map(item => item.token))
    const workerMemberIds = Array.from(new Set(group.memberAgentIds.filter(memberId => memberId && memberId !== group.coordinatorAgentId)))

    for (const memberId of workerMemberIds) {
      const agent = agentsById.value.get(memberId)
      const token = `@${agent?.name || memberId}`
      if (seenTokens.has(token)) continue
      seenTokens.add(token)
      hints.push({
        token,
        label: agent?.name || memberId,
        aliases: [agent?.name || '', memberId].filter(Boolean)
      })
    }

    return hints
  })

  function resolveAssistantSpeakerName (sourceText: string): string {
    if (currentGroupDefinition.value) {
      const knownMentionValues = groupMentionHints.value.flatMap((hint) => [hint.token, hint.label, ...(hint.aliases || [])])
      const mentionTokens = extractMentionTokens(sourceText, knownMentionValues)
      const fullGroupRequested = mentionTokens.some(token => {
        return token === 'all' || token === 'everyone' || token === '全组' || token === '全员' || token === '全部agent' || token === '所有agent'
      })
      const matchedLabels = Array.from(new Set(groupMentionHints.value
        .filter((hint) => {
          const searchableTokens = [hint.token, hint.label, ...(hint.aliases || [])]
            .map(normalizeMentionToken)
            .filter(Boolean)
          return mentionTokens.some(token => searchableTokens.includes(token))
        })
        .map(hint => hint.label)))

      if (!fullGroupRequested && matchedLabels.length === 1) {
        return matchedLabels[0]
      }

      const coordinatorName = currentGroupDefinition.value.coordinatorAgentId
        ? agentsById.value.get(currentGroupDefinition.value.coordinatorAgentId)?.name || ''
        : ''
      return coordinatorName || currentGroupDefinition.value.name
    }

    if (currentAgentDefinition.value) {
      return currentAgentDefinition.value.name
    }

    return 'The World AI'
  }

  async function loadSkills () {
    if (!window.electronAPI?.listSkills) return
    try {
      const nextSkills = await window.electronAPI.listSkills() as SkillItem[]
      availableSkills.value = nextSkills

      const availableIds = new Set(nextSkills.map(skill => skill.id))
      const nextActiveIds = Array.from(activeSkillIds.value).filter(id => availableIds.has(id))
      if (nextActiveIds.length !== activeSkillIds.value.size) {
        activeSkillIds.value = new Set(nextActiveIds)
        void syncActiveSkills()
      }
    } catch { /* ignore */ }
  }

  function getDefaultAgentId (): string {
    return availableAgents.value.find(agent => agent.id === 'agent_default')?.id || ''
  }

  async function loadAgentWorkspaceOptions () {
    if (!window.electronAPI?.listAgents || !window.electronAPI?.listAgentGroups || !window.electronAPI?.listChannelBindings) return

    try {
      const [agents, groups, bindings] = await Promise.all([
        window.electronAPI.listAgents(),
        window.electronAPI.listAgentGroups(),
        window.electronAPI.listChannelBindings()
      ])

      availableAgents.value = agents
      availableAgentGroups.value = groups
      availableChannelBindings.value = bindings

      if (selectedAgentId.value && !agents.some(agent => agent.id === selectedAgentId.value)) {
        selectedAgentId.value = ''
      }
      if (selectedGroupId.value && !groups.some(group => group.id === selectedGroupId.value)) {
        selectedGroupId.value = ''
      }
      if (selectedChannelBindingId.value && !bindings.some(binding => binding.id === selectedChannelBindingId.value)) {
        selectedChannelBindingId.value = ''
      }

      if (!selectedAgentId.value && !selectedGroupId.value && !selectedChannelBindingId.value) {
        selectedAgentId.value = getDefaultAgentId()
      }

      if (!currentConversationId.value && !selectedGroupId.value && !selectedChannelBindingId.value && selectedAgentId.value) {
        syncProviderSelectionForAgent(selectedAgentId.value)
      }
    } catch { /* ignore */ }
  }

  function resetTransientStreamState () {
    filePreview.value = {
      active: false,
      filePath: '',
      lineCount: 0,
      added: 0,
      removed: 0
    }
  }

  function getDocumentFileName (filePath: string, fallback?: string | null): string {
    const normalizedFallback = fallback?.trim()
    if (normalizedFallback) return normalizedFallback
    const segments = filePath.split(/[\\/]/).filter(Boolean)
    return segments[segments.length - 1] || filePath
  }

  function normalizeDocumentFileKey (filePath?: string | null): string {
    return (filePath || '')
      .trim()
      .replace(/\//g, '\\')
      .toLowerCase()
  }

  function sanitizeDocumentWorkspaceDocuments (documents?: ConversationDocumentReference[] | null): ConversationDocumentReference[] {
    const uniqueDocuments = new Map<string, ConversationDocumentReference>()

    for (const documentRef of documents || []) {
      const filePath = documentRef?.filePath?.trim()
      if (!filePath) continue
      const fileKey = normalizeDocumentFileKey(filePath)
      if (!fileKey || uniqueDocuments.has(fileKey)) continue
      uniqueDocuments.set(fileKey, {
        filePath,
        fileName: getDocumentFileName(filePath, documentRef.fileName)
      })
    }

    return Array.from(uniqueDocuments.values())
  }

  function applyDocumentWorkspaceState (state?: ConversationDocumentWorkspaceState | null): void {
    const nextDocuments = sanitizeDocumentWorkspaceDocuments(state?.documents)
    documentWorkspaceDocuments.value = nextDocuments

    const normalizedActiveFileKey = normalizeDocumentFileKey(state?.activeFilePath)
    const activeDocument = nextDocuments.find(item => normalizeDocumentFileKey(item.filePath) === normalizedActiveFileKey)
    documentWorkspaceActiveFilePath.value = activeDocument?.filePath || nextDocuments[0]?.filePath || null

    const nextWidth = state?.width
    documentWorkspaceWidth.value = typeof nextWidth === 'number' && Number.isFinite(nextWidth)
      ? Math.round(nextWidth)
      : DEFAULT_DOCUMENT_WORKSPACE_WIDTH
  }

  function buildCurrentDocumentWorkspaceState (): ConversationDocumentWorkspaceState | undefined {
    const documents = sanitizeDocumentWorkspaceDocuments(documentWorkspaceDocuments.value)
    if (documents.length === 0) return undefined

    const activeFilePath = documents.find(item => item.filePath === documentWorkspaceActiveFilePath.value)?.filePath
      || documents[0]?.filePath

    return {
      documents,
      activeFilePath,
      width: documentWorkspaceWidth.value
    }
  }

  function resetDocumentWorkspaceState (): void {
    documentWorkspaceDocuments.value = []
    documentWorkspaceActiveFilePath.value = null
    documentWorkspaceWidth.value = DEFAULT_DOCUMENT_WORKSPACE_WIDTH
  }

  function getFolderWorkspaceName (rootPath: string, fallback?: string | null): string {
    const normalizedFallback = fallback?.trim()
    if (normalizedFallback) return normalizedFallback
    const segments = rootPath.split(/[\\/]/).filter(Boolean)
    return segments[segments.length - 1] || rootPath
  }

  function normalizeFolderWorkspacePathKey (value?: string | null): string {
    return (value || '')
      .trim()
      .replace(/\\/g, '/')
  }

  function applyFolderWorkspaceState (state?: ConversationFolderWorkspaceState | null): void {
    const rootPath = state?.rootPath?.trim()
    if (!rootPath) {
      resetFolderWorkspaceState()
      return
    }

    folderWorkspaceRootPath.value = rootPath
    folderWorkspaceRootName.value = getFolderWorkspaceName(rootPath, state?.rootName)
    folderWorkspaceActiveFilePath.value = normalizeFolderWorkspacePathKey(state?.activeFilePath) || null

    const nextWidth = state?.width
    folderWorkspaceWidth.value = typeof nextWidth === 'number' && Number.isFinite(nextWidth)
      ? Math.round(nextWidth)
      : DEFAULT_FOLDER_WORKSPACE_WIDTH
  }

  function buildCurrentFolderWorkspaceState (): ConversationFolderWorkspaceState | undefined {
    const rootPath = folderWorkspaceRootPath.value?.trim()
    if (!rootPath) return undefined

    return {
      rootPath,
      rootName: getFolderWorkspaceName(rootPath, folderWorkspaceRootName.value),
      activeFilePath: normalizeFolderWorkspacePathKey(folderWorkspaceActiveFilePath.value) || undefined,
      width: folderWorkspaceWidth.value
    }
  }

  function resetFolderWorkspaceState (): void {
    folderWorkspaceRootPath.value = null
    folderWorkspaceRootName.value = null
    folderWorkspaceActiveFilePath.value = null
    folderWorkspaceWidth.value = DEFAULT_FOLDER_WORKSPACE_WIDTH
  }

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

  function resolveConversationAgentSelection (value: { agentId?: string | null; groupId?: string | null; channelBindingId?: string | null }): string {
    if (value.groupId || value.channelBindingId) {
      return value.agentId || ''
    }

    return value.agentId || getDefaultAgentId()
  }

  function getPinnedContextTitle (): string | null {
    if (currentGroupDefinition.value) {
      return currentGroupDefinition.value.name
    }

    if (selectedAgentId.value && selectedAgentId.value !== getDefaultAgentId() && currentAgentDefinition.value) {
      return currentAgentDefinition.value.name
    }

    return null
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

    await doSaveConversation(conversationId, [], {
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

    await createWorkspaceConversation({
      agentId: agent.id,
      title: agent.name
    })
  }

  async function openGroupWorkspaceConversation (groupId: string): Promise<void> {
    const existingConversation = getPinnedGroupConversation(conversations.value, groupId)
    if (existingConversation) {
      await loadConversation(existingConversation.id)
      return
    }

    const group = groupsById.value.get(groupId)
    if (!group) return

    await createWorkspaceConversation({
      groupId: group.id,
      title: group.name
    })
  }

  function toggleSkill (id: string) {
    if (activeSkillIds.value.has(id)) {
      activeSkillIds.value.delete(id)
    } else {
      activeSkillIds.value.add(id)
    }
    void syncActiveSkills()
  }

  function selectAllSkills () {
    activeSkillIds.value = new Set(availableSkills.value.map(skill => skill.id))
    void syncActiveSkills()
  }

  function clearSkills () {
    activeSkillIds.value = new Set()
    void syncActiveSkills()
  }

  async function syncActiveSkills () {
    if (!window.electronAPI?.setActiveSkills) return
    try {
      await window.electronAPI.setActiveSkills(Array.from(activeSkillIds.value))
    } catch { /* ignore */ }
  }

  function resolveAuthConversationId (request: Pick<AuthRequestPayload, 'conversationId' | 'sessionId'>): string | null {
    if (request.conversationId) {
      return request.conversationId
    }

    if (!request.sessionId) {
      return null
    }

    for (const [convId, activeSessionId] of activeStreamSessionIds.entries()) {
      if (activeSessionId === request.sessionId) {
        return convId
      }
    }

    return null
  }

  function trackPendingAuthRequest (request: AuthRequestPayload): AuthRequestPayload | null {
    const conversationId = resolveAuthConversationId(request)
    if (!conversationId) {
      return null
    }

    const normalizedRequest: AuthRequestPayload = {
      ...request,
      conversationId
    }
    const currentRequests = getPendingAuthRequests(conversationId)
    if (!currentRequests.some(item => item.requestId === normalizedRequest.requestId)) {
      pendingAuthRequestsByConversation.set(conversationId, [...currentRequests, normalizedRequest])
    }

    return normalizedRequest
  }

  function clearPendingAuthRequest (requestId: string): void {
    for (const [conversationId, requests] of pendingAuthRequestsByConversation.entries()) {
      const nextRequests = requests.filter(item => item.requestId !== requestId)
      if (nextRequests.length === requests.length) {
        continue
      }

      if (nextRequests.length > 0) {
        pendingAuthRequestsByConversation.set(conversationId, nextRequests)
      } else {
        pendingAuthRequestsByConversation.delete(conversationId)
      }
      return
    }
  }

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

  function getTrackedMessagesBySessionId (sessionId?: string): ChatMessage[] | null {
    if (!sessionId) return null

    for (const [convId, activeSessionId] of activeStreamSessionIds.entries()) {
      if (activeSessionId !== sessionId) continue
      if (currentConversationId.value === convId) {
        return messages.value
      }
      return backgroundStreamMessages.get(convId)?.messages ?? null
    }

    return null
  }

  function getTrackedMessagesByConversationId (conversationId?: string): ChatMessage[] | null {
    if (!conversationId) return null

    if (currentConversationId.value === conversationId) {
      return messages.value
    }

    return backgroundStreamMessages.get(conversationId)?.messages ?? null
  }

  function syncPendingAuthRequestsIntoMessages (_conversationId: string, _targetMessages: ChatMessage[]): void {
    // Auth requests now render in the floating AuthPermissionPanel above the chat input
    // rather than as message blocks, so there is nothing to sync into the transcript.
  }

  function getTrackedMessageCollections (): ChatMessage[][] {
    const collections: ChatMessage[][] = [messages.value]

    for (const { messages: trackedMessages } of backgroundStreamMessages.values()) {
      if (!collections.includes(trackedMessages)) {
        collections.push(trackedMessages)
      }
    }

    return collections
  }

  function setConversationTarget (convId: string, projectId: string | null | undefined) {
    if (!projectId) {
      conversationTargets.delete(convId)
      return
    }
    conversationTargets.set(convId, projectId)
  }

  function getConversationTarget (convId: string | null | undefined): string | null {
    if (!convId) return null
    return conversationTargets.get(convId) ?? null
  }

  function getConversationCreatedAt (convId: string): string {
    return conversations.value.find(conversation => conversation.id === convId)?.createdAt || new Date().toISOString()
  }

  function stashCurrentConversationForNavigation () {
    if (currentConversationId.value && streamingConvIds.has(currentConversationId.value)) {
      backgroundStreamMessages.set(currentConversationId.value, {
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
      void doSaveConversation(currentConversationId.value, messages.value, { targetProjectId: targetProjectId.value })
    }
  }

  async function startOptimizationConversation (ctx: Record<string, unknown>) {
    const projectId = typeof ctx.id === 'string' ? ctx.id : null
    const name = String(ctx.name || ctx.id || t('chatUi.unknownProject'))
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

    await doSaveConversation(conversationId, [], {
      titleOverride: t('chatUi.optimizationConversationTitle', { name }),
      targetProjectId: projectId
    })
  }

  async function applyProvidersConfig (
    config: ProvidersConfig,
    preferredProviderId?: string | null,
    preferredModelId?: string | null
  ) {
    syncingProviderOptions.value = true
    providersConfig.value = {
      providers: config.providers.map(provider => ({ ...provider })),
      activeProviderId: config.activeProviderId,
      enabledProviderIds: [...config.enabledProviderIds]
    }
    providers.value = getEnabledProviders(providersConfig.value)

    const candidateIds = [
      preferredProviderId,
      currentConversationId.value ? conversations.value.find(item => item.id === currentConversationId.value)?.providerId : null,
      activeProviderId.value,
      config.activeProviderId
    ]

    const nextProviderId = candidateIds.find(id => id && providers.value.some(provider => provider.id === id))
      || providers.value[0]?.id
      || ''

    activeProviderId.value = nextProviderId
    const active = providers.value.find(provider => provider.id === nextProviderId)
    const nextModelId = preferredModelId && active?.models.includes(preferredModelId)
      ? preferredModelId
      : active?.activeModel || active?.models[0] || ''
    selectedModel.value = nextModelId

    await nextTick()
    syncingProviderOptions.value = false
  }

  async function persistConversationProviderMeta () {
    if (!currentConversationId.value) return
    await doSaveConversation(currentConversationId.value, messages.value, {
      targetProjectId: targetProjectId.value,
      allowEmpty: true
    })
  }

  function syncProviderSelectionForAgent (agentId: string) {
    const defaultAgentId = getDefaultAgentId()
    if (!agentId || agentId === defaultAgentId) {
      return
    }

    const agent = agentsById.value.get(agentId)
    if (!agent) {
      return
    }

    const provider = agent.providerId
      ? providersById.value.get(agent.providerId) || null
      : null
    if (!provider) {
      return
    }

    const agentModelId = agent.modelId || ''
    const firstProviderModel = provider.models.length > 0 ? provider.models[0] : ''
    const providerFallbackModel = provider.activeModel || firstProviderModel
    const resolvedModelId = provider.models.includes(agentModelId)
      ? agentModelId
      : (providerFallbackModel || '')

    activeProviderId.value = provider.id
    selectedModel.value = resolvedModelId
  }

  async function handleProviderSelectionChange (providerId: string) {
    activeProviderId.value = providerId
    const provider = providers.value.find(item => item.id === providerId)
    selectedModel.value = provider?.activeModel || provider?.models[0] || ''

    if (syncingProviderOptions.value) return
    await persistConversationProviderMeta()
  }

  async function handleModelSelectionChange (model: string) {
    selectedModel.value = model
    if (syncingProviderOptions.value) return
    await persistConversationProviderMeta()
  }

  async function handleReasoningStrengthChange (value: ReasoningStrength) {
    reasoningStrength.value = value
    if (syncingProviderOptions.value || !currentConversationId.value) return
    await doSaveConversation(currentConversationId.value, messages.value, {
      targetProjectId: targetProjectId.value,
      allowEmpty: true
    })
  }

  // Effective provider default temperature for the active/selected provider,
  // falling back to the engine's coding default (0.3) when unset.
  const providerDefaultTemperature = computed<number>(() => {
    const config = providersConfig.value
    const id = activeProviderId.value || config.activeProviderId
    const provider = config.providers.find(item => item.id === id)
    const value = provider?.temperature
    return typeof value === 'number' && Number.isFinite(value) ? value : 0.3
  })

  async function handleTemperatureChange (value: number | null) {
    conversationTemperature.value = value === null || !Number.isFinite(value)
      ? null
      : Math.min(Math.max(value, 0), 2)
    if (syncingProviderOptions.value || !currentConversationId.value) return
    await doSaveConversation(currentConversationId.value, messages.value, {
      targetProjectId: targetProjectId.value,
      allowEmpty: true
    })
  }

  async function handleAuthModeChange (authMode: AIExecutionAuthMode) {
    currentAuthMode.value = authMode
    const activeConversationId = currentConversationId.value
    const activeSessionId = activeConversationId ? activeStreamSessionIds.get(activeConversationId) : null
    if (activeSessionId && window.electronAPI?.updateChatSessionAuthMode) {
      try {
        await window.electronAPI.updateChatSessionAuthMode(activeSessionId, authMode)
      } catch { /* ignore */ }
    }
    if (!currentConversationId.value) return
    await doSaveConversation(currentConversationId.value, messages.value, {
      targetProjectId: targetProjectId.value,
      allowEmpty: true
    })
  }

  async function handleAgentSelectionChange (agentId: string) {
    selectedAgentId.value = agentId
    syncProviderSelectionForAgent(agentId)
    if (!currentConversationId.value) return
    await doSaveConversation(currentConversationId.value, messages.value, {
      targetProjectId: targetProjectId.value,
      allowEmpty: true
    })
  }

  async function handleGroupSelectionChange (groupId: string) {
    selectedGroupId.value = groupId
    if (!currentConversationId.value) return
    await doSaveConversation(currentConversationId.value, messages.value, {
      targetProjectId: targetProjectId.value,
      allowEmpty: true
    })
  }

  async function handleChannelBindingSelectionChange (channelBindingId: string) {
    selectedChannelBindingId.value = channelBindingId
    if (!currentConversationId.value) return
    await doSaveConversation(currentConversationId.value, messages.value, {
      targetProjectId: targetProjectId.value,
      allowEmpty: true
    })
  }

  async function togglePlanMode () {
    planModeActive.value = !planModeActive.value
    if (window.electronAPI?.setPlanMode) {
      try {
        await window.electronAPI.setPlanMode(planModeActive.value)
      } catch { /* ignore */ }
    }
  }

  async function loadConversations () {
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

  async function loadProviders (preferredProviderId?: string | null, preferredModelId?: string | null) {
    if (!window.electronAPI) return
    try {
      const config = await window.electronAPI.getProviders()
      const currentConversation = currentConversationId.value
        ? conversations.value.find(item => item.id === currentConversationId.value)
        : null
      await applyProvidersConfig(
        config,
        preferredProviderId,
        preferredModelId || currentConversation?.selectedModel || selectedModel.value || null
      )
    } catch { /* ignore */ }
  }

  async function loadLongTermGoals () {
    if (!window.electronAPI?.listLongTermGoals) return
    try {
      longTermGoals.value = await window.electronAPI.listLongTermGoals()
      if (selectedLongTermGoalId.value && !longTermGoals.value.some(goal => goal.id === selectedLongTermGoalId.value)) {
        selectedLongTermGoalId.value = null
        longTermGoalSnapshot.value = null
      }
    } catch {
      /* ignore */
    }
  }

  async function loadLongTermGoalSnapshot (goalId?: string | null) {
    if (!window.electronAPI?.getLongTermGoalSnapshot) return
    try {
      longTermGoalSnapshot.value = await window.electronAPI.getLongTermGoalSnapshot(goalId || undefined)
    } catch {
      /* ignore */
    }
  }

  function newConversation () {
    stashCurrentConversationForNavigation()

    selectedLongTermGoalId.value = null
    currentConversationId.value = null
    resetConversationComposerState()
    selectedAgentId.value = getDefaultAgentId()
    selectedGroupId.value = ''
    selectedChannelBindingId.value = ''
    syncProviderSelectionForAgent(selectedAgentId.value)
  }

  async function loadConversation (id: string) {
    if (!window.electronAPI) return

    if (currentConversationId.value && currentConversationId.value !== id) {
      stashCurrentConversationForNavigation()
    }

    selectedLongTermGoalId.value = null
    clearConversationUnread(id)

    const bg = backgroundStreamMessages.get(id)
    if (bg) {
      currentConversationId.value = id
      messages.value = bg.messages
      syncPendingAuthRequestsIntoMessages(id, messages.value)
      targetProjectId.value = bg.targetProjectId
      currentAuthMode.value = bg.authMode
      reasoningStrength.value = bg.reasoningStrength
      conversationTemperature.value = bg.temperature ?? null
      selectedAgentId.value = resolveConversationAgentSelection(bg)
      selectedGroupId.value = bg.groupId || ''
      selectedChannelBindingId.value = bg.channelBindingId || ''
      applyDocumentWorkspaceState(bg.documentWorkspace)
      applyFolderWorkspaceState(bg.folderWorkspace)
      setConversationTarget(id, bg.targetProjectId)
      backgroundStreamMessages.delete(id)
      resetTransientStreamState()
      pendingFiles.value = []
      pendingImages.value = []
      uploadFeedback.value = ''
      await loadProviders(bg.providerId || null, bg.selectedModel || null)
      return
    }

    const conv = await window.electronAPI.getConversation(id)
    if (conv) {
      currentConversationId.value = conv.id
      messages.value = conv.messages
      syncPendingAuthRequestsIntoMessages(conv.id, messages.value)
      targetProjectId.value = conv.targetProjectId || null
      currentAuthMode.value = conv.authMode === 'auto' ? 'auto' : 'strict'
      reasoningStrength.value = conv.reasoningStrength || DEFAULT_REASONING_STRENGTH
      conversationTemperature.value = typeof conv.temperature === 'number' ? conv.temperature : null
      selectedAgentId.value = resolveConversationAgentSelection(conv)
      selectedGroupId.value = conv.groupId || ''
      selectedChannelBindingId.value = conv.channelBindingId || ''
      applyDocumentWorkspaceState(conv.documentWorkspace)
      applyFolderWorkspaceState(conv.folderWorkspace)
      setConversationTarget(conv.id, conv.targetProjectId || null)
      resetTransientStreamState()
      pendingFiles.value = []
      pendingImages.value = []
      uploadFeedback.value = ''
      await loadProviders(conv.providerId || null, conv.selectedModel || null)
    }
  }

  async function openLongTermGoal (goalId: string): Promise<void> {
    stashCurrentConversationForNavigation()
    selectedLongTermGoalId.value = goalId
    currentConversationId.value = null
    messages.value = []
    inputText.value = ''
    resetTransientStreamState()
    pendingFiles.value = []
    pendingImages.value = []
    uploadFeedback.value = ''
    resetDocumentWorkspaceState()
    resetFolderWorkspaceState()
    await loadLongTermGoalSnapshot(goalId)
  }

  async function createLongTermGoal (seed?: string, options?: { providerId?: string | null; modelId?: string | null }): Promise<void> {
    if (!window.electronAPI?.streamLongTermGoalCreate) return
    const normalizedSeed = typeof seed === 'string' ? seed.trim() : ''
    if (!normalizedSeed) return

    const streamId = generateId()
    const message: ChatMessage = {
      role: 'assistant',
      content: '',
      speakerName: 'Long-Term Goal',
      blocks: [createContentBlock('')]
    }
    streamingCreate.value = { userContent: normalizedSeed, message }
    const result = await streamGoalConversation(message, streamId, () => window.electronAPI!.streamLongTermGoalCreate!(normalizedSeed, {
      providerId: options?.providerId || activeProviderId.value || null,
      modelId: options?.modelId || selectedModel.value || null
    }, streamId))
    streamingCreate.value = null
    if (!result) return

    // createGoalViaConversation no longer auto-saves — the goal stays a draft until the user
    // confirms via the ask-style gate. Append this turn to the create conversation history.
    const finalContent = result.assistantTurn?.content || (typeof message.content === 'string' ? message.content : '')
    createConversationHistory.value = [...createConversationHistory.value, {
      role: 'user',
      content: normalizedSeed,
      blocks: [{ id: `goal_create_user_${generateId()}`, kind: 'content', content: normalizedSeed }]
    }, {
      role: 'assistant',
      content: finalContent,
      speakerName: 'Long-Term Goal',
      blocks: [{ id: `goal_create_asst_${generateId()}`, kind: 'content', content: finalContent }]
    }]
    // If the AI produced a proposal, surface the confirmation gate; otherwise stay open for more input.
    pendingCreationConfirm.value = result.changeSet && result.proposal
      ? { changeSet: result.changeSet, proposal: result.proposal }
      : null
  }

  async function saveLongTermGoalPatch (goal: LongTermGoalDefinition, patch: Partial<LongTermGoalDefinition>): Promise<void> {
    if (!window.electronAPI?.saveLongTermGoal) return
    if (typeof patch.title === 'string' && patch.title.trim() && patch.title.trim() !== goal.title && Object.keys(patch).length === 1) {
      await renameLongTermGoal(goal, patch.title)
      return
    }
    // IPC 用 structured clone 序列化，Vue reactive proxy 的嵌套对象/数组无法被克隆，
    // 会抛 "An object could not be cloned."。这里深拷贝成纯对象再合并 patch。
    const plainGoal = JSON.parse(JSON.stringify(goal)) as LongTermGoalDefinition
    const saved = await window.electronAPI.saveLongTermGoal({
      ...plainGoal,
      ...patch,
      title: patch.title || plainGoal.title,
      objective: patch.objective || plainGoal.objective,
      schedule: patch.schedule || plainGoal.schedule
    })
    longTermGoals.value = longTermGoals.value.map(item => item.id === saved.id ? mergeGoalTitleState(saved, item) : item)
    if (!longTermGoals.value.some(item => item.id === saved.id)) {
      longTermGoals.value = [saved, ...longTermGoals.value]
    }
    if (longTermGoalSnapshot.value?.goals.some(item => item.id === saved.id)) {
      longTermGoalSnapshot.value = {
        ...longTermGoalSnapshot.value,
        goals: longTermGoalSnapshot.value.goals.map(item => item.id === saved.id ? mergeGoalTitleState(saved, item) : item)
      }
    }
    selectedLongTermGoalId.value = saved.id
    await loadLongTermGoalSnapshot(saved.id)
  }

  async function renameLongTermGoal (goal: LongTermGoalDefinition, titleInput: string): Promise<void> {
    const title = titleInput.trim()
    if (!title || title === goal.title) return
    const optimisticGoal: LongTermGoalDefinition = {
      ...goal,
      title,
      updatedAt: new Date().toISOString()
    }
    longTermGoals.value = longTermGoals.value.map(item => item.id === goal.id ? optimisticGoal : item)
    pendingGoalTitleOverrides.set(goal.id, title)
    if (longTermGoalSnapshot.value?.goals.some(item => item.id === goal.id)) {
      longTermGoalSnapshot.value = {
        ...longTermGoalSnapshot.value,
        goals: longTermGoalSnapshot.value.goals.map(item => item.id === goal.id ? optimisticGoal : item)
      }
    }
    selectedLongTermGoalId.value = goal.id
    if (!window.electronAPI?.renameLongTermGoal) {
      pendingGoalTitleOverrides.delete(goal.id)
      await loadLongTermGoals()
      return
    }
    let saved: LongTermGoalDefinition
    try {
      saved = await window.electronAPI.renameLongTermGoal(goal.id, title)
    } catch (error) {
      pendingGoalTitleOverrides.delete(goal.id)
      await loadLongTermGoals()
      await loadLongTermGoalSnapshot(goal.id)
      throw error
    }
    pendingGoalTitleOverrides.delete(goal.id)
    longTermGoals.value = longTermGoals.value.map(item => item.id === saved.id ? mergeGoalTitleState(saved, item) : item)
    if (!longTermGoals.value.some(item => item.id === saved.id)) {
      longTermGoals.value = [saved, ...longTermGoals.value]
    }
    if (longTermGoalSnapshot.value?.goals.some(item => item.id === saved.id)) {
      longTermGoalSnapshot.value = {
        ...longTermGoalSnapshot.value,
        goals: longTermGoalSnapshot.value.goals.map(item => item.id === saved.id ? mergeGoalTitleState(saved, item) : item)
      }
    }
    await loadLongTermGoalSnapshot(saved.id)
  }

  async function pauseLongTermGoal (goal: LongTermGoalDefinition): Promise<void> {
    await setLongTermGoalStatus(goal, 'paused')
  }

  async function resumeLongTermGoal (goal: LongTermGoalDefinition): Promise<void> {
    await setLongTermGoalStatus(goal, 'active')
  }

  async function archiveLongTermGoal (goal: LongTermGoalDefinition): Promise<void> {
    await setLongTermGoalStatus(goal, 'archived')
  }

  async function setLongTermGoalStatus (goal: LongTermGoalDefinition, status: LongTermGoalDefinition['status']): Promise<void> {
    const optimisticGoal: LongTermGoalDefinition = {
      ...goal,
      status,
      currentPhase: status === 'active'
        ? (goal.currentPhase === '已暂停' ? '持续推进' : goal.currentPhase)
        : status === 'paused'
          ? '已暂停'
          : goal.currentPhase,
      updatedAt: new Date().toISOString()
    }
    pendingGoalStatusOverrides.set(goal.id, status)
    longTermGoals.value = longTermGoals.value.map(item => item.id === goal.id ? optimisticGoal : item)
    if (longTermGoalSnapshot.value?.goals.some(item => item.id === goal.id)) {
      longTermGoalSnapshot.value = {
        ...longTermGoalSnapshot.value,
        goals: longTermGoalSnapshot.value.goals.map(item => item.id === goal.id ? optimisticGoal : item)
      }
    }
    selectedLongTermGoalId.value = goal.id
    if (!window.electronAPI?.setLongTermGoalStatus) {
      pendingGoalStatusOverrides.delete(goal.id)
      await saveLongTermGoalPatch(optimisticGoal, { status })
      return
    }
    let saved: LongTermGoalDefinition
    try {
      saved = await window.electronAPI.setLongTermGoalStatus(goal.id, status)
    } catch (error) {
      pendingGoalStatusOverrides.delete(goal.id)
      await loadLongTermGoals()
      await loadLongTermGoalSnapshot(goal.id)
      throw error
    }
    pendingGoalStatusOverrides.delete(goal.id)
    longTermGoals.value = longTermGoals.value.map(item => item.id === saved.id ? mergeGoalTitleState(saved, item) : item)
    if (longTermGoalSnapshot.value?.goals.some(item => item.id === saved.id)) {
      longTermGoalSnapshot.value = {
        ...longTermGoalSnapshot.value,
        goals: longTermGoalSnapshot.value.goals.map(item => item.id === saved.id ? mergeGoalTitleState(saved, item) : item)
      }
    }
    await loadLongTermGoalSnapshot(saved.id)
  }

  async function deleteLongTermGoal (goalOrId: LongTermGoalDefinition | string): Promise<void> {
    if (!window.electronAPI?.deleteLongTermGoal) return
    const goalId = typeof goalOrId === 'string' ? goalOrId : goalOrId.id
    await window.electronAPI.deleteLongTermGoal(goalId)
    longTermGoals.value = longTermGoals.value.filter(item => item.id !== goalId)
    if (selectedLongTermGoalId.value === goalId) {
      selectedLongTermGoalId.value = longTermGoals.value[0]?.id || null
      longTermGoalSnapshot.value = null
      if (selectedLongTermGoalId.value) {
        await openLongTermGoal(selectedLongTermGoalId.value)
      } else {
        newConversation()
      }
    }
    await loadLongTermGoals()
  }

  async function runLongTermGoalNow (goalId: string): Promise<void> {
    if (!window.electronAPI?.runLongTermGoalNow) return
    await window.electronAPI.runLongTermGoalNow(goalId)
    await loadLongTermGoals()
    await loadLongTermGoalSnapshot(goalId)
    // 自动打开运行对话框，展示实时执行流；运行进度通过 onLongTermGoalRunProgress 持续更新。
    const snapshot = longTermGoalSnapshot.value
    const runningRun = snapshot?.runs.find(run => run.goalId === goalId && run.status === 'running')
    if (runningRun) {
      streamingRun.value = { goalId, run: runningRun }
      goalAutoOpenRunId.value = runningRun.id
    }
  }

  function clearGoalAutoOpenRunId (): void {
    goalAutoOpenRunId.value = null
  }

  async function streamGoalConversation (
    message: ChatMessage,
    streamId: string,
    invoke: () => Promise<LongTermGoalMessageResult>
  ): Promise<LongTermGoalMessageResult | null> {
    if (!window.electronAPI?.onLongTermGoalStreamEvent) {
      return invoke()
    }
    const toolRuns: ToolRun[] = []
    let thinkingAccum = ''
    let contentAccum = ''
    let pendingThinkingText = ''
    let pendingContentText = ''
    let flushTimer: number | null = null
    let hadToolSinceLastThinking = false

    const syncToolRuns = () => syncLegacyToolRuns(message, toolRuns)
    const clearTimer = () => {
      if (flushTimer != null) {
        window.clearTimeout(flushTimer)
        flushTimer = null
      }
    }
    const flush = () => {
      clearTimer()
      if (pendingThinkingText) {
        if (hadToolSinceLastThinking) {
          thinkingAccum = ''
          hadToolSinceLastThinking = false
        }
        thinkingAccum += pendingThinkingText
        message.thinking = thinkingAccum
        ensureThinkingBlock(message).text = thinkingAccum
        pendingThinkingText = ''
      }
      if (pendingContentText) {
        contentAccum += pendingContentText
        message.content = contentAccum
        const contentBlock = ensureStreamingContentBlock(message)
        const existing = typeof contentBlock.content === 'string' ? contentBlock.content : ''
        contentBlock.content = existing + pendingContentText
        pendingContentText = ''
      }
    }
    const scheduleFlush = () => {
      if (flushTimer != null) return
      flushTimer = window.setTimeout(() => {
        flushTimer = null
        flush()
      }, STREAM_RENDER_FLUSH_INTERVAL_MS)
    }
    const ensureActiveToolRun = (name?: string) => {
      const existing = findLastRunningToolRun(toolRuns, name) || findLastRunningToolRun(toolRuns)
      if (existing) return existing
      const created = createToolRun(name || t('chatUi.toolStageRunning'))
      toolRuns.push(created)
      syncToolRuns()
      return created
    }

    const cleanup = window.electronAPI.onLongTermGoalStreamEvent(streamId, (event) => {
      try {
        if (event.type === 'thinking' && event.content) {
          pendingThinkingText += event.content
          scheduleFlush()
        } else if (event.type === 'token' && event.content) {
          pendingContentText += event.content
          scheduleFlush()
        } else if (event.type === 'tool_start' && event.name) {
          flush()
          hadToolSinceLastThinking = true
          const toolRun = createToolRun(event.name)
          toolRuns.push(toolRun)
          ensureBlocks(message).push(createToolBlock(toolRun))
          syncToolRuns()
        } else if (event.type === 'tool_end') {
          flush()
          const toolRun = findLastRunningToolRun(toolRuns, event.name) || findLastRunningToolRun(toolRuns)
          if (toolRun) {
            toolRun.status = 'completed'
            syncToolRuns()
          }
        } else if (event.type === 'progress' && event.stage) {
          flush()
          const toolRun = ensureActiveToolRun()
          toolRun.progress.push({ stage: event.stage, detail: event.detail })
          syncToolRuns()
        } else if (event.type === 'web_search_result' && event.query) {
          flush()
          ensureBlocks(message).push(createWebSearchBlock(event.query, event.engine || 'web', Array.isArray(event.results) ? event.results : []))
        } else if (event.type === 'web_fetch_result' && event.result) {
          flush()
          ensureBlocks(message).push(createWebFetchBlock(event.result as unknown as WebFetchResultEntry, event.query))
        } else if (event.type === 'done') {
          flush()
          for (const toolRun of toolRuns) {
            if (toolRun.status === 'running') toolRun.status = 'completed'
          }
          syncToolRuns()
          // service 在 done 里转发了剥离 JSON 元数据后的最终正文，直接覆盖流式累积的原始文本。
          if (event.message?.content) {
            contentAccum = event.message.content
            message.content = contentAccum
            appendFinalContentBlock(message, event.message.content)
          }
        } else if (event.type === 'error') {
          flush()
          const toolRun = findLastRunningToolRun(toolRuns)
          if (toolRun) {
            toolRun.status = 'failed'
            toolRun.progress.push({ stage: t('chatUi.toolStageError'), detail: event.error })
            syncToolRuns()
          }
          setAssistantErrorState(message, event.error || t('chatUi.streamFailedUnknown'), getMessageTextContent)
        }
      } catch (err) {
        flush()
        console.error('[longTermGoal] stream event failed:', event, err)
      }
    })

    try {
      const result = await invoke()
      cleanup()
      return result
    } catch (err) {
      cleanup()
      setAssistantErrorState(message, (err as Error).message, getMessageTextContent)
      return null
    }
  }

  async function sendLongTermGoalMessage (goalId: string, content: string): Promise<void> {
    if (!window.electronAPI?.streamLongTermGoalMessage) return
    const streamId = generateId()
    const message: ChatMessage = {
      role: 'assistant',
      content: '',
      speakerName: 'Long-Term Goal',
      blocks: [createContentBlock('')]
    }
    streamingAdjust.value = { userContent: content, message }
    const result = await streamGoalConversation(message, streamId, () => window.electronAPI!.streamLongTermGoalMessage!(goalId, content, streamId))
    if (result) {
      longTermGoals.value = longTermGoals.value.map(item => item.id === result.goal.id ? mergeGoalTitleState(result.goal, item) : item)
    }
    streamingAdjust.value = null
    await loadLongTermGoalSnapshot(goalId)
  }

  async function applyLongTermGoalChangeSet (changeSetId: string): Promise<void> {
    if (!window.electronAPI?.applyLongTermGoalChangeSet) return
    const change = await window.electronAPI.applyLongTermGoalChangeSet(changeSetId)
    await loadLongTermGoals()
    await loadLongTermGoalSnapshot(change.goalId)
  }

  async function cancelLongTermGoalChangeSet (changeSetId: string): Promise<void> {
    if (!window.electronAPI?.cancelLongTermGoalChangeSet) return
    const change = await window.electronAPI.cancelLongTermGoalChangeSet(changeSetId)
    await loadLongTermGoalSnapshot(change.goalId)
  }

  async function applyLongTermGoalCreation (changeSetId: string): Promise<void> {
    if (!window.electronAPI?.applyLongTermGoalCreation) return
    const savedGoal = await window.electronAPI.applyLongTermGoalCreation(changeSetId)
    pendingCreationConfirm.value = null
    createConversationHistory.value = []
    await loadLongTermGoals()
    await openLongTermGoal(savedGoal.id)
  }

  async function cancelLongTermGoalCreation (changeSetId: string): Promise<void> {
    if (!window.electronAPI?.cancelLongTermGoalCreation) return
    await window.electronAPI.cancelLongTermGoalCreation(changeSetId)
    pendingCreationConfirm.value = null
    // Reset history to the intro so the user can start a fresh creation attempt.
    createConversationHistory.value = []
  }

  function resetLongTermGoalCreation (): void {
    pendingCreationConfirm.value = null
    createConversationHistory.value = []
  }

  async function answerLongTermGoalIntervention (goalId: string, interventionId: string, answers: Array<{ questionId: string; selectedOption: string | null; customAnswer: string | null }>): Promise<void> {
    if (!window.electronAPI?.answerLongTermGoalIntervention) return
    const streamId = generateId()
    const message: ChatMessage = {
      role: 'assistant',
      content: '',
      speakerName: 'Long-Term Goal',
      blocks: [createContentBlock('')]
    }
    streamingReplan.value = { goalId, message }

    let thinkingAccum = ''
    let contentAccum = ''
    let pendingThinking = ''
    let pendingContent = ''
    let flushTimer: number | null = null
    const flush = () => {
      if (flushTimer != null) { window.clearTimeout(flushTimer); flushTimer = null }
      if (pendingThinking) {
        thinkingAccum += pendingThinking
        message.thinking = thinkingAccum
        ensureThinkingBlock(message).text = thinkingAccum
        pendingThinking = ''
      }
      if (pendingContent) {
        contentAccum += pendingContent
        message.content = contentAccum
        const block = ensureStreamingContentBlock(message)
        const existing = typeof block.content === 'string' ? block.content : ''
        block.content = existing + pendingContent
        pendingContent = ''
      }
    }
    const scheduleFlush = () => {
      if (flushTimer != null) return
      flushTimer = window.setTimeout(flush, STREAM_RENDER_FLUSH_INTERVAL_MS)
    }
    const unsubscribe = window.electronAPI.onLongTermGoalStreamEvent?.(streamId, (event) => {
      if (event.type === 'thinking' && event.content) { pendingThinking += event.content; scheduleFlush() }
      else if (event.type === 'token' && event.content) { pendingContent += event.content; scheduleFlush() }
      else if (event.type === 'done') {
        flush()
        const finalContent = typeof event.message?.content === 'string' ? event.message.content : contentAccum
        if (finalContent) {
          message.content = finalContent
          ensureStreamingContentBlock(message).content = finalContent
        }
      }
    })

    try {
      const goal = await window.electronAPI.answerLongTermGoalIntervention(goalId, interventionId, answers, streamId)
      flush()
      longTermGoals.value = longTermGoals.value.map(item => item.id === goal.id ? mergeGoalTitleState(goal, item) : item)
      await loadLongTermGoalSnapshot(goalId)
    } finally {
      unsubscribe?.()
      streamingReplan.value = null
    }
  }

  async function doSaveConversation (
    convId: string,
    msgs: ChatMessage[],
    options?: { titleOverride?: string; targetProjectId?: string | null; allowEmpty?: boolean }
  ) {
    if (!window.electronAPI) return
    const existingConversation = conversations.value.find(conversation => conversation.id === convId)
    if (msgs.length === 0 && !options?.titleOverride && !options?.allowEmpty && !existingConversation) return

    const firstUserMsg = msgs.find(message => message.role === 'user')
    const titleText = getConversationTitleText(firstUserMsg, { attachmentTitle: formatAttachmentConversationTitle })
    const shouldKeepManualTitle = Boolean(existingConversation?.manualTitle && !options?.titleOverride)
    const resolvedTitle = options?.titleOverride || (shouldKeepManualTitle ? existingConversation?.title : '') || getPinnedContextTitle() || (titleText
      ? (titleText.length > 40 ? titleText.substring(0, 40) + '...' : titleText)
      : (existingConversation?.title || t('chatUi.newConversation')))
    const resolvedManualTitle = shouldKeepManualTitle || undefined
    const resolvedTargetProjectId = options && Object.prototype.hasOwnProperty.call(options, 'targetProjectId')
      ? (options.targetProjectId ?? null)
      : getConversationTarget(convId)

    setConversationTarget(convId, resolvedTargetProjectId)

    await window.electronAPI.saveConversation(JSON.parse(JSON.stringify({
      id: convId,
      title: resolvedTitle,
      messages: msgs,
      createdAt: getConversationCreatedAt(convId),
      updatedAt: new Date().toISOString(),
      manualTitle: resolvedManualTitle,
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

  async function renameConversation (id: string, title: string): Promise<boolean> {
    const nextTitle = title.trim()
    if (!window.electronAPI || !nextTitle) return false

    const result = await window.electronAPI.renameConversation(id, nextTitle)
    if (!result.success) return false

    conversations.value = conversations.value.map(conversation => (
      conversation.id === id
        ? { ...conversation, title: nextTitle, manualTitle: true }
        : conversation
    ))
    return true
  }

  async function deleteConversation (id: string) {
    if (!window.electronAPI) return
    await window.electronAPI.deleteConversation(id)
    conversationTargets.delete(id)
    backgroundStreamMessages.delete(id)
    activeStreamSessionIds.delete(id)
    if (currentConversationId.value === id) {
      newConversation()
    }
    await loadConversations()
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

  async function addAttachments (files: File[]) {
    if (files.length === 0) return

    isUploadingFiles.value = true
    uploadFeedback.value = ''

    try {
      for (const file of files) {
        if (isImageAttachment(file)) {
          if (file.size > MAX_IMAGE_ATTACHMENT_SIZE_BYTES) {
            uploadFeedback.value = t('chatUi.uploadImageTooLarge', { name: file.name })
            continue
          }

          try {
            const base64 = await readFileAsDataUrl(file, t('chatUi.readFileFailed', { name: file.name }))
            pendingImages.value.push({
              base64,
              mimeType: file.type || 'image/png'
            })
            uploadFeedback.value = ''
          } catch (err) {
            uploadFeedback.value = t('chatUi.uploadAddFailed', { name: file.name, message: (err as Error).message })
          }
          continue
        }

        try {
          const uploaded = await readUploadedAttachment(file, t('chatUi.readAttachmentUnsupported', { name: file.name }))
          pendingFiles.value.push({
            id: generateId(),
            name: uploaded.fileName,
            filePath: uploaded.filePath || getElectronFilePath(file) || file.name,
            fileType: uploaded.fileType,
            fileSizeLabel: formatFileSize(uploaded.size),
            promptContent: uploaded.content,
            previewText: trimPreviewText(uploaded.content)
          })
          uploadFeedback.value = ''
        } catch (err) {
          uploadFeedback.value = t('chatUi.uploadAddFailed', { name: file.name, message: (err as Error).message })
        }
      }
    } finally {
      isUploadingFiles.value = false
    }
  }

  function removeImage (index: number) {
    pendingImages.value.splice(index, 1)
  }

  function removeFile (id: string) {
    pendingFiles.value = pendingFiles.value.filter(file => file.id !== id)
    if (pendingFiles.value.length === 0) {
      uploadFeedback.value = ''
    }
  }

  function insertDocumentTag (tag: string) {
    const spacer = inputText.value.length > 0 && !/\s$/.test(inputText.value) ? ' ' : ''
    inputText.value = `${inputText.value}${spacer}${tag} `
  }

  function updateDocumentWorkspaceState (state: ConversationDocumentWorkspaceState) {
    applyDocumentWorkspaceState(state)
    if (!currentConversationId.value) return
    void doSaveConversation(currentConversationId.value, messages.value, {
      targetProjectId: targetProjectId.value,
      allowEmpty: true
    })
  }

  function updateFolderWorkspaceState (state: ConversationFolderWorkspaceState | null) {
    applyFolderWorkspaceState(state)
    if (!currentConversationId.value) return
    void doSaveConversation(currentConversationId.value, messages.value, {
      targetProjectId: targetProjectId.value,
      allowEmpty: true
    })
  }

  function handleAuthRequest (request: AuthRequestPayload) {
    const trackedRequest = trackPendingAuthRequest(request)
    if (!trackedRequest) {
      console.warn('[chat] Ignoring auth request that could not be routed to a conversation', request)
      return
    }
    // Intentionally do NOT inject the request into the transcript — the floating
    // AuthPermissionPanel above the chat input now owns the approve/deny UI so the
    // streaming output stays free of authorization noise.
  }

  function applyAuthResolution (requestId: string, approved: boolean) {
    clearPendingAuthRequest(requestId)
    for (const chatMessages of getTrackedMessageCollections()) {
      for (const message of chatMessages) {
        if (!Array.isArray(message.blocks)) continue
        const block = message.blocks.find((item): item is Extract<ChatMessageBlock, { kind: 'auth_request' }> => {
          return item.kind === 'auth_request' && item.requestId === requestId
        })
        if (!block) continue
        block.status = approved ? 'approved' : 'denied'
        return
      }
    }
  }

  function handleAuthResolution (payload: AuthResolutionPayload) {
    applyAuthResolution(payload.requestId, payload.approved)
  }

  function respondToAuthRequest (requestId: string, approved: boolean) {
    emitAuthResolution({ requestId, approved })
    window.electronAPI?.respondAuth(requestId, approved)
  }

  function handleSudoPasswordRequest (req: SudoPasswordRequestPayload) {
    const trackedRequest = trackPendingSudoPasswordRequest(req)
    if (!trackedRequest) {
      // Cannot route — cancel immediately so the tool is not left waiting forever
      window.electronAPI?.respondSudoPassword(req.requestId, null)
      return
    }
    // The floating SudoPasswordPanel above the chat input owns the password entry UI
    // so the streaming transcript stays free of authorization noise.
  }

  function respondToSudoPasswordRequest (requestId: string, password: string | null) {
    clearPendingSudoPasswordRequest(requestId)
    window.electronAPI?.respondSudoPassword(requestId, password)
  }

  function resolveAskUserConversationId (request: AskUserRequestPayload): string | null {
    if (request.conversationId) return request.conversationId
    if (!request.sessionId) return currentConversationId.value || null

    for (const [convId, activeSessionId] of activeStreamSessionIds.entries()) {
      if (activeSessionId === request.sessionId) return convId
    }

    return currentConversationId.value || null
  }

  function handleAskUserRequest (request: AskUserRequestPayload) {
    const conversationId = resolveAskUserConversationId(request)
    if (!conversationId) {
      // Cannot route — cancel immediately so the agent isn't left waiting forever.
      window.electronAPI?.respondAskUser(request.requestId, null)
      return
    }
    const normalized: AskUserRequestPayload = { ...request, conversationId }
    const list = getPendingAskUserRequests(conversationId)
    if (!list.some(item => item.requestId === normalized.requestId)) {
      pendingAskUserRequestsByConversation.set(conversationId, [...list, normalized])
    }
    // If the user is currently looking at a different conversation, badge the
    // origin conversation so they know it's blocked on their input.
    if (currentConversationId.value !== conversationId) {
      unreadConversationIds.add(conversationId)
    }
  }

  function clearPendingAskUserRequest (requestId: string): void {
    for (const [conversationId, requests] of pendingAskUserRequestsByConversation.entries()) {
      const next = requests.filter(item => item.requestId !== requestId)
      if (next.length === requests.length) continue
      if (next.length > 0) {
        pendingAskUserRequestsByConversation.set(conversationId, next)
      } else {
        pendingAskUserRequestsByConversation.delete(conversationId)
      }
      return
    }
  }

  function respondToAskUserRequest (requestId: string, answers: AskUserAnswerPayload[] | null) {
    clearPendingAskUserRequest(requestId)
    window.electronAPI?.respondAskUser(requestId, answers)
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

        const chatMessages = JSON.parse(JSON.stringify(buildOutgoingChatMessages(targetMessages.slice(0, -1))))
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
          props.activePageContext ?? undefined,
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
        const chatMessages = JSON.parse(JSON.stringify(buildOutgoingChatMessages(targetMessages.slice(0, -1))))
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

  watch(() => props.projectContext, (ctx) => {
    if (!ctx) return

    void startOptimizationConversation(ctx).finally(() => {
      bindings.onContextConsumed()
    })
  }, { immediate: true })

  function ensureSharedLifecycleBindings () {
    if (sharedLifecycleBindingsReady) {
      return
    }
    sharedLifecycleBindingsReady = true
    try {
      if (window.electronAPI?.onProvidersChanged) {
        sharedProviderChangeCleanup = window.electronAPI.onProvidersChanged((config) => {
          void applyProvidersConfig(config, activeProviderId.value, selectedModel.value)
        })
      }

      if (window.electronAPI?.onAuthRequest) {
        sharedAuthRequestCleanup = window.electronAPI.onAuthRequest(handleAuthRequest)
      }

      if (window.electronAPI?.onSudoPasswordRequest) {
        sharedSudoPasswordRequestCleanup = window.electronAPI.onSudoPasswordRequest(handleSudoPasswordRequest)
      }

      if (window.electronAPI?.onAskUserRequest) {
        sharedAskUserRequestCleanup = window.electronAPI.onAskUserRequest(handleAskUserRequest)
      }

      if (window.electronAPI?.onAuthResolved) {
        sharedAuthResolvedCleanup = window.electronAPI.onAuthResolved(handleAuthResolution)
      }

      if (window.electronAPI?.onSkillsChanged) {
        sharedSkillsChangedCleanup = window.electronAPI.onSkillsChanged(() => {
          void loadSkills()
        })
      }

      if (window.electronAPI?.onAgentWorkspaceChanged) {
        sharedAgentWorkspaceChangeCleanup = window.electronAPI.onAgentWorkspaceChanged(() => {
          void loadAgentWorkspaceOptions()
        })
      }

      if (window.electronAPI?.onLongTermGoalsChanged) {
        sharedLongTermGoalsCleanup = window.electronAPI.onLongTermGoalsChanged((goals) => {
          const existingGoalMap = new Map(longTermGoals.value.map(goal => [goal.id, goal]))
          longTermGoals.value = goals.map(goal => mergeGoalTitleState(goal, existingGoalMap.get(goal.id)))
        })
      }

      if (window.electronAPI?.onLongTermGoalSnapshotChanged) {
        sharedLongTermGoalSnapshotCleanup = window.electronAPI.onLongTermGoalSnapshotChanged((snapshot) => {
          if (!selectedLongTermGoalId.value || snapshot.goals.some(goal => goal.id === selectedLongTermGoalId.value)) {
            if (snapshot.goals.length > 0) {
              const snapshotGoalMap = new Map(snapshot.goals.map(goal => [goal.id, goal]))
              longTermGoals.value = longTermGoals.value.map(goal => {
                const incomingGoal = snapshotGoalMap.get(goal.id)
                return incomingGoal ? mergeGoalTitleState(incomingGoal, goal) : goal
              })
              for (const goal of snapshot.goals) {
                if (!longTermGoals.value.some(item => item.id === goal.id)) {
                  longTermGoals.value = [mergeGoalTitleState(goal), ...longTermGoals.value]
                }
              }
            }
            longTermGoalSnapshot.value = selectedLongTermGoalId.value
              ? {
                  ...snapshot,
                  goals: snapshot.goals.filter(goal => goal.id === selectedLongTermGoalId.value),
                  runs: snapshot.runs.filter(run => run.goalId === selectedLongTermGoalId.value),
                  reviews: snapshot.reviews.filter(review => review.goalId === selectedLongTermGoalId.value),
                  activities: snapshot.activities.filter(activity => activity.goalId === selectedLongTermGoalId.value),
                  memories: snapshot.memories.filter(memory => memory.goalId === selectedLongTermGoalId.value),
                  conversations: snapshot.conversations.filter(turn => turn.goalId === selectedLongTermGoalId.value),
                  changeSets: snapshot.changeSets.filter(change => change.goalId === selectedLongTermGoalId.value)
                }
              : snapshot
          }
        })
      }

      if (window.electronAPI?.onLongTermGoalInterventionRequested) {
        sharedLongTermGoalInterventionCleanup = window.electronAPI.onLongTermGoalInterventionRequested((intervention) => {
          if (selectedLongTermGoalId.value === intervention.goalId) {
            void loadLongTermGoalSnapshot(intervention.goalId)
          }
          void loadLongTermGoals()
        })
      }

      if (window.electronAPI?.onLongTermGoalRunProgress) {
        sharedLongTermGoalRunProgressCleanup = window.electronAPI.onLongTermGoalRunProgress(({ goalId, run }) => {
          // 仅更新当前选中目标的运行流；其他目标的进度等下次打开快照时自然刷新。
          if (selectedLongTermGoalId.value !== goalId) return
          streamingRun.value = { goalId, run }
          // 运行结束后清空流式消息，让快照里的最终 run 接管显示。
          if (run.status === 'completed' || run.status === 'failed') {
            void loadLongTermGoalSnapshot(goalId).then(() => {
              streamingRun.value = null
            })
          }
        })
      }

      sharedAuthResponseCleanup = onAuthResolution(handleAuthResolution)

      if (!sharedBeforeUnloadCleanupRegistered) {
        window.addEventListener('beforeunload', cleanupSharedChatPanelResources)
        sharedBeforeUnloadCleanupRegistered = true
      }
    } catch (error) {
      sharedLifecycleBindingsReady = false
      throw error
    }
  }

  onMounted(async () => {
    await loadConversations()
    await loadLongTermGoals()
    await loadProviders()
    await loadSkills()
    await loadAgentWorkspaceOptions()
    ensureSharedLifecycleBindings()
  })

  onUnmounted(() => {
    // Keep shared stream subscriptions alive so in-flight thinking/text continues
    // updating when the chat shell is temporarily unmounted or hidden.
  })

  return {
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
    documentDockVisible,
    documentWorkspaceActiveFilePath,
    documentWorkspaceDocuments,
    documentWorkspaceWidth,
    folderWorkspaceActiveFilePath,
    folderWorkspaceRootName,
    folderWorkspaceRootPath,
    folderWorkspaceVisible,
    folderWorkspaceWidth,
    filePreview,
    groupMentionHints,
    groupSidebarItems,
    longTermGoalSidebarItems,
    longTermGoalSnapshot,
    streamingAdjust,
    streamingCreate,
    streamingRun,
    streamingReplan,
    createConversationHistory,
    goalAutoOpenRunId,
    handleAgentSelectionChange,
    handleAuthModeChange,
    handleChannelBindingSelectionChange,
    handleModelSelectionChange,
    handleProviderSelectionChange,
    handleReasoningStrengthChange,
    handleTemperatureChange,
    inputText,
    insertDocumentTag,
    isGroupConversation,
    isLoading,
    isUploadingFiles,
    loadConversation,
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
    providers,
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
    selectedModel,
    selectAllSkills,
    sendMessage,
    sendLongTermGoalMessage,
    applyLongTermGoalChangeSet,
    cancelLongTermGoalChangeSet,
    applyLongTermGoalCreation,
    cancelLongTermGoalCreation,
    resetLongTermGoalCreation,
    pendingCreationConfirm,
    answerLongTermGoalIntervention,
    shouldUseConversationProviderOverride,
    showSkillPicker,
    stopCurrentStream,
    togglePlanMode,
    toggleSkill,
    clearSkills,
    updateDocumentWorkspaceState,
    updateFolderWorkspaceState,
    uploadFeedback,
    addAttachments
  }
}
