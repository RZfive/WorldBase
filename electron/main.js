import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AIEngine } from '../src/main/ai-engine/ai-engine.js'
import { ProjectFS } from '../src/main/project-fs/project-fs.js'
import { RuntimeManager } from '../src/main/project-runtime/runtime-manager.js'
import { ProjectApiClient } from '../src/main/project-api-bridge/api-client.js'
import { ProjectDataAccess } from '../src/main/project-data-access/data-access.js'
import { LanServer } from '../src/main/lan-server/server.js'
import { SettingsStore } from '../src/main/settings/settings-store.js'

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

let mainWindow = null
let aiEngine = null
let projectFS = null
let runtimeManager = null
let apiClient = null
let dataAccess = null
let lanServer = null
let settingsStore = null

function getProjectsDir () {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, 'projects')
}

function getSnapshotsDir () {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, 'snapshots')
}

async function initializeServices () {
  const projectsDir = getProjectsDir()
  const snapshotsDir = getSnapshotsDir()
  const userDataPath = app.getPath('userData')

  settingsStore = new SettingsStore(userDataPath)

  projectFS = new ProjectFS(projectsDir, snapshotsDir)
  runtimeManager = new RuntimeManager(projectsDir)
  apiClient = new ProjectApiClient(runtimeManager)
  dataAccess = new ProjectDataAccess(projectsDir)

  aiEngine = new AIEngine({
    projectFS,
    runtimeManager,
    apiClient,
    dataAccess
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

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

function setupIPC () {
  // AI chat
  ipcMain.handle('ai:chat', async (_event, messages) => {
    return aiEngine.chat(messages)
  })

  // Project management
  ipcMain.handle('projects:list', async () => {
    return projectFS.listProjects()
  })

  ipcMain.handle('projects:get', async (_event, projectId) => {
    return projectFS.getProjectMeta(projectId)
  })

  ipcMain.handle('projects:getFileTree', async (_event, projectId) => {
    return projectFS.getFileTree(projectId)
  })

  ipcMain.handle('projects:readFile', async (_event, projectId, filePath) => {
    return projectFS.readFile(projectId, filePath)
  })

  // Runtime management
  ipcMain.handle('runtime:start', async (_event, projectId) => {
    return runtimeManager.start(projectId)
  })

  ipcMain.handle('runtime:stop', async (_event, projectId) => {
    return runtimeManager.stop(projectId)
  })

  ipcMain.handle('runtime:status', async (_event, projectId) => {
    return runtimeManager.getStatus(projectId)
  })

  // Data access
  ipcMain.handle('data:query', async (_event, projectId, sql) => {
    return dataAccess.queryDatabase(projectId, sql)
  })

  ipcMain.handle('data:summary', async (_event, projectId) => {
    return dataAccess.getDataSummary(projectId)
  })

  // Settings
  ipcMain.handle('settings:getAI', async () => {
    return settingsStore.getAISettings()
  })

  ipcMain.handle('settings:saveAI', async (_event, config) => {
    settingsStore.saveAISettings(config)
    aiEngine.configure(config)
    return { success: true }
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
