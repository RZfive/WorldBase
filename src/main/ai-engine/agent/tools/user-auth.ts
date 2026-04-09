import { type BrowserWindow, ipcMain } from 'electron'
import type { SessionState } from '../agent-core.js'

/** Timeout in ms before auto-denying an auth request. */
const AUTH_TIMEOUT_MS = 120_000

/**
 * Show a confirmation request inside the app before executing a sensitive operation.
 * Returns true if the user approved, false otherwise.
 */
export async function requestUserAuth (
  getMainWindow: (() => BrowserWindow | null) | undefined,
  getSessionState: (() => SessionState) | undefined,
  title: string,
  detail: string
): Promise<boolean> {
  const win = getMainWindow?.() ?? null

  if (!win || win.isDestroyed()) {
    return false
  }

  try {
    const authMode = getSessionState?.().authMode ?? 'strict'
    return await requestUserAuthViaRenderer(win, title, detail, authMode)
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
  authMode: SessionState['authMode']
): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = `auth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    type AuthResponseHandler = (_event: Electron.IpcMainEvent, data: { requestId: string; approved: boolean }) => void

    // Send auth request to renderer first so the conversation can render the auth card.
    win.webContents.send('auth:request', {
      requestId,
      title,
      detail
    })

    if (authMode === 'auto') {
      emitAuthResolved(win, requestId, true)
      resolve(true)
      return
    }

    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let handler: AuthResponseHandler | null = null

    function cleanup () {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (handler) {
        ipcMain.removeListener('auth:response', handler)
        handler = null
      }
    }

    const finish = (approved: boolean) => {
      if (settled) return
      settled = true
      cleanup()
      emitAuthResolved(win, requestId, approved)
      resolve(approved)
    }

    handler = (_event: Electron.IpcMainEvent, data: { requestId: string; approved: boolean }) => {
      if (data.requestId !== requestId) return
      finish(data.approved)
    }

    ipcMain.on('auth:response', handler)

    timer = setTimeout(() => {
      finish(false) // Auto-deny after timeout
    }, AUTH_TIMEOUT_MS)
  })
}
