import crypto from 'node:crypto'
import type { AIConfigInput, AIEngine, CustomToolRegistration } from '../ai-engine/ai-engine.js'
import type { ChatMessage } from '../ai-engine/providers/openai-provider.js'
import type { LongTermGoalStore } from '../settings/long-term-goal-store.js'
import type { ScheduledTaskDefinition, ScheduledTaskProgressEntry, ScheduledTaskRunReport } from '../settings/scheduled-task-store.js'
import type { ScheduledTaskService } from '../scheduler/scheduled-task-service.js'
import type { SkillStore } from '../settings/skill-store.js'
import type {
  LongTermGoalActivityEvent,
  LongTermGoalChangeSet,
  LongTermGoalConversationTurn,
  LongTermGoalDailyReview,
  LongTermGoalDefinition,
  LongTermGoalIntervention,
  LongTermGoalMemoryEntry,
  LongTermGoalMessageResult,
  LongTermGoalNextTask,
  LongTermGoalReplanResult,
  LongTermGoalRun,
  LongTermGoalRunToolRun,
  LongTermGoalSaveInput,
  LongTermGoalSchedule,
  LongTermGoalScheduleSlot,
  LongTermGoalSnapshot,
  LongTermGoalStreamEvent
} from '../../shared/long-term-goal-types.js'

interface LongTermGoalServiceOptions {
  store: LongTermGoalStore
  scheduledTaskService: ScheduledTaskService
  aiEngine: AIEngine
  skillStore?: SkillStore
  projectFS?: { readFile: (projectId: string, relativePath: string) => Promise<string | null> }
  resolveProviderConfig?: (providerId?: string | null, modelId?: string | null, reasoningEffort?: 'low' | 'medium' | 'high' | 'max', temperature?: number) => AIConfigInput | undefined
  onGoalsChanged?: (goals: LongTermGoalDefinition[]) => void
  onSnapshotChanged?: (snapshot: LongTermGoalSnapshot) => void
  onInterventionRequested?: (goal: LongTermGoalDefinition, intervention: LongTermGoalIntervention) => void
  onRunProgress?: (goalId: string, run: LongTermGoalRun) => void
}

interface GoalConversationSession {
  phase: 'clarifying' | 'proposal'
  contextTurns: LongTermGoalConversationTurn[]
  lastAssistantTurnId: string | null
  proposal?: GoalAdjustmentProposal | null
  draftGoal?: LongTermGoalDefinition
}

interface GoalAdjustmentProposal {
  title: string
  objective: string
  summary: string
  before: Partial<LongTermGoalDefinition>
  after: Partial<LongTermGoalDefinition>
  questions: Array<{ id: string; question: string; options: string[]; reason?: string }>
}

interface GoalAdjustmentReply {
  content: string
  changeSet: LongTermGoalChangeSet | null
  proposal: GoalAdjustmentProposal | null
  phase: 'clarifying' | 'proposal'
  thinking?: string
  toolRuns?: LongTermGoalRunToolRun[]
}

interface ParsedGoalRunResult {
  progressSummary: string
  gapToGoal: string
  nextPlan: string[]
  completedItems: string[]
  importantAchievements: string[]
  learnedSkills: string[]
  blockers: string[]
  nextRunAt: string | null
  upcomingSchedule: Array<{ at: string; title: string; reason?: string }>
  bindProjectIds: string[]
  needsUserInput: boolean
  userQuestions: Array<{ id?: string; question: string; options?: string[]; reason?: string }>
  notificationLevel: 'silent' | 'badge' | 'notify'
  memoryUpdates: Array<{ kind?: LongTermGoalMemoryEntry['kind']; title: string; content: string; importance?: number }>
}

const GOAL_REPLAN_METADATA_LABEL = 'LONG_TERM_GOAL_REPLAN_METADATA'

const MAX_RUN_HISTORY = 120
const MAX_REVIEW_HISTORY = 180
const MAX_ACTIVITY_HISTORY = 600
const MAX_CONVERSATION_HISTORY = 200
const MAX_MEMORY_ENTRIES = 80
const RECENT_CONTEXT_LIMIT = 8
const EXECUTION_BRIEF_TITLE = '长期目标执行记忆包'
const LONG_TERM_GOAL_TASK_MARKER = '[LongTermGoal]'
const LONG_TERM_GOAL_REVIEW_MARKER = '[LongTermGoalReview]'
const GOAL_RUN_METADATA_LABEL = 'LONG_TERM_GOAL_RUN_METADATA'
const GOAL_ADJUSTMENT_METADATA_LABEL = 'LONG_TERM_GOAL_ADJUSTMENT_METADATA'
const GOAL_ADJUSTMENT_SAFE_TOOL_NAME_PATTERNS: RegExp[] = [
  /^list_/i,
  /^read_/i,
  /^grep_/i,
  /^glob_/i,
  /^get_/i,
  /^query_/i,
  /^analyze_/i,
  /^mcp__/i,
  /^web_search$/i,
  /^fetch_webpage$/i,
  /^read_current_page$/i,
  /^list_documents$/i,
  /^read_document$/i,
  /^mcp_list_/i,
  /^mcp_read_resource$/i,
  /^mcp_get_prompt$/i
]
const GOAL_ADJUSTMENT_BLOCKED_TOOL_NAME_PATTERNS: RegExp[] = [
  /(?:^|_)(write|create|edit|patch|delete|remove|update|run|execute|install|restart|start|stop|build|rebuild|finalize|spawn|interact|commit|push|pull)(?:_|$)/i
]
/**
 * 当长目标已绑定项目时，调整对话额外放行的项目读写/构建工具。
 * create_project 也放行——目标需要时可自建项目并自动绑定到 targetProjectIds。
 */
const GOAL_ADJUSTMENT_PROJECT_TOOLS = new Set([
  'create_project',
  'write_project_file',
  'patch_project_file',
  'read_project_file',
  'list_project_files',
  'rebuild_project',
  'read_file'
])

/** 调整流里始终允许的工具（不受写入黑名单影响）。 */
const GOAL_ADJUSTMENT_ALWAYS_ALLOWED_TOOLS = new Set(['create_project'])

function isGoalAdjustmentToolDefinition (tool: { name: string; description?: string }, goal?: { targetProjectIds?: string[] }): boolean {
  const name = tool.name.trim()
  if (!name) return false
  // create_project 始终放行：目标可自建项目，建后自动绑定。
  if (GOAL_ADJUSTMENT_ALWAYS_ALLOWED_TOOLS.has(name)) return true
  // 已绑定项目时，放行项目读写/构建工具（create_project 已在上面放行）。
  if (goal?.targetProjectIds && goal.targetProjectIds.length > 0 && GOAL_ADJUSTMENT_PROJECT_TOOLS.has(name)) {
    return true
  }

  if (GOAL_ADJUSTMENT_BLOCKED_TOOL_NAME_PATTERNS.some(pattern => pattern.test(name))) {
    return false
  }

  if (GOAL_ADJUSTMENT_SAFE_TOOL_NAME_PATTERNS.some(pattern => pattern.test(name))) {
    return true
  }

  const description = (tool.description || '').toLowerCase()
  if (!description) return false

  if (/(?:write|create|edit|patch|delete|remove|update|run|execute|install|restart|start|stop|build|rebuild|finalize|spawn|interact|commit|push|pull)/i.test(description)) {
    return false
  }

  return /(?:read|list|get|query|search|fetch|resource|prompt)/i.test(description)
}

function clone<T> (value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowIso (): string {
  return new Date().toISOString()
}

function generateId (prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

function normalizeString (value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeStringArray (value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    const normalized = normalizeString(item)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function compactText (value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3)}...`
}

function dateKeyFromIso (value?: string | null): string {
  const timestamp = value ? Date.parse(value) : Date.now()
  const date = Number.isFinite(timestamp) ? new Date(timestamp) : new Date()
  return date.toISOString().slice(0, 10)
}

function normalizeIsoDate (value?: string | null): string | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return new Date(timestamp).toISOString()
}

function normalizeFutureIsoDate (value?: string | null, minDelayMinutes = 10): string | null {
  const normalized = normalizeIsoDate(value)
  if (!normalized) return null
  const minimum = Date.now() + minDelayMinutes * 60 * 1000
  if (Date.parse(normalized) < minimum) return new Date(minimum).toISOString()
  return normalized
}

function fallbackNextRunAtFromSchedule (schedule: LongTermGoalSchedule): string {
  if (schedule.kind === 'once') return normalizeFutureIsoDate(schedule.runAt) || new Date(Date.now() + 60 * 60 * 1000).toISOString()
  if (schedule.kind === 'interval') {
    const startAt = normalizeFutureIsoDate(schedule.startAt)
    if (startAt) return startAt
    return new Date(Date.now() + Math.max(5, schedule.everyMinutes) * 60 * 1000).toISOString()
  }
  if (schedule.kind === 'daily') {
    const candidate = dateAtTime(new Date(), schedule.timeOfDay)
    return Date.parse(candidate) > Date.now()
      ? candidate
      : dateAtTime(new Date(Date.now() + 24 * 60 * 60 * 1000), schedule.timeOfDay)
  }
  if (schedule.kind === 'weekly') {
    const allowed = new Set(schedule.weekdays)
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidate = new Date()
      candidate.setDate(candidate.getDate() + offset)
      const weekday = candidate.getDay() === 0 ? 7 : candidate.getDay()
      const atTime = dateAtTime(candidate, schedule.timeOfDay)
      if (allowed.has(weekday) && Date.parse(atTime) > Date.now()) return atTime
    }
  }
  if (schedule.kind === 'dates') {
    const date = schedule.dates.map(date => normalizeFutureIsoDate(date)).find(Boolean)
    if (date) return date
  }
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
}

function toGoalScheduledSchedule (goal: LongTermGoalDefinition): ScheduledTaskDefinition['schedule'] {
  const runAt = normalizeFutureIsoDate(goal.nextRunAt) || fallbackNextRunAtFromSchedule(goal.schedule)
  return { kind: 'once', runAt }
}

function scheduleSummary (schedule: LongTermGoalSchedule): string {
  if (schedule.kind === 'daily') return `每天 ${schedule.timeOfDay}`
  if (schedule.kind === 'weekly') return `每周 ${schedule.weekdays.join(', ')} ${schedule.timeOfDay}`
  if (schedule.kind === 'interval') return `每 ${schedule.everyMinutes} 分钟`
  if (schedule.kind === 'once') return `一次性 ${schedule.runAt}`
  return `${schedule.dates.length} 个指定时间`
}

function normalizeTimeParts (hour: number, minute = 0): string | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`
}

function inferTimeOfDay (text: string, fallback = '09:00'): string {
  const explicit = text.match(/(\d{1,2})\s*[:：点]\s*(\d{1,2})?\s*(?:分)?/)
  if (explicit) {
    const hour = Number(explicit[1])
    const minute = explicit[2] == null || explicit[2] === '' ? 0 : Number(explicit[2])
    const normalized = normalizeTimeParts(hour, minute)
    if (normalized) return normalized
  }
  if (/凌晨|半夜/.test(text)) return '01:00'
  if (/清晨|早上|早晨|上午/.test(text)) return '09:00'
  if (/中午/.test(text)) return '12:00'
  if (/下午/.test(text)) return '15:00'
  if (/傍晚/.test(text)) return '18:00'
  if (/晚上|晚间/.test(text)) return '21:00'
  return fallback
}

function inferWeekdays (text: string): number[] {
  const weekdays = new Set<number>()
  const aliases: Array<[RegExp, number]> = [
    [/周一|星期一|礼拜一/g, 1],
    [/周二|星期二|礼拜二/g, 2],
    [/周三|星期三|礼拜三/g, 3],
    [/周四|星期四|礼拜四/g, 4],
    [/周五|星期五|礼拜五/g, 5],
    [/周六|星期六|礼拜六/g, 6],
    [/周日|周天|星期日|星期天|礼拜日|礼拜天/g, 7]
  ]
  for (const [pattern, day] of aliases) {
    if (pattern.test(text)) weekdays.add(day)
  }
  if (/工作日/.test(text)) [1, 2, 3, 4, 5].forEach(day => weekdays.add(day))
  if (/周末|星期末/.test(text)) [6, 7].forEach(day => weekdays.add(day))
  return Array.from(weekdays).sort((left, right) => left - right)
}

function dateAtTime (base: Date, timeOfDay: string): string {
  const [hour, minute] = timeOfDay.split(':').map(Number)
  const date = new Date(base.getTime())
  date.setHours(hour || 0, minute || 0, 0, 0)
  return date.toISOString()
}

function inferSpecificDateSchedule (text: string, timeOfDay: string): LongTermGoalSchedule | null {
  const now = new Date()
  if (/今天/.test(text)) {
    const today = dateAtTime(now, timeOfDay)
    return { kind: 'once', runAt: Date.parse(today) > Date.now() ? today : new Date(Date.now() + 10 * 60 * 1000).toISOString() }
  }
  if (/明天/.test(text)) {
    const date = new Date(now.getTime())
    date.setDate(date.getDate() + 1)
    return { kind: 'once', runAt: dateAtTime(date, timeOfDay) }
  }
  const dateMatch = text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/)
  if (dateMatch) {
    const date = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]))
    return { kind: 'once', runAt: dateAtTime(date, timeOfDay) }
  }
  return null
}

function inferGoalSchedule (objective: string, explicitSchedule?: LongTermGoalSchedule): LongTermGoalSchedule {
  if (explicitSchedule) return explicitSchedule
  const text = objective.replace(/\s+/g, '')
  const timeOfDay = inferTimeOfDay(text)

  const interval = text.match(/每(?:隔)?(\d+)(分钟|小时|天|周)/)
  if (interval) {
    const amount = Number(interval[1])
    const unit = interval[2]
    if (Number.isFinite(amount) && amount > 0) {
      const multiplier = unit === '小时' ? 60 : unit === '天' ? 24 * 60 : unit === '周' ? 7 * 24 * 60 : 1
      return {
        kind: 'interval',
        everyMinutes: Math.min(7 * 24 * 60, Math.max(5, Math.floor(amount * multiplier)))
      }
    }
  }

  const specificDate = inferSpecificDateSchedule(text, timeOfDay)
  if (specificDate && !/每天|每日|每周|每星期|每月|定期|持续|长期/.test(text)) {
    return specificDate
  }

  const weekdays = inferWeekdays(text)
  if (/每周|每星期|每礼拜|周报|周更|每个工作日|工作日|周末/.test(text) || weekdays.length > 0) {
    return {
      kind: 'weekly',
      weekdays: weekdays.length > 0 ? weekdays : [1],
      timeOfDay
    }
  }

  if (/实时|高频|盯|监控|巡检|检查|跟进|提醒|复查|同步/.test(text)) {
    if (/半小时|30分钟/.test(text)) return { kind: 'interval', everyMinutes: 30 }
    if (/小时|每小时/.test(text)) return { kind: 'interval', everyMinutes: 60 }
  }

  if (/每天|每日|日更|日报|每天都|早上|早晨|上午|晚上|晚间|下午|中午/.test(text)) {
    return { kind: 'daily', timeOfDay }
  }

  if (/月报|每月|月底|月初/.test(text)) {
    return { kind: 'weekly', weekdays: [1], timeOfDay }
  }

  if (/学习|健身|写作|复盘|项目|论文|产品|开发|研究|运营|增长|发布|长期|持续/.test(text)) {
    return { kind: 'daily', timeOfDay }
  }

  return { kind: 'daily', timeOfDay }
}

function sortGoals (goals: LongTermGoalDefinition[]): LongTermGoalDefinition[] {
  return [...goals].sort((left, right) => {
    const leftNeedsInput = left.openInterventions.some(item => item.status === 'open')
    const rightNeedsInput = right.openInterventions.some(item => item.status === 'open')
    if (leftNeedsInput !== rightNeedsInput) return leftNeedsInput ? -1 : 1
    if (left.status !== right.status) {
      const rank = new Map<LongTermGoalDefinition['status'], number>([
        ['active', 0],
        ['paused', 1],
        ['completed', 2],
        ['archived', 3]
      ])
      return (rank.get(left.status) ?? 9) - (rank.get(right.status) ?? 9)
    }
    const leftNext = left.nextRunAt || ''
    const rightNext = right.nextRunAt || ''
    if (leftNext && rightNext && leftNext !== rightNext) return leftNext.localeCompare(rightNext)
    if (leftNext && !rightNext) return -1
    if (!leftNext && rightNext) return 1
    return right.updatedAt.localeCompare(left.updatedAt)
  })
}

function extractJsonObject (text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [
    fenced?.[1],
    trimmed,
    trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)
  ].filter((value): value is string => Boolean(value && value.trim().startsWith('{')))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

function extractGoalMetadata (text: string): Record<string, unknown> | null {
  const metadataPattern = new RegExp(`<!--\\s*${GOAL_RUN_METADATA_LABEL}\\s*([\\s\\S]*?)\\s*-->`, 'i')
  const commentMatch = text.match(metadataPattern)
  if (commentMatch?.[1]) {
    const parsed = extractJsonObject(commentMatch[1])
    if (parsed) return parsed
  }

  return extractJsonObject(text)
}

function parseJsonRecord (value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value.trim()) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Not JSON.
  }
  return null
}

function stripJsonBlocksForDisplay (text: string): string {
  return text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, (block, body: string) => {
    return parseJsonRecord(body) ? '' : block
  })
}

function stripTrailingJsonObjectForDisplay (text: string): string {
  const trimmed = text.trim()
  for (let index = trimmed.lastIndexOf('{'); index >= 0; index = trimmed.lastIndexOf('{', index - 1)) {
    const parsed = parseJsonRecord(trimmed.slice(index))
    if (parsed) {
      return trimmed.slice(0, index).trim()
    }
  }
  return trimmed
}

function stripGoalMetadataForDisplay (text: string): string {
  const parsed = extractGoalMetadata(text)
  const withoutMetadata = text
    .replace(new RegExp(`<!--\\s*${GOAL_RUN_METADATA_LABEL}\\s*[\\s\\S]*?\\s*-->`, 'gi'), '')
    .replace(new RegExp(`<!--\\s*${GOAL_REPLAN_METADATA_LABEL}\\s*[\\s\\S]*?\\s*-->`, 'gi'), '')
    .trim()
  const withoutJsonBlocks = stripJsonBlocksForDisplay(withoutMetadata)
  const displayText = stripTrailingJsonObjectForDisplay(withoutJsonBlocks).trim()
  if (displayText && !parseJsonRecord(displayText)) return displayText
  if (parsed) return formatParsedGoalRunMarkdown(parsed, text)
  return ''
}

function stripGoalAdjustmentMetadataForDisplay (text: string): string {
  return stripTrailingJsonObjectForDisplay(
    stripJsonBlocksForDisplay(
      text.replace(new RegExp(`<!--\\s*${GOAL_ADJUSTMENT_METADATA_LABEL}\\s*[\\s\\S]*?\\s*-->`, 'gi'), '')
    )
  ).trim()
}

function formatParsedGoalRunMarkdown (parsed: Record<string, unknown>, fallbackText: string): string {
  const progressSummary = normalizeString(parsed.progressSummary) || compactText(fallbackText, 360) || '本次执行已结束。'
  const gapToGoal = normalizeString(parsed.gapToGoal) || normalizeString(parsed.gapAnalysis)
  const nextPlan = normalizeStringArray(parsed.nextPlan)
  const completedItems = normalizeStringArray(parsed.completedItems)
  const blockers = normalizeStringArray(parsed.blockers)

  return [
    '# 最新任务报告',
    '',
    progressSummary,
    '',
    completedItems.length > 0 ? `## 已完成\n${completedItems.map(item => `- ${item}`).join('\n')}` : '',
    gapToGoal ? `## 距离目标的差距\n${gapToGoal}` : '',
    nextPlan.length > 0 ? `## 下一步\n${nextPlan.map(item => `- ${item}`).join('\n')}` : '',
    blockers.length > 0 ? `## 阻塞\n${blockers.map(item => `- ${item}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n')
}

function progressToText (entry: ScheduledTaskProgressEntry): string {
  return [entry.stage, entry.detail].filter(Boolean).join(': ')
}

function shouldAttachProgressToTool (entry: ScheduledTaskProgressEntry): boolean {
  return entry.kind === 'progress' ||
    entry.kind === 'todo' ||
    entry.kind === 'file' ||
    entry.kind === 'web'
}

function reportProgressSummary (report: ScheduledTaskRunReport): string {
  const latest = [...(report.progress || [])]
    .reverse()
    .find(entry => entry.kind !== 'thinking')
  if (latest) return progressToText(latest)
  return report.summary || '正在执行长期目标。'
}

function buildRunToolRuns (report: ScheduledTaskRunReport): LongTermGoalRunToolRun[] {
  const toolRuns: LongTermGoalRunToolRun[] = []
  let activeTool: LongTermGoalRunToolRun | null = null

  for (const entry of report.progress || []) {
    if (entry.kind === 'tool_start') {
      activeTool = {
        id: `${report.id}_${toolRuns.length + 1}`,
        name: entry.toolName || entry.detail || entry.stage,
        status: 'running',
        progress: []
      }
      toolRuns.push(activeTool)
      continue
    }

    if (entry.kind === 'tool_end') {
      const target = [...toolRuns].reverse().find(item => item.status === 'running' && item.name === (entry.toolName || entry.detail || item.name)) ||
        activeTool ||
        toolRuns[toolRuns.length - 1] ||
        null
      if (target) {
        target.status = 'completed'
        if (entry.detail && !target.progress.some(step => step.stage === entry.stage && step.detail === entry.detail)) {
          target.progress.push({ stage: entry.stage, detail: entry.detail })
        }
      }
      activeTool = [...toolRuns].reverse().find(item => item.status === 'running') || null
      continue
    }

    if (shouldAttachProgressToTool(entry)) {
      if (activeTool) {
        activeTool.progress.push({ stage: entry.stage, detail: entry.detail })
      }
    }
  }

  if (report.status === 'completed' || report.status === 'failed') {
    for (const toolRun of toolRuns) {
      if (toolRun.status === 'running') {
        toolRun.status = report.status === 'failed' ? 'failed' : 'completed'
      }
    }
  }

  return toolRuns
}

function normalizeUpcomingSchedule (value: unknown): Array<{ at: string; title: string; reason?: string }> {
  if (!Array.isArray(value)) return []
  const result: Array<{ at: string; title: string; reason?: string }> = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const title = normalizeString(record.title)
    const at = normalizeFutureIsoDate(normalizeString(record.at), 1)
    if (!title || !at) continue
    result.push({ at, title, reason: normalizeString(record.reason) || undefined })
  }
  return result.slice(0, 12)
}

function buildFallbackGoalRunResult (resultText: string, fallbackTitle: string): ParsedGoalRunResult {
  const summary = compactText(resultText || fallbackTitle, 360)
  return {
    progressSummary: summary || '本次执行已结束。',
    gapToGoal: '本次未记录结构化差距分析，请在下一次执行中继续归纳。',
    nextPlan: [],
    completedItems: summary ? [summary] : [],
    importantAchievements: summary ? [summary] : [],
    learnedSkills: [],
    blockers: [],
    nextRunAt: null,
    upcomingSchedule: [],
    bindProjectIds: [],
    needsUserInput: false,
    userQuestions: [],
    notificationLevel: 'silent',
    memoryUpdates: summary
      ? [{ kind: 'progress_summary', title: '执行摘要', content: summary, importance: 0.55 }]
      : []
  }
}

function normalizeGoalRunResult (parsed: Record<string, unknown>, resultText: string, fallbackTitle: string): ParsedGoalRunResult {
  const notificationLevel = parsed.notificationLevel === 'notify' || parsed.notificationLevel === 'badge'
    ? parsed.notificationLevel
    : 'silent'
  const questions = Array.isArray(parsed.userQuestions) ? parsed.userQuestions : []
  const memoryUpdates = Array.isArray(parsed.memoryUpdates) ? parsed.memoryUpdates : []
  const userQuestions: ParsedGoalRunResult['userQuestions'] = []
  const parsedMemoryUpdates: ParsedGoalRunResult['memoryUpdates'] = []

  for (const item of questions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const question = normalizeString(record.question)
    if (!question) continue
    userQuestions.push({
      id: normalizeString(record.id) || undefined,
      question,
      options: normalizeStringArray(record.options),
      reason: normalizeString(record.reason) || undefined
    })
  }

  for (const item of memoryUpdates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const title = normalizeString(record.title)
    const content = normalizeString(record.content)
    if (!title || !content) continue
    const kind = normalizeString(record.kind) as LongTermGoalMemoryEntry['kind']
    const allowedKinds: LongTermGoalMemoryEntry['kind'][] = ['goal_profile', 'execution_brief', 'achievement', 'skill', 'progress_summary', 'daily_review', 'decision', 'blocker', 'plan', 'artifact']
    const importance = Number(record.importance)
    parsedMemoryUpdates.push({
      kind: allowedKinds.includes(kind) ? kind : 'progress_summary',
      title,
      content,
      importance: Number.isFinite(importance) ? Math.max(0, Math.min(1, importance)) : 0.6
    })
  }

  return {
    progressSummary: normalizeString(parsed.progressSummary) || compactText(resultText || fallbackTitle, 360) || '本次执行已结束。',
    gapToGoal: normalizeString(parsed.gapToGoal) || normalizeString(parsed.gapAnalysis) || '本次未发现新的关键差距。',
    nextPlan: normalizeStringArray(parsed.nextPlan),
    completedItems: normalizeStringArray(parsed.completedItems),
    importantAchievements: normalizeStringArray(parsed.importantAchievements),
    learnedSkills: normalizeStringArray(parsed.learnedSkills),
    blockers: normalizeStringArray(parsed.blockers),
    nextRunAt: normalizeFutureIsoDate(normalizeString(parsed.nextRunAt), 5),
    upcomingSchedule: normalizeUpcomingSchedule(parsed.upcomingSchedule),
    bindProjectIds: normalizeStringArray(parsed.bindProjectIds),
    needsUserInput: parsed.needsUserInput === true,
    userQuestions,
    notificationLevel,
    memoryUpdates: parsedMemoryUpdates
  }
}

function stripAssistantJson(text: string): string {
  return stripTrailingJsonObjectForDisplay(stripJsonBlocksForDisplay(text)).trim()
}

function formatGoalAdjustmentConversationTurn (turn: LongTermGoalConversationTurn): string {
  const lines = [turn.role === 'user' ? `用户：${turn.content}` : `AI：${turn.content}`]

  if (turn.thinking?.trim()) {
    lines.push(`思考：${compactText(turn.thinking, 1200)}`)
  }

  if (turn.toolRuns && turn.toolRuns.length > 0) {
    const toolLines = turn.toolRuns.map(toolRun => {
      const progress = toolRun.progress
        .map(step => compactText([step.stage, step.detail].filter(Boolean).join(': '), 160))
        .filter(Boolean)
      return `- ${toolRun.name} [${toolRun.status}]${progress.length > 0 ? `\n  ${progress.join('\n  ')}` : ''}`
    })
    lines.push(`工具：\n${toolLines.join('\n')}`)
  }

  return lines.join('\n')
}

function normalizeGoalAdjustmentQuestions (value: unknown): GoalAdjustmentProposal['questions'] {
  return Array.isArray(value)
    ? value
        .map(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return null
          const record = item as Record<string, unknown>
          const question = normalizeString(record.question)
          if (!question) return null
          return {
            id: normalizeString(record.id) || generateId('goal_question'),
            question,
            options: normalizeStringArray(record.options),
            reason: normalizeString(record.reason) || undefined
          }
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : []
}

function normalizeGoalPatch (value: unknown): Partial<LongTermGoalDefinition> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return clone(value) as Partial<LongTermGoalDefinition>
}

function deriveBeforePatch (goal: LongTermGoalDefinition, after: Partial<LongTermGoalDefinition>): Partial<LongTermGoalDefinition> {
  const before: Record<string, unknown> = {}
  const goalRecord = goal as unknown as Record<string, unknown>
  for (const key of Object.keys(after as Record<string, unknown>)) {
    if (key in goalRecord) {
      const currentValue = goalRecord[key]
      before[key] = currentValue === undefined ? undefined : clone(currentValue)
    }
  }
  return before as Partial<LongTermGoalDefinition>
}

function normalizeGoalAdjustmentProposal (
  value: Record<string, unknown>,
  currentGoal?: LongTermGoalDefinition
): GoalAdjustmentProposal | null {
  const after = normalizeGoalPatch(value.after)
  const afterRecord = after as Record<string, unknown>
  const title = normalizeString(value.title) || normalizeString(afterRecord.title) || currentGoal?.title || ''
  const objective = normalizeString(value.objective) || normalizeString(afterRecord.objective) || currentGoal?.objective || ''
  const summary = normalizeString(value.summary)
  if (!title || !objective || !summary) return null

  if (!normalizeString(afterRecord.title) && currentGoal && title !== currentGoal.title) {
    afterRecord.title = title
  }
  if (!normalizeString(afterRecord.objective) && currentGoal && objective !== currentGoal.objective) {
    afterRecord.objective = objective
  }
  const before = Object.keys(normalizeGoalPatch(value.before)).length > 0
    ? normalizeGoalPatch(value.before)
    : (currentGoal ? deriveBeforePatch(currentGoal, after) : {})
  return {
    title,
    objective,
    summary,
    before,
    after,
    questions: normalizeGoalAdjustmentQuestions(value.questions)
  }
}

function formatGoalAdjustmentAssistantText (text: string, fallbackProposal?: GoalAdjustmentProposal | null): string {
  const cleaned = stripGoalAdjustmentMetadataForDisplay(text)
  if (cleaned) return cleaned
  const parsed = fallbackProposal
  if (!parsed) return '我还需要更多信息来继续把目标收敛成更好的版本。'
  return [
    '# 目标调整提案',
    '',
    parsed.summary,
    '',
    `## 建议目标`,
    `- 标题：${parsed.title}`,
    `- 最终目标：${parsed.objective}`,
    '',
    parsed.questions.length > 0 ? `## 还需要确认\n${parsed.questions.map(question => `- ${question.question}`).join('\n')}` : '',
    '',
    '如果你确认这版更好，我再把它正式应用到长期目标里。'
  ].filter(Boolean).join('\n')
}

function buildGoalAdjustmentChangeSet (
  goal: LongTermGoalDefinition,
  proposal: GoalAdjustmentProposal,
  sourceTurnId: string
): LongTermGoalChangeSet {
  return {
    id: generateId('goal_change'),
    goalId: goal.id,
    sourceTurnId,
    summary: proposal.summary,
    before: proposal.before,
    after: proposal.after,
    requiresConfirmation: true,
    status: 'draft',
    createdAt: nowIso(),
    appliedAt: null
  }
}

export class LongTermGoalService {
  private snapshot: LongTermGoalSnapshot = {
    goals: [],
    runs: [],
    reviews: [],
    activities: [],
    memories: [],
    conversations: [],
    changeSets: []
  }
  private readonly adjustmentSessions = new Map<string, GoalConversationSession>()
  private readonly creationSessions = new Map<string, GoalConversationSession>()
  /** 绑定项目 README.md 内容缓存，供执行/重规划 prompt 同步注入接口说明。 */
  private readonly projectReadmeCache = new Map<string, string>()
  private readonly pendingRunResults = new Map<string, ParsedGoalRunResult>()

  constructor (private readonly options: LongTermGoalServiceOptions) {}

  private createLongTermGoalTools (
    goalInput: LongTermGoalDefinition | string,
    options: {
      allowMutation: boolean
      allowProposal?: boolean
      allowRunResult?: boolean
      runResultKey?: string
      onProposal?: (proposal: GoalAdjustmentProposal) => void
      onScheduleUpdate?: (result: LongTermGoalReplanResult) => void
    }
  ): CustomToolRegistration[] {
    const fallbackGoal = typeof goalInput === 'string' ? null : goalInput
    const goalId = typeof goalInput === 'string' ? goalInput : goalInput.id
    const resolveGoal = (): LongTermGoalDefinition => {
      const current = this.getGoal(goalId)
      if (current) return current
      if (fallbackGoal) return fallbackGoal
      return this.getGoalOrThrow(goalId)
    }
    const tools: CustomToolRegistration[] = [
      {
        definition: {
          name: 'long_term_goal_get_context',
          description: 'Long-term goal custom tool: read the current goal state, schedule, upcoming 24h plan, next tasks, bound projects, and recent progress memory.',
          parameters: {
            type: 'object',
            properties: {
              include_recent_activity: {
                type: 'boolean',
                description: 'Whether to include compact recent activity history. Defaults to true.'
              }
            }
          }
        },
        handler: async (args) => {
          const goal = resolveGoal()
          const includeRecentActivity = args.include_recent_activity !== false
          return {
            kind: 'long_term_goal_context',
            goal: {
              id: goal.id,
              title: goal.title,
              objective: goal.objective,
              status: goal.status,
              schedule: goal.schedule,
              nextRunAt: goal.nextRunAt,
              nextReviewAt: goal.nextReviewAt,
              currentPhase: goal.currentPhase,
              todayFocus: goal.todayFocus,
              progressSummary: goal.progressSummary,
              gapSummary: goal.gapSummary,
              targetProjectIds: goal.targetProjectIds,
              nextTasks: goal.nextTasks,
              upcomingSchedule: goal.upcomingSchedule
            },
            recentActivity: includeRecentActivity
              ? this.snapshot.activities
                .filter(item => item.goalId === goal.id)
                .slice(0, 12)
                .map(item => ({ at: item.createdAt, type: item.type, title: item.title, summary: item.summary }))
              : undefined
          }
        }
      }
    ]

    if (options.allowProposal) {
      tools.push({
        definition: {
          name: 'long_term_goal_propose_update',
          description: 'Long-term goal custom tool: create an explicit pending goal update proposal that requires user confirmation before any goal fields are changed. Use this whenever the user asks to modify, refine, or update the long-term goal itself.',
          parameters: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'The proposed goal title after confirmation.'
              },
              objective: {
                type: 'string',
                description: 'The proposed final objective after confirmation.'
              },
              summary: {
                type: 'string',
                description: 'Short human-readable summary of what will change and why.'
              },
              before: {
                type: 'object',
                description: 'Optional current values for fields that will change. Omit unknown fields; the system will derive them from the current goal when possible.'
              },
              after: {
                type: 'object',
                description: 'Only the fields to change after user confirmation, such as title, objective, schedule, targetProjectIds, selectedSkillIds, notificationPolicy, todayFocus, currentPhase, progressSummary, gapSummary, nextTasks, or upcomingSchedule.'
              },
              questions: {
                type: 'array',
                description: 'Optional final confirmation questions for the user.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    question: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' } },
                    reason: { type: 'string' }
                  },
                  required: ['question']
                }
              }
            },
            required: ['title', 'objective', 'summary', 'after']
          }
        },
        handler: async (args, onProgress) => {
          const goal = resolveGoal()
          const proposal = normalizeGoalAdjustmentProposal(args, goal)
          if (!proposal) {
            throw new Error('缺少可确认的目标变更提案，请提供 title、objective、summary 和 after。')
          }
          options.onProposal?.(proposal)
          onProgress?.('生成待确认目标变更', proposal.summary)
          return {
            kind: 'long_term_goal_pending_update',
            requiresConfirmation: true,
            message: '目标变更已生成待确认提案，用户确认前不会应用。',
            proposal
          }
        }
      })
    }

    if (options.allowRunResult) {
      tools.push({
        definition: {
          name: 'long_term_goal_record_run_result',
          description: 'Long-term goal custom tool: record the structured result of an execution or daily review. Use this before the final user-facing markdown report; do not hide this data in JSON comments.',
          parameters: {
            type: 'object',
            properties: {
              progressSummary: { type: 'string', description: 'What was completed and the current state, in one or two sentences.' },
              gapToGoal: { type: 'string', description: 'What is still missing to reach the goal and why it matters.' },
              nextPlan: { type: 'array', items: { type: 'string' }, description: 'Ordered next task titles.' },
              completedItems: { type: 'array', items: { type: 'string' }, description: 'Items completed in this run/review.' },
              importantAchievements: { type: 'array', items: { type: 'string' }, description: 'Reusable achievements or durable outputs from this run.' },
              learnedSkills: { type: 'array', items: { type: 'string' }, description: 'Reusable skills, methods, constraints, or lessons learned.' },
              blockers: { type: 'array', items: { type: 'string' }, description: 'Current blockers. Empty if none.' },
              nextRunAt: { type: 'string', description: 'ISO datetime for the next execution.' },
              upcomingSchedule: {
                type: 'array',
                description: 'Future 24h schedule slots: { at, title, reason }.',
                items: {
                  type: 'object',
                  properties: {
                    at: { type: 'string' },
                    title: { type: 'string' },
                    reason: { type: 'string' }
                  },
                  required: ['at', 'title']
                }
              },
              bindProjectIds: { type: 'array', items: { type: 'string' }, description: 'Project ids created in this run that should be bound to the goal.' },
              needsUserInput: { type: 'boolean', description: 'Whether the goal is blocked until the user answers.' },
              userQuestions: {
                type: 'array',
                description: 'Questions requiring user input.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    question: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' } },
                    reason: { type: 'string' }
                  },
                  required: ['question']
                }
              },
              notificationLevel: { type: 'string', enum: ['silent', 'badge', 'notify'], description: 'How visible the completion should be.' },
              memoryUpdates: {
                type: 'array',
                description: 'Long-term memory entries to write from this run.',
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string' },
                    title: { type: 'string' },
                    content: { type: 'string' },
                    importance: { type: 'number' }
                  },
                  required: ['title', 'content']
                }
              }
            },
            required: ['progressSummary', 'gapToGoal', 'nextPlan', 'nextRunAt', 'upcomingSchedule', 'notificationLevel']
          }
        },
        handler: async (args, onProgress) => {
          const goal = resolveGoal()
          const result = normalizeGoalRunResult(args, normalizeString(args.progressSummary), goal.title)
          const key = options.runResultKey || goal.id
          this.pendingRunResults.set(key, result)
          onProgress?.('记录长期目标执行结果', result.progressSummary)
          return {
            success: true,
            tool: 'long_term_goal_record_run_result',
            goalId: goal.id,
            requiresHiddenJson: false,
            progressSummary: result.progressSummary,
            nextRunAt: result.nextRunAt,
            notificationLevel: result.notificationLevel
          }
        }
      })
    }

    if (!options.allowMutation) {
      return tools
    }

    tools.push({
      definition: {
        name: 'long_term_goal_update_schedule',
        description: 'Long-term goal custom tool: update the goal next run time, future 24h schedule preview, next tasks, and lightweight focus/phase fields. Use this instead of encoding scheduling changes only in prose.',
        parameters: {
          type: 'object',
          properties: {
            next_run_at: {
              type: 'string',
              description: 'ISO datetime for the next execution. Omit to keep the current next run time.'
            },
            upcoming_schedule: {
              type: 'array',
              description: 'Future 24h schedule slots: { at, title, reason }. Only future slots inside 24h are kept.',
              items: {
                type: 'object',
                properties: {
                  at: { type: 'string' },
                  title: { type: 'string' },
                  reason: { type: 'string' }
                },
                required: ['at', 'title']
              }
            },
            next_tasks: {
              type: 'array',
              description: 'Ordered next task titles. These replace/create the visible next task queue while preserving still-running existing tasks.',
              items: { type: 'string' }
            },
            objective: { type: 'string', description: 'Optional updated objective when a user decision changes the goal direction.' },
            today_focus: { type: 'string', description: 'Optional updated focus for today.' },
            current_phase: { type: 'string', description: 'Optional updated current phase.' },
            progress_summary: { type: 'string', description: 'Optional updated progress summary.' },
            gap_summary: { type: 'string', description: 'Optional updated gap summary.' },
            summary: { type: 'string', description: 'Short reason for the schedule update.' }
          }
        }
      },
      handler: async (args, onProgress) => {
        const goal = this.getGoalOrThrow(goalId)
        const nextPlan = normalizeStringArray(args.next_tasks)
        const nextTasks = nextPlan.length > 0 ? this.buildNextTasks(goal, nextPlan) : goal.nextTasks
        const requestedNextRunAt = normalizeFutureIsoDate(normalizeString(args.next_run_at), 1)
        const nextRunAt = requestedNextRunAt || goal.nextRunAt || fallbackNextRunAtFromSchedule(goal.schedule)
        const upcomingSchedule = this.buildUpcomingSchedule(this.normalizeToolScheduleSlots(args.upcoming_schedule), nextTasks, nextRunAt)
        const summary = normalizeString(args.summary) || 'AI 更新了长期目标执行安排。'
        const patched: LongTermGoalDefinition = {
          ...goal,
          nextTasks,
          upcomingSchedule,
          nextRunAt,
          objective: normalizeString(args.objective) || goal.objective,
          todayFocus: normalizeString(args.today_focus) || goal.todayFocus,
          currentPhase: normalizeString(args.current_phase) || goal.currentPhase,
          progressSummary: normalizeString(args.progress_summary) || goal.progressSummary,
          gapSummary: normalizeString(args.gap_summary) || goal.gapSummary,
          updatedAt: nowIso()
        }

        let scheduled = patched
        try {
          scheduled = this.ensureScheduledTask(patched)
        } catch (error) {
          console.warn('[long-term-goal-service] Deferred backing schedule update from custom tool:', (error as Error).message)
        }

        this.upsertGoal(scheduled)
        this.addActivity({
          goalId: goal.id,
          actor: 'tool',
          type: 'plan_updated',
          title: '长期目标工具更新了执行安排',
          summary,
          details: JSON.stringify({ nextRunAt, upcomingSchedule: scheduled.upcomingSchedule }, null, 2)
        })
        this.persistAndEmit()
        onProgress?.('Long-term goal schedule updated', nextRunAt)
        const goalPatch: NonNullable<LongTermGoalReplanResult['goalPatch']> = {}
        const updatedObjective = normalizeString(args.objective)
        const updatedTodayFocus = normalizeString(args.today_focus)
        const updatedCurrentPhase = normalizeString(args.current_phase)
        if (updatedObjective) goalPatch.objective = updatedObjective
        if (updatedTodayFocus) goalPatch.todayFocus = updatedTodayFocus
        if (updatedCurrentPhase) goalPatch.currentPhase = updatedCurrentPhase
        const replanResult: LongTermGoalReplanResult = {
          summary,
          upcomingSchedule: scheduled.upcomingSchedule,
          nextTasks: scheduled.nextTasks.map(item => item.title)
        }
        if (scheduled.nextRunAt !== undefined) replanResult.nextRunAt = scheduled.nextRunAt
        if (Object.keys(goalPatch).length > 0) replanResult.goalPatch = goalPatch
        options.onScheduleUpdate?.(replanResult)
        return {
          success: true,
          tool: 'long_term_goal_update_schedule',
          goalId: goal.id,
          nextRunAt: scheduled.nextRunAt,
          upcomingSchedule: scheduled.upcomingSchedule,
          nextTasks: scheduled.nextTasks
        }
      }
    })

    return tools
  }

  private normalizeToolScheduleSlots (value: unknown): Array<{ at: string; title: string; reason?: string }> {
    if (!Array.isArray(value)) return []
    return value
      .map(item => {
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        const at = normalizeString(record.at)
        const title = normalizeString(record.title)
        if (!at || !title) return null
        const slot: { at: string; title: string; reason?: string } = {
          at,
          title
        }
        const reason = normalizeString(record.reason)
        if (reason) slot.reason = reason
        return slot
      })
      .filter((item): item is { at: string; title: string; reason?: string } => Boolean(item))
      .slice(0, 16)
  }

  start (): void {
    this.snapshot = this.options.store.getSnapshot()
    // Detect active goals whose AI-specified nextRunAt was missed while the app was closed/asleep.
    // Snapshot this BEFORE ensureScheduledTask re-derives nextRunAt from the (now-nulled) backing task.
    const now = Date.now()
    const missedGoalIds = this.snapshot.goals
      .filter(goal => goal.status === 'active' && goal.nextRunAt && Date.parse(goal.nextRunAt) <= now)
      .map(goal => goal.id)
    this.snapshot.goals = this.snapshot.goals.map(goal => this.ensureScheduledTask(this.syncGoalScheduleState(goal)))
    // 预热所有绑定项目的 README 缓存。
    for (const goal of this.snapshot.goals) {
      void this.refreshProjectReadmeCache(goal)
    }
    this.persistAndEmit()
    this.reconcileScheduledReports(this.options.scheduledTaskService.listAllReports())
    // Catch-up: trigger a fresh planning run for each missed goal so the AI re-decides nextRunAt based
    // on current state (user chose "skip + let AI re-decide"). Fire-and-forget; runNow guards against
    // double-runs via runningTaskIds.
    for (const goalId of missedGoalIds) {
      try {
        this.runGoalNow(goalId)
        this.addActivity({
          goalId,
          runId: null,
          actor: 'system',
          type: 'run_started',
          title: '错过执行，已触发重新规划',
          summary: '长期目标的上次计划执行时间在 app 关闭期间错过，已自动触发一次重新规划。'
        })
      } catch (error) {
        console.warn(`[long-term-goal-service] Failed to trigger catch-up run for goal ${goalId}:`, (error as Error).message)
      }
    }
  }

  listGoals (): LongTermGoalDefinition[] {
    return clone(sortGoals(this.snapshot.goals))
  }

  getGoal (goalId: string): LongTermGoalDefinition | null {
    const goal = this.snapshot.goals.find(item => item.id === goalId)
    return goal ? clone(goal) : null
  }

  getSnapshot (goalId?: string): LongTermGoalSnapshot {
    if (!goalId) return clone(this.snapshot)
    return clone({
      goals: this.snapshot.goals.filter(item => item.id === goalId),
      runs: this.snapshot.runs.filter(item => item.goalId === goalId),
      reviews: this.snapshot.reviews.filter(item => item.goalId === goalId),
      activities: this.snapshot.activities.filter(item => item.goalId === goalId),
      memories: this.snapshot.memories.filter(item => item.goalId === goalId),
      conversations: this.snapshot.conversations.filter(item => item.goalId === goalId),
      changeSets: this.snapshot.changeSets.filter(item => item.goalId === goalId)
    })
  }

  saveGoal (input: LongTermGoalSaveInput): LongTermGoalDefinition {
    const now = nowIso()
    const existing = input.id ? this.snapshot.goals.find(item => item.id === input.id) : undefined
    const title = normalizeString(input.title)
    const objective = normalizeString(input.objective)
    const inferredSchedule = inferGoalSchedule(`${title}\n${objective}`, input.schedule || existing?.schedule)
    const goal: LongTermGoalDefinition = {
      id: existing?.id || input.id || generateId('goal'),
      title,
      objective,
      status: input.status || existing?.status || 'active',
      providerId: normalizeString(input.providerId) || existing?.providerId || null,
      modelId: normalizeString(input.modelId) || existing?.modelId || null,
      schedule: inferredSchedule,
      scheduleTaskId: existing?.scheduleTaskId || input.scheduleTaskId || null,
      reviewScheduleTaskId: existing?.reviewScheduleTaskId || input.reviewScheduleTaskId || null,
      dailyReviewTimeOfDay: normalizeString(input.dailyReviewTimeOfDay) || existing?.dailyReviewTimeOfDay || inferTimeOfDay(`${title}\n${objective}`, '21:30'),
      selectedSkillIds: Array.isArray(input.selectedSkillIds) ? input.selectedSkillIds : (existing?.selectedSkillIds || []),
      selectedMcpServerIds: Array.isArray(input.selectedMcpServerIds) ? input.selectedMcpServerIds : (existing?.selectedMcpServerIds || []),
      targetProjectIds: Array.isArray(input.targetProjectIds) ? input.targetProjectIds : (existing?.targetProjectIds || []),
      notificationPolicy: input.notificationPolicy || existing?.notificationPolicy || 'minimal',
      currentPhase: normalizeString(input.currentPhase) || existing?.currentPhase || '启动',
      progressSummary: normalizeString(input.progressSummary) || existing?.progressSummary || '目标已创建，等待首次自动推进。',
      gapSummary: normalizeString(input.gapSummary) || existing?.gapSummary || '等待首次总结后生成差距分析。',
      todayFocus: normalizeString(input.todayFocus) || existing?.todayFocus || undefined,
      nextRunAt: existing?.nextRunAt || input.nextRunAt || null,
      nextReviewAt: existing?.nextReviewAt || input.nextReviewAt || null,
      lastRunAt: existing?.lastRunAt || input.lastRunAt || null,
      lastReviewAt: existing?.lastReviewAt || input.lastReviewAt || null,
      lastRunStatus: existing?.lastRunStatus || input.lastRunStatus || null,
      nextTasks: Array.isArray(input.nextTasks) ? input.nextTasks : (existing?.nextTasks || []),
      upcomingSchedule: Array.isArray(input.upcomingSchedule) ? input.upcomingSchedule : (existing?.upcomingSchedule || []),
      openInterventions: Array.isArray(input.openInterventions) ? input.openInterventions : (existing?.openInterventions || []),
      memorySummary: normalizeString(input.memorySummary) || existing?.memorySummary || undefined,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    }

    if (!goal.title) throw new Error('目标名称不能为空')
    if (!goal.objective) throw new Error('目标描述不能为空')

    const savedGoal = this.upsertGoal(this.ensureScheduledTask(goal))
    this.addActivity({
      goalId: savedGoal.id,
      actor: 'user',
      type: existing ? 'goal_changed' : 'goal_created',
      title: existing ? '目标已更新' : '目标已创建',
      summary: existing ? '用户更新了长期目标配置。' : `已创建长期目标：${savedGoal.title}`,
      details: savedGoal.objective
    })
    this.writeMemory(savedGoal.id, {
      kind: 'goal_profile',
      title: '目标定义',
      content: `${savedGoal.title}\n${savedGoal.objective}\n节奏：${scheduleSummary(savedGoal.schedule)}`,
      importance: 0.9
    })
    this.refreshExecutionBrief(savedGoal.id)
    this.persistAndEmit()
    return clone(savedGoal)
  }

  renameGoal (goalId: string, titleInput: string): LongTermGoalDefinition {
    const goal = this.getGoalOrThrow(goalId)
    const title = normalizeString(titleInput)
    if (!title) throw new Error('目标名称不能为空')
    if (title === goal.title) return clone(goal)

    const now = nowIso()
    const nextGoal: LongTermGoalDefinition = {
      ...goal,
      title,
      updatedAt: now
    }
    this.upsertGoal(nextGoal)
    this.addActivity({
      goalId,
      actor: 'user',
      type: 'goal_changed',
      title: '目标标题已更新',
      summary: `${goal.title} → ${title}`
    })
    this.writeMemory(goalId, {
      kind: 'goal_profile',
      title: '目标标题',
      content: title,
      importance: 0.9
    })
    this.refreshExecutionBrief(goalId)
    const scheduledGoal = this.ensureScheduledTask(nextGoal)
    this.upsertGoal({
      ...scheduledGoal,
      title,
      updatedAt: nowIso()
    })
    this.persistAndEmit()
    return this.getGoal(goalId)!
  }

  setGoalStatus (goalId: string, status: LongTermGoalDefinition['status']): LongTermGoalDefinition {
    const goal = this.getGoalOrThrow(goalId)
    if (status !== 'active' && status !== 'paused' && status !== 'completed' && status !== 'archived') {
      throw new Error('目标状态无效')
    }
    if (status === goal.status) return clone(goal)

    const now = nowIso()
    const nextGoal: LongTermGoalDefinition = {
      ...goal,
      status,
      nextRunAt: status === 'active'
        ? (normalizeFutureIsoDate(goal.nextRunAt) || fallbackNextRunAtFromSchedule(goal.schedule))
        : goal.nextRunAt || null,
      currentPhase: status === 'active'
        ? (goal.currentPhase === '已暂停' ? '持续推进' : goal.currentPhase || '持续推进')
        : status === 'paused'
          ? '已暂停'
          : goal.currentPhase,
      updatedAt: now
    }
    const scheduledGoal = this.ensureScheduledTask(nextGoal)
    const savedGoal = this.upsertGoal({
      ...scheduledGoal,
      status,
      updatedAt: nowIso()
    })
    this.addActivity({
      goalId,
      actor: 'user',
      type: 'goal_changed',
      title: status === 'active' ? '目标已恢复持续执行' : status === 'paused' ? '目标已暂停' : '目标状态已更新',
      summary: status
    })
    this.refreshExecutionBrief(goalId)
    this.persistAndEmit()
    return clone(savedGoal)
  }

  deleteGoal (goalId: string): boolean {
    const goal = this.snapshot.goals.find(item => item.id === goalId)
    if (!goal) return false
    if (goal.scheduleTaskId) {
      try {
        this.options.scheduledTaskService.deleteTask(goal.scheduleTaskId)
      } catch {
        // The scheduler may already be missing the backing task; keep deleting the goal.
      }
    }
    if (goal.reviewScheduleTaskId) {
      try {
        this.options.scheduledTaskService.deleteTask(goal.reviewScheduleTaskId)
      } catch {
        // The scheduler may already be missing the backing review task.
      }
    }
    this.snapshot.goals = this.snapshot.goals.filter(item => item.id !== goalId)
    this.snapshot.runs = this.snapshot.runs.filter(item => item.goalId !== goalId)
    this.snapshot.reviews = this.snapshot.reviews.filter(item => item.goalId !== goalId)
    this.snapshot.activities = this.snapshot.activities.filter(item => item.goalId !== goalId)
    this.snapshot.memories = this.snapshot.memories.filter(item => item.goalId !== goalId)
    this.snapshot.conversations = this.snapshot.conversations.filter(item => item.goalId !== goalId)
    this.snapshot.changeSets = this.snapshot.changeSets.filter(item => item.goalId !== goalId)
    this.persistAndEmit()
    return true
  }

  runGoalNow (goalId: string): ScheduledTaskRunReport {
    const goal = this.getGoalOrThrow(goalId)
    const scheduledGoal = this.ensureScheduledTask(goal)
    this.upsertGoal(scheduledGoal)
    this.persistAndEmit()
    if (!scheduledGoal.scheduleTaskId) throw new Error('长期目标缺少底层定时任务')
    return this.options.scheduledTaskService.runNow(scheduledGoal.scheduleTaskId)
  }

  async appendGoalMessage (goalId: string, content: string, onEvent?: (event: LongTermGoalStreamEvent) => void): Promise<LongTermGoalMessageResult> {
    const goal = this.getGoalOrThrow(goalId)
    const text = normalizeString(content)
    if (!text) throw new Error('请输入要调整的内容')
    return this.handleGoalConversation(goal, text, this.adjustmentSessions, '请输入要调整的内容', onEvent)
  }

  async createGoalViaConversation (content: string, options?: { providerId?: string | null; modelId?: string | null; selectedMcpServerIds?: string[] }, onEvent?: (event: LongTermGoalStreamEvent) => void): Promise<LongTermGoalMessageResult> {
    const text = normalizeString(content)
    if (!text) throw new Error('请输入要创建的目标')

    const draftGoal: LongTermGoalDefinition = {
      id: generateId('goal_draft'),
      title: '新长期目标',
      objective: text,
      status: 'paused',
      providerId: normalizeString(options?.providerId) || null,
      modelId: normalizeString(options?.modelId) || null,
      schedule: inferGoalSchedule(text),
      selectedSkillIds: [],
      selectedMcpServerIds: Array.isArray(options?.selectedMcpServerIds) ? options.selectedMcpServerIds : [],
      targetProjectIds: [],
      notificationPolicy: 'minimal',
      currentPhase: '目标定义中',
      progressSummary: '等待 AI 共同整理初始目标。',
      gapSummary: '尚未开始执行。',
      nextTasks: [],
      upcomingSchedule: [],
      openInterventions: [],
      createdAt: nowIso(),
      updatedAt: nowIso()
    }

    // Stash the draft goal on the creation session so applyGoalCreation can reuse its inferred
    // schedule/provider/model as fallback when the AI's proposal omits them.
    const existingCreationSession = this.creationSessions.get(draftGoal.id)
    if (existingCreationSession) {
      existingCreationSession.draftGoal = draftGoal
    } else {
      this.creationSessions.set(draftGoal.id, {
        phase: 'clarifying',
        contextTurns: [],
        lastAssistantTurnId: null,
        proposal: null,
        draftGoal
      })
    }

    const result = await this.handleGoalConversation(draftGoal, text, this.creationSessions, '请输入想创建的长期目标', onEvent)
    if (!result.proposal) {
      return result
    }

    // Do NOT persist the goal yet — the proposal is surfaced as a draft changeSet (already pushed
    // into snapshot.changeSets by handleGoalConversation) and requires user confirmation before
    // saving/scheduling. See applyGoalCreation / cancelGoalCreation.
    return result
  }

  private buildSaveInputFromProposal (proposal: GoalAdjustmentProposal, fallback: LongTermGoalDefinition): LongTermGoalSaveInput {
    const after = proposal.after || {}
    return {
      title: proposal.title || after.title || fallback.title,
      objective: proposal.objective || after.objective || fallback.objective,
      providerId: after.providerId ?? fallback.providerId,
      modelId: after.modelId ?? fallback.modelId,
      schedule: (after.schedule as LongTermGoalSchedule) || fallback.schedule,
      selectedSkillIds: Array.isArray(after.selectedSkillIds) ? after.selectedSkillIds as string[] : fallback.selectedSkillIds,
      selectedMcpServerIds: Array.isArray(after.selectedMcpServerIds) ? after.selectedMcpServerIds as string[] : fallback.selectedMcpServerIds,
      targetProjectIds: Array.isArray(after.targetProjectIds) ? after.targetProjectIds as string[] : fallback.targetProjectIds,
      notificationPolicy: (after.notificationPolicy as LongTermGoalDefinition['notificationPolicy']) || 'minimal',
      currentPhase: after.currentPhase || '持续推进',
      progressSummary: after.progressSummary || '目标已创建，等待首次自动推进。',
      gapSummary: after.gapSummary || '等待首次总结后生成差距分析。',
      todayFocus: after.todayFocus || undefined,
      nextTasks: Array.isArray(after.nextTasks) ? after.nextTasks as LongTermGoalNextTask[] : [],
      upcomingSchedule: Array.isArray(after.upcomingSchedule) ? after.upcomingSchedule as LongTermGoalScheduleSlot[] : [],
      openInterventions: Array.isArray(after.openInterventions) ? after.openInterventions as LongTermGoalIntervention[] : []
    }
  }

  private async handleGoalConversation (
    goal: LongTermGoalDefinition,
    latestUserText: string,
    sessions: Map<string, GoalConversationSession>,
    emptyHint: string,
    onEvent?: (event: LongTermGoalStreamEvent) => void
  ): Promise<LongTermGoalMessageResult> {
    const text = normalizeString(latestUserText)
    if (!text) throw new Error(emptyHint)

    const userTurn: LongTermGoalConversationTurn = {
      id: generateId('goal_turn'),
      goalId: goal.id,
      role: 'user',
      content: text,
      createdAt: nowIso(),
      appliedChangeId: null
    }
    this.snapshot.conversations.unshift(userTurn)

    const session = sessions.get(goal.id) || {
      phase: 'clarifying',
      contextTurns: [],
      lastAssistantTurnId: null,
      proposal: null
    }
    session.contextTurns.push(userTurn)

    const assistantResult = await this.generateGoalAdjustmentReply(goal, session, text, onEvent)
    if (assistantResult.proposal) {
      session.phase = 'proposal'
      session.proposal = assistantResult.proposal
    } else {
      session.phase = 'clarifying'
      session.proposal = null
    }
    sessions.set(goal.id, session)

    const assistantTurn: LongTermGoalConversationTurn = {
      id: generateId('goal_turn'),
      goalId: goal.id,
      role: 'assistant',
      content: assistantResult.content,
      thinking: assistantResult.thinking,
      toolRuns: assistantResult.toolRuns,
      createdAt: nowIso(),
      appliedChangeId: assistantResult.changeSet?.id || null
    }
    this.snapshot.conversations.unshift(assistantTurn)
    session.lastAssistantTurnId = assistantTurn.id
    session.contextTurns.push(assistantTurn)

    if (assistantResult.changeSet) {
      // For the create flow, drop any prior orphaned draft changeSets (each turn produces a new
      // draft goalId) so only the latest proposal awaits confirmation.
      if (goal.id.startsWith('goal_draft')) {
        this.snapshot.changeSets = this.snapshot.changeSets.filter(cs =>
          !(cs.goalId.startsWith('goal_draft') && cs.status === 'draft')
        )
      }
      this.snapshot.changeSets.unshift(assistantResult.changeSet)
    }

    if (!goal.id.startsWith('goal_draft')) {
      this.refreshExecutionBrief(goal.id)
    }
    this.trimCollections()
    this.persistAndEmit()

    return {
      turn: clone(userTurn),
      assistantTurn: clone(assistantTurn),
      changeSet: assistantResult.changeSet ? clone(assistantResult.changeSet) : null,
      goal: goal.id.startsWith('goal_draft') && assistantResult.proposal
        ? this.buildDraftGoalFromProposal(goal, assistantResult.proposal)
        : this.getGoal(goal.id)!,
      phase: assistantResult.phase,
      proposal: assistantResult.proposal ? clone(assistantResult.proposal) : null
    }
  }

  private buildDraftGoalFromProposal (
    draftGoal: LongTermGoalDefinition,
    proposal: GoalAdjustmentProposal
  ): LongTermGoalDefinition {
    const after = proposal.after || {}
    return {
      ...draftGoal,
      ...after,
      id: draftGoal.id,
      title: proposal.title || after.title || draftGoal.title,
      objective: proposal.objective || after.objective || draftGoal.objective,
      status: draftGoal.status,
      schedule: (after.schedule as LongTermGoalSchedule | undefined) || draftGoal.schedule,
      selectedSkillIds: Array.isArray(after.selectedSkillIds) ? after.selectedSkillIds : draftGoal.selectedSkillIds,
      selectedMcpServerIds: Array.isArray(after.selectedMcpServerIds) ? after.selectedMcpServerIds : draftGoal.selectedMcpServerIds,
      targetProjectIds: Array.isArray(after.targetProjectIds) ? after.targetProjectIds as string[] : draftGoal.targetProjectIds,
      nextTasks: Array.isArray(after.nextTasks) ? after.nextTasks as LongTermGoalNextTask[] : draftGoal.nextTasks,
      upcomingSchedule: Array.isArray(after.upcomingSchedule) ? after.upcomingSchedule as LongTermGoalScheduleSlot[] : draftGoal.upcomingSchedule,
      openInterventions: draftGoal.openInterventions,
      currentPhase: after.currentPhase || draftGoal.currentPhase,
      progressSummary: after.progressSummary || draftGoal.progressSummary,
      gapSummary: after.gapSummary || draftGoal.gapSummary,
      todayFocus: after.todayFocus || draftGoal.todayFocus,
      notificationPolicy: (after.notificationPolicy as LongTermGoalDefinition['notificationPolicy'] | undefined) || draftGoal.notificationPolicy,
      updatedAt: nowIso()
    }
  }

  private async generateGoalAdjustmentReply (
    goal: LongTermGoalDefinition,
    session: GoalConversationSession,
    latestUserText: string,
    onEvent?: (event: LongTermGoalStreamEvent) => void
  ): Promise<GoalAdjustmentReply> {
    const availableTools = this.options.aiEngine
      .getAvailableTools()
      .filter(tool => isGoalAdjustmentToolDefinition(tool, goal))
    let toolProposal: GoalAdjustmentProposal | null = null
    const customTools = this.createLongTermGoalTools(goal, {
      allowMutation: false,
      allowProposal: true,
      onProposal: proposal => {
        toolProposal = proposal
      }
    })
    const allowedToolNames = availableTools.map(tool => tool.name)
      .concat(customTools.map(tool => tool.definition.name))
    const allowedMcpServerIds = goal.selectedMcpServerIds.length > 0 ? goal.selectedMcpServerIds : undefined
    const activeSkillContents = this.resolveSkillContents(goal)
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          '你正在帮助用户调整一个长期目标。你的工作是通过多轮对话把目标收敛成更清晰、更可执行、更少打扰用户的新版本。',
          '你可以使用只读、检索、查询、分析类工具来理解当前环境、文件、文档、网页、数据库或上下文。',
          goal.targetProjectIds.length > 0
            ? `本目标已绑定项目，你可以用 write_project_file / patch_project_file / read_project_file / list_project_files / rebuild_project 修改这些绑定项目（project_id 传绑定的 id）：${goal.targetProjectIds.join(', ')}。需要时也可用 create_project 新建项目；如需把新项目绑定到本目标，必须把 targetProjectIds 放入 long_term_goal_propose_update 的 after，等待用户确认。`
            : '本目标未绑定项目。若推进目标需要代码项目，可用 create_project 新建；如需把新项目绑定到本目标，必须把 targetProjectIds 放入 long_term_goal_propose_update 的 after，等待用户确认。除此之外不要使用其它写入、执行、删除、启动、重启、构建、安装类工具。',
          '结构性重构绑定项目后，必须用 write_project_file 同步更新项目根的 README.md，描述架构与可被长期目标调用的数据接口（HTTP 路由 / DB 表 / 文件格式），方便长期目标执行时直接读用接口推数据而无需重建项目。',
          '长期目标执行时只做数据填入/修改，不重构项目；项目重构只在用户对话中完成。',
          '如果信息不够，就继续追问；如果信息足够，就输出一个最终提案，并明确让用户确认后再应用。',
          '当你准备修改目标本身时，必须先调用 long_term_goal_propose_update 生成待确认提案；不要只依赖正文或隐藏 JSON 来表达变更。',
          '用户确认前，目标不会被真正改动；正文里要明确告诉用户这是待确认变更。',
          '不要把原始 JSON 直接展示给用户，也不要在正文后附加 HTML 注释 JSON。',
          '正文应自然、简洁、像在和用户正常对话。',
          '需要时先思考，再调用工具，再给出结论。'
        ].join('\n')
      },
      {
        role: 'system',
        content: [
          '## 当前长期目标',
          `标题：${goal.title}`,
          `最终目标：${goal.objective}`,
          `状态：${goal.status}`,
          `执行供应商：${goal.providerId || '跟随全局'}`,
          `执行模型：${goal.modelId || '跟随供应商默认'}`,
          `当前阶段：${goal.currentPhase || '持续推进'}`,
          `当前进展：${goal.progressSummary || '暂无'}`,
          `当前差距：${goal.gapSummary || '暂无'}`,
          `节奏：${scheduleSummary(goal.schedule)}`,
          `今日重点：${goal.todayFocus || '未设置'}`
        ].join('\n')
      },
      {
        role: 'system',
        content: [
          '## 已有调整上下文',
          ...(session.contextTurns.slice(-6).map(turn => formatGoalAdjustmentConversationTurn(turn)))
        ].join('\n')
      },
      {
        role: 'user',
        content: latestUserText
      }
    ]

    const thinkingParts: string[] = []
    const contentParts: string[] = []
    const toolRuns: LongTermGoalRunToolRun[] = []
    let activeToolRun: LongTermGoalRunToolRun | null = null

    try {
    for await (const event of this.options.aiEngine.chatStream(messages, undefined, {
      providerConfig: this.options.resolveProviderConfig?.(goal.providerId, goal.modelId, 'max'),
      allowedToolNames: allowedToolNames.length > 0 ? allowedToolNames : undefined,
      allowedMcpServerIds,
      customTools,
      activeSkillContents: activeSkillContents.length > 0 ? activeSkillContents : undefined,
      systemPromptSections: [
        [
          '## Long-term goal adjustment mode',
          '- Think before you answer.',
          '- Use tools only when they help you verify or understand the goal.',
          '- Custom tools with the `long_term_goal_` prefix are long-term-goal-only tools.',
          '- In adjustment/create mode, call `long_term_goal_propose_update` once the proposal is ready. This tool is read-only and creates a pending change that the user must confirm before it applies.',
          '- Treat the current goal state from `long_term_goal_get_context` or the system-provided current goal as the source of truth. Do not let old conversation turns overwrite fields the user did not ask to change.',
          '- Keep the visible answer as markdown.',
          '- Do not hide JSON in HTML comments; use the long-term-goal tool for structured state.'
        ].join('\n')
      ]
    })) {
      // done 事件单独在下方转发剥离 JSON 后的最终正文，避免把原始元数据注释推给前端。
      if (event.type !== 'done') {
        onEvent?.(event as LongTermGoalStreamEvent)
      }

      if (event.type === 'thinking' && event.content) {
        thinkingParts.push(event.content)
        continue
      }

      if (event.type === 'token' && event.content) {
        contentParts.push(event.content)
        continue
      }

      if (event.type === 'tool_start' && event.name) {
        activeToolRun = {
          id: generateId('goal_tool'),
          name: event.name,
          status: 'running',
          progress: []
        }
        toolRuns.push(activeToolRun)
        continue
      }

      if (event.type === 'tool_end' && event.name) {
        const target = [...toolRuns].reverse().find(item => item.status === 'running' && item.name === event.name) ||
          activeToolRun ||
          toolRuns[toolRuns.length - 1] ||
          null
        if (target) {
          target.status = 'completed'
        }
        activeToolRun = [...toolRuns].reverse().find(item => item.status === 'running') || null
        continue
      }

      if (event.type === 'progress' && event.stage) {
        if (activeToolRun) {
          activeToolRun.progress.push({ stage: event.stage, detail: event.detail })
        }
        continue
      }

      if (event.type === 'web_search_result' && activeToolRun) {
        activeToolRun.progress.push({
          stage: 'web_search_result',
          detail: `${event.query} (${event.results.length} 条结果)`
        })
        continue
      }

      if (event.type === 'web_fetch_result' && activeToolRun) {
        activeToolRun.progress.push({
          stage: 'web_fetch_result',
          detail: event.result.title || event.result.url
        })
        continue
      }

      if (event.type === 'done') {
        if (event.thinking) {
          thinkingParts.push(event.thinking)
        }

        const rawText = typeof event.message.content === 'string'
          ? event.message.content
          : contentParts.join('')
        const proposal = toolProposal
        const content = formatGoalAdjustmentAssistantText(rawText, proposal)
        const changeSet = proposal ? buildGoalAdjustmentChangeSet(goal, proposal, session.lastAssistantTurnId || generateId('goal_turn')) : null

        onEvent?.({
          type: 'done',
          message: { role: 'assistant', content },
          thinking: thinkingParts.join('') || undefined
        })

        return {
          content,
          changeSet,
          proposal,
          phase: proposal ? 'proposal' : 'clarifying',
          thinking: thinkingParts.join('') || undefined,
          toolRuns: toolRuns.length > 0 ? clone(toolRuns) : undefined
        }
      }
    }
    } catch (err) {
      const errorMessage = (err as Error)?.message || '目标调整失败，请稍后重试。'
      onEvent?.({ type: 'error', error: errorMessage })
      return {
        content: errorMessage,
        changeSet: null,
        proposal: null,
        phase: 'clarifying',
        thinking: thinkingParts.join('') || undefined,
        toolRuns: toolRuns.length > 0 ? clone(toolRuns) : undefined
      }
    }

    const rawText = contentParts.join('')
    const proposal = toolProposal
    const content = formatGoalAdjustmentAssistantText(rawText, proposal)
    const changeSet = proposal ? buildGoalAdjustmentChangeSet(goal, proposal, session.lastAssistantTurnId || generateId('goal_turn')) : null
    return {
      content,
      changeSet,
      proposal,
      phase: proposal ? 'proposal' : 'clarifying',
      thinking: thinkingParts.join('') || undefined,
      toolRuns: toolRuns.length > 0 ? clone(toolRuns) : undefined
    }
  }

  applyChangeSet (changeSetId: string): LongTermGoalChangeSet {
    const changeSet = this.snapshot.changeSets.find(item => item.id === changeSetId)
    if (!changeSet) throw new Error('变更不存在')
    if (changeSet.status !== 'draft') return clone(changeSet)
    const goal = this.getGoalOrThrow(changeSet.goalId)
    const now = nowIso()
    const nextGoal = this.ensureScheduledTask({
      ...goal,
      ...changeSet.after,
      updatedAt: now
    } as LongTermGoalDefinition)
    this.upsertGoal(nextGoal)
    changeSet.status = 'applied'
    changeSet.appliedAt = now
    this.addActivity({
      goalId: goal.id,
      actor: 'user',
      type: 'goal_changed',
      title: '已应用目标调整',
      summary: changeSet.summary,
      details: JSON.stringify(changeSet.after, null, 2)
    })
    this.writeMemory(goal.id, {
      kind: 'decision',
      title: '用户确认的目标调整',
      content: changeSet.summary,
      importance: 0.82
    })
    this.refreshExecutionBrief(goal.id)
    this.persistAndEmit()
    return clone(changeSet)
  }

  cancelChangeSet (changeSetId: string): LongTermGoalChangeSet {
    const changeSet = this.snapshot.changeSets.find(item => item.id === changeSetId)
    if (!changeSet) throw new Error('变更不存在')
    changeSet.status = 'cancelled'
    this.persistAndEmit()
    return clone(changeSet)
  }

  applyGoalCreation (changeSetId: string): LongTermGoalDefinition {
    const changeSet = this.snapshot.changeSets.find(item => item.id === changeSetId)
    if (!changeSet) throw new Error('变更不存在')
    if (changeSet.status !== 'draft') throw new Error('变更已处理')
    const session = this.creationSessions.get(changeSet.goalId)
    const proposal = session?.proposal
    const draftGoal = session?.draftGoal
    if (!proposal || !draftGoal) {
      throw new Error('创建会话已过期，请重新发起目标创建')
    }
    // saveGoal defaults status to 'active' and schedules the first run via ensureScheduledTask.
    const savedGoal = this.saveGoal(this.buildSaveInputFromProposal(proposal, draftGoal))
    const now = nowIso()
    // Re-parent the changeSet + conversation turns from the draft goalId to the saved goal id.
    this.snapshot.changeSets = this.snapshot.changeSets.map(cs =>
      cs.id === changeSetId ? { ...cs, goalId: savedGoal.id, status: 'applied', appliedAt: now } : cs
    )
    this.snapshot.conversations = this.snapshot.conversations.map(turn =>
      turn.goalId === changeSet.goalId ? { ...turn, goalId: savedGoal.id } : turn
    )
    this.creationSessions.delete(changeSet.goalId)
    this.adjustmentSessions.delete(changeSet.goalId)
    this.refreshExecutionBrief(savedGoal.id)
    this.persistAndEmit()
    return clone(savedGoal)
  }

  cancelGoalCreation (changeSetId: string): void {
    const changeSet = this.snapshot.changeSets.find(item => item.id === changeSetId)
    if (!changeSet) return
    this.snapshot.changeSets = this.snapshot.changeSets.filter(cs => cs.id !== changeSetId)
    this.creationSessions.delete(changeSet.goalId)
    this.adjustmentSessions.delete(changeSet.goalId)
    this.persistAndEmit()
  }

  answerIntervention (
    goalId: string,
    interventionId: string,
    answers: Array<{ questionId: string; selectedOption?: string | null; customAnswer?: string | null }>,
    onEvent?: (event: LongTermGoalStreamEvent) => void
  ): LongTermGoalDefinition {
    const goal = this.getGoalOrThrow(goalId)
    const intervention = goal.openInterventions.find(item => item.id === interventionId)
    if (!intervention) return clone(goal)
    const answerText = answers
      .map(answer => {
        const question = intervention.questions.find(item => item.id === answer.questionId)
        const response = normalizeString(answer.customAnswer) || normalizeString(answer.selectedOption)
        return response ? `${question?.question || answer.questionId}: ${response}` : ''
      })
      .filter(Boolean)
      .join('\n')

    const nextGoal = {
      ...goal,
      openInterventions: goal.openInterventions.filter(item => item.id !== interventionId),
      updatedAt: nowIso()
    }
    this.upsertGoal(nextGoal)
    this.addActivity({
      goalId,
      actor: 'user',
      type: 'user_decision',
      title: '用户处理了干预项',
      summary: intervention.title,
      details: answerText || intervention.summary
    })
    if (answerText) {
      this.writeMemory(goalId, {
        kind: 'decision',
        title: intervention.title,
        content: answerText,
        importance: 0.86
      })
      this.snapshot.conversations.unshift({
        id: generateId('goal_turn'),
        goalId,
        role: 'user',
        content: answerText,
        createdAt: nowIso(),
        appliedChangeId: null
      })
    }
    this.refreshExecutionBrief(goalId)
    this.persistAndEmit()
    // 用户回答后立即触发轻量重规划（不执行工作），更新下次执行时间/时间表/目标。
    void this.replanGoal(goalId, 'intervention_answered', onEvent)
    return this.getGoal(goalId)!
  }

  private buildReplanPrompt (goal: LongTermGoalDefinition, triggerReason: string): string {
    const recentActivities = this.snapshot.activities
      .filter(item => item.goalId === goal.id)
      .slice(0, RECENT_CONTEXT_LIMIT)
      .map(item => `- ${item.createdAt}: ${item.title} — ${item.summary}`)
      .join('\n')
    const recentConversation = this.snapshot.conversations
      .filter(item => item.goalId === goal.id)
      .slice(0, 6)
      .reverse()
      .map(item => `${item.role === 'user' ? '用户' : 'AI'}: ${item.content}`)
      .join('\n')
    const nextTasksText = goal.nextTasks
      .filter(item => item.status !== 'done' && item.status !== 'skipped')
      .slice(0, 8)
      .map(item => `- ${item.title}${item.reason ? `（${item.reason}）` : ''}`)
      .join('\n')
    return [
      `${LONG_TERM_GOAL_TASK_MARKER} ${goal.id}`,
      '你正在对长期目标做一次轻量重规划。不要执行任何实际工作（不写代码、不调用写入/构建工具），只根据最新上下文重新决定执行安排。',
      `触发原因：${triggerReason}`,
      '',
      '## 目标',
      `名称：${goal.title}`,
      `目标：${goal.objective}`,
      `当前阶段：${goal.currentPhase || '持续推进'}`,
      `今日重点：${goal.todayFocus || '未设置'}`,
      `当前进展：${goal.progressSummary || '暂无'}`,
      `当前差距：${goal.gapSummary || '暂无'}`,
      `执行节奏：${scheduleSummary(goal.schedule)}`,
      `当前下次执行时间：${goal.nextRunAt || '未安排'}`,
      '',
      '## 当前下一步任务',
      nextTasksText || '暂无',
      '',
      '## 用户最近的对话/决定',
      recentConversation || '暂无',
      '',
      '## 最近执行履历',
      recentActivities || '暂无',
      '',
      '## 绑定项目接口说明（README.md）',
      this.getProjectReadmeSection(goal) || '（暂无）',
      '',
      '## 要求',
      '- 结合用户刚才的回答与最新进展，重新判断：下一次什么时候执行、未来 24h 怎么安排、下一步任务列表是否需要调整。',
      '- 不要执行工作；只输出新的执行安排。',
      '- 必须调用 long_term_goal_update_schedule 写入 nextRunAt、upcomingSchedule、nextTasks 和可选 objective/today_focus/current_phase。',
      '- 正文给用户看一句话总结（Markdown），不要展示 JSON，也不要附加 HTML 注释。'
    ].join('\n')
  }

  /**
   * 轻量重规划：用只读工具白名单 + 技能内容跑一次 AI，解析元数据后直接更新 goal 的
   * nextRunAt/upcomingSchedule/nextTasks/可选 patch，并推 nextRunAt 到调度器。不执行实际工作。
   */
  async replanGoal (
    goalId: string,
    triggerReason: string,
    onEvent?: (event: LongTermGoalStreamEvent) => void
  ): Promise<LongTermGoalReplanResult | null> {
    const goal = this.getGoalOrThrow(goalId)
    const prompt = this.buildReplanPrompt(goal, triggerReason)
    // 重规划只读：放行只读/检索/查询类工具 + 项目只读工具，排除 create_project 与写入/构建工具。
    const replanReadOnlyTools = new Set(['read_project_file', 'list_project_files', 'read_file'])
    const availableTools = this.options.aiEngine
      .getAvailableTools()
      .filter(tool => isGoalAdjustmentToolDefinition(tool, goal))
      .filter(tool => tool.name !== 'create_project'
        && !['write_project_file', 'patch_project_file', 'rebuild_project'].includes(tool.name)
        && (!GOAL_ADJUSTMENT_PROJECT_TOOLS.has(tool.name) || replanReadOnlyTools.has(tool.name)))
    const replanState: { result: LongTermGoalReplanResult | null } = { result: null }
    const customTools = this.createLongTermGoalTools(goal, {
      allowMutation: true,
      onScheduleUpdate: result => {
        replanState.result = result
      }
    })
    const allowedToolNames = availableTools.map(tool => tool.name)
      .concat(customTools.map(tool => tool.definition.name))
    const activeSkillContents = this.resolveSkillContents(goal)
    const contentParts: string[] = []
    const thinkingParts: string[] = []
    try {
      for await (const event of this.options.aiEngine.chatStream([{ role: 'user', content: prompt }], undefined, {
        providerConfig: this.options.resolveProviderConfig?.(goal.providerId, goal.modelId, 'high'),
        allowedToolNames: allowedToolNames.length > 0 ? allowedToolNames : undefined,
        allowedMcpServerIds: goal.selectedMcpServerIds.length > 0 ? goal.selectedMcpServerIds : undefined,
        customTools,
        activeSkillContents: activeSkillContents.length > 0 ? activeSkillContents : undefined,
        systemPromptSections: [
          [
            '## Long-term goal replan mode',
            '- 只读分析，不要执行写入/构建/创建类工具。',
            '- 必须使用 `long_term_goal_update_schedule` 直接同步 nextRunAt、未来 24h 安排和下一步任务；这是长期目标专属工具，不属于普通项目工具。',
            '- 结合用户最新回答重新决定执行安排。',
            '- 正文一句话总结，不要输出 JSON 元数据或 HTML 注释。'
          ].join('\n')
        ]
      })) {
        if (event.type !== 'done') onEvent?.(event as LongTermGoalStreamEvent)
        if (event.type === 'thinking' && event.content) { thinkingParts.push(event.content); continue }
        if (event.type === 'token' && event.content) { contentParts.push(event.content); continue }
        if (event.type === 'done') {
          const rawText = typeof event.message.content === 'string' ? event.message.content : contentParts.join('')
          const result = replanState.result
          onEvent?.({ type: 'done', message: { role: 'assistant', content: stripGoalMetadataForDisplay(rawText) || result?.summary || '重规划完成。' } })
          return result
        }
      }
    } catch (err) {
      const errorMessage = (err as Error)?.message || '重规划失败。'
      onEvent?.({ type: 'error', error: errorMessage })
    }
    return null
  }

  private applyReplanResult (goalId: string, result: LongTermGoalReplanResult): void {
    const goal = this.getGoalOrThrow(goalId)
    const nextTasks = this.buildNextTasks(goal, result.nextTasks)
    const nextRunAt = result.nextRunAt || fallbackNextRunAtFromSchedule(goal.schedule)
    const upcomingSchedule = this.buildUpcomingSchedule(result.upcomingSchedule, nextTasks, nextRunAt)
    const patched: LongTermGoalDefinition = {
      ...goal,
      nextTasks,
      upcomingSchedule,
      nextRunAt,
      objective: result.goalPatch?.objective || goal.objective,
      todayFocus: result.goalPatch?.todayFocus || goal.todayFocus,
      currentPhase: result.goalPatch?.currentPhase || goal.currentPhase,
      updatedAt: nowIso()
    }
    const scheduled = this.ensureScheduledTask(patched)
    this.upsertGoal(scheduled)
    this.addActivity({
      goalId,
      actor: 'ai',
      type: 'replan',
      title: '已根据用户回答重规划',
      summary: result.summary
    })
    this.refreshExecutionBrief(goalId)
    this.persistAndEmit()
  }

  resolveScheduledTaskPrompt (task: ScheduledTaskDefinition): string | undefined {
    const goal = this.snapshot.goals.find(item => item.scheduleTaskId === task.id || item.reviewScheduleTaskId === task.id)
    if (!goal) return undefined
    return task.id === goal.reviewScheduleTaskId ? this.buildDailyReviewPrompt(goal) : this.buildExecutionPrompt(goal)
  }

  /** 定时执行时把 goal 绑定的首个项目作为 targetProjectId 传给 AI，使 write_project_file
   *  等工具定向到绑定项目而非新建项目。每日复盘任务不需绑定（只总结不写代码）。 */
  resolveScheduledTaskOptions (task: ScheduledTaskDefinition): { targetProjectId?: string | null; workspaceRoot?: string | null; customTools?: CustomToolRegistration[]; systemPromptSections?: string[] } | undefined {
    const goal = this.snapshot.goals.find(item => item.scheduleTaskId === task.id || item.reviewScheduleTaskId === task.id)
    if (!goal) return undefined
    const isExecutionTask = task.id === goal.scheduleTaskId
    const targetProjectId = isExecutionTask ? goal.targetProjectIds[0] : null
    return {
      targetProjectId: targetProjectId || null,
      workspaceRoot: null,
      customTools: this.createLongTermGoalTools(goal, {
        allowMutation: true,
        allowRunResult: true,
        runResultKey: task.id
      }),
      systemPromptSections: [
        [
          '## Long-term goal custom tools',
          '- Tools whose names start with `long_term_goal_` are only available in long-term goal mode.',
          '- Prefer `long_term_goal_update_schedule` when you decide the next execution time, future 24h schedule preview, or next task queue should change.',
          '- Before your final visible markdown report, call `long_term_goal_record_run_result` to record progress, gap analysis, next tasks, notification level, memory updates, and user questions.',
          '- Do not encode long-term-goal state changes in hidden JSON or HTML comments.'
        ].join('\n')
      ]
    }
  }

  shouldNotifyScheduledReport (report: ScheduledTaskRunReport): boolean | undefined {
    const goal = this.snapshot.goals.find(item => item.scheduleTaskId === report.taskId || item.reviewScheduleTaskId === report.taskId)
    if (!goal) return undefined
    if (report.status === 'failed') return true
    if (goal.notificationPolicy === 'normal') return true
    const result = this.peekRunResult(report.taskId) || buildFallbackGoalRunResult(report.resultText || '', goal.title)
    return result.notificationLevel === 'notify' || result.needsUserInput || result.blockers.length > 0
  }

  private peekRunResult (taskId: string): ParsedGoalRunResult | null {
    const result = this.pendingRunResults.get(taskId)
    return result ? clone(result) : null
  }

  private consumeRunResult (taskId: string): ParsedGoalRunResult | null {
    const result = this.pendingRunResults.get(taskId)
    if (!result) return null
    this.pendingRunResults.delete(taskId)
    return clone(result)
  }

  reconcileScheduledReports (reports: ScheduledTaskRunReport[]): void {
    let changed = false
    for (const report of reports) {
      const goal = this.snapshot.goals.find(item => item.scheduleTaskId === report.taskId || item.reviewScheduleTaskId === report.taskId)
      if (!goal) continue
      const existingRun = this.snapshot.runs.find(item => item.scheduledReportId === report.id)
      if (existingRun?.status === 'completed' || existingRun?.status === 'failed') continue

      if (report.status === 'running' || report.status === 'retrying') {
        const runId = existingRun?.id || generateId('goal_run')
        this.upsertRun({
          id: runId,
          goalId: goal.id,
          scheduledReportId: report.id,
          status: 'running',
          startedAt: report.startedAt,
          finishedAt: null,
          progressSummary: reportProgressSummary(report),
          gapToGoal: existingRun?.gapToGoal || '',
          resultText: report.resultText || existingRun?.resultText,
          thinkingText: report.thinkingText || existingRun?.thinkingText,
          progress: report.progress || [],
          toolRuns: buildRunToolRuns(report),
          notificationLevel: 'silent',
          createdAt: existingRun?.createdAt || report.startedAt,
          updatedAt: report.updatedAt || nowIso()
        })
        if (!existingRun) {
          this.addActivity({
            goalId: goal.id,
            runId,
            actor: 'system',
            type: 'run_started',
            title: '自动执行开始',
            summary: report.trigger === 'manual' ? '用户手动启动了长期目标。' : '长期目标按计划自动开始执行。'
          })
        }
        this.upsertGoal({
          ...goal,
          lastRunStatus: 'running',
          currentPhase: reportProgressSummary(report),
          updatedAt: nowIso()
        })
        const progressedRun = this.snapshot.runs.find(item => item.id === runId)
        if (progressedRun) {
          this.options.onRunProgress?.(goal.id, progressedRun)
        }
        changed = true
        continue
      }

      if (report.status === 'completed') {
        this.finishCompletedReport(goal, report, existingRun)
        const finishedRun = this.snapshot.runs.find(item => item.scheduledReportId === report.id)
        if (finishedRun) {
          this.options.onRunProgress?.(goal.id, finishedRun)
        }
        changed = true
        continue
      }

      if (report.status === 'failed') {
        this.finishFailedReport(goal, report, existingRun)
        const failedRun = this.snapshot.runs.find(item => item.scheduledReportId === report.id)
        if (failedRun) {
          this.options.onRunProgress?.(goal.id, failedRun)
        }
        changed = true
      }
    }

    if (changed) {
      this.trimCollections()
      this.persistAndEmit()
    } else {
      this.syncGoalsFromScheduledTasks()
    }
  }

  private finishCompletedReport (goal: LongTermGoalDefinition, report: ScheduledTaskRunReport, existingRun?: LongTermGoalRun): void {
    const parsed = this.consumeRunResult(report.taskId) || buildFallbackGoalRunResult(report.resultText || report.summary, goal.title)
    const displayResultText = stripGoalMetadataForDisplay(report.resultText || report.summary)
    const finishedAt = report.finishedAt || nowIso()
    const runId = existingRun?.id || generateId('goal_run')
    const run: LongTermGoalRun = {
      id: runId,
      goalId: goal.id,
      scheduledReportId: report.id,
      status: 'completed',
      startedAt: report.startedAt,
      finishedAt,
      progressSummary: parsed.progressSummary,
      gapToGoal: parsed.gapToGoal,
      resultText: displayResultText || report.summary,
      thinkingText: report.thinkingText || existingRun?.thinkingText,
      progress: report.progress || existingRun?.progress || [],
      toolRuns: buildRunToolRuns(report),
      notificationLevel: parsed.notificationLevel,
      createdAt: existingRun?.createdAt || report.startedAt,
      updatedAt: nowIso()
    }
    this.upsertRun(run)

    const nextTasks = this.buildNextTasks(goal, parsed.nextPlan)
    const intervention = this.buildIntervention(goal.id, parsed)
    if (!parsed.nextRunAt) {
      console.warn(`[long-term-goal-service] Goal "${goal.title}" run did not emit nextRunAt metadata; falling back to schedule-derived time.`)
    }
    const nextRunAt = parsed.nextRunAt || fallbackNextRunAtFromSchedule(goal.schedule)
    const upcomingSchedule = this.buildUpcomingSchedule(parsed.upcomingSchedule, nextTasks, nextRunAt)
    // 自动绑定本次新建的项目（执行流里 create_project 建后不自动绑定，这里补上）。
    const createdProjectIds = this.detectCreatedProjectIds(buildRunToolRuns(report), parsed.bindProjectIds)
    const withProjects = this.bindCreatedProjects(goal, createdProjectIds)
    const baseGoal: LongTermGoalDefinition = withProjects ?? goal
    const updatedGoal: LongTermGoalDefinition = {
      ...baseGoal,
      lastRunAt: finishedAt,
      lastReviewAt: finishedAt,
      lastRunStatus: 'completed',
      progressSummary: parsed.progressSummary,
      gapSummary: parsed.gapToGoal,
      currentPhase: parsed.blockers.length > 0 ? '等待处理阻塞' : (baseGoal.currentPhase || '持续推进'),
      nextTasks,
      upcomingSchedule,
      nextRunAt,
      openInterventions: intervention
        ? [intervention, ...baseGoal.openInterventions.filter(item => item.status === 'open')]
        : baseGoal.openInterventions,
      updatedAt: nowIso()
    }
    const scheduledGoal = this.ensureScheduledTask(updatedGoal)
    this.upsertGoal(scheduledGoal)
    if (withProjects) {
      for (const pid of createdProjectIds) {
        this.addActivity({
          goalId: goal.id,
          runId,
          actor: 'ai',
          type: 'project_bound',
          title: '已自动绑定新项目',
          summary: pid
        })
      }
    }

    const review: LongTermGoalDailyReview = {
      id: generateId('goal_review'),
      goalId: goal.id,
      date: dateKeyFromIso(finishedAt),
      runId,
      progressSummary: parsed.progressSummary,
      gapAnalysis: parsed.gapToGoal,
      nextPlan: parsed.nextPlan,
      blockers: parsed.blockers,
      notificationLevel: parsed.notificationLevel,
      needsUserInput: parsed.needsUserInput || parsed.userQuestions.length > 0,
      createdAt: finishedAt,
      updatedAt: nowIso()
    }
    this.snapshot.reviews.unshift(review)

    this.addActivity({
      goalId: goal.id,
      runId,
      actor: 'ai',
      type: 'task_completed',
      title: '本次执行完成',
      summary: parsed.progressSummary,
      details: displayResultText || report.summary,
      artifacts: [{ kind: 'report', title: report.taskTitle, ref: report.id }]
    })
    this.addActivity({
      goalId: goal.id,
      runId,
      actor: 'ai',
      type: 'gap_found',
      title: '目标差距已更新',
      summary: parsed.gapToGoal
    })
    if (parsed.nextPlan.length > 0) {
      this.addActivity({
        goalId: goal.id,
        runId,
        actor: 'ai',
        type: 'plan_updated',
        title: '下一步计划已更新',
        summary: parsed.nextPlan.slice(0, 3).join('；')
      })
    }
    this.addActivity({
      goalId: goal.id,
      runId,
      actor: 'ai',
      type: 'review_completed',
      title: '每日总结已生成',
      summary: `${parsed.progressSummary}\n差距：${parsed.gapToGoal}`
    })

    for (const item of parsed.importantAchievements) {
      this.writeMemory(goal.id, {
        kind: 'achievement',
        title: '重要成果',
        content: item,
        importance: 0.82,
        sourceRunId: runId
      })
    }
    for (const item of parsed.learnedSkills) {
      this.writeMemory(goal.id, {
        kind: 'skill',
        title: '学到的技能或方法',
        content: item,
        importance: 0.78,
        sourceRunId: runId
      })
    }
    for (const item of parsed.memoryUpdates) {
      this.writeMemory(goal.id, {
        kind: item.kind || 'progress_summary',
        title: item.title,
        content: item.content,
        importance: item.importance ?? 0.6,
        sourceRunId: runId
      })
    }
    this.writeMemory(goal.id, {
      kind: 'daily_review',
      title: `${review.date} 每日总结`,
      content: `进展：${review.progressSummary}\n差距：${review.gapAnalysis}\n下一步：${review.nextPlan.join('；') || '继续推进'}`,
      importance: review.needsUserInput ? 0.86 : 0.68,
      sourceRunId: runId
    })
    if (intervention) {
      this.options.onInterventionRequested?.(scheduledGoal, intervention)
    }
    this.refreshExecutionBrief(goal.id)
    this.compactGoalMemory(goal.id)
  }

  private finishFailedReport (goal: LongTermGoalDefinition, report: ScheduledTaskRunReport, existingRun?: LongTermGoalRun): void {
    this.pendingRunResults.delete(report.taskId)
    const finishedAt = report.finishedAt || nowIso()
    const runId = existingRun?.id || generateId('goal_run')
    const summary = compactText(report.error || report.summary || '长期目标执行失败。', 360)
    this.upsertRun({
      id: runId,
      goalId: goal.id,
      scheduledReportId: report.id,
      status: 'failed',
      startedAt: report.startedAt,
      finishedAt,
      progressSummary: summary,
      gapToGoal: '执行失败，需要处理失败原因后继续。',
      resultText: report.resultText,
      thinkingText: report.thinkingText || existingRun?.thinkingText,
      progress: report.progress || existingRun?.progress || [],
      toolRuns: buildRunToolRuns(report),
      error: report.error || report.summary,
      notificationLevel: 'notify',
      createdAt: existingRun?.createdAt || report.startedAt,
      updatedAt: nowIso()
    })
    const intervention = this.createIntervention(goal.id, {
      severity: 'blocked',
      title: '长期目标执行失败',
      summary,
      questions: [{
        id: generateId('goal_question'),
        question: '是否需要调整目标、执行环境或稍后重试？',
        options: ['稍后重试', '调整目标', '暂停这个目标'],
        reason: '连续失败会阻断后续自动推进。'
      }]
    })
    const updatedGoal: LongTermGoalDefinition = {
      ...goal,
      lastRunAt: finishedAt,
      lastRunStatus: 'failed',
      currentPhase: '遇到阻塞',
      gapSummary: summary,
      nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      // 失败时清空过期的 ai 时间表槽位，保留未来项。
      upcomingSchedule: goal.upcomingSchedule.filter(slot => Date.parse(slot.at) > Date.now()),
      openInterventions: [intervention, ...goal.openInterventions],
      updatedAt: nowIso()
    }
    this.upsertGoal(this.ensureScheduledTask(updatedGoal))
    this.addActivity({
      goalId: goal.id,
      runId,
      actor: 'system',
      type: 'blocked',
      title: '执行失败，需要用户处理',
      summary,
      details: report.error
    })
    this.writeMemory(goal.id, {
      kind: 'blocker',
      title: '执行失败',
      content: summary,
      importance: 0.9,
      sourceRunId: runId
    })
    this.refreshExecutionBrief(goal.id)
    this.options.onInterventionRequested?.(goal, intervention)
  }

  private buildExecutionPrompt (goal: LongTermGoalDefinition): string {
    const executionBrief = this.snapshot.memories.find(item => item.goalId === goal.id && item.kind === 'execution_brief')
    const executionBriefContent = executionBrief?.content || this.buildExecutionBrief(goal)
    const recentReviews = this.snapshot.reviews
      .filter(item => item.goalId === goal.id)
      .slice(0, RECENT_CONTEXT_LIMIT)
      .map(item => `- ${item.date}: 进展=${item.progressSummary}; 差距=${item.gapAnalysis}; 下一步=${item.nextPlan.join(' / ') || '无'}`)
      .join('\n')
    const recentActivities = this.snapshot.activities
      .filter(item => item.goalId === goal.id)
      .slice(0, RECENT_CONTEXT_LIMIT)
      .map(item => `- ${item.createdAt}: ${item.title} — ${item.summary}`)
      .join('\n')
    const recentConversation = this.snapshot.conversations
      .filter(item => item.goalId === goal.id)
      .slice(0, 6)
      .reverse()
      .map(item => `${item.role === 'user' ? '用户' : 'AI'}: ${item.content}`)
      .join('\n')
    const memories = this.snapshot.memories
      .filter(item => item.goalId === goal.id)
      .filter(item => item.kind !== 'execution_brief')
      .sort((left, right) => {
        if (right.importance !== left.importance) return right.importance - left.importance
        return right.updatedAt.localeCompare(left.updatedAt)
      })
      .slice(0, 10)
      .map(item => `- [${item.kind}] ${item.title}: ${compactText(item.content, 260)}`)
      .join('\n')

    return [
      `${LONG_TERM_GOAL_TASK_MARKER} ${goal.id}`,
      '你正在执行一个长期目标。你的职责是安静推进目标，并在每天自动总结进度、归纳距离目标的差距、规划接下来的任务。',
      '除非遇到困难、需要授权、需要用户做方向性决定、或达成重要里程碑，否则不要要求通知用户。',
      '',
      '## 目标',
      `名称：${goal.title}`,
      `目标：${goal.objective}`,
      `当前阶段：${goal.currentPhase || '持续推进'}`,
      `今日重点：${goal.todayFocus || '根据目标和长期记忆自行选择最有价值的下一步'}`,
      `当前进展：${goal.progressSummary || '暂无'}`,
      `当前差距：${goal.gapSummary || '暂无'}`,
      `执行节奏：${scheduleSummary(goal.schedule)}`,
      '',
      '## 执行记忆包（每次执行必须优先读取）',
      executionBriefContent,
      '',
      '## 长期目标记忆',
      memories || '暂无长期记忆。',
      '',
      '## 最近每日总结',
      recentReviews || '暂无每日总结。',
      '',
      '## 最近执行履历',
      recentActivities || '暂无执行履历。',
      '',
      '## 用户最近的快速调整/对话',
      recentConversation || '暂无用户补充。',
      '',
      '## 绑定项目',
      goal.targetProjectIds.length > 0
        ? `本目标已绑定以下项目，优先用 README 描述的接口推入/修改数据，不要重建项目（结构性重构只在用户对话中完成）。需要查看现状用 read_project_file / list_project_files，需要重建时用 rebuild_project：\n${goal.targetProjectIds.map(id => `- ${id}`).join('\n')}`
        : '本目标未绑定项目。若推进目标需要代码项目，可用 create_project 新建（建后会自动绑定到本目标，便于后续持续修改）。',
      '',
      '## 绑定项目接口说明（README.md）',
      this.getProjectReadmeSection(goal) || '（暂无；若已绑定项目，请在调整对话里用 write_project_file 写一份 README.md，描述架构与可调用的数据接口，方便执行时直接用接口推数据。）',
      '',
      '## 本次要求',
      '- 先判断离目标最近的有效下一步，然后推进实际任务。',
      '- 必须利用执行记忆包，避免重复做已经完成的工作，并沿用已验证有效的方法。',
      '- 优先通过 README.md 描述的接口推入/修改数据，避免重建项目；只在接口确实不够时才用 rebuild_project。',
      '- 完成后总结今天干了什么、正在推进什么、接下来要做什么。',
      '- 把本次产生的关键成果写入 importantAchievements；把可复用方法、工具使用经验、项目约束、踩坑结论写入 learnedSkills。',
      '- 明确指出距离目标还有哪些差距。',
      '- 自己决定下一次持续推进应该在什么时候运行，把 ISO 时间写入 nextRunAt。不要让用户手动设置频率；如果目标需要更密集推进就安排更近，如果等待外部条件就安排更远。',
      '- 给出未来 24 小时的执行时间表 upcomingSchedule（按时间顺序，每项含 at/title/reason），让用户能预览接下来的执行安排。',
      '- 如果可用，优先调用 long_term_goal_update_schedule 同步 nextRunAt、upcomingSchedule 和 nextTasks；这是长期目标专属工具，和普通项目工具不同。',
      '- 若本次新建了项目，把新建项目 id 写入 bindProjectIds，系统会自动绑定到本目标。',
      '- 只有需要用户决定、授权、补信息、或遇到阻塞时，才把 needsUserInput 设为 true 或 notificationLevel 设为 notify。',
      '- 在最终 Markdown 报告前，必须调用 long_term_goal_record_run_result 记录 progressSummary、gapToGoal、nextPlan、completedItems、importantAchievements、learnedSkills、blockers、nextRunAt、upcomingSchedule、bindProjectIds、needsUserInput、userQuestions、notificationLevel、memoryUpdates。',
      '- 正文输出给用户看的 Markdown 报告，重点写本次真实推进过程、结论、差距和下一步；不要输出 JSON，也不要附加 HTML 注释。'
    ].join('\n')
  }

  private buildDailyReviewPrompt (goal: LongTermGoalDefinition): string {
    const executionBrief = this.snapshot.memories.find(item => item.goalId === goal.id && item.kind === 'execution_brief')
    const executionBriefContent = executionBrief?.content || this.buildExecutionBrief(goal)
    const recentRuns = this.snapshot.runs
      .filter(item => item.goalId === goal.id)
      .slice(0, RECENT_CONTEXT_LIMIT)
      .map(item => `- ${item.startedAt}: ${item.progressSummary}; 差距=${item.gapToGoal}; 状态=${item.status}`)
      .join('\n')
    const recentReviews = this.snapshot.reviews
      .filter(item => item.goalId === goal.id)
      .slice(0, RECENT_CONTEXT_LIMIT)
      .map(item => `- ${item.date}: 进展=${item.progressSummary}; 差距=${item.gapAnalysis}; 下一步=${item.nextPlan.join(' / ') || '无'}`)
      .join('\n')
    const memories = this.snapshot.memories
      .filter(item => item.goalId === goal.id)
      .filter(item => item.kind !== 'execution_brief')
      .sort((left, right) => {
        if (right.importance !== left.importance) return right.importance - left.importance
        return right.updatedAt.localeCompare(left.updatedAt)
      })
      .slice(0, 10)
      .map(item => `- [${item.kind}] ${item.title}: ${compactText(item.content, 260)}`)
      .join('\n')

    return [
      `${LONG_TERM_GOAL_REVIEW_MARKER} ${goal.id}`,
      '你正在做长期目标的每日复盘。不要执行重型任务；只总结进度、归纳距离目标的差距、规划接下来的任务，并判断是否真的需要用户介入。',
      '除非阻塞、失败、授权、方向性决定或关键里程碑，不要通知用户。',
      '',
      '## 目标',
      `名称：${goal.title}`,
      `目标：${goal.objective}`,
      `当前阶段：${goal.currentPhase || '持续推进'}`,
      `当前进展：${goal.progressSummary || '暂无'}`,
      `当前差距：${goal.gapSummary || '暂无'}`,
      '',
      '## 执行记忆包（复盘时必须优先更新）',
      executionBriefContent,
      '',
      '## 最近执行',
      recentRuns || '今天没有新的执行记录。',
      '',
      '## 最近每日总结',
      recentReviews || '暂无每日总结。',
      '',
      '## 长期记忆',
      memories || '暂无长期记忆。',
      '',
      '如果可用，优先调用 long_term_goal_update_schedule 同步 nextRunAt、upcomingSchedule 和 nextTasks；这是长期目标专属工具，和普通项目工具不同。',
      '请根据今天进展刷新关键成果、技能方法和下一步计划，避免重复推进已经完成的事，并自行决定下一次推进时间 nextRunAt。',
      '在最终 Markdown 复盘前，必须调用 long_term_goal_record_run_result 记录 progressSummary、gapToGoal、nextPlan、completedItems、importantAchievements、learnedSkills、blockers、nextRunAt、upcomingSchedule、needsUserInput、userQuestions、notificationLevel、memoryUpdates。',
      '最终只输出给用户看的 Markdown 每日复盘；不要输出 JSON，也不要附加 HTML 注释。'
    ].join('\n')
  }

  private ensureScheduledTask (goal: LongTermGoalDefinition): LongTermGoalDefinition {
    const now = nowIso()
    const enabled = goal.status === 'active'
    // 绑定项目变化时刷新 README 缓存（fire-and-forget），供下次执行 prompt 读取。
    void this.refreshProjectReadmeCache(goal)
    const tasks = this.options.scheduledTaskService.listTasks({ includeHidden: true })
    const existingTask = goal.scheduleTaskId
      ? tasks.find(task => task.id === goal.scheduleTaskId)
      : null
    const existingReviewTask = goal.reviewScheduleTaskId
      ? tasks.find(task => task.id === goal.reviewScheduleTaskId)
      : null
    const task: ScheduledTaskDefinition = {
      id: existingTask?.id || goal.scheduleTaskId || generateId('task_goal'),
      title: `${LONG_TERM_GOAL_TASK_MARKER} ${goal.title}`,
      enabled,
      hidden: true,
      createdBy: 'ai',
      prompt: this.buildExecutionPrompt(goal),
      schedule: toGoalScheduledSchedule(goal),
      providerId: goal.providerId || null,
      modelId: goal.modelId || null,
      selectedSkillIds: [...goal.selectedSkillIds],
      selectedMcpServerIds: [...goal.selectedMcpServerIds],
      retryPolicy: existingTask?.retryPolicy || { maxRetries: 1, retryDelayMinutes: 10 },
      createdAt: existingTask?.createdAt || goal.createdAt || now,
      updatedAt: now,
      nextRunAt: normalizeFutureIsoDate(goal.nextRunAt) || null,
      retryScheduledAt: existingTask?.retryScheduledAt || null,
      lastRunAt: existingTask?.lastRunAt || null,
      lastStatus: existingTask?.lastStatus || 'idle',
      lastReportId: existingTask?.lastReportId || null
    }
    let savedTask: ScheduledTaskDefinition
    try {
      savedTask = this.options.scheduledTaskService.saveTaskWhenIdle(task)
    } catch (error) {
      if (!existingTask) throw error
      console.warn('[long-term-goal-service] Failed to update running backing task:', (error as Error).message)
      savedTask = existingTask
    }
    const reviewTask: ScheduledTaskDefinition = {
      id: existingReviewTask?.id || goal.reviewScheduleTaskId || generateId('task_goal_review'),
      title: `${LONG_TERM_GOAL_REVIEW_MARKER} ${goal.title}`,
      enabled,
      hidden: true,
      createdBy: 'ai',
      prompt: this.buildDailyReviewPrompt(goal),
      schedule: {
        kind: 'daily',
        timeOfDay: goal.dailyReviewTimeOfDay || '21:30'
      },
      providerId: goal.providerId || null,
      modelId: goal.modelId || null,
      selectedSkillIds: [...goal.selectedSkillIds],
      selectedMcpServerIds: [...goal.selectedMcpServerIds],
      retryPolicy: existingReviewTask?.retryPolicy || { maxRetries: 1, retryDelayMinutes: 10 },
      createdAt: existingReviewTask?.createdAt || goal.createdAt || now,
      updatedAt: now,
      nextRunAt: existingReviewTask?.nextRunAt || null,
      retryScheduledAt: existingReviewTask?.retryScheduledAt || null,
      lastRunAt: existingReviewTask?.lastRunAt || null,
      lastStatus: existingReviewTask?.lastStatus || 'idle',
      lastReportId: existingReviewTask?.lastReportId || null
    }
    let savedReviewTask: ScheduledTaskDefinition
    try {
      savedReviewTask = this.options.scheduledTaskService.saveTaskWhenIdle(reviewTask)
    } catch (error) {
      if (!existingReviewTask) throw error
      console.warn('[long-term-goal-service] Failed to update running backing review task:', (error as Error).message)
      savedReviewTask = existingReviewTask
    }
    return this.syncGoalScheduleState({
      ...goal,
      scheduleTaskId: savedTask.id,
      reviewScheduleTaskId: savedReviewTask.id,
      nextRunAt: savedTask.retryScheduledAt || savedTask.nextRunAt || null,
      nextReviewAt: savedReviewTask.retryScheduledAt || savedReviewTask.nextRunAt || null,
      updatedAt: now
    })
  }

  private syncGoalsFromScheduledTasks (): void {
    const nextGoals = this.snapshot.goals.map(goal => this.syncGoalScheduleState(goal))
    if (JSON.stringify(nextGoals) === JSON.stringify(this.snapshot.goals)) return
    this.snapshot.goals = nextGoals
    this.persistAndEmit()
  }

  private syncGoalScheduleState (goal: LongTermGoalDefinition): LongTermGoalDefinition {
    const tasks = this.options.scheduledTaskService.listTasks({ includeHidden: true })
    const task = goal.scheduleTaskId ? tasks.find(item => item.id === goal.scheduleTaskId) : null
    const reviewTask = goal.reviewScheduleTaskId ? tasks.find(item => item.id === goal.reviewScheduleTaskId) : null
    if (!task && !reviewTask) return goal
    return {
      ...goal,
      nextRunAt: task ? (task.retryScheduledAt || task.nextRunAt || null) : goal.nextRunAt || null,
      nextReviewAt: reviewTask ? (reviewTask.retryScheduledAt || reviewTask.nextRunAt || null) : goal.nextReviewAt || null,
      lastRunAt: task?.lastRunAt || reviewTask?.lastRunAt || goal.lastRunAt || null,
      lastRunStatus: task?.lastStatus === 'running' || task?.lastStatus === 'retrying' || reviewTask?.lastStatus === 'running' || reviewTask?.lastStatus === 'retrying'
        ? 'running'
        : task?.lastStatus === 'failed' || reviewTask?.lastStatus === 'failed'
          ? 'failed'
          : task?.lastStatus === 'completed' || reviewTask?.lastStatus === 'completed'
            ? 'completed'
            : goal.lastRunStatus || null
    }
  }

  /** 解析目标绑定的技能为内容数组，供调整/重规划流注入 chatStream。 */
  private resolveSkillContents (goal: LongTermGoalDefinition): string[] {
    if (!this.options.skillStore || goal.selectedSkillIds.length === 0) return []
    const contents: string[] = []
    for (const skillId of goal.selectedSkillIds) {
      const skill = this.options.skillStore.get(skillId)
      if (skill?.content) contents.push(skill.content)
    }
    return contents
  }

  /** 刷新目标绑定项目的 README.md 缓存（异步，不阻塞调用方）。 */
  private async refreshProjectReadmeCache (goal: LongTermGoalDefinition): Promise<void> {
    if (!this.options.projectFS?.readFile || goal.targetProjectIds.length === 0) return
    await Promise.all(goal.targetProjectIds.map(async (projectId) => {
      const content = await this.readProjectReadme(projectId)
      if (content) this.projectReadmeCache.set(projectId, content)
      else this.projectReadmeCache.delete(projectId)
    }))
  }

  /** 同步读取缓存里的项目 README，拼成 prompt 段落。 */
  private getProjectReadmeSection (goal: LongTermGoalDefinition): string | null {
    if (goal.targetProjectIds.length === 0) return null
    const lines: string[] = []
    for (const projectId of goal.targetProjectIds) {
      const readme = this.projectReadmeCache.get(projectId)
      if (!readme) continue
      lines.push(`### ${projectId}\n${readme}`)
    }
    return lines.length > 0 ? lines.join('\n\n') : null
  }

  /** 读取绑定项目的 README.md（缺失返回 null），供执行/重规划 prompt 注入接口说明。 */
  private async readProjectReadme (projectId: string): Promise<string | null> {
    const projectFS = this.options.projectFS
    if (!projectFS?.readFile) return null
    try {
      const content = await projectFS.readFile(projectId, 'README.md')
      if (!content || !content.trim()) return null
      return compactText(content, 4000)
    } catch {
      return null
    }
  }

  /**
   * 合并 AI 产出的时间表（source:'ai'）与 nextTasks 补齐（source:'task'），
   * 只保留未来 24h 内的槽位。任务槽位按 nextRunAt 附近递增排布。
   */
  private buildUpcomingSchedule (
    aiSlots: Array<{ at: string; title: string; reason?: string }>,
    nextTasks: LongTermGoalNextTask[],
    nextRunAt: string | null
  ): LongTermGoalScheduleSlot[] {
    const now = Date.now()
    const horizon = now + 24 * 60 * 60 * 1000
    const slots: LongTermGoalScheduleSlot[] = []
    const seen = new Set<string>()
    for (const slot of aiSlots) {
      const at = normalizeFutureIsoDate(slot.at, 1)
      if (!at) continue
      const ts = Date.parse(at)
      if (ts < now || ts > horizon) continue
      const title = normalizeString(slot.title)
      if (!title) continue
      slots.push({ id: generateId('goal_slot'), at, title, reason: normalizeString(slot.reason) || undefined, source: 'ai' })
    }
    // 用 nextTasks 补齐，确保未来 24h 有可读安排；按 nextRunAt 附近递增排布。
    const baseTs = nextRunAt ? Date.parse(nextRunAt) : now + 60 * 60 * 1000
    const anchor = Number.isFinite(baseTs) && baseTs > now ? baseTs : now + 60 * 60 * 1000
    nextTasks.slice(0, 6).forEach((task, index) => {
      const atIso = new Date(anchor + index * 3 * 60 * 60 * 1000).toISOString()
      const ts = Date.parse(atIso)
      if (ts > horizon) return
      const key = `${atIso}|${task.title}`
      if (seen.has(key)) return
      seen.add(key)
      slots.push({ id: generateId('goal_slot'), at: atIso, title: task.title, reason: task.reason || undefined, source: 'task' })
    })
    return slots.sort((left, right) => left.at.localeCompare(right.at)).slice(0, 16)
  }

  /**
   * 从本次工具调用里检测 create_project 新建的项目 id。
   * create_project 工具结果通常含 projectId；元数据里的 bindProjectIds 作为兜底。
   */
  private detectCreatedProjectIds (toolRuns: LongTermGoalRunToolRun[], parsedBindIds: string[]): string[] {
    const ids = new Set<string>()
    for (const id of parsedBindIds) {
      if (id) ids.add(id)
    }
    // toolRuns 本身不携带工具结果文本，但 create_project 的 progress.detail 里常带 projectId。
    for (const run of toolRuns) {
      if (run.name !== 'create_project') continue
      for (const step of run.progress) {
        const detail = step.detail || ''
        const match = detail.match(/proj_[a-z0-9_]+/i)
        if (match) ids.add(match[0])
      }
    }
    return [...ids]
  }

  /** 把新建项目合并进 goal.targetProjectIds，返回是否有变化。 */
  private bindCreatedProjects (goal: LongTermGoalDefinition, newProjectIds: string[]): LongTermGoalDefinition | null {
    if (newProjectIds.length === 0) return null
    const existing = new Set(goal.targetProjectIds)
    const additions = newProjectIds.filter(id => !existing.has(id))
    if (additions.length === 0) return null
    return { ...goal, targetProjectIds: [...goal.targetProjectIds, ...additions], updatedAt: nowIso() }
  }

  private buildNextTasks (goal: LongTermGoalDefinition, nextPlan: string[]): LongTermGoalNextTask[] {
    const now = nowIso()
    const completedTitles = new Set(nextPlan.map(item => item.toLowerCase()))
    const preserved = goal.nextTasks
      .filter(item => item.status === 'running' || (item.status === 'todo' && !completedTitles.has(item.title.toLowerCase())))
      .slice(0, 10)
    const created = nextPlan.slice(0, 8).map((title, index): LongTermGoalNextTask => ({
      id: generateId('goal_task'),
      title,
      priority: index === 0 ? 'high' : 'medium',
      status: 'todo',
      createdAt: now,
      updatedAt: now
    }))
    return [...created, ...preserved].slice(0, 14)
  }

  private buildIntervention (goalId: string, parsed: ParsedGoalRunResult): LongTermGoalIntervention | null {
    if (!parsed.needsUserInput && parsed.userQuestions.length === 0 && parsed.blockers.length === 0) return null
    return this.createIntervention(goalId, {
      severity: parsed.blockers.length > 0 ? 'blocked' : 'decision',
      title: parsed.blockers.length > 0 ? '目标推进遇到阻塞' : '需要你做一个决定',
      summary: parsed.blockers[0] || parsed.userQuestions[0]?.reason || parsed.userQuestions[0]?.question || 'AI 需要你的补充才能继续推进。',
      questions: parsed.userQuestions.length > 0
        ? parsed.userQuestions.map(question => ({
            id: question.id || generateId('goal_question'),
            question: question.question,
            options: question.options || [],
            reason: question.reason
          }))
        : [{
            id: generateId('goal_question'),
            question: '这个阻塞要如何处理？',
            options: ['调整计划继续推进', '暂停目标', '我补充更多信息'],
            reason: parsed.blockers.join('\n')
          }]
    })
  }

  private createIntervention (goalId: string, input: Pick<LongTermGoalIntervention, 'severity' | 'title' | 'summary' | 'questions'>): LongTermGoalIntervention {
    return {
      id: generateId('goal_intervention'),
      goalId,
      status: 'open',
      severity: input.severity,
      title: input.title,
      summary: input.summary,
      questions: input.questions,
      createdAt: nowIso(),
      resolvedAt: null
    }
  }

  private buildHeuristicChangeSet (goal: LongTermGoalDefinition, turn: LongTermGoalConversationTurn): LongTermGoalChangeSet | null {
    const text = turn.content
    const after: Partial<LongTermGoalDefinition> = {}
    const before: Partial<LongTermGoalDefinition> = {}
    const summaryParts: string[] = []

    if (/暂停|停一下|先停/i.test(text)) {
      before.status = goal.status
      after.status = 'paused'
      summaryParts.push('暂停自动推进')
    } else if (/继续|恢复|重新开始/i.test(text)) {
      before.status = goal.status
      after.status = 'active'
      summaryParts.push('恢复自动推进')
    } else if (/完成|结束目标/i.test(text)) {
      before.status = goal.status
      after.status = 'completed'
      summaryParts.push('标记目标完成')
    }

    if (/执行|频率|间隔|每天|每日|每周|每星期|工作日|周末|早上|晚上|下午|中午|分钟|小时|定时|定期/.test(text)) {
      const inferredSchedule = inferGoalSchedule(text)
      if (JSON.stringify(inferredSchedule) !== JSON.stringify(goal.schedule)) {
        before.schedule = goal.schedule
        after.schedule = inferredSchedule
        summaryParts.push(`改为${scheduleSummary(inferredSchedule)}执行`)
      }
    }

    const objectiveMatch = text.match(/(?:目标改成|目标改为|把目标改成|把目标改为)([\s\S]+)/)
    if (objectiveMatch) {
      const objective = normalizeString(objectiveMatch[1])
      if (objective) {
        before.objective = goal.objective
        after.objective = objective
        summaryParts.push('更新目标描述')
      }
    }

    if (/只.*(阻塞|困难|需要我|决定).*提醒|少提醒|不要频繁/i.test(text)) {
      before.notificationPolicy = goal.notificationPolicy
      after.notificationPolicy = 'minimal'
      summaryParts.push('改为最少打扰通知策略')
    } else if (/正常提醒|都提醒|详细提醒/i.test(text)) {
      before.notificationPolicy = goal.notificationPolicy
      after.notificationPolicy = 'normal'
      summaryParts.push('改为普通通知策略')
    }

    if (summaryParts.length === 0) return null
    return {
      id: generateId('goal_change'),
      goalId: goal.id,
      sourceTurnId: turn.id,
      summary: summaryParts.join('；'),
      before,
      after,
      requiresConfirmation: true,
      status: 'draft',
      createdAt: nowIso(),
      appliedAt: null
    }
  }

  private getGoalOrThrow (goalId: string): LongTermGoalDefinition {
    const goal = this.snapshot.goals.find(item => item.id === goalId)
    if (!goal) throw new Error(`长期目标不存在: ${goalId}`)
    return clone(goal)
  }

  private upsertGoal (goal: LongTermGoalDefinition): LongTermGoalDefinition {
    const index = this.snapshot.goals.findIndex(item => item.id === goal.id)
    const nextGoal = clone(goal)
    if (index >= 0) {
      this.snapshot.goals[index] = nextGoal
    } else {
      this.snapshot.goals.unshift(nextGoal)
    }
    return nextGoal
  }

  private upsertRun (run: LongTermGoalRun): void {
    const index = this.snapshot.runs.findIndex(item => item.id === run.id)
    if (index >= 0) {
      this.snapshot.runs[index] = run
    } else {
      this.snapshot.runs.unshift(run)
    }
  }

  private addActivity (input: Omit<LongTermGoalActivityEvent, 'id' | 'createdAt' | 'artifacts'> & { artifacts?: LongTermGoalActivityEvent['artifacts'] }): void {
    this.snapshot.activities.unshift({
      id: generateId('goal_event'),
      artifacts: [],
      createdAt: nowIso(),
      ...input
    })
  }

  private writeMemory (goalId: string, input: {
    kind: LongTermGoalMemoryEntry['kind']
    title: string
    content: string
    importance: number
    sourceRunId?: string | null
  }): void {
    const now = nowIso()
    this.snapshot.memories.unshift({
      id: generateId('goal_memory'),
      goalId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      importance: Math.max(0, Math.min(1, input.importance)),
      sourceRunId: input.sourceRunId || null,
      createdAt: now,
      updatedAt: now
    })
    this.addActivity({
      goalId,
      runId: input.sourceRunId || null,
      actor: 'ai',
      type: 'memory_written',
      title: '写入长期目标记忆',
      summary: input.title,
      details: input.content
    })
  }

  private upsertMemoryByTitle (goalId: string, input: {
    kind: LongTermGoalMemoryEntry['kind']
    title: string
    content: string
    importance: number
    sourceRunId?: string | null
  }): void {
    const now = nowIso()
    const index = this.snapshot.memories.findIndex(item => item.goalId === goalId && item.kind === input.kind && item.title === input.title)
    const memory: LongTermGoalMemoryEntry = {
      id: index >= 0 ? this.snapshot.memories[index].id : generateId('goal_memory'),
      goalId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      importance: Math.max(0, Math.min(1, input.importance)),
      sourceRunId: input.sourceRunId || null,
      createdAt: index >= 0 ? this.snapshot.memories[index].createdAt : now,
      updatedAt: now
    }
    if (index >= 0) {
      this.snapshot.memories[index] = memory
    } else {
      this.snapshot.memories.unshift(memory)
    }
  }

  private selectMemoriesForBrief (
    goalId: string,
    kinds: LongTermGoalMemoryEntry['kind'][],
    limit: number
  ): LongTermGoalMemoryEntry[] {
    const kindSet = new Set(kinds)
    return this.snapshot.memories
      .filter(item => item.goalId === goalId && kindSet.has(item.kind) && item.title !== EXECUTION_BRIEF_TITLE)
      .sort((left, right) => {
        if (right.importance !== left.importance) return right.importance - left.importance
        return right.updatedAt.localeCompare(left.updatedAt)
      })
      .slice(0, limit)
  }

  private formatMemoryBullets (memories: LongTermGoalMemoryEntry[], maxLength = 180): string {
    return memories
      .map(item => `- ${item.title}: ${compactText(item.content, maxLength)}`)
      .join('\n')
  }

  private buildExecutionBrief (goal: LongTermGoalDefinition): string {
    const achievements = this.selectMemoriesForBrief(goal.id, ['achievement', 'progress_summary', 'daily_review', 'artifact'], 8)
    const skills = this.selectMemoriesForBrief(goal.id, ['skill'], 8)
    const decisions = this.selectMemoriesForBrief(goal.id, ['decision', 'blocker'], 8)
    const nextTasks = goal.nextTasks
      .filter(item => item.status === 'todo' || item.status === 'running')
      .slice(0, 8)
      .map(item => `- [${item.priority}] ${item.title}${item.reason ? `：${compactText(item.reason, 120)}` : ''}`)
      .join('\n')
    const recentReviews = this.snapshot.reviews
      .filter(item => item.goalId === goal.id)
      .slice(0, 3)
      .map(item => `- ${item.date}: ${compactText(item.progressSummary, 140)}；差距：${compactText(item.gapAnalysis, 140)}`)
      .join('\n')

    return [
      `# ${EXECUTION_BRIEF_TITLE}`,
      '',
      '## 目标核心',
      `- 名称：${goal.title}`,
      `- 最终目标：${compactText(goal.objective, 900)}`,
      `- 当前阶段：${goal.currentPhase || '持续推进'}`,
      `- 当前进展：${goal.progressSummary || '暂无'}`,
      `- 当前差距：${goal.gapSummary || '暂无'}`,
      goal.todayFocus ? `- 今日重点：${goal.todayFocus}` : '',
      '',
      '## 已执行过的重要成果',
      this.formatMemoryBullets(achievements) || '- 暂无沉淀成果。',
      '',
      '## 已学到的技能和有效方法',
      this.formatMemoryBullets(skills) || '- 暂无可复用技能/方法。',
      '',
      '## 关键决定、限制和阻塞',
      this.formatMemoryBullets(decisions) || '- 暂无关键限制。',
      '',
      '## 下一步任务队列',
      nextTasks || '- 等待下一次执行生成。',
      '',
      '## 最近复盘',
      recentReviews || '- 暂无复盘。'
    ].filter(Boolean).join('\n')
  }

  private refreshExecutionBrief (goalId: string): void {
    const goal = this.snapshot.goals.find(item => item.id === goalId)
    if (!goal) return
    const content = this.buildExecutionBrief(goal)
    this.upsertMemoryByTitle(goalId, {
      kind: 'execution_brief',
      title: EXECUTION_BRIEF_TITLE,
      content,
      importance: 1
    })
    this.addActivity({
      goalId,
      actor: 'system',
      type: 'memory_compacted',
      title: '执行记忆包已刷新',
      summary: '已压缩目标核心、重要成果、技能方法、关键决定和下一步任务，供后续执行优先读取。',
      details: content
    })
    this.updateGoalMemorySummary(goalId)
  }

  private compactGoalMemory (goalId: string): void {
    const memories = this.snapshot.memories.filter(item => item.goalId === goalId)
    if (memories.length <= MAX_MEMORY_ENTRIES) {
      this.updateGoalMemorySummary(goalId)
      return
    }
    const pinnedKinds = new Set<LongTermGoalMemoryEntry['kind']>(['goal_profile', 'execution_brief', 'decision', 'blocker'])
    const preserved = memories
      .filter(item => pinnedKinds.has(item.kind))
      .slice(0, 24)
    const recent = memories
      .filter(item => !pinnedKinds.has(item.kind))
      .slice(0, MAX_MEMORY_ENTRIES - preserved.length - 1)
    const overflow = memories.slice(MAX_MEMORY_ENTRIES - 1)
    const compactedContent = overflow
      .slice(0, 30)
      .map(item => `${item.title}: ${compactText(item.content, 160)}`)
      .join('\n')
    const now = nowIso()
    const summaryMemory: LongTermGoalMemoryEntry = {
      id: generateId('goal_memory'),
      goalId,
      kind: 'progress_summary',
      title: '自动压缩的长期记忆摘要',
      content: compactedContent || '旧记忆已自动压缩。',
      importance: 0.76,
      sourceRunId: null,
      createdAt: now,
      updatedAt: now
    }
    const otherGoalMemories = this.snapshot.memories.filter(item => item.goalId !== goalId)
    this.snapshot.memories = [summaryMemory, ...preserved, ...recent, ...otherGoalMemories]
    this.addActivity({
      goalId,
      actor: 'system',
      type: 'memory_compacted',
      title: '长期记忆已自动压缩',
      summary: `已将 ${overflow.length} 条较旧记忆压缩为摘要。`,
      details: summaryMemory.content
    })
    this.updateGoalMemorySummary(goalId)
  }

  private updateGoalMemorySummary (goalId: string): void {
    const goal = this.snapshot.goals.find(item => item.id === goalId)
    if (!goal) return
    const executionBrief = this.snapshot.memories.find(item => item.goalId === goalId && item.kind === 'execution_brief')
    const summary = this.snapshot.memories
      .filter(item => item.goalId === goalId)
      .filter(item => item.kind !== 'execution_brief')
      .sort((left, right) => {
        if (right.importance !== left.importance) return right.importance - left.importance
        return right.updatedAt.localeCompare(left.updatedAt)
      })
      .slice(0, 7)
      .map(item => `${item.title}: ${compactText(item.content, 140)}`)
      .join('\n')
    this.upsertGoal({
      ...goal,
      memorySummary: executionBrief
        ? compactText(executionBrief.content, 1600)
        : (summary || goal.memorySummary),
      updatedAt: nowIso()
    })
  }

  private trimCollections (): void {
    this.snapshot.goals = sortGoals(this.snapshot.goals)
    this.snapshot.runs = this.snapshot.runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, MAX_RUN_HISTORY)
    this.snapshot.reviews = this.snapshot.reviews.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, MAX_REVIEW_HISTORY)
    this.snapshot.activities = this.snapshot.activities.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, MAX_ACTIVITY_HISTORY)
    this.snapshot.conversations = this.snapshot.conversations.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, MAX_CONVERSATION_HISTORY)
    this.snapshot.changeSets = this.snapshot.changeSets.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, MAX_CONVERSATION_HISTORY)
  }

  private persistAndEmit (): void {
    this.trimCollections()
    this.snapshot = this.options.store.saveSnapshot(this.snapshot)
    this.options.onGoalsChanged?.(this.listGoals())
    this.options.onSnapshotChanged?.(this.getSnapshot())
  }
}
