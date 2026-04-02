import { app, BrowserWindow, ipcMain, shell, dialog, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import { AIEngine } from '../src/main/ai-engine/ai-engine.js'
import { ProjectFS } from '../src/main/project-fs/project-fs.js'
import { RuntimeManager } from '../src/main/project-runtime/runtime-manager.js'
import { ProjectApiClient } from '../src/main/project-api-bridge/api-client.js'
import { ProjectDataAccess } from '../src/main/project-data-access/data-access.js'
import { SqliteAdapter } from '../src/main/project-data-access/adapters/sqlite-adapter.js'
import { LanServer } from '../src/main/lan-server/server.js'
import { LAN_SERVER_PORT } from '../src/main/constants.js'
import { SettingsStore, type AIProvidersConfig } from '../src/main/settings/settings-store.js'
import { ChatHistoryStore, type Conversation } from '../src/main/settings/chat-history.js'
import { SkillStore, type Skill } from '../src/main/settings/skill-store.js'

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
let apiClient: ProjectApiClient | null = null
let dataAccess: ProjectDataAccess | null = null
let lanServer: LanServer | null = null
let settingsStore: SettingsStore | null = null
let chatHistory: ChatHistoryStore | null = null
let skillStore: SkillStore | null = null

/** Track standalone project windows keyed by projectId */
const projectWindows = new Map<string, BrowserWindow>()

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

  lanServer = new LanServer({
    port: LAN_SERVER_PORT,
    projectFS,
    runtimeManager,
    apiClient,
    dataAccess,
    aiEngine,
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
}

function setupIPC (): void {
  // AI chat (non-streaming, kept for backward compat)
  ipcMain.handle('ai:chat', async (_event: IpcMainInvokeEvent, messages: Array<{ role: string; content: string }>) => {
    return aiEngine!.chat(messages)
  })

  // AI chat streaming — pushes events to renderer via per-session channel
  ipcMain.handle('ai:chatStream', async (event: IpcMainInvokeEvent, messages: Array<{ role: string; content: string }>, sessionId: string) => {
    const sender = event.sender
    const channel = `ai:stream-event:${sessionId}`
    // Progress callback: sends progress events directly to renderer in real-time
    const onProgress = (stage: string, detail?: string) => {
      if (!sender.isDestroyed()) {
        sender.send(channel, { type: 'progress', stage, detail })
      }
    }
    try {
      for await (const streamEvent of aiEngine!.chatStream(messages, onProgress)) {
        if (sender.isDestroyed()) break
        try {
          sender.send(channel, JSON.parse(JSON.stringify(streamEvent)))
        } catch {
          // Fallback: send a safe subset if serialization fails (e.g. circular refs in tool results)
          const safe: Record<string, unknown> = { type: (streamEvent as { type: string }).type }
          if ('content' in streamEvent) safe.content = String((streamEvent as { content?: string }).content || '')
          if ('name' in streamEvent) safe.name = String((streamEvent as { name?: string }).name || '')
          if ('error' in streamEvent) safe.error = String((streamEvent as { error?: string }).error || '')
          if ('stage' in streamEvent) safe.stage = String((streamEvent as { stage?: string }).stage || '')
          if ('detail' in streamEvent) safe.detail = String((streamEvent as { detail?: string }).detail || '')
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
        }
      }
    } catch (err) {
      if (!sender.isDestroyed()) {
        sender.send(channel, { type: 'error', error: (err as Error).message })
      }
    }
    return { ok: true }
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

  // Project management
  ipcMain.handle('projects:list', async () => {
    return projectFS!.listProjects()
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

  ipcMain.handle('projects:delete', async (_event: IpcMainInvokeEvent, projectId: string) => {
    // Stop the project first if running
    try { await runtimeManager!.stop(projectId) } catch { /* ignore */ }
    await projectFS!.deleteProject(projectId)
    mainWindow?.webContents.send('projects:changed', { action: 'deleted', projectId })
    return { success: true }
  })

  // Runtime management
  ipcMain.handle('runtime:start', async (_event: IpcMainInvokeEvent, projectId: string) => {
    return runtimeManager!.start(projectId)
  })

  ipcMain.handle('runtime:stop', async (_event: IpcMainInvokeEvent, projectId: string) => {
    return runtimeManager!.stop(projectId)
  })

  ipcMain.handle('runtime:status', async (_event: IpcMainInvokeEvent, projectId: string) => {
    return runtimeManager!.getStatus(projectId)
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
    // Reconfigure AI engine with the active provider
    const active = config.providers.find(p => p.id === config.activeProviderId)
    if (active) {
      aiEngine!.configure({
        apiKey: active.apiKey,
        baseUrl: active.baseUrl,
        model: active.activeModel,
        enableThinking: active.enableThinking ?? false,
        contextWindow: active.modelContextWindows?.[active.activeModel]
      })
    }
    return { success: true }
  })

  // Window controls
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })

  ipcMain.handle('window:close', () => {
    mainWindow?.close()
  })

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false
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
      baseUrl: addresses.length > 0 ? `http://${addresses[0]}:${LAN_SERVER_PORT}` : `http://localhost:${LAN_SERVER_PORT}`
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
    const lanIp = addresses.length > 0 ? addresses[0] : 'localhost'
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
      filters: [{ name: 'Markdown / Text', extensions: ['md', 'txt'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return []
    const imported: Skill[] = []
    for (const filePath of result.filePaths) {
      imported.push(skillStore!.importFromFile(filePath))
    }
    return imported
  })

  ipcMain.handle('skills:importContent', async (_event: IpcMainInvokeEvent, name: string, content: string, description?: string) => {
    return skillStore!.importFromContent(name, content, description)
  })

  ipcMain.handle('skills:delete', async (_event: IpcMainInvokeEvent, id: string) => {
    return skillStore!.delete(id)
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
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    win.loadURL(`http://localhost:${port}`)
    projectWindows.set(projectId, win)

    win.on('closed', () => {
      projectWindows.delete(projectId)
      // Notify renderer that standalone window was closed
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('project:windowClosed', { projectId })
      }
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

app.on('before-quit', async () => {
  if (runtimeManager) {
    await runtimeManager.stopAll()
  }
  if (lanServer) {
    await lanServer.stop()
  }
})
