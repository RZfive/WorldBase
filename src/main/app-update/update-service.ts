import { app, shell } from 'electron'
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
const DEFAULT_UPDATE_API_PATH = '/api/releases?latest=1'
const CHECK_TIMEOUT_MS = 15000
const DOWNLOADS_SUBDIR = 'updates'
const PROGRESS_EMIT_INTERVAL_MS = 120
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
  if (!website.baseUrl) return ''
  return joinWebsiteUrl(website.baseUrl, DEFAULT_UPDATE_API_PATH)
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

function resolveDownloadUrl (input: Record<string, unknown>, website: AppUpdateWebsiteLinks): string {
  const explicit = getTrimmedString(input.downloadUrl) || getTrimmedString(input.url)
  if (isValidHttpUrl(explicit)) return explicit

  if (explicit.startsWith('/') && isValidHttpUrl(website.baseUrl)) {
    try {
      return new URL(explicit, website.baseUrl).toString()
    } catch {
      return ''
    }
  }

  const slug = getTrimmedString(input.slug)
  if (slug && isValidHttpUrl(website.baseUrl)) {
    return joinWebsiteUrl(website.baseUrl, `/api/download/${encodeURIComponent(slug)}`)
  }

  return ''
}

function normalizeAsset (value: unknown, website: AppUpdateWebsiteLinks): AppUpdateAssetInfo | null {
  if (!isRecord(value)) return null

  const input = value
  const downloadUrl = resolveDownloadUrl(input, website)
  const slug = getTrimmedString(input.slug)
  const format = getTrimmedString(input.format).replace(/^\./, '')
  const fileName = getTrimmedString(input.fileName) ||
    getFileNameFromUrl(downloadUrl) ||
    (slug && format ? `${slug}.${format}` : slug)
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

function getPlatformAliases (platform: string): string[] {
  switch (platform) {
    case 'win32': return ['win32', 'windows', 'win']
    case 'darwin': return ['darwin', 'macos', 'mac os', 'mac']
    case 'linux': return ['linux']
    default: return [platform]
  }
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

function isInstallableAsset (asset: Record<string, unknown>): boolean {
  const kind = getTrimmedString(asset.kind).toLowerCase()
  if (kind && kind !== 'installer') return false

  const format = getTrimmedString(asset.format).toLowerCase()
  const fileName = getTrimmedString(asset.fileName) || getFileNameFromUrl(getTrimmedString(asset.url) || getTrimmedString(asset.downloadUrl))
  const extension = path.extname(fileName).replace(/^\./, '').toLowerCase()
  const installableFormats = new Set(['exe', 'msi', 'dmg', 'pkg', 'appimage'])
  return !format || installableFormats.has(format) || installableFormats.has(extension)
}

function assetMatchesRuntime (asset: Record<string, unknown>, platform: string, arch: string): boolean {
  const text = createAssetSearchText(asset)
  const platformMatches = getPlatformAliases(platform).some(alias => text.includes(alias))
  const archMatches = getArchAliases(arch).some(alias => text.includes(alias))
  return platformMatches && archMatches
}

function selectReleaseAsset (
  assetsValue: unknown,
  options: { platform: string; arch: string; website: AppUpdateWebsiteLinks }
): AppUpdateAssetInfo | null {
  if (!Array.isArray(assetsValue)) return null

  const assets = assetsValue.filter(isRecord).filter(isInstallableAsset)
  const exactMatch = assets.find(asset => assetMatchesRuntime(asset, options.platform, options.arch))
  const fallbackMatch = assets.find(asset => getPlatformAliases(options.platform).some(alias => createAssetSearchText(asset).includes(alias)))
  return normalizeAsset(exactMatch || fallbackMatch || null, options.website)
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
  const asset = normalizeAsset(response.asset, options.website) ||
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

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(body || t('mainDialog.updateApiHttpStatus', { status: response.status }))
      }

      const payload = await response.json() as unknown
      const remoteUpdate = normalizeRemoteUpdatePayload(payload, {
        channel,
        currentVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        website: this.website
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
    if (process.platform !== 'win32') {
      return this.fail(t('mainDialog.updateDownloadUnsupportedPlatform'))
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
    if (process.platform !== 'win32') {
      const state = this.fail(t('mainDialog.updateInstallUnsupportedPlatform'))
      return { success: false, state, error: state.error || undefined }
    }

    if (!this.state.downloadedFilePath || !fs.existsSync(this.state.downloadedFilePath)) {
      const state = this.fail(t('mainDialog.updateInstallerMissing'))
      return { success: false, state, error: state.error || undefined }
    }

    this.updateState({ status: 'installing', error: null })

    const error = await shell.openPath(this.state.downloadedFilePath)
    if (error) {
      const state = this.fail(error)
      return { success: false, state, error }
    }

    this.updateState({
      status: 'install_triggered',
      progress: null,
      error: null
    })

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
