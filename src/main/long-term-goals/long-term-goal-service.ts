import crypto from 'node:crypto'
import type { LongTermGoalStore } from '../settings/long-term-goal-store.js'
import type { ScheduledTaskDefinition, ScheduledTaskRunReport } from '../settings/scheduled-task-store.js'
import type { ScheduledTaskService } from '../scheduler/scheduled-task-service.js'
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
  LongTermGoalRun,
  LongTermGoalSaveInput,
  LongTermGoalSchedule,
  LongTermGoalSnapshot
} from '../../shared/long-term-goal-types.js'

interface LongTermGoalServiceOptions {
  store: LongTermGoalStore
  scheduledTaskService: ScheduledTaskService
  onGoalsChanged?: (goals: LongTermGoalDefinition[]) => void
  onSnapshotChanged?: (snapshot: LongTermGoalSnapshot) => void
  onInterventionRequested?: (goal: LongTermGoalDefinition, intervention: LongTermGoalIntervention) => void
}

interface ParsedGoalRunResult {
  progressSummary: string
  gapToGoal: string
  nextPlan: string[]
  completedItems: string[]
  importantAchievements: string[]
  learnedSkills: string[]
  blockers: string[]
  needsUserInput: boolean
  userQuestions: Array<{ id?: string; question: string; options?: string[]; reason?: string }>
  notificationLevel: 'silent' | 'badge' | 'notify'
  memoryUpdates: Array<{ kind?: LongTermGoalMemoryEntry['kind']; title: string; content: string; importance?: number }>
}

const MAX_RUN_HISTORY = 120
const MAX_REVIEW_HISTORY = 180
const MAX_ACTIVITY_HISTORY = 600
const MAX_CONVERSATION_HISTORY = 200
const MAX_MEMORY_ENTRIES = 80
const RECENT_CONTEXT_LIMIT = 8
const EXECUTION_BRIEF_TITLE = '长期目标执行记忆包'
const LONG_TERM_GOAL_TASK_MARKER = '[LongTermGoal]'
const LONG_TERM_GOAL_REVIEW_MARKER = '[LongTermGoalReview]'

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

function toScheduledSchedule (schedule: LongTermGoalSchedule): ScheduledTaskDefinition['schedule'] {
  return clone(schedule) as ScheduledTaskDefinition['schedule']
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

function parseGoalRunResult (resultText: string, fallbackTitle: string): ParsedGoalRunResult {
  const parsed = extractJsonObject(resultText)
  if (!parsed) {
    const summary = compactText(resultText || fallbackTitle, 360)
    return {
      progressSummary: summary || '本次执行已结束。',
      gapToGoal: '尚未提取到结构化差距分析，请在下一次执行中继续归纳。',
      nextPlan: [],
      completedItems: summary ? [summary] : [],
      importantAchievements: summary ? [summary] : [],
      learnedSkills: [],
      blockers: [],
      needsUserInput: false,
      userQuestions: [],
      notificationLevel: 'silent',
      memoryUpdates: summary
        ? [{ kind: 'progress_summary', title: '执行摘要', content: summary, importance: 0.55 }]
        : []
    }
  }

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
    progressSummary: normalizeString(parsed.progressSummary) || compactText(resultText, 360) || '本次执行已结束。',
    gapToGoal: normalizeString(parsed.gapToGoal) || normalizeString(parsed.gapAnalysis) || '本次未发现新的关键差距。',
    nextPlan: normalizeStringArray(parsed.nextPlan),
    completedItems: normalizeStringArray(parsed.completedItems),
    importantAchievements: normalizeStringArray(parsed.importantAchievements),
    learnedSkills: normalizeStringArray(parsed.learnedSkills),
    blockers: normalizeStringArray(parsed.blockers),
    needsUserInput: parsed.needsUserInput === true,
    userQuestions,
    notificationLevel,
    memoryUpdates: parsedMemoryUpdates
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

  constructor (private readonly options: LongTermGoalServiceOptions) {}

  start (): void {
    this.snapshot = this.options.store.getSnapshot()
    this.snapshot.goals = this.snapshot.goals.map(goal => this.ensureScheduledTask(this.syncGoalScheduleState(goal)))
    this.persistAndEmit()
    this.reconcileScheduledReports(this.options.scheduledTaskService.listReports())
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

  appendGoalMessage (goalId: string, content: string): LongTermGoalMessageResult {
    const goal = this.getGoalOrThrow(goalId)
    const text = normalizeString(content)
    if (!text) throw new Error('请输入要调整的内容')

    const userTurn: LongTermGoalConversationTurn = {
      id: generateId('goal_turn'),
      goalId,
      role: 'user',
      content: text,
      createdAt: nowIso(),
      appliedChangeId: null
    }
    this.snapshot.conversations.unshift(userTurn)

    const changeSet = this.buildHeuristicChangeSet(goal, userTurn)
    if (changeSet) {
      this.snapshot.changeSets.unshift(changeSet)
    } else {
      this.writeMemory(goalId, {
        kind: 'decision',
        title: '用户补充',
        content: text,
        importance: 0.7
      })
      this.addActivity({
        goalId,
        actor: 'user',
        type: 'user_decision',
        title: '用户补充了目标上下文',
        summary: compactText(text, 180),
        details: text
      })
    }

    const assistantContent = changeSet
      ? `我整理了一个变更预览：${changeSet.summary}。确认后会应用到这个长期目标。`
      : '收到，我会把这条补充作为后续推进和每日总结的上下文。'
    const assistantTurn: LongTermGoalConversationTurn = {
      id: generateId('goal_turn'),
      goalId,
      role: 'assistant',
      content: assistantContent,
      createdAt: nowIso(),
      appliedChangeId: changeSet?.id || null
    }
    this.snapshot.conversations.unshift(assistantTurn)
    this.refreshExecutionBrief(goalId)
    this.trimCollections()
    this.persistAndEmit()

    return {
      turn: clone(userTurn),
      assistantTurn: clone(assistantTurn),
      changeSet: changeSet ? clone(changeSet) : null,
      goal: this.getGoal(goalId)!
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

  answerIntervention (
    goalId: string,
    interventionId: string,
    answers: Array<{ questionId: string; selectedOption?: string | null; customAnswer?: string | null }>
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
    return this.getGoal(goalId)!
  }

  resolveScheduledTaskPrompt (task: ScheduledTaskDefinition): string | undefined {
    const goal = this.snapshot.goals.find(item => item.scheduleTaskId === task.id || item.reviewScheduleTaskId === task.id)
    if (!goal) return undefined
    return task.id === goal.reviewScheduleTaskId ? this.buildDailyReviewPrompt(goal) : this.buildExecutionPrompt(goal)
  }

  shouldNotifyScheduledReport (report: ScheduledTaskRunReport): boolean | undefined {
    const goal = this.snapshot.goals.find(item => item.scheduleTaskId === report.taskId || item.reviewScheduleTaskId === report.taskId)
    if (!goal) return undefined
    if (report.status === 'failed') return true
    if (goal.notificationPolicy === 'normal') return true
    const result = parseGoalRunResult(report.resultText || '', goal.title)
    return result.notificationLevel === 'notify' || result.needsUserInput || result.blockers.length > 0
  }

  reconcileScheduledReports (reports: ScheduledTaskRunReport[]): void {
    let changed = false
    for (const report of reports) {
      const goal = this.snapshot.goals.find(item => item.scheduleTaskId === report.taskId || item.reviewScheduleTaskId === report.taskId)
      if (!goal) continue
      const existingRun = this.snapshot.runs.find(item => item.scheduledReportId === report.id)
      if (existingRun?.status === 'completed' || existingRun?.status === 'failed') continue

      if (report.status === 'running' || report.status === 'retrying') {
        if (!existingRun) {
          this.snapshot.runs.unshift({
            id: generateId('goal_run'),
            goalId: goal.id,
            scheduledReportId: report.id,
            status: 'running',
            startedAt: report.startedAt,
            finishedAt: null,
            progressSummary: '正在执行长期目标。',
            gapToGoal: '',
            notificationLevel: 'silent',
            createdAt: report.startedAt,
            updatedAt: nowIso()
          })
          this.addActivity({
            goalId: goal.id,
            runId: report.id,
            actor: 'system',
            type: 'run_started',
            title: '自动执行开始',
            summary: report.trigger === 'manual' ? '用户手动启动了长期目标。' : '长期目标按计划自动开始执行。'
          })
          this.upsertGoal({
            ...goal,
            lastRunStatus: 'running',
            updatedAt: nowIso()
          })
          changed = true
        }
        continue
      }

      if (report.status === 'completed') {
        this.finishCompletedReport(goal, report, existingRun)
        changed = true
        continue
      }

      if (report.status === 'failed') {
        this.finishFailedReport(goal, report, existingRun)
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
    const parsed = parseGoalRunResult(report.resultText || report.summary, goal.title)
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
      resultText: report.resultText || report.summary,
      notificationLevel: parsed.notificationLevel,
      createdAt: existingRun?.createdAt || report.startedAt,
      updatedAt: nowIso()
    }
    this.upsertRun(run)

    const nextTasks = this.buildNextTasks(goal, parsed.nextPlan)
    const intervention = this.buildIntervention(goal.id, parsed)
    const updatedGoal: LongTermGoalDefinition = this.syncGoalScheduleState({
      ...goal,
      lastRunAt: finishedAt,
      lastReviewAt: finishedAt,
      lastRunStatus: 'completed',
      progressSummary: parsed.progressSummary,
      gapSummary: parsed.gapToGoal,
      currentPhase: parsed.blockers.length > 0 ? '等待处理阻塞' : (goal.currentPhase || '持续推进'),
      nextTasks,
      openInterventions: intervention
        ? [intervention, ...goal.openInterventions.filter(item => item.status === 'open')]
        : goal.openInterventions,
      updatedAt: nowIso()
    })
    this.upsertGoal(updatedGoal)

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
      details: report.resultText || report.summary,
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
      this.options.onInterventionRequested?.(updatedGoal, intervention)
    }
    this.refreshExecutionBrief(goal.id)
    this.compactGoalMemory(goal.id)
  }

  private finishFailedReport (goal: LongTermGoalDefinition, report: ScheduledTaskRunReport, existingRun?: LongTermGoalRun): void {
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
    this.upsertGoal(this.syncGoalScheduleState({
      ...goal,
      lastRunAt: finishedAt,
      lastRunStatus: 'failed',
      currentPhase: '遇到阻塞',
      gapSummary: summary,
      openInterventions: [intervention, ...goal.openInterventions],
      updatedAt: nowIso()
    }))
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
      '## 本次要求',
      '- 先判断离目标最近的有效下一步，然后推进实际任务。',
      '- 必须利用执行记忆包，避免重复做已经完成的工作，并沿用已验证有效的方法。',
      '- 完成后总结今天干了什么、正在推进什么、接下来要做什么。',
      '- 把本次产生的关键成果写入 importantAchievements；把可复用方法、工具使用经验、项目约束、踩坑结论写入 learnedSkills。',
      '- 明确指出距离目标还有哪些差距。',
      '- 只有需要用户决定、授权、补信息、或遇到阻塞时，才把 needsUserInput 设为 true 或 notificationLevel 设为 notify。',
      '- 输出必须是严格 JSON，不要包裹 Markdown 代码块。',
      '',
      'JSON schema:',
      JSON.stringify({
        progressSummary: '今天完成了什么和当前状态，一两句话',
        gapToGoal: '距离目标仍缺什么，以及为什么重要',
        nextPlan: ['下一步任务 1', '下一步任务 2'],
        completedItems: ['本次完成项'],
        importantAchievements: ['对后续有复用价值的重要成果'],
        learnedSkills: ['本次学到的技能、方法、工具经验、项目约束或踩坑结论'],
        blockers: ['阻塞点，没有则空数组'],
        needsUserInput: false,
        userQuestions: [{ id: 'q1', question: '需要用户决定的问题', options: ['选项 A', '选项 B'], reason: '为什么需要用户' }],
        notificationLevel: 'silent',
        memoryUpdates: [{ kind: 'progress_summary', title: '记忆标题', content: '长期可复用的信息', importance: 0.7 }]
      }, null, 2)
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
      '输出严格 JSON，不要 Markdown。请根据今天进展刷新关键成果、技能方法和下一步计划，避免重复推进已经完成的事：',
      JSON.stringify({
        progressSummary: '今天整体进展和当前状态',
        gapToGoal: '距离目标仍缺什么，以及为什么重要',
        nextPlan: ['下一步任务 1', '下一步任务 2'],
        completedItems: ['今天完成项'],
        importantAchievements: ['今天沉淀的重要成果'],
        learnedSkills: ['今天学到的技能、方法、工具经验、项目约束或踩坑结论'],
        blockers: ['阻塞点，没有则空数组'],
        needsUserInput: false,
        userQuestions: [{ id: 'q1', question: '需要用户决定的问题', options: ['选项 A', '选项 B'], reason: '为什么需要用户' }],
        notificationLevel: 'silent',
        memoryUpdates: [{ kind: 'daily_review', title: '每日总结', content: '长期可复用的复盘摘要', importance: 0.7 }]
      }, null, 2)
    ].join('\n')
  }

  private ensureScheduledTask (goal: LongTermGoalDefinition): LongTermGoalDefinition {
    const now = nowIso()
    const enabled = goal.status === 'active'
    const tasks = this.options.scheduledTaskService.listTasks()
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
      createdBy: 'ai',
      prompt: this.buildExecutionPrompt(goal),
      schedule: toScheduledSchedule(goal.schedule),
      providerId: goal.providerId || null,
      modelId: goal.modelId || null,
      selectedSkillIds: [...goal.selectedSkillIds],
      selectedMcpServerIds: [...goal.selectedMcpServerIds],
      retryPolicy: existingTask?.retryPolicy || { maxRetries: 1, retryDelayMinutes: 10 },
      createdAt: existingTask?.createdAt || goal.createdAt || now,
      updatedAt: now,
      nextRunAt: existingTask?.nextRunAt || null,
      retryScheduledAt: existingTask?.retryScheduledAt || null,
      lastRunAt: existingTask?.lastRunAt || null,
      lastStatus: existingTask?.lastStatus || 'idle',
      lastReportId: existingTask?.lastReportId || null
    }
    const savedTask = this.options.scheduledTaskService.saveTask(task)
    const reviewTask: ScheduledTaskDefinition = {
      id: existingReviewTask?.id || goal.reviewScheduleTaskId || generateId('task_goal_review'),
      title: `${LONG_TERM_GOAL_REVIEW_MARKER} ${goal.title}`,
      enabled,
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
    const savedReviewTask = this.options.scheduledTaskService.saveTask(reviewTask)
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
    const tasks = this.options.scheduledTaskService.listTasks()
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
