import { type BrowserWindow, ipcMain } from 'electron'
import type { SessionState } from '../agent-core.js'

/**
 * One question presented to the user. Each question carries 1-N suggested options;
 * the renderer always shows an additional "其他" free-text fallback so the user
 * can override the suggestions even when the agent thought the list was exhaustive.
 */
export interface AskUserQuestion {
  id: string
  question: string
  options: string[]
}

/**
 * One answer returned by the user. `selectedOption` carries one of the suggested
 * options when the user picked a chip; `customAnswer` carries the free-text the
 * user typed into the "其他" box when they overrode the suggestions.
 */
export interface AskUserAnswer {
  questionId: string
  selectedOption: string | null
  customAnswer: string | null
}

/**
 * Request a batch of clarification answers from the user via an inline panel
 * above the chat input. Returns the answer list, or null if the user cancels
 * or the agent is aborted before the user replies.
 */
export async function requestUserQuestions (
  getMainWindow: (() => BrowserWindow | null) | undefined,
  getSessionState: (() => SessionState) | undefined,
  getAbortSignal: (() => AbortSignal | undefined) | undefined,
  questions: AskUserQuestion[]
): Promise<AskUserAnswer[] | null> {
  const win = getMainWindow?.() ?? null
  if (!win || win.isDestroyed()) return null

  return new Promise((resolve) => {
    const requestId = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const conversationId = getSessionState?.().conversationId
    const sessionId = getSessionState?.().sessionId

    win.webContents.send('askUser:request', { requestId, conversationId, sessionId, questions })

    let settled = false
    type Handler = (_event: Electron.IpcMainEvent, data: { requestId: string; answers: AskUserAnswer[] | null }) => void
    let handler: Handler | null = null
    let abortSignal: AbortSignal | undefined
    let abortListener: (() => void) | null = null

    function cleanup () {
      if (handler) {
        ipcMain.removeListener('askUser:response', handler)
        handler = null
      }
      if (abortSignal && abortListener) {
        abortSignal.removeEventListener('abort', abortListener)
        abortListener = null
      }
    }

    const finish = (answers: AskUserAnswer[] | null) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(answers)
    }

    handler = (_event, data) => {
      if (data.requestId !== requestId) return
      finish(data.answers)
    }
    ipcMain.on('askUser:response', handler)

    abortSignal = getAbortSignal?.()
    if (abortSignal?.aborted) {
      finish(null)
      return
    }
    abortListener = () => finish(null)
    abortSignal?.addEventListener('abort', abortListener, { once: true })
  })
}
