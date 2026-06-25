import fs from 'node:fs'
import path from 'node:path'

export type ScheduledTaskStatus = 'idle' | 'running' | 'retrying' | 'completed' | 'failed'
export type ScheduledTaskRunStatus = 'running' | 'retrying' | 'completed' | 'failed'
export type ScheduledTaskTrigger = 'manual' | 'schedule'

export interface ScheduledTaskProgressEntry {
  at: string
  stage: string
  detail?: string
  kind?: 'progress' | 'thinking' | 'tool_start' | 'tool_end' | 'todo' | 'file' | 'web'
  toolName?: string
}

export interface ScheduledTaskRetryPolicy {
  maxRetries: number
  retryDelayMinutes: number
}

export interface ScheduledTaskOnceSchedule {
  kind: 'once'
  runAt: string
}

export interface ScheduledTaskIntervalSchedule {
  kind: 'interval'
  everyMinutes: number
  startAt?: string
}

export interface ScheduledTaskDailySchedule {
  kind: 'daily'
  timeOfDay: string
}

export interface ScheduledTaskWeeklySchedule {
  kind: 'weekly'
  weekdays: number[]
  timeOfDay: string
}

export interface ScheduledTaskDatesSchedule {
  kind: 'dates'
  dates: string[]
}

export type ScheduledTaskSchedule =
  | ScheduledTaskOnceSchedule
  | ScheduledTaskIntervalSchedule
  | ScheduledTaskDailySchedule
  | ScheduledTaskWeeklySchedule
  | ScheduledTaskDatesSchedule

export interface ScheduledTaskDefinition {
  id: string
  title: string
  enabled: boolean
  createdBy: 'manual' | 'ai'
  prompt: string
  schedule: ScheduledTaskSchedule
  providerId?: string | null
  modelId?: string | null
  selectedSkillIds: string[]
  selectedMcpServerIds: string[]
  retryPolicy: ScheduledTaskRetryPolicy
  createdAt: string
  updatedAt: string
  nextRunAt?: string | null
  retryScheduledAt?: string | null
  lastRunAt?: string | null
  lastStatus?: ScheduledTaskStatus
  lastReportId?: string | null
}

export interface ScheduledTaskRunReport {
  id: string
  taskId: string
  taskTitle: string
  trigger: ScheduledTaskTrigger
  status: ScheduledTaskRunStatus
  scheduledFor?: string | null
  startedAt: string
  finishedAt?: string | null
  attempt: number
  prompt: string
  summary: string
  resultText?: string
  thinkingText?: string
  error?: string
  progress: ScheduledTaskProgressEntry[]
  providerId?: string | null
  modelId?: string | null
  selectedSkillIds: string[]
  selectedMcpServerIds: string[]
  retryScheduledAt?: string | null
  createdAt: string
  updatedAt: string
}

interface ScheduledTaskStoreSnapshot {
  tasks: ScheduledTaskDefinition[]
  reports: ScheduledTaskRunReport[]
}

const DEFAULT_RETRY_POLICY: ScheduledTaskRetryPolicy = {
  maxRetries: 0,
  retryDelayMinutes: 5
}

function normalizeString (value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeIsoDate (value: unknown): string | null {
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return new Date(timestamp).toISOString()
}

function normalizeStringArray (value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const normalized: string[] = []
  for (const item of value) {
    const next = normalizeString(item)
    if (!next || seen.has(next)) continue
    seen.add(next)
    normalized.push(next)
  }
  return normalized
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
  const normalized: number[] = []
  for (const item of value) {
    const weekday = Number(item)
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7 || seen.has(weekday)) continue
    seen.add(weekday)
    normalized.push(weekday)
  }

  return normalized.sort((left, right) => left - right)
}

function normalizeRetryPolicy (value: unknown): ScheduledTaskRetryPolicy {
  const record = (value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {}

  const rawMaxRetries = Number(record.maxRetries)
  const rawRetryDelay = Number(record.retryDelayMinutes)

  return {
    maxRetries: Number.isFinite(rawMaxRetries) && rawMaxRetries >= 0
      ? Math.min(10, Math.floor(rawMaxRetries))
      : DEFAULT_RETRY_POLICY.maxRetries,
    retryDelayMinutes: Number.isFinite(rawRetryDelay) && rawRetryDelay > 0
      ? Math.min(7 * 24 * 60, Math.floor(rawRetryDelay))
      : DEFAULT_RETRY_POLICY.retryDelayMinutes
  }
}

function normalizeSchedule (value: unknown): ScheduledTaskSchedule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  const kind = normalizeString(record.kind)

  if (kind === 'once') {
    const runAt = normalizeIsoDate(record.runAt)
    return runAt ? { kind: 'once', runAt } : null
  }

  if (kind === 'interval') {
    const everyMinutes = Number(record.everyMinutes)
    const startAt = normalizeIsoDate(record.startAt)
    if (!Number.isFinite(everyMinutes) || everyMinutes < 1) return null
    return {
      kind: 'interval',
      everyMinutes: Math.min(7 * 24 * 60, Math.floor(everyMinutes)),
      startAt: startAt || undefined
    }
  }

  if (kind === 'daily') {
    const timeOfDay = normalizeTimeOfDay(record.timeOfDay)
    return timeOfDay ? { kind: 'daily', timeOfDay } : null
  }

  if (kind === 'weekly') {
    const timeOfDay = normalizeTimeOfDay(record.timeOfDay)
    const weekdays = normalizeWeekdays(record.weekdays)
    if (!timeOfDay || weekdays.length === 0) return null
    return {
      kind: 'weekly',
      weekdays,
      timeOfDay
    }
  }

  if (kind === 'dates') {
    const dates = normalizeStringArray(record.dates)
      .map(date => normalizeIsoDate(date))
      .filter((date): date is string => Boolean(date))
      .sort((left, right) => left.localeCompare(right))

    if (dates.length === 0) return null
    return {
      kind: 'dates',
      dates
    }
  }

  return null
}

function normalizeTask (value: unknown): ScheduledTaskDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  const id = normalizeString(record.id)
  const title = normalizeString(record.title)
  const prompt = normalizeString(record.prompt)
  const schedule = normalizeSchedule(record.schedule)
  if (!id || !title || !prompt || !schedule) return null

  const createdAt = normalizeIsoDate(record.createdAt) || new Date().toISOString()
  const updatedAt = normalizeIsoDate(record.updatedAt) || createdAt
  const nextRunAt = normalizeIsoDate(record.nextRunAt)
  const retryScheduledAt = normalizeIsoDate(record.retryScheduledAt)
  const lastRunAt = normalizeIsoDate(record.lastRunAt)
  const lastStatus = record.lastStatus === 'running' || record.lastStatus === 'retrying' || record.lastStatus === 'completed' || record.lastStatus === 'failed'
    ? record.lastStatus
    : 'idle'

  return {
    id,
    title,
    enabled: record.enabled !== false,
    createdBy: record.createdBy === 'ai' ? 'ai' : 'manual',
    prompt,
    schedule,
    providerId: normalizeString(record.providerId) || null,
    modelId: normalizeString(record.modelId) || null,
    selectedSkillIds: normalizeStringArray(record.selectedSkillIds),
    selectedMcpServerIds: normalizeStringArray(record.selectedMcpServerIds),
    retryPolicy: normalizeRetryPolicy(record.retryPolicy),
    createdAt,
    updatedAt,
    nextRunAt,
    retryScheduledAt,
    lastRunAt,
    lastStatus,
    lastReportId: normalizeString(record.lastReportId) || null
  }
}

function normalizeProgressEntry (value: unknown): ScheduledTaskProgressEntry | null {
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

function normalizeReport (value: unknown): ScheduledTaskRunReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  const id = normalizeString(record.id)
  const taskId = normalizeString(record.taskId)
  const taskTitle = normalizeString(record.taskTitle)
  const prompt = normalizeString(record.prompt)
  const summary = normalizeString(record.summary)
  const startedAt = normalizeIsoDate(record.startedAt)
  if (!id || !taskId || !taskTitle || !prompt || !summary || !startedAt) return null

  const status = record.status === 'running' || record.status === 'retrying' || record.status === 'completed' || record.status === 'failed'
    ? record.status
    : null
  if (!status) return null

  return {
    id,
    taskId,
    taskTitle,
    trigger: record.trigger === 'manual' ? 'manual' : 'schedule',
    status,
    scheduledFor: normalizeIsoDate(record.scheduledFor),
    startedAt,
    finishedAt: normalizeIsoDate(record.finishedAt),
    attempt: Number.isFinite(Number(record.attempt)) && Number(record.attempt) > 0
      ? Math.floor(Number(record.attempt))
      : 1,
    prompt,
    summary,
    resultText: normalizeString(record.resultText) || undefined,
    thinkingText: normalizeString(record.thinkingText) || undefined,
    error: normalizeString(record.error) || undefined,
    progress: Array.isArray(record.progress)
      ? record.progress
        .map(normalizeProgressEntry)
        .filter((entry): entry is ScheduledTaskProgressEntry => Boolean(entry))
      : [],
    providerId: normalizeString(record.providerId) || null,
    modelId: normalizeString(record.modelId) || null,
    selectedSkillIds: normalizeStringArray(record.selectedSkillIds),
    selectedMcpServerIds: normalizeStringArray(record.selectedMcpServerIds),
    retryScheduledAt: normalizeIsoDate(record.retryScheduledAt),
    createdAt: normalizeIsoDate(record.createdAt) || startedAt,
    updatedAt: normalizeIsoDate(record.updatedAt) || normalizeIsoDate(record.createdAt) || startedAt
  }
}

function normalizeSnapshot (value: unknown): ScheduledTaskStoreSnapshot {
  const record = (value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {}

  const tasks = Array.isArray(record.tasks)
    ? record.tasks
      .map(normalizeTask)
      .filter((task): task is ScheduledTaskDefinition => Boolean(task))
    : []

  const reports = Array.isArray(record.reports)
    ? record.reports
      .map(normalizeReport)
      .filter((report): report is ScheduledTaskRunReport => Boolean(report))
    : []

  return { tasks, reports }
}

export class ScheduledTaskStore {
  private readonly filePath: string
  private cache: ScheduledTaskStoreSnapshot | null = null

  constructor (userDataPath: string) {
    this.filePath = path.join(userDataPath, 'scheduled-tasks.json')
  }

  private readSnapshot (): ScheduledTaskStoreSnapshot {
    if (this.cache) return this.cache

    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        this.cache = normalizeSnapshot(JSON.parse(raw))
        return this.cache
      }
    } catch (error) {
      console.error('[scheduled-task-store] Failed to read snapshot:', (error as Error).message)
    }

    this.cache = { tasks: [], reports: [] }
    return this.cache
  }

  private writeSnapshot (snapshot: ScheduledTaskStoreSnapshot): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(snapshot, null, 2), 'utf-8')
      this.cache = snapshot
    } catch (error) {
      console.error('[scheduled-task-store] Failed to write snapshot:', (error as Error).message)
      throw error
    }
  }

  getTasks (): ScheduledTaskDefinition[] {
    return this.readSnapshot().tasks
  }

  saveTasks (tasks: ScheduledTaskDefinition[]): void {
    const snapshot = this.readSnapshot()
    this.writeSnapshot({
      ...snapshot,
      tasks: normalizeSnapshot({ tasks }).tasks
    })
  }

  getReports (): ScheduledTaskRunReport[] {
    return this.readSnapshot().reports
  }

  saveReports (reports: ScheduledTaskRunReport[]): void {
    const snapshot = this.readSnapshot()
    this.writeSnapshot({
      ...snapshot,
      reports: normalizeSnapshot({ reports }).reports
    })
  }
}
