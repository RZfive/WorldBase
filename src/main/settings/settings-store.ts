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
  /** Default provider ID used as fallback for new conversations. */
  activeProviderId: string
  /** Provider IDs currently enabled for chat selection. */
  enabledProviderIds: string[]
}

export interface LaunchpadFolderLayout {
  id: string
  name: string
  projectIds: string[]
}

export interface LaunchpadLayout {
  folders: LaunchpadFolderLayout[]
  topLevelOrder: string[]
}

export interface WebAppShortcut {
  id: string
  kind: 'web'
  type: 'browser'
  name: string
  url: string
  icon?: string
  createdAt: string
  updatedAt: string
}

export type ThemePreference = 'system' | 'light' | 'dark'
export type AIExecutionAuthMode = 'strict' | 'auto'

export interface AIExecutionPreferences {
  notifyOnTaskComplete: boolean
}

export interface PortableSettingsConfig {
  providers: AIProvidersConfig
  themePreference: ThemePreference
  aiExecutionPreferences: AIExecutionPreferences
  launchpadLayout: LaunchpadLayout
  webApps: WebAppShortcut[]
  projectLaunchModes: Record<string, 'embed' | 'window'>
}

export const DEFAULT_AI_EXECUTION_PREFERENCES: AIExecutionPreferences = {
  notifyOnTaskComplete: true
}

export const DEFAULT_MODEL_CONTEXT_WINDOW = 32000
type RawModelItem = string | { name?: string; contextWindow?: number }

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

function normalizeBaseUrl (value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.replace(/\/+$/, '')
}

function normalizeProvider (input: AIProvider): AIProvider {
  const rawModels = Array.isArray(input.models) ? input.models : []
  const models: string[] = []
  const modelContextWindows: Record<string, number> = {}
  const savedContextWindows = input.modelContextWindows || {}

  for (const item of rawModels as RawModelItem[]) {
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
    baseUrl: normalizeBaseUrl(input.baseUrl),
    apiKey: input.apiKey,
    models,
    modelContextWindows,
    activeModel,
    enableThinking: input.enableThinking ?? false
  }
}

function normalizeLaunchpadLayout (value: unknown): LaunchpadLayout {
  const input = (value && typeof value === 'object') ? value as Record<string, unknown> : {}

  const folders = Array.isArray(input.folders)
    ? input.folders
      .map((folder) => {
        if (!folder || typeof folder !== 'object') return null
        const record = folder as Record<string, unknown>
        const id = typeof record.id === 'string' ? record.id.trim() : ''
        if (!id) return null
        const name = typeof record.name === 'string' && record.name.trim()
          ? record.name.trim()
          : '新文件夹'
        const seenProjectIds = new Set<string>()
        const projectIds = Array.isArray(record.projectIds)
          ? record.projectIds
            .filter((projectId): projectId is string => typeof projectId === 'string' && projectId.trim().length > 0)
            .map(projectId => projectId.trim())
            .filter((projectId) => {
              if (seenProjectIds.has(projectId)) return false
              seenProjectIds.add(projectId)
              return true
            })
          : []

        return { id, name, projectIds }
      })
      .filter((folder): folder is LaunchpadFolderLayout => Boolean(folder))
    : []

  const seenOrderKeys = new Set<string>()
  const topLevelOrder = Array.isArray(input.topLevelOrder)
    ? input.topLevelOrder
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map(item => item.trim())
      .filter((item) => {
        if (seenOrderKeys.has(item)) return false
        seenOrderKeys.add(item)
        return true
      })
    : []

  return {
    folders,
    topLevelOrder
  }
}

function normalizeThemePreference (value: unknown): ThemePreference {
  if (value === 'light' || value === 'dark' || value === 'system') {
    return value
  }
  return 'system'
}

function normalizeAIExecutionPreferences (value: unknown): AIExecutionPreferences {
  const input = (value && typeof value === 'object') ? value as Record<string, unknown> : {}
  return {
    notifyOnTaskComplete: typeof input.notifyOnTaskComplete === 'boolean'
      ? input.notifyOnTaskComplete
      : DEFAULT_AI_EXECUTION_PREFERENCES.notifyOnTaskComplete
  }
}

function normalizeWebAppShortcut (value: unknown): WebAppShortcut | null {
  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const urlValue = typeof record.url === 'string' ? record.url.trim() : ''
  if (!id || !name || !urlValue) return null

  let normalizedUrl = ''
  try {
    const parsed = new URL(urlValue)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    normalizedUrl = parsed.toString()
  } catch {
    return null
  }

  const icon = typeof record.icon === 'string' && record.icon.trim()
    ? record.icon.trim()
    : undefined
  const createdAt = typeof record.createdAt === 'string' && record.createdAt.trim()
    ? record.createdAt.trim()
    : new Date().toISOString()
  const updatedAt = typeof record.updatedAt === 'string' && record.updatedAt.trim()
    ? record.updatedAt.trim()
    : createdAt

  return {
    id,
    kind: 'web',
    type: 'browser',
    name,
    url: normalizedUrl,
    icon,
    createdAt,
    updatedAt
  }
}

function normalizeWebApps (value: unknown): WebAppShortcut[] {
  if (!Array.isArray(value)) return []

  const normalized = value
    .map(normalizeWebAppShortcut)
    .filter((webApp): webApp is WebAppShortcut => Boolean(webApp))

  const seenIds = new Set<string>()
  const seenUrls = new Set<string>()
  const deduped: WebAppShortcut[] = []

  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const webApp = normalized[index]
    if (seenIds.has(webApp.id) || seenUrls.has(webApp.url)) continue
    seenIds.add(webApp.id)
    seenUrls.add(webApp.url)
    deduped.push(webApp)
  }

  return deduped.reverse()
}

function normalizeProjectLaunchModes (value: unknown): Record<string, 'embed' | 'window'> {
  const input = (value && typeof value === 'object') ? value as Record<string, unknown> : {}
  const normalized: Record<string, 'embed' | 'window'> = {}

  for (const [projectId, mode] of Object.entries(input)) {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) continue
    normalized[normalizedProjectId] = mode === 'window' ? 'window' : 'embed'
  }

  return normalized
}

function normalizeEnabledProviderIds (
  value: unknown,
  providers: AIProvider[],
  fallbackProviderId?: string
): string[] {
  const providerIds = new Set(providers.map(provider => provider.id))
  const seen = new Set<string>()
  const enabledProviderIds = Array.isArray(value)
    ? value
      .filter((providerId): providerId is string => typeof providerId === 'string' && providerId.trim().length > 0)
      .map(providerId => providerId.trim())
      .filter((providerId) => {
        if (!providerIds.has(providerId) || seen.has(providerId)) return false
        seen.add(providerId)
        return true
      })
    : []

  if (enabledProviderIds.length === 0 && fallbackProviderId && providerIds.has(fallbackProviderId)) {
    enabledProviderIds.push(fallbackProviderId)
  }

  return enabledProviderIds
}

function normalizeProvidersConfig (config: AIProvidersConfig): AIProvidersConfig {
  const providers = config.providers.map(provider => normalizeProvider(provider))
  let activeProviderId = providers.some(p => p.id === config.activeProviderId)
    ? config.activeProviderId
    : ''
  let enabledProviderIds = normalizeEnabledProviderIds(config.enabledProviderIds, providers, activeProviderId)

  if (!activeProviderId) {
    activeProviderId = enabledProviderIds[0] || providers[0]?.id || ''
  }

  if (activeProviderId && !enabledProviderIds.includes(activeProviderId)) {
    enabledProviderIds = [activeProviderId, ...enabledProviderIds]
  }

  return {
    providers,
    activeProviderId,
    enabledProviderIds: Array.from(new Set(enabledProviderIds))
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

  /** Replace settings on disk with a normalized object. */
  replace (data: Record<string, unknown>): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8')
      this._cache = data
    } catch (err) {
      console.error('[settings] Failed to replace settings:', (err as Error).message)
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
      const enabledProviderIds = normalizeEnabledProviderIds(
        (saved as AIProvidersConfig & { enabledProviderIds?: string[] }).enabledProviderIds,
        providers,
        saved.activeProviderId
      )
      const activeProviderId = providers.some(p => p.id === saved.activeProviderId)
        ? saved.activeProviderId
        : (enabledProviderIds[0] || providers[0]?.id || '')

      const normalizedEnabledProviderIds = enabledProviderIds.includes(activeProviderId)
        ? enabledProviderIds
        : (activeProviderId ? [activeProviderId, ...enabledProviderIds] : enabledProviderIds)

      return {
        providers,
        activeProviderId,
        enabledProviderIds: Array.from(new Set(normalizedEnabledProviderIds))
      }
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
      return {
        providers: [migrated],
        activeProviderId: 'default',
        enabledProviderIds: ['default']
      }
    }

    return { providers: [], activeProviderId: '', enabledProviderIds: [] }
  }

  /**
   * Save multi-provider configuration.
   */
  saveProviders (config: AIProvidersConfig): void {
    const normalized = normalizeProvidersConfig(config)
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

  /** Get persisted launchpad layout preferences. */
  getLaunchpadLayout (): LaunchpadLayout {
    const settings = this.read()
    return normalizeLaunchpadLayout(settings.launchpadLayout)
  }

  /** Save launchpad layout preferences. */
  saveLaunchpadLayout (layout: LaunchpadLayout): void {
    this.write({ launchpadLayout: normalizeLaunchpadLayout(layout) })
  }

  /** Get persisted web app shortcuts for the launchpad. */
  getWebApps (): WebAppShortcut[] {
    const settings = this.read()
    return normalizeWebApps(settings.webApps)
  }

  /** Save persisted web app shortcuts for the launchpad. */
  saveWebApps (webApps: WebAppShortcut[]): void {
    this.write({ webApps: normalizeWebApps(webApps) })
  }

  /** Get theme preference: 'system', 'light', or 'dark'. */
  getThemePreference (): ThemePreference {
    const settings = this.read()
    return normalizeThemePreference(settings.themePreference)
  }

  /** Save theme preference. */
  saveThemePreference (preference: ThemePreference): void {
    this.write({ themePreference: normalizeThemePreference(preference) })
  }

  /** Get AI execution preferences. */
  getAIExecutionPreferences (): AIExecutionPreferences {
    const settings = this.read()
    return normalizeAIExecutionPreferences(settings.aiExecutionPreferences)
  }

  /** Save AI execution preferences. */
  saveAIExecutionPreferences (preferences: AIExecutionPreferences): void {
    this.write({ aiExecutionPreferences: normalizeAIExecutionPreferences(preferences) })
  }

  /** Build a normalized, portable settings snapshot for encrypted export. */
  exportPortableConfig (): PortableSettingsConfig {
    const settings = this.read()
    return {
      providers: this.getProviders(),
      themePreference: this.getThemePreference(),
      aiExecutionPreferences: this.getAIExecutionPreferences(),
      launchpadLayout: this.getLaunchpadLayout(),
      webApps: this.getWebApps(),
      projectLaunchModes: normalizeProjectLaunchModes(settings.projectLaunchModes)
    }
  }

  /** Replace local settings with an imported, normalized snapshot. */
  importPortableConfig (config: PortableSettingsConfig): PortableSettingsConfig {
    const normalizedProviders = normalizeProvidersConfig(config.providers || {
      providers: [],
      activeProviderId: '',
      enabledProviderIds: []
    })
    const activeProvider = normalizedProviders.providers.find(provider => provider.id === normalizedProviders.activeProviderId)

    const nextSettings: Record<string, unknown> = {
      aiProviders: normalizedProviders,
      aiApiKey: activeProvider?.apiKey || '',
      aiBaseUrl: activeProvider?.baseUrl || '',
      aiModel: activeProvider?.activeModel || '',
      themePreference: normalizeThemePreference(config.themePreference),
      aiExecutionPreferences: normalizeAIExecutionPreferences(config.aiExecutionPreferences),
      launchpadLayout: normalizeLaunchpadLayout(config.launchpadLayout),
      webApps: normalizeWebApps(config.webApps),
      projectLaunchModes: normalizeProjectLaunchModes(config.projectLaunchModes)
    }

    this.replace(nextSettings)
    return this.exportPortableConfig()
  }
}
