import { randomUUID } from 'node:crypto'
import { OpenAIProvider } from '../ai-engine/providers/openai-provider.js'
import { t } from '../i18n/main-i18n.js'
import type { AIProvidersConfig } from './settings-store.js'
import type { ImageLibraryStore } from './image-library-store.js'
import type {
  ImageLibraryEntry,
  ImageStudioGenerateRequest,
  ImageStudioGenerateResponse,
  ImageStudioImageQuality,
  ImageStudioMode,
  ImageStudioOutputFormat
} from '../../shared/image-studio-types.js'

/** Hard cap on images produced by a single generate/edit request (matches the studio UI). */
export const MAX_IMAGES_PER_REQUEST = 4

/** Aspect-ratio presets offered by the drawing studio. */
export const ASPECT_RATIOS = ['1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '4:7'] as const
export const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high'] as const satisfies readonly ImageStudioImageQuality[]
export const OUTPUT_FORMATS = ['png', 'jpeg', 'webp'] as const satisfies readonly ImageStudioOutputFormat[]
export const IMAGE_RESOLUTION_TIERS = ['1K', '2K', '4K'] as const
export type ImageResolutionTier = typeof IMAGE_RESOLUTION_TIERS[number]
export const MIN_DIMENSION = 560
export const MAX_DIMENSION = 3840
const MAX_TOTAL_PIXELS = 3840 * 2160
const DEFAULT_REFERENCE_DIMENSION = 1024
const RESOLUTION_TIER_SHORT_SIDE: Record<ImageResolutionTier, number> = {
  '1K': 1024,
  '2K': 1440,
  '4K': 2160
}

const RATIO_DIMENSIONS: Record<string, [number, number]> = {
  '1:1': [1, 1],
  '3:2': [3, 2],
  '2:3': [2, 3],
  '16:9': [16, 9],
  '9:16': [9, 16],
  '4:3': [4, 3],
  '3:4': [3, 4],
  '4:7': [4, 7]
}

function roundToMultipleOf16 (value: number): number {
  return Math.round(value / 16) * 16
}

function clampDimension (value: number): number {
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, value))
}

function sizeForRatioReference (ratio: string | undefined, referenceDimension: number): string {
  const [w, h] = RATIO_DIMENSIONS[ratio ?? '1:1'] ?? RATIO_DIMENSIONS['1:1']
  const scale = referenceDimension / Math.min(w, h)
  const width = clampDimension(roundToMultipleOf16(w * scale))
  const height = clampDimension(roundToMultipleOf16(h * scale))
  return `${width}x${height}`
}

/**
 * Pixel size for an aspect-ratio preset, scaled so the short side is 1K by
 * default and every dimension is valid for GPT Image arbitrary-size requests.
 */
export function defaultSizeForRatio (ratio?: string): string {
  return sizeForRatioReference(ratio, DEFAULT_REFERENCE_DIMENSION)
}

export function sizeForRatioTier (ratio: string | undefined, tier: ImageResolutionTier): string {
  return sizeForRatioReference(ratio, RESOLUTION_TIER_SHORT_SIDE[tier])
}

/** Validate/normalize a `WxH` size string; returns null when out of range or malformed. */
export function normalizeSize (raw: string): string | null {
  const match = raw.trim().match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width < MIN_DIMENSION || width > MAX_DIMENSION || height < MIN_DIMENSION || height > MAX_DIMENSION) return null
  if (width % 16 !== 0 || height % 16 !== 0) return null
  if (width * height > MAX_TOTAL_PIXELS) return null
  return `${width}x${height}`
}

export function normalizeImageQuality (value: unknown): ImageStudioImageQuality | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return IMAGE_QUALITIES.includes(normalized as ImageStudioImageQuality) ? normalized as ImageStudioImageQuality : undefined
}

export function normalizeOutputFormat (value: unknown): ImageStudioOutputFormat | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return OUTPUT_FORMATS.includes(normalized as ImageStudioOutputFormat) ? normalized as ImageStudioOutputFormat : undefined
}

export function normalizeResolutionTier (value: unknown): ImageResolutionTier | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toUpperCase()
  return IMAGE_RESOLUTION_TIERS.includes(normalized as ImageResolutionTier) ? normalized as ImageResolutionTier : undefined
}

/** Capability flag backing each studio mode. */
const MODE_CAPABILITY: Record<ImageStudioMode, 'imageGeneration' | 'imageEditing'> = {
  generate: 'imageGeneration',
  edit: 'imageEditing'
}

/** A provider+model pair that advertises the requested image capability. */
export interface ImageModelOption {
  providerId: string
  providerName: string
  model: string
}

/** Order providers with the active one first, mirroring the studio's selection priority. */
function prioritizeProviders (config: AIProvidersConfig): AIProvidersConfig['providers'] {
  const enabled = new Set(
    (config.enabledProviderIds.length > 0 ? config.enabledProviderIds : [config.activeProviderId]).filter(Boolean)
  )
  const inScope = config.providers.filter(p => enabled.has(p.id))
  const providers = inScope.length > 0 ? inScope : config.providers
  const active = providers.find(p => p.id === config.activeProviderId)
  return active ? [active, ...providers.filter(p => p.id !== active.id)] : providers
}

/**
 * List every configured provider+model that can serve the given mode (capability
 * flag set AND an API key present), in selection priority order.
 */
export function listImageModels (config: AIProvidersConfig, mode: ImageStudioMode): ImageModelOption[] {
  const capability = MODE_CAPABILITY[mode]
  const options: ImageModelOption[] = []
  for (const provider of prioritizeProviders(config)) {
    if (!provider.apiKey) continue
    for (const model of provider.models) {
      if (provider.modelCapabilities?.[model]?.[capability] === true) {
        options.push({ providerId: provider.id, providerName: provider.name, model })
      }
    }
  }
  return options
}

function describeAvailable (options: ImageModelOption[]): string {
  if (options.length === 0) return ''
  return options.map(o => `${o.providerName}·${o.model}`).join('、')
}

/**
 * Resolve which provider+model should serve a request, honoring an explicit
 * provider/model hint when given and otherwise auto-selecting the first capable
 * model. Throws a descriptive error (listing what *is* available) when no match
 * exists, so the agent gets actionable feedback.
 */
export function resolveImageModel (
  config: AIProvidersConfig,
  opts: { mode: ImageStudioMode; providerId?: string; model?: string }
): ImageModelOption {
  const options = listImageModels(config, opts.mode)
  const modeLabel = opts.mode === 'edit' ? '图片编辑' : '图片生成'
  if (options.length === 0) {
    throw new Error(`未找到支持${modeLabel}的模型，请到「设置 → 供应商」为某个模型勾选「${modeLabel}」能力并配置 API Key。`)
  }

  if (opts.providerId) {
    const inProvider = options.filter(o => o.providerId === opts.providerId)
    if (inProvider.length === 0) {
      throw new Error(`供应商 ${opts.providerId} 没有可用于${modeLabel}的模型。可用：${describeAvailable(options)}`)
    }
    if (opts.model) {
      const matched = inProvider.find(o => o.model === opts.model)
      if (matched) return matched
      throw new Error(`供应商 ${opts.providerId} 的模型 ${opts.model} 不支持${modeLabel}。可用：${describeAvailable(inProvider)}`)
    }
    return inProvider[0]
  }

  if (opts.model) {
    const matched = options.find(o => o.model === opts.model)
    if (matched) return matched
    throw new Error(`模型 ${opts.model} 不支持${modeLabel}或未配置。可用：${describeAvailable(options)}`)
  }

  return options[0]
}

export interface ImageGenerationDeps {
  getProvidersConfig: () => AIProvidersConfig
  imageLibraryStore: ImageLibraryStore
  abortSignal?: AbortSignal
}

/**
 * Run a single generate/edit request end-to-end: resolve the provider, call the
 * image endpoint, then persist every returned image to the library. Shared by the
 * studio IPC handler and the agent's image tools so both behave identically.
 *
 * The caller is expected to have already resolved `providerId`/`model` (the studio
 * picks them from a capability-filtered dropdown; the agent tools use
 * `resolveImageModel`). Returns the same response shape the renderer consumes.
 */
export async function runImageStudioRequest (
  req: ImageStudioGenerateRequest,
  deps: ImageGenerationDeps
): Promise<ImageStudioGenerateResponse> {
  try {
    const providersConfig = deps.getProvidersConfig()
    const provider = providersConfig.providers.find(p => p.id === req.providerId)
    if (!provider) {
      throw new Error(t('mainDialog.providerNotFound'))
    }
    if (!provider.apiKey) {
      throw new Error(t('mainDialog.providerApiKeyMissing'))
    }
    const model = provider.models.includes(req.model) ? req.model : provider.activeModel
    if (!model) {
      throw new Error(t('mainDialog.providerNoModels'))
    }

    const aiProvider = new OpenAIProvider()
    aiProvider.setApiKey(provider.apiKey)
    aiProvider.setBaseUrl(provider.baseUrl)
    aiProvider.setModel(model)

    const n = req.n && req.n > 0 ? Math.min(req.n, MAX_IMAGES_PER_REQUEST) : 1

    const result = req.mode === 'edit'
      ? await aiProvider.editImages({
          prompt: req.prompt,
          images: req.inputImages ?? [],
          size: req.size,
          quality: req.quality,
          outputFormat: req.outputFormat,
          n,
          abortSignal: deps.abortSignal
        })
      : await aiProvider.generateImages({
          prompt: req.prompt,
          negativePrompt: req.negativePrompt,
          size: req.size,
          quality: req.quality,
          outputFormat: req.outputFormat,
          n,
          abortSignal: deps.abortSignal
        })

    if (!result.images.length) {
      throw new Error(t('mainDialog.imageModelNoImages'))
    }

    const createdAt = new Date().toISOString()
    const entries: ImageLibraryEntry[] = await Promise.all(result.images.map(imageUrl => deps.imageLibraryStore.save(
      {
        id: randomUUID(),
        createdAt,
        mode: req.mode,
        providerId: req.providerId,
        model,
        prompt: req.prompt,
        negativePrompt: req.negativePrompt || undefined,
        aspectRatio: req.aspectRatio || undefined,
        size: req.size,
        quality: req.quality,
        outputFormat: req.outputFormat,
        folder: req.folder?.trim() || undefined,
        tags: req.tags?.length ? req.tags : undefined
      },
      imageUrl,
      req.mode === 'edit' ? req.inputImages : undefined
    )))

    return { ok: true, entries }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : t('mainDialog.imageGenerationFailed') }
  }
}
