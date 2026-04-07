import { type BrowserWindow, ipcMain } from 'electron'

/** Timeout in ms before auto-denying an auth request. */
const AUTH_TIMEOUT_MS = 120_000

/**
 * Show a confirmation request inside the app before executing a sensitive operation.
 * Returns true if the user approved, false otherwise.
 */
export async function requestUserAuth (
  getMainWindow: (() => BrowserWindow | null) | undefined,
  title: string,
  detail: string
): Promise<boolean> {
  const win = getMainWindow?.() ?? null

  if (!win || win.isDestroyed()) {
    return false
  }

  try {
    return await requestUserAuthViaRenderer(win, title, detail)
  } catch {
    return false
  }
}

/**
 * Send an auth request to the renderer and wait for the user's response.
 */
function requestUserAuthViaRenderer (win: BrowserWindow, title: string, detail: string): Promise<boolean> {
  return new Promise((resolve) => {
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
