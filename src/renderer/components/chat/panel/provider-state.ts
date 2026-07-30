import { computed, nextTick, type ComputedRef, type Ref } from 'vue'
import { getEnabledProviders } from './provider-utils'
import type {
  AIExecutionAuthMode,
  ChatMessage,
  ConversationSummary,
  ProviderOption,
  ProvidersConfig,
  ReasoningStrength
} from './types'

interface ChatProviderStateOptions {
  conversations: Ref<ConversationSummary[]>
  currentConversationId: Ref<string | null>
  messages: Ref<ChatMessage[]>
  targetProjectId: Ref<string | null>
  providers: Ref<ProviderOption[]>
  providersConfig: Ref<ProvidersConfig>
  activeProviderId: Ref<string>
  selectedModel: Ref<string>
  reasoningStrength: Ref<ReasoningStrength>
  conversationTemperature: Ref<number | null>
  currentAuthMode: Ref<AIExecutionAuthMode>
  selectedAgentId: Ref<string>
  selectedGroupId: Ref<string>
  selectedChannelBindingId: Ref<string>
  syncingProviderOptions: Ref<boolean>
  planModeActive: Ref<boolean>
  activeStreamSessionIds: Map<string, string>
  agentsById: ComputedRef<Map<string, AgentDefinition>>
  providersById: ComputedRef<Map<string, ProviderOption>>
  getDefaultAgentId: () => string
  saveConversation: (conversationId: string, messages: ChatMessage[], options?: { targetProjectId?: string | null; allowEmpty?: boolean }) => Promise<void>
}

export function createChatProviderState (options: ChatProviderStateOptions) {
  const {
    conversations,
    currentConversationId,
    messages,
    targetProjectId,
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
    saveConversation
  } = options

  async function saveActiveConversationMeta (): Promise<void> {
    if (!currentConversationId.value) return
    await saveConversation(currentConversationId.value, messages.value, {
      targetProjectId: targetProjectId.value,
      allowEmpty: true
    })
  }

  async function applyProvidersConfig (
    config: ProvidersConfig,
    preferredProviderId?: string | null,
    preferredModelId?: string | null
  ): Promise<void> {
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
    selectedModel.value = preferredModelId && active?.models.includes(preferredModelId)
      ? preferredModelId
      : active?.activeModel || active?.models[0] || ''

    await nextTick()
    syncingProviderOptions.value = false
  }

  async function loadProviders (preferredProviderId?: string | null, preferredModelId?: string | null): Promise<void> {
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
    } catch {
      /* ignore */
    }
  }

  function syncProviderSelectionForAgent (agentId: string): void {
    const defaultAgentId = getDefaultAgentId()
    if (!agentId || agentId === defaultAgentId) return

    const agent = agentsById.value.get(agentId)
    const provider = agent?.providerId ? providersById.value.get(agent.providerId) || null : null
    if (!agent || !provider) return

    const providerFallbackModel = provider.activeModel || provider.models[0] || ''
    activeProviderId.value = provider.id
    selectedModel.value = provider.models.includes(agent.modelId || '')
      ? agent.modelId || ''
      : providerFallbackModel
  }

  async function handleProviderSelectionChange (providerId: string): Promise<void> {
    activeProviderId.value = providerId
    const provider = providers.value.find(item => item.id === providerId)
    selectedModel.value = provider?.activeModel || provider?.models[0] || ''
    if (!syncingProviderOptions.value) await saveActiveConversationMeta()
  }

  async function handleModelSelectionChange (model: string): Promise<void> {
    selectedModel.value = model
    if (!syncingProviderOptions.value) await saveActiveConversationMeta()
  }

  async function handleReasoningStrengthChange (value: ReasoningStrength): Promise<void> {
    reasoningStrength.value = value
    if (!syncingProviderOptions.value) await saveActiveConversationMeta()
  }

  const providerDefaultTemperature = computed<number>(() => {
    const config = providersConfig.value
    const id = activeProviderId.value || config.activeProviderId
    const value = config.providers.find(item => item.id === id)?.temperature
    return typeof value === 'number' && Number.isFinite(value) ? value : 0.3
  })

  async function handleTemperatureChange (value: number | null): Promise<void> {
    conversationTemperature.value = value === null || !Number.isFinite(value)
      ? null
      : Math.min(Math.max(value, 0), 2)
    if (!syncingProviderOptions.value) await saveActiveConversationMeta()
  }

  async function handleAuthModeChange (authMode: AIExecutionAuthMode): Promise<void> {
    currentAuthMode.value = authMode
    const activeConversationId = currentConversationId.value
    const activeSessionId = activeConversationId ? activeStreamSessionIds.get(activeConversationId) : null
    if (activeSessionId && window.electronAPI?.updateChatSessionAuthMode) {
      try {
        await window.electronAPI.updateChatSessionAuthMode(activeSessionId, authMode)
      } catch {
        /* ignore */
      }
    }
    await saveActiveConversationMeta()
  }

  async function handleAgentSelectionChange (agentId: string): Promise<void> {
    selectedAgentId.value = agentId
    syncProviderSelectionForAgent(agentId)
    await saveActiveConversationMeta()
  }

  async function handleGroupSelectionChange (groupId: string): Promise<void> {
    selectedGroupId.value = groupId
    await saveActiveConversationMeta()
  }

  async function handleChannelBindingSelectionChange (channelBindingId: string): Promise<void> {
    selectedChannelBindingId.value = channelBindingId
    await saveActiveConversationMeta()
  }

  async function togglePlanMode (): Promise<void> {
    planModeActive.value = !planModeActive.value
    if (!window.electronAPI?.setPlanMode) return
    try {
      await window.electronAPI.setPlanMode(planModeActive.value)
    } catch {
      /* ignore */
    }
  }

  return {
    applyProvidersConfig,
    handleAgentSelectionChange,
    handleAuthModeChange,
    handleChannelBindingSelectionChange,
    handleGroupSelectionChange,
    handleModelSelectionChange,
    handleProviderSelectionChange,
    handleReasoningStrengthChange,
    handleTemperatureChange,
    loadProviders,
    providerDefaultTemperature,
    syncProviderSelectionForAgent,
    togglePlanMode
  }
}
