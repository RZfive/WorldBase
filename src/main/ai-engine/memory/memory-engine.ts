import type { AgentDefinition, AgentGroupDefinition, AgentMemoryScope, ChannelBinding, MemoryCompactionResult, MemoryEntry, MemoryPromptContext, MemorySearchScope, MemoryType } from '../../../shared/agent-workspace-types.js'
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

export interface MemoryCompactionPlan {
  deleteIds?: string[]
  mergeGroups?: Array<{
    ids: string[]
    targetId?: string
    title?: string
    summary?: string
    details?: string
    tags?: string[]
  }>
  updates?: Array<{
    id: string
    title?: string
    summary?: string
    details?: string
    tags?: string[]
    importance?: number
    confidence?: number
  }>
}

const MEMORY_TYPE_LIMITS: Record<MemoryType, number> = {
  user_trait: 5,
  agent_skill: 5,
  step: 6,
  knowledge: 8
}

const MEMORY_QUERY_TERM_LIMIT = 12
const MEMORY_COMPACTION_LIMIT = 50000
const MEMORY_SIMILARITY_THRESHOLD = 0.72
const MEMORY_CONTAINMENT_THRESHOLD = 0.88
const KNOWLEDGE_SIGNAL_PATTERN = /(关键|注意|约束|坑|必须|不要|优先|应该|需要|避免|只能|不能|务必|建议|推荐)/
const SOFTWARE_CONTEXT_PATTERN = /(AI|API|CSS|DOM|Electron|HTML|JavaScript|MCP|Next\.?js|React|SQLite|TypeScript|Vue|agent|build|prompt|runtime|server|shell|token|代码|项目|文件|构建|编译|测试|依赖|组件|函数|接口|数据库|工具|提示词|记忆|上下文|权限|命令|模型|网页|浏览器|日志|路由|配置|环境)/i

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

function stripMarkdownPrefix (value: string): string {
  return value
    .trim()
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^#{1,6}\s*/, '')
    .trim()
}

function cleanMemoryText (value: string): string {
  return normalizeText(stripMarkdownPrefix(value)
    .replace(/\*\*/g, '')
    .replace(/`+/g, ''))
}

function isMarkdownStructureLine (value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return true

  const withoutBullet = stripMarkdownPrefix(trimmed)
  if (!withoutBullet) return true
  if (/^#{1,6}\s+/.test(trimmed.replace(/^[-*+]\s+/, '').trim())) return true
  if (/^\|.*\|$/.test(withoutBullet)) return true
  if (/^[:|\-\s]+$/.test(withoutBullet)) return true
  if (/^```/.test(withoutBullet)) return true
  if (/^(关键点|结论|注意|备注|说明|总结)[:：]?$/.test(withoutBullet)) return true

  return false
}

function isUsefulMemoryText (title: string, summary: string): boolean {
  const cleanTitle = cleanMemoryText(title)
  const cleanSummary = cleanMemoryText(summary)
  if (!cleanTitle || !cleanSummary) return false
  if (isMarkdownStructureLine(title) || isMarkdownStructureLine(summary)) return false
  if (cleanTitle === cleanSummary && cleanTitle.length <= 12 && /^(关键点|结论|注意|备注|说明|总结)/.test(cleanTitle)) return false
  return true
}

function getMemorySearchText (entry: MemoryEntry): string {
  return normalizeText([
    entry.title,
    entry.summary,
    entry.details || '',
    ...(entry.tags || [])
  ].join(' '))
}

function extractQueryTerms (value: string): string[] {
  const normalized = value.normalize('NFKC')
  const rawTerms = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) || []
  const seen = new Set<string>()
  const terms: string[] = []

  for (const rawTerm of rawTerms) {
    const term = rawTerm.replace(/^[-_]+|[-_]+$/g, '').toLocaleLowerCase()
    if (!term || seen.has(term)) continue
    seen.add(term)
    terms.push(term)
    if (terms.length >= MEMORY_QUERY_TERM_LIMIT) break
  }

  return terms
}

function hasQueryOverlap (entry: MemoryEntry, queryTerms: string[]): boolean {
  if (queryTerms.length === 0) return false
  const haystack = getMemorySearchText(entry).toLocaleLowerCase()
  return queryTerms.some(term => haystack.includes(term))
}

function isDurableSoftwareKnowledge (value: string): boolean {
  const cleaned = cleanMemoryText(value)
  if (cleaned.length < 12 || cleaned.length > 220) return false
  if (!KNOWLEDGE_SIGNAL_PATTERN.test(cleaned)) return false
  return SOFTWARE_CONTEXT_PATTERN.test(cleaned)
}

function splitKnowledgeCandidates (assistantText: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const rawLine of assistantText.split(/\r?\n/)) {
    if (isMarkdownStructureLine(rawLine)) continue

    const cleaned = cleanMemoryText(rawLine)
    if (!cleaned) continue

    const sentenceParts = cleaned
      .split(/[。！？!?；;]\s*/)
      .map(part => part.trim())
      .filter(Boolean)

    for (const part of sentenceParts.length > 0 ? sentenceParts : [cleaned]) {
      if (!isDurableSoftwareKnowledge(part) || seen.has(part)) continue
      seen.add(part)
      result.push(part)
      if (result.length >= 3) return result
    }
  }

  return result
}

function buildKnowledgeTitle (value: string): string {
  const cleaned = cleanMemoryText(value)
  return cleaned.length > 32 ? `${cleaned.slice(0, 32)}...` : cleaned
}

function normalizeUniqueStringArray (value: Array<string | undefined>): string[] {
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

function getLatestIsoString (values: Array<string | undefined>): string | undefined {
  return normalizeUniqueStringArray(values).sort((left, right) => right.localeCompare(left))[0]
}

function normalizeForSimilarity (value: string): string {
  return cleanMemoryText(value)
    .toLocaleLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
}

function buildSimilarityTokenSet (value: string): Set<string> {
  const normalized = cleanMemoryText(value).toLocaleLowerCase().normalize('NFKC')
  const tokens = new Set<string>()
  const words = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) || []

  for (const word of words) {
    tokens.add(word)
  }

  const compact = normalized.replace(/[^\p{L}\p{N}]+/gu, '')
  if (/[\u4e00-\u9fff]/.test(compact)) {
    for (let index = 0; index < compact.length - 1; index++) {
      tokens.add(compact.slice(index, index + 2))
    }
  }

  if (tokens.size === 0 && compact) {
    tokens.add(compact)
  }

  return tokens
}

function jaccardSimilarity (left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) {
    if (right.has(token)) intersection++
  }
  return intersection / (left.size + right.size - intersection)
}

function containmentSimilarity (left: Set<string>, right: Set<string>): number {
  const smaller = left.size <= right.size ? left : right
  const larger = left.size <= right.size ? right : left
  if (smaller.size === 0) return 0
  let intersection = 0
  for (const token of smaller) {
    if (larger.has(token)) intersection++
  }
  return intersection / smaller.size
}

function getEntryComparableText (entry: MemoryEntry): string {
  return cleanMemoryText(`${entry.title} ${entry.summary}`)
}

function memoryValueScore (entry: MemoryEntry): number {
  return (entry.pinned ? 10 : 0) +
    (entry.importance * 3) +
    (entry.confidence * 2) +
    (entry.lastUsedAt ? 0.4 : 0)
}

function isUselessMemoryEntry (entry: MemoryEntry): boolean {
  if (entry.pinned) return false

  const title = cleanMemoryText(entry.title)
  const summary = cleanMemoryText(entry.summary)
  const combined = cleanMemoryText(`${title} ${summary}`)

  if (!isUsefulMemoryText(entry.title, entry.summary)) return true
  if (combined.length < 8) return true
  if (/^(none|n\/a|null|undefined|无|暂无|空|未知)$/i.test(title) || /^(none|n\/a|null|undefined|无|暂无|空|未知)$/i.test(summary)) return true
  if (entry.memoryType === 'knowledge' && !isDurableSoftwareKnowledge(summary)) return true
  if (entry.importance < 0.25 && entry.confidence < 0.25) return true

  return false
}

function areSimilarMemoryEntries (left: MemoryEntry, right: MemoryEntry): boolean {
  if (left.scopeType !== right.scopeType || left.scopeId !== right.scopeId || left.memoryType !== right.memoryType) {
    return false
  }

  const leftText = normalizeForSimilarity(getEntryComparableText(left))
  const rightText = normalizeForSimilarity(getEntryComparableText(right))
  if (!leftText || !rightText) return false
  if (leftText === rightText) return true

  const shorter = leftText.length <= rightText.length ? leftText : rightText
  const longer = leftText.length <= rightText.length ? rightText : leftText
  if (shorter.length >= 12 && longer.includes(shorter)) return true

  const leftTokens = buildSimilarityTokenSet(getEntryComparableText(left))
  const rightTokens = buildSimilarityTokenSet(getEntryComparableText(right))
  return jaccardSimilarity(leftTokens, rightTokens) >= MEMORY_SIMILARITY_THRESHOLD ||
    containmentSimilarity(leftTokens, rightTokens) >= MEMORY_CONTAINMENT_THRESHOLD
}

function compactTextFragments (values: Array<string | undefined>, maxChars: number): string {
  const fragments: string[] = []

  for (const value of values) {
    const cleaned = cleanMemoryText(value || '')
    if (!cleaned) continue
    if (fragments.some(existing => existing === cleaned || existing.includes(cleaned))) continue

    const containingIndex = fragments.findIndex(existing => cleaned.includes(existing))
    if (containingIndex >= 0) {
      fragments.splice(containingIndex, 1)
    }

    fragments.push(cleaned)
  }

  let result = ''
  for (const fragment of fragments) {
    const next = result ? `${result}；${fragment}` : fragment
    if (next.length > maxChars) {
      const remaining = maxChars - result.length - (result ? 1 : 0)
      if (remaining > 24) {
        result = `${result}${result ? '；' : ''}${fragment.slice(0, remaining - 3)}...`
      }
      break
    }
    result = next
  }

  return result
}

function choosePrimaryMemoryEntry (entries: MemoryEntry[], preferredId?: string): MemoryEntry {
  const preferred = preferredId ? entries.find(entry => entry.id === preferredId) : undefined
  if (preferred) return preferred

  return [...entries].sort((left, right) => {
    const scoreDiff = memoryValueScore(right) - memoryValueScore(left)
    if (scoreDiff !== 0) return scoreDiff
    const leftTime = left.lastUsedAt || left.updatedAt || left.createdAt
    const rightTime = right.lastUsedAt || right.updatedAt || right.createdAt
    return rightTime.localeCompare(leftTime)
  })[0]
}

function coercePlanText (value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = cleanMemoryText(value)
  if (!cleaned) return undefined
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned
}

function coercePlanNumber (value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

function mergeMemoryEntries (
  entries: MemoryEntry[],
  overrides?: {
    targetId?: string
    title?: string
    summary?: string
    details?: string
    tags?: string[]
  }
): MemoryEntry {
  const primary = choosePrimaryMemoryEntry(entries, overrides?.targetId)
  const ordered = [
    primary,
    ...entries.filter(entry => entry.id !== primary.id)
  ]
  const sourceMessageIds = normalizeUniqueStringArray(ordered.flatMap(entry => entry.sourceMessageIds || []))
  const aiSummary = coercePlanText(overrides?.summary, 420)
  const aiDetails = coercePlanText(overrides?.details, 1200)
  const summary = aiSummary || compactTextFragments(ordered.map(entry => entry.summary), 320) || primary.summary
  const details = aiDetails || compactTextFragments([
    ...ordered.map(entry => entry.details),
    ...ordered.map(entry => entry.summary)
  ], 900)
  const tags = normalizeUniqueStringArray([
    ...(overrides?.tags || []),
    ...ordered.flatMap(entry => entry.tags)
  ])
  const title = coercePlanText(overrides?.title, 80) || primary.title || summary

  return {
    ...primary,
    title: buildKnowledgeTitle(title),
    summary,
    details: details || primary.details,
    tags,
    sourceConversationId: primary.sourceConversationId || ordered.find(entry => entry.sourceConversationId)?.sourceConversationId,
    sourceSessionId: primary.sourceSessionId || ordered.find(entry => entry.sourceSessionId)?.sourceSessionId,
    sourceMessageIds,
    importance: Math.min(1, Math.max(...ordered.map(entry => entry.importance)) + (ordered.length - 1) * 0.03),
    confidence: Math.min(1, Math.max(...ordered.map(entry => entry.confidence)) + (ordered.length - 1) * 0.02),
    pinned: ordered.some(entry => entry.pinned),
    lastUsedAt: getLatestIsoString(ordered.map(entry => entry.lastUsedAt))
  }
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
    const lines = entries
      .map((entry) => {
        const entryTitle = cleanMemoryText(entry.title)
        const summary = cleanMemoryText(entry.summary)
        if (!entryTitle || !summary) return null
        if (entryTitle === summary || summary.startsWith(`${entryTitle}:`) || summary.startsWith(`${entryTitle}：`)) {
          return `- ${summary}`
        }
        return `- ${entryTitle}: ${summary}`
      })
      .filter((line): line is string => Boolean(line))
    if (lines.length === 0) return null
    return `## ${title}\n${lines.join('\n')}`
  }

  private shouldInjectMemoryEntry (entry: MemoryEntry, queryTerms: string[], matchedQuery: boolean): boolean {
    if (!isUsefulMemoryText(entry.title, entry.summary)) return false
    if (entry.pinned) return true
    if (entry.memoryType === 'user_trait' || entry.memoryType === 'agent_skill') return true

    const isGroupCollaborationKnowledge = entry.scopeType === 'group' && entry.tags.includes('group-collaboration')
    if (entry.memoryType === 'knowledge' && !isGroupCollaborationKnowledge && !isDurableSoftwareKnowledge(entry.summary)) {
      return false
    }

    if (matchedQuery || hasQueryOverlap(entry, queryTerms)) return true

    // Without a textual match, only very reliable reusable workflow memory is
    // worth injecting. This prevents unrelated baseline memories from leaking
    // into every prompt.
    return queryTerms.length === 0 && entry.memoryType === 'step' && entry.importance >= 0.85 && entry.confidence >= 0.8
  }

  buildPromptContext (input: MemoryPromptInput): MemoryPromptContext {
    const scopes = this.buildScopes(input)
    const query = normalizeText(input.userMessage)
    const queried = query ? this.store.search({ scopes, query, limit: 20 }) : []
    const queriedIds = new Set(queried.map(entry => entry.id))
    const queryTerms = extractQueryTerms(query)
    const baseline = this.store.search({ scopes, limit: 20 })
    const merged = dedupeEntries([...queried, ...baseline])

    const grouped: Record<MemoryType, MemoryEntry[]> = {
      user_trait: [],
      agent_skill: [],
      step: [],
      knowledge: []
    }

    for (const entry of merged) {
      if (!this.shouldInjectMemoryEntry(entry, queryTerms, queriedIds.has(entry.id))) continue
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

  /**
   * R7 · Write a single knowledge entry scoped to a group. Used by the group
   * deliberation runtime to persist a collaboration summary so future runs of
   * the same group can recall how it worked together.
   */
  writeGroupKnowledge (input: {
    group: AgentGroupDefinition
    title: string
    summary: string
    details?: string
    tags?: string[]
    sourceConversationId?: string
    sourceSessionId?: string
    importance?: number
    confidence?: number
  }): MemoryEntry | null {
    if (!input.title.trim() || !input.summary.trim()) return null
    const entry = this.buildEntry({
      scopeType: 'group',
      scopeId: input.group.id,
      memoryType: 'knowledge',
      title: input.title.trim(),
      summary: input.summary.trim(),
      details: input.details,
      tags: input.tags ?? [],
      sourceConversationId: input.sourceConversationId,
      sourceSessionId: input.sourceSessionId,
      importance: input.importance ?? 0.7,
      confidence: input.confidence ?? 0.7,
      pinned: false
    })
    return this.store.upsert(entry)
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

    const candidates = splitKnowledgeCandidates(assistantText)

    return candidates.map(candidate => this.buildEntry({
      scopeType: knowledgeScope.scopeType,
      scopeId: knowledgeScope.scopeId,
      memoryType: 'knowledge',
      title: buildKnowledgeTitle(candidate),
      summary: candidate,
      details: normalized.slice(0, 600),
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

  compactMemory (plan: MemoryCompactionPlan): MemoryCompactionResult {
    const allEntries = this.store.listAll(MEMORY_COMPACTION_LIMIT)
    const entriesById = new Map(allEntries.map(entry => [entry.id, entry]))
    const deletedIds = new Set<string>()
    const mergeGroups: MemoryCompactionResult['groups'] = []
    let deleted = 0
    let removedUseless = 0
    let merged = 0
    let updated = 0

    const removeEntry = (id: string): boolean => {
      const entry = entriesById.get(id)
      if (!entry || deletedIds.has(id) || entry.pinned) return false
      if (!this.store.delete(id)) return false
      deletedIds.add(id)
      entriesById.delete(id)
      deleted++
      return true
    }

    for (const id of normalizeUniqueStringArray(plan.deleteIds || [])) {
      if (removeEntry(id)) {
        removedUseless++
      }
    }

    for (const group of plan.mergeGroups || []) {
      const ids = normalizeUniqueStringArray(group.ids || [])
      const cluster = ids
        .map(id => entriesById.get(id))
        .filter((entry): entry is MemoryEntry => entry !== undefined && !deletedIds.has(entry.id))
      if (cluster.length <= 1) continue

      const first = cluster[0]
      const sameScopeAndType = cluster.every(entry => {
        return entry.scopeType === first.scopeType &&
          entry.scopeId === first.scopeId &&
          entry.memoryType === first.memoryType
      })
      if (!sameScopeAndType) continue

      const preferredTargetId = group.targetId && cluster.some(entry => entry.id === group.targetId)
        ? group.targetId
        : undefined
      const mergedEntry = mergeMemoryEntries(cluster, {
        targetId: preferredTargetId,
        title: group.title,
        summary: group.summary,
        details: group.details,
        tags: group.tags
      })
      if (!mergedEntry.summary.trim()) continue

      const saved = this.store.upsert(mergedEntry)
      entriesById.set(saved.id, saved)
      updated++

      const mergedIds: string[] = []
      for (const entry of cluster) {
        if (entry.id === saved.id || entry.pinned) continue
        if (removeEntry(entry.id)) {
          mergedIds.push(entry.id)
          merged++
        }
      }

      if (mergedIds.length > 0) {
        mergeGroups.push({ targetId: saved.id, mergedIds, title: saved.title })
      }
    }

    for (const patch of plan.updates || []) {
      const current = entriesById.get(patch.id)
      if (!current || deletedIds.has(current.id)) continue

      const title = coercePlanText(patch.title, 80)
      const summary = coercePlanText(patch.summary, 420)
      const details = coercePlanText(patch.details, 1200)
      const importance = coercePlanNumber(patch.importance)
      const confidence = coercePlanNumber(patch.confidence)
      const tags = Array.isArray(patch.tags)
        ? normalizeUniqueStringArray(patch.tags)
        : undefined

      const next: MemoryEntry = {
        ...current,
        title: title || current.title,
        summary: summary || current.summary,
        details: details || current.details,
        tags: tags && tags.length > 0 ? tags : current.tags,
        importance: importance ?? current.importance,
        confidence: confidence ?? current.confidence
      }

      if (!next.title.trim() || !next.summary.trim()) continue
      const saved = this.store.upsert(next)
      entriesById.set(saved.id, saved)
      updated++
    }

    return {
      scanned: allEntries.length,
      deleted,
      removedUseless,
      merged,
      updated,
      retained: Math.max(0, allEntries.length - deleted),
      groups: mergeGroups
    }
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
