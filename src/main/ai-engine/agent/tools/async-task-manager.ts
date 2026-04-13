import crypto from 'node:crypto'
import type { BuilderService, BuildResult } from '../../../project-runtime/builder-service.js'

export type AsyncTaskType = 'rebuild'
export type AsyncTaskStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface AsyncTaskSnapshot {
  task_id: string
  project_id: string
  task: AsyncTaskType
  status: AsyncTaskStatus
  progress: {
    stage: string
    detail?: string
  }
  created_at: string
  started_at?: string
  completed_at?: string
  result?: BuildResult
  error?: string
}

interface AsyncTaskRecord {
  id: string
  projectId: string
  task: AsyncTaskType
  status: AsyncTaskStatus
  createdAt: string
  startedAt?: string
  completedAt?: string
  progressStage: string
  progressDetail?: string
  result?: BuildResult
  error?: string
}

export class AsyncTaskManager {
  private readonly tasks = new Map<string, AsyncTaskRecord>()
  private readonly activeTaskKeys = new Map<string, string>()
  private readonly maxTaskHistory = 100

  constructor (private readonly builderService: BuilderService) {}

  startTask (projectId: string, task: AsyncTaskType): AsyncTaskSnapshot {
    const taskKey = this.getTaskKey(projectId, task)
    const existingTaskId = this.activeTaskKeys.get(taskKey)
    if (existingTaskId) {
      const existing = this.tasks.get(existingTaskId)
      if (existing && (existing.status === 'queued' || existing.status === 'running')) {
        return this.toSnapshot(existing)
      }
    }

    const record: AsyncTaskRecord = {
      id: `${task}_${crypto.randomUUID()}`,
      projectId,
      task,
      status: 'queued',
      createdAt: new Date().toISOString(),
      progressStage: '任务已创建，等待执行'
    }

    this.tasks.set(record.id, record)
    this.activeTaskKeys.set(taskKey, record.id)
    this.trimHistory()

    void this.runTask(record)
    return this.toSnapshot(record)
  }

  getTask (taskId: string): AsyncTaskSnapshot | null {
    const task = this.tasks.get(taskId)
    return task ? this.toSnapshot(task) : null
  }

  private async runTask (task: AsyncTaskRecord): Promise<void> {
    task.status = 'running'
    task.startedAt = new Date().toISOString()
    task.progressStage = '正在重建项目'
    task.progressDetail = '执行依赖安装与构建流程'

    try {
      const result = await this.executeTask(task)
      task.result = result
      task.completedAt = new Date().toISOString()
      if (result.success) {
        task.status = 'completed'
        task.progressStage = '任务完成'
        task.progressDetail = `耗时 ${Math.round(result.duration / 1000)}s`
      } else {
        task.status = 'failed'
        task.error = result.error || '任务执行失败'
        task.progressStage = '任务失败'
        task.progressDetail = task.error
      }
    } catch (err) {
      task.status = 'failed'
      task.completedAt = new Date().toISOString()
      task.error = (err as Error).message
      task.progressStage = '任务失败'
      task.progressDetail = task.error
    } finally {
      this.activeTaskKeys.delete(this.getTaskKey(task.projectId, task.task))
      this.trimHistory()
    }
  }

  private async executeTask (task: AsyncTaskRecord): Promise<BuildResult> {
    if (task.task === 'rebuild') {
      return this.builderService.rebuild(task.projectId)
    }

    throw new Error(`Unsupported async task: ${task.task}`)
  }

  private trimHistory (): void {
    if (this.tasks.size <= this.maxTaskHistory) {
      return
    }

    const removableTasks = Array.from(this.tasks.values())
      .filter(task => task.status === 'completed' || task.status === 'failed')
      .sort((left, right) => left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0)

    while (this.tasks.size > this.maxTaskHistory && removableTasks.length > 0) {
      const task = removableTasks.shift()
      if (!task) break
      this.tasks.delete(task.id)
    }
  }

  private toSnapshot (task: AsyncTaskRecord): AsyncTaskSnapshot {
    return {
      task_id: task.id,
      project_id: task.projectId,
      task: task.task,
      status: task.status,
      progress: {
        stage: task.progressStage,
        detail: task.progressDetail
      },
      created_at: task.createdAt,
      started_at: task.startedAt,
      completed_at: task.completedAt,
      result: task.result,
      error: task.error
    }
  }

  private getTaskKey (projectId: string, task: AsyncTaskType): string {
    return `${projectId}:${task}`
  }
}
