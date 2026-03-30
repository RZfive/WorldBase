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
  /** Currently selected model for this provider */
  activeModel: string
}

export interface AIProvidersConfig {
  providers: AIProvider[]
  /** ID of the currently active provider */
  activeProviderId: string
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
      return saved
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
    this.write({ aiProviders: config })

    // Also keep legacy fields in sync with the active provider
    const active = config.providers.find(p => p.id === config.activeProviderId)
    if (active) {
      this.saveAISettings({
        apiKey: active.apiKey,
        baseUrl: active.baseUrl,
        model: active.activeModel
      })
    }
  }
}
