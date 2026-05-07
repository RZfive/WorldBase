import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { emitAuthResolution, onAuthResolution, type AuthResolutionPayload } from '../../../utils/auth-events'
import {
  MAX_IMAGE_ATTACHMENT_SIZE_BYTES,
  buildUploadedFilesPrompt,
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
  createSudoPasswordRequestBlock,
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
  ensureAuthRequestBlockInMessages,
  finalizePendingAuthBlocks,
  findLatestAssistantMessage,
  getConversationTitleText,
  getLatestVisibleTodoItems,
  getMessageTextContent,
  hasRenderableContent,
  markAssistantMessageStopped
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
const sharedReasoningStrength = ref<ReasoningStrength>('medium')
const sharedCurrentAuthMode = ref<AIExecutionAuthMode>('strict')
const sharedPendingImages = ref<PendingImage[]>([])
const sharedPendingFiles = ref<PendingAttachment[]>([])
const sharedIsUploadingFiles = ref(false)
const sharedUploadFeedback = ref('')
const sharedFilePreview = ref<FilePreviewState>({
  active: false,
  filePath: '',
  content: '',
  truncated: false
})
const sharedAvailableSkills = ref<SkillItem[]>([])
const sharedActiveSkillIds = ref<Set<string>>(new Set())
const sharedAvailableAgents = ref<AgentDefinition[]>([])
const sharedAvailableAgentGroups = ref<AgentGroupDefinition[]>([])
const sharedAvailableChannelBindings = ref<ChannelBinding[]>([])
const sharedSelectedAgentId = ref('')
const sharedSelectedGroupId = ref('')
const sharedSelectedChannelBindingId = ref('')
const sharedShowSkillPicker = ref(false)
const sharedPlanModeActive = ref(false)
const sharedSyncingProviderOptions = ref(false)
const sharedDocumentDockVisible = ref(false)
const sharedStreamingConvIds = reactive(new Set<string>())
const sharedPendingAuthRequestsByConversation = reactive(new Map<string, AuthRequestPayload[]>())
const sharedBackgroundStreamMessages = new Map<string, BackgroundStreamState>()
const sharedActiveCleanups = new Map<string, () => void>()
const sharedActiveStreamSessionIds = new Map<string, string>()
const sharedConversationTargets = new Map<string, string | null>()
let sharedProviderChangeCleanup: (() => void) | null = null
let sharedAuthRequestCleanup: (() => void) | null = null
let sharedSudoPasswordRequestCleanup: (() => void) | null = null
let sharedAuthResponseCleanup: (() => void) | null = null
let sharedAuthResolvedCleanup: (() => void) | null = null
let sharedSkillsChangedCleanup: (() => void) | null = null
let sharedAgentWorkspaceChangeCleanup: (() => void) | null = null
let sharedLifecycleBindingsReady = false

export function useChatPanel (props: ChatPanelProps, bindings: UseChatPanelBindings) {
  const messages = sharedMessages
  const inputText = sharedInputText
  const conversations = sharedConversations
  const currentConversationId = sharedCurrentConversationId
  const targetProjectId = sharedTargetProjectId
  const providers = sharedProviders
  const providersConfig = sharedProvidersConfig
  const activeProviderId = sharedActiveProviderId
  const selectedModel = sharedSelectedModel
  const reasoningStrength = sharedReasoningStrength
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
  const selectedAgentId = sharedSelectedAgentId
  const selectedGroupId = sharedSelectedGroupId
  const selectedChannelBindingId = sharedSelectedChannelBindingId
  const showSkillPicker = sharedShowSkillPicker
  const planModeActive = sharedPlanModeActive
  const syncingProviderOptions = sharedSyncingProviderOptions
  const documentDockVisible = sharedDocumentDockVisible
  const DOCUMENT_TAG_PATTERN = /\[\[doc:([A-Za-z0-9_-]+)(?:\|([^\]]*))?\]\]/g
  const PROJECT_TAG_PATTERN = /\[\[project:([^\]|]+)(?:\|([^\]]*))?\]\]/g

  const streamingConvIds = sharedStreamingConvIds
  const pendingAuthRequestsByConversation = sharedPendingAuthRequestsByConversation
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
        const selection = getAgentModelSelection(agent, providersById.value, activeProviderId.value)

        return {
          id: agent.id,
          conversationId: conversation?.id || null,
          title: agent.name,
          subtitle: `${selection.providerName} · ${selection.modelId || '未配置模型'}`,
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
          isActive: Boolean(conversation && currentConversationId.value === conversation.id)
        }
      })
  })

  const groupSidebarItems = computed<SidebarGroupItem[]>(() => {
    return availableAgentGroups.value.map((group) => {
      const conversation = getPinnedGroupConversation(conversations.value, group.id)
      const coordinatorName = group.coordinatorAgentId
        ? agentsById.value.get(group.coordinatorAgentId)?.name || '未设置协调 Agent'
        : '未设置协调 Agent'

      return {
        id: group.id,
        conversationId: conversation?.id || null,
        title: group.name,
        subtitle: `${group.memberAgentIds.length} 位 Agent · 协调 ${coordinatorName}`,
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
        isActive: Boolean(conversation && currentConversationId.value === conversation.id)
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
          ? `${formatConversationSubtitle(conversation.updatedAt)} · ${conversation.previewText}`
          : formatConversationSubtitle(conversation.updatedAt),
        searchText: buildSidebarSearchText([
          conversation.title,
          conversation.previewText,
          conversation.searchText,
          formatConversationSubtitle(conversation.updatedAt)
        ]),
        icon: resolveConversationIcon(conversation, groupsById.value, agentsById.value),
        isStreaming: streamingConvIds.has(conversation.id),
        pendingAuthCount: getPendingAuthRequests(conversation.id).length,
        isActive: currentConversationId.value === conversation.id
      }))
  })

  const currentContextLabel = computed(() => {
    if (currentGroupDefinition.value) {
      return `${getGroupIcon(currentGroupDefinition.value)} ${currentGroupDefinition.value.name}`
    }

    if (currentAgentDefinition.value) {
      return `${getAgentIcon(currentAgentDefinition.value)} ${currentAgentDefinition.value.name}`
    }

    return '💬 新对话'
  })

  const currentModelLabel = computed(() => {
    if (currentGroupDefinition.value) {
      return `群组协作 · ${currentGroupDefinition.value.name}`
    }

    const defaultAgentId = getDefaultAgentId()
    const isNonDefaultAgent = Boolean(selectedAgentId.value) && selectedAgentId.value !== defaultAgentId
    if (currentAgentDefinition.value && isNonDefaultAgent) {
      const selection = getAgentModelSelection(currentAgentDefinition.value, providersById.value, activeProviderId.value)
      const labelParts = [selection.modelId, selection.providerName].filter(Boolean)
      return labelParts.length > 0 ? labelParts.join(' · ') : currentAgentDefinition.value.name
    }

    const provider = providers.value.find(item => item.id === activeProviderId.value)
    const labelParts = [selectedModel.value, provider?.name].filter(Boolean)
    return labelParts.length > 0 ? labelParts.join(' · ') : 'The World AI'
  })

  const currentContextDetail = computed(() => {
    if (currentGroupDefinition.value) {
      return `${currentGroupDefinition.value.memberAgentIds.length} 位 Agent 协作 · 默认全群讨论，@主Agent 或协调者可决定是否拉群，单独 @成员 直接回复，@多人 / @all 指定讨论范围`
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
        label: coordinator?.name || '主 Agent',
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
      label: `${group.name} 全组讨论`,
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
      content: '',
      truncated: false
    }
  }

  function resetConversationComposerState (): void {
    messages.value = []
    targetProjectId.value = null
    currentAuthMode.value = 'strict'
    reasoningStrength.value = 'medium'
    inputText.value = ''
    resetTransientStreamState()
    pendingImages.value = []
    pendingFiles.value = []
    uploadFeedback.value = ''
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

  function syncPendingAuthRequestsIntoMessages (conversationId: string, targetMessages: ChatMessage[]): void {
    for (const request of getPendingAuthRequests(conversationId)) {
      ensureAuthRequestBlockInMessages(targetMessages, request)
    }
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
        agentId: selectedAgentId.value || null,
        groupId: selectedGroupId.value || null,
        channelBindingId: selectedChannelBindingId.value || null
      })
      void doSaveConversation(currentConversationId.value, messages.value, { targetProjectId: targetProjectId.value })
    }
  }

  async function startOptimizationConversation (ctx: Record<string, unknown>) {
    const projectId = typeof ctx.id === 'string' ? ctx.id : null
    const name = String(ctx.name || ctx.id || '未知项目')
    const projectRef = projectId ? `[[project:${projectId}|${name}]]` : ''
    const conversationId = generateId()

    stashCurrentConversationForNavigation()

    currentConversationId.value = conversationId
    messages.value = []
    targetProjectId.value = projectId
    currentAuthMode.value = 'strict'
    reasoningStrength.value = 'medium'
    selectedAgentId.value = getDefaultAgentId()
    selectedGroupId.value = ''
    selectedChannelBindingId.value = ''
    syncProviderSelectionForAgent(selectedAgentId.value)
    inputText.value = `${projectRef}${projectRef ? '\n' : ''}请先检查这个项目的当前代码、运行状态和最近日志，明确告诉我这个项目现在的具体问题、风险点和可优化项，然后再继续修改。`
    pendingImages.value = []
    pendingFiles.value = []
    uploadFeedback.value = ''
    resetTransientStreamState()
    setConversationTarget(conversationId, projectId)

    await doSaveConversation(conversationId, [], {
      titleOverride: `优化 · ${name}`,
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
    if (!window.electronAPI) return
    try {
      conversations.value = await window.electronAPI.listConversations()
    } catch { /* ignore */ }
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

  function newConversation () {
    stashCurrentConversationForNavigation()

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

    const bg = backgroundStreamMessages.get(id)
    if (bg) {
      currentConversationId.value = id
      messages.value = bg.messages
      syncPendingAuthRequestsIntoMessages(id, messages.value)
      targetProjectId.value = bg.targetProjectId
      currentAuthMode.value = bg.authMode
      reasoningStrength.value = bg.reasoningStrength
      selectedAgentId.value = resolveConversationAgentSelection(bg)
      selectedGroupId.value = bg.groupId || ''
      selectedChannelBindingId.value = bg.channelBindingId || ''
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
      reasoningStrength.value = conv.reasoningStrength || 'medium'
      selectedAgentId.value = resolveConversationAgentSelection(conv)
      selectedGroupId.value = conv.groupId || ''
      selectedChannelBindingId.value = conv.channelBindingId || ''
      setConversationTarget(conv.id, conv.targetProjectId || null)
      resetTransientStreamState()
      pendingFiles.value = []
      pendingImages.value = []
      uploadFeedback.value = ''
      await loadProviders(conv.providerId || null, conv.selectedModel || null)
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
    const titleText = getConversationTitleText(firstUserMsg)
    const resolvedTitle = options?.titleOverride || getPinnedContextTitle() || (titleText
      ? (titleText.length > 40 ? titleText.substring(0, 40) + '...' : titleText)
      : (existingConversation?.title || '新对话'))
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
      authMode: currentAuthMode.value,
      providerId: shouldUseConversationProviderOverride.value ? (activeProviderId.value || undefined) : undefined,
      selectedModel: shouldUseConversationProviderOverride.value ? (selectedModel.value || undefined) : undefined,
      reasoningStrength: reasoningStrength.value,
      targetProjectId: resolvedTargetProjectId || undefined,
      agentId: selectedAgentId.value || undefined,
      groupId: selectedGroupId.value || undefined,
      channelBindingId: selectedChannelBindingId.value || undefined
    })))

    await loadConversations()
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
      markAssistantMessageStopped(assistantMessage)
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
            uploadFeedback.value = `${file.name} 添加失败：图片大小不能超过 20MB`
            continue
          }

          try {
            const base64 = await readFileAsDataUrl(file)
            pendingImages.value.push({
              base64,
              mimeType: file.type || 'image/png'
            })
            uploadFeedback.value = ''
          } catch (err) {
            uploadFeedback.value = `${file.name} 添加失败：${(err as Error).message}`
          }
          continue
        }

        try {
          const uploaded = await readUploadedAttachment(file)
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
          uploadFeedback.value = `${file.name} 添加失败：${(err as Error).message}`
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

  function handleAuthRequest (request: AuthRequestPayload) {
    const trackedRequest = trackPendingAuthRequest(request)
    if (!trackedRequest) {
      console.warn('[chat] Ignoring auth request that could not be routed to a conversation', request)
      return
    }

    const targetMessages = getTrackedMessagesByConversationId(trackedRequest.conversationId)
      ?? getTrackedMessagesBySessionId(trackedRequest.sessionId)

    if (targetMessages) {
      ensureAuthRequestBlockInMessages(targetMessages, trackedRequest)
    }
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

  function handleSudoPasswordRequest (req: { requestId: string; conversationId?: string; sessionId?: string; command: string }) {
    const targetMessages = getTrackedMessagesByConversationId(req.conversationId)
      ?? getTrackedMessagesBySessionId(req.sessionId)

    if (!targetMessages) {
      // Cannot route — cancel immediately so the tool is not left waiting forever
      window.electronAPI?.respondSudoPassword(req.requestId, null)
      return
    }

    let assistantMessage = findLatestAssistantMessage(targetMessages)
    if (!assistantMessage) {
      const placeholder: ChatMessage = { role: 'assistant', content: '', blocks: [] }
      targetMessages.push(placeholder)
      assistantMessage = placeholder
    }
    ensureBlocks(assistantMessage).push(createSudoPasswordRequestBlock(req.requestId, req.command))
  }

  function respondToSudoPasswordRequest (requestId: string, password: string | null) {
    for (const chatMessages of getTrackedMessageCollections()) {
      for (const message of chatMessages) {
        if (!Array.isArray(message.blocks)) continue
        const block = message.blocks.find(
          (b): b is Extract<ChatMessageBlock, { kind: 'sudo_password_request' }> =>
            b.kind === 'sudo_password_request' && (b as Extract<ChatMessageBlock, { kind: 'sudo_password_request' }>).requestId === requestId
        )
        if (block) {
          block.status = password !== null ? 'submitted' : 'canceled'
          break
        }
      }
    }
    window.electronAPI?.respondSudoPassword(requestId, password)
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
    const { regionIds: referencedDocumentRegionIds, normalizedText } = extractDocumentTagRefs(textAfterProject, DOCUMENT_TAG_PATTERN)

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

    const flushPendingStreamText = () => {
      clearPendingStreamFlush()

      if (pendingThinkingText) {
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
        contentBlock.content = contentAccum
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

    const ensureActiveToolRun = (name = '执行中') => {
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
              const activeToolRun = ensureActiveToolRun('文件生成')
              const alreadyLogged = activeToolRun.progress.some(step => step.stage === '文件预览' && step.detail === event.filePath)
              if (!alreadyLogged) {
                activeToolRun.progress.push({ stage: '文件预览', detail: event.filePath })
                syncAssistantToolRuns()
              }
              ensureBlocks(assistantMessage).push(createFilePreviewBlock(event.filePath, Boolean(event.truncated)))
              if (isForeground) {
                filePreview.value = {
                  active: true,
                  filePath: event.filePath,
                  content: '',
                  truncated: Boolean(event.truncated)
                }
              }
            } else if (event.type === 'file_preview_chunk' && event.content) {
              const previewBlock = getLastActivePreviewBlock(assistantMessage, event.filePath)
              if (previewBlock) {
                previewBlock.previewContent += event.content
              }
              if (isForeground && filePreview.value.filePath === event.filePath) {
                filePreview.value = {
                  ...filePreview.value,
                  content: filePreview.value.content + event.content
                }
              }
            } else if (event.type === 'file_preview_end') {
              const previewBlock = getLastActivePreviewBlock(assistantMessage, event.filePath)
              if (previewBlock) {
                previewBlock.active = false
                previewBlock.truncated = Boolean(event.truncated ?? previewBlock.truncated)
              }
              if (isForeground) {
                filePreview.value = {
                  ...filePreview.value,
                  active: false,
                  truncated: Boolean(event.truncated ?? filePreview.value.truncated)
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
                  assistantMessage.content = '(无响应)'
                  contentAccum = '(无响应)'
                  ensureBlocks(assistantMessage).push(createContentBlock('(无响应)'))
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
                  activeToolRun.progress.push({ stage: '错误', detail: event.error })
                  syncAssistantToolRuns()
                }
                finalizePendingAuthBlocks(assistantMessage)
                setAssistantErrorState(assistantMessage, event.error || '流式响应失败，但未返回具体错误信息', getMessageTextContent)
              } finally {
                finishSession()
              }
            } else if (event.type === 'stopped') {
              try {
                flushPendingStreamText()
                markAssistantMessageStopped(assistantMessage)
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
              activeToolRun.progress.push({ stage: '渲染错误', detail: (err as Error).message })
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
          props.activePageContext ?? undefined
        )

        if (streamingConvIds.has(convId)) {
          releaseStreamSession(convId, sessionId)
          if (!hasRenderableContent(assistantMessage)) {
            assistantMessage.content = '(无响应)'
            ensureBlocks(assistantMessage).push(createContentBlock('(无响应)'))
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
        assistantMessage.content = response.content || '(无响应)'
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

    sharedAuthResponseCleanup = onAuthResolution(handleAuthResolution)
    sharedLifecycleBindingsReady = true
  }

  onMounted(async () => {
    await loadConversations()
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
    conversationSidebarItems,
    currentAuthMode,
    currentContextDetail,
    currentContextLabel,
    currentConversationId,
    currentPendingAuthCount,
    deleteConversation,
    documentDockVisible,
    filePreview,
    groupMentionHints,
    groupSidebarItems,
    handleAgentSelectionChange,
    handleAuthModeChange,
    handleChannelBindingSelectionChange,
    handleModelSelectionChange,
    handleProviderSelectionChange,
    handleReasoningStrengthChange,
    inputText,
    insertDocumentTag,
    isGroupConversation,
    isLoading,
    isUploadingFiles,
    loadConversation,
    messages,
    newConversation,
    nonDefaultAgents,
    openAgentWorkspaceConversation,
    openGroupWorkspaceConversation,
    pendingFiles,
    pendingImages,
    planModeActive,
    providers,
    reasoningStrength,
    removeFile,
    removeImage,
    respondToAuthRequest,
    respondToSudoPasswordRequest,
    selectedChannelBindingId,
    selectedModel,
    selectAllSkills,
    sendMessage,
    shouldUseConversationProviderOverride,
    showSkillPicker,
    stopCurrentStream,
    togglePlanMode,
    toggleSkill,
    clearSkills,
    uploadFeedback,
    addAttachments
  }
}
