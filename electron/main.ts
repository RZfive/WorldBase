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
import { ProjectApiClient } from '../src/main/project-api-bridge/api-client.js'
import { ProjectDataAccess } from '../src/main/project-data-access/data-access.js'
import { SqliteAdapter } from '../src/main/project-data-access/adapters/sqlite-adapter.js'
import { LanServer } from '../src/main/lan-server/server.js'
import { LAN_SERVER_PORT } from '../src/main/constants.js'
import { SystemService } from '../src/main/system-capabilities/system-service.js'
import { SettingsStore, type AIExecutionAuthMode, type AIExecutionPreferences, type AIProvidersConfig, type LaunchpadLayout } from '../src/main/settings/settings-store.js'
import { ChatHistoryStore, type Conversation } from '../src/main/settings/chat-history.js'
import { SkillStore, type Skill } from '../src/main/settings/skill-store.js'
import type { MessageContent } from '../src/main/ai-engine/providers/openai-provider.js'
import { isOfficeFile, readOfficeFile, detectOfficeType } from '../src/main/ai-engine/agent/tools/office-utils.js'

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
let systemService: SystemService | null = null
let apiClient: ProjectApiClient | null = null
let dataAccess: ProjectDataAccess | null = null
let lanServer: LanServer | null = null
let settingsStore: SettingsStore | null = null
let chatHistory: ChatHistoryStore | null = null
let skillStore: SkillStore | null = null
let isClosingMainWindow = false
let isQuitCleanupRunning = false
let hasFinishedQuitCleanup = false

/** Track standalone project windows keyed by projectId */
const projectWindows = new Map<string, BrowserWindow>()
const activeChatStreams = new Map<string, AbortController>()

const LOCAL_APP_HOSTS = new Set(['localhost', '127.0.0.1'])
const MAX_UPLOADED_OFFICE_FILE_SIZE_BYTES = 10 * 1024 * 1024
const MAX_UPLOADED_OFFICE_CONTENT_LENGTH = 100000

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

async function initializeServices (): Promise<void> {
  const projectsDir = getProjectsDir()
  const snapshotsDir = getSnapshotsDir()
  const userDataPath = app.getPath('userData')

  settingsStore = new SettingsStore(userDataPath)
  chatHistory = new ChatHistoryStore(userDataPath)
  skillStore = new SkillStore(userDataPath)

  projectFS = new ProjectFS(projectsDir, snapshotsDir)
  runtimeManager = new RuntimeManager(projectsDir)
  builderService = new BuilderService(projectsDir)
  runtimeManager.setBuilderService(builderService)
  apiClient = new ProjectApiClient(runtimeManager)
  dataAccess = new ProjectDataAccess(projectsDir)

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

  aiEngine = new AIEngine({
    projectFS,
    runtimeManager,
    builderService,
    apiClient,
    dataAccess,
    getMainWindow: () => mainWindow
  })

  // Apply saved AI settings on startup
  const providersConfig = settingsStore.getProviders()
  const activeProvider = providersConfig.providers.find(p => p.id === providersConfig.activeProviderId)
  const savedAI = settingsStore.getAISettings()
  if (activeProvider) {
    aiEngine.configure({
      apiKey: activeProvider.apiKey,
      baseUrl: activeProvider.baseUrl,
      model: activeProvider.activeModel,
      enableThinking: activeProvider.enableThinking ?? false,
      contextWindow: activeProvider.modelContextWindows?.[activeProvider.activeModel]
    })
    console.log('[main] Applied active AI provider settings')
  } else if (savedAI.apiKey || savedAI.baseUrl || savedAI.model) {
    aiEngine.configure(savedAI)
    console.log('[main] Applied saved AI settings')
  }

  appGateway = new AppGateway(runtimeManager, projectFS, builderService)
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
      nodeIntegration: false
    }
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
  const resolveProviderConfig = (requestedProviderId?: string, requestedModelId?: string) => {
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
      contextWindow: provider.modelContextWindows?.[resolvedModel]
    }
  }

  // AI chat (non-streaming, kept for backward compat)
  ipcMain.handle('ai:chat', async (_event: IpcMainInvokeEvent, messages: Array<{ role: string; content: MessageContent }>, providerId?: string, modelId?: string) => {
    return aiEngine!.chat(messages, {
      providerConfig: resolveProviderConfig(providerId, modelId)
    })
  })

  // AI chat streaming — pushes events to renderer via per-session channel
  ipcMain.handle('ai:chatStream', async (event: IpcMainInvokeEvent, messages: Array<{ role: string; content: MessageContent }>, sessionId: string, providerId?: string, modelId?: string, targetProjectId?: string, authMode?: AIExecutionAuthMode) => {
    const sender = event.sender
    const channel = `ai:stream-event:${sessionId}`
    const abortController = new AbortController()
    const executionPreferences = settingsStore!.getAIExecutionPreferences()
    activeChatStreams.set(sessionId, abortController)
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
        providerConfig: resolveProviderConfig(providerId, modelId),
        abortSignal: abortController.signal,
        authMode: authMode ?? 'strict'
      })) {
        if (streamEvent.type === 'done') {
          notifyAiTaskStatus(executionPreferences, messages, 'completed')
        }
        if (sender.isDestroyed()) break
        try {
          sender.send(channel, JSON.parse(JSON.stringify(streamEvent)))
        } catch (serErr) {
          console.error('[ai:chatStream] Stream event serialization failed:', serErr)
          // Fallback: send a safe subset if serialization fails (e.g. circular refs in tool results)
          try {
            const safe: Record<string, unknown> = { type: (streamEvent as { type: string }).type }
            if ('content' in streamEvent) safe.content = String((streamEvent as { content?: string }).content || '')
            if ('name' in streamEvent) safe.name = String((streamEvent as { name?: string }).name || '')
            if ('error' in streamEvent) safe.error = String((streamEvent as { error?: string }).error || '')
            if ('stage' in streamEvent) safe.stage = String((streamEvent as { stage?: string }).stage || '')
            if ('detail' in streamEvent) safe.detail = String((streamEvent as { detail?: string }).detail || '')
            if ('filePath' in streamEvent) safe.filePath = String((streamEvent as { filePath?: string }).filePath || '')
            if ('truncated' in streamEvent) safe.truncated = Boolean((streamEvent as { truncated?: boolean }).truncated)
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
          }
        }
      }
    } catch (err) {
      const errorMessage = (err as Error).message
      notifyAiTaskStatus(
        executionPreferences,
        messages,
        errorMessage === USER_ABORT_MESSAGE ? 'stopped' : 'failed',
        errorMessage === USER_ABORT_MESSAGE ? '用户中断了本次任务' : errorMessage
      )
      if (!sender.isDestroyed()) {
        sender.send(channel, errorMessage === USER_ABORT_MESSAGE
          ? { type: 'stopped' }
          : { type: 'error', error: errorMessage })
      }
    } finally {
      activeChatStreams.delete(sessionId)
    }
    return { ok: true }
  })

  ipcMain.handle('ai:stopStream', async (_event: IpcMainInvokeEvent, sessionId: string) => {
    const controller = activeChatStreams.get(sessionId)
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
    const normalizedConfig = settingsStore!.getProviders()
    // Reconfigure AI engine with the active provider
    const active = normalizedConfig.providers.find(p => p.id === normalizedConfig.activeProviderId)
    if (active) {
      aiEngine!.configure({
        apiKey: active.apiKey,
        baseUrl: active.baseUrl,
        model: active.activeModel,
        enableThinking: active.enableThinking ?? false,
        contextWindow: active.modelContextWindows?.[active.activeModel]
      })
    }
    broadcastToAppWindows('settings:providersChanged', normalizedConfig)
    return { success: true }
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
    const nets = networkInterfaces()
    const addresses: string[] = []
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          addresses.push(net.address)
        }
      }
    }
    return {
      port: LAN_SERVER_PORT,
      addresses,
      baseUrl: addresses.length > 0 ? `http://${addresses[0]}:${LAN_SERVER_PORT}` : `http://127.0.0.1:${LAN_SERVER_PORT}`
    }
  })

  // Get project LAN URL for QR code generation
  ipcMain.handle('projects:getLanUrl', async (_event: IpcMainInvokeEvent, projectId: string) => {
    const port = runtimeManager!.getPort(projectId)
    const nets = networkInterfaces()
    const addresses: string[] = []
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          addresses.push(net.address)
        }
      }
    }
    const lanIp = addresses.length > 0 ? addresses[0] : '127.0.0.1'
    return {
      projectPort: port,
      lanUrl: port ? `http://${lanIp}:${port}` : null,
      proxyUrl: `http://${lanIp}:${LAN_SERVER_PORT}/tool/${projectId}`,
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
    } finally {
      hasFinishedQuitCleanup = true
      isQuitCleanupRunning = false
      app.quit()
    }
  })()
})
