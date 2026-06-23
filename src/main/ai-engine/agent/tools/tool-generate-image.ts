import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import type { SettingsStore } from '../../../settings/settings-store.js'
import type { ImageLibraryStore } from '../../../settings/image-library-store.js'
import type { ImageStudioGenerateRequest } from '../../../../shared/image-studio-types.js'
import {
  ASPECT_RATIOS,
  IMAGE_QUALITIES,
  IMAGE_RESOLUTION_TIERS,
  MAX_IMAGES_PER_REQUEST,
  MAX_DIMENSION,
  MIN_DIMENSION,
  listImageModels,
  normalizeImageQuality,
  normalizeOutputFormat,
  normalizeResolutionTier,
  normalizeSize,
  resolveImageModel,
  sizeForRatioTier
} from '../../../settings/image-generation-service.js'

interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

/** Pushes resolved requests onto the drawing studio's shared task queue. */
type EnqueueStudioImageTasks = (requests: ImageStudioGenerateRequest[]) => void

/** Source images per edit task may not exceed this (mirrors the studio UI). */
const MAX_INPUT_IMAGES = 4
/** Upper bound on tasks per call so a single tool call can't run away. */
const MAX_TASKS = 20

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

/** Metadata about one queued task, returned to the model (never inlines base64). */
interface QueuedTaskInfo {
  index: number
  prompt: string
  mode: 'generate' | 'edit'
  providerId: string
  model: string
  size: string
  quality?: string
  outputFormat?: string
  n: number
  folder?: string
  inputCount?: number
  inputNotes?: string[]
}

interface TaskError {
  index: number
  prompt: string
  error: string
}

/** Build the response object the agent receives after handing tasks to the studio. */
function buildResult (mode: 'generate' | 'edit', queued: QueuedTaskInfo[], errors: TaskError[], truncated: number): Record<string, unknown> {
  const verb = mode === 'edit' ? '图片编辑' : '图片生成'
  const parts = [`已将 ${queued.length} 个${verb}任务加入绘制工作台的任务队列`]
  if (errors.length) parts.push(`${errors.length} 个任务因参数问题被跳过`)
  const result: Record<string, unknown> = {
    ok: queued.length > 0,
    mode,
    queued: queued.length,
    failed: errors.length,
    message: `${parts.join('，')}。任务会按工作台「并发」设置依次执行，可在「绘制工作台 → 📋 任务队列」查看进度、重试或移除，完成后进入图片库。`,
    tasks: queued,
    errors: errors.length ? errors : undefined
  }
  if (truncated > 0) result.note = `仅处理前 ${MAX_TASKS} 个任务，忽略了 ${truncated} 个。`
  return result
}

/* -------------------------------------------------------------------------- */
/* generate_image — batch text-to-image                                        */
/* -------------------------------------------------------------------------- */

export function toolGenerateImage (settingsStore: SettingsStore, _imageLibraryStore: ImageLibraryStore, enqueue: EnqueueStudioImageTasks): Tool {
  return {
    definition: {
      name: 'generate_image',
      description: [
        'Batch text-to-image generation, mirroring the drawing studio (绘制工作台) 文生图 form.',
        'Tasks are NOT run here — they are added to the studio\'s shared task queue and execute under the workbench\'s own concurrency setting, so user- and agent-initiated jobs are managed together.',
        'After this returns, the tasks are visible (and retryable/removable) under 绘制工作台 → 📋 任务队列, and finished images land in the 图片库. The tool returns immediately and does NOT wait for images to finish.',
        'Controllable parameters match the studio: model, prompt, negative prompt, resolution tier, aspect ratio, size, quality, output format, and count (n).',
        'Provider/model are auto-selected from the first configured model with the 图片生成 capability when not specified; pass `model` (or `provider_id`) to pick a specific one.',
        'Use top-level fields as shared defaults applied to every task; per-task fields override them.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: `One entry per image-generation task (max ${MAX_TASKS}). Each becomes one queue job.`,
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'Required. What to draw.' },
                negative_prompt: { type: 'string', description: 'Optional. Content to avoid (only some providers honor it).' },
                aspect_ratio: { type: 'string', enum: [...ASPECT_RATIOS], description: 'Optional aspect ratio preset. Used to derive size when no explicit size is given.' },
                resolution: { type: 'string', enum: [...IMAGE_RESOLUTION_TIERS], description: 'Optional resolution tier used with aspect_ratio when no explicit size is given. Defaults to 1K.' },
                size: { type: 'string', description: `Optional explicit pixel size "WxH" (each side ${MIN_DIMENSION}-${MAX_DIMENSION}, dimensions must be multiples of 16). Overrides resolution and aspect_ratio.` },
                quality: { type: 'string', enum: [...IMAGE_QUALITIES], description: 'Optional image quality. Defaults to high for clearer 2K/4K output.' },
                output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Optional output format. Defaults to png.' },
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
          resolution: { type: 'string', enum: [...IMAGE_RESOLUTION_TIERS], description: 'Optional default resolution tier for all tasks. Defaults to 1K.' },
          size: { type: 'string', description: 'Optional default explicit size "WxH" for all tasks.' },
          quality: { type: 'string', enum: [...IMAGE_QUALITIES], description: 'Optional default image quality. Defaults to high.' },
          output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Optional default output format. Defaults to png.' },
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
      const defaultResolution = normalizeResolutionTier(args.resolution) ?? '1K'
      const defaultSize = asString(args.size)
      const defaultQuality = normalizeImageQuality(args.quality) ?? 'high'
      const defaultOutputFormat = normalizeOutputFormat(args.output_format) ?? 'png'
      const defaultNegative = asString(args.negative_prompt)
      const defaultFolder = asString(args.folder)
      const defaultTags = asStringArray(args.tags)
      const defaultN = args.n

      const requests: ImageStudioGenerateRequest[] = []
      const queued: QueuedTaskInfo[] = []
      const errors: TaskError[] = []

      tasks.forEach((task, index) => {
        const prompt = asString(task.prompt)
        if (!prompt) {
          errors.push({ index, prompt: '', error: 'prompt 不能为空。' })
          return
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
          const rawResolution = asString(task.resolution)
          const rawQuality = asString(task.quality)
          const taskQuality = rawQuality ? normalizeImageQuality(rawQuality) : defaultQuality
          if (!taskQuality) {
            errors.push({ index, prompt, error: `画质 ${rawQuality} 无效（可选：${IMAGE_QUALITIES.join('、')}）。` })
            return
          }
          const rawOutputFormat = asString(task.output_format)
          const taskOutputFormat = rawOutputFormat ? normalizeOutputFormat(rawOutputFormat) : defaultOutputFormat
          if (!taskOutputFormat) {
            errors.push({ index, prompt, error: `输出格式 ${rawOutputFormat} 无效（可选：png、jpeg、webp）。` })
            return
          }
          let size: string
          let aspectRatio: string | undefined
          if (explicitSize) {
            const normalized = normalizeSize(explicitSize)
            if (!normalized) {
              errors.push({ index, prompt, error: `尺寸 ${explicitSize} 无效（需 WxH，单边 ${MIN_DIMENSION}-${MAX_DIMENSION}，宽高为 16 的倍数且总像素不超过 3840x2160）。` })
              return
            }
            size = normalized
            aspectRatio = ratio || undefined
          } else {
            const resolution = rawResolution ? normalizeResolutionTier(rawResolution) : defaultResolution
            if (!resolution) {
              errors.push({ index, prompt, error: `清晰度 ${rawResolution} 无效（可选：${IMAGE_RESOLUTION_TIERS.join('、')}）。` })
              return
            }
            aspectRatio = ratio || '1:1'
            size = sizeForRatioTier(aspectRatio, resolution)
          }

          const folder = asString(task.folder) || defaultFolder
          const taskTags = asStringArray(task.tags)
          const tags = taskTags.length ? taskTags : defaultTags
          const n = clampCount(task.n ?? defaultN, 1)

          requests.push({
            providerId: resolved.providerId,
            model: resolved.model,
            mode: 'generate',
            prompt,
            negativePrompt: (asString(task.negative_prompt) || defaultNegative) || undefined,
            aspectRatio,
            size,
            quality: taskQuality,
            outputFormat: taskOutputFormat,
            n,
            folder: folder || undefined,
            tags: tags.length ? tags : undefined
          })
          queued.push({ index, prompt, mode: 'generate', providerId: resolved.providerId, model: resolved.model, size, quality: taskQuality, outputFormat: taskOutputFormat, n, folder: folder || undefined })
        } catch (error) {
          errors.push({ index, prompt, error: error instanceof Error ? error.message : '解析任务失败' })
        }
      })

      if (requests.length > 0) {
        enqueue(requests)
        onProgress?.('📋 加入任务队列', `生成 ×${requests.length}`)
      }
      return buildResult('generate', queued, errors, truncated)
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
  const add = (dataUrl: string): void => {
    if (images.length < MAX_INPUT_IMAGES) images.push(dataUrl)
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

export function toolEditImage (settingsStore: SettingsStore, imageLibraryStore: ImageLibraryStore, enqueue: EnqueueStudioImageTasks): Tool {
  return {
    definition: {
      name: 'edit_image',
      description: [
        'Batch image editing, mirroring the drawing studio (绘制工作台) 图片编辑 form.',
        'Tasks are NOT run here — they are added to the studio\'s shared task queue and execute under the workbench\'s own concurrency setting, alongside user-initiated jobs.',
        'After this returns, the tasks are visible (and retryable/removable) under 绘制工作台 → 📋 任务队列, and finished images land in the 图片库. The tool returns immediately and does NOT wait for images to finish.',
        `Each task supplies a prompt plus one or more input images (max ${MAX_INPUT_IMAGES}) from: image-library ids (input_image_ids — e.g. ids previously generated), local file paths (input_image_paths), or raw base64 data URLs (input_images).`,
        'Controllable parameters match the studio: model, prompt, aspect ratio, resolution tier, size, quality, output format, and count (n). Provider/model auto-select from the first model with the 图片编辑 capability unless `model`/`provider_id` is given.',
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
                input_image_ids: { type: 'array', items: { type: 'string' }, description: 'Image-library ids to edit (e.g. ids of images generated earlier).' },
                input_image_paths: { type: 'array', items: { type: 'string' }, description: 'Absolute local file paths of source images (png/jpg/jpeg/webp/gif).' },
                input_images: { type: 'array', items: { type: 'string' }, description: 'Raw base64 data URLs of source images.' },
                aspect_ratio: { type: 'string', enum: [...ASPECT_RATIOS], description: 'Optional output aspect ratio preset. Used with resolution when no explicit size is given.' },
                resolution: { type: 'string', enum: [...IMAGE_RESOLUTION_TIERS], description: 'Optional output resolution tier used with aspect_ratio when no explicit size is given.' },
                size: { type: 'string', description: `Optional output size "WxH" (each side ${MIN_DIMENSION}-${MAX_DIMENSION}, dimensions must be multiples of 16).` },
                quality: { type: 'string', enum: [...IMAGE_QUALITIES], description: 'Optional image quality. Defaults to high.' },
                output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Optional output format. Defaults to png.' },
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
          aspect_ratio: { type: 'string', enum: [...ASPECT_RATIOS], description: 'Optional default output aspect ratio.' },
          resolution: { type: 'string', enum: [...IMAGE_RESOLUTION_TIERS], description: 'Optional default output resolution tier.' },
          size: { type: 'string', description: 'Optional default output size "WxH" for all tasks.' },
          quality: { type: 'string', enum: [...IMAGE_QUALITIES], description: 'Optional default image quality. Defaults to high.' },
          output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Optional default output format. Defaults to png.' },
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
      const defaultRatio = asString(args.aspect_ratio)
      const defaultResolution = normalizeResolutionTier(args.resolution)
      const defaultSize = asString(args.size)
      const defaultQuality = normalizeImageQuality(args.quality) ?? 'high'
      const defaultOutputFormat = normalizeOutputFormat(args.output_format) ?? 'png'
      const defaultFolder = asString(args.folder)
      const defaultTags = asStringArray(args.tags)
      const defaultN = args.n

      const requests: ImageStudioGenerateRequest[] = []
      const queued: QueuedTaskInfo[] = []
      const errors: TaskError[] = []

      for (const [index, task] of tasks.entries()) {
        const prompt = asString(task.prompt)
        if (!prompt) {
          errors.push({ index, prompt: '', error: 'prompt 不能为空。' })
          continue
        }
        try {
          const { images, notes } = await resolveEditInputs(task, imageLibraryStore)
          if (images.length === 0) {
            errors.push({ index, prompt, error: '该编辑任务需要至少一张输入图片（input_image_ids / input_image_paths / input_images）。' + (notes.length ? ` ${notes.join('；')}` : '') })
            continue
          }

          const model = asString(task.model) || defaultModel
          const resolved = resolveImageModel(settingsStore.getProviders(), {
            mode: 'edit',
            providerId: defaultProviderId || undefined,
            model: model || undefined
          })

          let size = ''
          let aspectRatio: string | undefined
          const explicitSize = asString(task.size) || defaultSize
          const rawQuality = asString(task.quality)
          const taskQuality = rawQuality ? normalizeImageQuality(rawQuality) : defaultQuality
          if (!taskQuality) {
            errors.push({ index, prompt, error: `画质 ${rawQuality} 无效（可选：${IMAGE_QUALITIES.join('、')}）。` })
            continue
          }
          const rawOutputFormat = asString(task.output_format)
          const taskOutputFormat = rawOutputFormat ? normalizeOutputFormat(rawOutputFormat) : defaultOutputFormat
          if (!taskOutputFormat) {
            errors.push({ index, prompt, error: `输出格式 ${rawOutputFormat} 无效（可选：png、jpeg、webp）。` })
            continue
          }
          if (explicitSize) {
            const normalized = normalizeSize(explicitSize)
            if (!normalized) {
              errors.push({ index, prompt, error: `尺寸 ${explicitSize} 无效（需 WxH，单边 ${MIN_DIMENSION}-${MAX_DIMENSION}，宽高为 16 的倍数且总像素不超过 3840x2160）。` })
              continue
            }
            size = normalized
            aspectRatio = asString(task.aspect_ratio) || defaultRatio || undefined
          } else {
            const ratio = asString(task.aspect_ratio) || defaultRatio
            const rawResolution = asString(task.resolution)
            const resolution = rawResolution ? normalizeResolutionTier(rawResolution) : defaultResolution
            if (ratio && resolution) {
              aspectRatio = ratio
              size = sizeForRatioTier(aspectRatio, resolution)
            } else if (ratio && rawResolution) {
              errors.push({ index, prompt, error: `清晰度 ${rawResolution} 无效（可选：${IMAGE_RESOLUTION_TIERS.join('、')}）。` })
              continue
            }
          }

          const folder = asString(task.folder) || defaultFolder
          const taskTags = asStringArray(task.tags)
          const tags = taskTags.length ? taskTags : defaultTags
          const n = clampCount(task.n ?? defaultN, 1)

          requests.push({
            providerId: resolved.providerId,
            model: resolved.model,
            mode: 'edit',
            prompt,
            aspectRatio,
            size,
            quality: taskQuality,
            outputFormat: taskOutputFormat,
            n,
            inputImages: images,
            folder: folder || undefined,
            tags: tags.length ? tags : undefined
          })
          queued.push({ index, prompt, mode: 'edit', providerId: resolved.providerId, model: resolved.model, size: size || '原图尺寸', quality: taskQuality, outputFormat: taskOutputFormat, n, folder: folder || undefined, inputCount: images.length, inputNotes: notes.length ? notes : undefined })
        } catch (error) {
          errors.push({ index, prompt, error: error instanceof Error ? error.message : '解析任务失败' })
        }
      }

      if (requests.length > 0) {
        enqueue(requests)
        onProgress?.('📋 加入任务队列', `编辑 ×${requests.length}`)
      }
      return buildResult('edit', queued, errors, truncated)
    }
  }
}
