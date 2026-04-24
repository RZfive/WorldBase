import type { AgentDefinition, AgentGroupDefinition, AgentMemoryScope, ChannelBinding, MemoryEntry, MemoryPromptContext, MemorySearchScope, MemoryType } from '../../../shared/agent-workspace-types.js'
import { MemoryStore } from './memory-store.js'

interface MemoryPromptInput {
  agent?: AgentDefinition | null
  group?: AgentGroupDefinition | null
  channelBinding?: ChannelBinding | null
  userMessage: string
  targetProjectId?: string | null
  userId?: string | null
  enabledScopeTypes?: AgentMemoryScope[]
}

interface IngestSessionInput {
  agent?: AgentDefinition | null
  group?: AgentGroupDefinition | null
  channelBinding?: ChannelBinding | null
  userMessages: string[]
  finalAssistantText?: string
  toolNames?: string[]
  targetProjectId?: string | null
  sourceConversationId?: string
  sourceSessionId?: string
  userId?: string | null
  enabledScopeTypes?: AgentMemoryScope[]
}

const MEMORY_TYPE_LIMITS: Record<MemoryType, number> = {
  user_trait: 5,
  agent_skill: 5,
  step: 6,
  knowledge: 8
}

function normalizeText (value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function stableId (seed: string): string {
  let hash = 0
  for (let index = 0; index < seed.length; index++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(index)
    hash |= 0
  }
  return `mem_${Math.abs(hash).toString(36)}`
}

function firstNonEmptyLine (value: string): string {
  return value
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || ''
}

function dedupeEntries (entries: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>()
  const result: MemoryEntry[] = []
  for (const entry of entries) {
    if (!entry.id || seen.has(entry.id)) continue
    seen.add(entry.id)
    result.push(entry)
  }
  return result
}

export class MemoryEngine {
  constructor (private readonly store: MemoryStore) {}

  private buildScopes (input: {
    agent?: AgentDefinition | null
    group?: AgentGroupDefinition | null
    channelBinding?: ChannelBinding | null
    targetProjectId?: string | null
    userId?: string | null
    enabledScopeTypes?: AgentMemoryScope[]
  }): MemorySearchScope[] {
    const enabledScopeTypes = new Set(input.enabledScopeTypes || ['user', 'agent', 'project', 'group', 'channel'])
    const scopes: MemorySearchScope[] = []
    if (enabledScopeTypes.has('user')) scopes.push({ scopeType: 'user', scopeId: input.userId || 'local-user' })
    if (input.agent && enabledScopeTypes.has('agent')) scopes.push({ scopeType: 'agent', scopeId: input.agent.id })
    if (input.group && enabledScopeTypes.has('group')) scopes.push({ scopeType: 'group', scopeId: input.group.id })
    if (input.channelBinding && enabledScopeTypes.has('channel')) scopes.push({ scopeType: 'channel', scopeId: input.channelBinding.id })
    if (input.targetProjectId && enabledScopeTypes.has('project')) scopes.push({ scopeType: 'project', scopeId: input.targetProjectId })
    return scopes
  }

  private formatSection (title: string, entries: MemoryEntry[]): string | null {
    if (entries.length === 0) return null
    const lines = entries.map(entry => `- ${entry.title}: ${entry.summary}`)
    return `## ${title}\n${lines.join('\n')}`
  }

  buildPromptContext (input: MemoryPromptInput): MemoryPromptContext {
    const scopes = this.buildScopes(input)
    const baseline = this.store.search({ scopes, limit: 20 })
    const query = normalizeText(input.userMessage)
    const queried = query ? this.store.search({ scopes, query, limit: 20 }) : []
    const merged = dedupeEntries([...queried, ...baseline])

    const grouped: Record<MemoryType, MemoryEntry[]> = {
      user_trait: [],
      agent_skill: [],
      step: [],
      knowledge: []
    }

    for (const entry of merged) {
      if (grouped[entry.memoryType].length >= MEMORY_TYPE_LIMITS[entry.memoryType]) continue
      grouped[entry.memoryType].push(entry)
      this.store.touch(entry.id)
    }

    const sections = [
      this.formatSection('User traits memory', grouped.user_trait),
      this.formatSection('Agent skills memory', grouped.agent_skill),
      this.formatSection('Reusable steps memory', grouped.step),
      this.formatSection('Knowledge memory', grouped.knowledge)
    ].filter((value): value is string => Boolean(value))

    return {
      sections,
      entries: [...grouped.user_trait, ...grouped.agent_skill, ...grouped.step, ...grouped.knowledge]
    }
  }

  private buildEntry (input: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): MemoryEntry {
    const timestamp = new Date().toISOString()
    const identitySeed = [input.scopeType, input.scopeId, input.memoryType, input.title, input.summary].join('|')
    return {
      ...input,
      id: stableId(identitySeed),
      createdAt: timestamp,
      updatedAt: timestamp
    }
  }

  private extractUserTraitEntries (messages: string[], scopes: MemorySearchScope[], sourceConversationId?: string, sourceSessionId?: string): MemoryEntry[] {
    const userScope = scopes.find(scope => scope.scopeType === 'user')
    if (!userScope) return []

    const patterns: Array<{ regex: RegExp; title: string; summary: string; tags: string[] }> = [
      {
        regex: /(以后|今后|默认|始终|统一).{0,12}(中文|Chinese)/i,
        title: '偏好使用中文',
        summary: '用户偏好默认使用中文沟通和输出。',
        tags: ['language', 'preference']
      },
      {
        regex: /(先.*方案.*再.*(写|改)代码|先规划后执行|先出方案)/i,
        title: '偏好先方案后执行',
        summary: '用户偏好先看方案或规划，再进入实现。',
        tags: ['workflow', 'planning']
      },
      {
        regex: /(严格授权|不要自动执行|不要直接执行)/i,
        title: '偏好严格授权',
        summary: '用户偏好危险操作先确认，不接受默认自动执行。',
        tags: ['auth', 'safety']
      },
      {
        regex: /(自动执行|可以直接执行|不需要确认)/i,
        title: '偏好自动执行',
        summary: '用户接受在安全边界内自动执行操作。',
        tags: ['auth', 'automation']
      }
    ]

    const result: MemoryEntry[] = []
    for (const message of messages) {
      for (const pattern of patterns) {
        if (!pattern.regex.test(message)) continue
        result.push(this.buildEntry({
          scopeType: userScope.scopeType,
          scopeId: userScope.scopeId,
          memoryType: 'user_trait',
          title: pattern.title,
          summary: pattern.summary,
          details: firstNonEmptyLine(message),
          tags: pattern.tags,
          sourceConversationId,
          sourceSessionId,
          sourceMessageIds: [],
          importance: 0.85,
          confidence: 0.85,
          pinned: false,
          lastUsedAt: undefined
        }))
      }
    }

    return dedupeEntries(result)
  }

  private extractAgentSkillEntries (agent: AgentDefinition | null | undefined, sourceConversationId?: string, sourceSessionId?: string): MemoryEntry[] {
    if (!agent || agent.skillIds.length === 0 || !agent.memoryWritePolicy.allowAgentSkills) return []

    return [this.buildEntry({
      scopeType: 'agent',
      scopeId: agent.id,
      memoryType: 'agent_skill',
      title: `${agent.name} 默认技能组合`,
      summary: `默认激活技能: ${agent.skillIds.join(', ')}`,
      details: agent.description || undefined,
      tags: ['skills', 'profile'],
      sourceConversationId,
      sourceSessionId,
      sourceMessageIds: [],
      importance: 0.8,
      confidence: 0.95,
      pinned: false,
      lastUsedAt: undefined
    })]
  }

  private extractStepEntries (toolNames: string[], scopes: MemorySearchScope[], sourceConversationId?: string, sourceSessionId?: string): MemoryEntry[] {
    const uniqueToolNames = Array.from(new Set(toolNames.map(name => normalizeText(name)).filter(Boolean)))
    if (uniqueToolNames.length < 2) return []

    const stepScope = scopes.find(scope => scope.scopeType === 'project') || scopes.find(scope => scope.scopeType === 'agent')
    if (!stepScope) return []

    return [this.buildEntry({
      scopeType: stepScope.scopeType,
      scopeId: stepScope.scopeId,
      memoryType: 'step',
      title: '常用执行链路',
      summary: `近期高频执行顺序: ${uniqueToolNames.join(' -> ')}`,
      details: '该步骤来自已完成会话的工具执行顺序，可在相似任务中优先复用。',
      tags: ['workflow', 'tools'],
      sourceConversationId,
      sourceSessionId,
      sourceMessageIds: [],
      importance: 0.72,
      confidence: 0.7,
      pinned: false,
      lastUsedAt: undefined
    })]
  }

  private extractKnowledgeEntries (assistantText: string, scopes: MemorySearchScope[], sourceConversationId?: string, sourceSessionId?: string): MemoryEntry[] {
    const normalized = normalizeText(assistantText)
    if (!normalized) return []

    const knowledgeScope = scopes.find(scope => scope.scopeType === 'project') || scopes.find(scope => scope.scopeType === 'group') || scopes.find(scope => scope.scopeType === 'agent')
    if (!knowledgeScope) return []

    const lines = assistantText
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => /(关键|注意|约束|坑|必须|不要|优先)/.test(line))
      .slice(0, 3)

    return lines.map(line => this.buildEntry({
      scopeType: knowledgeScope.scopeType,
      scopeId: knowledgeScope.scopeId,
      memoryType: 'knowledge',
      title: line.length > 28 ? `${line.slice(0, 28)}...` : line,
      summary: line,
      details: normalized.slice(0, 400),
      tags: ['knowledge', 'insight'],
      sourceConversationId,
      sourceSessionId,
      sourceMessageIds: [],
      importance: 0.75,
      confidence: 0.62,
      pinned: false,
      lastUsedAt: undefined
    }))
  }

  ingestSessionMemory (input: IngestSessionInput): MemoryEntry[] {
    const scopes = this.buildScopes({
      agent: input.agent,
      group: input.group,
      channelBinding: input.channelBinding,
      targetProjectId: input.targetProjectId,
      userId: input.userId,
      enabledScopeTypes: input.enabledScopeTypes
    })

    const entries = dedupeEntries([
      ...this.extractUserTraitEntries(input.userMessages, scopes, input.sourceConversationId, input.sourceSessionId),
      ...this.extractAgentSkillEntries(input.agent, input.sourceConversationId, input.sourceSessionId),
      ...(input.agent?.memoryWritePolicy.allowSteps !== false ? this.extractStepEntries(input.toolNames || [], scopes, input.sourceConversationId, input.sourceSessionId) : []),
      ...(input.agent?.memoryWritePolicy.allowKnowledge !== false ? this.extractKnowledgeEntries(input.finalAssistantText || '', scopes, input.sourceConversationId, input.sourceSessionId) : [])
    ])

    return this.store.upsertMany(entries)
  }

  listMemoryByScope (scopeType: MemorySearchScope['scopeType'], scopeId: string, limit = 50): MemoryEntry[] {
    return this.store.listByScope(scopeType, scopeId, limit)
  }

  deleteMemory (id: string): boolean {
    return this.store.delete(id)
  }

  pinMemory (id: string, pinned: boolean): boolean {
    return this.store.pin(id, pinned)
  }
}