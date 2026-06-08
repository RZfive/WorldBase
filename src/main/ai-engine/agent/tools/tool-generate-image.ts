import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import type { SettingsStore } from '../../../settings/settings-store.js'
import type { ImageLibraryStore } from '../../../settings/image-library-store.js'
import type { ImageStudioGenerateRequest, ImageLibraryEntry } from '../../../../shared/image-studio-types.js'
import {
  ASPECT_RATIOS,
  MAX_IMAGES_PER_REQUEST,
  MAX_DIMENSION,
  MIN_DIMENSION,
  defaultSizeForRatio,
  listImageModels,
  normalizeSize,
  resolveImageModel,
  runImageStudioRequest
} from '../../../settings/image-generation-service.js'

interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

/** Source images per edit task may not exceed this (mirrors the studio UI). */
const MAX_INPUT_IMAGES = 4
/** Upper bound on tasks per call so a single tool call can't run away. */
const MAX_TASKS = 20
/** How many tasks run at once — matches the studio's concurrent-task limit. */
const TASK_CONCURRENCY = 2

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

function asString (value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asStringArray (value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
}

function asObjectArray (value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
}

function clampCount (value: unknown, fallback: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_IMAGES_PER_REQUEST, Math.max(1, n))
}

/** Run async work over items with a small concurrency cap, preserving order. */
async function mapWithConcurrency<T, R> (items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

/** Lightweight per-task outcome returned to the model (never inlines base64). */
interface TaskResult {
  index: number
  status: 'success' | 'error'
  prompt: string
  providerId?: string
  model?: string
  size?: string
  folder?: string
  imageCount?: number
  imageIds?: string[]
  imageUrls?: string[]
  inputNotes?: string[]
  error?: string
}

function entriesToResult (index: number, prompt: string, providerId: string, model: string, size: string, folder: string | undefined, entries: ImageLibraryEntry[], inputNotes?: string[]): TaskResult {
  return {
    index,
    status: 'success',
    prompt,
    providerId,
    model,
    size,
    folder,
    imageCount: entries.length,
    imageIds: entries.map(e => e.id),
    imageUrls: entries.map(e => e.fullUrl).filter((u): u is string => Boolean(u)),
    inputNotes: inputNotes?.length ? inputNotes : undefined
  }
}

function summarize (mode: 'generate' | 'edit', results: TaskResult[]): Record<string, unknown> {
  const succeeded = results.filter(r => r.status === 'success').length
  const failed = results.length - succeeded
  const verb = mode === 'edit' ? '图片编辑' : '图片生成'
  const folders = Array.from(new Set(results.filter(r => r.status === 'success' && r.folder).map(r => r.folder)))
  const folderNote = folders.length === 1 ? `「${folders[0]}」分组` : '图片库'
  return {
    ok: succeeded > 0,
    mode,
    total: results.length,
    succeeded,
    failed,
    message: `${verb}完成：成功 ${succeeded}/${results.length}${failed ? `，失败 ${failed}` : ''}。结果已存入${folderNote}，可在「绘制工作台 → 图片库」查看。`,
    results
  }
}

/* -------------------------------------------------------------------------- */
/* generate_image — batch text-to-image                                        */
/* -------------------------------------------------------------------------- */

export function toolGenerateImage (settingsStore: SettingsStore, imageLibraryStore: ImageLibraryStore, getAbortSignal?: () => AbortSignal | undefined): Tool {
  return {
    definition: {
      name: 'generate_image',
      description: [
        'Batch text-to-image generation, mirroring the drawing studio (绘制工作台) 文生图 form.',
        'Queue many prompts in one call to create a batch of images; every result is saved to the image library and visible under 绘制工作台 → 图片库.',
        'Controllable parameters match the studio: model, prompt, negative prompt, aspect ratio, size, and count (n).',
        'Provider/model are auto-selected from the first configured model with the 图片生成 capability when not specified; pass `model` (or `provider_id`) to pick a specific one.',
        'Use top-level fields as shared defaults applied to every task; per-task fields override them.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: `One entry per image-generation task (max ${MAX_TASKS}). Each becomes a separate library save.`,
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'Required. What to draw.' },
                negative_prompt: { type: 'string', description: 'Optional. Content to avoid (only some providers honor it).' },
                aspect_ratio: { type: 'string', enum: [...ASPECT_RATIOS], description: 'Optional aspect ratio preset. Used to derive size when no explicit size is given.' },
                size: { type: 'string', description: `Optional explicit pixel size "WxH" (each side ${MIN_DIMENSION}-${MAX_DIMENSION}). Overrides aspect_ratio.` },
                n: { type: 'integer', description: `Optional image count, 1-${MAX_IMAGES_PER_REQUEST}. Defaults to 1.` },
                model: { type: 'string', description: 'Optional model name override for this task.' },
                folder: { type: 'string', description: 'Optional image-library folder to file this task\'s images under.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags applied to this task\'s images.' }
              },
              required: ['prompt']
            }
          },
          provider_id: { type: 'string', description: 'Optional default provider id for all tasks.' },
          model: { type: 'string', description: 'Optional default model name for all tasks.' },
          aspect_ratio: { type: 'string', enum: [...ASPECT_RATIOS], description: 'Optional default aspect ratio for all tasks.' },
          size: { type: 'string', description: 'Optional default explicit size "WxH" for all tasks.' },
          n: { type: 'integer', description: `Optional default image count (1-${MAX_IMAGES_PER_REQUEST}) for all tasks.` },
          negative_prompt: { type: 'string', description: 'Optional default negative prompt for all tasks.' },
          folder: { type: 'string', description: 'Optional default image-library folder for all tasks (great for organizing a batch).' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional default tags for all tasks.' }
        },
        required: ['tasks']
      }
    },
    handler: async (args, onProgress) => {
      const rawTasks = asObjectArray(args.tasks)
      if (rawTasks.length === 0) {
        return { ok: false, error: 'tasks 不能为空，请提供至少一个包含 prompt 的生成任务。' }
      }
      if (listImageModels(settingsStore.getProviders(), 'generate').length === 0) {
        return { ok: false, error: '未找到支持图片生成的模型，请到「设置 → 供应商」为某个模型勾选「图片生成」能力并配置 API Key。' }
      }

      const tasks = rawTasks.slice(0, MAX_TASKS)
      const truncated = rawTasks.length - tasks.length
      const defaultModel = asString(args.model)
      const defaultProviderId = asString(args.provider_id)
      const defaultRatio = asString(args.aspect_ratio)
      const defaultSize = asString(args.size)
      const defaultNegative = asString(args.negative_prompt)
      const defaultFolder = asString(args.folder)
      const defaultTags = asStringArray(args.tags)
      const defaultN = args.n

      const results = await mapWithConcurrency(tasks, TASK_CONCURRENCY, async (task, index): Promise<TaskResult> => {
        const prompt = asString(task.prompt)
        if (!prompt) {
          return { index, status: 'error', prompt: '', error: 'prompt 不能为空。' }
        }
        try {
          const model = asString(task.model) || defaultModel
          const resolved = resolveImageModel(settingsStore.getProviders(), {
            mode: 'generate',
            providerId: defaultProviderId || undefined,
            model: model || undefined
          })

          const ratio = asString(task.aspect_ratio) || defaultRatio
          const explicitSize = asString(task.size) || defaultSize
          let size: string
          let aspectRatio: string | undefined
          if (explicitSize) {
            const normalized = normalizeSize(explicitSize)
            if (!normalized) {
              return { index, status: 'error', prompt, error: `尺寸 ${explicitSize} 无效（需 WxH，单边 ${MIN_DIMENSION}-${MAX_DIMENSION}）。` }
            }
            size = normalized
            aspectRatio = ratio || undefined
          } else {
            aspectRatio = ratio || '1:1'
            size = defaultSizeForRatio(aspectRatio)
          }

          const folder = asString(task.folder) || defaultFolder
          const tags = asStringArray(task.tags).length ? asStringArray(task.tags) : defaultTags

          onProgress?.('🎨 生成图片', `任务 ${index + 1}/${tasks.length}：${prompt.slice(0, 40)}`)

          const req: ImageStudioGenerateRequest = {
            providerId: resolved.providerId,
            model: resolved.model,
            mode: 'generate',
            prompt,
            negativePrompt: (asString(task.negative_prompt) || defaultNegative) || undefined,
            aspectRatio,
            size,
            n: clampCount(task.n ?? defaultN, 1),
            folder: folder || undefined,
            tags: tags.length ? tags : undefined
          }

          const response = await runImageStudioRequest(req, {
            getProvidersConfig: () => settingsStore.getProviders(),
            imageLibraryStore,
            abortSignal: getAbortSignal?.()
          })
          if (!response.ok) {
            return { index, status: 'error', prompt, error: response.error }
          }
          onProgress?.('✅ 生成完成', `任务 ${index + 1}/${tasks.length}`)
          return entriesToResult(index, prompt, resolved.providerId, resolved.model, size, folder || undefined, response.entries)
        } catch (error) {
          return { index, status: 'error', prompt, error: error instanceof Error ? error.message : '图片生成失败' }
        }
      })

      const summary = summarize('generate', results)
      if (truncated > 0) summary.note = `仅处理前 ${MAX_TASKS} 个任务，忽略了 ${truncated} 个。`
      return summary
    }
  }
}

/* -------------------------------------------------------------------------- */
/* edit_image — batch image editing                                           */
/* -------------------------------------------------------------------------- */

/** Read a local image file into a base64 data URL. */
async function fileToDataUrl (filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase()
  const mime = MIME_BY_EXT[ext]
  if (!mime) throw new Error(`不支持的图片格式：${ext || '(无扩展名)'}`)
  const buffer = await fsp.readFile(filePath)
  return `data:${mime};base64,${buffer.toString('base64')}`
}

/**
 * Resolve a task's input images (library ids → local paths → raw data URLs),
 * capped at MAX_INPUT_IMAGES. Returns the data URLs plus human-readable notes
 * about anything skipped, so the model can react to partial failures.
 */
async function resolveEditInputs (task: Record<string, unknown>, imageLibraryStore: ImageLibraryStore): Promise<{ images: string[]; notes: string[] }> {
  const images: string[] = []
  const notes: string[] = []
  const add = (dataUrl: string): boolean => {
    if (images.length >= MAX_INPUT_IMAGES) return false
    images.push(dataUrl)
    return true
  }

  for (const id of asStringArray(task.input_image_ids)) {
    if (images.length >= MAX_INPUT_IMAGES) break
    const data = imageLibraryStore.getImageData(id)
    if (data?.dataUrl) add(data.dataUrl)
    else notes.push(`图片库中未找到 id=${id}`)
  }
  for (const filePath of asStringArray(task.input_image_paths)) {
    if (images.length >= MAX_INPUT_IMAGES) break
    try {
      add(await fileToDataUrl(filePath))
    } catch (error) {
      notes.push(`读取 ${filePath} 失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }
  for (const dataUrl of asStringArray(task.input_images)) {
    if (images.length >= MAX_INPUT_IMAGES) break
    if (dataUrl.startsWith('data:image/')) add(dataUrl)
    else notes.push('input_images 仅接受 data:image/... base64 URL')
  }

  return { images, notes }
}

export function toolEditImage (settingsStore: SettingsStore, imageLibraryStore: ImageLibraryStore, getAbortSignal?: () => AbortSignal | undefined): Tool {
  return {
    definition: {
      name: 'edit_image',
      description: [
        'Batch image editing, mirroring the drawing studio (绘制工作台) 图片编辑 form.',
        'Each task supplies a prompt plus one or more input images and produces edited results saved to the image library.',
        `Input images (max ${MAX_INPUT_IMAGES} per task) come from: image-library ids (input_image_ids — e.g. results of generate_image), local file paths (input_image_paths), or raw base64 data URLs (input_images).`,
        'Controllable parameters match the studio: model, prompt, size, and count (n). Provider/model auto-select from the first model with the 图片编辑 capability unless `model`/`provider_id` is given.',
        'Top-level fields are shared defaults; per-task fields override them.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: `One entry per image-edit task (max ${MAX_TASKS}).`,
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'Required. How to edit the input image(s).' },
                input_image_ids: { type: 'array', items: { type: 'string' }, description: 'Image-library ids to edit (e.g. ids returned by generate_image).' },
                input_image_paths: { type: 'array', items: { type: 'string' }, description: 'Absolute local file paths of source images (png/jpg/jpeg/webp/gif).' },
                input_images: { type: 'array', items: { type: 'string' }, description: 'Raw base64 data URLs of source images.' },
                size: { type: 'string', description: `Optional output size "WxH" (each side ${MIN_DIMENSION}-${MAX_DIMENSION}).` },
                n: { type: 'integer', description: `Optional output count, 1-${MAX_IMAGES_PER_REQUEST}. Defaults to 1.` },
                model: { type: 'string', description: 'Optional model name override for this task.' },
                folder: { type: 'string', description: 'Optional image-library folder for this task\'s results.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for this task\'s results.' }
              },
              required: ['prompt']
            }
          },
          provider_id: { type: 'string', description: 'Optional default provider id for all tasks.' },
          model: { type: 'string', description: 'Optional default model name for all tasks.' },
          size: { type: 'string', description: 'Optional default output size "WxH" for all tasks.' },
          n: { type: 'integer', description: `Optional default output count (1-${MAX_IMAGES_PER_REQUEST}) for all tasks.` },
          folder: { type: 'string', description: 'Optional default image-library folder for all tasks.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional default tags for all tasks.' }
        },
        required: ['tasks']
      }
    },
    handler: async (args, onProgress) => {
      const rawTasks = asObjectArray(args.tasks)
      if (rawTasks.length === 0) {
        return { ok: false, error: 'tasks 不能为空，请提供至少一个包含 prompt 和输入图片的编辑任务。' }
      }
      if (listImageModels(settingsStore.getProviders(), 'edit').length === 0) {
        return { ok: false, error: '未找到支持图片编辑的模型，请到「设置 → 供应商」为某个模型勾选「图片编辑」能力并配置 API Key。' }
      }

      const tasks = rawTasks.slice(0, MAX_TASKS)
      const truncated = rawTasks.length - tasks.length
      const defaultModel = asString(args.model)
      const defaultProviderId = asString(args.provider_id)
      const defaultSize = asString(args.size)
      const defaultFolder = asString(args.folder)
      const defaultTags = asStringArray(args.tags)
      const defaultN = args.n

      const results = await mapWithConcurrency(tasks, TASK_CONCURRENCY, async (task, index): Promise<TaskResult> => {
        const prompt = asString(task.prompt)
        if (!prompt) {
          return { index, status: 'error', prompt: '', error: 'prompt 不能为空。' }
        }
        try {
          const { images, notes } = await resolveEditInputs(task, imageLibraryStore)
          if (images.length === 0) {
            return { index, status: 'error', prompt, error: '该编辑任务需要至少一张输入图片（input_image_ids / input_image_paths / input_images）。', inputNotes: notes.length ? notes : undefined }
          }

          const model = asString(task.model) || defaultModel
          const resolved = resolveImageModel(settingsStore.getProviders(), {
            mode: 'edit',
            providerId: defaultProviderId || undefined,
            model: model || undefined
          })

          let size = ''
          const explicitSize = asString(task.size) || defaultSize
          if (explicitSize) {
            const normalized = normalizeSize(explicitSize)
            if (!normalized) {
              return { index, status: 'error', prompt, error: `尺寸 ${explicitSize} 无效（需 WxH，单边 ${MIN_DIMENSION}-${MAX_DIMENSION}）。` }
            }
            size = normalized
          }

          const folder = asString(task.folder) || defaultFolder
          const tags = asStringArray(task.tags).length ? asStringArray(task.tags) : defaultTags

          onProgress?.('🖌️ 编辑图片', `任务 ${index + 1}/${tasks.length}：${prompt.slice(0, 40)}`)

          const req: ImageStudioGenerateRequest = {
            providerId: resolved.providerId,
            model: resolved.model,
            mode: 'edit',
            prompt,
            size,
            n: clampCount(task.n ?? defaultN, 1),
            inputImages: images,
            folder: folder || undefined,
            tags: tags.length ? tags : undefined
          }

          const response = await runImageStudioRequest(req, {
            getProvidersConfig: () => settingsStore.getProviders(),
            imageLibraryStore,
            abortSignal: getAbortSignal?.()
          })
          if (!response.ok) {
            return { index, status: 'error', prompt, error: response.error, inputNotes: notes.length ? notes : undefined }
          }
          onProgress?.('✅ 编辑完成', `任务 ${index + 1}/${tasks.length}`)
          return entriesToResult(index, prompt, resolved.providerId, resolved.model, size || '原图尺寸', folder || undefined, response.entries, notes)
        } catch (error) {
          return { index, status: 'error', prompt, error: error instanceof Error ? error.message : '图片编辑失败' }
        }
      })

      const summary = summarize('edit', results)
      if (truncated > 0) summary.note = `仅处理前 ${MAX_TASKS} 个任务，忽略了 ${truncated} 个。`
      return summary
    }
  }
}
