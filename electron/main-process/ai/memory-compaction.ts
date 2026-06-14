import { randomUUID } from 'node:crypto'
import { OpenAIProvider } from '../../../src/main/ai-engine/providers/openai-provider.js'
import type { ChatMessage } from '../../../src/main/ai-engine/providers/openai-provider.js'
import type { MemoryCompactionPlan } from '../../../src/main/ai-engine/memory/memory-engine.js'
import type { MemoryCompactionResult, MemoryCompactionStatus, MemoryEntry } from '../../../src/shared/agent-workspace-types.js'
import { MEMORY_AI_COMPACTION_CHUNK_SIZE, MEMORY_AI_COMPACTION_TIMEOUT_MS } from '../constants.js'
import { mainState } from '../state.js'
import { broadcastToAppWindows } from '../windows.js'
import { getMessageText, truncateSectionText } from '../chat-message-utils.js'
import { resolveProviderConfig } from './agent-context.js'

export function cloneMemoryCompactionStatus (): MemoryCompactionStatus {
  return {
    ...mainState.memoryCompactionStatus,
    result: mainState.memoryCompactionStatus.result
      ? {
          ...mainState.memoryCompactionStatus.result,
          groups: mainState.memoryCompactionStatus.result.groups.map(group => ({
            ...group,
            mergedIds: [...group.mergedIds]
          }))
        }
      : undefined
  }
}

export function updateMemoryCompactionStatus (patch: Partial<MemoryCompactionStatus>): MemoryCompactionStatus {
  mainState.memoryCompactionStatus = {
    ...mainState.memoryCompactionStatus,
    ...patch,
    updatedAt: new Date().toISOString()
  }
  const snapshot = cloneMemoryCompactionStatus()
  broadcastToAppWindows('memory:compactionStatusChanged', snapshot)
  return snapshot
}

export function extractJsonObjectCandidate (value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fencedMatch?.[1]?.trim() || trimmed
  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    return candidate
  }
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return candidate.slice(start, end + 1)
  }
  return null
}

export function sanitizeMemoryPlanIdList (value: unknown, allowedIds: Set<string>): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const id = typeof item === 'string' ? item.trim() : ''
    if (!id || !allowedIds.has(id) || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

export function sanitizeMemoryPlanText (value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length > maxChars ? normalized.slice(0, maxChars) : normalized
}

export function sanitizeMemoryPlanTags (value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const tag = typeof item === 'string' ? item.trim() : ''
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    result.push(tag.slice(0, 40))
    if (result.length >= 12) break
  }
  return result
}

export function sanitizeMemoryPlanNumber (value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

export function parseMemoryCompactionPlan (rawText: string, chunkEntries: MemoryEntry[]): MemoryCompactionPlan {
  const allowedIds = new Set(chunkEntries.map(entry => entry.id))
  const jsonCandidate = extractJsonObjectCandidate(rawText)
  if (!jsonCandidate) {
    throw new Error('AI 未返回有效 JSON 整理方案')
  }

  const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>
  const deleteIds = sanitizeMemoryPlanIdList(parsed.deleteIds, allowedIds)
  const mergeGroups: NonNullable<MemoryCompactionPlan['mergeGroups']> = []
  const updates: NonNullable<MemoryCompactionPlan['updates']> = []

  if (Array.isArray(parsed.mergeGroups)) {
    for (const rawGroup of parsed.mergeGroups) {
      if (!rawGroup || typeof rawGroup !== 'object') continue
      const group = rawGroup as Record<string, unknown>
      const ids = sanitizeMemoryPlanIdList(group.ids, allowedIds)
      if (ids.length < 2) continue
      const targetId = typeof group.targetId === 'string' && allowedIds.has(group.targetId.trim())
        ? group.targetId.trim()
        : undefined
      mergeGroups.push({
        ids,
        targetId,
        title: sanitizeMemoryPlanText(group.title, 80),
        summary: sanitizeMemoryPlanText(group.summary, 420),
        details: sanitizeMemoryPlanText(group.details, 1200),
        tags: sanitizeMemoryPlanTags(group.tags)
      })
    }
  }

  if (Array.isArray(parsed.updates)) {
    for (const rawUpdate of parsed.updates) {
      if (!rawUpdate || typeof rawUpdate !== 'object') continue
      const update = rawUpdate as Record<string, unknown>
      const id = typeof update.id === 'string' ? update.id.trim() : ''
      if (!id || !allowedIds.has(id)) continue
      updates.push({
        id,
        title: sanitizeMemoryPlanText(update.title, 80),
        summary: sanitizeMemoryPlanText(update.summary, 420),
        details: sanitizeMemoryPlanText(update.details, 1200),
        tags: sanitizeMemoryPlanTags(update.tags),
        importance: sanitizeMemoryPlanNumber(update.importance),
        confidence: sanitizeMemoryPlanNumber(update.confidence)
      })
    }
  }

  return { deleteIds, mergeGroups, updates }
}

export function mergeMemoryCompactionPlans (plans: MemoryCompactionPlan[]): MemoryCompactionPlan {
  return {
    deleteIds: Array.from(new Set(plans.flatMap(plan => plan.deleteIds || []))),
    mergeGroups: plans.flatMap(plan => plan.mergeGroups || []),
    updates: plans.flatMap(plan => plan.updates || [])
  }
}

export function serializeMemoryEntryForAi (entry: MemoryEntry): Record<string, unknown> {
  return {
    id: entry.id,
    scope: `${entry.scopeType}/${entry.scopeId}`,
    type: entry.memoryType,
    pinned: entry.pinned,
    title: truncateSectionText(entry.title, 90),
    summary: truncateSectionText(entry.summary, 240),
    details: entry.details ? truncateSectionText(entry.details, 320) : undefined,
    tags: entry.tags.slice(0, 10),
    importance: Number(entry.importance.toFixed(2)),
    confidence: Number(entry.confidence.toFixed(2)),
    lastUsedAt: entry.lastUsedAt,
    updatedAt: entry.updatedAt
  }
}

export function sortMemoryEntriesForAiCompaction (entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((left, right) => {
    const leftGroup = `${left.scopeType}/${left.scopeId}/${left.memoryType}`
    const rightGroup = `${right.scopeType}/${right.scopeId}/${right.memoryType}`
    if (leftGroup !== rightGroup) return leftGroup.localeCompare(rightGroup)
    return `${left.title} ${left.summary}`.localeCompare(`${right.title} ${right.summary}`)
  })
}

export function chunkMemoryEntriesForAiCompaction (entries: MemoryEntry[]): MemoryEntry[][] {
  const sorted = sortMemoryEntriesForAiCompaction(entries)
  const chunks: MemoryEntry[][] = []
  let current: MemoryEntry[] = []
  let currentGroup = ''

  for (const entry of sorted) {
    const group = `${entry.scopeType}/${entry.scopeId}/${entry.memoryType}`
    if (current.length > 0 && (current.length >= MEMORY_AI_COMPACTION_CHUNK_SIZE || group !== currentGroup)) {
      chunks.push(current)
      current = []
    }
    currentGroup = group
    current.push(entry)
  }

  if (current.length > 0) chunks.push(current)
  return chunks
}

export function createMemoryCompactionProvider (): OpenAIProvider {
  const providerConfig = resolveProviderConfig()
  if (!providerConfig?.apiKey || !providerConfig.baseUrl || !providerConfig.model) {
    throw new Error('当前 AI 供应商未配置完整，无法执行 AI 记忆整理')
  }

  const provider = new OpenAIProvider()
  provider.setApiKey(providerConfig.apiKey)
  provider.setBaseUrl(providerConfig.baseUrl)
  provider.setModel(providerConfig.model)
  provider.setEnableThinking(false)
  provider.setTemperature(0.1)
  if (providerConfig.contextWindow) {
    provider.setContextWindow(providerConfig.contextWindow)
  }
  return provider
}

export async function requestMemoryCompactionPlanChunk (provider: OpenAIProvider, entries: MemoryEntry[], index: number, total: number): Promise<MemoryCompactionPlan> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        '你是 The World 的长期记忆整理器。你的任务是压缩整理用户、Agent、项目和频道记忆。',
        '只允许基于输入 JSON 中的记忆做判断，不得编造新事实，不得引用输入外的 ID。',
        '删除标准：空壳内容、Markdown 标题/表格碎片、无复用价值碎片、明显过时或与软件工程/当前 Agent 工作无关的知识。',
        '合并标准：同一 scope 且同一 type 下语义重复或高度近似的记忆。跨 scope 或跨 type 不要合并。',
        '置顶 pinned=true 的记忆不得放入 deleteIds；如果参与合并，优先作为 targetId。',
        'updates 用来改写仍有价值但表达松散的记忆，让 title/summary 更短、更准确。',
        '输出严格 JSON，不要 Markdown，不要解释。格式：',
        '{"deleteIds":["id"],"mergeGroups":[{"ids":["id1","id2"],"targetId":"id1","title":"短标题","summary":"合并后的完整事实","details":"可选详情","tags":["tag"]}],"updates":[{"id":"id","title":"短标题","summary":"整理后的事实","details":"可选详情","tags":["tag"],"importance":0.8,"confidence":0.8}]}'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `这是第 ${index + 1}/${total} 批记忆。请整理这一批。`,
        JSON.stringify(entries.map(serializeMemoryEntryForAi), null, 2)
      ].join('\n\n')
    }
  ]

  const response = await provider.chatCompletion(messages, [], undefined, { timeoutMs: MEMORY_AI_COMPACTION_TIMEOUT_MS })
  const text = getMessageText(response.content)
  return parseMemoryCompactionPlan(text, entries)
}

export async function buildMemoryCompactionPlanWithAi (
  entries: MemoryEntry[],
  onProgress?: (progress: { stage: string; detail?: string; totalChunks: number; completedChunks: number }) => void
): Promise<MemoryCompactionPlan> {
  if (entries.length === 0) return { deleteIds: [], mergeGroups: [], updates: [] }

  const provider = createMemoryCompactionProvider()
  const chunks = chunkMemoryEntriesForAiCompaction(entries)
  const plans: MemoryCompactionPlan[] = []
  onProgress?.({
    stage: '准备整理',
    detail: `共 ${chunks.length} 批记忆`,
    totalChunks: chunks.length,
    completedChunks: 0
  })

  for (let index = 0; index < chunks.length; index++) {
    onProgress?.({
      stage: 'AI 分析记忆',
      detail: `正在整理第 ${index + 1}/${chunks.length} 批`,
      totalChunks: chunks.length,
      completedChunks: index
    })
    plans.push(await requestMemoryCompactionPlanChunk(provider, chunks[index], index, chunks.length))
    onProgress?.({
      stage: 'AI 分析记忆',
      detail: `已完成 ${index + 1}/${chunks.length} 批`,
      totalChunks: chunks.length,
      completedChunks: index + 1
    })
  }

  return mergeMemoryCompactionPlans(plans)
}

export async function runMemoryCompactionWithStatus (): Promise<MemoryCompactionResult> {
  const taskId = randomUUID()
  const startedAt = new Date().toISOString()
  updateMemoryCompactionStatus({
    id: taskId,
    status: 'running',
    stage: '扫描记忆',
    detail: '正在读取当前所有记忆',
    scanned: 0,
    totalChunks: 0,
    completedChunks: 0,
    startedAt,
    finishedAt: undefined,
    result: undefined,
    error: undefined
  })

  try {
    const entries = mainState.memoryStore!.listAll(50000)
    updateMemoryCompactionStatus({
      id: taskId,
      status: 'running',
      stage: entries.length > 0 ? '准备整理' : '无需整理',
      detail: entries.length > 0 ? `已扫描 ${entries.length} 条记忆` : '当前没有可整理的记忆',
      scanned: entries.length,
      totalChunks: entries.length > 0 ? mainState.memoryCompactionStatus.totalChunks : 0,
      completedChunks: 0
    })

    const plan = await buildMemoryCompactionPlanWithAi(entries, (progress) => {
      updateMemoryCompactionStatus({
        id: taskId,
        status: 'running',
        stage: progress.stage,
        detail: progress.detail,
        scanned: entries.length,
        totalChunks: progress.totalChunks,
        completedChunks: progress.completedChunks
      })
    })

    updateMemoryCompactionStatus({
      id: taskId,
      status: 'running',
      stage: '应用整理结果',
      detail: '正在删除、合并和更新记忆',
      scanned: entries.length,
      completedChunks: mainState.memoryCompactionStatus.totalChunks
    })

    const result = mainState.memoryEngine!.compactMemory(plan)
    updateMemoryCompactionStatus({
      id: taskId,
      status: 'completed',
      stage: '整理完成',
      detail: `扫描 ${result.scanned} 条，删除 ${result.removedUseless} 条，合并 ${result.merged} 条，更新 ${result.updated} 条`,
      scanned: result.scanned,
      completedChunks: mainState.memoryCompactionStatus.totalChunks,
      finishedAt: new Date().toISOString(),
      result,
      error: undefined
    })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    updateMemoryCompactionStatus({
      id: taskId,
      status: 'failed',
      stage: '整理失败',
      detail: message,
      finishedAt: new Date().toISOString(),
      error: message
    })
    throw error
  } finally {
    mainState.activeMemoryCompactionPromise = null
  }
}
