import fs from 'node:fs'
import path from 'node:path'

export interface AISettings {
  apiKey: string
  baseUrl: string
  model: string
}

export interface AISettingsInput {
  apiKey?: string
  baseUrl?: string
  model?: string
}

/** A saved AI provider configuration */
export interface AIProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: string[]
  /** Context window per model name */
  modelContextWindows?: Record<string, number>
  /** Currently selected model for this provider */
  activeModel: string
  /** Whether to enable thinking/reasoning mode for compatible models */
  enableThinking?: boolean
}

export interface AIProvidersConfig {
  providers: AIProvider[]
  /** ID of the currently active provider */
  activeProviderId: string
}

export const DEFAULT_MODEL_CONTEXT_WINDOW = 32000

function normalizeContextWindow (value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value)
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_MODEL_CONTEXT_WINDOW
}

function normalizeProvider (input: AIProvider): AIProvider {
  const rawModels = Array.isArray(input.models) ? input.models : []
  const models: string[] = []
  const modelContextWindows: Record<string, number> = {}
  const savedContextWindows = input.modelContextWindows || {}

  for (const item of rawModels as Array<string | { name?: string; contextWindow?: number }>) {
    if (typeof item === 'string') {
      if (item.trim()) {
        const name = item.trim()
        models.push(name)
        modelContextWindows[name] = normalizeContextWindow(savedContextWindows[name])
      }
      continue
    }

    const name = typeof item?.name === 'string' ? item.name.trim() : ''
    if (!name) continue
    models.push(name)
    modelContextWindows[name] = normalizeContextWindow(item.contextWindow ?? savedContextWindows[name])
  }

  for (const modelName of models) {
    modelContextWindows[modelName] = normalizeContextWindow(modelContextWindows[modelName])
  }

  const activeModel = models.includes(input.activeModel) ? input.activeModel : (models[0] || '')

  return {
    id: input.id,
    name: input.name,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    models,
    modelContextWindows,
    activeModel,
    enableThinking: input.enableThinking ?? false
  }
}

/**
 * SettingsStore — 用户设置持久化存储
 * 将设置保存为 JSON 文件到 userData 目录
 */
export class SettingsStore {
  private filePath: string
  private _cache: Record<string, unknown> | null = null

  constructor (userDataPath: string) {
    this.filePath = path.join(userDataPath, 'settings.json')
  }

  /**
   * Read all settings from disk.
   */
  read (): Record<string, unknown> {
    if (this._cache) return this._cache

    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        this._cache = JSON.parse(raw) as Record<string, unknown>
        return this._cache
      }
    } catch (err) {
      console.error('[settings] Failed to read settings:', (err as Error).message)
    }

    return {}
  }

  /**
   * Write settings to disk (merge with existing).
   */
  write (data: Record<string, unknown>): void {
    const current = this.read()
    const merged = { ...current, ...data }
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(merged, null, 2), 'utf-8')
      this._cache = merged
    } catch (err) {
      console.error('[settings] Failed to write settings:', (err as Error).message)
      throw err
    }
  }

  /**
   * Get legacy flat AI provider settings.
   */
  getAISettings (): AISettings {
    const settings = this.read()
    return {
      apiKey: (settings.aiApiKey as string) || '',
      baseUrl: (settings.aiBaseUrl as string) || '',
      model: (settings.aiModel as string) || ''
    }
  }

  /**
   * Save legacy flat AI provider settings.
   */
  saveAISettings (config: AISettingsInput): void {
    const data: Record<string, unknown> = {}
    if (config.apiKey !== undefined) data.aiApiKey = config.apiKey
    if (config.baseUrl !== undefined) data.aiBaseUrl = config.baseUrl
    if (config.model !== undefined) data.aiModel = config.model
    this.write(data)
  }

  /**
   * Get multi-provider configuration.
   * Falls back to the legacy single-provider config if no providers are saved.
   */
  getProviders (): AIProvidersConfig {
    const settings = this.read()
    const saved = settings.aiProviders as AIProvidersConfig | undefined
    if (saved && saved.providers && saved.providers.length > 0) {
      const providers = saved.providers.map(provider => normalizeProvider(provider))
      const activeProviderId = providers.some(p => p.id === saved.activeProviderId)
        ? saved.activeProviderId
        : (providers[0]?.id || '')
      return { providers, activeProviderId }
    }

    // Migrate from legacy single-provider config
    const legacy = this.getAISettings()
    if (legacy.apiKey || legacy.baseUrl) {
      const migrated: AIProvider = {
        id: 'default',
        name: 'Default',
        baseUrl: legacy.baseUrl || 'https://api.openai.com/v1',
        apiKey: legacy.apiKey,
        models: legacy.model ? [legacy.model] : ['gpt-4o'],
        modelContextWindows: {
          [legacy.model || 'gpt-4o']: DEFAULT_MODEL_CONTEXT_WINDOW
        },
        activeModel: legacy.model || 'gpt-4o'
      }
      return { providers: [migrated], activeProviderId: 'default' }
    }

    return { providers: [], activeProviderId: '' }
  }

  /**
   * Save multi-provider configuration.
   */
  saveProviders (config: AIProvidersConfig): void {
    const normalized: AIProvidersConfig = {
      providers: config.providers.map(provider => normalizeProvider(provider)),
      activeProviderId: config.providers.some(p => p.id === config.activeProviderId)
        ? config.activeProviderId
        : (config.providers[0]?.id || '')
    }
    this.write({ aiProviders: normalized })

    // Also keep legacy fields in sync with the active provider
    const active = normalized.providers.find(p => p.id === normalized.activeProviderId)
    if (active) {
      this.saveAISettings({
        apiKey: active.apiKey,
        baseUrl: active.baseUrl,
        model: active.activeModel
      })
    }
  }

  /** Get project launch mode preference: 'embed' or 'window'. */
  getLaunchMode (projectId: string): 'embed' | 'window' {
    const settings = this.read()
    const modes = (settings.projectLaunchModes as Record<string, string>) || {}
    return (modes[projectId] as 'embed' | 'window') || 'embed'
  }

  /** Save project launch mode preference. */
  saveLaunchMode (projectId: string, mode: 'embed' | 'window'): void {
    const settings = this.read()
    const modes = (settings.projectLaunchModes as Record<string, string>) || {}
    modes[projectId] = mode
    this.write({ projectLaunchModes: modes })
  }
}
