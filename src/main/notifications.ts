import { app, BrowserWindow, type Notification } from 'electron'
import { createRequire } from 'node:module'

const { Notification } = createRequire(import.meta.url)('electron') as typeof import('electron')

/**
 * Active OS notifications that are waiting for the user to interact.
 *
 * A `Notification` created in a local scope is eligible for garbage collection
 * as soon as the enclosing function returns. The native banner still renders,
 * but once the JS object is collected its `click` handler is dropped — so
 * clicking the notification silently does nothing. Keeping a strong reference
 * here until the notification closes prevents that.
 */
const activeNotifications = new Set<Notification>()

export function isNotificationSupported (): boolean {
  return Notification.isSupported()
}

/**
 * Raise a (possibly minimized / backgrounded) main window to the foreground.
 *
 * On macOS `BrowserWindow.focus()` only moves focus within the app; if the app
 * itself is not frontmost the window stays buried behind other apps. Activating
 * the app first (`app.focus({ steal: true })`) is what actually brings it to
 * the front in response to a notification click.
 */
export function focusMainWindow (mainWindow: BrowserWindow | null | undefined): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  app.focus({ steal: true })
  mainWindow.show()
  mainWindow.focus()
}

/**
 * Show an OS notification and invoke `onClick` (on the main thread) when the
 * user clicks it. The notification is retained until it closes so its click
 * handler survives garbage collection.
 */
export function showAppNotification (title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body })
  if (onClick) {
    notification.once('click', () => {
      try {
        onClick()
      } finally {
        activeNotifications.delete(notification)
      }
    })
  }
  notification.once('close', () => {
    activeNotifications.delete(notification)
  })
  activeNotifications.add(notification)
  notification.show()
}
