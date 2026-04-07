import { dialog, type BrowserWindow } from 'electron'

/** Timeout in ms before auto-denying an auth request. */
const AUTH_TIMEOUT_MS = 120_000

/**
 * Show a confirmation dialog to the user before executing a sensitive operation.
 * Tries in-app UI dialog first (via IPC), falls back to native Electron dialog.
 * Returns true if the user approved, false otherwise.
 */
export async function requestUserAuth (
  getMainWindow: (() => BrowserWindow | null) | undefined,
  title: string,
  detail: string
): Promise<boolean> {
  const win = getMainWindow?.() ?? null

  // Try in-app UI dialog via IPC (more polished UX)
  if (win && !win.isDestroyed()) {
    try {
      return await requestUserAuthViaRenderer(win, title, detail)
    } catch {
      // Fall back to native dialog if renderer auth fails
    }
  }

  // Fallback: native Electron dialog
  const options = {
    type: 'warning' as const,
    title: '操作授权',
    message: title,
    detail,
    buttons: ['拒绝', '允许'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }

  const result = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)

  // button index 1 = "允许"
  return result.response === 1
}

/**
 * Send an auth request to the renderer and wait for the user's response.
 */
function requestUserAuthViaRenderer (win: BrowserWindow, title: string, detail: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { ipcMain } = require('electron') as typeof import('electron')
    const requestId = `auth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const cleanup = () => {
      clearTimeout(timer)
      ipcMain.removeListener('auth:response', handler)
    }

    const timer = setTimeout(() => {
      cleanup()
      resolve(false) // Auto-deny after timeout
    }, AUTH_TIMEOUT_MS)

    const handler = (_event: Electron.IpcMainEvent, data: { requestId: string; approved: boolean }) => {
      if (data.requestId === requestId) {
        cleanup()
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
  })
}
