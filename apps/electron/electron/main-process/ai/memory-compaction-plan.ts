import type { MemoryCompactionPlan, MemoryEntry } from '../../../src/shared/agent-workspace-types.js'
import { MEMORY_AI_COMPACTION_CHUNK_SIZE } from '../constants.js'
import { truncateSectionText } from '../chat-message-utils.js'
import { t } from '../../../src/main/i18n/main-i18n.js'

/**
 * Pure plan-building helpers for AI memory compaction. Kept free of
 * Electron/main-state dependencies so the parsing rules stay unit-testable.
 */

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

/** One-line, length-capped snippet of the raw model output for error reporting. */
export function buildModelOutputPreview (rawText: string): string {
  const normalized = rawText.replace(/\s+/g, ' ').trim()
  const preview = normalized.length > 160 ? `${normalized.slice(0, 160)}…` : normalized
  return preview || t('mainDialog.memoryCompactionEmptyResponse')
}

export function parseMemoryCompactionPlan (rawText: string, chunkEntries: MemoryEntry[]): MemoryCompactionPlan {
  const allowedIds = new Set(chunkEntries.map(entry => entry.id))
  // Reasoning models may inline chain-of-thought in the content; it never
  // carries the plan and can confuse brace matching when truncated.
  const withoutThinking = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const jsonCandidate = extractJsonObjectCandidate(withoutThinking)
  if (!jsonCandidate) {
    throw new Error(t('mainDialog.memoryCompactionInvalidJsonPlan', { preview: buildModelOutputPreview(rawText) }))
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonCandidate) as Record<string, unknown>
  } catch (error) {
    throw new Error(t('mainDialog.memoryCompactionInvalidJsonPlan', { preview: buildModelOutputPreview(rawText) }), { cause: error })
  }
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
