import { app, BrowserWindow, screen, session, type DownloadItem, type IpcMainInvokeEvent, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECT_PACKAGE_EXTENSION } from '../../src/main/project-fs/project-package-service.js'
import { LAN_SERVER_PORT } from '../../src/main/constants.js'
import { t } from '../../src/main/i18n/main-i18n.js'
import type { ActivePageAutomationContext, PageAutomationRendererRequest, PageAutomationRendererResult } from '../../src/shared/page-automation-types.js'
import type { ActiveCodeViewContext } from '../../src/shared/folder-workspace-types.js'
import type { ActiveTerminalContext } from '../../src/shared/terminal-types.js'
import type { WorkspaceTabControlRequest, WorkspaceTabControlResult } from '../../src/shared/workspace-control-types.js'
import { forwardProjectRuntimeLog } from './project-runtime-log-routing.js'
import {
  ALLOWED_WEBVIEW_POPUP_PROTOCOLS,
  DEFAULT_MAIN_WINDOW_MIN_HEIGHT,
  DEFAULT_MAIN_WINDOW_MIN_WIDTH,
  DEFAULT_WINDOW_EXPAND_ANIMATION_DURATION_MS,
  LOCAL_APP_HOSTS,
  PAGE_AUTOMATION_REQUEST_TIMEOUT_MS,
  VIRTUAL_INTERFACE_NAME_PATTERN,
  WORKSPACE_TAB_CONTROL_TIMEOUT_MS
} from './constants.js'
import { aiRequestWindowStorage, activeWindowWidthAnimations, mainState, pendingPageAutomationRequests, pendingWorkspaceTabControlRequests, projectWindows, type EnsureWindowWidthOptions, type WindowBounds } from './state.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const downloadHandlerSessions = new WeakSet<Session>()
const INVALID_DOWNLOAD_FILENAME_PATTERN = /[<>:"/\\|?*\x00-\x1F]/g
const MAX_DOWNLOAD_FILENAME_LENGTH = 180

function sanitizeDownloadFilename (fileName: string): string {
  const normalized = (fileName || 'download').replace(/\\/g, '/')
  const baseName = path.basename(normalized).trim()
  const safeName = baseName.replace(INVALID_DOWNLOAD_FILENAME_PATTERN, '_').trim()
  if (!safeName || /^\.+$/.test(safeName)) return 'download'
  return safeName
}

function limitDownloadFilenameLength (fileName: string): string {
  if (fileName.length <= MAX_DOWNLOAD_FILENAME_LENGTH) return fileName

  const extension = path.extname(fileName)
  const name = path.basename(fileName, extension)
  const maxNameLength = Math.max(1, MAX_DOWNLOAD_FILENAME_LENGTH - extension.length)
  return `${name.slice(0, maxNameLength)}${extension}`
}

function resolveUniqueDownloadPath (suggestedFilename: string): string {
  const downloadsDir = app.getPath('downloads')
  fs.mkdirSync(downloadsDir, { recursive: true })

  const safeFilename = limitDownloadFilenameLength(sanitizeDownloadFilename(suggestedFilename))
  const extension = path.extname(safeFilename)
  const name = path.basename(safeFilename, extension) || 'download'
  let candidate = path.join(downloadsDir, safeFilename)
  let counter = 1

  while (fs.existsSync(candidate)) {
    candidate = path.join(downloadsDir, `${name} (${counter})${extension}`)
    counter += 1
  }

  return candidate
}

export function installWebviewDownloadHandler (targetSession: Session): void {
  if (downloadHandlerSessions.has(targetSession)) return
  downloadHandlerSessions.add(targetSession)

  targetSession.on('will-download', (_event, item: DownloadItem) => {
    try {
      const targetPath = resolveUniqueDownloadPath(item.getFilename())
      item.setSavePath(targetPath)

      item.once('done', (_doneEvent, state) => {
        if (state !== 'completed' && state !== 'cancelled') {
          console.warn('[main] Webview download failed:', state, targetPath)
        }
      })
    } catch (error) {
      console.warn('[main] Failed to prepare webview download path:', error)
    }
  })
}

export function openWebviewPopupInDock (url: string, sourceWebContentsId?: number): void {
  let parsedUrl: URL

  try {
    parsedUrl = new URL(url)
  } catch {
    return
  }

  if (!ALLOWED_WEBVIEW_POPUP_PROTOCOLS.has(parsedUrl.protocol)) {
    console.warn('[main] Blocked external popup URL from webview:', parsedUrl.toString())
    return
  }

  if (mainState.mainWindow && !mainState.mainWindow.isDestroyed()) {
    // The source id lets the renderer keep workspace-tab popups inside the
    // workspace panel instead of bouncing the whole UI to the docked app view.
    mainState.mainWindow.webContents.send('browser:openUrlInDock', {
      url: parsedUrl.toString(),
      ...(typeof sourceWebContentsId === 'number' ? { webContentsId: sourceWebContentsId } : {})
    })
  }
}

export function attachMainWindowWebviewHandlers (win: BrowserWindow): void {
  win.webContents.on('did-attach-webview', (_event, guestContents) => {
    installWebviewDownloadHandler(guestContents.session)

    guestContents.setWindowOpenHandler(({ url }) => {
      openWebviewPopupInDock(url, guestContents.id)
      return { action: 'deny' }
    })

    // Webview guests swallow the DOM contextmenu; forward the guest-side
    // params to the host window so BrowserWebView can show its own menu.
    guestContents.on('context-menu', (_menuEvent, params) => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send('browserPage:contextMenu', {
        webContentsId: guestContents.id,
        params: {
          x: params.x,
          y: params.y,
          selectionText: params.selectionText ?? '',
          linkURL: params.linkURL ?? '',
          mediaType: params.mediaType ?? 'none',
          srcURL: params.srcURL ?? '',
          isEditable: params.isEditable ?? false
        }
      })
    })
  })
}

function resolveRuntimePortFromUrl (value: string): number | null {
  if (!value) return null

  try {
    const parsedUrl = new URL(value)
    if (!LOCAL_APP_HOSTS.has(parsedUrl.hostname)) return null

    const port = Number(parsedUrl.port)
    if (!Number.isInteger(port) || port <= 0) return null

    return port
  } catch {
    return null
  }
}

function forwardRuntimeLog (port: number, type: 'stdout' | 'stderr', text: string): void {
  const rustClient = mainState.rustHarness
  forwardProjectRuntimeLog({
    port,
    type,
    text,
    rustSelected: true,
    rust: rustClient
      ? {
          isRunning: () => rustClient.isRunning(),
          append: async (nativePort, nativeType, nativeText) => {
            return await rustClient.callRunning('project.logs.append', {
              port: nativePort,
              type: nativeType,
              text: nativeText
            })
          }
        }
      : null,
    typeScript: null,
    onRustAppendError: error => {
      // A handoff or app-server shutdown can race with Chromium console events.
      console.warn('[rust-harness] Failed to append project renderer log:', error)
    }
  })
}

export function forwardProjectRendererConsoleMessage (level: number, message: string, line: number, sourceId: string): void {
  const levelLabel = ['debug', 'info', 'warn', 'error'][level] || String(level)
  const type: 'stdout' | 'stderr' = level >= 3 ? 'stderr' : 'stdout'
  const location = sourceId ? ` (${sourceId}:${line})` : ''
  const text = `[app:${levelLabel}] ${message}${location}`
  const port = resolveRuntimePortFromUrl(sourceId)
  if (!port) return
  forwardRuntimeLog(port, type, text)
}

export function forwardProjectLoadFailure (errorCode: number, errorDescription: string, validatedURL: string): void {
  const port = resolveRuntimePortFromUrl(validatedURL)
  if (!port) return
  const text = `[app:load-failed] ${errorDescription} (${errorCode}) (${validatedURL})`
  forwardRuntimeLog(port, 'stderr', text)
}

export function attachProjectRuntimeLogForwarding (win: BrowserWindow): void {
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    forwardProjectRendererConsoleMessage(level, message, line, sourceId)
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    forwardProjectLoadFailure(errorCode, errorDescription, validatedURL)
  })
}

export function getUrlHostname (value?: string): string | null {
  if (!value || value === 'null') return null
  try {
    return new URL(value).hostname
  } catch {
    return null
  }
}

export function isLocalAppOrigin (value?: string): boolean {
  // file:// renderers report an opaque "null" origin, so guard both the literal
  // string and actual file URLs when deciding whether to relax iframe/CORS rules.
  if (!value || value === 'null') return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'file:' || LOCAL_APP_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

export function getOriginFromUrl (value?: string): string | null {
  if (!value || value === 'null') return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export function isPrivateIpv4 (address: string): boolean {
  const octets = address.split('.').map(part => Number.parseInt(part, 10))
  if (octets.length !== 4 || octets.some(octet => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return false
  }

  if (octets[0] === 10) return true
  if (octets[0] === 192 && octets[1] === 168) return true
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true
  return false
}

export function isLinkLocalIpv4 (address: string): boolean {
  return address.startsWith('169.254.')
}

export function getPreferredLanIpv4Addresses (): string[] {
  const nets = networkInterfaces()
  const candidates: Array<{ address: string; score: number }> = []

  for (const [name, entries] of Object.entries(nets)) {
    const normalizedName = name || ''
    const isVirtualInterface = VIRTUAL_INTERFACE_NAME_PATTERN.test(normalizedName)

    for (const net of entries || []) {
      if (net.family !== 'IPv4' || net.internal || !net.address || isLinkLocalIpv4(net.address)) {
        continue
      }

      let score = 0
      if (isPrivateIpv4(net.address)) score += 100
      if (!isVirtualInterface) score += 30
      if (normalizedName.toLowerCase().includes('wi-fi') || normalizedName.toLowerCase().includes('wlan')) score += 10
      if (normalizedName.toLowerCase().includes('ethernet')) score += 10
      if (isVirtualInterface) score -= 50

      candidates.push({ address: net.address, score })
    }
  }

  const seen = new Set<string>()
  return candidates
    .sort((left, right) => right.score - left.score || left.address.localeCompare(right.address))
    .map(candidate => candidate.address)
    .filter(address => {
      if (seen.has(address)) return false
      seen.add(address)
      return true
    })
}

export function isRemoteSubresourceRequest (value: string): boolean {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return !LOCAL_APP_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

export function isLanResourceProxyRequest (value: string): boolean {
  try {
    const parsed = new URL(value)
    return LOCAL_APP_HOSTS.has(parsed.hostname) && parsed.port === String(LAN_SERVER_PORT) && parsed.pathname.startsWith('/api/resource-proxy')
  } catch {
    return false
  }
}

export function getResourceProxyUrl (resourceUrl: string): string {
  const parsed = new URL(resourceUrl)
  const protocol = parsed.protocol.replace(':', '')
  const host = encodeURIComponent(parsed.host)
  const pathname = parsed.pathname || '/'
  return `http://127.0.0.1:${LAN_SERVER_PORT}/api/resource-proxy/${protocol}/${host}${pathname}${parsed.search}`
}

export function upsertHeader (headers: Record<string, string[]>, name: string, value: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      headers[key] = [value]
      return
    }
  }
  headers[name] = [value]
}

export function removeHeader (headers: Record<string, string[]>, name: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      delete headers[key]
    }
  }
}

export function setupEmbeddedAppCorsWorkaround (): void {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const referrer = typeof details.referrer === 'string' ? details.referrer : undefined
    const isFromLocalApp = isLocalAppOrigin(referrer)
    const isFrameRequest = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame'
    const method = (details.method || 'GET').toUpperCase()

    if (
      !isFromLocalApp ||
      isFrameRequest ||
      !isRemoteSubresourceRequest(details.url) ||
      isLanResourceProxyRequest(details.url) ||
      (method !== 'GET' && method !== 'HEAD')
    ) {
      callback({})
      return
    }

    callback({ redirectURL: getResourceProxyUrl(details.url) })
  })

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const referrer = typeof details.referrer === 'string' ? details.referrer : undefined
    const isFromLocalApp = isLocalAppOrigin(referrer)
    const isFrameRequest = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame'

    if (!isFromLocalApp || !isRemoteSubresourceRequest(details.url)) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }

    const headers = { ...(details.responseHeaders || {}) }

    if (isFrameRequest) {
      removeHeader(headers, 'X-Frame-Options')
      removeHeader(headers, 'Content-Security-Policy')
      removeHeader(headers, 'Content-Security-Policy-Report-Only')
      callback({ responseHeaders: headers })
      return
    }

    const allowOrigin = getOriginFromUrl(referrer) || '*'
    upsertHeader(headers, 'Access-Control-Allow-Origin', allowOrigin)
    upsertHeader(headers, 'Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    upsertHeader(headers, 'Cross-Origin-Resource-Policy', 'cross-origin')
    upsertHeader(headers, 'Vary', 'Origin')

    callback({ responseHeaders: headers })
  })
}

export function broadcastToAppWindows (channel: string, payload: unknown): void {
  const windows = new Set<BrowserWindow>()
  if (mainState.mainWindow && !mainState.mainWindow.isDestroyed()) {
    windows.add(mainState.mainWindow)
  }
  for (const win of projectWindows.values()) {
    if (!win.isDestroyed()) {
      windows.add(win)
    }
  }
  for (const win of windows) {
    win.webContents.send(channel, payload)
  }
}

export function getSenderWindow (event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function getActiveAiRequestWindow (): BrowserWindow | null {
  return aiRequestWindowStorage.getStore() ?? mainState.mainWindow
}

export function runWithAiRequestWindow<T> (win: BrowserWindow | null, task: () => Promise<T>): Promise<T> {
  return aiRequestWindowStorage.run(win, task)
}

export async function requestPageAutomationFromRenderer<T extends PageAutomationRendererResult> (request: PageAutomationRendererRequest): Promise<T> {
  const targetWindow = getActiveAiRequestWindow()
  if (!targetWindow || targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
    throw new Error(t('mainDialog.pageAutomationNoWindow'))
  }

  return await new Promise<T>((resolve, reject) => {
    const requestId = randomUUID()
    const timeout = setTimeout(() => {
      pendingPageAutomationRequests.delete(requestId)
      reject(new Error(t('mainDialog.pageAutomationTimeout')))
    }, PAGE_AUTOMATION_REQUEST_TIMEOUT_MS)

    pendingPageAutomationRequests.set(requestId, {
      resolve: (result) => resolve(result as T),
      reject,
      timeout
    })

    targetWindow.webContents.send('pageAutomation:request', {
      requestId,
      request
    })
  })
}

/**
 * Round-trip for the AI `manage_workspace_tabs` tool: the tab state lives in
 * the renderer's workspace store, so list/activate/close must be answered
 * there (activate/close go through the chat shell to reuse the panel's
 * window-width animation). Mirrors `requestPageAutomationFromRenderer`.
 */
export async function requestWorkspaceTabControlFromRenderer (request: WorkspaceTabControlRequest): Promise<WorkspaceTabControlResult> {
  const targetWindow = getActiveAiRequestWindow()
  if (!targetWindow || targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
    throw new Error('No active Electron window for workspace tab control')
  }

  return await new Promise<WorkspaceTabControlResult>((resolve, reject) => {
    const requestId = randomUUID()
    const timeout = setTimeout(() => {
      pendingWorkspaceTabControlRequests.delete(requestId)
      reject(new Error('Workspace tab control timed out in the renderer'))
    }, WORKSPACE_TAB_CONTROL_TIMEOUT_MS)

    pendingWorkspaceTabControlRequests.set(requestId, {
      resolve: (result) => resolve(result),
      reject,
      timeout
    })

    targetWindow.webContents.send('workspace:tabControl', {
      requestId,
      request
    })
  })
}

export function buildActivePagePromptSection (activePageContext?: ActivePageAutomationContext | null): string | null {
  if (!activePageContext || activePageContext.kind !== 'browser') return null

  const lines = [
    '## Active in-app browser page',
    '- The user currently has a live browser page open inside the app shell.',
    `- Active page title: ${activePageContext.title || '(untitled page)'}`,
    `- Active page URL: ${activePageContext.url || '(unknown URL)'}`,
    `- Active page origin: ${activePageContext.origin || '(unknown origin)'}`,
    '- If the user asks what is on this page or asks you to operate it, call read_current_page first to inspect the live DOM, then use interact_current_page for click, input, select, scroll, wait, extract, evaluate, hover, focus, or press_key actions.',
    '- For filling multiple form fields at once, use fill_current_page_form with the selectors returned by read_current_page.',
    '- For long pages, either paginate with interact_current_page action="extract" plus offset/max_chars, or call save_current_page_as_document to persist the page as a chunked document and read it with read_document.',
    '- Do not use fetch_webpage for this active in-app page. fetch_webpage is only for public external references, not the live embedded browser surface.'
  ]

  return lines.join('\n')
}

/**
 * Routing policy for web retrieval: static fetches first, the built-in
 * workspace browser when they are blocked, external browser MCP only as a
 * last resort. Kept as a single static section so every run gets the same
 * ladder (see docs/web-capability-router-design.md §3).
 */
export function buildWebCapabilityPolicySection (): string {
  return [
    '## Web access policy (built-in first)',
    '- For public web content, start with web_search / web_fetch. They are fast and silent, but they do not run JavaScript and have no login session.',
    '- When a web_search / web_fetch result reports `access: "blocked"` or `"degraded"` (HTTP 401/403/429/503, an anti-bot challenge, a thin JS-only shell page, or all search sources failed), do NOT retry the same static request. Switch to the built-in workspace browser:',
    '  1. open_workspace_tab with kind "browser" and the target URL — it opens visibly so the user can follow along;',
    '  2. read_current_page with mode "article" to extract the readable page content;',
    '  3. interact_current_page only when the information requires an action (site search box, pagination, cookie banner).',
    '- The built-in browser reuses the app\'s persistent session, so pages behind the user\'s existing logins usually work there. Prefer it over external browser automation.',
    '- Only use browser-class mcp__ tools (chrome/playwright MCP) when the built-in browser genuinely cannot do the job (multi-tab orchestration, network-level capture) AND such an MCP server is configured; those calls require user approval.',
    '- Never call web_search/web_fetch for a page that is already open in the embedded browser; read_current_page is the source of truth for it.'
  ].join('\n')
}

export function buildActiveCodeViewPromptSection (activeCodeContext?: ActiveCodeViewContext | null): string | null {
  if (!activeCodeContext || !activeCodeContext.filePath) return null

  const lines = [
    '## Currently viewed code file',
    `- The user is viewing \`${activeCodeContext.filePath}\` in the folder workspace "${activeCodeContext.rootName}" (${activeCodeContext.rootPath}), ${activeCodeContext.lineCount} lines${activeCodeContext.truncated ? ' (viewer shows a truncated head)' : ''}.`,
    '- Treat this file as the user\'s current focus: when the request is ambiguous about which file it refers to, prefer this one.',
    '- Read it with read_workspace_file (relative path) to verify current content before discussing or editing it.'
  ]
  if (activeCodeContext.selection) {
    const { start, end } = activeCodeContext.selection
    const rangeLabel = start === end ? `line ${start}` : `lines ${start}-${end}`
    lines.push(
      `- The user currently checked/selected ${rangeLabel} in the viewer.`,
      '- When the user says "selected code" / "勾选的部分" / "当前选中" / "选中的几行" without naming a file, they mean this exact range of this file. Read at least that range before answering.'
    )
  }

  return lines.join('\n')
}

export function buildActiveTerminalPromptSection (activeTerminalContext?: ActiveTerminalContext | null): string | null {
  if (!activeTerminalContext) return null

  const lines = [
    '## Active terminal',
    '- The user currently has a live terminal session open in the workspace panel.',
    `- Terminal working directory: ${activeTerminalContext.cwd || '(home directory)'}`,
    '- This is a SHARED terminal: whatever you write appears in the user\'s terminal in real time, and everything the user types is visible to you.',
    '- Use read_active_terminal to inspect the terminal screen (cleaned text tail) before acting, and write_active_terminal with execute=true to run a command, then read the returned output.',
    '- While a long-running command produces output, never type filler keys (".", spaces, empty lines) to pass time: call write_active_terminal with empty text and a wait_ms (up to 120000) to wait and get the new output in one step. To just press Enter on an interactive prompt, pass execute=false with a single newline as text.',
    '- Prefer dedicated tools (run_project_command, run_workspace_command, file tools) for non-interactive work; use the shared terminal only when the user asks you to operate it or for interactive programs (dev servers, REPLs, paged installers).',
    '- Commands executed here are approved by the user in real time; do not repeat a command whose output already shows it ran, and avoid destructive commands.'
  ]

  return lines.join('\n')
}

export function sanitizeProjectPackageBaseName (value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()

  return normalized || 'the-world-app'
}

export function createProjectPackageDefaultName (projectName: string, projectId: string): string {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  return `${sanitizeProjectPackageBaseName(projectName || projectId)}-${stamp}.${PROJECT_PACKAGE_EXTENSION}`
}

export function guessImageExtension (mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('png')) return 'png'
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg'
  if (normalized.includes('webp')) return 'webp'
  if (normalized.includes('gif')) return 'gif'
  if (normalized.includes('svg')) return 'svg'
  return 'png'
}

export async function resolveImageBuffer (imageUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (imageUrl.startsWith('data:')) {
    const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) {
      throw new Error(t('mainDialog.unsupportedImageData'))
    }

    return {
      mimeType: match[1],
      buffer: Buffer.from(match[2], 'base64')
    }
  }

  const response = await fetch(imageUrl)
  if (!response.ok) {
    throw new Error(t('mainDialog.imageDownloadFailed', { status: response.status }))
  }

  const mimeType = response.headers.get('content-type') || 'image/png'
  const arrayBuffer = await response.arrayBuffer()
  return {
    mimeType,
    buffer: Buffer.from(arrayBuffer)
  }
}

export function buildRendererWindowUrl (projectId?: string): { devUrl?: string; filePath?: string; query?: Record<string, string> } {
  if (process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL)
    if (projectId) {
      url.searchParams.set('projectWindow', projectId)
    }
    return { devUrl: url.toString() }
  }

  const query = projectId ? { projectWindow: projectId } : undefined
  return {
    filePath: path.join(__dirname, '../../dist/index.html'),
    query
  }
}

export function getProjectsDir (): string {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, 'projects')
}

export function getSnapshotsDir (): string {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, 'snapshots')
}

export function createWindow (): void {
  mainState.mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    transparent: false,
    backgroundColor: '#0f0f10',
    minWidth: DEFAULT_MAIN_WINDOW_MIN_WIDTH,
    minHeight: DEFAULT_MAIN_WINDOW_MIN_HEIGHT,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  attachMainWindowWebviewHandlers(mainState.mainWindow)
  attachProjectRuntimeLogForwarding(mainState.mainWindow)

  mainState.mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (!/(\[web-apps\]|\[launchpad\]|\[browser-webview\])/.test(message)) return
    const levelLabel = ['debug', 'info', 'warn', 'error'][level] || String(level)
    console.log(`[renderer:${levelLabel}] ${message} (${sourceId}:${line})`)
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainState.mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainState.mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'))
  }

  mainState.mainWindow.on('close', (event) => {
    if (mainState.hasFinishedQuitCleanup) return
    if (mainState.isClosingMainWindow || mainState.isQuitCleanupRunning) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    mainState.isClosingMainWindow = true
    app.quit()
  })

  mainState.mainWindow.on('closed', () => {
    stopWindowWidthAnimation(mainState.mainWindow)
    mainState.mainWindow = null
  })
}

export function stopWindowWidthAnimation (targetWindow: BrowserWindow | null, result?: { applied: boolean; width: number }): void {
  if (!targetWindow) return

  const animation = activeWindowWidthAnimations.get(targetWindow.id)
  if (!animation) return

  clearInterval(animation.timer)
  activeWindowWidthAnimations.delete(targetWindow.id)
  animation.resolve(result ?? {
    applied: false,
    width: targetWindow.isDestroyed() ? 0 : targetWindow.getBounds().width
  })
}

export function resolveWindowBoundsForMinimumWidth (
  targetWindow: BrowserWindow,
  requestedWidth: number,
  options?: EnsureWindowWidthOptions
): { currentBounds: WindowBounds; nextBounds: WindowBounds; canResize: boolean } {
  const currentBounds = targetWindow.getBounds()

  if (!Number.isFinite(requestedWidth) || requestedWidth <= 0 || targetWindow.isMaximized() || targetWindow.isFullScreen()) {
    return { currentBounds, nextBounds: currentBounds, canResize: false }
  }

  const [minimumWindowWidth] = targetWindow.getMinimumSize()
  const desiredWidth = Math.max(minimumWindowWidth || 0, Math.round(requestedWidth))
  const display = screen.getDisplayMatching(currentBounds)
  const maxDisplayWidth = display.workArea.width >= minimumWindowWidth
    ? display.workArea.width
    : minimumWindowWidth
  const nextWidth = Math.min(desiredWidth, maxDisplayWidth)
  const allowShrink = Boolean(options?.allowShrink)

  if (currentBounds.width === nextWidth || (!allowShrink && currentBounds.width >= nextWidth)) {
    return { currentBounds, nextBounds: currentBounds, canResize: false }
  }

  const maxX = display.workArea.x + display.workArea.width - nextWidth
  const nextX = maxX < display.workArea.x
    ? display.workArea.x
    : Math.min(
        Math.max(display.workArea.x, Math.round(currentBounds.x - (nextWidth - currentBounds.width) / 2)),
        maxX
      )
  const maxY = display.workArea.y + display.workArea.height - currentBounds.height
  const nextY = maxY < display.workArea.y
    ? display.workArea.y
    : Math.min(Math.max(display.workArea.y, currentBounds.y), maxY)

  return {
    currentBounds,
    nextBounds: {
      x: nextX,
      y: nextY,
      width: nextWidth,
      height: currentBounds.height
    },
    canResize: true
  }
}

export async function animateWindowBounds (targetWindow: BrowserWindow, currentBounds: WindowBounds, nextBounds: WindowBounds, durationMs?: number): Promise<{ applied: boolean; width: number }> {
  const duration = Number.isFinite(durationMs)
    ? Math.max(120, Math.round(durationMs || 0))
    : DEFAULT_WINDOW_EXPAND_ANIMATION_DURATION_MS

  if (
    duration <= 0
    || (currentBounds.width === nextBounds.width
      && currentBounds.x === nextBounds.x
      && currentBounds.y === nextBounds.y
      && currentBounds.height === nextBounds.height)
  ) {
    targetWindow.setBounds(nextBounds)
    return { applied: true, width: nextBounds.width }
  }

  stopWindowWidthAnimation(targetWindow)

  return await new Promise((resolve) => {
    const startTime = Date.now()
    const deltaX = nextBounds.x - currentBounds.x
    const deltaY = nextBounds.y - currentBounds.y
    const deltaWidth = nextBounds.width - currentBounds.width
    const deltaHeight = nextBounds.height - currentBounds.height
    const timer = setInterval(() => {
      if (targetWindow.isDestroyed()) {
        stopWindowWidthAnimation(targetWindow, { applied: false, width: 0 })
        return
      }

      const elapsed = Date.now() - startTime
      const progress = Math.min(1, elapsed / duration)
      const easedProgress = 1 - Math.pow(1 - progress, 3)

      targetWindow.setBounds({
        x: Math.round(currentBounds.x + deltaX * easedProgress),
        y: Math.round(currentBounds.y + deltaY * easedProgress),
        width: Math.round(currentBounds.width + deltaWidth * easedProgress),
        height: Math.round(currentBounds.height + deltaHeight * easedProgress)
      })

      if (progress >= 1) {
        targetWindow.setBounds(nextBounds)
        stopWindowWidthAnimation(targetWindow, { applied: true, width: nextBounds.width })
      }
    }, 16)

    activeWindowWidthAnimations.set(targetWindow.id, { timer, resolve })
  })
}

export function setWindowMinimumWidth (targetWindow: BrowserWindow, requestedWidth: number): { success: boolean; width: number } {
  if (!Number.isFinite(requestedWidth) || requestedWidth <= 0) {
    return {
      success: false,
      width: targetWindow.getMinimumSize()[0] || DEFAULT_MAIN_WINDOW_MIN_WIDTH
    }
  }

  const display = screen.getDisplayMatching(targetWindow.getBounds())
  const [, minimumHeight] = targetWindow.getMinimumSize()
  const nextMinimumWidth = Math.min(Math.round(requestedWidth), display.workArea.width)
  targetWindow.setMinimumSize(nextMinimumWidth, minimumHeight || DEFAULT_MAIN_WINDOW_MIN_HEIGHT)

  return {
    success: true,
    width: nextMinimumWidth
  }
}

export async function ensureWindowHasMinimumWidth (targetWindow: BrowserWindow, requestedWidth: number, options?: EnsureWindowWidthOptions): Promise<{ applied: boolean; width: number }> {
  const { currentBounds, nextBounds, canResize } = resolveWindowBoundsForMinimumWidth(targetWindow, requestedWidth, options)

  if (!canResize) {
    return { applied: false, width: currentBounds.width }
  }

  if (options?.animate) {
    return await animateWindowBounds(targetWindow, currentBounds, nextBounds, options.durationMs)
  }

  stopWindowWidthAnimation(targetWindow)
  targetWindow.setBounds(nextBounds)

  return { applied: true, width: nextBounds.width }
}
