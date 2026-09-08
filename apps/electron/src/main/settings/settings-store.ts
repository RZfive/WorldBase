import fs from 'node:fs'
import path from 'node:path'
import { t } from '../i18n/main-i18n.js'
import type { AppUpdateAssetInfo, AppUpdateChannel, AppUpdateConfig, AppUpdateNotes, AppUpdateProgress, AppUpdateState, AppUpdateStatus, AppUpdateWebsiteLinks } from '../../shared/app-update-types.js'
import { CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN, DEFAULT_CHAT_FONT_SIZE } from '../../shared/chat-font-preferences.js'

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
  /** Wire protocol: 'anthropic' uses the native Messages API; default auto-detects from baseUrl. */
  apiProtocol?: 'openai' | 'anthropic'
  models: string[]
  /** Context window per model name */
  modelContextWindows?: Record<string, number>
  /** Capability flags per model name. */
  modelCapabilities?: Record<string, { imageGeneration?: boolean; imageEditing?: boolean }>
  /** Currently selected model for this provider */
  activeModel: string
  /** Whether to enable thinking/reasoning mode for compatible models */
  enableThinking?: boolean
  /** Default sampling temperature for this provider. Unset → engine default (0.3). */
  temperature?: number
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

/**
 * An app the user pinned to the dock so it stays available even when not
 * running. `kind: 'project'` references a local project by id; `kind: 'browser'`
 * references a web shortcut by id/url. Display metadata (name/type/icon) is
 * captured at pin time so the dock can render a cold pin without a live lookup.
 */
export interface PinnedDockApp {
  id: string
  kind: 'project' | 'browser'
  name: string
  type?: string
  icon?: string
  url?: string
  addedAt: string
}

export type ThemePreference = 'system' | 'light' | 'dark'

/**
 * Persisted language preference. `'system'` resolves at runtime to the
 * platform locale. Kept here (rather than the global env.d.ts type) because the
 * main process owns persistence; the renderer re-declares the same union in
 * env.d.ts for its own typing.
 */
export type LanguagePreference = 'zh-CN' | 'en-US' | 'system'

export const DEFAULT_LANGUAGE_PREFERENCE: LanguagePreference = 'system'
export type AIExecutionAuthMode = 'strict' | 'auto'
/** Which agent harness handles chat execution in Electron. */
export type HarnessBackend = 'ts' | 'rust'

export interface AIExecutionPreferences {
  notifyOnTaskComplete: boolean
  enableAiLogging: boolean
  harnessBackend: HarnessBackend
}

/**
 * Chat message font customization. `fontFamily` is empty for the app's default
 * system font stack; otherwise a system font family name returned by the Local
 * Font Access API. `fontSize` is the message body size in px, clamped to
 * [CHAT_FONT_SIZE_MIN, CHAT_FONT_SIZE_MAX]. Older snapshots stored a coarse
 * `fontSizePreset` bucket — `normalizeChatFontPreferences` migrates those.
 */
export interface ChatFontPreferences {
  fontFamily: string
  fontSize: number
}

export interface CostSettings {
  modelPricing: Array<{ model: string; inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number }>
  budgetLimit: number | null
}

export type MCPTransportType = 'stdio' | 'streamable-http' | 'sse'

export interface MCPServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: MCPTransportType
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  url: string
  headers: Record<string, string>
  timeoutMs: number
}

export interface PortableSettingsConfig {
  providers: AIProvidersConfig
  themePreference: ThemePreference
  languagePreference: LanguagePreference
  aiExecutionPreferences: AIExecutionPreferences
  chatFontPreferences: ChatFontPreferences
  costSettings: CostSettings
  mcpServers: MCPServerConfig[]
  launchpadLayout: LaunchpadLayout
  webApps: WebAppShortcut[]
  pinnedDockApps: PinnedDockApp[]
  projectLaunchModes: Record<string, 'embed' | 'window'>
}

export const DEFAULT_AI_EXECUTION_PREFERENCES: AIExecutionPreferences = {
  notifyOnTaskComplete: true,
  enableAiLogging: false,
  // Rust is the only actively developed harness.  `ts` remains readable for
  // existing user settings as a frozen compatibility backend.
  harnessBackend: 'rust'
}

export const DEFAULT_CHAT_FONT_PREFERENCES: ChatFontPreferences = {
  fontFamily: '',
  fontSize: DEFAULT_CHAT_FONT_SIZE
}

/** Legacy coarse bucket → px, for migrating older portable config snapshots. */
const FONT_SIZE_PRESET_TO_PX: Record<string, number> = {
  small: 14,
  medium: 16,
  large: 18
}

export const DEFAULT_MODEL_CONTEXT_WINDOW = 100000
export const DEFAULT_MCP_SERVER_TIMEOUT_MS = 15000
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

function normalizeModelCapabilities (
  value: unknown,
  models: string[]
): Record<string, { imageGeneration?: boolean; imageEditing?: boolean }> {
  const input = (value && typeof value === 'object') ? value as Record<string, unknown> : {}
  const normalized: Record<string, { imageGeneration?: boolean; imageEditing?: boolean }> = {}

  for (const model of models) {
    const raw = (input[model] && typeof input[model] === 'object')
      ? input[model] as Record<string, unknown>
      : {}
    normalized[model] = {
      imageGeneration: raw.imageGeneration === true,
      imageEditing: raw.imageEditing === true
    }
  }

  return normalized
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

  const modelCapabilities = normalizeModelCapabilities(input.modelCapabilities, models)

  const activeModel = models.includes(input.activeModel) ? input.activeModel : (models[0] || '')

  return {
    id: input.id,
    name: input.name,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    apiKey: input.apiKey,
    apiProtocol: input.apiProtocol === 'anthropic' || input.apiProtocol === 'openai' ? input.apiProtocol : undefined,
    models,
    modelContextWindows,
    modelCapabilities,
    activeModel,
    enableThinking: input.enableThinking ?? false,
    temperature: normalizeTemperature(input.temperature)
  }
}

/** Clamp a saved provider temperature to the valid range, or drop it if unset/invalid. */
function normalizeTemperature (value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return undefined
  return Math.min(Math.max(parsed, 0), 2)
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
          : t('mainDialog.defaultLaunchpadFolderName')
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

function normalizeLanguagePreference (value: unknown): LanguagePreference {
  if (value === 'zh-CN' || value === 'en-US' || value === 'system') {
    return value
  }
  return DEFAULT_LANGUAGE_PREFERENCE
}

function normalizeAIExecutionPreferences (value: unknown): AIExecutionPreferences {
  const input = (value && typeof value === 'object') ? value as Record<string, unknown> : {}
  return {
    notifyOnTaskComplete: typeof input.notifyOnTaskComplete === 'boolean'
      ? input.notifyOnTaskComplete
      : DEFAULT_AI_EXECUTION_PREFERENCES.notifyOnTaskComplete,
    enableAiLogging: typeof input.enableAiLogging === 'boolean'
      ? input.enableAiLogging
      : DEFAULT_AI_EXECUTION_PREFERENCES.enableAiLogging,
    // Rust is the only actively maintained Harness. Preserve an explicit
    // legacy `ts` choice for existing installations, but treat missing or
    // invalid values as the Rust default instead of reviving Node silently.
    harnessBackend: input.harnessBackend === 'ts' ? 'ts' : 'rust'
  }
}

function clampChatFontSize (value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CHAT_FONT_SIZE
  const rounded = Math.round(value)
  if (rounded < CHAT_FONT_SIZE_MIN) return CHAT_FONT_SIZE_MIN
  if (rounded > CHAT_FONT_SIZE_MAX) return CHAT_FONT_SIZE_MAX
  return rounded
}

function normalizeChatFontSize (value: unknown, legacyPreset: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampChatFontSize(value)
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return clampChatFontSize(parsed)
  }
  // Legacy coarse bucket from older portable config snapshots.
  if (typeof legacyPreset === 'string' && FONT_SIZE_PRESET_TO_PX[legacyPreset] !== undefined) {
    return FONT_SIZE_PRESET_TO_PX[legacyPreset]
  }
  return DEFAULT_CHAT_FONT_SIZE
}

function normalizeChatFontPreferences (value: unknown): ChatFontPreferences {
  const input = (value && typeof value === 'object') ? value as Record<string, unknown> : {}
  const rawFamily = typeof input.fontFamily === 'string' ? input.fontFamily.trim() : ''
  // Strip stray quotes/commas a user (or a malformed import) might have introduced,
  // so the value is always a bare family name.
  const fontFamily = rawFamily.replace(/["',]/g, '').trim()
  return {
    fontFamily,
    fontSize: normalizeChatFontSize(input.fontSize, input.fontSizePreset)
  }
}

function normalizeModelPricingEntry (entry: unknown): { model: string; inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number } | null {
  if (!entry || typeof entry !== 'object') return null

  const input = entry as Record<string, unknown>
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (!model) return null

  const inputPerMillion = Number(input.inputPerMillion)
  const outputPerMillion = Number(input.outputPerMillion)
  const cacheReadPerMillion = Number(input.cacheReadPerMillion)

  return {
    model,
    inputPerMillion: Number.isFinite(inputPerMillion) ? inputPerMillion : 0,
    outputPerMillion: Number.isFinite(outputPerMillion) ? outputPerMillion : 0,
    cacheReadPerMillion: Number.isFinite(cacheReadPerMillion) ? cacheReadPerMillion : 0
  }
}

function normalizeCostSettings (value: unknown): CostSettings {
  const input = (value && typeof value === 'object') ? value as Record<string, unknown> : {}
  const modelPricing = Array.isArray(input.modelPricing)
    ? input.modelPricing
      .map(normalizeModelPricingEntry)
      .filter((entry): entry is NonNullable<ReturnType<typeof normalizeModelPricingEntry>> => Boolean(entry))
    : []
  const rawBudgetLimit = input.budgetLimit == null ? null : Number(input.budgetLimit)
  // Empty and legacy zero values mean "no cap"; the input uses 0 as its HTML
  // minimum but a $0 session budget would otherwise silently block every call.
  const budgetLimit = rawBudgetLimit != null && Number.isFinite(rawBudgetLimit) && rawBudgetLimit > 0
    ? rawBudgetLimit
    : null

  const seenModels = new Set<string>()
  return {
    modelPricing: modelPricing.filter((entry) => {
      if (seenModels.has(entry.model)) return false
      seenModels.add(entry.model)
      return true
    }),
    budgetLimit
  }
}

function normalizeStringArray (value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim())
}

function normalizeStringMap (value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}

  const normalized: Record<string, string> = {}
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.trim()
    if (!normalizedKey) continue
    const normalizedValue = typeof rawValue === 'string'
      ? rawValue
      : (rawValue == null ? '' : String(rawValue))
    normalized[normalizedKey] = normalizedValue
  }
  return normalized
}

function normalizeMcpTransportType (value: unknown): MCPTransportType {
  if (value === 'streamable-http' || value === 'sse' || value === 'stdio') {
    return value
  }
  return 'stdio'
}

function normalizeMcpTimeout (value: unknown): number {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric >= 1000) {
    return Math.floor(numeric)
  }
  return DEFAULT_MCP_SERVER_TIMEOUT_MS
}

function normalizeMcpServerConfig (value: unknown): MCPServerConfig | null {
  if (!value || typeof value !== 'object') return null

  const input = value as Record<string, unknown>
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!id || !name) return null

  const transport = normalizeMcpTransportType(input.transport)
  const urlValue = typeof input.url === 'string' ? input.url.trim() : ''
  let normalizedUrl = ''
  if (urlValue) {
    try {
      normalizedUrl = new URL(urlValue).toString()
    } catch {
      normalizedUrl = ''
    }
  }

  return {
    id,
    name,
    enabled: input.enabled !== false,
    transport,
    command: typeof input.command === 'string' ? input.command.trim() : '',
    args: normalizeStringArray(input.args),
    cwd: typeof input.cwd === 'string' ? input.cwd.trim() : '',
    env: normalizeStringMap(input.env),
    url: normalizedUrl,
    headers: normalizeStringMap(input.headers),
    timeoutMs: normalizeMcpTimeout(input.timeoutMs)
  }
}

function normalizeMcpServers (value: unknown): MCPServerConfig[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const normalized: MCPServerConfig[] = []

  for (const item of value) {
    const server = normalizeMcpServerConfig(item)
    if (!server || seen.has(server.id)) continue
    seen.add(server.id)
    normalized.push(server)
  }

  return normalized.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
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

function normalizePinnedDockApp (value: unknown): PinnedDockApp | null {
  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const kind = record.kind === 'browser' ? 'browser' : 'project'
  if (!id || !name) return null

  let url: string | undefined
  if (kind === 'browser') {
    const rawUrl = typeof record.url === 'string' ? record.url.trim() : ''
    if (!rawUrl) return null
    try {
      const parsed = new URL(rawUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
      url = parsed.toString()
    } catch {
      return null
    }
  }

  const type = typeof record.type === 'string' && record.type.trim()
    ? record.type.trim()
    : undefined
  const icon = typeof record.icon === 'string' && record.icon.trim()
    ? record.icon.trim()
    : undefined
  const addedAt = typeof record.addedAt === 'string' && record.addedAt.trim()
    ? record.addedAt.trim()
    : new Date().toISOString()

  return { id, kind, name, type, icon, url, addedAt }
}

function normalizePinnedDockApps (value: unknown): PinnedDockApp[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const normalized: PinnedDockApp[] = []
  for (const item of value) {
    const pinned = normalizePinnedDockApp(item)
    if (!pinned || seen.has(pinned.id)) continue
    seen.add(pinned.id)
    normalized.push(pinned)
  }
  return normalized
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

function normalizeAppUpdateConfig (value: unknown): AppUpdateConfig {
  const input = (value && typeof value === 'object') ? value as Record<string, unknown> : {}

  return {
    websiteBaseUrl: normalizeBaseUrl(input.websiteBaseUrl),
    updateApiUrl: normalizeBaseUrl(input.updateApiUrl),
    downloadsPageUrl: normalizeBaseUrl(input.downloadsPageUrl),
    updatesPageUrl: normalizeBaseUrl(input.updatesPageUrl)
  }
}

function normalizeAppUpdateChannel (value: unknown): AppUpdateChannel {
  return value === 'beta' ? 'beta' : 'stable'
}

function normalizeAppUpdateStatus (value: unknown): AppUpdateStatus {
  switch (value) {
    case 'checking':
    case 'up_to_date':
    case 'unsupported_platform':
    case 'update_available':
    case 'downloading':
    case 'downloaded':
    case 'installing':
    case 'install_triggered':
    case 'failed':
      return value
    default:
      return 'idle'
  }
}

function normalizeAppUpdateNotes (value: unknown): AppUpdateNotes | null {
  if (!value || typeof value !== 'object') return null

  const input = value as Record<string, unknown>
  const zh = Array.isArray(input.zh)
    ? input.zh.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    : []
  const en = Array.isArray(input.en)
    ? input.en.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    : []

  if (zh.length === 0 && en.length === 0) return null
  return { zh, en }
}

function normalizeAppUpdateAssetInfo (value: unknown): AppUpdateAssetInfo | null {
  if (!value || typeof value !== 'object') return null

  const input = value as Record<string, unknown>
  const fileName = typeof input.fileName === 'string' ? input.fileName.trim() : ''
  const downloadUrl = typeof input.downloadUrl === 'string' ? input.downloadUrl.trim() : ''
  if (!fileName || !downloadUrl) return null

  const size = Number(input.size)
  return {
    fileName,
    downloadUrl,
    sha512: typeof input.sha512 === 'string' && input.sha512.trim() ? input.sha512.trim() : undefined,
    sha256: typeof input.sha256 === 'string' && input.sha256.trim() ? input.sha256.trim().toLowerCase() : undefined,
    size: Number.isFinite(size) && size >= 0 ? size : null
  }
}

function normalizeAppUpdateProgress (value: unknown): AppUpdateProgress | null {
  if (!value || typeof value !== 'object') return null

  const input = value as Record<string, unknown>
  const bytesDownloaded = Number(input.bytesDownloaded)
  const totalBytes = Number(input.totalBytes)
  const percent = Number(input.percent)

  return {
    bytesDownloaded: Number.isFinite(bytesDownloaded) && bytesDownloaded >= 0 ? bytesDownloaded : 0,
    totalBytes: Number.isFinite(totalBytes) && totalBytes >= 0 ? totalBytes : null,
    percent: Number.isFinite(percent) && percent >= 0 ? percent : null
  }
}

function normalizeAppUpdateWebsiteLinks (value: unknown): AppUpdateWebsiteLinks {
  const input = (value && typeof value === 'object') ? value as Record<string, unknown> : {}
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  const downloadsUrl = typeof input.downloadsUrl === 'string' ? input.downloadsUrl.trim() : ''
  const updatesUrl = typeof input.updatesUrl === 'string' ? input.updatesUrl.trim() : ''

  return {
    baseUrl,
    downloadsUrl,
    updatesUrl,
    configured: Boolean(input.configured) && Boolean(baseUrl) && Boolean(downloadsUrl) && Boolean(updatesUrl)
  }
}

function normalizeAppUpdateState (value: unknown): AppUpdateState | null {
  if (!value || typeof value !== 'object') return null

  const input = value as Record<string, unknown>
  return {
    status: normalizeAppUpdateStatus(input.status),
    currentVersion: typeof input.currentVersion === 'string' ? input.currentVersion.trim() : '',
    latestVersion: typeof input.latestVersion === 'string' && input.latestVersion.trim() ? input.latestVersion.trim() : null,
    channel: normalizeAppUpdateChannel(input.channel),
    platform: typeof input.platform === 'string' ? input.platform.trim() : '',
    arch: typeof input.arch === 'string' ? input.arch.trim() : '',
    lastCheckedAt: typeof input.lastCheckedAt === 'string' && input.lastCheckedAt.trim() ? input.lastCheckedAt.trim() : null,
    publishedAt: typeof input.publishedAt === 'string' && input.publishedAt.trim() ? input.publishedAt.trim() : null,
    downloadedFilePath: typeof input.downloadedFilePath === 'string' && input.downloadedFilePath.trim() ? input.downloadedFilePath.trim() : null,
    progress: normalizeAppUpdateProgress(input.progress),
    error: typeof input.error === 'string' && input.error.trim() ? input.error.trim() : null,
    notes: normalizeAppUpdateNotes(input.notes),
    asset: normalizeAppUpdateAssetInfo(input.asset),
    website: normalizeAppUpdateWebsiteLinks(input.website)
  }
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

  /** Get apps the user pinned to the dock. */
  getPinnedDockApps (): PinnedDockApp[] {
    const settings = this.read()
    return normalizePinnedDockApps(settings.pinnedDockApps)
  }

  /** Save apps the user pinned to the dock. */
  savePinnedDockApps (apps: PinnedDockApp[]): void {
    this.write({ pinnedDockApps: normalizePinnedDockApps(apps) })
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

  /** Get language preference: 'zh-CN', 'en-US', or 'system'. */
  getLanguagePreference (): LanguagePreference {
    const settings = this.read()
    return normalizeLanguagePreference(settings.languagePreference)
  }

  /** Save language preference. */
  saveLanguagePreference (preference: LanguagePreference): void {
    this.write({ languagePreference: normalizeLanguagePreference(preference) })
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

  /** Get chat message font preferences. */
  getChatFontPreferences (): ChatFontPreferences {
    const settings = this.read()
    return normalizeChatFontPreferences(settings.chatFontPreferences)
  }

  /** Save chat message font preferences. */
  saveChatFontPreferences (preferences: ChatFontPreferences): void {
    this.write({ chatFontPreferences: normalizeChatFontPreferences(preferences) })
  }

  /** Get the persisted update source configuration. */
  getAppUpdateConfig (): AppUpdateConfig {
    const settings = this.read()
    return normalizeAppUpdateConfig(settings.appUpdateConfig)
  }

  /** Save the update source configuration for future app starts. */
  saveAppUpdateConfig (config: AppUpdateConfig): void {
    this.write({ appUpdateConfig: normalizeAppUpdateConfig(config) })
  }

  /** Get the last app update snapshot persisted by the main process. */
  getAppUpdateState (): AppUpdateState | null {
    const settings = this.read()
    return normalizeAppUpdateState(settings.appUpdateState)
  }

  /** Save the app update snapshot for About/Updates restoration. */
  saveAppUpdateState (state: AppUpdateState): void {
    this.write({ appUpdateState: normalizeAppUpdateState(state) })
  }

  /** Get cost tracking settings. */
  getCostSettings (): CostSettings {
    const settings = this.read()
    return normalizeCostSettings(settings.costSettings)
  }

  /** Save cost tracking settings. */
  saveCostSettings (costSettings: CostSettings): void {
    this.write({ costSettings: normalizeCostSettings(costSettings) })
  }

  /** Get configured MCP servers. */
  getMcpServers (): MCPServerConfig[] {
    const settings = this.read()
    return normalizeMcpServers(settings.mcpServers)
  }

  /** Save configured MCP servers. */
  saveMcpServers (servers: MCPServerConfig[]): void {
    this.write({ mcpServers: normalizeMcpServers(servers) })
  }

  /** Build a normalized, portable settings snapshot for encrypted export. */
  exportPortableConfig (): PortableSettingsConfig {
    const settings = this.read()
    return {
      providers: this.getProviders(),
      themePreference: this.getThemePreference(),
      languagePreference: this.getLanguagePreference(),
      aiExecutionPreferences: this.getAIExecutionPreferences(),
      chatFontPreferences: this.getChatFontPreferences(),
      costSettings: this.getCostSettings(),
      mcpServers: this.getMcpServers(),
      launchpadLayout: this.getLaunchpadLayout(),
      webApps: this.getWebApps(),
      pinnedDockApps: this.getPinnedDockApps(),
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
      languagePreference: normalizeLanguagePreference(config.languagePreference),
      aiExecutionPreferences: normalizeAIExecutionPreferences(config.aiExecutionPreferences),
      chatFontPreferences: normalizeChatFontPreferences(config.chatFontPreferences),
      costSettings: normalizeCostSettings(config.costSettings),
      mcpServers: normalizeMcpServers(config.mcpServers),
      launchpadLayout: normalizeLaunchpadLayout(config.launchpadLayout),
      webApps: normalizeWebApps(config.webApps),
      pinnedDockApps: normalizePinnedDockApps(config.pinnedDockApps),
      projectLaunchModes: normalizeProjectLaunchModes(config.projectLaunchModes)
    }

    this.replace(nextSettings)
    return this.exportPortableConfig()
  }
}
