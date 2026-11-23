import { computed, type ComputedRef, type Ref } from 'vue'
import type { ComposerTranslation } from 'vue-i18n'
import type { LongTermGoalDefinition } from '../../../../shared/long-term-goal-types.js'
import { resolveRoomAddress, ROOM_ALL_MENTIONS, ROOM_DEFAULT_MENTIONS } from '../../../../shared/group-mentions.js'
import { roomLocalWorkerName } from '../../../../shared/local-agent-types.js'
import {
  formatConversationSubtitle,
  getAgentIcon,
  getAgentModelSelection,
  getGroupIcon,
  getPinnedAgentConversation,
  getPinnedGroupConversation,
  resolveConversationIcon
} from './provider-utils'
import type {
  AgentDefinition,
  AgentGroupDefinition,
  ConversationSummary,
  GroupMentionHint,
  ProviderOption,
  ProvidersConfig,
  SidebarAgentItem,
  SidebarConversationItem,
  SidebarGroupItem,
  SidebarLongTermGoalItem
} from './types'

interface ChatSidebarStateOptions {
  t: ComposerTranslation
  locale: Ref<string>
  conversations: Ref<ConversationSummary[]>
  providers: Ref<ProviderOption[]>
  providersConfig: Ref<ProvidersConfig>
  activeProviderId: Ref<string>
  selectedModel: Ref<string>
  availableAgents: Ref<AgentDefinition[]>
  availableAgentGroups: Ref<AgentGroupDefinition[]>
  longTermGoals: Ref<LongTermGoalDefinition[]>
  selectedLongTermGoalId: Ref<string | null>
  selectedAgentId: Ref<string>
  selectedGroupId: Ref<string>
  selectedChannelBindingId: Ref<string>
  currentConversationId: Ref<string | null>
  streamingConversationIds: Set<string>
  getPendingAuthCount: (conversationId: string) => number
  getUnreadCount: (conversationId: string) => number
}

function buildSidebarSearchText (parts: Array<string | null | undefined>): string {
  return parts
    .filter((value): value is string => Boolean(value && value.trim()))
    .join('\n')
}

function roomMemberIds (group: AgentGroupDefinition): string[] {
  return [...new Set([group.coordinatorAgentId, ...group.memberAgentIds].filter(Boolean))]
}

export function createChatSidebarState (options: ChatSidebarStateOptions) {
  const {
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
    streamingConversationIds,
    getPendingAuthCount,
    getUnreadCount
  } = options

  function getDefaultAgentId (): string {
    return availableAgents.value.find(agent => agent.id === 'agent_default')?.id || ''
  }

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
          ]),
          icon: getAgentIcon(agent),
          modelId: selection.modelId,
          providerName: selection.providerName,
          modelOptions: selection.modelOptions,
          isStreaming: conversation ? streamingConversationIds.has(conversation.id) : false,
          pendingAuthCount: conversation ? getPendingAuthCount(conversation.id) : 0,
          unreadCount: conversation ? getUnreadCount(conversation.id) : 0,
          isActive: Boolean(conversation && currentConversationId.value === conversation.id)
        }
      })
  })

  const groupSidebarItems = computed<SidebarGroupItem[]>(() => {
    return availableAgentGroups.value.map((group) => {
      const conversation = getPinnedGroupConversation(conversations.value, group.id)
      const memberIds = roomMemberIds(group)

      return {
        id: group.id,
        conversationId: conversation?.id || null,
        title: group.name,
        subtitle: t('chatUi.groupSidebarSubtitle', { count: memberIds.length + (group.localWorkers?.length || 0) }),
        searchText: buildSidebarSearchText([
          group.name,
          ...memberIds.map(id => agentsById.value.get(id)?.name),
          ...(group.localWorkers || []).map(worker => worker.role),
          conversation?.title,
          conversation?.previewText,
        ]),
        icon: getGroupIcon(group),
        isStreaming: conversation ? streamingConversationIds.has(conversation.id) : false,
        pendingAuthCount: conversation ? getPendingAuthCount(conversation.id) : 0,
        unreadCount: conversation ? getUnreadCount(conversation.id) : 0,
        isActive: Boolean(conversation && currentConversationId.value === conversation.id)
      }
    })
  })

  function formatGoalSubtitle (goal: LongTermGoalDefinition): string {
    if (goal.status === 'paused') return t('chatUi.longTermGoalPaused')
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

  type ConversationPresentation = Pick<SidebarConversationItem, 'id' | 'title' | 'subtitle' | 'searchText' | 'icon' | 'isFork' | 'projectId' | 'updatedAt' | 'workspaceRootPath' | 'workspaceRootName'>
  const presentations = new WeakMap<ConversationSummary, ComputedRef<ConversationPresentation>>()

  function getConversationPresentation (conversation: ConversationSummary): ConversationPresentation {
    let presentation = presentations.get(conversation)
    if (!presentation) {
      presentation = computed(() => {
        const timestamp = formatConversationSubtitle(conversation.updatedAt, locale.value)
        return {
          id: conversation.id,
          title: conversation.title,
          subtitle: conversation.previewText ? `${timestamp} · ${conversation.previewText}` : timestamp,
          searchText: buildSidebarSearchText([conversation.title, conversation.previewText, timestamp]),
          icon: resolveConversationIcon(conversation, groupsById.value, agentsById.value),
          isFork: Boolean(conversation.forkedFromConversationId),
          projectId: conversation.projectId || conversation.targetProjectId || undefined,
          updatedAt: conversation.updatedAt,
          workspaceRootPath: conversation.workspaceRootPath,
          workspaceRootName: conversation.workspaceRootName
        }
      })
      presentations.set(conversation, presentation)
    }
    return presentation.value
  }

  // Membership does not depend on the selected chat/provider or unread badges.
  // In particular, don't derive it from agentSidebarItems (which does).
  const regularConversations = computed(() => {
    const defaultAgentId = getDefaultAgentId()
    return conversations.value.filter(conversation => {
      if (conversation.groupId && groupsById.value.has(conversation.groupId)) return false
      if (conversation.agentId && conversation.agentId !== defaultAgentId && agentsById.value.has(conversation.agentId)) return false
      return true
    })
  })

  let previousConversationRows = new Map<string, { presentation: ConversationPresentation; item: SidebarConversationItem }>()
  const conversationSidebarItems = computed<SidebarConversationItem[]>(() => {
    const activeId = currentConversationId.value
    const nextRows = new Map<string, { presentation: ConversationPresentation; item: SidebarConversationItem }>()
    const items = regularConversations.value.map(conversation => {
      const presentation = getConversationPresentation(conversation)
      const isActive = activeId === conversation.id
      const isStreaming = streamingConversationIds.has(conversation.id)
      const pendingAuthCount = getPendingAuthCount(conversation.id)
      const unreadCount = getUnreadCount(conversation.id)
      const previous = previousConversationRows.get(conversation.id)
      // Stable props let Vue skip every unaffected card. Switching chats only
      // changes two rows, not thousands of date labels and 6 KB search strings.
      const entry = previous && previous.presentation === presentation
        && previous.item.isActive === isActive && previous.item.isStreaming === isStreaming
        && previous.item.pendingAuthCount === pendingAuthCount && previous.item.unreadCount === unreadCount
        ? previous
        : { presentation, item: { ...presentation, isActive, isStreaming, pendingAuthCount, unreadCount } }
      nextRows.set(conversation.id, entry)
      return entry.item
    })
    previousConversationRows = nextRows
    return items
  })

  const currentContextLabel = computed(() => {
    if (currentLongTermGoal.value) return `◎ ${currentLongTermGoal.value.title}`
    if (currentGroupDefinition.value) return `${getGroupIcon(currentGroupDefinition.value)} ${currentGroupDefinition.value.name}`
    if (currentAgentDefinition.value) return `${getAgentIcon(currentAgentDefinition.value)} ${currentAgentDefinition.value.name}`
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
    return 'WorldBase AI'
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
    return labelParts.length > 0 ? labelParts.join(' · ') : 'WorldBase AI'
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
      const group = currentGroupDefinition.value
      return t('chatUi.groupContextDetail', { count: roomMemberIds(group).length + (group.localWorkers?.length || 0) })
    }
    return currentModelLabel.value
  })

  const groupMentionHints = computed<GroupMentionHint[]>(() => {
    const group = currentGroupDefinition.value
    if (!group) return []

    const hints: GroupMentionHint[] = [{
      token: '@all',
      label: t('chatUi.groupAllDiscussionLabel'),
      aliases: ROOM_ALL_MENTIONS
    }]

    const seenTokens = new Set(hints.map(item => item.token))
    for (const memberId of roomMemberIds(group)) {
      const agent = agentsById.value.get(memberId)
      const token = `@${agent?.name || memberId}`
      if (seenTokens.has(token)) continue
      seenTokens.add(token)
      hints.push({
        token,
        agentId: memberId,
        label: agent?.name || memberId,
        aliases: [memberId, ...(memberId === group.coordinatorAgentId ? ROOM_DEFAULT_MENTIONS : [])]
      })
    }
    for (const worker of group.localWorkers || []) {
      const name = roomLocalWorkerName(worker)
      hints.push({ token: `@${name}`, agentId: worker.id, label: name, aliases: [worker.role, worker.kind, worker.id] })
    }
    return hints
  })

  function resolveAssistantSpeaker (sourceText: string): { speakerName: string; speakerIcon?: string } {
    const group = currentGroupDefinition.value
    if (group) {
      const workers = (group.localWorkers || []).map(worker => ({ id: worker.id, name: roomLocalWorkerName(worker), icon: '⌘' }))
      const members = [...roomMemberIds(group).flatMap(id => agentsById.value.get(id) || []), ...workers]
      const address = resolveRoomAddress(sourceText, members, group.coordinatorAgentId)
      const agent = address.agentIds.length === 1 ? members.find(member => member.id === address.agentIds[0]) : undefined
      return {
        speakerName: agent?.name || group.name,
        speakerIcon: agent ? getAgentIcon(agent) : getGroupIcon(group)
      }
    }
    return { speakerName: currentAgentDefinition.value?.name || 'WorldBase AI' }
  }

  return {
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
    resolveAssistantSpeaker,
    shouldUseConversationProviderOverride
  }
}
