import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { AuthRequestPayload, RoomApprovalRequest } from '../../../src/shared/agent-workspace-types.js'

export async function requestRoomWorkspaceApproval (
  sender: WebContents,
  sessionId: string,
  conversationId: string | undefined,
  approval: RoomApprovalRequest,
  signal: AbortSignal
): Promise<boolean> {
  if (sender.isDestroyed() || signal.aborted) return false
  const request: AuthRequestPayload = {
    requestId: randomUUID(),
    sessionId,
    conversationId,
    ...approval
  }
  return await new Promise<boolean>(resolve => {
    let settled = false
    const finish = (approved: boolean) => {
      if (settled) return
      settled = true
      ipcMain.removeListener('auth:response', onResponse)
      sender.removeListener('destroyed', cancel)
      sender.removeListener('render-process-gone', cancel)
      sender.removeListener('did-start-navigation', onNavigation)
      signal.removeEventListener('abort', cancel)
      try {
        if (sender.isDestroyed()) return resolve(false)
        sender.send('auth:resolved', { requestId: request.requestId, approved })
        resolve(approved)
      } catch {
        resolve(false)
      }
    }
    const cancel = () => finish(false)
    const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) cancel()
    }
    const onResponse = (event: IpcMainEvent, payload?: { requestId?: string; approved?: boolean }) => {
      if (event.sender !== sender || payload?.requestId !== request.requestId) return
      finish(payload.approved === true)
    }
    ipcMain.on('auth:response', onResponse)
    sender.once('destroyed', cancel)
    sender.once('render-process-gone', cancel)
    sender.on('did-start-navigation', onNavigation)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      sender.send('auth:request', request)
    } catch {
      cancel()
    }
  })
}
