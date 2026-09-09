import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  AppAboutInfo,
  AppUpdateAssetInfo,
  AppUpdateChannel,
  AppUpdateConfig,
  AppUpdateNotes,
  AppUpdateProgress,
  AppUpdateState,
  AppUpdateStatus,
  AppUpdateWebsiteKind,
  AppUpdateWebsiteLinks
} from '../../shared/app-update-types.js'
import { t } from '../i18n/main-i18n.js'
import type { SettingsStore } from '../settings/settings-store.js'

const APP_ID = 'com.theworld.app'
const DEFAULT_UPDATE_WEBSITE_BASE_URL = 'https://worldbase.world'
const DEFAULT_UPDATE_API_BASE_URL = 'https://api.worldbase.world'
const DEFAULT_UPDATE_API_PATH = '/api/releases?latest=1'
const CHECK_TIMEOUT_MS = 15000
const DOWNLOADS_SUBDIR = 'updates'
const PROGRESS_EMIT_INTERVAL_MS = 120
const INSTALLER_LAUNCH_DELAY_SECONDS = 2
const APP_QUIT_AFTER_INSTALL_TRIGGER_MS = 300
const UPDATE_CONFIG_ERROR_KEY = 'mainDialog.updateConfigRequired'

interface RemoteUpdateResponse {
  status?: string
  version?: string
  latestVersion?: string
  publishedAt?: string
  headline?: unknown
  summary?: unknown
  notes?: unknown
  asset?: unknown
  assets?: unknown
  item?: unknown
  items?: unknown
}

interface NormalizedRemoteUpdate {
  status: Extract<AppUpdateStatus, 'update_available' | 'up_to_date' | 'unsupported_platform'>
  latestVersion: string | null
  publishedAt: string | null
  notes: AppUpdateNotes | null
  asset: AppUpdateAssetInfo | null
}

interface VersionParts {
  core: number[]
  prerelease: string[]
}

interface AssetSelectionOptions {
  platform: string
  arch: string
  website: AppUpdateWebsiteLinks
  apiBaseUrl: string
}

interface InstallerLaunchConfig {
  command: string
  args: string[]
  windowsHide?: boolean
}

type UpdatePlatformFamily = 'win' | 'mac' | 'linux'

function inferChannelFromVersion (version: string): AppUpdateChannel {
  return /(?:alpha|beta|rc)/i.test(version) ? 'beta' : 'stable'
}

function normalizeUrlBase (value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.replace(/\/+$/, '')
}

function joinWebsiteUrl (baseUrl: string, pathname: string): string {
  if (!baseUrl) return ''
  return `${baseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getTrimmedString (value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isValidHttpUrl (value: string): boolean {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function cloneConfig (config: AppUpdateConfig): AppUpdateConfig {
  return {
    websiteBaseUrl: config.websiteBaseUrl,
    updateApiUrl: config.updateApiUrl,
    downloadsPageUrl: config.downloadsPageUrl,
    updatesPageUrl: config.updatesPageUrl
  }
}

function createWebsiteLinks (config: AppUpdateConfig): AppUpdateWebsiteLinks {
  const baseUrl = normalizeUrlBase(config.websiteBaseUrl || DEFAULT_UPDATE_WEBSITE_BASE_URL)
  const downloadsUrl = normalizeUrlBase(config.downloadsPageUrl || '') || joinWebsiteUrl(baseUrl, '/downloads')
  const updatesUrl = normalizeUrlBase(config.updatesPageUrl || '') || joinWebsiteUrl(baseUrl, '/updates')

  return {
    baseUrl,
    downloadsUrl,
    updatesUrl,
    configured: isValidHttpUrl(downloadsUrl) && isValidHttpUrl(updatesUrl)
  }
}

function createUpdateApiUrl (config: AppUpdateConfig, website: AppUpdateWebsiteLinks): string {
  const explicit = normalizeUrlBase(config.updateApiUrl || '')
  if (explicit) return explicit
  void website
  return joinWebsiteUrl(DEFAULT_UPDATE_API_BASE_URL, DEFAULT_UPDATE_API_PATH)
}

function resolveApiBaseUrl (updateApiUrl: string): string {
  try {
    const parsed = new URL(updateApiUrl)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return DEFAULT_UPDATE_API_BASE_URL
  }
}

function describeUnexpectedUpdateApiResponse (response: Response, body: string): string {
  const contentType = response.headers.get('content-type') || ''
  const location = response.headers.get('location') || response.url
  const looksLikeHtml = /<!doctype\s+html|<html[\s>]/i.test(body)
  const looksLikeAccess = /cloudflareaccess\.com|Cloudflare Access|cdn-cgi\/access/i.test(`${location}\n${body}`)

  if (looksLikeAccess) {
    return '更新接口被 Cloudflare Access 拦截，请放行 api.worldbase.world 的 /api/releases 公开路径。'
  }

  if (looksLikeHtml) {
    return '更新接口返回了 HTML 页面而不是 JSON，请检查 API 域名和 Access 放行配置。'
  }

  return `更新接口返回了非 JSON 内容：${contentType || 'unknown'}`
}

function parseUpdateApiJsonResponse (response: Response, body: string): unknown {
  const contentType = response.headers.get('content-type') || ''

  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(describeUnexpectedUpdateApiResponse(response, body))
  }

  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new Error('更新接口返回的 JSON 格式无效。')
  }
}

function isProtectedUploadDownloadUrl (value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.pathname.startsWith('/api/uploads/')
  } catch {
    return value.includes('/api/uploads/')
  }
}

function normalizeNotes (value: unknown): AppUpdateNotes | null {
  if (Array.isArray(value)) {
    const notes = value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map(item => item.trim())
    return notes.length > 0 ? { zh: notes, en: notes } : null
  }

  if (typeof value === 'string') {
    const note = value.trim()
    return note ? { zh: [note], en: [note] } : null
  }

  if (!isRecord(value)) return null

  const input = value
  const zh = Array.isArray(input.zh)
    ? input.zh.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    : []
  const en = Array.isArray(input.en)
    ? input.en.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    : []

  if (zh.length === 0 && en.length === 0) return null
  return { zh, en }
}

function normalizeLocalizedText (value: unknown): { zh: string; en: string } {
  if (isRecord(value)) {
    return {
      zh: getTrimmedString(value.zh),
      en: getTrimmedString(value.en)
    }
  }

  const text = getTrimmedString(value)
  return { zh: text, en: text }
}

function uniqueStrings (values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

function normalizeReleaseNotes (value: unknown): AppUpdateNotes | null {
  if (!isRecord(value)) return normalizeNotes(value)

  const notes = normalizeNotes(value.notes)
  const headline = normalizeLocalizedText(value.headline)
  const summary = normalizeLocalizedText(value.summary)
  const zh = uniqueStrings([
    ...(summary.zh ? [summary.zh] : []),
    ...(notes?.zh || []),
    ...(!summary.zh && !notes?.zh.length && headline.zh ? [headline.zh] : [])
  ])
  const en = uniqueStrings([
    ...(summary.en ? [summary.en] : []),
    ...(notes?.en || []),
    ...(!summary.en && !notes?.en.length && headline.en ? [headline.en] : [])
  ])

  if (zh.length === 0 && en.length === 0) return null
  return { zh, en }
}

function parseAssetSize (value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value)
  }

  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  const direct = Number(trimmed)
  if (Number.isFinite(direct) && direct >= 0) {
    return Math.round(direct)
  }

  const match = trimmed.match(/^([\d.]+)\s*(b|kb|mb|gb|tb)$/i)
  if (!match) return null

  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount < 0) return null

  const unit = match[2].toLowerCase()
  const multiplier = unit === 'tb'
    ? 1024 ** 4
    : unit === 'gb'
      ? 1024 ** 3
      : unit === 'mb'
        ? 1024 ** 2
        : unit === 'kb'
          ? 1024
          : 1

  return Math.round(amount * multiplier)
}

function normalizeSha256 (value: unknown): string | undefined {
  const checksum = getTrimmedString(value).toLowerCase()
  return /^[a-f0-9]{64}$/.test(checksum) ? checksum : undefined
}

function normalizeSha512 (value: unknown): string | undefined {
  const checksum = getTrimmedString(value)
  return /^[a-z0-9+/=]{40,}$/i.test(checksum) ? checksum : undefined
}

function getFileNameFromUrl (value: string): string {
  try {
    const parsed = new URL(value)
    return decodeURIComponent(path.basename(parsed.pathname)).trim()
  } catch {
    return ''
  }
}

function resolveDownloadUrl (
  input: Record<string, unknown>,
  options: { website: AppUpdateWebsiteLinks; apiBaseUrl: string }
): string {
  const slug = getTrimmedString(input.slug)
  if (slug && isValidHttpUrl(options.apiBaseUrl)) {
    return joinWebsiteUrl(options.apiBaseUrl, `/api/download/${encodeURIComponent(slug)}`)
  }

  const explicit = getTrimmedString(input.downloadUrl) || getTrimmedString(input.url)
  if (isValidHttpUrl(explicit)) return explicit

  if (explicit.startsWith('/') && isValidHttpUrl(options.apiBaseUrl)) {
    try {
      return new URL(explicit, options.apiBaseUrl).toString()
    } catch {
      return ''
    }
  }

  if (explicit.startsWith('/') && isValidHttpUrl(options.website.baseUrl)) {
    try {
      return new URL(explicit, options.website.baseUrl).toString()
    } catch {
      return ''
    }
  }

  return ''
}

function normalizeAsset (
  value: unknown,
  options: { website: AppUpdateWebsiteLinks; apiBaseUrl: string }
): AppUpdateAssetInfo | null {
  if (!isRecord(value)) return null

  const input = value
  const downloadUrl = resolveDownloadUrl(input, options)
  const slug = getTrimmedString(input.slug)
  const format = getTrimmedString(input.format).replace(/^\./, '')
  const fileName = getTrimmedString(input.fileName) ||
    getFileNameFromUrl(getTrimmedString(input.url)) ||
    (slug && format ? `${slug}.${format}` : '') ||
    getFileNameFromUrl(downloadUrl) ||
    slug
  if (!fileName || !downloadUrl) return null

  return {
    fileName,
    downloadUrl,
    sha512: normalizeSha512(input.sha512),
    sha256: normalizeSha256(input.sha256) || normalizeSha256(input.checksum),
    size: parseAssetSize(input.size)
  }
}

function parseVersionParts (version: string): VersionParts {
  const withoutBuild = version.trim().replace(/^v/i, '').split('+')[0] || ''
  const prereleaseStart = withoutBuild.indexOf('-')
  const corePart = prereleaseStart >= 0 ? withoutBuild.slice(0, prereleaseStart) : withoutBuild
  const prereleasePart = prereleaseStart >= 0 ? withoutBuild.slice(prereleaseStart + 1) : ''
  const core = corePart
    .split('.')
    .slice(0, 3)
    .map(part => Number.parseInt(part.replace(/[^0-9].*$/, ''), 10) || 0)

  while (core.length < 3) core.push(0)

  return {
    core,
    prerelease: prereleasePart
      ? prereleasePart.split('.').map(part => part.trim()).filter(Boolean)
      : []
  }
}

function comparePrereleaseIdentifier (left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)

  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right)
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1
  }

  return left.localeCompare(right, 'en')
}

function compareVersions (left: string, right: string): number {
  const leftParts = parseVersionParts(left)
  const rightParts = parseVersionParts(right)

  for (let index = 0; index < 3; index++) {
    if (leftParts.core[index] !== rightParts.core[index]) {
      return leftParts.core[index] - rightParts.core[index]
    }
  }

  if (leftParts.prerelease.length === 0 && rightParts.prerelease.length === 0) return 0
  if (leftParts.prerelease.length === 0) return 1
  if (rightParts.prerelease.length === 0) return -1

  const maxLength = Math.max(leftParts.prerelease.length, rightParts.prerelease.length)
  for (let index = 0; index < maxLength; index++) {
    const leftIdentifier = leftParts.prerelease[index]
    const rightIdentifier = rightParts.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1

    const result = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier)
    if (result !== 0) return result
  }

  return 0
}

function normalizeRemoteStatus (value: unknown): NormalizedRemoteUpdate['status'] | null {
  switch (value) {
    case 'update_available':
    case 'up_to_date':
    case 'unsupported_platform':
      return value
    default:
      return null
  }
}

function normalizePlatformFamily (platform: string): UpdatePlatformFamily | null {
  const normalized = platform.trim().toLowerCase()
  switch (normalized) {
    case 'win32':
    case 'windows':
    case 'win':
      return 'win'
    case 'darwin':
    case 'macos':
    case 'mac os':
    case 'mac':
    case 'osx':
      return 'mac'
    case 'linux':
      return 'linux'
    default:
      return null
  }
}

function getPlatformAliases (platform: string): string[] {
  switch (normalizePlatformFamily(platform)) {
    case 'win': return ['win32', 'windows', 'win']
    case 'mac': return ['darwin', 'macos', 'mac os', 'mac', 'osx']
    case 'linux': return ['linux']
    default: return [platform]
  }
}

function getInstallableFormatsForPlatform (platform: string): Set<string> {
  switch (normalizePlatformFamily(platform)) {
    case 'win': return new Set(['exe', 'msi'])
    case 'mac': return new Set(['dmg', 'pkg'])
    case 'linux': return new Set(['appimage'])
    default: return new Set()
  }
}

function isSupportedUpdatePlatform (platform: string): boolean {
  return getInstallableFormatsForPlatform(platform).size > 0
}

function getArchAliases (arch: string): string[] {
  switch (arch) {
    case 'x64': return ['x64', 'x86_64', 'amd64']
    case 'arm64': return ['arm64', 'aarch64', 'apple silicon']
    case 'ia32': return ['ia32', 'x86']
    default: return [arch]
  }
}

function createAssetSearchText (asset: Record<string, unknown>): string {
  return [
    asset.slug,
    asset.platform,
    asset.arch,
    asset.format,
    asset.kind,
    asset.fileName,
    asset.url,
    asset.downloadUrl
  ]
    .map(getTrimmedString)
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function escapeRegExp (value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function assetSearchTextIncludesAlias (text: string, alias: string): boolean {
  const parts = alias
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegExp)
  if (parts.length === 0) return false

  const pattern = parts.join('[^a-z0-9]+')
  return new RegExp(`(^|[^a-z0-9])${pattern}($|[^a-z0-9])`).test(text)
}

function getAssetFormats (asset: Record<string, unknown>): string[] {
  const format = getTrimmedString(asset.format).replace(/^\./, '').toLowerCase()
  const fileName = getTrimmedString(asset.fileName) || getFileNameFromUrl(getTrimmedString(asset.url) || getTrimmedString(asset.downloadUrl))
  const extension = path.extname(fileName).replace(/^\./, '').toLowerCase()
  return Array.from(new Set([format, extension].filter(Boolean)))
}

function isInstallableAsset (asset: Record<string, unknown>, platform: string): boolean {
  const kind = getTrimmedString(asset.kind).toLowerCase()
  if (kind && kind !== 'installer') return false

  const platformFormats = getInstallableFormatsForPlatform(platform)
  if (platformFormats.size === 0) return false

  const formats = getAssetFormats(asset)
  return formats.length === 0 || formats.some(format => platformFormats.has(format))
}

function assetMatchesPlatform (asset: Record<string, unknown>, platform: string): boolean {
  const text = createAssetSearchText(asset)
  return getPlatformAliases(platform).some(alias => assetSearchTextIncludesAlias(text, alias))
}

function assetHasPlatformHint (asset: Record<string, unknown>): boolean {
  const text = createAssetSearchText(asset)
  return ['win', 'mac', 'linux'].some(platform =>
    getPlatformAliases(platform).some(alias => assetSearchTextIncludesAlias(text, alias))
  )
}

function assetMatchesOrOmitsPlatform (asset: Record<string, unknown>, platform: string): boolean {
  return assetMatchesPlatform(asset, platform) || !assetHasPlatformHint(asset)
}

function assetMatchesRuntime (asset: Record<string, unknown>, platform: string, arch: string): boolean {
  const text = createAssetSearchText(asset)
  const platformMatches = getPlatformAliases(platform).some(alias => assetSearchTextIncludesAlias(text, alias))
  const archMatches = getArchAliases(arch).some(alias => assetSearchTextIncludesAlias(text, alias))
  return platformMatches && archMatches
}

function selectReleaseAsset (
  assetsValue: unknown,
  options: AssetSelectionOptions
): AppUpdateAssetInfo | null {
  if (!Array.isArray(assetsValue)) return null

  const assets = assetsValue
    .filter(isRecord)
    .filter(asset => isInstallableAsset(asset, options.platform))
  const exactMatch = assets.find(asset => assetMatchesRuntime(asset, options.platform, options.arch))
  const fallbackMatch = assets.find(asset => assetMatchesPlatform(asset, options.platform))
  const genericMatch = assets.find(asset => assetMatchesOrOmitsPlatform(asset, options.platform))
  return normalizeAsset(exactMatch || fallbackMatch || genericMatch || null, options)
}

function normalizeRuntimeAsset (value: unknown, options: AssetSelectionOptions): AppUpdateAssetInfo | null {
  if (!isRecord(value) || !isInstallableAsset(value, options.platform) || !assetMatchesOrOmitsPlatform(value, options.platform)) return null
  return normalizeAsset(value, options)
}

function isRuntimeAssetInfoSupportedForPlatform (asset: AppUpdateAssetInfo, platform: string): boolean {
  const assetRecord = asset as unknown as Record<string, unknown>
  return isInstallableAsset(assetRecord, platform) && assetMatchesOrOmitsPlatform(assetRecord, platform)
}

function selectReleaseItem (payload: RemoteUpdateResponse, channel: AppUpdateChannel): Record<string, unknown> | null {
  if (isRecord(payload.item)) return payload.item
  if (Array.isArray(payload.items)) {
    const releases = payload.items.filter(isRecord)
    return releases.find(item => getTrimmedString(item.channel) === channel) || releases[0] || null
  }
  if (getTrimmedString(payload.version)) return payload as Record<string, unknown>
  return null
}

function normalizeRemoteUpdatePayload (
  payload: unknown,
  options: {
    channel: AppUpdateChannel
    currentVersion: string
    platform: string
    arch: string
    website: AppUpdateWebsiteLinks
    apiBaseUrl: string
  }
): NormalizedRemoteUpdate {
  if (!isRecord(payload)) {
    throw new Error(t('mainDialog.updateCheckFailed'))
  }

  const response = payload as RemoteUpdateResponse
  const releaseItem = selectReleaseItem(response, options.channel)
  const explicitStatus = normalizeRemoteStatus(response.status)
  const latestVersion = getTrimmedString(response.latestVersion) ||
    getTrimmedString(response.version) ||
    (releaseItem ? getTrimmedString(releaseItem.version) : '')

  if (!latestVersion && explicitStatus !== 'unsupported_platform') {
    throw new Error(t('mainDialog.updateCheckFailed'))
  }

  const notes = normalizeReleaseNotes(response) || normalizeReleaseNotes(releaseItem)
  const publishedAt = getTrimmedString(response.publishedAt) ||
    (releaseItem ? getTrimmedString(releaseItem.publishedAt) : '') ||
    null
  const asset = normalizeRuntimeAsset(response.asset, options) ||
    selectReleaseAsset(response.assets, options) ||
    (releaseItem ? selectReleaseAsset(releaseItem.assets, options) : null)

  if (explicitStatus) {
    return {
      status: explicitStatus,
      latestVersion: latestVersion || null,
      publishedAt,
      notes,
      asset: explicitStatus === 'update_available' ? asset : null
    }
  }

  return {
    status: compareVersions(latestVersion, options.currentVersion) > 0 ? 'update_available' : 'up_to_date',
    latestVersion,
    publishedAt,
    notes,
    asset
  }
}

function cloneState (state: AppUpdateState): AppUpdateState {
  return {
    ...state,
    progress: state.progress ? { ...state.progress } : null,
    notes: state.notes
      ? {
          zh: [...state.notes.zh],
          en: [...state.notes.en]
        }
      : null,
    asset: state.asset ? { ...state.asset } : null,
    website: { ...state.website }
  }
}

async function hashFile (filePath: string, asset: AppUpdateAssetInfo): Promise<{ sha256?: string; sha512?: string }> {
  const sha256 = asset.sha256 ? createHash('sha256') : null
  const sha512 = asset.sha512 ? createHash('sha512') : null

  return await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath)

    stream.on('data', (chunk: Buffer) => {
      sha256?.update(chunk)
      sha512?.update(chunk)
    })

    stream.once('error', reject)
    stream.once('end', () => {
      resolve({
        sha256: sha256?.digest('hex'),
        sha512: sha512?.digest('base64')
      })
    })
  })
}

async function ensureDeleted (targetPath: string): Promise<void> {
  try {
    await fsp.unlink(targetPath)
  } catch {
    // ignore missing temp files
  }
}

function buildDelayedWindowsInstallerCommand (installerPath: string): string {
  const escapedPath = installerPath.replace(/"/g, '""')
  return `timeout /t ${INSTALLER_LAUNCH_DELAY_SECONDS} /nobreak >nul & start "" "${escapedPath}"`
}

function buildInstallerLaunchConfig (installerPath: string, platform: string): InstallerLaunchConfig | null {
  switch (normalizePlatformFamily(platform)) {
    case 'win':
      return {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', buildDelayedWindowsInstallerCommand(installerPath)],
        windowsHide: true
      }
    case 'mac':
      return {
        command: '/bin/sh',
        args: [
          '-c',
          'sleep "$1"; open "$2"',
          'worldbase-update-launcher',
          String(INSTALLER_LAUNCH_DELAY_SECONDS),
          installerPath
        ]
      }
    case 'linux':
      return {
        command: '/bin/sh',
        args: [
          '-c',
          'sleep "$1"; chmod +x "$2"; "$2" >/dev/null 2>&1 &',
          'worldbase-update-launcher',
          String(INSTALLER_LAUNCH_DELAY_SECONDS),
          installerPath
        ]
      }
    default:
      return null
  }
}

function isInstallerPathSupportedForPlatform (installerPath: string, platform: string): boolean {
  const extension = path.extname(installerPath).replace(/^\./, '').toLowerCase()
  const platformFormats = getInstallableFormatsForPlatform(platform)
  return platformFormats.has(extension)
}

export class UpdateService extends EventEmitter {
  private readonly settingsStore: SettingsStore
  private readonly updatesDir: string
  private config: AppUpdateConfig
  private website: AppUpdateWebsiteLinks
  private updateApiUrl: string
  private state: AppUpdateState
  private activeDownloadAbortController: AbortController | null = null
  private disposed = false

  constructor (settingsStore: SettingsStore) {
    super()
    this.settingsStore = settingsStore
    this.config = this.settingsStore.getAppUpdateConfig()
    this.website = createWebsiteLinks(this.config)
    this.updateApiUrl = createUpdateApiUrl(this.config, this.website)
    this.updatesDir = path.join(app.getPath('userData'), DOWNLOADS_SUBDIR)
    this.state = this.restorePersistedState()
  }

  getConfig (): AppUpdateConfig {
    return cloneConfig(this.config)
  }

  saveConfig (config: AppUpdateConfig): AppUpdateConfig {
    this.settingsStore.saveAppUpdateConfig(config)
    this.config = this.settingsStore.getAppUpdateConfig()
    this.refreshResolvedConfig()

    const shouldResetConfigFailure = this.state.status === 'failed' && this.state.error === t(UPDATE_CONFIG_ERROR_KEY)
    this.updateState({
      website: { ...this.website },
      ...(shouldResetConfigFailure
        ? {
            status: this.resolveFallbackStatus(),
            error: null
          }
        : {})
    })

    return this.getConfig()
  }

  getAboutInfo (): AppAboutInfo {
    return {
      productName: app.getName(),
      version: app.getVersion(),
      appId: APP_ID,
      platform: process.platform,
      arch: process.arch,
      channel: inferChannelFromVersion(app.getVersion()),
      website: { ...this.website }
    }
  }

  getState (): AppUpdateState {
    return cloneState(this.state)
  }

  async checkForUpdates (channel = inferChannelFromVersion(app.getVersion())): Promise<AppUpdateState> {
    if (this.disposed) return this.getState()
    if (!isValidHttpUrl(this.updateApiUrl)) {
      return this.fail(t(UPDATE_CONFIG_ERROR_KEY))
    }
    if (this.state.status === 'checking' || this.state.status === 'downloading') {
      return this.getState()
    }

    this.updateState({
      status: 'checking',
      channel,
      error: null,
      progress: null
    })

    const timeoutController = new AbortController()
    const timeout = setTimeout(() => {
      timeoutController.abort()
    }, CHECK_TIMEOUT_MS)

    try {
      const url = new URL(this.updateApiUrl)
      if (url.pathname.endsWith('/api/releases') && !url.searchParams.has('latest')) {
        url.searchParams.set('latest', '1')
      }
      url.searchParams.set('channel', channel)
      url.searchParams.set('platform', process.platform)
      url.searchParams.set('arch', process.arch)
      url.searchParams.set('current', app.getVersion())

      const response = await fetch(url, {
        signal: timeoutController.signal,
        headers: {
          Accept: 'application/json'
        }
      })

      const body = await response.text().catch(() => '')

      if (!response.ok) {
        throw new Error(body || t('mainDialog.updateApiHttpStatus', { status: response.status }))
      }

      const payload = parseUpdateApiJsonResponse(response, body)
      const remoteUpdate = normalizeRemoteUpdatePayload(payload, {
        channel,
        currentVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        website: this.website,
        apiBaseUrl: resolveApiBaseUrl(this.updateApiUrl)
      })
      const now = new Date().toISOString()

      if (remoteUpdate.status === 'update_available') {
        const nextState: AppUpdateState = {
          ...this.createBaseState(),
          status: 'update_available',
          latestVersion: remoteUpdate.latestVersion,
          channel,
          lastCheckedAt: now,
          publishedAt: remoteUpdate.publishedAt,
          downloadedFilePath: this.state.downloadedFilePath,
          error: null,
          notes: remoteUpdate.notes,
          asset: remoteUpdate.asset,
          website: { ...this.website }
        }

        this.state = await this.reconcileRestoredDownload(nextState)
        this.persistAndEmit()
        return this.getState()
      }

      if (remoteUpdate.status === 'unsupported_platform') {
        this.updateState({
          status: 'unsupported_platform',
          latestVersion: remoteUpdate.latestVersion,
          lastCheckedAt: now,
          publishedAt: remoteUpdate.publishedAt,
          downloadedFilePath: null,
          progress: null,
          error: null,
          notes: remoteUpdate.notes,
          asset: null,
          website: { ...this.website }
        })
        return this.getState()
      }

      this.updateState({
        status: 'up_to_date',
        latestVersion: remoteUpdate.latestVersion || app.getVersion(),
        lastCheckedAt: now,
        publishedAt: remoteUpdate.publishedAt,
        downloadedFilePath: null,
        progress: null,
        error: null,
        notes: remoteUpdate.notes,
        asset: null,
        website: { ...this.website }
      })
      return this.getState()
    } catch (error) {
      const message = timeoutController.signal.aborted
        ? t('mainDialog.updateCheckTimeout')
        : ((error as Error).message || t('mainDialog.updateCheckFailed'))
      return this.fail(message)
    } finally {
      clearTimeout(timeout)
    }
  }

  async downloadUpdate (): Promise<AppUpdateState> {
    if (this.disposed) return this.getState()
    if (!this.state.asset || !this.state.latestVersion) {
      return this.fail(t('mainDialog.updateNoDownloadableAsset'))
    }
    if (!isSupportedUpdatePlatform(process.platform)) {
      return this.fail(t('mainDialog.updateDownloadUnsupportedPlatform'))
    }
    if (!isRuntimeAssetInfoSupportedForPlatform(this.state.asset, process.platform)) {
      return this.fail(t('mainDialog.updateInstallerPlatformMismatch'))
    }

    const asset = this.state.asset
    const version = this.state.latestVersion
    const targetDir = path.join(this.updatesDir, version)
    const targetPath = path.join(targetDir, asset.fileName)
    const tempPath = `${targetPath}.download`

    try {
      await fsp.mkdir(targetDir, { recursive: true })

      if (fs.existsSync(targetPath)) {
        const existing = await hashFile(targetPath, asset)
        if ((!asset.sha256 || existing.sha256 === asset.sha256) && (!asset.sha512 || existing.sha512 === asset.sha512)) {
          this.updateState({
            status: 'downloaded',
            downloadedFilePath: targetPath,
            progress: asset.size != null
              ? { bytesDownloaded: asset.size, totalBytes: asset.size, percent: 100 }
              : null,
            error: null
          })
          return this.getState()
        }

        await ensureDeleted(targetPath)
      }

      this.activeDownloadAbortController = new AbortController()
      this.updateState({
        status: 'downloading',
        progress: {
          bytesDownloaded: 0,
          totalBytes: asset.size,
          percent: asset.size === 0 ? 100 : null
        },
        error: null
      })

      const response = await fetch(asset.downloadUrl, {
        signal: this.activeDownloadAbortController.signal,
        headers: {
          Accept: 'application/octet-stream'
        }
      })

      if (!response.ok || !response.body) {
        throw new Error(t('mainDialog.updatePackageDownloadFailed', { status: response.status }))
      }

      const totalBytesHeader = Number.parseInt(response.headers.get('content-length') || '', 10)
      const totalBytes = Number.isFinite(totalBytesHeader) && totalBytesHeader > 0
        ? totalBytesHeader
        : asset.size

      const reader = response.body.getReader()
      const writer = fs.createWriteStream(tempPath)
      const sha256 = asset.sha256 ? createHash('sha256') : null
      const sha512 = asset.sha512 ? createHash('sha512') : null
      let bytesDownloaded = 0
      let lastProgressEmitAt = 0

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue

          const chunk = Buffer.from(value)
          bytesDownloaded += chunk.byteLength
          sha256?.update(chunk)
          sha512?.update(chunk)

          if (!writer.write(chunk)) {
            await once(writer, 'drain')
          }

          const now = Date.now()
          if (now - lastProgressEmitAt >= PROGRESS_EMIT_INTERVAL_MS) {
            lastProgressEmitAt = now
            this.updateState({
              progress: this.createProgress(bytesDownloaded, totalBytes)
            }, { persist: false })
          }
        }
      } finally {
        reader.releaseLock()
      }

      await new Promise<void>((resolve, reject) => {
        writer.end((error?: Error | null) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })

      const actualSha256 = sha256?.digest('hex')
      const actualSha512 = sha512?.digest('base64')

      if (asset.sha256 && actualSha256 !== asset.sha256) {
        throw new Error(t('mainDialog.updateSha256Failed'))
      }

      if (asset.sha512 && actualSha512 !== asset.sha512) {
        throw new Error(t('mainDialog.updateSha512Failed'))
      }

      await fsp.rename(tempPath, targetPath)

      this.updateState({
        status: 'downloaded',
        downloadedFilePath: targetPath,
        progress: this.createProgress(bytesDownloaded, totalBytes),
        error: null
      })
      return this.getState()
    } catch (error) {
      await ensureDeleted(tempPath)
      return this.fail((error as Error).message || t('mainDialog.updateDownloadFailed'))
    } finally {
      this.activeDownloadAbortController = null
    }
  }

  async installDownloadedUpdate (): Promise<{ success: boolean; state: AppUpdateState; error?: string }> {
    if (!isSupportedUpdatePlatform(process.platform)) {
      const state = this.fail(t('mainDialog.updateInstallUnsupportedPlatform'))
      return { success: false, state, error: state.error || undefined }
    }

    if (!this.state.downloadedFilePath || !fs.existsSync(this.state.downloadedFilePath)) {
      const state = this.fail(t('mainDialog.updateInstallerMissing'))
      return { success: false, state, error: state.error || undefined }
    }

    const installerPath = this.state.downloadedFilePath
    if (!isInstallerPathSupportedForPlatform(installerPath, process.platform)) {
      const state = this.fail(t('mainDialog.updateInstallerPlatformMismatch'))
      return { success: false, state, error: state.error || undefined }
    }

    this.updateState({ status: 'installing', error: null })

    try {
      const launchConfig = buildInstallerLaunchConfig(installerPath, process.platform)
      if (!launchConfig) {
        throw new Error(t('mainDialog.updateInstallUnsupportedPlatform'))
      }

      const launcher = spawn(launchConfig.command, launchConfig.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: launchConfig.windowsHide
      })
      launcher.unref()
    } catch (error) {
      const message = (error as Error).message || t('mainDialog.updateInstallFailed')
      const state = this.fail(message)
      return { success: false, state, error: message }
    }

    this.updateState({
      status: 'install_triggered',
      progress: null,
      error: null
    })

    setTimeout(() => {
      app.quit()
    }, APP_QUIT_AFTER_INSTALL_TRIGGER_MS)

    return { success: true, state: this.getState() }
  }

  async openWebsitePage (kind: AppUpdateWebsiteKind): Promise<{ success: boolean; error?: string }> {
    const url = kind === 'downloads' ? this.website.downloadsUrl : this.website.updatesUrl
    if (!isValidHttpUrl(url)) {
      return { success: false, error: t('mainDialog.updateWebsiteNotConfigured') }
    }

    await shell.openExternal(url)
    return { success: true }
  }

  dispose (): void {
    this.disposed = true
    this.activeDownloadAbortController?.abort()
    this.removeAllListeners()
  }

  private createBaseState (): AppUpdateState {
    return {
      status: 'idle',
      currentVersion: app.getVersion(),
      latestVersion: null,
      channel: inferChannelFromVersion(app.getVersion()),
      platform: process.platform,
      arch: process.arch,
      lastCheckedAt: null,
      publishedAt: null,
      downloadedFilePath: null,
      progress: null,
      error: null,
      notes: null,
      asset: null,
      website: { ...this.website }
    }
  }

  private refreshResolvedConfig (): void {
    this.website = createWebsiteLinks(this.config)
    this.updateApiUrl = createUpdateApiUrl(this.config, this.website)
  }

  private resolveFallbackStatus (): AppUpdateStatus {
    if (this.state.downloadedFilePath) return 'downloaded'
    if (this.state.asset) return 'update_available'
    return 'idle'
  }

  private restorePersistedState (): AppUpdateState {
    const persisted = this.settingsStore.getAppUpdateState()
    const base = this.createBaseState()
    if (!persisted) return base

    const restored: AppUpdateState = {
      ...base,
      ...persisted,
      currentVersion: base.currentVersion,
      channel: base.channel,
      platform: base.platform,
      arch: base.arch,
      progress: null,
      website: { ...base.website }
    }

    if (restored.latestVersion && restored.latestVersion === base.currentVersion) {
      return {
        ...restored,
        status: 'up_to_date',
        downloadedFilePath: null,
        asset: null,
        error: null
      }
    }

    if (restored.downloadedFilePath && !fs.existsSync(restored.downloadedFilePath)) {
      restored.downloadedFilePath = null
      if (restored.status === 'downloaded' || restored.status === 'install_triggered') {
        restored.status = restored.asset ? 'update_available' : 'idle'
      }
    }

    if (restored.asset && isProtectedUploadDownloadUrl(restored.asset.downloadUrl)) {
      restored.asset = null
      restored.downloadedFilePath = null
      restored.progress = null
      restored.status = 'idle'
    }

    if (restored.asset && !isRuntimeAssetInfoSupportedForPlatform(restored.asset, process.platform)) {
      restored.asset = null
      restored.downloadedFilePath = null
      restored.progress = null
      restored.status = 'idle'
      restored.error = null
    }

    if (restored.status === 'checking' || restored.status === 'downloading' || restored.status === 'installing') {
      restored.status = restored.downloadedFilePath ? 'downloaded' : (restored.asset ? 'update_available' : 'idle')
    }

    return restored
  }

  private async reconcileRestoredDownload (state: AppUpdateState): Promise<AppUpdateState> {
    if (!state.asset || !state.downloadedFilePath || !fs.existsSync(state.downloadedFilePath)) {
      return state
    }

    if (path.basename(state.downloadedFilePath) !== state.asset.fileName) {
      return {
        ...state,
        downloadedFilePath: null
      }
    }

    const existing = await hashFile(state.downloadedFilePath, state.asset)
    if ((state.asset.sha256 && existing.sha256 !== state.asset.sha256) || (state.asset.sha512 && existing.sha512 !== state.asset.sha512)) {
      await ensureDeleted(state.downloadedFilePath)
      return {
        ...state,
        downloadedFilePath: null
      }
    }

    return {
      ...state,
      status: 'downloaded',
      progress: state.asset.size != null
        ? this.createProgress(state.asset.size, state.asset.size)
        : null
    }
  }

  private createProgress (bytesDownloaded: number, totalBytes: number | null): AppUpdateProgress {
    const percent = totalBytes && totalBytes > 0
      ? Math.min(100, Math.round((bytesDownloaded / totalBytes) * 1000) / 10)
      : null

    return {
      bytesDownloaded,
      totalBytes,
      percent
    }
  }

  private updateState (partial: Partial<AppUpdateState>, options: { persist?: boolean } = {}): void {
    this.state = {
      ...this.state,
      ...partial,
      website: partial.website ? { ...partial.website } : this.state.website,
      progress: partial.progress === undefined ? this.state.progress : partial.progress,
      notes: partial.notes === undefined ? this.state.notes : partial.notes,
      asset: partial.asset === undefined ? this.state.asset : partial.asset
    }

    if (options.persist === false) {
      this.emit('stateChanged', this.getState())
      return
    }

    this.persistAndEmit()
  }

  private persistAndEmit (): void {
    this.settingsStore.saveAppUpdateState(this.state)
    this.emit('stateChanged', this.getState())
  }

  private fail (message: string): AppUpdateState {
    this.updateState({
      status: 'failed',
      progress: null,
      error: message
    })
    return this.getState()
  }
}
