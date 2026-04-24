import fs from 'node:fs'
import path from 'node:path'
import type { AgentGroupDefinition } from '../../shared/agent-workspace-types.js'

function sanitizeId (value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '')
}

function createGroupId (value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 36)

  return `group_${normalized || 'team'}_${Date.now().toString(36)}`
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

function normalizeGroup (value: Partial<AgentGroupDefinition>, existing?: AgentGroupDefinition | null): AgentGroupDefinition {
  const timestamp = new Date().toISOString()

  return {
    id: sanitizeId(value.id || existing?.id || createGroupId(value.name || 'group')),
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : (existing?.name || '未命名群组'),
    description: typeof value.description === 'string' ? value.description.trim() : (existing?.description || ''),
    coordinatorAgentId: typeof value.coordinatorAgentId === 'string' ? value.coordinatorAgentId.trim() : (existing?.coordinatorAgentId || ''),
    memberAgentIds: normalizeUniqueStringArray(value.memberAgentIds ?? existing?.memberAgentIds ?? []),
    maxRounds: Math.max(1, Math.min(5, Number(value.maxRounds ?? existing?.maxRounds ?? 2) || 2)),
    maxParallelWorkers: Math.max(1, Math.min(5, Number(value.maxParallelWorkers ?? existing?.maxParallelWorkers ?? 2) || 2)),
    sharedMemoryScopes: normalizeUniqueStringArray(value.sharedMemoryScopes ?? existing?.sharedMemoryScopes ?? ['group']).filter((item): item is AgentGroupDefinition['sharedMemoryScopes'][number] => {
      return item === 'group' || item === 'project' || item === 'channel'
    }),
    visibility: value.visibility === 'expandable_internal_transcript'
      ? 'expandable_internal_transcript'
      : (existing?.visibility || 'summary_only'),
    createdAt: existing?.createdAt || value.createdAt || timestamp,
    updatedAt: timestamp
  }
}

export class AgentGroupStore {
  private dir: string

  constructor (userDataPath: string) {
    this.dir = path.join(userDataPath, 'agent-groups')
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true })
    }
  }

  private filePath (id: string): string {
    return path.join(this.dir, `${sanitizeId(id)}.json`)
  }

  list (): AgentGroupDefinition[] {
    const groups: AgentGroupDefinition[] = []
    for (const file of fs.readdirSync(this.dir).filter(item => item.endsWith('.json'))) {
      try {
        const raw = fs.readFileSync(path.join(this.dir, file), 'utf-8')
        groups.push(normalizeGroup(JSON.parse(raw) as Partial<AgentGroupDefinition>))
      } catch {
        // Ignore corrupted group definitions.
      }
    }

    return groups.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  get (id: string): AgentGroupDefinition | null {
    const targetPath = this.filePath(id)
    if (!fs.existsSync(targetPath)) return null

    try {
      const raw = fs.readFileSync(targetPath, 'utf-8')
      return normalizeGroup(JSON.parse(raw) as Partial<AgentGroupDefinition>)
    } catch {
      return null
    }
  }

  save (value: Partial<AgentGroupDefinition>): AgentGroupDefinition {
    const existing = value.id ? this.get(value.id) : null
    const normalized = normalizeGroup(value, existing)
    fs.writeFileSync(this.filePath(normalized.id), JSON.stringify(normalized, null, 2), 'utf-8')
    return normalized
  }

  delete (id: string): boolean {
    const targetPath = this.filePath(id)
    if (!fs.existsSync(targetPath)) return false
    fs.unlinkSync(targetPath)
    return true
  }
}