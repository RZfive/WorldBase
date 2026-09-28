import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import type { ToolServices } from './index.js'
import type { ToolDefinition as RuntimeToolDefinition } from '../../providers/openai-provider.js'
import type { AgentDefinition, AgentGroupDefinition } from '../../../../shared/agent-workspace-types.js'

interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

function normalizeString (value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeStringArray (value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
}

function getProviderCatalog (services: ToolServices): Array<{ id: string; name: string; activeModel: string; models: string[] }> {
  const config = services.settingsStore?.getProviders()
  return (config?.providers || []).map(provider => ({
    id: provider.id,
    name: provider.name,
    activeModel: provider.activeModel,
    models: [...provider.models]
  }))
}

function getSkillCatalog (services: ToolServices): Array<{ id: string; name: string; description: string }> {
  return (services.skillStore?.list() || []).map(skill => ({
    id: skill.id,
    name: skill.name,
    description: skill.description
  }))
}

function getToolCatalog (getToolDefinitions: () => RuntimeToolDefinition[]): Array<{ name: string; description: string }> {
  return getToolDefinitions()
    .map(tool => ({ name: tool.name, description: tool.description }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
}

function getKnownToolNames (getToolDefinitions: () => RuntimeToolDefinition[]): Set<string> {
  return new Set(getToolDefinitions().map(tool => tool.name))
}

function getKnownSkillIds (services: ToolServices): Set<string> {
  return new Set((services.skillStore?.list() || []).map(skill => skill.id))
}

function validateProviderAndModel (services: ToolServices, providerId: string, modelId: string): string | null {
  if (!providerId && !modelId) return null
  const providers = services.settingsStore?.getProviders().providers || []
  const provider = providers.find(item => item.id === providerId)
  if (!provider) {
    return `Unknown providerId: ${providerId}`
  }
  if (modelId && !provider.models.includes(modelId)) {
    return `Model ${modelId} is not registered under provider ${providerId}`
  }
  return null
}

function validateSkillIds (services: ToolServices, skillIds: string[]): string | null {
  const knownSkillIds = getKnownSkillIds(services)
  const invalidIds = skillIds.filter(skillId => !knownSkillIds.has(skillId))
  return invalidIds.length > 0 ? `Unknown skillIds: ${invalidIds.join(', ')}` : null
}

function validateToolNames (getToolDefinitions: () => RuntimeToolDefinition[], toolNames: string[]): string | null {
  const knownToolNames = getKnownToolNames(getToolDefinitions)
  const invalidNames = toolNames.filter(toolName => !knownToolNames.has(toolName))
  return invalidNames.length > 0 ? `Unknown tool names: ${invalidNames.join(', ')}` : null
}

function normalizeMemoryScopes (value: unknown): AgentDefinition['memoryScopes'] | undefined {
  const scopes = normalizeStringArray(value).filter((scope): scope is AgentDefinition['memoryScopes'][number] => {
    return scope === 'user' || scope === 'agent' || scope === 'project' || scope === 'group' || scope === 'channel'
  })
  return scopes.length > 0 ? scopes : undefined
}

function normalizeSharedMemoryScopes (value: unknown): AgentGroupDefinition['sharedMemoryScopes'] | undefined {
  const scopes = normalizeStringArray(value).filter((scope): scope is AgentGroupDefinition['sharedMemoryScopes'][number] => {
    return scope === 'group' || scope === 'project' || scope === 'channel'
  })
  return scopes.length > 0 ? scopes : undefined
}

export function toolListAgentWorkspaceCatalog (services: ToolServices, getToolDefinitions: () => RuntimeToolDefinition[]): Tool {
  return {
    definition: {
      name: 'list_agent_workspace_catalog',
      description: 'List available providers, models, skills, tool names, existing agents, and existing agent groups before creating or updating agent workspace entities.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    },
    handler: async () => {
      return {
        providers: getProviderCatalog(services),
        skills: getSkillCatalog(services),
        tools: getToolCatalog(getToolDefinitions),
        agents: services.agentStore?.list() || [],
        groups: services.agentGroupStore?.list() || []
      }
    }
  }
}

export function toolCreateAgent (services: ToolServices, getToolDefinitions: () => RuntimeToolDefinition[]): Tool {
  return {
    definition: {
      name: 'create_agent',
      description: 'Create or update a custom agent in the Agent Workspace. Use list_agent_workspace_catalog first to choose valid provider, model, skill IDs, and tool names.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Optional existing agent ID to update. Omit to create a new agent.' },
          name: { type: 'string', description: 'Agent display name.' },
          description: { type: 'string', description: 'Short description of the agent role.' },
          system_prompt: { type: 'string', description: 'System prompt for the agent.' },
          provider_id: { type: 'string', description: 'Existing provider ID from list_agent_workspace_catalog.' },
          model_id: { type: 'string', description: 'Existing model ID under the selected provider.' },
          reasoning_strength: { type: 'string', enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
          skill_ids: { type: 'array', items: { type: 'string' }, description: 'Existing skill IDs to bind.' },
          allowed_tools: { type: 'array', items: { type: 'string' }, description: 'Allowed tool names. Leave empty for no allow-list restriction.' },
          denied_tools: { type: 'array', items: { type: 'string' }, description: 'Denied tool names.' },
          memory_scopes: { type: 'array', items: { type: 'string', enum: ['user', 'agent', 'project', 'group', 'channel'] } },
          allow_user_traits: { type: 'boolean' },
          allow_agent_skills: { type: 'boolean' },
          allow_steps: { type: 'boolean' },
          allow_knowledge: { type: 'boolean' },
          auto_reply_enabled: { type: 'boolean' },
          auto_reply_require_mention: { type: 'boolean' }
        },
        required: ['name', 'system_prompt']
      }
    },
    handler: async (args, onProgress) => {
      if (!services.agentStore) {
        return { error: 'Agent storage is not available in this runtime.' }
      }

      const name = normalizeString(args.name)
      const systemPrompt = normalizeString(args.system_prompt)
      if (!name || !systemPrompt) {
        return { error: 'name and system_prompt are required.' }
      }

      const providerId = normalizeString(args.provider_id)
      const modelId = normalizeString(args.model_id)
      const skillIds = normalizeStringArray(args.skill_ids)
      const allowedTools = normalizeStringArray(args.allowed_tools)
      const deniedTools = normalizeStringArray(args.denied_tools)

      const providerError = validateProviderAndModel(services, providerId, modelId)
      if (providerError) return { error: providerError }

      const skillError = validateSkillIds(services, skillIds)
      if (skillError) return { error: skillError }

      const allowedToolsError = validateToolNames(getToolDefinitions, allowedTools)
      if (allowedToolsError) return { error: allowedToolsError }

      const deniedToolsError = validateToolNames(getToolDefinitions, deniedTools)
      if (deniedToolsError) return { error: deniedToolsError }

      onProgress?.('🧠 保存 Agent', name)
      const saved = services.agentStore.save({
        id: normalizeString(args.id) || undefined,
        name,
        description: normalizeString(args.description),
        systemPrompt,
        providerId: providerId || undefined,
        modelId: modelId || undefined,
        reasoningStrength: args.reasoning_strength === 'low' || args.reasoning_strength === 'medium' || args.reasoning_strength === 'high' || args.reasoning_strength === 'max'
          ? args.reasoning_strength
          : undefined,
        skillIds,
        allowedTools,
        deniedTools,
        memoryScopes: normalizeMemoryScopes(args.memory_scopes),
        memoryWritePolicy: {
          allowUserTraits: args.allow_user_traits !== false,
          allowAgentSkills: args.allow_agent_skills !== false,
          allowSteps: args.allow_steps !== false,
          allowKnowledge: args.allow_knowledge !== false
        },
        autoReplyPolicy: {
          enabled: args.auto_reply_enabled === true,
          requireMention: args.auto_reply_require_mention !== false
        }
      })
      services.notifyAgentWorkspaceChanged?.({ entity: 'agent', action: 'saved', id: saved.id })
      onProgress?.('✅ Agent 已保存', saved.name)

      return {
        success: true,
        agent: saved,
        message: `Agent ${saved.name} 已保存。`
      }
    }
  }
}

export function toolCreateAgentGroup (services: ToolServices): Tool {
  return {
    definition: {
      name: 'create_agent_group',
      description: 'Create or update an agent group in the Agent Workspace. Use list_agent_workspace_catalog first to pick valid coordinator and member agent IDs.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Optional existing group ID to update. Omit to create a new group.' },
          name: { type: 'string', description: 'Group display name.' },
          description: { type: 'string', description: 'Short description of the group objective.' },
          coordinator_agent_id: { type: 'string', description: 'Existing agent ID used as coordinator.' },
          member_agent_ids: { type: 'array', items: { type: 'string' }, description: 'Existing member agent IDs.' },
          max_rounds: { type: 'integer' },
          max_parallel_workers: { type: 'integer' },
          shared_memory_scopes: { type: 'array', items: { type: 'string', enum: ['group', 'project', 'channel'] } },
          visibility: { type: 'string', enum: ['summary_only', 'expandable_internal_transcript'] }
        },
        required: ['name', 'coordinator_agent_id', 'member_agent_ids']
      }
    },
    handler: async (args, onProgress) => {
      if (!services.agentGroupStore || !services.agentStore) {
        return { error: 'Agent group storage is not available in this runtime.' }
      }

      const name = normalizeString(args.name)
      const coordinatorAgentId = normalizeString(args.coordinator_agent_id)
      const memberAgentIds = normalizeStringArray(args.member_agent_ids)
      if (!name || !coordinatorAgentId || memberAgentIds.length === 0) {
        return { error: 'name, coordinator_agent_id, and member_agent_ids are required.' }
      }

      const knownAgentIds = new Set((services.agentStore.list() || []).map(agent => agent.id))
      if (!knownAgentIds.has(coordinatorAgentId)) {
        return { error: `Unknown coordinator_agent_id: ${coordinatorAgentId}` }
      }
      const invalidMemberIds = memberAgentIds.filter(agentId => !knownAgentIds.has(agentId))
      if (invalidMemberIds.length > 0) {
        return { error: `Unknown member_agent_ids: ${invalidMemberIds.join(', ')}` }
      }

      const normalizedMembers = Array.from(new Set([coordinatorAgentId, ...memberAgentIds]))
      onProgress?.('👥 保存 Agent 群组', name)
      const saved = services.agentGroupStore.save({
        id: normalizeString(args.id) || undefined,
        name,
        description: normalizeString(args.description) || undefined,
        coordinatorAgentId,
        memberAgentIds: normalizedMembers,
        maxRounds: Number.isFinite(Number(args.max_rounds)) ? Number(args.max_rounds) : undefined,
        maxParallelWorkers: Number.isFinite(Number(args.max_parallel_workers)) ? Number(args.max_parallel_workers) : undefined,
        sharedMemoryScopes: normalizeSharedMemoryScopes(args.shared_memory_scopes),
        visibility: args.visibility === 'expandable_internal_transcript' ? 'expandable_internal_transcript' : undefined
      })
      services.notifyAgentWorkspaceChanged?.({ entity: 'group', action: 'saved', id: saved.id })
      onProgress?.('✅ Agent 群组已保存', saved.name)

      return {
        success: true,
        group: saved,
        message: `Agent 群组 ${saved.name} 已保存。`
      }
    }
  }
}