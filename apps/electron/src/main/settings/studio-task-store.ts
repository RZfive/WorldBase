import fs from 'node:fs'
import path from 'node:path'
import type { ImageStudioGenerateRequest, ImageStudioTask, ImageStudioTaskStatus } from '../../shared/image-studio-types.js'

/**
 * StudioTaskStore — checkpoints the image-studio task queue to disk so that
 * failed (and still-queued) generation/edit tasks survive an app restart.
 *
 * Only `queued` and `error` tasks are persisted: `running` is transient (a task
 * interrupted by a quit can't be resumed — it must re-run) and `success`
 * results already live in the image library, so re-showing them in the queue
 * would just duplicate what the library panel already offers.
 *
 * The store is deliberately defensive: a corrupted or partially-written file
 * must never crash startup (see the long-term-goal regression), so every field
 * is normalized and any task that fails validation is dropped silently.
 */

const MAX_PERSISTED_TASKS = 200

interface PersistedStudioTask {
  id: string
  status: ImageStudioTaskStatus
  createdAt: number
  request: ImageStudioGenerateRequest
  label: string
  createdByAgent?: boolean
  error?: string
}

function isImageStudioTaskStatus (value: unknown): value is ImageStudioTaskStatus {
  return value === 'queued' || value === 'running' || value === 'success' || value === 'error'
}

function normalizeString (value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeStringArray (value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => normalizeString(item)).filter(item => item.length > 0)
    : []
}

function normalizeRequest (value: unknown): ImageStudioGenerateRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const mode = record.mode === 'edit' ? 'edit' : 'generate'
  const providerId = normalizeString(record.providerId)
  const model = normalizeString(record.model)
  const prompt = normalizeString(record.prompt)
  const size = normalizeString(record.size)
  // providerId/model/prompt/size are required for a re-runnable task; drop if missing.
  if (!providerId || !model || !prompt || !size) return null

  const quality = normalizeString(record.quality)
  const outputFormat = normalizeString(record.outputFormat)
  const n = typeof record.n === 'number' && Number.isFinite(record.n) && record.n > 0
    ? Math.floor(record.n)
    : undefined

  return {
    mode,
    providerId,
    model,
    prompt,
    negativePrompt: normalizeString(record.negativePrompt) || undefined,
    aspectRatio: normalizeString(record.aspectRatio) || undefined,
    size,
    quality: quality ? (quality as ImageStudioGenerateRequest['quality']) : undefined,
    outputFormat: outputFormat ? (outputFormat as ImageStudioGenerateRequest['outputFormat']) : undefined,
    n,
    folder: normalizeString(record.folder) || undefined,
    tags: Array.isArray(record.tags) ? normalizeStringArray(record.tags) : undefined,
    inputImages: Array.isArray(record.inputImages) ? normalizeStringArray(record.inputImages) : undefined
  }
}

function normalizePersistedTask (value: unknown): ImageStudioTask | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>

  const id = normalizeString(record.id)
  const status = isImageStudioTaskStatus(record.status) ? record.status : null
  const request = normalizeRequest(record.request)
  if (!id || !status || !request) return null

  // Only queued/error tasks are ever persisted; if a stale 'running'/'success'
  // row somehow survived on disk, drop it instead of resurrecting a stale state.
  if (status !== 'queued' && status !== 'error') return null

  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    ? record.createdAt
    : Date.now()
  const label = normalizeString(record.label) || request.prompt

  return {
    id,
    status,
    createdAt,
    request,
    label,
    createdByAgent: record.createdByAgent === true || undefined,
    inputPreview: request.mode === 'edit' ? request.inputImages?.[0] : undefined,
    entries: [],
    error: status === 'error' ? (normalizeString(record.error) || undefined) : undefined
  }
}

export class StudioTaskStore {
  private readonly filePath: string

  constructor (userDataPath: string) {
    this.filePath = path.join(userDataPath, 'studio-tasks.json')
  }

  load (): ImageStudioTask[] {
    try {
      if (!fs.existsSync(this.filePath)) return []
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      const list = Array.isArray(parsed) ? parsed : (Array.isArray((parsed as Record<string, unknown>)?.tasks) ? (parsed as Record<string, unknown[]>).tasks : [])
      const tasks = list
        .map(normalizePersistedTask)
        .filter((task): task is ImageStudioTask => task !== null)
        // Oldest-first so the renderer can unshift() them back in display order.
        .sort((a, b) => a.createdAt - b.createdAt)
      return tasks.slice(0, MAX_PERSISTED_TASKS)
    } catch (error) {
      console.error('[studio-task-store] Failed to load tasks:', (error as Error).message)
      return []
    }
  }

  save (tasks: ImageStudioTask[]): void {
    try {
      const persistable = tasks
        .filter(task => task.status === 'queued' || task.status === 'error')
        .map<PersistedStudioTask>(task => ({
          id: task.id,
          status: task.status,
          createdAt: task.createdAt,
          request: task.request,
          label: task.label,
          createdByAgent: task.createdByAgent,
          error: task.error
        }))
        .slice(0, MAX_PERSISTED_TASKS)

      fs.writeFileSync(this.filePath, JSON.stringify(persistable, null, 2), 'utf-8')
    } catch (error) {
      console.error('[studio-task-store] Failed to save tasks:', (error as Error).message)
    }
  }
}
