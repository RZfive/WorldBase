import fs from 'node:fs'
import path from 'node:path'
import type { AgentDefinition, AgentMemoryWritePolicy } from '../../shared/agent-workspace-types.js'

const DEFAULT_AGENT_ID = 'agent_default'

const DEFAULT_MEMORY_WRITE_POLICY: AgentMemoryWritePolicy = {
  allowUserTraits: true,
  allowAgentSkills: true,
  allowSteps: true,
  allowKnowledge: true
}

function sanitizeId (value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '')
}

function createAgentId (value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 36)

  return `agent_${normalized || 'custom'}_${Date.now().toString(36)}`
}

function normalizeUniqueStringArray (value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const normalized = item.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

function normalizeAgent (value: Partial<AgentDefinition>, existing?: AgentDefinition | null): AgentDefinition {
  const timestamp = new Date().toISOString()

  return {
    id: sanitizeId(value.id || existing?.id || createAgentId(value.name || 'custom')),
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : (existing?.name || '未命名 Agent'),
    icon: typeof value.icon === 'string' && value.icon.trim() ? value.icon.trim() : existing?.icon,
    description: typeof value.description === 'string' ? value.description.trim() : (existing?.description || ''),
    systemPrompt: typeof value.systemPrompt === 'string' ? value.systemPrompt : (existing?.systemPrompt || ''),
    providerId: typeof value.providerId === 'string' && value.providerId.trim() ? value.providerId.trim() : existing?.providerId,
    modelId: typeof value.modelId === 'string' && value.modelId.trim() ? value.modelId.trim() : existing?.modelId,
    reasoningStrength: value.reasoningStrength || existing?.reasoningStrength || 'medium',
    skillIds: normalizeUniqueStringArray(value.skillIds ?? existing?.skillIds ?? []),
    allowedTools: normalizeUniqueStringArray(value.allowedTools ?? existing?.allowedTools ?? []),
    deniedTools: normalizeUniqueStringArray(value.deniedTools ?? existing?.deniedTools ?? []),
    memoryScopes: normalizeUniqueStringArray(value.memoryScopes ?? existing?.memoryScopes ?? ['user', 'agent', 'project']).filter((item): item is AgentDefinition['memoryScopes'][number] => {
      return item === 'user' || item === 'agent' || item === 'project' || item === 'group' || item === 'channel'
    }),
    memoryWritePolicy: {
      allowUserTraits: value.memoryWritePolicy?.allowUserTraits ?? existing?.memoryWritePolicy.allowUserTraits ?? DEFAULT_MEMORY_WRITE_POLICY.allowUserTraits,
      allowAgentSkills: value.memoryWritePolicy?.allowAgentSkills ?? existing?.memoryWritePolicy.allowAgentSkills ?? DEFAULT_MEMORY_WRITE_POLICY.allowAgentSkills,
      allowSteps: value.memoryWritePolicy?.allowSteps ?? existing?.memoryWritePolicy.allowSteps ?? DEFAULT_MEMORY_WRITE_POLICY.allowSteps,
      allowKnowledge: value.memoryWritePolicy?.allowKnowledge ?? existing?.memoryWritePolicy.allowKnowledge ?? DEFAULT_MEMORY_WRITE_POLICY.allowKnowledge
    },
    autoReplyPolicy: {
      enabled: value.autoReplyPolicy?.enabled ?? existing?.autoReplyPolicy?.enabled ?? false,
      requireMention: value.autoReplyPolicy?.requireMention ?? existing?.autoReplyPolicy?.requireMention ?? true
    },
    createdAt: existing?.createdAt || value.createdAt || timestamp,
    updatedAt: timestamp
  }
}

function buildDefaultAgent (): AgentDefinition {
  const timestamp = new Date().toISOString()
  return {
    id: DEFAULT_AGENT_ID,
    name: '主 Agent',
    icon: '🤖',
    description: '默认主 Agent，适合通用开发、调试和方案推进。',
    systemPrompt: 'You are the primary The World agent. Coordinate user requests pragmatically, favor grounded implementation, and reuse available skills and memory before inventing new flows.',
    reasoningStrength: 'medium',
    skillIds: [],
    allowedTools: [],
    deniedTools: [],
    memoryScopes: ['user', 'agent', 'project'],
    memoryWritePolicy: { ...DEFAULT_MEMORY_WRITE_POLICY },
    autoReplyPolicy: {
      enabled: false,
      requireMention: true
    },
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

export class AgentStore {
  private dir: string

  constructor (userDataPath: string) {
    this.dir = path.join(userDataPath, 'agents')
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true })
    }
  }

  private filePath (id: string): string {
    return path.join(this.dir, `${sanitizeId(id)}.json`)
  }

  private ensureDefaultAgent (): void {
    if (fs.readdirSync(this.dir).some(file => file.endsWith('.json'))) {
      return
    }

    const defaultAgent = buildDefaultAgent()
    fs.writeFileSync(this.filePath(defaultAgent.id), JSON.stringify(defaultAgent, null, 2), 'utf-8')
  }

  list (): AgentDefinition[] {
    this.ensureDefaultAgent()

    const agents: AgentDefinition[] = []
    for (const file of fs.readdirSync(this.dir).filter(item => item.endsWith('.json'))) {
      try {
        const raw = fs.readFileSync(path.join(this.dir, file), 'utf-8')
        agents.push(normalizeAgent(JSON.parse(raw) as Partial<AgentDefinition>))
      } catch {
        // Ignore corrupted agent definitions.
      }
    }

    return agents.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  get (id: string): AgentDefinition | null {
    this.ensureDefaultAgent()

    const targetPath = this.filePath(id)
    if (!fs.existsSync(targetPath)) return null

    try {
      const raw = fs.readFileSync(targetPath, 'utf-8')
      return normalizeAgent(JSON.parse(raw) as Partial<AgentDefinition>)
    } catch {
      return null
    }
  }

  save (value: Partial<AgentDefinition>): AgentDefinition {
    const existing = value.id ? this.get(value.id) : null
    const normalized = normalizeAgent(value, existing)
    fs.writeFileSync(this.filePath(normalized.id), JSON.stringify(normalized, null, 2), 'utf-8')
    return normalized
  }

  delete (id: string): boolean {
    if (id === DEFAULT_AGENT_ID) return false

    const targetPath = this.filePath(id)
    if (!fs.existsSync(targetPath)) return false
    fs.unlinkSync(targetPath)
    return true
  }
}