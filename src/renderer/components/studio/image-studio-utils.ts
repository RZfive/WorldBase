import type { ImageStudioMode } from '../../../shared/image-studio-types'
import type { ProviderOption, ProvidersConfig } from '../chat/panel/types'

/** Aspect ratio preset with candidate pixel sizes. */
export interface RatioPreset {
  label: string
  /** Candidate pixel sizes (`WxH`) offered for this ratio. */
  sizes: string[]
  /** Default size selected when this ratio is chosen. */
  defaultSize: string
}

export const MIN_DIMENSION = 560
export const MAX_DIMENSION = 8192

const PRESET_REFERENCE_DIMENSIONS = [560, 720, 1080, 1440, 2160, 4320]
const DEFAULT_REFERENCE_DIMENSION = 1080

const RATIO_DEFINITIONS = [
  { label: '1:1', width: 1, height: 1 },
  { label: '3:2', width: 3, height: 2 },
  { label: '2:3', width: 2, height: 3 },
  { label: '16:9', width: 16, height: 9 },
  { label: '9:16', width: 9, height: 16 },
  { label: '4:3', width: 4, height: 3 },
  { label: '3:4', width: 3, height: 4 }
] as const

function roundToEven (value: number): number {
  return Math.round(value / 2) * 2
}

function buildPresetSize (widthRatio: number, heightRatio: number, referenceDimension: number): string | null {
  const shortSide = Math.min(widthRatio, heightRatio)
  const scale = referenceDimension / shortSide
  const width = roundToEven(widthRatio * scale)
  const height = roundToEven(heightRatio * scale)

  if (width < MIN_DIMENSION || width > MAX_DIMENSION || height < MIN_DIMENSION || height > MAX_DIMENSION) {
    return null
  }

  return `${width}x${height}`
}

export const RATIO_PRESETS: RatioPreset[] = RATIO_DEFINITIONS.map((ratio) => {
  const sizes = Array.from(
    new Set(
      PRESET_REFERENCE_DIMENSIONS
        .map(referenceDimension => buildPresetSize(ratio.width, ratio.height, referenceDimension))
        .filter((size): size is string => Boolean(size))
    )
  )

  const defaultSize = buildPresetSize(ratio.width, ratio.height, DEFAULT_REFERENCE_DIMENSION) ?? sizes[0]

  return {
    label: ratio.label,
    sizes,
    defaultSize
  }
})

/** A flattened provider+model option usable in a single dropdown. */
export interface StudioModelOption {
  providerId: string
  providerName: string
  model: string
  /** Combined value `${providerId}::${model}`. */
  value: string
  label: string
}

export function isTextModel (provider: ProviderOption, model: string): boolean {
  const caps = provider.modelCapabilities?.[model]
  return caps?.imageGeneration !== true && caps?.imageEditing !== true
}

const MODE_CAPABILITY: Record<ImageStudioMode, 'imageGeneration' | 'imageEditing'> = {
  generate: 'imageGeneration',
  edit: 'imageEditing'
}

function prioritizeProviders (config: ProvidersConfig): ProviderOption[] {
  const activeProvider = config.providers.find(provider => provider.id === config.activeProviderId)
  if (!activeProvider) return config.providers
  return [activeProvider, ...config.providers.filter(provider => provider.id !== activeProvider.id)]
}

/**
 * Build the list of selectable provider+model options for the given mode,
 * keeping only models flagged with the matching capability.
 */
export function buildModelOptions (config: ProvidersConfig | null, mode: ImageStudioMode): StudioModelOption[] {
  if (!config) return []

  const enabledIds = new Set(
    (config.enabledProviderIds.length > 0 ? config.enabledProviderIds : [config.activeProviderId]).filter(Boolean)
  )
  const enabledProviders: ProviderOption[] = config.providers.filter(provider => enabledIds.has(provider.id))
  const providers = enabledProviders.length > 0 ? enabledProviders : config.providers
  const capability = MODE_CAPABILITY[mode]

  const options: StudioModelOption[] = []
  for (const provider of providers) {
    for (const model of provider.models) {
      if (provider.modelCapabilities?.[model]?.[capability] === true) {
        options.push({
          providerId: provider.id,
          providerName: provider.name,
          model,
          value: `${provider.id}::${model}`,
          label: `${provider.name} · ${model}`
        })
      }
    }
  }
  return options
}

export function buildTextModelOptions (config: ProvidersConfig | null): StudioModelOption[] {
  if (!config) return []

  const options: StudioModelOption[] = []
  for (const provider of prioritizeProviders(config)) {
    const orderedModels = provider.activeModel && provider.models.includes(provider.activeModel)
      ? [provider.activeModel, ...provider.models.filter(model => model !== provider.activeModel)]
      : provider.models

    for (const model of orderedModels) {
      if (!isTextModel(provider, model)) continue
      options.push({
        providerId: provider.id,
        providerName: provider.name,
        model,
        value: `${provider.id}::${model}`,
        label: `${provider.name} · ${model}`
      })
    }
  }

  return options
}

/** Validate and normalize a custom `WxH` size; returns null when invalid. */
export function normalizeCustomSize (width: number, height: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  const w = Math.round(width)
  const h = Math.round(height)
  if (w < MIN_DIMENSION || w > MAX_DIMENSION || h < MIN_DIMENSION || h > MAX_DIMENSION) return null
  return `${w}x${h}`
}

/** Read a File into a base64 data URL. */
export function fileToDataUrl (file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}
