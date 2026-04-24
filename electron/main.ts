import { app, BrowserWindow, ipcMain, shell, dialog, session, Notification, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import { AIEngine, type ProgressEvent } from '../src/main/ai-engine/ai-engine.js'
import { USER_ABORT_MESSAGE } from '../src/main/ai-engine/abort-utils.js'
import { ProjectFS } from '../src/main/project-fs/project-fs.js'
import { RuntimeManager } from '../src/main/project-runtime/runtime-manager.js'
import { BuilderService } from '../src/main/project-runtime/builder-service.js'
import { AppGateway } from '../src/main/project-runtime/app-gateway.js'
import { ProcessManagerService } from '../src/main/project-runtime/process-manager-service.js'
import { ProjectApiClient } from '../src/main/project-api-bridge/api-client.js'
import { ProjectDataAccess } from '../src/main/project-data-access/data-access.js'
import { SqliteAdapter } from '../src/main/project-data-access/adapters/sqlite-adapter.js'
import { LanServer } from '../src/main/lan-server/server.js'
import { LAN_SERVER_PORT } from '../src/main/constants.js'
import { SystemService } from '../src/main/system-capabilities/system-service.js'
import { SettingsStore, type AIExecutionAuthMode, type AIExecutionPreferences, type AIProvidersConfig, type LaunchpadLayout, type PortableSettingsConfig, type WebAppShortcut } from '../src/main/settings/settings-store.js'
import { ChatHistoryStore, type Conversation } from '../src/main/settings/chat-history.js'
import { AILogStore } from '../src/main/settings/ai-log-store.js'
import { SkillStore, type Skill } from '../src/main/settings/skill-store.js'
import {
  ScheduledTaskStore,
  type ScheduledTaskDefinition,
  type ScheduledTaskRunReport
} from '../src/main/settings/scheduled-task-store.js'
import type { MessageContent } from '../src/main/ai-engine/providers/openai-provider.js'
import { isOfficeFile, readOfficeFile, detectOfficeType } from '../src/main/ai-engine/agent/tools/office-utils.js'
import { AsyncTaskManager } from '../src/main/ai-engine/agent/tools/async-task-manager.js'
import { DocumentStore } from '../src/main/ai-engine/agent/tools/document-store.js'
import { parseDocument, parseDocumentBuffer, isSupportedDocument, detectDocumentType } from '../src/main/ai-engine/agent/tools/document-parser.js'
import type { CreateSelectionPayload } from '../src/main/ai-engine/agent/tools/document-types.js'
import { buildDocumentRenderPreview, readDocumentRenderAsset } from '../src/main/document-preview/document-render-service.js'
import { decryptPortableSettingsConfig, encryptPortableSettingsConfig, PORTABLE_SETTINGS_APP_ID, PORTABLE_SETTINGS_EXTENSION } from '../src/main/settings/settings-transfer.js'
import { MCPService, type MCPStateSnapshot } from '../src/main/mcp/mcp-service.js'
import type { MCPServerConfig } from '../src/main/settings/settings-store.js'
import { ScheduledTaskService } from '../src/main/scheduler/scheduled-task-service.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Ensure only one instance of the app is running.
// This prevents file lock conflicts when the installer tries to
// uninstall or overwrite the old version while the app is still running.
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  // When a second instance is launched, focus the existing window
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

let mainWindow: BrowserWindow | null = null
let aiEngine: AIEngine | null = null
let projectFS: ProjectFS | null = null
let runtimeManager: RuntimeManager | null = null
let builderService: BuilderService | null = null
let appGateway: AppGateway | null = null
let processManagerService: ProcessManagerService | null = null
let systemService: SystemService | null = null
let apiClient: ProjectApiClient | null = null
let dataAccess: ProjectDataAccess | null = null
let asyncTaskManager: AsyncTaskManager | null = null
let lanServer: LanServer | null = null
let settingsStore: SettingsStore | null = null
let chatHistory: ChatHistoryStore | null = null
let aiLogStore: AILogStore | null = null
let skillStore: SkillStore | null = null
let scheduledTaskStore: ScheduledTaskStore | null = null
let scheduledTaskService: ScheduledTaskService | null = null
let documentStore: DocumentStore | null = null
let mcpService: MCPService | null = null
let isClosingMainWindow = false
let isQuitCleanupRunning = false
let hasFinishedQuitCleanup = false

/** Track standalone project windows keyed by projectId */
const projectWindows = new Map<string, BrowserWindow>()
const activeChatSessions = new Map<string, ActiveChatSession>()

const LOCAL_APP_HOSTS = new Set(['localhost', '127.0.0.1'])
const MAX_UPLOADED_OFFICE_FILE_SIZE_BYTES = 10 * 1024 * 1024
const MAX_UPLOADED_OFFICE_CONTENT_LENGTH = 100000
const VIRTUAL_INTERFACE_NAME_PATTERN = /(loopback|virtual|vmware|vbox|virtualbox|docker|podman|wsl|hyper-v|vethernet|tailscale|zerotier|utun|tun|tap|bridge)/i
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.mdx', '.markdown',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.csv', '.tsv', '.log', '.sql', '.graphql', '.gql', '.xml',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue',
  '.css', '.scss', '.sass', '.less', '.html', '.htm',
  '.py', '.rb', '.php', '.java', '.kt', '.go', '.rs', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.env', '.properties', '.gitignore', '.editorconfig', '.npmrc', '.pnpmfile', '.npmignore'
])
const TEXT_ATTACHMENT_FILE_NAMES = new Set([
  '.env', '.gitignore', '.npmrc', '.npmignore', '.editorconfig',
  'dockerfile', 'makefile', 'readme', 'license', 'procfile'
])
const TEXT_ATTACHMENT_MIME_PATTERN = /^(text\/|application\/(json|ld\+json|xml|yaml|x-yaml|javascript|x-javascript|typescript|x-typescript|csv|toml|sql|graphql))/i

interface UploadedAttachmentBufferPayload {
  fileName: string
  fileType?: string
  bytes: Uint8Array
}

interface UploadedAttachmentResult {
  filePath: string
  fileName: string
  size: number
  fileType: string
  content: string
}

interface ActiveChatSession {
  abortController: AbortController
  authMode: { current: AIExecutionAuthMode }
}

function isSupportedTextAttachment (fileName: string): boolean {
  const normalizedName = path.basename(fileName).toLowerCase()
  return TEXT_ATTACHMENT_FILE_NAMES.has(normalizedName) || TEXT_ATTACHMENT_EXTENSIONS.has(path.extname(normalizedName))
}

function isLikelyTextAttachmentMimeType (fileType?: string): boolean {
  return typeof fileType === 'string' && TEXT_ATTACHMENT_MIME_PATTERN.test(fileType.trim())
}

function looksLikeTextBuffer (buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  if (sample.length === 0) return true

  let suspiciousByteCount = 0
  for (const byte of sample) {
    if (byte === 0) return false
    const isControl = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13
    if (isControl) suspiciousByteCount++
  }

  return suspiciousByteCount / sample.length < 0.05
}

function detectTextAttachmentType (fileName: string, fileType?: string): string {
  const normalizedName = path.basename(fileName).toLowerCase()
  if (TEXT_ATTACHMENT_FILE_NAMES.has(normalizedName)) {
    return normalizedName.replace(/^\./, '') || 'text'
  }

  const extension = path.extname(normalizedName).replace(/^\./, '')
  if (extension) return extension

  const normalizedMimeType = fileType?.trim().toLowerCase() || ''
  if (normalizedMimeType.includes('json')) return 'json'
  if (normalizedMimeType.includes('xml')) return 'xml'
  if (normalizedMimeType.includes('yaml')) return 'yaml'
  if (normalizedMimeType.includes('markdown')) return 'md'
  return 'text'
}

function trimAttachmentContent (content: string): string {
  return content.replace(/^\uFEFF/, '').substring(0, MAX_UPLOADED_OFFICE_CONTENT_LENGTH)
}

async function readUploadedAttachmentFromBuffer (
  buffer: Buffer,
  options: { fileName: string; fileType?: string; filePath?: string }
): Promise<UploadedAttachmentResult> {
  const fileName = path.basename(options.fileName || '').trim()
  if (!fileName) {
    throw new Error('附件缺少文件名')
  }

  if (buffer.byteLength > MAX_UPLOADED_OFFICE_FILE_SIZE_BYTES) {
    throw new Error(`文件过大 (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)，最大支持 10 MB`)
  }

  if (isSupportedDocument(fileName)) {
    const artifact = options.filePath
      ? await parseDocument(options.filePath)
      : await parseDocumentBuffer(buffer, { fileName, fileSize: buffer.byteLength })

    return {
      filePath: options.filePath || '',
      fileName,
      size: buffer.byteLength,
      fileType: artifact.fileType,
      content: trimAttachmentContent(artifact.plainText)
    }
  }

  if (!isSupportedTextAttachment(fileName) && !isLikelyTextAttachmentMimeType(options.fileType) && !looksLikeTextBuffer(buffer)) {
    throw new Error(`暂不支持的附件格式: ${path.extname(fileName) || 'unknown'}`)
  }

  return {
    filePath: options.filePath || '',
    fileName,
    size: buffer.byteLength,
    fileType: detectTextAttachmentType(fileName, options.fileType),
    content: trimAttachmentContent(buffer.toString('utf8'))
  }
}

async function readUploadedAttachmentFromPath (filePath: string): Promise<UploadedAttachmentResult> {
  const resolvedPath = path.resolve(filePath)
  const stat = await fs.stat(resolvedPath)

  if (!stat.isFile()) {
    throw new Error(`路径不是一个文件: ${resolvedPath}`)
  }

  if (isSupportedDocument(resolvedPath)) {
    const artifact = await parseDocument(resolvedPath)
    return {
      filePath: resolvedPath,
      fileName: path.basename(resolvedPath),
      size: stat.size,
      fileType: artifact.fileType,
      content: trimAttachmentContent(artifact.plainText)
    }
  }

  const buffer = await fs.readFile(resolvedPath)
  return readUploadedAttachmentFromBuffer(buffer, {
    fileName: path.basename(resolvedPath),
    filePath: resolvedPath
  })
}

async function ensureDocumentRenderPreview (artifactId: string) {
  const artifact = documentStore!.getArtifact(artifactId)
  if (!artifact) return null

  if (artifact.render?.status === 'ready') {
    return artifact
  }

  try {
    artifact.render = await buildDocumentRenderPreview(artifact.filePath, artifact.fileType)
  } catch (error) {
    artifact.render = {
      kind: 'structured',
      source: 'fallback',
      status: 'unavailable',
      error: `真实预览生成失败，已回退到结构化视图: ${(error as Error).message || String(error)}`,
      generatedAt: new Date().toISOString()
    }
  }

  return artifact
}

function openWebviewPopupInDock (url: string): void {
  let parsedUrl: URL

  try {
    parsedUrl = new URL(url)
  } catch {
    return
  }

  if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser:openUrlInDock', { url: parsedUrl.toString() })
    }
    return
  }

  void shell.openExternal(parsedUrl.toString()).catch((error) => {
    console.error('[main] Failed to open external popup URL:', error)
  })
}

function attachMainWindowWebviewHandlers (win: BrowserWindow): void {
  win.webContents.on('did-attach-webview', (_event, guestContents) => {
    guestContents.setWindowOpenHandler(({ url }) => {
      openWebviewPopupInDock(url)
      return { action: 'deny' }
    })
  })
}

function getMessageText (content: MessageContent): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part.type === 'text')
    .map(part => part.text || '')
    .join(' ')
    .trim()
}

function getTaskLabelFromMessages (messages: Array<{ role: string; content: MessageContent }>): string {
  if (messages.length === 0) {
    return '未命名任务'
  }

  for (let idx = messages.length - 1; idx >= 0; idx--) {
    const message = messages[idx]
    if (message.role !== 'user') continue
    const text = getMessageText(message.content).replace(/\s+/g, ' ').trim()
    if (text) {
      return text.length > 40 ? `${text.slice(0, 40)}…` : text
    }
  }
  return '未命名任务'
}

function getConversationTitleFromMessages (messages: Array<{ role: string; content: MessageContent }>): string {
  const firstUserMessage = messages.find(message => message.role === 'user')
  if (!firstUserMessage) return '新对话'
  const text = getMessageText(firstUserMessage.content)
  if (!text) return '新对话'
  return text.length > 40 ? `${text.slice(0, 40)}...` : text
}

function notifyAiTaskStatus (
  preferences: AIExecutionPreferences,
  messages: Array<{ role: string; content: MessageContent }>,
  status: 'completed' | 'failed' | 'stopped',
  detail?: string
): void {
  if (!preferences.notifyOnTaskComplete || !Notification.isSupported()) return

  const taskLabel = getTaskLabelFromMessages(messages)
  let title = 'AI 任务已完成'
  let statusLabel = '已完成'
  if (status === 'failed') {
    title = 'AI 任务执行失败'
    statusLabel = '失败'
  } else if (status === 'stopped') {
    title = 'AI 任务已停止'
    statusLabel = '已停止'
  }
  const body = detail
    ? `任务：${taskLabel}\n状态：${statusLabel}\n详情：${detail}`
    : `任务：${taskLabel}\n状态：${statusLabel}`

  new Notification({ title, body }).show()
}

function getUrlHostname (value?: string): string | null {
  if (!value || value === 'null') return null
  try {
    return new URL(value).hostname
  } catch {
    return null
  }
}

function isLocalAppOrigin (value?: string): boolean {
  // file:// renderers report an opaque "null" origin, so guard both the literal
  // string and actual file URLs when deciding whether to relax iframe/CORS rules.
  if (!value || value === 'null') return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'file:' || LOCAL_APP_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

function getOriginFromUrl (value?: string): string | null {
  if (!value || value === 'null') return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function isPrivateIpv4 (address: string): boolean {
  const octets = address.split('.').map(part => Number.parseInt(part, 10))
  if (octets.length !== 4 || octets.some(octet => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return false
  }

  if (octets[0] === 10) return true
  if (octets[0] === 192 && octets[1] === 168) return true
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true
  return false
}

function isLinkLocalIpv4 (address: string): boolean {
  return address.startsWith('169.254.')
}

function getPreferredLanIpv4Addresses (): string[] {
  const nets = networkInterfaces()
  const candidates: Array<{ address: string; score: number }> = []

  for (const [name, entries] of Object.entries(nets)) {
    const normalizedName = name || ''
    const isVirtualInterface = VIRTUAL_INTERFACE_NAME_PATTERN.test(normalizedName)

    for (const net of entries || []) {
      if (net.family !== 'IPv4' || net.internal || !net.address || isLinkLocalIpv4(net.address)) {
        continue
      }

      let score = 0
      if (isPrivateIpv4(net.address)) score += 100
      if (!isVirtualInterface) score += 30
      if (normalizedName.toLowerCase().includes('wi-fi') || normalizedName.toLowerCase().includes('wlan')) score += 10
      if (normalizedName.toLowerCase().includes('ethernet')) score += 10
      if (isVirtualInterface) score -= 50

      candidates.push({ address: net.address, score })
    }
  }

  const seen = new Set<string>()
  return candidates
    .sort((left, right) => right.score - left.score || left.address.localeCompare(right.address))
    .map(candidate => candidate.address)
    .filter(address => {
      if (seen.has(address)) return false
      seen.add(address)
      return true
    })
}

function isRemoteSubresourceRequest (value: string): boolean {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return !LOCAL_APP_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

function isLanResourceProxyRequest (value: string): boolean {
  try {
    const parsed = new URL(value)
    return LOCAL_APP_HOSTS.has(parsed.hostname) && parsed.port === String(LAN_SERVER_PORT) && parsed.pathname.startsWith('/api/resource-proxy')
  } catch {
    return false
  }
}

function getResourceProxyUrl (resourceUrl: string): string {
  const parsed = new URL(resourceUrl)
  const protocol = parsed.protocol.replace(':', '')
  const host = encodeURIComponent(parsed.host)
  const pathname = parsed.pathname || '/'
  return `http://127.0.0.1:${LAN_SERVER_PORT}/api/resource-proxy/${protocol}/${host}${pathname}${parsed.search}`
}

function upsertHeader (headers: Record<string, string[]>, name: string, value: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      headers[key] = [value]
      return
    }
  }
  headers[name] = [value]
}

function removeHeader (headers: Record<string, string[]>, name: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      delete headers[key]
    }
  }
}

function setupEmbeddedAppCorsWorkaround (): void {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const referrer = typeof details.referrer === 'string' ? details.referrer : undefined
    const isFromLocalApp = isLocalAppOrigin(referrer)
    const isFrameRequest = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame'
    const method = (details.method || 'GET').toUpperCase()

    if (
      !isFromLocalApp ||
      isFrameRequest ||
      !isRemoteSubresourceRequest(details.url) ||
      isLanResourceProxyRequest(details.url) ||
      (method !== 'GET' && method !== 'HEAD')
    ) {
      callback({})
      return
    }

    callback({ redirectURL: getResourceProxyUrl(details.url) })
  })

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const referrer = typeof details.referrer === 'string' ? details.referrer : undefined
    const isFromLocalApp = isLocalAppOrigin(referrer)
    const isFrameRequest = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame'

    if (!isFromLocalApp || !isRemoteSubresourceRequest(details.url)) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }

    const headers = { ...(details.responseHeaders || {}) }

    if (isFrameRequest) {
      removeHeader(headers, 'X-Frame-Options')
      removeHeader(headers, 'Content-Security-Policy')
      removeHeader(headers, 'Content-Security-Policy-Report-Only')
      callback({ responseHeaders: headers })
      return
    }

    const allowOrigin = getOriginFromUrl(referrer) || '*'
    upsertHeader(headers, 'Access-Control-Allow-Origin', allowOrigin)
    upsertHeader(headers, 'Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    upsertHeader(headers, 'Cross-Origin-Resource-Policy', 'cross-origin')
    upsertHeader(headers, 'Vary', 'Origin')

    callback({ responseHeaders: headers })
  })
}

function broadcastToAppWindows (channel: string, payload: unknown): void {
  const windows = new Set<BrowserWindow>()
  if (mainWindow && !mainWindow.isDestroyed()) {
    windows.add(mainWindow)
  }
  for (const win of projectWindows.values()) {
    if (!win.isDestroyed()) {
      windows.add(win)
    }
  }
  for (const win of windows) {
    win.webContents.send(channel, payload)
  }
}

function getSenderWindow (event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function guessImageExtension (mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('png')) return 'png'
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg'
  if (normalized.includes('webp')) return 'webp'
  if (normalized.includes('gif')) return 'gif'
  if (normalized.includes('svg')) return 'svg'
  return 'png'
}

async function resolveImageBuffer (imageUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (imageUrl.startsWith('data:')) {
    const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) {
      throw new Error('不支持的图片数据格式')
    }

    return {
      mimeType: match[1],
      buffer: Buffer.from(match[2], 'base64')
    }
  }

  const response = await fetch(imageUrl)
  if (!response.ok) {
    throw new Error(`下载图片失败 (${response.status})`)
  }

  const mimeType = response.headers.get('content-type') || 'image/png'
  const arrayBuffer = await response.arrayBuffer()
  return {
    mimeType,
    buffer: Buffer.from(arrayBuffer)
  }
}

function buildRendererWindowUrl (projectId?: string): { devUrl?: string; filePath?: string; query?: Record<string, string> } {
  if (process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL)
    if (projectId) {
      url.searchParams.set('projectWindow', projectId)
    }
    return { devUrl: url.toString() }
  }

  const query = projectId ? { projectWindow: projectId } : undefined
  return {
    filePath: path.join(__dirname, '../../dist/index.html'),
    query
  }
}

function getProjectsDir (): string {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, 'projects')
}

function getSnapshotsDir (): string {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, 'snapshots')
}

function applyActiveProviderToAiEngine (): AIProvidersConfig {
  const normalizedConfig = settingsStore!.getProviders()
  const active = normalizedConfig.providers.find(provider => provider.id === normalizedConfig.activeProviderId)

  aiEngine!.configure({
    apiKey: active?.apiKey ?? '',
    baseUrl: active?.baseUrl ?? '',
    model: active?.activeModel ?? '',
    enableThinking: active?.enableThinking ?? false,
    reasoningEffort: 'medium',
    contextWindow: active?.activeModel ? active.modelContextWindows?.[active.activeModel] : undefined
  })

  return normalizedConfig
}

function resolveProviderConfig (requestedProviderId?: string, requestedModelId?: string, reasoningEffort: 'low' | 'medium' | 'high' | 'max' = 'medium') {
  const providersConfig = settingsStore!.getProviders()
  const enabledProviderIds = new Set(providersConfig.enabledProviderIds)
  const enabledProviders = providersConfig.providers.filter(provider => enabledProviderIds.has(provider.id))
  const requestedProvider = requestedProviderId
    ? enabledProviders.find(provider => provider.id === requestedProviderId)
    : null
  const defaultProvider = enabledProviders.find(provider => provider.id === providersConfig.activeProviderId)
    || enabledProviders[0]
    || providersConfig.providers.find(provider => provider.id === providersConfig.activeProviderId)
    || providersConfig.providers[0]

  const provider = requestedProvider || defaultProvider
  if (!provider) return undefined

  const resolvedModel = requestedModelId && provider.models.includes(requestedModelId)
    ? requestedModelId
    : provider.activeModel

  return {
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    model: resolvedModel,
    enableThinking: provider.enableThinking ?? false,
    reasoningEffort,
    contextWindow: provider.modelContextWindows?.[resolvedModel]
  }
}

function applyMcpServersToService (): MCPServerConfig[] {
  const servers = settingsStore!.getMcpServers()
  void mcpService!.updateServers(servers).catch((error) => {
    console.error('[main:mcp] Failed to apply MCP settings:', error)
  })
  return servers
}

async function initializeServices (): Promise<void> {
  const projectsDir = getProjectsDir()
  const snapshotsDir = getSnapshotsDir()
  const userDataPath = app.getPath('userData')

  settingsStore = new SettingsStore(userDataPath)
  chatHistory = new ChatHistoryStore(userDataPath)
  aiLogStore = new AILogStore(userDataPath)
  skillStore = new SkillStore(userDataPath)
  scheduledTaskStore = new ScheduledTaskStore(userDataPath)
  mcpService = new MCPService()
  mcpService.on('stateChanged', (state: MCPStateSnapshot) => {
    broadcastToAppWindows('settings:mcpStateChanged', state)
  })

  projectFS = new ProjectFS(projectsDir, snapshotsDir)
  runtimeManager = new RuntimeManager(projectsDir)
  builderService = new BuilderService(projectsDir)
  runtimeManager.setBuilderService(builderService)
  builderService.setRuntimeManager(runtimeManager)
  apiClient = new ProjectApiClient(runtimeManager)
  dataAccess = new ProjectDataAccess(projectsDir)
  asyncTaskManager = new AsyncTaskManager(builderService)

  // Wire up the external database delegate.
  // The SqliteAdapter is loaded here (in the shell) so that the data layer
  // itself doesn't depend on native modules directly.
  const sqliteDelegate = new SqliteAdapter()
  dataAccess.setDatabaseDelegate({
    query: (dbPath: string, sql: string, params?: unknown[]) => sqliteDelegate.query(dbPath, sql, params),
    execute: (dbPath: string, sql: string, params?: unknown[]) => sqliteDelegate.execute(dbPath, sql, params),
    listTables: (dbPath: string) => sqliteDelegate.listTables(dbPath),
    getSchema: (dbPath: string) => sqliteDelegate.getSchema(dbPath),
    close: (dbPath: string) => sqliteDelegate.close(dbPath),
    closeAll: () => sqliteDelegate.closeAll()
  })

  documentStore = new DocumentStore()

  aiEngine = new AIEngine({
    projectFS,
    runtimeManager,
    builderService,
    apiClient,
    dataAccess,
    asyncTaskManager,
    documentStore,
    skillStore,
    settingsStore,
    getMainWindow: () => mainWindow,
    notifySkillsChanged: (event) => {
      broadcastToAppWindows('skills:changed', event)
    },
    mcpService,
    scheduledTaskService: undefined
  })

  scheduledTaskService = new ScheduledTaskService({
    store: scheduledTaskStore,
    aiEngine,
    skillStore,
    getMainWindow: () => mainWindow,
    resolveProviderConfig: () => resolveProviderConfig(),
    getNotificationPreference: () => settingsStore?.getAIExecutionPreferences().notifyOnTaskComplete ?? true,
    onTasksChanged: (tasks: ScheduledTaskDefinition[]) => {
      broadcastToAppWindows('scheduler:tasksChanged', tasks)
    },
    onReportsChanged: (reports: ScheduledTaskRunReport[]) => {
      broadcastToAppWindows('scheduler:reportsChanged', reports)
    },
    onReportNotificationClick: (report: ScheduledTaskRunReport) => {
      broadcastToAppWindows('scheduler:reportRequested', report)
    }
  })
  aiEngine.setScheduledTaskService(scheduledTaskService)
  scheduledTaskService.start()

  // Apply saved AI settings on startup
  const providersConfig = applyActiveProviderToAiEngine()
  const activeProvider = providersConfig.providers.find(p => p.id === providersConfig.activeProviderId)
  if (activeProvider) {
    console.log('[main] Applied active AI provider settings')
  }

  // Apply saved cost settings on startup
  const savedCostSettings = settingsStore!.getCostSettings()
  if (savedCostSettings.modelPricing.length > 0) {
    const pricingMap: Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number }> = {}
    for (const entry of savedCostSettings.modelPricing) {
      pricingMap[entry.model] = {
        inputPerMillion: entry.inputPerMillion,
        outputPerMillion: entry.outputPerMillion,
        cacheReadPerMillion: entry.cacheReadPerMillion || undefined
      }
    }
    aiEngine.setCustomModelPricing(pricingMap)
  }
  if (savedCostSettings.budgetLimit != null) {
    aiEngine.setBudgetLimit(savedCostSettings.budgetLimit)
  }

  applyMcpServersToService()

  appGateway = new AppGateway(runtimeManager, projectFS, builderService)
  processManagerService = new ProcessManagerService(runtimeManager, projectFS)
  // System snapshots read the current runtime/app-gateway state directly.
  // Periodic health checks are started here before the service is exposed via IPC/LAN.
  appGateway.startHealthChecks()
  console.log('[main] AppGateway health checks started')

  systemService = new SystemService(runtimeManager, appGateway)

  lanServer = new LanServer({
    port: LAN_SERVER_PORT,
    projectFS,
    runtimeManager,
    apiClient,
    dataAccess,
    aiEngine,
    systemService,
    settingsStore
  })

  await lanServer.start()
  console.log('[main] LAN server started on port 19527')
}

function createWindow (): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    transparent: false,
    backgroundColor: '#0f0f10',
    minWidth: 800,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  attachMainWindowWebviewHandlers(mainWindow)

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (!/(\[web-apps\]|\[launchpad\]|\[browser-webview\])/.test(message)) return
    const levelLabel = ['debug', 'info', 'warn', 'error'][level] || String(level)
    console.log(`[renderer:${levelLabel}] ${message} (${sourceId}:${line})`)
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'))
  }

  mainWindow.on('close', (event) => {
    if (hasFinishedQuitCleanup) return
    if (isClosingMainWindow || isQuitCleanupRunning) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    isClosingMainWindow = true
    app.quit()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function setupIPC (): void {
  // AI chat (non-streaming, kept for backward compat)
  ipcMain.handle('ai:chat', async (_event: IpcMainInvokeEvent, messages: Array<{ role: string; content: MessageContent }>, providerId?: string, modelId?: string, reasoningStrength?: 'low' | 'medium' | 'high' | 'max') => {
    return aiEngine!.chat(messages, {
      providerConfig: resolveProviderConfig(providerId, modelId, reasoningStrength)
    })
  })

  // AI chat streaming — pushes events to renderer via per-session channel
  ipcMain.handle('ai:chatStream', async (event: IpcMainInvokeEvent, messages: Array<{ role: string; content: MessageContent }>, sessionId: string, conversationId?: string, providerId?: string, modelId?: string, targetProjectId?: string, authMode?: AIExecutionAuthMode, reasoningStrength?: 'low' | 'medium' | 'high' | 'max') => {
    const sender = event.sender
    const channel = `ai:stream-event:${sessionId}`
    const abortController = new AbortController()
    const authModeRef = { current: authMode ?? 'strict' }
    const executionPreferences = settingsStore!.getAIExecutionPreferences()
    const conversationTitle = getConversationTitleFromMessages(messages)
    const aiLogger = executionPreferences.enableAiLogging && aiLogStore && conversationId
      ? aiLogStore.createSessionLogger({
          conversationId,
          title: conversationTitle,
          sessionId,
          uploadedMessages: messages,
          providerId,
          modelId,
          authMode,
          targetProjectId: targetProjectId ?? null
        })
      : undefined
    activeChatSessions.set(sessionId, {
      abortController,
      authMode: authModeRef
    })
    // Progress callback: sends progress events directly to renderer in real-time
    const onProgress = (stageOrEvent: string | ProgressEvent, detail?: string) => {
      if (!sender.isDestroyed()) {
        if (typeof stageOrEvent === 'string') {
          sender.send(channel, { type: 'progress', stage: stageOrEvent, detail })
          return
        }
        sender.send(channel, stageOrEvent)
      }
    }
      try {
        for await (const streamEvent of aiEngine!.chatStream(messages, onProgress, {
          targetProjectId: targetProjectId ?? null,
          providerConfig: resolveProviderConfig(providerId, modelId, reasoningStrength),
          abortSignal: abortController.signal,
          authMode: authModeRef.current,
          getAuthMode: () => authModeRef.current,
          aiLogger
        })) {
        if (streamEvent.type === 'done') {
          notifyAiTaskStatus(executionPreferences, messages, 'completed')
          aiLogger?.finish('completed', streamEvent.message)
        }
        if (sender.isDestroyed()) break
        try {
          sender.send(channel, JSON.parse(JSON.stringify(streamEvent)))
        } catch (serErr) {
          console.error('[ai:chatStream] Stream event serialization failed:', serErr)
          aiLogger?.logError('stream', serErr as Error, { streamEventType: streamEvent.type })
          // Fallback: send a safe subset if serialization fails (e.g. circular refs in tool results)
          try {
            const safe: Record<string, unknown> = { type: (streamEvent as { type: string }).type }
            if ('content' in streamEvent) safe.content = String((streamEvent as { content?: string }).content || '')
            if ('name' in streamEvent) safe.name = String((streamEvent as { name?: string }).name || '')
            if ('error' in streamEvent) safe.error = String((streamEvent as { error?: string }).error || '')
            if ('stage' in streamEvent) safe.stage = String((streamEvent as { stage?: string }).stage || '')
            if ('detail' in streamEvent) safe.detail = String((streamEvent as { detail?: string }).detail || '')
            if ('items' in streamEvent) {
              try {
                safe.items = JSON.parse(JSON.stringify((streamEvent as { items?: unknown }).items ?? []))
              } catch {
                safe.items = []
              }
            }
            if ('filePath' in streamEvent) safe.filePath = String((streamEvent as { filePath?: string }).filePath || '')
            if ('truncated' in streamEvent) safe.truncated = Boolean((streamEvent as { truncated?: boolean }).truncated)
            if ('query' in streamEvent) safe.query = String((streamEvent as { query?: string }).query || '')
            if ('engine' in streamEvent) safe.engine = String((streamEvent as { engine?: string }).engine || '')
            if ('results' in streamEvent) {
              try {
                safe.results = JSON.parse(JSON.stringify((streamEvent as { results?: unknown }).results ?? []))
              } catch {
                safe.results = []
              }
            }
            if ('result' in streamEvent) {
              try {
                safe.result = JSON.parse(JSON.stringify((streamEvent as { result?: unknown }).result))
              } catch {
                safe.result = String((streamEvent as { result?: unknown }).result ?? '')
              }
            }
            if ('message' in streamEvent) {
              const msg = (streamEvent as { message?: { role: string; content: unknown } }).message
              if (msg) {
                safe.message = {
                  role: msg.role,
                  content: typeof msg.content === 'string' ? msg.content : ''
                }
              }
            }
            sender.send(channel, safe)
          } catch (fallbackErr) {
            console.error('[ai:chatStream] Fallback send also failed:', fallbackErr)
            aiLogger?.logError('stream', fallbackErr as Error, { phase: 'fallback-send', streamEventType: streamEvent.type })
          }
        }
      }
    } catch (err) {
      const errorMessage = (err as Error).message
      const finalStatus = errorMessage === USER_ABORT_MESSAGE ? 'stopped' : 'failed'
      notifyAiTaskStatus(
        executionPreferences,
        messages,
        finalStatus,
        errorMessage === USER_ABORT_MESSAGE ? '用户中断了本次任务' : errorMessage
      )
      aiLogger?.logError('stream', err as Error, { sessionId, conversationId })
      aiLogger?.finish(finalStatus)
      if (!sender.isDestroyed()) {
        sender.send(channel, errorMessage === USER_ABORT_MESSAGE
          ? { type: 'stopped' }
          : { type: 'error', error: errorMessage })
      }
    } finally {
      activeChatSessions.delete(sessionId)
    }
    return { ok: true }
  })

  ipcMain.handle('ai:updateSessionAuthMode', async (_event: IpcMainInvokeEvent, sessionId: string, authMode: AIExecutionAuthMode) => {
    const sessionState = activeChatSessions.get(sessionId)
    if (!sessionState) {
      return { ok: true, updated: false }
    }
    sessionState.authMode.current = authMode
    return { ok: true, updated: true }
  })

  ipcMain.handle('ai:stopStream', async (_event: IpcMainInvokeEvent, sessionId: string) => {
    const controller = activeChatSessions.get(sessionId)?.abortController
    if (!controller || controller.signal.aborted) {
      return { ok: true, stopped: false }
    }
    controller.abort(new Error(USER_ABORT_MESSAGE))
    return { ok: true, stopped: true }
  })

  // Conversation history
  ipcMain.handle('conversations:list', async () => {
    return chatHistory!.list()
  })

  ipcMain.handle('conversations:get', async (_event: IpcMainInvokeEvent, id: string) => {
    return chatHistory!.get(id)
  })

  ipcMain.handle('conversations:save', async (_event: IpcMainInvokeEvent, conversation: Conversation) => {
    chatHistory!.save(conversation)
    return { success: true }
  })

  ipcMain.handle('conversations:delete', async (_event: IpcMainInvokeEvent, id: string) => {
    return chatHistory!.delete(id)
  })

  ipcMain.handle('media:saveImage', async (event: IpcMainInvokeEvent, imageUrl: string, defaultName?: string) => {
    const senderWindow = getSenderWindow(event) || mainWindow
    const { buffer, mimeType } = await resolveImageBuffer(imageUrl)
    const extension = guessImageExtension(mimeType)
    const safeDefaultName = (defaultName && defaultName.trim()) || `the-world-image.${extension}`
    const finalDefaultName = safeDefaultName.includes('.') ? safeDefaultName : `${safeDefaultName}.${extension}`

    const dialogOptions = {
      title: '保存图片',
      defaultPath: finalDefaultName,
      filters: [
        {
          name: 'Image',
          extensions: [extension]
        }
      ]
    }

    const result = senderWindow
      ? await dialog.showSaveDialog(senderWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)

    if (result.canceled || !result.filePath) {
      return { canceled: true }
    }

    await fs.writeFile(result.filePath, buffer)
    return { success: true, filePath: result.filePath }
  })

  ipcMain.handle('chat:readUploadedOfficeFile', async (_event: IpcMainInvokeEvent, filePath: string) => {
    const resolvedPath = path.resolve(filePath)
    const stat = await fs.stat(resolvedPath)

    if (!stat.isFile()) {
      throw new Error(`路径不是一个文件: ${resolvedPath}`)
    }

    if (stat.size > MAX_UPLOADED_OFFICE_FILE_SIZE_BYTES) {
      throw new Error(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)} MB)，最大支持 10 MB`)
    }

    if (!isOfficeFile(resolvedPath)) {
      throw new Error(`暂不支持的 Office 文件格式: ${path.extname(resolvedPath) || 'unknown'}`)
    }

    const result = await readOfficeFile(resolvedPath)

    return {
      filePath: resolvedPath,
      fileName: path.basename(resolvedPath),
      size: stat.size,
      fileType: detectOfficeType(resolvedPath) || result.type,
      content: result.content.substring(0, MAX_UPLOADED_OFFICE_CONTENT_LENGTH)
    }
  })

  ipcMain.handle('chat:readUploadedAttachmentFile', async (_event: IpcMainInvokeEvent, filePath: string) => {
    return readUploadedAttachmentFromPath(filePath)
  })

  ipcMain.handle('chat:readUploadedAttachmentBuffer', async (_event: IpcMainInvokeEvent, payload: UploadedAttachmentBufferPayload) => {
    const bytes = payload?.bytes instanceof Uint8Array ? payload.bytes : new Uint8Array()
    return readUploadedAttachmentFromBuffer(Buffer.from(bytes), {
      fileName: payload?.fileName || '',
      fileType: payload?.fileType
    })
  })

  // ─── Document import / preview / selection ───────────────────────────

  ipcMain.handle('document:import', async (_event: IpcMainInvokeEvent, filePath: string) => {
    const resolvedPath = path.resolve(filePath)
    const stat = await fs.stat(resolvedPath)
    if (!stat.isFile()) throw new Error(`路径不是一个文件: ${resolvedPath}`)
    if (stat.size > MAX_UPLOADED_OFFICE_FILE_SIZE_BYTES) {
      throw new Error(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)} MB)，最大支持 10 MB`)
    }
    if (!isSupportedDocument(resolvedPath)) {
      throw new Error(`不支持的文档格式: ${path.extname(resolvedPath) || 'unknown'}`)
    }
    const artifact = await parseDocument(resolvedPath)
    documentStore!.addArtifact(artifact)
    return { artifact }
  })

  ipcMain.handle('document:pickFiles', async (event: IpcMainInvokeEvent) => {
    const senderWindow = getSenderWindow(event) || mainWindow
    const dialogOptions = {
      title: '导入文档',
      filters: [
        { name: '文档', extensions: ['pdf', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt'] }
      ],
      properties: ['openFile' as const, 'multiSelections' as const]
    }
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, filePaths: [] }
    return { canceled: false, filePaths: result.filePaths }
  })

  ipcMain.handle('office:pickFiles', async (event: IpcMainInvokeEvent) => {
    const senderWindow = getSenderWindow(event) || mainWindow
    const dialogOptions = {
      title: '上传 Office 文件',
      filters: [
        { name: 'Office 文档', extensions: ['xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt'] }
      ],
      properties: ['openFile' as const, 'multiSelections' as const]
    }
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, filePaths: [] }
    return { canceled: false, filePaths: result.filePaths }
  })

  ipcMain.handle('document:list', async () => {
    return documentStore!.listSummaries()
  })

  ipcMain.handle('document:get', async (_event: IpcMainInvokeEvent, artifactId: string) => {
    return documentStore!.getArtifact(artifactId)
  })

  ipcMain.handle('document:getRenderData', async (_event: IpcMainInvokeEvent, artifactId: string) => {
    const artifact = documentStore!.getArtifact(artifactId)
    if (!artifact) return null
    return readDocumentRenderAsset(artifact.render)
  })

  ipcMain.handle('document:ensureRenderPreview', async (_event: IpcMainInvokeEvent, artifactId: string) => {
    return ensureDocumentRenderPreview(artifactId)
  })

  ipcMain.handle('document:openOriginal', async (_event: IpcMainInvokeEvent, artifactId: string) => {
    const artifact = documentStore!.getArtifact(artifactId)
    if (!artifact) {
      return { success: false, error: `文档不存在: ${artifactId}` }
    }

    const error = await shell.openPath(artifact.filePath)
    if (error) {
      return { success: false, error }
    }

    return { success: true }
  })

  ipcMain.handle('document:remove', async (_event: IpcMainInvokeEvent, artifactId: string) => {
    return documentStore!.removeArtifact(artifactId)
  })

  ipcMain.handle('document:createSelection', async (_event: IpcMainInvokeEvent, payload: CreateSelectionPayload) => {
    return documentStore!.createSelection(payload)
  })

  ipcMain.handle('document:removeSelection', async (_event: IpcMainInvokeEvent, regionId: string) => {
    return documentStore!.removeSelection(regionId)
  })

  ipcMain.handle('document:updateSelectionLabel', async (_event: IpcMainInvokeEvent, regionId: string, label: string) => {
    return documentStore!.updateSelectionLabel(regionId, label)
  })

  ipcMain.handle('document:getSelections', async (_event: IpcMainInvokeEvent, artifactId: string) => {
    return documentStore!.getSelectionsForArtifact(artifactId)
  })

  ipcMain.handle('document:buildSelectionsPrompt', async (_event: IpcMainInvokeEvent, regionIds?: string[]) => {
    return documentStore!.buildSelectionsPrompt(regionIds)
  })

  // Project management
  ipcMain.handle('projects:list', async () => {
    const projects = await projectFS!.listProjects()
    return projects.map(project => ({
      ...project,
      runtime: runtimeManager!.getStatus(project.id)
    }))
  })

  ipcMain.handle('projects:get', async (_event: IpcMainInvokeEvent, projectId: string) => {
    return projectFS!.getProjectMeta(projectId)
  })

  ipcMain.handle('projects:getFileTree', async (_event: IpcMainInvokeEvent, projectId: string) => {
    return projectFS!.getFileTree(projectId)
  })

  ipcMain.handle('projects:readFile', async (_event: IpcMainInvokeEvent, projectId: string, filePath: string) => {
    return projectFS!.readFile(projectId, filePath)
  })

  ipcMain.handle('projects:writeFile', async (_event: IpcMainInvokeEvent, projectId: string, filePath: string, content: string) => {
    await projectFS!.writeFile(projectId, filePath, content)
    return { success: true }
  })

  ipcMain.handle('projects:updateAppearance', async (_event: IpcMainInvokeEvent, projectId: string, updates: { name?: string; icon?: string }) => {
    const meta = await projectFS!.updateProjectMeta(projectId, updates)

    const projectWindow = projectWindows.get(projectId)
    if (projectWindow && !projectWindow.isDestroyed()) {
      projectWindow.setTitle((meta.name as string) || projectId)
    }

    broadcastToAppWindows('projects:changed', { action: 'updated', projectId })
    return meta
  })

  ipcMain.handle('projects:delete', async (_event: IpcMainInvokeEvent, projectId: string) => {
    if (!projectId || typeof projectId !== 'string') {
      throw new TypeError(`Invalid project ID: ${String(projectId)}`)
    }
    // Stop the project first if running
    try { await runtimeManager!.stop(projectId) } catch { /* ignore */ }
    await projectFS!.deleteProject(projectId)
    broadcastToAppWindows('projects:changed', { action: 'deleted', projectId })
    return { success: true }
  })

  // Runtime management
  ipcMain.handle('runtime:start', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const result = await runtimeManager!.start(projectId)
    if (result.status === 'running' || result.status === 'already_running') {
      broadcastToAppWindows('projects:changed', { action: 'started', projectId, port: result.port })
    }
    return result
  })

  ipcMain.handle('runtime:stop', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const result = await runtimeManager!.stop(projectId)
    if (result.status === 'stopped') {
      broadcastToAppWindows('projects:changed', { action: 'stopped', projectId })
    }
    return result
  })

  ipcMain.handle('runtime:status', async (_event: IpcMainInvokeEvent, projectId: string) => {
    return runtimeManager!.getStatus(projectId)
  })

  ipcMain.handle('system:getStatus', async () => {
    return systemService!.getStatus()
  })

  // Build management
  ipcMain.handle('build:run', async (_event: IpcMainInvokeEvent, projectId: string) => {
    return builderService!.build(projectId)
  })

  ipcMain.handle('build:cleanup', async (_event: IpcMainInvokeEvent, projectId: string) => {
    return builderService!.cleanup(projectId)
  })

  ipcMain.handle('build:rebuild', async (_event: IpcMainInvokeEvent, projectId: string) => {
    return builderService!.rebuild(projectId)
  })

  ipcMain.handle('build:needsRebuild', async (_event: IpcMainInvokeEvent, projectId: string) => {
    return builderService!.needsRebuild(projectId)
  })

  // Gateway / service management
  ipcMain.handle('gateway:serviceMap', async () => {
    return appGateway!.getServiceMap()
  })

  ipcMain.handle('gateway:startAll', async () => {
    return appGateway!.startAll()
  })

  ipcMain.handle('gateway:stopAll', async () => {
    await appGateway!.stopAll()
    return { success: true }
  })

  ipcMain.handle('gateway:setRestartPolicy', async (_event: IpcMainInvokeEvent, projectId: string, policy: 'always' | 'on-failure' | 'never') => {
    appGateway!.setRestartPolicy(projectId, policy)
    return { success: true }
  })

  // Process management
  ipcMain.handle('process:getSnapshot', async () => {
    return processManagerService!.getSnapshot()
  })

  ipcMain.handle('process:restart', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const result = await processManagerService!.restartProject(projectId)
    if (result.success) {
      broadcastToAppWindows('projects:changed', { action: 'started', projectId })
    }
    return result
  })

  ipcMain.handle('process:stop', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const result = await processManagerService!.stopProject(projectId)
    if (result.success) {
      broadcastToAppWindows('projects:changed', { action: 'stopped', projectId })
    }
    return result
  })

  ipcMain.handle('process:forceKill', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const result = await processManagerService!.forceKillProject(projectId)
    if (result.success) {
      broadcastToAppWindows('projects:changed', { action: 'stopped', projectId })
    }
    return result
  })

  ipcMain.handle('process:killOrphan', async (_event: IpcMainInvokeEvent, pid: number) => {
    return processManagerService!.killOrphanProcess(pid)
  })

  // Data access
  ipcMain.handle('data:query', async (_event: IpcMainInvokeEvent, projectId: string, sql: string) => {
    return dataAccess!.queryDatabase(projectId, sql)
  })

  ipcMain.handle('data:summary', async (_event: IpcMainInvokeEvent, projectId: string) => {
    return dataAccess!.getDataSummary(projectId)
  })

  // List all databases across all projects (for the settings DB viewer)
  ipcMain.handle('data:listAll', async () => {
    return dataAccess!.listAllDatabases()
  })

  // Query a table for the DB viewer with pagination
  ipcMain.handle('data:queryTable', async (_event: IpcMainInvokeEvent, projectId: string, tableName: string, page: number, pageSize: number) => {
    return dataAccess!.queryTableForViewer(projectId, tableName, { page, pageSize })
  })

  // Get table schema for a project
  ipcMain.handle('data:getSchema', async (_event: IpcMainInvokeEvent, projectId: string) => {
    return dataAccess!.getTableSchema(projectId)
  })

  // Settings — legacy flat AI settings
  ipcMain.handle('settings:getAI', async () => {
    return settingsStore!.getAISettings()
  })

  ipcMain.handle('settings:saveAI', async (_event: IpcMainInvokeEvent, config: { apiKey?: string; baseUrl?: string; model?: string }) => {
    settingsStore!.saveAISettings(config)
    aiEngine!.configure(config)
    return { success: true }
  })

  // Settings — multi-provider
  ipcMain.handle('settings:getProviders', async () => {
    return settingsStore!.getProviders()
  })

  ipcMain.handle('settings:saveProviders', async (_event: IpcMainInvokeEvent, config: AIProvidersConfig) => {
    settingsStore!.saveProviders(config)
    const normalizedConfig = applyActiveProviderToAiEngine()
    broadcastToAppWindows('settings:providersChanged', normalizedConfig)
    return { success: true }
  })

  ipcMain.handle('settings:getMcpServers', async () => {
    return settingsStore!.getMcpServers()
  })

  ipcMain.handle('settings:saveMcpServers', async (_event: IpcMainInvokeEvent, servers: MCPServerConfig[]) => {
    settingsStore!.saveMcpServers(servers)
    applyMcpServersToService()
    return { success: true }
  })

  ipcMain.handle('settings:getMcpState', async () => {
    return mcpService!.getState()
  })

  ipcMain.handle('settings:refreshMcpServer', async (_event: IpcMainInvokeEvent, serverId?: string) => {
    if (!serverId) {
      await mcpService!.refreshEnabledServers()
      return mcpService!.getState()
    }
    return mcpService!.refreshServer(serverId)
  })

  ipcMain.handle('settings:disconnectMcpServer', async (_event: IpcMainInvokeEvent, serverId: string) => {
    return mcpService!.disconnectServer(serverId)
  })

  ipcMain.handle('settings:getThemePreference', async () => {
    return settingsStore!.getThemePreference()
  })

  ipcMain.handle('settings:saveThemePreference', async (_event: IpcMainInvokeEvent, preference: 'system' | 'light' | 'dark') => {
    settingsStore!.saveThemePreference(preference)
    return { success: true }
  })

  ipcMain.handle('settings:getAIExecutionPreferences', async () => {
    return settingsStore!.getAIExecutionPreferences()
  })

  ipcMain.handle('settings:saveAIExecutionPreferences', async (_event: IpcMainInvokeEvent, preferences: AIExecutionPreferences) => {
    settingsStore!.saveAIExecutionPreferences(preferences)
    return { success: true }
  })

  ipcMain.handle('settings:listAILogConversations', async () => {
    return aiLogStore!.listConversations()
  })

  ipcMain.handle('settings:getAILogConversation', async (_event: IpcMainInvokeEvent, conversationId: string) => {
    return aiLogStore!.getConversation(conversationId)
  })

  ipcMain.handle('settings:deleteAILogConversation', async (_event: IpcMainInvokeEvent, conversationId: string) => {
    return aiLogStore!.deleteConversation(conversationId)
  })

  ipcMain.handle('settings:exportConfig', async (event: IpcMainInvokeEvent) => {
    const senderWindow = getSenderWindow(event) || mainWindow
    const now = new Date()
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
    const dialogOptions = {
      title: '导出加密配置',
      defaultPath: `the-world-config-${stamp}.${PORTABLE_SETTINGS_EXTENSION}`,
      filters: [
        { name: 'The World 配置包', extensions: [PORTABLE_SETTINGS_EXTENSION] }
      ]
    }

    const result = senderWindow
      ? await dialog.showSaveDialog(senderWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true }
    }

    const serialized = encryptPortableSettingsConfig(settingsStore!.exportPortableConfig(), PORTABLE_SETTINGS_APP_ID)
    await fs.writeFile(result.filePath, serialized, 'utf-8')
    return { success: true, filePath: result.filePath }
  })

  ipcMain.handle('settings:importConfig', async (event: IpcMainInvokeEvent) => {
    const senderWindow = getSenderWindow(event) || mainWindow
    const dialogOptions = {
      title: '导入加密配置',
      filters: [
        { name: 'The World 配置包', extensions: [PORTABLE_SETTINGS_EXTENSION] }
      ],
      properties: ['openFile' as const]
    }

    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true }
    }

    const filePath = result.filePaths[0]
    const serialized = await fs.readFile(filePath, 'utf-8')
    const payload = decryptPortableSettingsConfig(serialized, PORTABLE_SETTINGS_APP_ID)
    const normalizedConfig = settingsStore!.importPortableConfig(payload.config as PortableSettingsConfig)
    const providersConfig = applyActiveProviderToAiEngine()
    applyMcpServersToService()

    broadcastToAppWindows('settings:providersChanged', providersConfig)

    return {
      success: true,
      filePath,
      importedAt: payload.exportedAt,
      requiresReload: true,
      importedConfig: normalizedConfig
    }
  })

  // Window controls
  ipcMain.handle('window:minimize', (event: IpcMainInvokeEvent) => {
    getSenderWindow(event)?.minimize()
  })

  ipcMain.handle('window:maximize', (event: IpcMainInvokeEvent) => {
    const targetWindow = getSenderWindow(event)
    if (!targetWindow) return

    if (targetWindow.isMaximized()) {
      targetWindow.unmaximize()
    } else {
      targetWindow.maximize()
    }
  })

  ipcMain.handle('window:close', (event: IpcMainInvokeEvent) => {
    getSenderWindow(event)?.close()
  })

  ipcMain.handle('window:isMaximized', (event: IpcMainInvokeEvent) => {
    return getSenderWindow(event)?.isMaximized() ?? false
  })

  // Open project folder in system file explorer
  ipcMain.handle('projects:openFolder', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const projectDir = path.join(getProjectsDir(), projectId)
    await shell.openPath(projectDir)
    return { success: true }
  })

  // Get LAN server info (local IP and port)
  ipcMain.handle('lan:getInfo', async () => {
    const addresses = getPreferredLanIpv4Addresses()
    return {
      port: LAN_SERVER_PORT,
      addresses,
      baseUrl: addresses.length > 0 ? `http://${addresses[0]}:${LAN_SERVER_PORT}` : `http://127.0.0.1:${LAN_SERVER_PORT}`
    }
  })

  // Get project LAN URL for QR code generation
  ipcMain.handle('projects:getLanUrl', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const port = runtimeManager!.getPort(projectId)
    const addresses = getPreferredLanIpv4Addresses()
    const lanIp = addresses.length > 0 ? addresses[0] : '127.0.0.1'
    const encodedProjectId = encodeURIComponent(projectId)
    return {
      projectPort: port,
      lanUrl: port ? `http://${lanIp}:${port}` : null,
      proxyUrl: `http://${lanIp}:${LAN_SERVER_PORT}/tool/${encodedProjectId}`,
      localProxyUrl: `http://127.0.0.1:${LAN_SERVER_PORT}/tool/${encodedProjectId}`,
      lanIp
    }
  })

  // --- Skill management ---
  ipcMain.handle('skills:list', async () => {
    return skillStore!.list()
  })

  ipcMain.handle('skills:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '导入 Skill 文件',
      filters: [{ name: 'Skill 文件', extensions: ['md', 'txt', 'zip'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return []
    const imported: Skill[] = []
    for (const filePath of result.filePaths) {
      imported.push(await skillStore!.importFromFile(filePath))
    }
    if (imported.length > 0) broadcastToAppWindows('skills:changed', { action: 'imported', count: imported.length })
    return imported
  })

  ipcMain.handle('skills:importContent', async (_event: IpcMainInvokeEvent, name: string, content: string, description?: string) => {
    const skill = skillStore!.importFromContent(name, content, description)
    broadcastToAppWindows('skills:changed', { action: 'imported', count: 1 })
    return skill
  })

  ipcMain.handle('skills:delete', async (_event: IpcMainInvokeEvent, id: string) => {
    const deleted = skillStore!.delete(id)
    if (deleted) broadcastToAppWindows('skills:changed', { action: 'deleted', id })
    return deleted
  })

  ipcMain.handle('skills:setActive', async (_event: IpcMainInvokeEvent, skillIds: string[]) => {
    const contents: string[] = []
    for (const id of skillIds) {
      const skill = skillStore!.get(id)
      if (skill) contents.push(skill.content)
    }
    aiEngine!.setActiveSkills(contents)
    return { success: true, count: contents.length }
  })

  // --- Launch mode preferences ---
  ipcMain.handle('settings:getLaunchMode', async (_event: IpcMainInvokeEvent, projectId: string) => {
    return settingsStore!.getLaunchMode(projectId)
  })

  ipcMain.handle('settings:saveLaunchMode', async (_event: IpcMainInvokeEvent, projectId: string, mode: 'embed' | 'window') => {
    settingsStore!.saveLaunchMode(projectId, mode)
    return { success: true }
  })

  ipcMain.handle('settings:getLaunchpadLayout', async () => {
    return settingsStore!.getLaunchpadLayout()
  })

  ipcMain.handle('settings:saveLaunchpadLayout', async (_event: IpcMainInvokeEvent, layout: LaunchpadLayout) => {
    settingsStore!.saveLaunchpadLayout(layout)
    return { success: true }
  })

  ipcMain.handle('settings:getWebApps', async () => {
    const webApps = settingsStore!.getWebApps()
    console.info('[main:web-apps] getWebApps', webApps.map(app => ({
      id: app.id,
      name: app.name,
      url: app.url
    })))
    return webApps
  })

  ipcMain.handle('settings:saveWebApps', async (_event: IpcMainInvokeEvent, webApps: WebAppShortcut[]) => {
    console.info('[main:web-apps] saveWebApps', webApps.map(app => ({
      id: app.id,
      name: app.name,
      url: app.url
    })))
    settingsStore!.saveWebApps(webApps)
    return { success: true }
  })

  // --- Plan Mode ---
  ipcMain.handle('ai:setPlanMode', async (_event: IpcMainInvokeEvent, active: boolean) => {
    aiEngine!.setPlanMode(active)
    return { success: true }
  })

  // --- Cost Settings ---
  ipcMain.handle('settings:getCostSettings', async () => {
    return settingsStore!.getCostSettings()
  })

  ipcMain.handle('settings:saveCostSettings', async (_event: IpcMainInvokeEvent, costSettings: { modelPricing: Array<{ model: string; inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number }>; budgetLimit: number | null }) => {
    settingsStore!.saveCostSettings(costSettings)
    // Apply pricing overrides to AIEngine
    const pricingMap: Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number }> = {}
    for (const entry of costSettings.modelPricing) {
      pricingMap[entry.model] = {
        inputPerMillion: entry.inputPerMillion,
        outputPerMillion: entry.outputPerMillion,
        cacheReadPerMillion: entry.cacheReadPerMillion || undefined
      }
    }
    aiEngine!.setCustomModelPricing(pricingMap)
    aiEngine!.setBudgetLimit(costSettings.budgetLimit)
    return { success: true }
  })

  ipcMain.handle('scheduler:listTasks', async () => {
    return scheduledTaskService!.listTasks()
  })

  ipcMain.handle('scheduler:saveTask', async (_event: IpcMainInvokeEvent, task: ScheduledTaskDefinition) => {
    return scheduledTaskService!.saveTask(task)
  })

  ipcMain.handle('scheduler:deleteTask', async (_event: IpcMainInvokeEvent, taskId: string) => {
    return scheduledTaskService!.deleteTask(taskId)
  })

  ipcMain.handle('scheduler:runNow', async (_event: IpcMainInvokeEvent, taskId: string) => {
    return scheduledTaskService!.runNow(taskId)
  })

  ipcMain.handle('scheduler:listReports', async (_event: IpcMainInvokeEvent, taskId?: string) => {
    return scheduledTaskService!.listReports(taskId)
  })

  ipcMain.handle('scheduler:getReport', async (_event: IpcMainInvokeEvent, reportId: string) => {
    return scheduledTaskService!.getReport(reportId)
  })

  // --- Open project in standalone window ---
  ipcMain.handle('runtime:openWindow', async (_event: IpcMainInvokeEvent, projectId: string) => {
    // Check if a window already exists for this project
    const existing = projectWindows.get(projectId)
    if (existing && !existing.isDestroyed()) {
      existing.focus()
      return { success: true, reused: true }
    }

    const port = runtimeManager!.getPort(projectId)
    if (!port) return { success: false, error: 'Project not running' }

    const meta = await projectFS!.getProjectMeta(projectId)
    const projectName = (meta?.name as string) || projectId

    const win = new BrowserWindow({
      width: 1024,
      height: 768,
      title: projectName,
      minWidth: 760,
      minHeight: 480,
      frame: false,
      backgroundColor: '#081018',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    const target = buildRendererWindowUrl(projectId)
    if (target.devUrl) {
      win.loadURL(target.devUrl)
    } else if (target.filePath) {
      win.loadFile(target.filePath, { query: target.query })
    }

    projectWindows.set(projectId, win)

    win.on('closed', () => {
      projectWindows.delete(projectId)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('project:windowClosed', { projectId })
      }
      if (!runtimeManager) {
        console.warn(`[runtime] Runtime manager unavailable while closing window for ${projectId}`)
        return
      }
      void (async () => {
        try {
          const result = await runtimeManager.stop(projectId)
          if (result.status === 'stopped') {
            broadcastToAppWindows('projects:changed', { action: 'stopped', projectId })
          }
        } catch (error) {
          console.warn(`[runtime] Failed to stop ${projectId} after window close:`, error)
        }
      })()
    })

    return { success: true }
  })

  // --- Check which projects have standalone windows ---
  ipcMain.handle('runtime:getOpenWindows', async () => {
    const result: string[] = []
    for (const [id, win] of projectWindows) {
      if (!win.isDestroyed()) result.push(id)
    }
    return result
  })

  // --- Focus a standalone project window ---
  ipcMain.handle('runtime:focusWindow', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const win = projectWindows.get(projectId)
    if (win && !win.isDestroyed()) {
      win.focus()
      return { success: true }
    }
    return { success: false }
  })
}

app.whenReady().then(async () => {
  await initializeServices()
  setupEmbeddedAppCorsWorkaround()
  setupIPC()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  if (hasFinishedQuitCleanup) return

  event.preventDefault()

  if (isQuitCleanupRunning) return
  isQuitCleanupRunning = true

  void (async () => {
    try {
      if (runtimeManager) {
        await runtimeManager.stopAll()
      }
      if (lanServer) {
        await lanServer.stop()
      }
      if (mcpService) {
        await mcpService.dispose()
      }
      if (scheduledTaskService) {
        scheduledTaskService.dispose()
      }
    } finally {
      hasFinishedQuitCleanup = true
      isQuitCleanupRunning = false
      app.quit()
    }
  })()
})
