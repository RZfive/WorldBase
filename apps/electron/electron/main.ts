import { app, BrowserWindow, net, protocol } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { STUDIO_IMAGE_SCHEME } from '../src/main/settings/image-library-store.js'
import { APP_DISPLAY_NAME } from './main-process/constants.js'
import { mainState } from './main-process/state.js'
import { initializeServices } from './main-process/services.js'
import { setupIPC } from './main-process/ipc.js'
import { startSelectedRustHarness } from './main-process/ai/selected-execution-engine.js'
import { setMainLocale } from '../src/main/i18n/main-i18n.js'
import { createWindow, setupEmbeddedAppCorsWorkaround } from './main-process/windows.js'
import { reportStartup } from '../src/main/app-start-report/startup-report-service.js'
import { ensureLoginShellPath } from '../src/main/system-capabilities/shell-path.js'
import { isHotPayloadActive, markHotBootOk } from '../src/main/app-update/hot-payload-store.js'

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
  // Finder/Dock launches carry a minimal PATH. Merge the login shell PATH first
  // so MCP stdio servers (npx / uvx), the Rust app-server, and project runtimes
  // spawned below can resolve user-installed toolchains.
  await ensureLoginShellPath()
  await initializeServices()
  setupEmbeddedAppCorsWorkaround()
  // Bootstrap main-process locale from the persisted preference so IPC errors,
  // OS notifications, and dialog titles render in the user's language from the
  // very first interaction (the renderer reconciles its own locale separately).
  setMainLocale(mainState.settingsStore!.getLanguagePreference())
  setupIPC()

  // Stream image-library thumbnails/originals from disk. Thumbnails are generated
  // eagerly at save time (see ImageLibraryStore.resolveImageRequest), so this never
  // blocks on image processing. Images are content-addressed by id+variant and never
  // change, so we mark responses immutable - the renderer serves repeat views from
  // its own cache instead of re-hitting the protocol and re-decoding on every scroll.
  protocol.handle(STUDIO_IMAGE_SCHEME, async (request) => {
    try {
      const nativeImage = await readRustStudioImage(request.url)
      if (nativeImage) return nativeImage
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

  // Scan and kill leftover project processes from a previous crashed or unclean
  // exit before any window opens, so launching an internal app doesn't race
  // with a stale instance still holding its port / file locks — that race is
  // what caused the internal-app crash-on-open.
  let rustHarnessHandshakeOk = false
  try {
    {
      const rustHarness = await startSelectedRustHarness()
      if (rustHarness && mainState.rustHarness) {
        await mainState.rustHarness.call('project.process.cleanupOrphans', {})
      }
      rustHarnessHandshakeOk = true
    }
  } catch (err) {
    console.warn('[main] Orphan process cleanup failed on startup:', (err as Error).message)
  }

  createWindow()

  // Hot payload boot health (design 5.6): the new version only counts as good
  // once the window is ready AND the hot-payload Rust harness handshake
  // succeeded; otherwise two failed startups roll the app back automatically.
  if (isHotPayloadActive() && rustHarnessHandshakeOk) {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    const confirmHotBoot = () => {
      void mainState.updateService?.confirmHotBoot().catch((error) => {
        console.warn('[main] Hot boot confirm failed:', (error as Error).message)
      })
    }
    if (!mainWindow || !mainWindow.webContents.isLoading()) {
      confirmHotBoot()
    } else {
      mainWindow.once('ready-to-show', confirmHotBoot)
    }
  }

  void reportStartup({
    settingsStore: mainState.settingsStore!,
    systemService: mainState.systemService!
  }).catch((error) => {
    console.warn('[main] Startup report failed:', (error as Error).message)
  })

  // Check once per application launch. UpdateService persists and broadcasts
  // every state transition, so About & Updates shows this result whenever it opens.
  void mainState.updateService!.checkForUpdates().catch((error) => {
    console.warn('[main] Startup update check failed:', (error as Error).message)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

/**
 * Rust mode keeps the image-library index in the harness database. The custom
 * protocol remains an Electron UI transport, but it must not require the TS
 * gallery cache to have imported the image first.
 */
async function readRustStudioImage (rawUrl: string): Promise<Response | null> {
  const client = mainState.rustHarness
  if (!client?.isAvailable()) return new Response(null, { status: 503 })
  let id = ''
  let variant: 'thumb' | 'full' = 'full'
  try {
    const url = new URL(rawUrl)
    const parts = url.pathname.split('/').filter(Boolean)
    id = decodeURIComponent(parts[0] || '')
    variant = parts[1] === 'thumb' ? 'thumb' : 'full'
  } catch {
    return new Response(null, { status: 400 })
  }
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return new Response(null, { status: 400 })

  try {
    const result = await client.call<Record<string, unknown>>('studio.library.read', { id, variant })
    const dataUrl = typeof result.dataUrl === 'string' ? result.dataUrl : ''
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
    if (!match) return new Response(null, { status: 404 })
    return new Response(Buffer.from(match[2], 'base64'), {
      headers: {
        'Content-Type': match[1],
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    })
  } catch {
    // Rust is selected, so this URL must not reveal stale Electron gallery
    // data when its native library cannot serve the item.
    return new Response(null, { status: 404 })
  }
}

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
      if (mainState.lanServer) {
        await mainState.lanServer.stop()
      }
      if (mainState.mcpService) {
        await mainState.mcpService.dispose()
      }
      if (mainState.rustHarness) {
        // Rust owns project children and MCP transports entirely in the
        // app-server. Do not touch their Electron counterparts.
        await mainState.rustHarness.stopAllProjects().catch(() => {})
        mainState.rustHarness.dispose()
      }
      if (mainState.updateService) {
        mainState.updateService.dispose()
      }
      if (mainState.scheduledTaskService) {
        mainState.scheduledTaskService.dispose()
      }
      if (mainState.dailySuggestionService) {
        mainState.dailySuggestionService.dispose()
      }
    } finally {
      // Drain accepted history writes even if another service failed cleanup.
      await mainState.chatHistory?.dispose().catch(error => console.warn('[main] History shutdown failed:', error))
      // Now that every service is down, hand off to the update installer if
      // one was requested. It must run here, not earlier: the NSIS installer
      // kills WorldBase.exe on start, which would abort the cleanup above.
      await mainState.updateService?.launchPendingInstaller().catch(error => console.warn('[main] Installer launch failed:', error))
      mainState.hasFinishedQuitCleanup = true
      mainState.isQuitCleanupRunning = false
      app.quit()
    }
  })()
})
