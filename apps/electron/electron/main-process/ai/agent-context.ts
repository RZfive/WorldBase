import type { AIExecutionPreferences, AIProvidersConfig } from '../../../src/main/settings/settings-store.js'
import type { MessageContent } from '../../../src/main/ai-engine/providers/openai-provider.js'
import type { AgentDefinition, AgentGroupDefinition, AgentMemoryScope, ChannelBinding } from '../../../src/shared/agent-workspace-types.js'
import { t } from '../../../src/main/i18n/main-i18n.js'
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
    reasoningEffort: 'medium' as const,
    temperature: active?.temperature,
    contextWindow: active?.activeModel ? active.modelContextWindows?.[active.activeModel] : undefined
  }
  mainState.aiEngine!.configure(config)
  mainState.rustHarnessEngine?.configure(config)

  return normalizedConfig
}

export function resolveProviderConfig (requestedProviderId?: string, requestedModelId?: string, reasoningEffort: 'low' | 'medium' | 'high' | 'max' = 'medium', requestedTemperature?: number) {
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
    reasoningEffort,
    temperature: requestedTemperature ?? provider.temperature,
    contextWindow: provider.modelContextWindows?.[resolvedModel]
  }
}

export function resolveAgentRuntimeContext (input: {
  messages: Array<{ role: string; content: MessageContent }>
  agentId?: string
  groupId?: string
  channelBindingId?: string
  requestedProviderId?: string
  requestedModelId?: string
  requestedTargetProjectId?: string
  requestedReasoningStrength?: 'low' | 'medium' | 'high' | 'max'
  requestedTemperature?: number
  userId?: string
}): ResolvedAgentRuntimeContext {
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
  const useRustMemory = mainState.settingsStore?.getAIExecutionPreferences().harnessBackend === 'rust'
  const memoryContext = !useRustMemory
    ? mainState.memoryEngine?.buildPromptContext({
        agent,
        group,
        channelBinding,
        userMessage: getLastUserMessageText(input.messages),
        targetProjectId: effectiveTargetProjectId,
        userId: 'local-user',
        enabledScopeTypes: memoryScopeTypes
      })
    : undefined
  const systemPromptSections = [
    agent ? buildActiveAgentSection(agent) : null,
    group ? buildActiveGroupSection(group) : null,
    channelBinding ? buildActiveChannelSection(channelBinding) : null,
    ...(memoryContext?.sections || [])
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
    memoryScopes
  }
}
