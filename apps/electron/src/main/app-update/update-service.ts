import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createHash, createPublicKey, randomUUID, verify as cryptoVerify } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import extract from 'extract-zip'
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
import {
  HOT_PAYLOAD_PUBLIC_KEYS,
  getHotRoot,
  getInstalledVersion,
  getEffectiveVersion,
  isHotPayloadActive,
  markHotBootOk,
  readPendingEvents,
  clearPendingEvents,
  resetBootState,
  writeCurrentPointer,
  pruneHotVersions,
  type HotPayloadManifest,
  type HotPendingEvent
} from './hot-payload-store.js'

const APP_ID = 'com.theworld.app'
const DEFAULT_UPDATE_WEBSITE_BASE_URL = 'https://worldbase.world'
const DEFAULT_UPDATE_API_BASE_URL = 'https://api.worldbase.world'
const DEFAULT_UPDATE_API_PATH = '/api/app-update/latest'
const LEGACY_UPDATE_API_BASE_PATH = '/api/releases'
const INSTALL_ID_FILE = 'install-id.json'
const CHECK_TIMEOUT_MS = 15000
const DOWNLOADS_SUBDIR = 'updates'
const PROGRESS_EMIT_INTERVAL_MS = 120
const APP_QUIT_AFTER_INSTALL_TRIGGER_MS = 300
// If quit cleanup hangs (e.g. a stuck harness child), launch the installer
// anyway and hard-exit so the user never ends up with neither app nor installer.
const INSTALL_QUIT_CLEANUP_TIMEOUT_MS = 15_000
const INSTALLER_SPAWN_CONFIRM_TIMEOUT_MS = 5_000
const UPDATER_LOG_FILE = 'updater.log'
const UPDATE_CONFIG_ERROR_KEY = 'mainDialog.updateConfigRequired'
const HOT_STAGING_PREFIX = 'staging-'
const UPDATE_EVENT_TIMEOUT_MS = 8000

type UpdateEventPhase = 'downloaded' | 'verified' | 'applied' | 'boot_ok' | 'rolled_back' | 'failed'

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
  hotPayload?: unknown
}

interface NormalizedRemoteUpdate {
  status: Extract<AppUpdateStatus, 'update_available' | 'up_to_date' | 'unsupported_platform'>
  latestVersion: string | null
  publishedAt: string | null
  notes: AppUpdateNotes | null
  asset: AppUpdateAssetInfo | null
  hotPayload: AppUpdateAssetInfo | null
}

interface NormalizedHotPayload {
  manifest: Record<string, unknown>
  manifestSig: string
}

/** manifest.sig 的签名原文是 CI 里写入的 manifest.json 字节。 */
function verifyManifestSignature (manifestBytes: Buffer, signatureBase64: string): boolean {
  const signature = Buffer.from(signatureBase64.trim().replace(/\s+/g, ''), 'base64')
  for (const publicKeyBase64 of HOT_PAYLOAD_PUBLIC_KEYS) {
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(publicKeyBase64, 'base64'),
        format: 'der',
        type: 'spki'
      })
      if (cryptoVerify(null, manifestBytes, publicKey, signature)) return true
    } catch {
      // 尝试下一把公钥（密钥轮换期间新旧并存）
    }
  }
  return false
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
  options: { website: AppUpdateWebsiteLinks; apiBaseUrl: string },
  kind: 'installer' | 'hot_payload' = 'installer'
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
    size: parseAssetSize(input.size),
    kind,
    electronVersion: kind === 'hot_payload' ? (getTrimmedString(input.electronVersion) || undefined) : undefined,
    minBaseVersion: kind === 'hot_payload' ? (getTrimmedString(input.minBaseVersion) || undefined) : undefined
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

/** 热更新包不是安装器格式，平台匹配已由服务端完成，这里只做字段规范化。 */
function normalizeHotPayloadAsset (value: unknown, options: AssetSelectionOptions): AppUpdateAssetInfo | null {
  if (!isRecord(value)) return null
  return normalizeAsset(value, options, 'hot_payload')
}

function isRuntimeAssetInfoSupportedForPlatform (asset: AppUpdateAssetInfo, platform: string): boolean {
  if (asset.kind === 'hot_payload') return true
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
  const hotPayload = normalizeHotPayloadAsset(response.hotPayload, options)

  if (explicitStatus) {
    const hasUpdate = explicitStatus === 'update_available'
    return {
      status: explicitStatus,
      latestVersion: latestVersion || null,
      publishedAt,
      notes,
      asset: hasUpdate ? asset : null,
      hotPayload: hasUpdate ? hotPayload : null
    }
  }

  const isUpdateAvailable = compareVersions(latestVersion, options.currentVersion) > 0
  return {
    status: isUpdateAvailable ? 'update_available' : 'up_to_date',
    latestVersion,
    publishedAt,
    notes,
    asset: isUpdateAvailable ? asset : null,
    hotPayload: isUpdateAvailable ? hotPayload : null
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
    installerAsset: state.installerAsset ? { ...state.installerAsset } : null,
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

async function listFilesRecursive (rootDir: string, relDir = ''): Promise<string[]> {
  const entries = await fsp.readdir(path.join(rootDir, relDir), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(rootDir, relPath))
    } else if (entry.isFile()) {
      files.push(relPath)
    }
  }
  return files.sort()
}

/**
 * The installer is launched only after quit cleanup has finished (see
 * `launchPendingInstaller`), so no launch-side delay is needed. Windows runs
 * the NSIS installer directly: wrapping it in `cmd /c start "" "<path>"` broke
 * because Node re-quotes arguments for CreateProcess and turns the inner
 * quotes into `\"`, which cmd does not understand, so `start` received a
 * mangled path and silently failed inside a hidden console.
 */
function buildInstallerLaunchConfig (installerPath: string, platform: string): InstallerLaunchConfig | null {
  switch (normalizePlatformFamily(platform)) {
    case 'win':
      // `--updated` is the electron-builder NSIS flag electron-updater passes on
      // upgrades: skips the "already installed" prompt and keeps user choices.
      return { command: installerPath, args: ['--updated'] }
    case 'mac':
      return { command: '/usr/bin/open', args: [installerPath] }
    case 'linux':
      return { command: installerPath, args: [] }
    default:
      return null
  }
}

function isWindowsSpawnError (error: NodeJS.ErrnoException): boolean {
  // libuv reports ERROR_ELEVATION_REQUIRED (740) as EACCES, and older Node
  // builds surface it as UNKNOWN. Both mean "needs ShellExecute + UAC".
  return error.code === 'EACCES' || error.code === 'UNKNOWN' || error.code === 'EPERM'
}

/**
 * Spawn detached and wait until the OS confirms the child exists. The
 * synchronous `spawn()` return value does not prove the process started; on
 * Windows a launch failure only surfaces through the async `error` event.
 */
async function spawnDetachedAndConfirm (config: InstallerLaunchConfig): Promise<void> {
  const child = spawn(config.command, config.args, {
    detached: true,
    stdio: 'ignore'
  })

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Installer spawn not confirmed within ${INSTALLER_SPAWN_CONFIRM_TIMEOUT_MS}ms`))
    }, INSTALLER_SPAWN_CONFIRM_TIMEOUT_MS)
    const onSpawn = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('spawn', onSpawn)
      child.off('error', onError)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })

  child.unref()
}

function isInstallerPathSupportedForPlatform (installerPath: string, platform: string): boolean {
  const extension = path.extname(installerPath).replace(/^\./, '').toLowerCase()
  const platformFormats = getInstallableFormatsForPlatform(platform)
  return platformFormats.has(extension)
}

export class UpdateService extends EventEmitter {
  private readonly settingsStore: SettingsStore
  private readonly updatesDir: string
  private readonly logFilePath: string
  private config: AppUpdateConfig
  private website: AppUpdateWebsiteLinks
  private updateApiUrl: string
  private state: AppUpdateState
  private activeDownloadAbortController: AbortController | null = null
  private pendingInstallerPath: string | null = null
  private pendingInstallerLaunch: Promise<boolean> | null = null
  private installQuitGuard: NodeJS.Timeout | null = null
  private disposed = false

  constructor (settingsStore: SettingsStore) {
    super()
    this.settingsStore = settingsStore
    this.config = this.settingsStore.getAppUpdateConfig()
    this.website = createWebsiteLinks(this.config)
    this.updateApiUrl = createUpdateApiUrl(this.config, this.website)
    this.updatesDir = path.join(app.getPath('userData'), DOWNLOADS_SUBDIR)
    this.logFilePath = path.join(app.getPath('userData'), UPDATER_LOG_FILE)
    this.state = this.restorePersistedState()
  }

  /**
   * Append-only diagnostics for the install hand-off. The window is already
   * closing when the installer launches, so this file is the only place a
   * Windows launch failure can be seen after the fact.
   */
  private log (message: string): void {
    const line = `[${new Date().toISOString()}] ${message}\n`
    console.log(`[update] ${message}`)
    fsp.appendFile(this.logFilePath, line).catch(() => {})
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
      version: getEffectiveVersion(),
      appId: APP_ID,
      platform: process.platform,
      arch: process.arch,
      channel: inferChannelFromVersion(getEffectiveVersion()),
      website: { ...this.website }
    }
  }

  getState (): AppUpdateState {
    return cloneState(this.state)
  }

  async checkForUpdates (channel = inferChannelFromVersion(getEffectiveVersion())): Promise<AppUpdateState> {
    if (this.disposed) return this.getState()
    if (!isValidHttpUrl(this.updateApiUrl)) {
      return this.fail(t(UPDATE_CONFIG_ERROR_KEY))
    }
    if (this.state.status === 'checking' || this.state.status === 'downloading' || this.state.status === 'applying') {
      return this.getState()
    }

    this.updateState({
      status: 'checking',
      channel,
      error: null,
      progress: null
    })

    // bootstrap 里记下的回滚事件（网络栈没起来时写盘的）在这里补发。
    void this.flushPendingRollbackEvents()

    const timeoutController = new AbortController()
    const timeout = setTimeout(() => {
      timeoutController.abort()
    }, CHECK_TIMEOUT_MS)

    const buildUrl = async (apiPath: string): Promise<URL> => {
      const legacy = apiPath !== DEFAULT_UPDATE_API_PATH
      const url = new URL(this.updateApiUrl)
      url.pathname = apiPath
      url.search = ''
      url.searchParams.set('channel', channel)
      url.searchParams.set('platform', process.platform)
      url.searchParams.set('arch', process.arch)
      // current 是生效版本（可能已是热更新版本），installed 是安装器版本。
      url.searchParams.set('current', getEffectiveVersion())
      if (legacy) {
        // /api/releases 只认 latest=1；installed/electron/device 是新接口的参数
        url.searchParams.set('latest', '1')
      } else {
        url.searchParams.set('installed', getInstalledVersion())
        url.searchParams.set('electron', process.versions.electron)
        const deviceId = await this.getInstallId()
        if (deviceId) url.searchParams.set('device', deviceId)
      }
      return url
    }

    try {
      const fetchPayload = async (apiPath: string): Promise<unknown> => {
        const url = await buildUrl(apiPath)
        const response = await fetch(url, {
          signal: timeoutController.signal,
          headers: { Accept: 'application/json' }
        })
        // 老版服务端还没有 /api/app-update/latest：退回 /api/releases 兼容判定。
        if (response.status === 404 && apiPath === DEFAULT_UPDATE_API_PATH) {
          return await fetchPayload(LEGACY_UPDATE_API_BASE_PATH)
        }
        const body = await response.text().catch(() => '')
        if (!response.ok) {
          throw new Error(body || t('mainDialog.updateApiHttpStatus', { status: response.status }))
        }
        return parseUpdateApiJsonResponse(response, body)
      }

      const payload = await fetchPayload(DEFAULT_UPDATE_API_PATH)
      const remoteUpdate = normalizeRemoteUpdatePayload(payload, {
        channel,
        currentVersion: getEffectiveVersion(),
        platform: process.platform,
        arch: process.arch,
        website: this.website,
        apiBaseUrl: resolveApiBaseUrl(this.updateApiUrl)
      })
      const now = new Date().toISOString()

      if (remoteUpdate.status === 'update_available') {
        const pendingAsset = remoteUpdate.hotPayload || remoteUpdate.asset
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
          asset: pendingAsset,
          installerAsset: remoteUpdate.asset,
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
          installerAsset: null,
          website: { ...this.website }
        })
        return this.getState()
      }

      this.updateState({
        status: 'up_to_date',
        latestVersion: remoteUpdate.latestVersion || getEffectiveVersion(),
        lastCheckedAt: now,
        publishedAt: remoteUpdate.publishedAt,
        downloadedFilePath: null,
        progress: null,
        error: null,
        notes: remoteUpdate.notes,
        asset: null,
        installerAsset: null,
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

      // 热更新包：校验过的 zip 直接进入应用阶段（解压/验签/逐文件校验），
      // 成功后状态为 applied（重启生效），失败自动退回安装包流程。
      if (asset.kind === 'hot_payload') {
        void this.reportUpdateEvent('downloaded', version, 'hot_payload')
        return await this.applyHotPayload()
      }

      return this.getState()
    } catch (error) {
      await ensureDeleted(tempPath)
      return this.fail((error as Error).message || t('mainDialog.updateDownloadFailed'))
    } finally {
      this.activeDownloadAbortController = null
    }
  }

  /**
   * 应用已下载的热更新包（docs/desktop-hot-update-design.md 5.5.3）：
   * 解压到 staging → manifest ed25519 验签 → 逐文件 sha256/size 白名单校验
   * → 原子 rename 生效 → 写 current.json → 重置 boot-state。
   * 任何一步失败都删掉 staging、上报 failed，并把状态退回安装包流程。
   */
  async applyHotPayload (): Promise<AppUpdateState> {
    const asset = this.state.asset
    const version = this.state.latestVersion
    const zipPath = this.state.downloadedFilePath
    if (!asset || asset.kind !== 'hot_payload' || !version || !zipPath || !fs.existsSync(zipPath)) {
      return this.getState()
    }

    this.updateState({ status: 'applying', progress: null, error: null })

    const hotRoot = getHotRoot()
    const stagingDir = path.join(hotRoot, `${HOT_STAGING_PREFIX}${version}`)
    const targetDir = path.join(hotRoot, version)

    try {
      await fsp.rm(stagingDir, { recursive: true, force: true })
      await fsp.mkdir(stagingDir, { recursive: true })
      await extract(zipPath, { dir: stagingDir })

      // 非 Windows：兜底保证 harness 可执行位（zip 的 unix 权限元数据可能丢失）。
      if (process.platform !== 'win32') {
        await fsp.chmod(path.join(stagingDir, 'harness', 'worldbase-app-server'), 0o755).catch(() => {})
      }

      // manifest 完整性：ed25519 签名对 manifest.json 原始字节验证
      const manifestBytes = await fsp.readFile(path.join(stagingDir, 'manifest.json'))
      const manifest = JSON.parse(manifestBytes.toString('utf8')) as HotPayloadManifest
      const sigText = await fsp.readFile(path.join(stagingDir, 'manifest.sig'), 'utf8').catch(() => '')
      if (!sigText || !verifyManifestSignature(manifestBytes, sigText)) {
        throw new Error(t('mainDialog.hotSignatureFailed'))
      }
      if (manifest.kind !== 'hot_payload' || manifest.version !== version || !Array.isArray(manifest.files) || manifest.files.length === 0) {
        throw new Error(t('mainDialog.hotManifestMismatch'))
      }
      if (manifest.electronVersion && manifest.electronVersion !== process.versions.electron) {
        throw new Error(t('mainDialog.hotElectronMismatch'))
      }
      if (compareVersions(manifest.version, getEffectiveVersion()) <= 0) {
        throw new Error(t('mainDialog.hotVersionNotNewer'))
      }

      await this.reportUpdateEvent('verified', version, 'hot_payload')

      // 逐文件校验：路径白名单（拒绝绝对路径与 ..），sha256 与 size 必须一致
      const listedFiles = new Set<string>(['manifest.json', 'manifest.sig'])
      for (const file of manifest.files) {
        if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string') {
          throw new Error(t('mainDialog.hotManifestMismatch'))
        }
        const relPath = file.path.replace(/\\/g, '/')
        if (relPath.startsWith('/') || relPath.split('/').some(part => part === '..' || part.length === 0)) {
          throw new Error(t('mainDialog.hotManifestMismatch'))
        }
        const filePath = path.join(stagingDir, ...relPath.split('/'))
        const stat = await fsp.stat(filePath).catch(() => null)
        if (!stat || !stat.isFile()) {
          throw new Error(t('mainDialog.hotFileMissing', { file: relPath }))
        }
        if (typeof file.size === 'number' && stat.size !== file.size) {
          throw new Error(t('mainDialog.hotHashFailed', { file: relPath }))
        }
        const actual = await hashFile(filePath, { fileName: relPath, downloadUrl: '', sha256: file.sha256, size: null })
        if (actual.sha256 !== file.sha256.toLowerCase()) {
          throw new Error(t('mainDialog.hotHashFailed', { file: relPath }))
        }
        listedFiles.add(relPath)
      }

      // staging 里出现清单外文件即整体失败
      const actualFiles = await listFilesRecursive(stagingDir)
      const extraFile = actualFiles.find(file => !listedFiles.has(file))
      if (extraFile) {
        throw new Error(t('mainDialog.hotExtraFile', { file: extraFile }))
      }

      // 原子生效：rename 同盘目录，写指针，重置启动计数，清理旧版本
      await fsp.rm(targetDir, { recursive: true, force: true })
      await fsp.rename(stagingDir, targetDir)
      writeCurrentPointer(version)
      resetBootState(version)
      await pruneHotVersions()

      this.updateState({
        status: 'applied',
        downloadedFilePath: zipPath,
        progress: null,
        error: null
      })
      this.log(`hot payload v${version} applied; restart to activate`)
      void this.reportUpdateEvent('applied', version, 'hot_payload')
      return this.getState()
    } catch (error) {
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
      const message = (error as Error).message || t('mainDialog.hotApplyFailed')
      this.log(`hot payload apply failed: ${message}`)
      void this.reportUpdateEvent('failed', version, 'hot_payload', message)
      // 绝不能让用户卡住：退回安装包流程
      this.updateState({
        status: this.state.installerAsset ? 'update_available' : 'failed',
        asset: this.state.installerAsset ? { ...this.state.installerAsset } : null,
        downloadedFilePath: null,
        progress: null,
        error: t('mainDialog.hotApplyFailed')
      })
      return this.getState()
    }
  }

  async installDownloadedUpdate (): Promise<{ success: boolean; state: AppUpdateState; error?: string }> {
    // 热更新包不走安装器：applied 状态下 relaunch，重启后 bootstrap 加载新包。
    if (this.state.asset?.kind === 'hot_payload') {
      if (this.state.status !== 'applied') {
        return { success: false, state: this.getState(), error: t('mainDialog.hotApplyFailed') }
      }
      this.updateState({ status: 'install_triggered', progress: null, error: null })
      this.log(`hot payload relaunch requested (v${this.state.latestVersion ?? '?'})`)
      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, APP_QUIT_AFTER_INSTALL_TRIGGER_MS)
      return { success: true, state: this.getState() }
    }

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

    if (!buildInstallerLaunchConfig(installerPath, process.platform)) {
      const message = t('mainDialog.updateInstallUnsupportedPlatform')
      const state = this.fail(message)
      return { success: false, state, error: message }
    }

    // Do not launch yet. The NSIS installer taskkills WorldBase.exe as soon
    // as it starts (build/installer.nsh), which would cut quit cleanup short
    // and could corrupt history/harness state. Instead, record the pending
    // installer and let the before-quit cleanup in electron/main.ts call
    // `launchPendingInstaller()` once every service has shut down.
    this.pendingInstallerPath = installerPath
    this.log(`install requested: ${installerPath} (v${this.state.latestVersion ?? '?'} over v${app.getVersion()})`)

    this.updateState({
      status: 'install_triggered',
      progress: null,
      error: null
    })

    this.installQuitGuard = setTimeout(() => {
      this.log(`quit cleanup exceeded ${INSTALL_QUIT_CLEANUP_TIMEOUT_MS}ms; launching installer and forcing exit`)
      void this.launchPendingInstaller().finally(() => app.exit(0))
    }, INSTALL_QUIT_CLEANUP_TIMEOUT_MS)

    // Let the IPC reply reach the renderer before quit begins.
    setTimeout(() => {
      app.quit()
    }, APP_QUIT_AFTER_INSTALL_TRIGGER_MS)

    return { success: true, state: this.getState() }
  }

  /**
   * Launch the installer recorded by `installDownloadedUpdate`. Called from the
   * before-quit cleanup after all services are down and again by the quit
   * guard timer; both callers share one launch attempt. Resolves true when
   * the OS confirmed the installer process started. Safe to call when nothing
   * is pending and after `dispose()`.
   */
  async launchPendingInstaller (): Promise<boolean> {
    if (this.pendingInstallerLaunch) return await this.pendingInstallerLaunch
    const installerPath = this.pendingInstallerPath
    if (!installerPath) return false

    if (this.installQuitGuard) {
      clearTimeout(this.installQuitGuard)
      this.installQuitGuard = null
    }

    this.pendingInstallerLaunch = this.launchInstaller(installerPath)
    return await this.pendingInstallerLaunch
  }

  private async launchInstaller (installerPath: string): Promise<boolean> {
    const launchConfig = buildInstallerLaunchConfig(installerPath, process.platform)
    if (!launchConfig) {
      this.recordInstallLaunchFailure(t('mainDialog.updateInstallUnsupportedPlatform'))
      return false
    }

    if (normalizePlatformFamily(process.platform) === 'linux') {
      await fsp.chmod(installerPath, 0o755).catch((error: Error) => {
        this.log(`chmod failed (continuing): ${error.message}`)
      })
    }

    this.log(`spawning: ${launchConfig.command} ${launchConfig.args.join(' ')}`)
    try {
      await spawnDetachedAndConfirm(launchConfig)
      this.log('installer process started')
      return true
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      this.log(`spawn failed: code=${err.code ?? 'n/a'} errno=${err.errno ?? 'n/a'} ${err.message}`)
      if (normalizePlatformFamily(process.platform) !== 'win' || !isWindowsSpawnError(err)) {
        this.recordInstallLaunchFailure(err.message || t('mainDialog.updateInstallFailed'))
        return false
      }
    }

    // Elevation required (a previous per-machine install) or an odd CreateProcess
    // refusal: hand off to ShellExecute, which shows the UAC prompt itself.
    this.log('falling back to shell.openPath')
    const shellError = await shell.openPath(installerPath)
    if (shellError) {
      this.log(`shell.openPath failed: ${shellError}`)
      this.recordInstallLaunchFailure(shellError)
      return false
    }
    this.log('installer opened via shell')
    return true
  }

  /**
   * 主窗口 ready 且 Rust harness 握手成功后由 main.ts 调用：
   * 确认本次热包启动健康，归零 boot-state 计数并上报 boot_ok。
   */
  async confirmHotBoot (): Promise<void> {
    if (!isHotPayloadActive()) return
    const effectiveVersion = getEffectiveVersion()
    markHotBootOk()
    this.log(`hot payload v${effectiveVersion} boot confirmed ok`)
    await this.reportUpdateEvent('boot_ok', effectiveVersion, 'hot_payload')
  }

  /** 安装-id 与 startup-report-service 共用；见 getInstallId 的灰度桶说明。 */
  private async getInstallId (): Promise<string | null> {
    const filePath = path.join(app.getPath('userData'), INSTALL_ID_FILE)
    try {
      const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8')) as { id?: unknown }
      if (typeof parsed.id === 'string' && parsed.id.trim()) return parsed.id.trim()
    } catch {
      // 首次启动没有该文件
    }
    try {
      const id = randomUUID()
      await fsp.mkdir(path.dirname(filePath), { recursive: true })
      await fsp.writeFile(filePath, JSON.stringify({ id }, null, 2), 'utf8')
      return id
    } catch {
      return null
    }
  }

  private async reportUpdateEvent (
    phase: UpdateEventPhase,
    toVersion: string,
    kind: 'installer' | 'hot_payload',
    error?: string,
    channel = this.state.channel
  ): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), UPDATE_EVENT_TIMEOUT_MS)
    try {
      const deviceId = await this.getInstallId()
      await fetch(`${resolveApiBaseUrl(this.updateApiUrl)}/api/app-update/events`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(deviceId ? { deviceId } : {}),
          platform: process.platform,
          arch: process.arch,
          channel,
          kind,
          fromVersion: getInstalledVersion(),
          toVersion,
          phase,
          ...(error ? { error: String(error).slice(0, 500) } : {})
        })
      })
    } catch {
      // 埋点失败不影响更新流程
    } finally {
      clearTimeout(timer)
    }
  }

  /** bootstrap 回滚时网络栈还没起，事件落盘在 pending-events.json，这里补发。 */
  private async flushPendingRollbackEvents (): Promise<void> {
    const pending = await readPendingEvents()
    if (pending.length === 0) return
    for (const event of pending as HotPendingEvent[]) {
      await this.reportUpdateEvent(
        'rolled_back',
        event.toVersion,
        'hot_payload',
        event.error,
        inferChannelFromVersion(event.toVersion)
      )
    }
    await clearPendingEvents()
    this.log(`flushed ${pending.length} pending rollback event(s)`)
  }

  /**
   * The window is gone by the time a launch fails, so persist the failure;
   * `restorePersistedState` surfaces it in About & Updates on next start.
   */
  private recordInstallLaunchFailure (message: string): void {
    this.state = {
      ...this.state,
      status: 'failed',
      progress: null,
      error: message
    }
    this.settingsStore.saveAppUpdateState(this.state)
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
    // Keep pendingInstallerPath and the quit guard: dispose() runs during quit
    // cleanup, and launchPendingInstaller() is called right after it.
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
      installerAsset: null,
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

    // 热更新包已生效（重启后运行的就是 latestVersion）：视为已是最新。
    if (restored.latestVersion && restored.latestVersion === getEffectiveVersion() && restored.asset?.kind === 'hot_payload') {
      return {
        ...restored,
        status: 'up_to_date',
        currentVersion: getEffectiveVersion(),
        downloadedFilePath: null,
        asset: null,
        installerAsset: null,
        error: null
      }
    }

    // 应用中断（下载完没来得及 apply）：退回待下载状态，走安装包或重新检查。
    if (restored.status === 'applying') {
      restored.status = restored.installerAsset ? 'update_available' : 'idle'
      restored.asset = restored.installerAsset ? { ...restored.installerAsset } : null
      restored.downloadedFilePath = null
      restored.error = null
    }

    if (restored.downloadedFilePath && !fs.existsSync(restored.downloadedFilePath)) {
      restored.downloadedFilePath = null
      if (restored.status === 'downloaded' || restored.status === 'install_triggered' || restored.status === 'applied') {
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
  }  private async reconcileRestoredDownload (state: AppUpdateState): Promise<AppUpdateState> {
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
