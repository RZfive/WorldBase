import { type BrowserWindow, ipcMain } from 'electron'
import { DEFAULT_AI_EXECUTION_PREFERENCES, type AIExecutionPreferences } from '../../../settings/settings-store.js'

/** Timeout in ms before auto-denying an auth request. */
const AUTH_TIMEOUT_MS = 120_000

/**
 * Show a confirmation request inside the app before executing a sensitive operation.
 * Returns true if the user approved, false otherwise.
 */
export async function requestUserAuth (
  getMainWindow: (() => BrowserWindow | null) | undefined,
  getAIExecutionPreferences: (() => AIExecutionPreferences) | undefined,
  title: string,
  detail: string
): Promise<boolean> {
  const win = getMainWindow?.() ?? null

  if (!win || win.isDestroyed()) {
    return false
  }

  try {
    const preferences = getAIExecutionPreferences?.() ?? DEFAULT_AI_EXECUTION_PREFERENCES
    return await requestUserAuthViaRenderer(win, title, detail, preferences)
  } catch {
    return false
  }
}

/**
 * Send an auth request to the renderer and wait for the user's response.
 */
function emitAuthResolved (win: BrowserWindow, requestId: string, approved: boolean): void {
  win.webContents.send('auth:resolved', { requestId, approved })
}

function requestUserAuthViaRenderer (
  win: BrowserWindow,
  title: string,
  detail: string,
  preferences: AIExecutionPreferences
): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = `auth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const cleanup = () => {
      clearTimeout(timer)
      ipcMain.removeListener('auth:response', handler)
    }

    const timer = setTimeout(() => {
      cleanup()
      emitAuthResolved(win, requestId, false)
      resolve(false) // Auto-deny after timeout
    }, AUTH_TIMEOUT_MS)

    const handler = (_event: Electron.IpcMainEvent, data: { requestId: string; approved: boolean }) => {
      if (data.requestId === requestId) {
        cleanup()
        emitAuthResolved(win, requestId, data.approved)
        resolve(data.approved)
      }
    }
    ipcMain.on('auth:response', handler)

    // Send auth request to renderer
    win.webContents.send('auth:request', {
      requestId,
      title,
      detail
    })

    if (preferences.authMode === 'auto') {
      cleanup()
      emitAuthResolved(win, requestId, true)
      resolve(true)
    }
  })
}
