import { computed, nextTick, type ComputedRef, type Ref } from 'vue'
import { getEnabledProviders } from './provider-utils'
import type {
  AIExecutionAuthMode,
  ConversationSummary,
  ProviderOption,
  ProvidersConfig,
  ReasoningStrength
} from './types'

interface ChatProviderStateOptions {
  conversations: Ref<ConversationSummary[]>
  currentConversationId: Ref<string | null>
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
  saveConversationMetadata: (conversationId: string) => Promise<void>
}

export function createChatProviderState (options: ChatProviderStateOptions) {
  const {
    conversations,
    currentConversationId,
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
    saveConversationMetadata
  } = options

  let catalogVersion = 0

  async function saveActiveConversationMeta (): Promise<void> {
    if (!currentConversationId.value) return
    await saveConversationMetadata(currentConversationId.value)
  }

  async function applyProvidersConfig (
    config: ProvidersConfig,
    preferredProviderId?: string | null,
    preferredModelId?: string | null
  ): Promise<void> {
    catalogVersion++
    syncingProviderOptions.value = true
    providersConfig.value = {
      providers: config.providers.map(provider => ({ ...provider })),
      activeProviderId: config.activeProviderId,
      enabledProviderIds: [...config.enabledProviderIds]
    }
    providers.value = getEnabledProviders(providersConfig.value)

    selectConversationProvider(preferredProviderId, preferredModelId)

    await nextTick()
    syncingProviderOptions.value = false
  }

  function selectConversationProvider (preferredProviderId?: string | null, preferredModelId?: string | null): void {
    const candidateIds = [
      preferredProviderId,
      currentConversationId.value ? conversations.value.find(item => item.id === currentConversationId.value)?.providerId : null,
      activeProviderId.value,
      providersConfig.value.activeProviderId
    ]
    const nextProviderId = candidateIds.find(id => id && providers.value.some(provider => provider.id === id))
      || providers.value[0]?.id
      || ''

    activeProviderId.value = nextProviderId
    const active = providers.value.find(provider => provider.id === nextProviderId)
    selectedModel.value = preferredModelId && active?.models.includes(preferredModelId)
      ? preferredModelId
      : active?.activeModel || active?.models[0] || ''
  }

  async function loadProviders (preferredProviderId?: string | null, preferredModelId?: string | null): Promise<void> {
    if (!window.electronAPI) return
    const version = catalogVersion
    try {
      const config = await window.electronAPI.getProviders()
      if (version !== catalogVersion) return
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
    const savingMetadata = saveActiveConversationMeta()
    const activeConversationId = currentConversationId.value
    const activeSessionId = activeConversationId ? activeStreamSessionIds.get(activeConversationId) : null
    const updatingSession = activeSessionId && window.electronAPI?.updateChatSessionAuthMode
      ? window.electronAPI.updateChatSessionAuthMode(activeSessionId, authMode).catch(() => {})
      : Promise.resolve()
    // Attach both rejection handlers immediately; persistence must retain the
    // captured conversation even if navigation happens during the session RPC.
    await Promise.all([savingMetadata, updatingSession])
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
    selectConversationProvider,
    syncProviderSelectionForAgent,
    togglePlanMode
  }
}
