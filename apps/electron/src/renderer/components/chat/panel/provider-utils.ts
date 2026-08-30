import type {
  AgentDefinition,
  AgentGroupDefinition,
  ConversationSummary,
  ProviderOption,
  ProvidersConfig
} from './types'

export function getEnabledProviders (config: ProvidersConfig): ProviderOption[] {
  const enabledIds = new Set(
    (config.enabledProviderIds.length > 0 ? config.enabledProviderIds : [config.activeProviderId])
      .filter(Boolean)
  )
  const enabledProviders = config.providers.filter(provider => enabledIds.has(provider.id))
  return enabledProviders.length > 0 ? enabledProviders : config.providers
}

export function getAgentIcon (agent?: Pick<AgentDefinition, 'icon'> | null): string {
  return agent?.icon?.trim() || '🤖'
}

export function getGroupIcon (group?: Pick<AgentGroupDefinition, 'icon'> | null): string {
  return group?.icon?.trim() || '👥'
}

export function getAgentModelSelection (
  agent: AgentDefinition | null | undefined,
  providersById: Map<string, ProviderOption>,
  activeProviderId: string,
  fallbackProviderName = ''
): {
  providerName: string
  modelId: string
  modelOptions: string[]
} {
  const provider = agent?.providerId
    ? providersById.get(agent.providerId) || null
    : (activeProviderId ? providersById.get(activeProviderId) || null : null)
  const modelOptions = provider?.models || []
  const modelId = agent?.modelId || provider?.activeModel || modelOptions[0] || ''

  return {
    providerName: provider?.name || fallbackProviderName,
    modelId,
    modelOptions
  }
}

export function resolveConversationIcon (
  conversation: ConversationSummary,
  groupsById: Map<string, AgentGroupDefinition>,
  agentsById: Map<string, AgentDefinition>
): string {
  if (conversation.groupId) {
    return getGroupIcon(groupsById.get(conversation.groupId) || null)
  }

  if (conversation.agentId) {
    return getAgentIcon(agentsById.get(conversation.agentId) || null)
  }

  return '💬'
}

export function formatConversationSubtitle (updatedAt: string, locale: string): string {
  try {
    return new Date(updatedAt).toLocaleString(locale, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return updatedAt
  }
}

export function getPinnedAgentConversation (
  conversations: ConversationSummary[],
  agentId: string
): ConversationSummary | null {
  return conversations.find(conversation => {
    return conversation.agentId === agentId && !conversation.groupId && !conversation.channelBindingId
  }) || null
}

export function getPinnedGroupConversation (
  conversations: ConversationSummary[],
  groupId: string
): ConversationSummary | null {
  return conversations.find(conversation => conversation.groupId === groupId) || null
}
