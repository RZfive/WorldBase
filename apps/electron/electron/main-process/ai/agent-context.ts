import type { AIExecutionPreferences, AIProvidersConfig, AIProvider } from '../../../src/main/settings/settings-store.js'
import type { MessageContent } from '../../../src/main/ai-engine/providers/openai-provider.js'
import type { AgentDefinition, AgentGroupDefinition, AgentMemoryScope, ChannelBinding, MemoryEmbeddingRuntimeConfig } from '../../../src/shared/agent-workspace-types.js'
import { t } from '../../../src/main/i18n/main-i18n.js'
import { clampReasoningEffort, fetchProviderCatalog, type ProviderModelMetadata } from '../../../src/main/settings/provider-model-service.js'
import { mainState } from '../state.js'
import { broadcastToAppWindows } from '../windows.js'
import { focusMainWindow, isNotificationSupported, showAppNotification } from '../../../src/main/notifications.js'
import { getLastUserMessageText, getTaskLabelFromMessages } from '../chat-message-utils.js'

export interface ResolvedAgentRuntimeContext {
  agent: AgentDefinition | null
  group: AgentGroupDefinition | null
  channelBinding: ChannelBinding | null
  effectiveTargetProjectId: string | null
  providerConfig: ReturnType<typeof resolveProviderConfig>
  activeSkillContents: string[]
  systemPromptSections: string[]
  allowedToolNames: string[]
  deniedToolNames: string[]
  memoryScopeTypes: AgentMemoryScope[] | undefined
  memoryScopes: Array<{ scopeType: AgentMemoryScope; scopeId: string }>
  memoryEmbedding?: MemoryEmbeddingRuntimeConfig
}

export function notifyAgentWorkspaceChanged (event: { entity: 'agent' | 'group' | 'binding'; action: string; id?: string }): void {
  broadcastToAppWindows('agentWorkspace:changed', event)
}

export function mergeUniqueStrings (...collections: Array<string[] | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const collection of collections) {
    if (!collection) continue
    for (const item of collection) {
      const normalized = item.trim()
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      result.push(normalized)
    }
  }

  return result
}

export function resolveAgentMemoryScopes (
  agent?: AgentDefinition | null,
  group?: AgentGroupDefinition | null
): AgentMemoryScope[] | undefined {
  if (!agent && !group) return undefined
  return mergeUniqueStrings(agent?.memoryScopes, group?.sharedMemoryScopes) as AgentMemoryScope[]
}

function resolveRustMemoryScopes (input: {
  agent?: AgentDefinition | null
  group?: AgentGroupDefinition | null
  channelBinding?: ChannelBinding | null
  targetProjectId?: string | null
  enabledScopeTypes?: AgentMemoryScope[]
  userId?: string | null
}): Array<{ scopeType: AgentMemoryScope; scopeId: string }> {
  const enabled = new Set(input.enabledScopeTypes || ['user', 'agent', 'project', 'group', 'channel'])
  const scopes: Array<{ scopeType: AgentMemoryScope; scopeId: string }> = []
  if (enabled.has('user')) scopes.push({ scopeType: 'user', scopeId: input.userId?.trim() || 'local-user' })
  if (input.agent && enabled.has('agent')) scopes.push({ scopeType: 'agent', scopeId: input.agent.id })
  if (input.group && enabled.has('group')) scopes.push({ scopeType: 'group', scopeId: input.group.id })
  if (input.channelBinding && enabled.has('channel')) scopes.push({ scopeType: 'channel', scopeId: input.channelBinding.id })
  if (input.targetProjectId && enabled.has('project')) scopes.push({ scopeType: 'project', scopeId: input.targetProjectId })
  return scopes
}

/**
 * Resolve the current Memory Settings selection into the per-request
 * embedding runtime config handed to the Rust harness. Returns null when no
 * usable provider/model is configured — the harness then does keyword-only
 * recall and never touches the embedding API (design §7.3).
 */
export function resolveMemoryEmbeddingRuntimeConfig (): MemoryEmbeddingRuntimeConfig | undefined {
  const settings = mainState.settingsStore?.getMemoryEmbeddingSettings()
  if (!settings?.enabled) return undefined
  const providerId = settings.providerId?.trim()
  const modelId = settings.modelId?.trim()
  if (!providerId || !modelId) return undefined
  const provider = mainState.settingsStore?.getProviders().providers.find(item => item.id === providerId)
  const model = (provider?.embeddingModels || []).find(item => item.id === modelId && item.enabled !== false)
  if (!provider?.baseUrl?.trim() || !model) return undefined
  return {
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    modelId: model.id,
    ...(model?.dimensions ? { dimensions: model.dimensions } : {}),
    ...(model?.distance ? { distance: model.distance } : {}),
    ...(model?.normalized != null ? { normalized: model.normalized } : {}),
    ...(model?.queryPrefix !== undefined ? { queryPrefix: model.queryPrefix } : {}),
    ...(model?.documentPrefix !== undefined ? { documentPrefix: model.documentPrefix } : {})
  }
}

export function resolveSkillContentsByIds (skillIds?: string[]): string[] {
  if (!mainState.skillStore || !skillIds || skillIds.length === 0) return []

  const contents: string[] = []
  for (const skillId of skillIds) {
    const skill = mainState.skillStore.get(skillId)
    if (skill?.content?.trim()) {
      contents.push(skill.content)
    }
  }

  return mergeUniqueStrings(contents)
}

export function buildActiveAgentSection (agent: AgentDefinition): string {
  const lines = [
    '## Active custom agent',
    `- Agent: ${agent.name}`,
    `- Description: ${agent.description || 'N/A'}`,
    `- Reasoning strength: ${agent.reasoningStrength || 'medium'}`,
    `- Memory scopes: ${(agent.memoryScopes || []).join(', ') || 'user, agent, project'}`
  ]

  if (agent.allowedTools && agent.allowedTools.length > 0) {
    lines.push(`- Allowed tools: ${agent.allowedTools.join(', ')}`)
  }

  if (agent.deniedTools && agent.deniedTools.length > 0) {
    lines.push(`- Denied tools: ${agent.deniedTools.join(', ')}`)
  }

  if (agent.systemPrompt.trim()) {
    lines.push('', '### Agent instructions', agent.systemPrompt.trim())
  }

  return lines.join('\n')
}

export function buildActiveGroupSection (group: AgentGroupDefinition): string {
  const coordinatorName = mainState.agentStore?.get(group.coordinatorAgentId)?.name || group.coordinatorAgentId || 'N/A'
  const memberNames = group.memberAgentIds.map(agentId => mainState.agentStore?.get(agentId)?.name || agentId)

  return [
    '## Active agent group',
    `- Group: ${group.name}`,
    `- Description: ${group.description || 'N/A'}`,
    `- Coordinator: ${coordinatorName}`,
    `- Members: ${memberNames.join(', ') || 'N/A'}`,
    `- Max rounds: ${group.maxRounds}`,
    `- Max parallel workers: ${group.maxParallelWorkers}`,
    `- Shared memory scopes: ${group.sharedMemoryScopes.join(', ') || 'group'}`,
    `- Transcript visibility: ${group.visibility}`
  ].join('\n')
}

export function buildActiveChannelSection (binding: ChannelBinding): string {
  const connector = mainState.channelBindingStore?.listConnectors().find(item => item.id === binding.connectorType)

  return [
    '## Active channel binding',
    `- Connector: ${connector?.name || binding.connectorType}`,
    `- External channel ID: ${binding.externalChannelId}`,
    `- External thread ID: ${binding.externalThreadId || 'N/A'}`,
    `- Bound group ID: ${binding.boundGroupId || 'N/A'}`,
    `- Default agent ID: ${binding.defaultAgentId || 'N/A'}`,
    `- Target project ID: ${binding.targetProjectId || 'N/A'}`,
    `- Auto reply: ${binding.autoReply ? 'enabled' : 'disabled'}`,
    `- Risky tools require approval: ${binding.requireApprovalForRiskyTools ? 'yes' : 'no'}`
  ].join('\n')
}

export function notifyAiTaskStatus (
  preferences: AIExecutionPreferences,
  messages: Array<{ role: string; content: MessageContent }>,
  status: 'completed' | 'failed' | 'stopped',
  detail?: string
): void {
  if (!preferences.notifyOnTaskComplete || !isNotificationSupported()) return

  const taskLabel = getTaskLabelFromMessages(messages)
  let title = t('mainDialog.aiTaskCompletedTitle')
  let statusLabel = t('mainDialog.aiTaskStatusCompleted')
  if (status === 'failed') {
    title = t('mainDialog.aiTaskFailedTitle')
    statusLabel = t('mainDialog.aiTaskStatusFailed')
  } else if (status === 'stopped') {
    title = t('mainDialog.aiTaskStoppedTitle')
    statusLabel = t('mainDialog.aiTaskStatusStopped')
  }
  const body = detail
    ? t('mainDialog.aiTaskNotificationBodyWithDetail', { task: taskLabel, status: statusLabel, detail })
    : t('mainDialog.aiTaskNotificationBody', { task: taskLabel, status: statusLabel })

  showAppNotification(title, body, () => {
    focusMainWindow(mainState.mainWindow)
  })
}

export function applyActiveProviderToAiEngine (): AIProvidersConfig {
  const normalizedConfig = mainState.settingsStore!.getProviders()
  const active = normalizedConfig.providers.find(provider => provider.id === normalizedConfig.activeProviderId)

  const config = {
    apiKey: active?.apiKey ?? '',
    baseUrl: active?.baseUrl ?? '',
    model: active?.activeModel ?? '',
    // Auto entries carry their probe result; never guess from the base URL.
    apiProtocol: active?.apiProtocol || active?.detectedApiProtocol || undefined,
    imageGeneration: active?.activeModel ? active.modelCapabilities?.[active.activeModel]?.imageGeneration === true : false,
    imageEditing: active?.activeModel ? active.modelCapabilities?.[active.activeModel]?.imageEditing === true : false,
    enableThinking: active?.enableThinking ?? false,
    reasoningEffort: active?.modelCapabilities?.[active.activeModel]?.reasoningEffort ?? 'medium',
    temperature: active?.temperature,
    contextWindow: active?.activeModel ? active.modelContextWindows?.[active.activeModel] : undefined
  }
  // Rust is the only execution backend.
  mainState.rustHarnessEngine?.configure(config)

  return normalizedConfig
}

/**
 * Backfill each provider's per-model metadata from its /models catalog —
 * reasoning-effort levels (zhipu declares glm-5.3 only accepts low/high/max)
 * and the context window. Best effort: catalog failures leave existing
 * capabilities untouched. Runs after a providers save so the effort clamp in
 * resolveProviderConfig always has declared data to work with.
 */
export async function refreshProviderReasoningMetadata (): Promise<void> {
  const providersConfig = mainState.settingsStore!.getProviders()
  let changed = false
  for (const provider of providersConfig.providers) {
    if (!provider.apiKey || !provider.baseUrl || provider.models.length === 0) continue
    // Anthropic-style catalogs carry no model metadata.
    if ((provider.apiProtocol || provider.detectedApiProtocol) === 'anthropic') continue
    let modelMetadata: Record<string, ProviderModelMetadata>
    try {
      ;({ modelMetadata } = await fetchProviderCatalog({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        apiProtocol: provider.apiProtocol || provider.detectedApiProtocol || ''
      }))
    } catch {
      continue
    }
    for (const [model, metadata] of Object.entries(modelMetadata)) {
      if (!provider.models.includes(model)) continue
      if (providerModelMetadataMatches(provider, model, metadata)) continue
      if (metadata.supportedReasoningEfforts.length > 0) {
        if (!provider.modelCapabilities) provider.modelCapabilities = {}
        const caps = provider.modelCapabilities[model] || (provider.modelCapabilities[model] = {})
        caps.reasoningEfforts = metadata.supportedReasoningEfforts
        if (metadata.defaultReasoningEffort) caps.defaultReasoningEffort = metadata.defaultReasoningEffort
        // cc-switch behaviour: a model without a user-chosen strength starts
        // on the gateway's declared default level.
        if (!caps.reasoningEffort && metadata.defaultReasoningEffort &&
          metadata.supportedReasoningEfforts.includes(metadata.defaultReasoningEffort)) {
          caps.reasoningEffort = metadata.defaultReasoningEffort as NonNullable<AIProvider['modelCapabilities']>[string]['reasoningEffort']
        }
      }
      if (metadata.contextWindow !== undefined) {
        if (!provider.modelContextWindows) provider.modelContextWindows = {}
        provider.modelContextWindows[model] = metadata.contextWindow
      }
      changed = true
    }
  }
  if (!changed) return
  mainState.settingsStore!.saveProviders(providersConfig)
  applyActiveProviderToAiEngine()
  if (mainState.rustHarness?.isAvailable()) {
    try {
      await mainState.rustHarness.syncProviders()
    } catch (error) {
      console.warn('[reasoning-metadata] Rust harness sync deferred:', error)
    }
  }
  broadcastToAppWindows('settings:providersChanged', providersConfig)
}

function providerModelMetadataMatches (
  provider: AIProvider,
  model: string,
  metadata: ProviderModelMetadata
): boolean {
  const caps = provider.modelCapabilities?.[model]
  if (metadata.supportedReasoningEfforts.length > 0) {
    const current = caps?.reasoningEfforts || []
    if (current.length !== metadata.supportedReasoningEfforts.length ||
      !current.every((effort, index) => effort === metadata.supportedReasoningEfforts[index])) return false
    if (metadata.defaultReasoningEffort !== undefined &&
      (caps?.defaultReasoningEffort || undefined) !== metadata.defaultReasoningEffort) return false
  }
  if (metadata.contextWindow !== undefined && provider.modelContextWindows?.[model] !== metadata.contextWindow) {
    return false
  }
  return true
}

/**
 * Clamp domain for a model's reasoning effort: the user's multi-picked allowed
 * levels (settings UI) intersected with the gateway-declared set; absent picks
 * fall back to the declared set. An empty intersection falls back to declared
 * so requests never leave what the gateway accepts.
 */
function effortClampDomain (caps?: { reasoningEfforts?: string[]; allowedReasoningEfforts?: string[] }): string[] | undefined {
  const declared = caps?.reasoningEfforts
  const allowed = caps?.allowedReasoningEfforts
  if (!allowed?.length) return declared
  if (!declared?.length) return allowed
  const intersected = allowed.filter(level => declared.includes(level))
  return intersected.length > 0 ? intersected : declared
}

export function resolveProviderConfig (requestedProviderId?: string, requestedModelId?: string, reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra', requestedTemperature?: number) {
  const providersConfig = mainState.settingsStore!.getProviders()
  const enabledProviderIds = new Set(providersConfig.enabledProviderIds)
  const enabledProviders = providersConfig.providers.filter(provider => enabledProviderIds.has(provider.id))
  const requestedProvider = requestedProviderId
    ? providersConfig.providers.find(provider => provider.id === requestedProviderId)
    : null
  const defaultProvider = enabledProviders.find(provider => provider.id === providersConfig.activeProviderId)
    || enabledProviders[0]
    || providersConfig.providers.find(provider => provider.id === providersConfig.activeProviderId)
    || providersConfig.providers[0]

  const provider = requestedProvider || defaultProvider
  if (!provider) return undefined

  const resolvedModel = requestedModelId && provider.models.includes(requestedModelId)
    ? requestedModelId
    : provider.activeModel
  // Callers without an explicit session/agent strength fall back to the
  // model's own configured default, then the system default.
  const effectiveReasoningEffort = reasoningEffort ??
    provider.modelCapabilities?.[resolvedModel]?.reasoningEffort ?? 'medium'

  return {
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    model: resolvedModel,
    // Auto entries carry their probe result; never guess from the base URL.
    apiProtocol: provider.apiProtocol || provider.detectedApiProtocol || undefined,
    providerId: provider.id,
    providerName: provider.name,
    imageGeneration: provider.modelCapabilities?.[resolvedModel]?.imageGeneration === true,
    imageEditing: provider.modelCapabilities?.[resolvedModel]?.imageEditing === true,
    enableThinking: provider.enableThinking ?? false,
    reasoningEffort: clampReasoningEffort(
      effectiveReasoningEffort,
      effortClampDomain(provider.modelCapabilities?.[resolvedModel])
    ) as NonNullable<typeof reasoningEffort>,
    temperature: requestedTemperature ?? provider.temperature,
    contextWindow: provider.modelContextWindows?.[resolvedModel]
  }
}

export async function resolveAgentRuntimeContext (input: {
  messages: Array<{ role: string; content: MessageContent }>
  agentId?: string
  groupId?: string
  channelBindingId?: string
  requestedProviderId?: string
  requestedModelId?: string
  requestedTargetProjectId?: string
  requestedReasoningStrength?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
  requestedTemperature?: number
  userId?: string
}): Promise<ResolvedAgentRuntimeContext> {
  const group = input.groupId ? mainState.agentGroupStore?.get(input.groupId) || null : null
  const channelBinding = input.channelBindingId ? mainState.channelBindingStore?.get(input.channelBindingId) || null : null
  const explicitAgent = input.agentId ? mainState.agentStore?.get(input.agentId) || null : null
  const fallbackAgentId = channelBinding?.defaultAgentId || group?.coordinatorAgentId
  const agent = explicitAgent || (fallbackAgentId ? mainState.agentStore?.get(fallbackAgentId) || null : null)
  const effectiveTargetProjectId = input.requestedTargetProjectId ?? channelBinding?.targetProjectId ?? null
  const effectiveReasoningStrength = input.requestedReasoningStrength || agent?.reasoningStrength || 'medium'
  const providerConfig = resolveProviderConfig(
    input.requestedProviderId || agent?.providerId,
    input.requestedModelId || agent?.modelId,
    effectiveReasoningStrength,
    input.requestedTemperature
  )
  const memoryScopeTypes = resolveAgentMemoryScopes(agent, group)
  const memoryScopes = resolveRustMemoryScopes({
    agent,
    group,
    channelBinding,
    targetProjectId: effectiveTargetProjectId,
    enabledScopeTypes: memoryScopeTypes,
    userId: input.userId
  })
  // Memory is owned by the Rust harness (single source): recall happens
  // Rust-side from the shared agent-memory databases. The host supplies the
  // resolved scopes, the current query, and the per-request embedding config
  // resolved from Memory Settings (design §12/§17).
  const memoryEmbedding = resolveMemoryEmbeddingRuntimeConfig()
  const systemPromptSections = [
    agent ? buildActiveAgentSection(agent) : null,
    group ? buildActiveGroupSection(group) : null,
    channelBinding ? buildActiveChannelSection(channelBinding) : null
  ].filter((value): value is string => Boolean(value))

  return {
    agent,
    group,
    channelBinding,
    effectiveTargetProjectId,
    providerConfig,
    activeSkillContents: resolveSkillContentsByIds(agent?.skillIds),
    systemPromptSections,
    allowedToolNames: agent?.allowedTools || [],
    deniedToolNames: agent?.deniedTools || [],
    memoryScopeTypes,
    memoryScopes,
    memoryEmbedding
  }
}
