import { app, BrowserWindow, net, protocol } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { STUDIO_IMAGE_SCHEME } from '../src/main/settings/image-library-store.js'
import { APP_DISPLAY_NAME } from './main-process/constants.js'
import { mainState } from './main-process/state.js'
import { initializeServices } from './main-process/services.js'
import { setupIPC } from './main-process/ipc.js'
import { createWindow, setupEmbeddedAppCorsWorkaround } from './main-process/windows.js'

app.setName(APP_DISPLAY_NAME)
app.setAppUserModelId('com.theworld.app')
app.setPath('userData', path.join(app.getPath('appData'), APP_DISPLAY_NAME))

// The image-library studio serves thumbnails/originals over a privileged custom
// protocol so the renderer references images by URL (browser-managed decode/cache)
// instead of holding multi-MB base64 in memory. Must be registered before ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: STUDIO_IMAGE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }
])

// Ensure only one instance of the app is running.
// This prevents file lock conflicts when the installer tries to
// uninstall or overwrite the old version while the app is still running.
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  // When a second instance is launched, focus the existing window
  app.on('second-instance', () => {
    if (mainState.mainWindow) {
      if (mainState.mainWindow.isMinimized()) mainState.mainWindow.restore()
      mainState.mainWindow.focus()
    }
  })
}

app.whenReady().then(async () => {
  await initializeServices()
  setupEmbeddedAppCorsWorkaround()
  setupIPC()

  // Stream image-library thumbnails/originals from disk. Thumbnails are generated
  // eagerly at save time (see ImageLibraryStore.resolveImageRequest), so this never
  // blocks on image processing. Images are content-addressed by id+variant and never
  // change, so we mark responses immutable - the renderer serves repeat views from
  // its own cache instead of re-hitting the protocol and re-decoding on every scroll.
  protocol.handle(STUDIO_IMAGE_SCHEME, async (request) => {
    try {
      const filePath = await mainState.imageLibraryStore?.resolveImageRequest(request.url)
      if (!filePath) return new Response(null, { status: 404 })
      const res = await net.fetch(pathToFileURL(filePath).toString())
      const headers = new Headers(res.headers)
      headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    } catch {
      return new Response(null, { status: 500 })
    }
  })

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
  if (mainState.hasFinishedQuitCleanup) return

  event.preventDefault()

  if (mainState.isQuitCleanupRunning) return
  mainState.isQuitCleanupRunning = true

  void (async () => {
    try {
      if (mainState.runtimeManager) {
        await mainState.runtimeManager.stopAll()
      }
      if (mainState.lanServer) {
        await mainState.lanServer.stop()
      }
      if (mainState.mcpService) {
        await mainState.mcpService.dispose()
      }
      if (mainState.updateService) {
        mainState.updateService.dispose()
      }
      if (mainState.scheduledTaskService) {
        mainState.scheduledTaskService.dispose()
      }
      if (mainState.memoryStore) {
        mainState.memoryStore.close()
      }
    } finally {
      mainState.hasFinishedQuitCleanup = true
      mainState.isQuitCleanupRunning = false
      app.quit()
    }
  })()
})
