import { dialog, type BrowserWindow } from 'electron'

/**
 * Show a native confirmation dialog to the user before executing a sensitive operation.
 * Returns true if the user approved, false otherwise.
 */
export async function requestUserAuth (
  getMainWindow: (() => BrowserWindow | null) | undefined,
  title: string,
  detail: string
): Promise<boolean> {
  const win = getMainWindow?.() ?? null
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
