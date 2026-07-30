import { computed, type Ref } from 'vue'
import type { ComposerTranslation } from 'vue-i18n'
import type { LongTermGoalDefinition } from '../../../../shared/long-term-goal-types.js'
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
      if (normalizeMentionToken(candidate.slice(0, endOffset)) === token) return token
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
    const resolved = resolveKnownMentionMatch(value.slice(index + 1, candidateEnd), normalizedKnownMentions)
    if (!resolved) continue

    matches.push(resolved)
    index = Math.max(index, candidateEnd - 1)
  }
  return matches
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
            conversation?.searchText
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

  const conversationSidebarItems = computed<SidebarConversationItem[]>(() => {
    const defaultAgentId = getDefaultAgentId()
    const pinnedConversationIds = new Set<string>([
      ...agentSidebarItems.value.map(item => item.conversationId).filter((value): value is string => Boolean(value)),
      ...groupSidebarItems.value.map(item => item.conversationId).filter((value): value is string => Boolean(value))
    ])

    return conversations.value
      .filter((conversation) => {
        if (pinnedConversationIds.has(conversation.id)) return false
        if (conversation.groupId && groupsById.value.has(conversation.groupId)) return false
        if (conversation.agentId && conversation.agentId !== defaultAgentId && agentsById.value.has(conversation.agentId)) return false
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
        isStreaming: streamingConversationIds.has(conversation.id),
        pendingAuthCount: getPendingAuthCount(conversation.id),
        unreadCount: getUnreadCount(conversation.id),
        isActive: currentConversationId.value === conversation.id
      }))
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
      return t('chatUi.groupContextDetail', { count: currentGroupDefinition.value.memberAgentIds.length })
    }
    return currentModelLabel.value
  })

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
      const knownMentionValues = groupMentionHints.value.flatMap(hint => [hint.token, hint.label, ...(hint.aliases || [])])
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

      if (!fullGroupRequested && matchedLabels.length === 1) return matchedLabels[0]

      const coordinatorName = currentGroupDefinition.value.coordinatorAgentId
        ? agentsById.value.get(currentGroupDefinition.value.coordinatorAgentId)?.name || ''
        : ''
      return coordinatorName || currentGroupDefinition.value.name
    }
    if (currentAgentDefinition.value) return currentAgentDefinition.value.name
    return 'WorldBase AI'
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
    resolveAssistantSpeakerName,
    shouldUseConversationProviderOverride
  }
}
