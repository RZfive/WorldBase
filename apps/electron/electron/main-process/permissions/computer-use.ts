import path from 'node:path'
import type { ComputerUsePermissionStatus, ComputerUsePermissionTarget, ScreenPermissionStatus } from '../../../src/shared/computer-use-permissions.js'
import { createStartupPermissionSnapshot } from './startup-snapshot.js'

interface PermissionHost {
  platform: string
  isPackaged: boolean
  executablePath: string
  getScreenStatus: () => ScreenPermissionStatus
  isAccessibilityTrusted: (prompt: boolean) => boolean
  requestScreenAccess: () => Promise<void>
  openExternal: (url: string) => Promise<unknown>
  warn: (message: string, error: unknown) => void
}

const SETTINGS_PANES = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
} as const

/** All native probes belong to startup or an explicit user authorization request. */
export function createComputerUsePermissionService (host: PermissionHost) {
  const appPath = host.platform === 'darwin' && /\.app\/Contents\/MacOS\/[^/]+$/.test(host.executablePath)
    ? path.posix.dirname(path.posix.dirname(path.posix.dirname(host.executablePath)))
    : host.executablePath
  const unavailable: ComputerUsePermissionStatus = {
    platform: host.platform,
    isPackaged: host.isPackaged,
    appPath,
    screen: 'unknown',
    accessibility: false,
    granted: false
  }
  const snapshot = createStartupPermissionSnapshot<ComputerUsePermissionStatus>(() => {
    if (host.platform !== 'darwin') {
      return { ...unavailable, screen: 'granted', accessibility: true, granted: true }
    }
    // A failed screen probe must not discard a successful Accessibility read
    // (or vice versa). Log failures instead of silently displaying both denied.
    let screen: ScreenPermissionStatus = 'unknown'
    let accessibility = false
    try { screen = host.getScreenStatus() } catch (error) {
      host.warn('[permissions] Could not read Screen Recording status', error)
    }
    try { accessibility = host.isAccessibilityTrusted(false) } catch (error) {
      host.warn('[permissions] Could not read Accessibility status', error)
    }
    return { ...unavailable, screen, accessibility, granted: screen === 'granted' && accessibility }
  }, unavailable)
  let pendingRequest: Promise<{ granted: boolean }> | null = null

  function request (target?: ComputerUsePermissionTarget): Promise<{ granted: boolean }> {
    // Reject arbitrary renderer input before it can select a system URL.
    if (target !== undefined && target !== 'screen' && target !== 'accessibility') {
      return Promise.reject(new Error('Unknown Computer Use permission target'))
    }
    if (pendingRequest) return pendingRequest
    pendingRequest = Promise.resolve().then(async () => {
      const status = snapshot.get()
      if (host.platform !== 'darwin') return { granted: true }
      if (status.granted && !target) return { granted: true }

      if ((!target || target === 'accessibility') && !status.accessibility) {
        try { host.isAccessibilityTrusted(true) } catch (error) {
          host.warn('[permissions] Could not request Accessibility access', error)
        }
      }
      if ((!target || target === 'screen') && status.screen !== 'granted') {
        try {
          // Merely opening Privacy_ScreenCapture does not register this app.
          // Electron must trigger the request as the actual permission client;
          // do not use a Rust/osascript child or treat source listing as a grant.
          await host.requestScreenAccess()
        } catch (error) {
          // Denial is expected. Still open Settings so the user can grant access.
          host.warn('[permissions] Screen Recording request did not complete', error)
        }
      }
      const pane = target ?? (status.screen !== 'granted' ? 'screen' : 'accessibility')
      await host.openExternal(SETTINGS_PANES[pane])
      // Keep startup-only semantics. A prompt/source list is not proof of access.
      return { granted: status.granted }
    }).finally(() => { pendingRequest = null })
    return pendingRequest
  }

  return { initialize: snapshot.initialize, get: snapshot.get, request }
}
