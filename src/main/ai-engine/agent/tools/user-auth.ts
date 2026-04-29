import { type BrowserWindow, ipcMain } from 'electron'
import type { SessionState } from '../agent-core.js'

/**
 * Request a sudo password from the user via an inline conversation block.
 * Returns the password string the user typed, or null if cancelled / aborted.
 * The password is never forwarded to the AI model.
 */
export async function requestSudoPassword (
  getMainWindow: (() => BrowserWindow | null) | undefined,
  getSessionState: (() => SessionState) | undefined,
  getAbortSignal: (() => AbortSignal | undefined) | undefined,
  command: string
): Promise<string | null> {
  const win = getMainWindow?.() ?? null
  if (!win || win.isDestroyed()) return null

  return new Promise((resolve) => {
    const requestId = `sudo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const conversationId = getSessionState?.().conversationId
    const sessionId = getSessionState?.().sessionId

    win.webContents.send('auth:sudo-request', { requestId, conversationId, sessionId, command })

    let settled = false
    type SudoResponseHandler = (_event: Electron.IpcMainEvent, data: { requestId: string; password: string | null }) => void
    let handler: SudoResponseHandler | null = null
    let abortSignal: AbortSignal | undefined
    let abortListener: (() => void) | null = null

    function cleanup () {
      if (handler) {
        ipcMain.removeListener('auth:sudo-response', handler)
        handler = null
      }
      if (abortSignal && abortListener) {
        abortSignal.removeEventListener('abort', abortListener)
        abortListener = null
      }
    }

    const finish = (password: string | null) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(password)
    }

    handler = (_event, data) => {
      if (data.requestId !== requestId) return
      finish(data.password)
    }
    ipcMain.on('auth:sudo-response', handler)

    abortSignal = getAbortSignal?.()
    if (abortSignal?.aborted) {
      finish(null)
      return
    }
    abortListener = () => finish(null)
    abortSignal?.addEventListener('abort', abortListener, { once: true })
  })
}

/**
 * Show a confirmation request inside the app before executing a sensitive operation.
 * Returns true if the user approved, false otherwise.
 */
export async function requestUserAuth (
  getMainWindow: (() => BrowserWindow | null) | undefined,
  getSessionState: (() => SessionState) | undefined,
  getAbortSignal: (() => AbortSignal | undefined) | undefined,
  title: string,
  detail: string
): Promise<boolean> {
  const win = getMainWindow?.() ?? null

  if (!win || win.isDestroyed()) {
    return false
  }

  try {
    return await requestUserAuthViaRenderer(win, title, detail, getSessionState, getAbortSignal)
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
  getSessionState: (() => SessionState) | undefined,
  getAbortSignal: (() => AbortSignal | undefined) | undefined
): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = `auth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const conversationId = getSessionState?.().conversationId
    const sessionId = getSessionState?.().sessionId
    type AuthResponseHandler = (_event: Electron.IpcMainEvent, data: { requestId: string; approved: boolean }) => void

    // Send auth request to renderer first so the conversation can render the auth card.
    win.webContents.send('auth:request', {
      requestId,
      conversationId,
      sessionId,
      title,
      detail
    })

    const resolveCurrentMode = (): SessionState['authMode'] => getSessionState?.().authMode ?? 'strict'
    if (resolveCurrentMode() === 'auto') {
      emitAuthResolved(win, requestId, true)
      resolve(true)
      return
    }

    let settled = false
    let authModePoll: ReturnType<typeof setInterval> | null = null
    let handler: AuthResponseHandler | null = null
    let abortSignal: AbortSignal | undefined
    let abortListener: (() => void) | null = null

    function cleanup () {
      if (authModePoll) {
        clearInterval(authModePoll)
        authModePoll = null
      }
      if (handler) {
        ipcMain.removeListener('auth:response', handler)
        handler = null
      }
      if (abortSignal && abortListener) {
        abortSignal.removeEventListener('abort', abortListener)
        abortListener = null
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

    authModePoll = setInterval(() => {
      if (resolveCurrentMode() === 'auto') {
        finish(true)
      }
    }, 200)

    abortSignal = getAbortSignal?.()
    if (abortSignal?.aborted) {
      finish(false)
      return
    }

    abortListener = () => {
      finish(false)
    }
    abortSignal?.addEventListener('abort', abortListener, { once: true })
  })
}
