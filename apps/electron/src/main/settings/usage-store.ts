import fs from 'node:fs'
import path from 'node:path'

/**
 * UsageStore — 持久化的 token 用量统计
 *
 * 按 (date, hourBucket, providerId, model) 聚合记录每次 provider 调用消耗的真实 token
 * （取自 provider 返回的 usage 字段），用于设置页「用量统计」表格与时段折线图。hourBucket
 * 为 0-23 的小时桶（本地时区），同键累加避免单次调用膨胀文件；展示层再按范围聚合到
 * 小时/两小时/天。自动只保留最近 MAX_RETENTION_DAYS 天的数据。
 *
 * 防崩溃：参照 scheduled-task-store / studio-task-store，逐字段 normalize，损坏
 * 文件不会让启动崩溃（这是历史上 long-term-goal 踩过的坑）。
 */

const MAX_RETENTION_DAYS = 90

export interface UsageRecord {
  date: string          // YYYY-MM-DD (本地时区)
  hourBucket: number    // 小时桶 0-23 (本地时区)
  providerId: string
  providerName: string  // 快照，provider 改名后历史仍可读
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** 原始供应商 input 是否已包含缓存读取；旧记录无此字段时兼容推断。 */
  inputIncludesCacheRead?: boolean
  /** 已明确协议口径的记录所对应的未缓存输入，用于跨协议精确汇总。 */
  knownUncachedInputTokens?: number
  callCount: number
}

export interface UsageRecordInput {
  providerId: string
  providerName: string
  model: string
  timestampMs?: number
  /** 原始 usage 对象（OpenAI / Anthropic 风格均可，统一解析）。 */
  usage: Record<string, unknown> | null | undefined
}

export interface UsageSummary {
  providerId: string
  providerName: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  uncachedInputTokens: number
  callCount: number
  /** 缓存命中占总输入 token 的比例 (0..1)，输入列保留供应商原始口径。 */
  cacheHitRate: number
  models: Array<{
    model: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    uncachedInputTokens: number
    callCount: number
    cacheHitRate: number
  }>
}

/** 旧记录未保存协议口径时的兼容推断；新记录以 inputIncludesCacheRead 为准。 */
export function totalInputTokens (inputTokens: number, cacheReadTokens: number, cacheCreationTokens = 0): number {
  return cacheReadTokens > inputTokens
    ? inputTokens + cacheReadTokens + cacheCreationTokens
    : inputTokens
}

export function cacheHitRate (uncachedInputTokens: number, cacheReadTokens: number, cacheCreationTokens = 0): number {
  const total = uncachedInputTokens + cacheReadTokens + cacheCreationTokens
  return total > 0 ? cacheReadTokens / total : 0
}

function uncachedInputTokens (record: Pick<UsageRecord, 'inputTokens' | 'cacheReadTokens' | 'inputIncludesCacheRead' | 'knownUncachedInputTokens'>): number {
  if (record.knownUncachedInputTokens !== undefined) return record.knownUncachedInputTokens
  if (record.inputIncludesCacheRead === true) return Math.max(0, record.inputTokens - record.cacheReadTokens)
  if (record.inputIncludesCacheRead === false) return record.inputTokens
  return totalInputTokens(record.inputTokens, record.cacheReadTokens) - record.cacheReadTokens
}

/** OpenAI 风格 usage 字段。 */
interface ParsedUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  inputIncludesCacheRead?: boolean
}

/**
 * 解析 provider 返回的 usage 对象，兼容 OpenAI（prompt_tokens_details.cached_tokens）
 * 与 Anthropic（cache_read_input_tokens / cache_creation_input_tokens）两种 schema。
 */
function parseUsage (usage: Record<string, unknown> | null | undefined): ParsedUsage {
  const empty: ParsedUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  if (!usage || typeof usage !== 'object') return empty

  const num = (value: unknown): number => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }

  const inputTokens = num(usage.prompt_tokens) || num(usage.input_tokens)
  const outputTokens = num(usage.completion_tokens) || num(usage.output_tokens)

  // OpenAI: prompt_tokens_details.cached_tokens
  const promptDetails = (usage.input_tokens_details ?? usage.prompt_tokens_details) as Record<string, unknown> | undefined
  const openaiCacheRead = promptDetails ? num(promptDetails.cached_tokens) : 0

  // Anthropic: cache_read_input_tokens / cache_creation_input_tokens
  const anthropicCacheRead = num(usage.cache_read_input_tokens)
  const anthropicCacheCreation = num(usage.cache_creation_input_tokens)
  const inputIncludesCacheRead = typeof usage.input_includes_cache_read === 'boolean'
    ? usage.input_includes_cache_read
    : usage.prompt_tokens_details || usage.input_tokens_details
      ? true
      : usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined
        ? false
        : undefined

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: openaiCacheRead || anthropicCacheRead,
    cacheCreationTokens: anthropicCacheCreation,
    inputIncludesCacheRead
  }
}

function normalizeString (value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeRecord (value: unknown): UsageRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const providerId = normalizeString(record.providerId)
  const model = normalizeString(record.model)
  const date = normalizeString(record.date)
  if (!providerId || !model || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null

  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
  }

  // hourBucket 规范化为 0-23 整数：缺失或非法 → 0，小数向下取整。
  const rawHour = typeof record.hourBucket === 'number' ? record.hourBucket : Number(record.hourBucket)
  const hourBucket = Number.isFinite(rawHour) && rawHour >= 0 && rawHour <= 23
    ? Math.floor(rawHour)
    : 0

  return {
    date,
    hourBucket,
    providerId,
    providerName: normalizeString(record.providerName) || providerId,
    model,
    inputTokens: num(record.inputTokens),
    outputTokens: num(record.outputTokens),
    cacheReadTokens: num(record.cacheReadTokens),
    cacheCreationTokens: num(record.cacheCreationTokens),
    inputIncludesCacheRead: typeof record.inputIncludesCacheRead === 'boolean' ? record.inputIncludesCacheRead : undefined,
    knownUncachedInputTokens: typeof record.knownUncachedInputTokens === 'number' ? num(record.knownUncachedInputTokens) : undefined,
    callCount: num(record.callCount) || 1
  }
}

function dateKeyFromMs (ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 把 ms 映射到 0-23 的小时桶（本地时区，与 dateKeyFromMs 同源）。 */
function hourBucketFromMs (ms: number): number {
  return new Date(ms).getHours()
}

function isOlderThan (dateKey: string, maxDays: number): boolean {
  const target = Date.parse(dateKey)
  if (!Number.isFinite(target)) return true
  const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000
  return target < cutoff
}

export class UsageStore {
  private readonly filePath: string
  private cache: UsageRecord[] | null = null

  constructor (userDataPath: string) {
    this.filePath = path.join(userDataPath, 'usage-records.json')
  }

  private load (): UsageRecord[] {
    if (this.cache) return this.cache
    try {
      if (!fs.existsSync(this.filePath)) {
        this.cache = []
        return this.cache
      }
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      const list = Array.isArray(parsed) ? parsed : (Array.isArray((parsed as Record<string, unknown>)?.records) ? (parsed as Record<string, unknown[]>).records : [])
      this.cache = list
        .map(normalizeRecord)
        .filter((r): r is UsageRecord => r !== null)
        .filter(r => !isOlderThan(r.date, MAX_RETENTION_DAYS))
      // If the load itself pruned anything, persist the trimmed set once.
      if (this.cache.length !== list.length) this.persist()
      return this.cache
    } catch (error) {
      console.error('[usage-store] Failed to load records:', (error as Error).message)
      this.cache = []
      return this.cache
    }
  }

  private persist (): void {
    if (!this.cache) return
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8')
    } catch (error) {
      console.error('[usage-store] Failed to persist records:', (error as Error).message)
    }
  }

  /** 记录一次 provider 调用的 token 消耗（同 date+hourBucket+provider+model 累加）。 */
  record (input: UsageRecordInput): void {
    const parsed = parseUsage(input.usage)
    // 跳过空 usage（某些流式调用可能不返回 token）。
    if (parsed.inputTokens === 0 && parsed.outputTokens === 0 && parsed.cacheReadTokens === 0 && parsed.cacheCreationTokens === 0) {
      return
    }
    const records = this.load()
    const timestampMs = typeof input.timestampMs === 'number' && Number.isFinite(input.timestampMs)
      ? input.timestampMs
      : Date.now()
    const date = dateKeyFromMs(timestampMs)
    const hourBucket = hourBucketFromMs(timestampMs)
    const existing = records.find(r =>
      r.date === date && r.hourBucket === hourBucket && r.providerId === input.providerId && r.model === input.model
    )
    const incomingUncachedInputTokens = parsed.inputIncludesCacheRead === true
      ? Math.max(0, parsed.inputTokens - parsed.cacheReadTokens)
      : parsed.inputIncludesCacheRead === false
        ? parsed.inputTokens
        : totalInputTokens(parsed.inputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens) - parsed.cacheReadTokens
    if (existing) {
      const previousUncachedInputTokens = uncachedInputTokens(existing)
      existing.inputTokens += parsed.inputTokens
      existing.outputTokens += parsed.outputTokens
      existing.cacheReadTokens += parsed.cacheReadTokens
      existing.cacheCreationTokens += parsed.cacheCreationTokens
      if (existing.inputIncludesCacheRead === undefined) {
        existing.inputIncludesCacheRead = parsed.inputIncludesCacheRead
      }
      existing.knownUncachedInputTokens = previousUncachedInputTokens + incomingUncachedInputTokens
      existing.callCount += 1
    } else {
      records.push({
        date,
        hourBucket,
        providerId: input.providerId,
        providerName: input.providerName || input.providerId,
        model: input.model,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        cacheReadTokens: parsed.cacheReadTokens,
        cacheCreationTokens: parsed.cacheCreationTokens,
        inputIncludesCacheRead: parsed.inputIncludesCacheRead,
        knownUncachedInputTokens: incomingUncachedInputTokens,
        callCount: 1
      })
    }
    this.persist()
  }

  /** 获取日期范围内的明细记录（按日期升序，同日按时段升序）。 */
  getDaily (from?: string, to?: string): UsageRecord[] {
    const records = this.load()
    return records
      .filter(r => (!from || r.date >= from) && (!to || r.date <= to))
      .sort((a, b) => a.date.localeCompare(b.date) || a.hourBucket - b.hourBucket || a.providerId.localeCompare(b.providerId) || a.model.localeCompare(b.model))
  }

  /** 按供应商聚合（含模型明细），用于表格分组展示。 */
  getSummary (from?: string, to?: string): UsageSummary[] {
    const daily = this.getDaily(from, to)
    const byProvider = new Map<string, UsageSummary>()
    for (const r of daily) {
      let summary = byProvider.get(r.providerId)
      if (!summary) {
        summary = {
          providerId: r.providerId,
          providerName: r.providerName,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          uncachedInputTokens: 0,
          callCount: 0,
          cacheHitRate: 0,
          models: []
        }
        byProvider.set(r.providerId, summary)
      }
      summary.inputTokens += r.inputTokens
      summary.outputTokens += r.outputTokens
      summary.cacheReadTokens += r.cacheReadTokens
      summary.cacheCreationTokens += r.cacheCreationTokens
      summary.uncachedInputTokens += uncachedInputTokens(r)
      summary.callCount += r.callCount

      let model = summary.models.find(m => m.model === r.model)
      if (!model) {
        model = { model: r.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, uncachedInputTokens: 0, callCount: 0, cacheHitRate: 0 }
        summary.models.push(model)
      }
      model.inputTokens += r.inputTokens
      model.outputTokens += r.outputTokens
      model.cacheReadTokens += r.cacheReadTokens
      model.cacheCreationTokens += r.cacheCreationTokens
      model.uncachedInputTokens += uncachedInputTokens(r)
      model.callCount += r.callCount
    }
    for (const summary of byProvider.values()) {
      summary.cacheHitRate = cacheHitRate(summary.uncachedInputTokens, summary.cacheReadTokens, summary.cacheCreationTokens)
      for (const model of summary.models) {
        model.cacheHitRate = cacheHitRate(model.uncachedInputTokens, model.cacheReadTokens, model.cacheCreationTokens)
      }
    }
    return [...byProvider.values()].sort((a, b) => a.providerName.localeCompare(b.providerName, 'zh-CN'))
  }

  /** 清理早于 beforeDate 的记录；不传则清空全部。 */
  clear (beforeDate?: string): number {
    const records = this.load()
    const before = beforeDate ? records.filter(r => r.date >= beforeDate) : []
    const removed = records.length - before.length
    this.cache = before
    this.persist()
    return removed
  }
}
