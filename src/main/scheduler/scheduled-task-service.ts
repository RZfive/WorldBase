import crypto from 'node:crypto'
import { Notification, type BrowserWindow } from 'electron'
import { AIEngine, type AIConfigInput, type ProgressEvent } from '../ai-engine/ai-engine.js'
import type { SkillStore } from '../settings/skill-store.js'
import {
  ScheduledTaskStore,
  type ScheduledTaskDefinition,
  type ScheduledTaskProgressEntry,
  type ScheduledTaskRunReport,
  type ScheduledTaskStatus,
  type ScheduledTaskTrigger
} from '../settings/scheduled-task-store.js'

interface ScheduledTaskServiceOptions {
  store: ScheduledTaskStore
  aiEngine: AIEngine
  skillStore?: SkillStore
  getMainWindow?: () => BrowserWindow | null
  resolveProviderConfig?: () => AIConfigInput | undefined
  getNotificationPreference?: () => boolean
  onTasksChanged?: (tasks: ScheduledTaskDefinition[]) => void
  onReportsChanged?: (reports: ScheduledTaskRunReport[]) => void
  onReportNotificationClick?: (report: ScheduledTaskRunReport) => void
}

interface ScheduledTaskExecutionContext {
  trigger: ScheduledTaskTrigger
  consumeSchedule: boolean
  attempt: number
  scheduledFor?: string | null
}

const MAX_REPORT_HISTORY = 200
const REPORT_SUMMARY_MAX_LENGTH = 180

function clone<T> (value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeString (value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeIsoDate (value?: string | null): string | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return new Date(timestamp).toISOString()
}

function toPlainText (value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const text = (part as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildSummary (resultText: string, fallback: string): string {
  const source = resultText || fallback
  if (source.length <= REPORT_SUMMARY_MAX_LENGTH) return source
  return `${source.slice(0, REPORT_SUMMARY_MAX_LENGTH)}...`
}

function sortTasks (tasks: ScheduledTaskDefinition[]): ScheduledTaskDefinition[] {
  return [...tasks].sort((left, right) => {
    const leftNext = normalizeIsoDate(left.retryScheduledAt || left.nextRunAt)
    const rightNext = normalizeIsoDate(right.retryScheduledAt || right.nextRunAt)
    if (leftNext && rightNext && leftNext !== rightNext) {
      return leftNext.localeCompare(rightNext)
    }
    if (leftNext && !rightNext) return -1
    if (!leftNext && rightNext) return 1
    return left.title.localeCompare(right.title, 'zh-CN')
  })
}

function sortReports (reports: ScheduledTaskRunReport[]): ScheduledTaskRunReport[] {
  return [...reports].sort((left, right) => right.startedAt.localeCompare(left.startedAt))
}

export class ScheduledTaskService {
  private tasks: ScheduledTaskDefinition[] = []
  private reports: ScheduledTaskRunReport[] = []
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly runningTaskIds = new Set<string>()

  constructor (private readonly options: ScheduledTaskServiceOptions) {}

  start (): void {
    this.tasks = sortTasks(this.options.store.getTasks()).map(task => this.resolvePersistedTask(task))
    this.reports = sortReports(this.options.store.getReports()).slice(0, MAX_REPORT_HISTORY)
    this.persistTasks()
    this.persistReports()
    this.emitTasksChanged()
    this.emitReportsChanged()

    for (const task of this.tasks) {
      this.scheduleTask(task)
    }
  }

  dispose (): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.runningTaskIds.clear()
  }

  listTasks (): ScheduledTaskDefinition[] {
    return clone(sortTasks(this.tasks))
  }

  listReports (taskId?: string): ScheduledTaskRunReport[] {
    const filtered = taskId
      ? this.reports.filter(report => report.taskId === taskId)
      : this.reports
    return clone(sortReports(filtered))
  }

  getReport (reportId: string): ScheduledTaskRunReport | null {
    const report = this.reports.find(item => item.id === reportId)
    return report ? clone(report) : null
  }

  saveTask (input: ScheduledTaskDefinition): ScheduledTaskDefinition {
    const existing = this.tasks.find(task => task.id === input.id)
    if (existing && this.runningTaskIds.has(existing.id)) {
      throw new Error('任务正在执行中，暂不支持编辑')
    }

    const now = new Date().toISOString()
    const scheduleChanged = existing ? JSON.stringify(existing.schedule) !== JSON.stringify(input.schedule) : true
    const enabledChanged = existing ? existing.enabled !== input.enabled : false
    const id = normalizeString(input.id) || `task_${crypto.randomUUID()}`
    const candidate: ScheduledTaskDefinition = {
      id,
      title: normalizeString(input.title),
      enabled: input.enabled !== false,
      createdBy: input.createdBy === 'ai' ? 'ai' : 'manual',
      prompt: normalizeString(input.prompt),
      schedule: input.schedule,
      selectedSkillIds: Array.isArray(input.selectedSkillIds) ? input.selectedSkillIds : [],
      selectedMcpServerIds: Array.isArray(input.selectedMcpServerIds) ? input.selectedMcpServerIds : [],
      retryPolicy: input.retryPolicy,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      nextRunAt: existing?.nextRunAt || null,
      retryScheduledAt: (!existing || scheduleChanged || enabledChanged) ? null : (existing.retryScheduledAt || null),
      lastRunAt: existing?.lastRunAt || null,
      lastStatus: existing?.lastStatus || 'idle',
      lastReportId: existing?.lastReportId || null
    }

    const nextTasks = existing
      ? this.tasks.map(task => task.id === existing.id ? candidate : task)
      : [...this.tasks, candidate]

    this.options.store.saveTasks(nextTasks)
    const savedTask = this.options.store.getTasks().find(task => task.id === id)
    if (!savedTask) {
      throw new Error('保存定时任务失败，任务配置无效')
    }

    const resolvedTask = this.resolveSavedTask(savedTask, existing, scheduleChanged || enabledChanged)
    this.tasks = sortTasks(this.options.store.getTasks().map(task => task.id === id ? resolvedTask : this.resolvePersistedTask(task)))
    this.persistTasks()
    this.emitTasksChanged()
    this.scheduleTask(resolvedTask)
    return clone(resolvedTask)
  }

  deleteTask (taskId: string): boolean {
    const task = this.tasks.find(item => item.id === taskId)
    if (!task) return false
    if (this.runningTaskIds.has(taskId)) {
      throw new Error('任务正在执行中，无法删除')
    }

    this.clearTaskTimer(taskId)
    this.tasks = this.tasks.filter(item => item.id !== taskId)
    this.reports = this.reports.filter(report => report.taskId !== taskId)
    this.persistTasks()
    this.persistReports()
    this.emitTasksChanged()
    this.emitReportsChanged()
    return true
  }

  runNow (taskId: string): ScheduledTaskRunReport {
    const task = this.getTaskOrThrow(taskId)
    if (this.runningTaskIds.has(taskId)) {
      throw new Error('任务正在执行中，请稍后重试')
    }

    const report = this.createReport(task, {
      trigger: 'manual',
      consumeSchedule: false,
      attempt: 1,
      scheduledFor: null
    })

    void this.executeTask(task.id, {
      trigger: 'manual',
      consumeSchedule: false,
      attempt: 1,
      scheduledFor: null
    }, report.id)

    return clone(report)
  }

  private getTaskOrThrow (taskId: string): ScheduledTaskDefinition {
    const task = this.tasks.find(item => item.id === taskId)
    if (!task) {
      throw new Error(`未找到定时任务: ${taskId}`)
    }
    return task
  }

  private resolvePersistedTask (task: ScheduledTaskDefinition): ScheduledTaskDefinition {
    if (this.runningTaskIds.has(task.id)) return task
    const nextRunAt = task.nextRunAt || this.computeInitialNextRun(task)
    return {
      ...task,
      nextRunAt,
      retryScheduledAt: task.retryScheduledAt || null,
      lastStatus: task.lastStatus || 'idle',
      lastReportId: task.lastReportId || null
    }
  }

  private resolveSavedTask (
    task: ScheduledTaskDefinition,
    existing?: ScheduledTaskDefinition,
    shouldRecomputeNextRun = false
  ): ScheduledTaskDefinition {
    const nextRunAt = shouldRecomputeNextRun
      ? this.computeInitialNextRun({
          ...task,
          lastRunAt: existing?.lastRunAt || task.lastRunAt || null
        })
      : (task.nextRunAt || existing?.nextRunAt || this.computeInitialNextRun(task))

    return {
      ...task,
      nextRunAt,
      retryScheduledAt: shouldRecomputeNextRun ? null : (task.retryScheduledAt || existing?.retryScheduledAt || null),
      lastRunAt: existing?.lastRunAt || task.lastRunAt || null,
      lastStatus: existing?.lastStatus || task.lastStatus || 'idle',
      lastReportId: existing?.lastReportId || task.lastReportId || null
    }
  }

  private computeInitialNextRun (task: ScheduledTaskDefinition): string | null {
    const now = Date.now()
    if (task.schedule.kind === 'once') {
      const runAt = normalizeIsoDate(task.schedule.runAt)
      if (!runAt) return null
      const lastRunAt = normalizeIsoDate(task.lastRunAt)
      if (lastRunAt && Date.parse(lastRunAt) >= Date.parse(runAt)) return null
      return runAt
    }

    if (task.schedule.kind === 'dates') {
      const lastRunAt = normalizeIsoDate(task.lastRunAt)
      const lastRunAtMs = lastRunAt ? Date.parse(lastRunAt) : Number.NEGATIVE_INFINITY
      const nextDate = task.schedule.dates.find(date => Date.parse(date) > lastRunAtMs)
      return nextDate || null
    }

    const startAt = normalizeIsoDate(task.schedule.startAt)
    if (startAt && Date.parse(startAt) > now) {
      return startAt
    }
    return new Date(now).toISOString()
  }

  private computeNextRunAfterExecution (task: ScheduledTaskDefinition, referenceAt: string): string | null {
    if (task.schedule.kind === 'once') {
      return null
    }

    if (task.schedule.kind === 'dates') {
      const referenceMs = Date.parse(referenceAt)
      return task.schedule.dates.find(date => Date.parse(date) > referenceMs) || null
    }

    return new Date(Date.parse(referenceAt) + task.schedule.everyMinutes * 60 * 1000).toISOString()
  }

  private clearTaskTimer (taskId: string): void {
    const timer = this.timers.get(taskId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(taskId)
    }
  }

  private scheduleTask (task: ScheduledTaskDefinition): void {
    this.clearTaskTimer(task.id)
    if (!task.enabled || this.runningTaskIds.has(task.id) || task.retryScheduledAt) {
      return
    }

    const scheduledFor = normalizeIsoDate(task.nextRunAt)
    if (!scheduledFor) {
      return
    }

    const delay = Math.max(0, Date.parse(scheduledFor) - Date.now())
    const timer = setTimeout(() => {
      this.timers.delete(task.id)
      const latestTask = this.tasks.find(item => item.id === task.id)
      if (!latestTask || this.runningTaskIds.has(task.id)) return
      const report = this.createReport(latestTask, {
        trigger: 'schedule',
        consumeSchedule: true,
        attempt: 1,
        scheduledFor
      })
      void this.executeTask(task.id, {
        trigger: 'schedule',
        consumeSchedule: true,
        attempt: 1,
        scheduledFor
      }, report.id)
    }, delay)

    this.timers.set(task.id, timer)
  }

  private scheduleRetry (task: ScheduledTaskDefinition, retryAt: string, context: ScheduledTaskExecutionContext): void {
    this.clearTaskTimer(task.id)
    const timer = setTimeout(() => {
      this.timers.delete(task.id)
      const latestTask = this.tasks.find(item => item.id === task.id)
      if (!latestTask) return
      const report = this.createReport(latestTask, context)
      void this.executeTask(task.id, context, report.id)
    }, Math.max(0, Date.parse(retryAt) - Date.now()))

    this.timers.set(task.id, timer)
  }

  private createReport (task: ScheduledTaskDefinition, context: ScheduledTaskExecutionContext): ScheduledTaskRunReport {
    const now = new Date().toISOString()
    const report: ScheduledTaskRunReport = {
      id: `task_report_${crypto.randomUUID()}`,
      taskId: task.id,
      taskTitle: task.title,
      trigger: context.trigger,
      status: context.attempt > 1 ? 'retrying' : 'running',
      scheduledFor: context.scheduledFor || null,
      startedAt: now,
      finishedAt: null,
      attempt: context.attempt,
      prompt: task.prompt,
      summary: context.attempt > 1 ? '任务正在重试执行' : '任务开始执行',
      resultText: '',
      progress: [],
      selectedSkillIds: [...task.selectedSkillIds],
      selectedMcpServerIds: [...task.selectedMcpServerIds],
      retryScheduledAt: null,
      createdAt: now,
      updatedAt: now
    }

    this.reports = sortReports([report, ...this.reports]).slice(0, MAX_REPORT_HISTORY)
    this.persistReports()
    this.emitReportsChanged()
    return report
  }

  private updateReport (reportId: string, updater: (report: ScheduledTaskRunReport) => void): ScheduledTaskRunReport {
    const nextReports = this.reports.map(report => {
      if (report.id !== reportId) return report
      const nextReport = clone(report)
      updater(nextReport)
      nextReport.updatedAt = new Date().toISOString()
      return nextReport
    })
    this.reports = sortReports(nextReports).slice(0, MAX_REPORT_HISTORY)
    this.persistReports()
    this.emitReportsChanged()
    return this.reports.find(report => report.id === reportId)!
  }

  private updateTask (taskId: string, updater: (task: ScheduledTaskDefinition) => ScheduledTaskDefinition): ScheduledTaskDefinition {
    const nextTasks = this.tasks.map(task => task.id === taskId ? updater(clone(task)) : task)
    this.tasks = sortTasks(nextTasks)
    this.persistTasks()
    this.emitTasksChanged()
    return this.tasks.find(task => task.id === taskId)!
  }

  private async executeTask (taskId: string, context: ScheduledTaskExecutionContext, reportId: string): Promise<void> {
    const task = this.getTaskOrThrow(taskId)
    if (this.runningTaskIds.has(taskId)) {
      return
    }

    this.clearTaskTimer(taskId)
    this.runningTaskIds.add(taskId)
    this.updateTask(taskId, (currentTask) => ({
      ...currentTask,
      lastStatus: context.attempt > 1 ? 'retrying' : 'running',
      retryScheduledAt: null,
      lastReportId: reportId
    }))

    const progress: ScheduledTaskProgressEntry[] = []
    const appendProgress = (stage: string, detail?: string) => {
      const entry: ScheduledTaskProgressEntry = {
        at: new Date().toISOString(),
        stage,
        detail: detail || undefined
      }
      progress.push(entry)
      this.updateReport(reportId, (report) => {
        report.progress = [...progress]
      })
    }

    const onProgress = (stageOrEvent: string | ProgressEvent, detail?: string) => {
      if (typeof stageOrEvent === 'string') {
        appendProgress(stageOrEvent, detail)
        return
      }

      if (stageOrEvent.type === 'progress') {
        appendProgress(stageOrEvent.stage, stageOrEvent.detail)
        return
      }

      if (stageOrEvent.type === 'todo_update') {
        const completed = stageOrEvent.items.filter(item => item.status === 'completed').length
        const inProgress = stageOrEvent.items.find(item => item.status === 'in-progress')
        appendProgress('更新 Todo', `共 ${stageOrEvent.items.length} 项，已完成 ${completed} 项${inProgress ? `，进行中：${inProgress.title}` : ''}`)
        return
      }

      if (stageOrEvent.type === 'file_preview_start') {
        appendProgress('生成文件预览', stageOrEvent.filePath)
        return
      }

      if (stageOrEvent.type === 'web_search_result') {
        appendProgress('返回网页搜索结果', `${stageOrEvent.query} · ${stageOrEvent.results.length} 条结果`)
        return
      }

      if (stageOrEvent.type === 'web_fetch_result') {
        appendProgress('抓取网页内容', stageOrEvent.result.url)
      }
    }

    let resultText = ''
    let finalTaskStatus: ScheduledTaskStatus = 'completed'

    try {
      const activeSkillContents = task.selectedSkillIds
        .map(skillId => this.options.skillStore?.get(skillId)?.content || '')
        .filter(Boolean)

      for await (const event of this.options.aiEngine.chatStream([
        { role: 'user', content: task.prompt }
      ], onProgress, {
        providerConfig: this.options.resolveProviderConfig?.(),
        authMode: 'auto',
        activeSkillContents,
        allowedMcpServerIds: task.selectedMcpServerIds
      })) {
        if (event.type === 'done') {
          resultText = toPlainText(event.message?.content)
        }
      }

      const finishedAt = new Date().toISOString()
      const summary = buildSummary(resultText, '任务执行完成')
      this.updateReport(reportId, (report) => {
        report.status = 'completed'
        report.finishedAt = finishedAt
        report.retryScheduledAt = null
        report.summary = summary
        report.resultText = resultText
      })

      const updatedTask = this.updateTask(taskId, (currentTask) => {
        const nextRunAt = context.consumeSchedule
          ? this.computeNextRunAfterExecution(currentTask, context.scheduledFor || finishedAt)
          : (currentTask.nextRunAt || this.computeInitialNextRun(currentTask))

        return {
          ...currentTask,
          enabled: currentTask.schedule.kind === 'interval' ? currentTask.enabled : (context.consumeSchedule ? Boolean(nextRunAt) : currentTask.enabled),
          nextRunAt,
          retryScheduledAt: null,
          lastRunAt: finishedAt,
          lastStatus: 'completed',
          lastReportId: reportId
        }
      })

      this.notifyCompletion(this.getReport(reportId)!)
      this.scheduleTask(updatedTask)
    } catch (error) {
      const errorMessage = (error as Error).message || '任务执行失败'
      const taskForRetry = this.getTaskOrThrow(taskId)
      const shouldRetry = context.attempt <= taskForRetry.retryPolicy.maxRetries
      const finishedAt = new Date().toISOString()

      if (shouldRetry) {
        const retryAt = new Date(Date.now() + taskForRetry.retryPolicy.retryDelayMinutes * 60 * 1000).toISOString()
        this.updateReport(reportId, (report) => {
          report.status = 'retrying'
          report.finishedAt = finishedAt
          report.error = errorMessage
          report.retryScheduledAt = retryAt
          report.summary = `执行失败，将在 ${taskForRetry.retryPolicy.retryDelayMinutes} 分钟后重试`
        })

        const retryTask = this.updateTask(taskId, (currentTask) => ({
          ...currentTask,
          retryScheduledAt: retryAt,
          lastStatus: 'retrying',
          lastReportId: reportId
        }))

        this.scheduleRetry(retryTask, retryAt, {
          ...context,
          attempt: context.attempt + 1
        })
      } else {
        finalTaskStatus = 'failed'
        const summary = buildSummary('', errorMessage)
        this.updateReport(reportId, (report) => {
          report.status = 'failed'
          report.finishedAt = finishedAt
          report.error = errorMessage
          report.retryScheduledAt = null
          report.summary = summary
          report.resultText = resultText
        })

        const updatedTask = this.updateTask(taskId, (currentTask) => {
          const nextRunAt = context.consumeSchedule
            ? this.computeNextRunAfterExecution(currentTask, context.scheduledFor || finishedAt)
            : (currentTask.nextRunAt || this.computeInitialNextRun(currentTask))

          return {
            ...currentTask,
            enabled: currentTask.schedule.kind === 'interval' ? currentTask.enabled : (context.consumeSchedule ? Boolean(nextRunAt) : currentTask.enabled),
            nextRunAt,
            retryScheduledAt: null,
            lastRunAt: finishedAt,
            lastStatus: 'failed',
            lastReportId: reportId
          }
        })

        this.notifyCompletion(this.getReport(reportId)!)
        this.scheduleTask(updatedTask)
      }
    } finally {
      this.runningTaskIds.delete(taskId)
      if (finalTaskStatus === 'completed' || finalTaskStatus === 'failed') {
        const latestTask = this.tasks.find(item => item.id === taskId)
        if (latestTask && !latestTask.retryScheduledAt) {
          this.scheduleTask(latestTask)
        }
      }
    }
  }

  private notifyCompletion (report: ScheduledTaskRunReport): void {
    if (!this.options.getNotificationPreference?.() || !Notification.isSupported()) {
      return
    }

    const title = report.status === 'completed'
      ? `定时任务已完成: ${report.taskTitle}`
      : `定时任务执行失败: ${report.taskTitle}`
    const body = report.status === 'completed'
      ? buildSummary(report.summary, '点击查看执行报告')
      : buildSummary(report.error || report.summary, '点击查看失败详情')

    const notification = new Notification({ title, body })
    notification.once('click', () => {
      const mainWindow = this.options.getMainWindow?.()
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow.show()
        mainWindow.focus()
      }
      this.options.onReportNotificationClick?.(clone(report))
    })
    notification.show()
  }

  private persistTasks (): void {
    this.options.store.saveTasks(this.tasks)
  }

  private persistReports (): void {
    this.options.store.saveReports(this.reports.slice(0, MAX_REPORT_HISTORY))
  }

  private emitTasksChanged (): void {
    this.options.onTasksChanged?.(this.listTasks())
  }

  private emitReportsChanged (): void {
    this.options.onReportsChanged?.(this.listReports())
  }
}