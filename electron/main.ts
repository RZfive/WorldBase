import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import { AIEngine } from '../src/main/ai-engine/ai-engine.js'
import { ProjectFS } from '../src/main/project-fs/project-fs.js'
import { RuntimeManager } from '../src/main/project-runtime/runtime-manager.js'
import { ProjectApiClient } from '../src/main/project-api-bridge/api-client.js'
import { ProjectDataAccess } from '../src/main/project-data-access/data-access.js'
import { LanServer } from '../src/main/lan-server/server.js'
import { SettingsStore, type AIProvidersConfig } from '../src/main/settings/settings-store.js'
import { ChatHistoryStore, type Conversation } from '../src/main/settings/chat-history.js'

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

  projectFS = new ProjectFS(projectsDir, snapshotsDir)
  runtimeManager = new RuntimeManager(projectsDir)
  apiClient = new ProjectApiClient(runtimeManager)
  dataAccess = new ProjectDataAccess(projectsDir)

  aiEngine = new AIEngine({
    projectFS,
    runtimeManager,
    apiClient,
    dataAccess,
    getMainWindow: () => mainWindow
  })

  // Apply saved AI settings on startup
  const savedAI = settingsStore.getAISettings()
  if (savedAI.apiKey || savedAI.baseUrl || savedAI.model) {
    aiEngine.configure(savedAI)
    console.log('[main] Applied saved AI settings')
  }

  lanServer = new LanServer({
    port: 19527,
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

  // AI chat streaming — pushes events to renderer via webContents.send
  ipcMain.handle('ai:chatStream', async (event: IpcMainInvokeEvent, messages: Array<{ role: string; content: string }>) => {
    const sender = event.sender
    try {
      for await (const streamEvent of aiEngine!.chatStream(messages)) {
        if (sender.isDestroyed()) break
        sender.send('ai:stream-event', JSON.parse(JSON.stringify(streamEvent)))
      }
    } catch (err) {
      if (!sender.isDestroyed()) {
        sender.send('ai:stream-event', { type: 'error', error: (err as Error).message })
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
        enableThinking: active.enableThinking ?? false
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
      port: 19527,
      addresses,
      baseUrl: addresses.length > 0 ? `http://${addresses[0]}:19527` : `http://localhost:19527`
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
      proxyUrl: `http://${lanIp}:19527/tool/${projectId}`,
      lanIp
    }
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
