import fs from 'node:fs'
import path from 'node:path'
import type {
  LongTermGoalActivityArtifact,
  LongTermGoalActivityEvent,
  LongTermGoalChangeSet,
  LongTermGoalConversationTurn,
  LongTermGoalDailyReview,
  LongTermGoalDefinition,
  LongTermGoalIntervention,
  LongTermGoalInterventionQuestion,
  LongTermGoalMemoryEntry,
  LongTermGoalNextTask,
  LongTermGoalRun,
  LongTermGoalRunProgressEntry,
  LongTermGoalRunStatus,
  LongTermGoalRunToolRun,
  LongTermGoalSchedule,
  LongTermGoalSnapshot,
  LongTermGoalStatus
} from '../../shared/long-term-goal-types.js'

function normalizeString (value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeIsoDate (value: unknown): string | null {
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return new Date(timestamp).toISOString()
}

function normalizeDateKey (value: unknown): string {
  const raw = normalizeString(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const iso = normalizeIsoDate(raw)
  return iso ? iso.slice(0, 10) : new Date().toISOString().slice(0, 10)
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

function normalizeTimeOfDay (value: unknown): string | null {
  const raw = normalizeString(value)
  const match = raw.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null
  }
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
}

function normalizeWeekdays (value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<number>()
  const weekdays: number[] = []
  for (const item of value) {
    const weekday = Number(item)
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7 || seen.has(weekday)) continue
    seen.add(weekday)
    weekdays.push(weekday)
  }
  return weekdays.sort((left, right) => left - right)
}

function normalizeNumber (value: unknown, fallback: number, min: number, max: number): number {
  const next = Number(value)
  if (!Number.isFinite(next)) return fallback
  return Math.max(min, Math.min(max, next))
}

function normalizeSchedule (value: unknown): LongTermGoalSchedule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const kind = normalizeString(record.kind)

  if (kind === 'once') {
    const runAt = normalizeIsoDate(record.runAt)
    return runAt ? { kind: 'once', runAt } : null
  }

  if (kind === 'dates') {
    const dates = normalizeStringArray(record.dates)
      .map(date => normalizeIsoDate(date))
      .filter((date): date is string => Boolean(date))
      .sort((left, right) => left.localeCompare(right))
    return dates.length > 0 ? { kind: 'dates', dates } : null
  }

  if (kind === 'daily') {
    const timeOfDay = normalizeTimeOfDay(record.timeOfDay)
    return timeOfDay ? { kind: 'daily', timeOfDay } : null
  }

  if (kind === 'weekly') {
    const timeOfDay = normalizeTimeOfDay(record.timeOfDay)
    const weekdays = normalizeWeekdays(record.weekdays)
    return timeOfDay && weekdays.length > 0 ? { kind: 'weekly', weekdays, timeOfDay } : null
  }

  const everyMinutes = Number(record.everyMinutes)
  const startAt = normalizeIsoDate(record.startAt)
  return {
    kind: 'interval',
    everyMinutes: Number.isFinite(everyMinutes) && everyMinutes > 0 ? Math.min(7 * 24 * 60, Math.floor(everyMinutes)) : 24 * 60,
    startAt: startAt || undefined
  }
}

function normalizeNextTask (value: unknown): LongTermGoalNextTask | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = normalizeString(record.id)
  const title = normalizeString(record.title)
  if (!id || !title) return null
  const now = new Date().toISOString()
  const priority = record.priority === 'high' || record.priority === 'low' ? record.priority : 'medium'
  const status = record.status === 'running' || record.status === 'done' || record.status === 'skipped' ? record.status : 'todo'
  const createdAt = normalizeIsoDate(record.createdAt) || now
  return {
    id,
    title,
    reason: normalizeString(record.reason) || undefined,
    priority,
    status,
    dueAt: normalizeIsoDate(record.dueAt),
    createdAt,
    updatedAt: normalizeIsoDate(record.updatedAt) || createdAt
  }
}

function normalizeInterventionQuestion (value: unknown): LongTermGoalInterventionQuestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = normalizeString(record.id)
  const question = normalizeString(record.question)
  if (!id || !question) return null
  return {
    id,
    question,
    options: normalizeStringArray(record.options).slice(0, 6),
    reason: normalizeString(record.reason) || undefined
  }
}

function normalizeIntervention (value: unknown): LongTermGoalIntervention | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = normalizeString(record.id)
  const goalId = normalizeString(record.goalId)
  const title = normalizeString(record.title)
  const summary = normalizeString(record.summary)
  if (!id || !goalId || !title || !summary) return null
  const severity = record.severity === 'blocked' || record.severity === 'authorization' || record.severity === 'info' ? record.severity : 'decision'
  const status = record.status === 'answered' || record.status === 'dismissed' ? record.status : 'open'
  const createdAt = normalizeIsoDate(record.createdAt) || new Date().toISOString()
  return {
    id,
    goalId,
    status,
    severity,
    title,
    summary,
    questions: Array.isArray(record.questions)
      ? record.questions.map(normalizeInterventionQuestion).filter((item): item is LongTermGoalInterventionQuestion => Boolean(item))
      : [],
    createdAt,
    resolvedAt: normalizeIsoDate(record.resolvedAt)
  }
}

function normalizeGoalStatus (value: unknown): LongTermGoalStatus {
  return value === 'paused' || value === 'completed' || value === 'archived' ? value : 'active'
}

function normalizeRunStatus (value: unknown): LongTermGoalRunStatus {
  if (value === 'running' || value === 'reviewing' || value === 'failed') return value
  return 'completed'
}

function normalizeGoal (value: unknown): LongTermGoalDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = normalizeString(record.id)
  const title = normalizeString(record.title)
  const objective = normalizeString(record.objective)
  const schedule = normalizeSchedule(record.schedule)
  if (!id || !title || !objective || !schedule) return null
  const createdAt = normalizeIsoDate(record.createdAt) || new Date().toISOString()
  const notificationPolicy = record.notificationPolicy === 'normal' ? 'normal' : 'minimal'
  return {
    id,
    title,
    objective,
    status: normalizeGoalStatus(record.status),
    providerId: normalizeString(record.providerId) || null,
    modelId: normalizeString(record.modelId) || null,
    schedule,
    scheduleTaskId: normalizeString(record.scheduleTaskId) || null,
    reviewScheduleTaskId: normalizeString(record.reviewScheduleTaskId) || null,
    dailyReviewTimeOfDay: normalizeTimeOfDay(record.dailyReviewTimeOfDay) || '21:30',
    selectedSkillIds: normalizeStringArray(record.selectedSkillIds),
    selectedMcpServerIds: normalizeStringArray(record.selectedMcpServerIds),
    targetProjectIds: normalizeStringArray(record.targetProjectIds),
    notificationPolicy,
    currentPhase: normalizeString(record.currentPhase) || undefined,
    progressSummary: normalizeString(record.progressSummary) || undefined,
    gapSummary: normalizeString(record.gapSummary) || undefined,
    todayFocus: normalizeString(record.todayFocus) || undefined,
    nextRunAt: normalizeIsoDate(record.nextRunAt),
    nextReviewAt: normalizeIsoDate(record.nextReviewAt),
    lastRunAt: normalizeIsoDate(record.lastRunAt),
    lastReviewAt: normalizeIsoDate(record.lastReviewAt),
    lastRunStatus: record.lastRunStatus ? normalizeRunStatus(record.lastRunStatus) : null,
    nextTasks: Array.isArray(record.nextTasks)
      ? record.nextTasks.map(normalizeNextTask).filter((item): item is LongTermGoalNextTask => Boolean(item)).slice(0, 30)
      : [],
    openInterventions: Array.isArray(record.openInterventions)
      ? record.openInterventions.map(normalizeIntervention).filter((item): item is LongTermGoalIntervention => Boolean(item)).filter(item => item.status === 'open')
      : [],
    memorySummary: normalizeString(record.memorySummary) || undefined,
    createdAt,
    updatedAt: normalizeIsoDate(record.updatedAt) || createdAt
  }
}

function normalizeArtifact (value: unknown): LongTermGoalActivityArtifact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const title = normalizeString(record.title)
  const ref = normalizeString(record.ref)
  if (!title || !ref) return null
  const kind = record.kind === 'file' || record.kind === 'url' || record.kind === 'report' || record.kind === 'memory' || record.kind === 'conversation' || record.kind === 'task'
    ? record.kind
    : 'report'
  return { kind, title, ref }
}

function normalizeActivity (value: unknown): LongTermGoalActivityEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = normalizeString(record.id)
  const goalId = normalizeString(record.goalId)
  const title = normalizeString(record.title)
  const summary = normalizeString(record.summary)
  if (!id || !goalId || !title || !summary) return null
  const actor = record.actor === 'user' || record.actor === 'system' || record.actor === 'tool' ? record.actor : 'ai'
  const type = normalizeString(record.type) as LongTermGoalActivityEvent['type']
  const allowedTypes: LongTermGoalActivityEvent['type'][] = ['goal_created', 'goal_changed', 'run_started', 'task_completed', 'gap_found', 'plan_updated', 'memory_written', 'memory_compacted', 'user_decision', 'blocked', 'milestone_completed', 'review_completed']
  return {
    id,
    goalId,
    runId: normalizeString(record.runId) || null,
    actor,
    type: allowedTypes.includes(type) ? type : 'task_completed',
    title,
    summary,
    details: normalizeString(record.details) || undefined,
    artifacts: Array.isArray(record.artifacts)
      ? record.artifacts.map(normalizeArtifact).filter((item): item is LongTermGoalActivityArtifact => Boolean(item))
      : [],
    createdAt: normalizeIsoDate(record.createdAt) || new Date().toISOString()
  }
}

function normalizeMemory (value: unknown): LongTermGoalMemoryEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = normalizeString(record.id)
  const goalId = normalizeString(record.goalId)
  const title = normalizeString(record.title)
  const content = normalizeString(record.content)
  if (!id || !goalId || !title || !content) return null
  const kind = normalizeString(record.kind) as LongTermGoalMemoryEntry['kind']
  const allowedKinds: LongTermGoalMemoryEntry['kind'][] = ['goal_profile', 'execution_brief', 'achievement', 'skill', 'progress_summary', 'daily_review', 'decision', 'blocker', 'plan', 'artifact']
  const createdAt = normalizeIsoDate(record.createdAt) || new Date().toISOString()
  return {
    id,
    goalId,
    kind: allowedKinds.includes(kind) ? kind : 'progress_summary',
    title,
    content,
    importance: normalizeNumber(record.importance, 0.5, 0, 1),
    sourceRunId: normalizeString(record.sourceRunId) || null,
    createdAt,
    updatedAt: normalizeIsoDate(record.updatedAt) || createdAt
  }
}

function normalizeReview (value: unknown): LongTermGoalDailyReview | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = normalizeString(record.id)
  const goalId = normalizeString(record.goalId)
  const progressSummary = normalizeString(record.progressSummary)
  const gapAnalysis = normalizeString(record.gapAnalysis)
  if (!id || !goalId || !progressSummary || !gapAnalysis) return null
  const createdAt = normalizeIsoDate(record.createdAt) || new Date().toISOString()
  return {
    id,
    goalId,
    date: normalizeDateKey(record.date),
    runId: normalizeString(record.runId) || null,
    progressSummary,
    gapAnalysis,
    nextPlan: normalizeStringArray(record.nextPlan),
    blockers: normalizeStringArray(record.blockers),
    notificationLevel: record.notificationLevel === 'notify' || record.notificationLevel === 'badge' ? record.notificationLevel : 'silent',
    needsUserInput: record.needsUserInput === true,
    createdAt,
    updatedAt: normalizeIsoDate(record.updatedAt) || createdAt
  }
}

function normalizeRunProgressEntry (value: unknown): LongTermGoalRunProgressEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const stage = normalizeString(record.stage)
  if (!stage) return null
  const kind = record.kind === 'thinking' ||
    record.kind === 'tool_start' ||
    record.kind === 'tool_end' ||
    record.kind === 'todo' ||
    record.kind === 'file' ||
    record.kind === 'web'
    ? record.kind
    : 'progress'
  return {
    at: normalizeIsoDate(record.at) || new Date().toISOString(),
    stage,
    detail: normalizeString(record.detail) || undefined,
    kind,
    toolName: normalizeString(record.toolName) || undefined
  }
}

function normalizeToolRunProgressEntry (value: unknown): LongTermGoalRunToolRun['progress'][number] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const stage = normalizeString(record.stage)
  if (!stage) return null
  return {
    stage,
    detail: normalizeString(record.detail) || undefined
  }
}

function normalizeRunToolRun (value: unknown): LongTermGoalRunToolRun | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = normalizeString(record.id)
  const name = normalizeString(record.name)
  if (!id || !name) return null
  const status = record.status === 'completed' || record.status === 'failed' ? record.status : 'running'
  return {
    id,
    name,
    status,
    progress: Array.isArray(record.progress)
      ? record.progress.map(normalizeToolRunProgressEntry).filter((item): item is LongTermGoalRunToolRun['progress'][number] => Boolean(item))
      : []
  }
}

function normalizeRun (value: unknown): LongTermGoalRun | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = normalizeString(record.id)
  const goalId = normalizeString(record.goalId)
  const startedAt = normalizeIsoDate(record.startedAt)
  if (!id || !goalId || !startedAt) return null
  const createdAt = normalizeIsoDate(record.createdAt) || startedAt
  return {
    id,
    goalId,
    scheduledReportId: normalizeString(record.scheduledReportId) || null,
    status: normalizeRunStatus(record.status),
    startedAt,
    finishedAt: normalizeIsoDate(record.finishedAt),
    progressSummary: normalizeString(record.progressSummary),
    gapToGoal: normalizeString(record.gapToGoal),
    resultText: normalizeString(record.resultText) || undefined,
    thinkingText: normalizeString(record.thinkingText) || undefined,
    progress: Array.isArray(record.progress)
      ? record.progress.map(normalizeRunProgressEntry).filter((item): item is LongTermGoalRunProgressEntry => Boolean(item))
      : [],
    toolRuns: Array.isArray(record.toolRuns)
      ? record.toolRuns.map(normalizeRunToolRun).filter((item): item is LongTermGoalRunToolRun => Boolean(item))
      : [],
    error: normalizeString(record.error) || undefined,
    notificationLevel: record.notificationLevel === 'notify' || record.notificationLevel === 'badge' ? record.notificationLevel : 'silent',
    createdAt,
    updatedAt: normalizeIsoDate(record.updatedAt) || createdAt
  }
}

function normalizeConversationTurn (value: unknown): LongTermGoalConversationTurn | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = normalizeString(record.id)
  const goalId = normalizeString(record.goalId)
  const content = normalizeString(record.content)
  if (!id || !goalId || !content) return null
  return {
    id,
    goalId,
    role: record.role === 'assistant' ? 'assistant' : 'user',
    content,
    thinking: normalizeString(record.thinking) || undefined,
    toolRuns: Array.isArray(record.toolRuns)
      ? record.toolRuns.map(normalizeRunToolRun).filter((item): item is LongTermGoalRunToolRun => Boolean(item))
      : undefined,
    createdAt: normalizeIsoDate(record.createdAt) || new Date().toISOString(),
    appliedChangeId: normalizeString(record.appliedChangeId) || null
  }
}

function normalizeChangeSet (value: unknown): LongTermGoalChangeSet | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = normalizeString(record.id)
  const goalId = normalizeString(record.goalId)
  const sourceTurnId = normalizeString(record.sourceTurnId)
  const summary = normalizeString(record.summary)
  if (!id || !goalId || !sourceTurnId || !summary) return null
  const status = record.status === 'applied' || record.status === 'cancelled' ? record.status : 'draft'
  return {
    id,
    goalId,
    sourceTurnId,
    summary,
    before: (record.before && typeof record.before === 'object' && !Array.isArray(record.before)) ? record.before as Partial<LongTermGoalDefinition> : {},
    after: (record.after && typeof record.after === 'object' && !Array.isArray(record.after)) ? record.after as Partial<LongTermGoalDefinition> : {},
    requiresConfirmation: record.requiresConfirmation !== false,
    status,
    createdAt: normalizeIsoDate(record.createdAt) || new Date().toISOString(),
    appliedAt: normalizeIsoDate(record.appliedAt)
  }
}

function normalizeSnapshot (value: unknown): LongTermGoalSnapshot {
  const record = (value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {}

  return {
    goals: Array.isArray(record.goals) ? record.goals.map(normalizeGoal).filter((item): item is LongTermGoalDefinition => Boolean(item)) : [],
    runs: Array.isArray(record.runs) ? record.runs.map(normalizeRun).filter((item): item is LongTermGoalRun => Boolean(item)) : [],
    reviews: Array.isArray(record.reviews) ? record.reviews.map(normalizeReview).filter((item): item is LongTermGoalDailyReview => Boolean(item)) : [],
    activities: Array.isArray(record.activities) ? record.activities.map(normalizeActivity).filter((item): item is LongTermGoalActivityEvent => Boolean(item)) : [],
    memories: Array.isArray(record.memories) ? record.memories.map(normalizeMemory).filter((item): item is LongTermGoalMemoryEntry => Boolean(item)) : [],
    conversations: Array.isArray(record.conversations) ? record.conversations.map(normalizeConversationTurn).filter((item): item is LongTermGoalConversationTurn => Boolean(item)) : [],
    changeSets: Array.isArray(record.changeSets) ? record.changeSets.map(normalizeChangeSet).filter((item): item is LongTermGoalChangeSet => Boolean(item)) : []
  }
}

export class LongTermGoalStore {
  private readonly filePath: string
  private cache: LongTermGoalSnapshot | null = null

  constructor (userDataPath: string) {
    this.filePath = path.join(userDataPath, 'long-term-goals.json')
  }

  private readSnapshot (): LongTermGoalSnapshot {
    if (this.cache) return this.cache
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        this.cache = normalizeSnapshot(JSON.parse(raw))
        return this.cache
      }
    } catch (error) {
      console.error('[long-term-goal-store] Failed to read snapshot:', (error as Error).message)
    }
    this.cache = normalizeSnapshot({})
    return this.cache
  }

  private writeSnapshot (snapshot: LongTermGoalSnapshot): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(normalizeSnapshot(snapshot), null, 2), 'utf-8')
      this.cache = normalizeSnapshot(snapshot)
    } catch (error) {
      console.error('[long-term-goal-store] Failed to write snapshot:', (error as Error).message)
      throw error
    }
  }

  getSnapshot (): LongTermGoalSnapshot {
    return normalizeSnapshot(this.readSnapshot())
  }

  saveSnapshot (snapshot: LongTermGoalSnapshot): LongTermGoalSnapshot {
    this.writeSnapshot(snapshot)
    return this.getSnapshot()
  }
}
