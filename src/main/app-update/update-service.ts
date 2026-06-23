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
const CHECK_TIMEOUT_MS = 15000
const DOWNLOADS_SUBDIR = 'updates'
const PROGRESS_EMIT_INTERVAL_MS = 120
const UPDATE_CONFIG_ERROR_KEY = 'mainDialog.updateConfigRequired'

interface RemoteUpdateResponse {
  status?: string
  latestVersion?: string
  publishedAt?: string
  notes?: {
    zh?: unknown
    en?: unknown
  }
  asset?: {
    fileName?: string
    downloadUrl?: string
    sha512?: string
    sha256?: string
    size?: unknown
  }
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
  const baseUrl = normalizeUrlBase(config.websiteBaseUrl || '')
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
  return joinWebsiteUrl(website.baseUrl, '/api/app-update/latest')
}

function normalizeNotes (value: unknown): AppUpdateNotes | null {
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

function normalizeAsset (value: unknown): AppUpdateAssetInfo | null {
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
    if (this.state.status === 'downloading') {
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

      const payload = await response.json() as RemoteUpdateResponse
      const now = new Date().toISOString()
      const notes = normalizeNotes(payload.notes)
      const asset = normalizeAsset(payload.asset)

      if (payload.status === 'update_available') {
        const nextState: AppUpdateState = {
          ...this.createBaseState(),
          status: 'update_available',
          latestVersion: typeof payload.latestVersion === 'string' && payload.latestVersion.trim()
            ? payload.latestVersion.trim()
            : null,
          channel,
          lastCheckedAt: now,
          publishedAt: typeof payload.publishedAt === 'string' && payload.publishedAt.trim()
            ? payload.publishedAt.trim()
            : null,
          downloadedFilePath: this.state.downloadedFilePath,
          error: null,
          notes,
          asset,
          website: { ...this.website }
        }

        this.state = await this.reconcileRestoredDownload(nextState)
        this.persistAndEmit()
        return this.getState()
      }

      if (payload.status === 'unsupported_platform') {
        this.updateState({
          status: 'unsupported_platform',
          latestVersion: typeof payload.latestVersion === 'string' && payload.latestVersion.trim()
            ? payload.latestVersion.trim()
            : null,
          lastCheckedAt: now,
          publishedAt: typeof payload.publishedAt === 'string' && payload.publishedAt.trim()
            ? payload.publishedAt.trim()
            : null,
          downloadedFilePath: null,
          progress: null,
          error: null,
          notes,
          asset: null,
          website: { ...this.website }
        })
        return this.getState()
      }

      this.updateState({
        status: 'up_to_date',
        latestVersion: typeof payload.latestVersion === 'string' && payload.latestVersion.trim()
          ? payload.latestVersion.trim()
          : app.getVersion(),
        lastCheckedAt: now,
        publishedAt: typeof payload.publishedAt === 'string' && payload.publishedAt.trim()
          ? payload.publishedAt.trim()
          : null,
        downloadedFilePath: null,
        progress: null,
        error: null,
        notes,
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
