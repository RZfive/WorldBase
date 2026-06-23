<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import ChatPanel from './renderer/components/chat/ChatPanel.vue'
import Launchpad from './renderer/components/launchpad/Launchpad.vue'
import AISettings from './renderer/components/settings/AISettings.vue'
import ImageStudio from './renderer/components/studio/ImageStudio.vue'
import SourceViewer from './renderer/components/viewer/SourceViewer.vue'
import TitleBar from './renderer/components/app/TitleBar.vue'
import DockBar from './renderer/components/app/DockBar.vue'
import BrowserWebView from './renderer/components/app/BrowserWebView.vue'
import FloatingTaskBubble from './renderer/components/app/FloatingTaskBubble.vue'
import ProjectWindowShell from './renderer/components/app/ProjectWindowShell.vue'
import ScheduledTaskReportDialog from './renderer/components/settings/ScheduledTaskReportDialog.vue'
import type { ChatSurfaceStatusSummary } from './renderer/components/chat/panel/types'
import type {
  ActivePageAutomationContext,
  BrowserAutomationAction,
  BrowserAutomationActionResult,
  BrowserAutomationSnapshot,
  PageAutomationRequestEnvelope,
  PageAutomationResponseEnvelope
} from './shared/page-automation-types'
import { applyThemePreference, getAppliedThemePreference, watchSystemThemeChange } from './renderer/utils/theme'
import { createWebAppId, getWebAppNameFromUrl, normalizeWebUrlInput, type SavedWebApp } from './renderer/utils/web-app'

interface RunningApp {
  id: string
  name: string
  kind: 'project' | 'browser'
  type: string
  icon?: string
  url?: string
  port?: number
  isWindow: boolean
  closable?: boolean
  savedToLaunchpad?: boolean
  /** Present on dock items the user pinned to the dock. */
  pinned?: boolean
  /** Whether a pinned dock item is currently open/running. */
  isRunning?: boolean
}

interface ProjectStatus {
  status: string
  port?: number
}

interface ProjectLanUrlInfo {
  projectPort: number | null
  lanUrl: string | null
  proxyUrl: string
  localProxyUrl: string
  lanIp: string
}

interface ProjectListItem {
  id: string
  name?: string
  type?: string
  icon?: string
  runtime?: ProjectStatus
}

const standaloneProjectId = new URLSearchParams(window.location.search).get('projectWindow')
const isStandaloneProjectWindow = Boolean(standaloneProjectId)
const { t } = useI18n()

type MainView = 'chat' | 'app' | 'source' | 'settings' | 'studio'
type AppChatPresentation = 'full' | 'bubble' | 'overlay'
type ChatShellMode = 'full' | 'overlay' | 'hidden'

interface EmbeddedAppState {
  url: string
  loading: boolean
  kind: 'project' | 'browser'
  sandbox: string
  projectPort?: number
}

interface ActivePageSurfaceSummary {
  appId: string
  kind: 'project' | 'browser'
  title: string
  icon?: string
  url: string | null
  origin: string | null
  loading: boolean
}

interface BrowserAutomationViewHandle {
  captureAutomationSnapshot: () => Promise<BrowserAutomationSnapshot>
  runAutomationAction: (action: BrowserAutomationAction) => Promise<BrowserAutomationActionResult>
}

/** Maximum seconds to wait for a project's port to become available after starting. */
const START_TIMEOUT_SECONDS = 15
const RUNNING_APPS_REFRESH_INTERVAL_MS = 5000
/** QR code image dimensions. */
const QR_CODE_WIDTH = 220
const QR_CODE_MARGIN = 2
/** Duration in ms for the "copied" feedback after copying a LAN URL. */
const COPY_FEEDBACK_MS = 2000
const PROJECT_IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals'
const PROJECT_IFRAME_ALLOW = 'clipboard-read; clipboard-write; fullscreen'
const BROWSER_IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals'

function logWebAppsSnapshot (label: string, webApps: SavedWebApp[]) {
  console.info(`[web-apps] ${label}`, webApps.map(app => ({
    id: app.id,
    name: app.name,
    url: app.url
  })))
}

function toPlainSavedWebApps (webApps: SavedWebApp[]): SavedWebApp[] {
  return webApps.map(app => ({
    id: app.id,
    kind: 'web',
    type: 'browser',
    name: app.name,
    url: app.url,
    icon: app.icon,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt
  }))
}

const currentView = ref<MainView>('chat')
const appChatPresentation = ref<AppChatPresentation>('full')
const chatProjectContext = ref<Record<string, unknown> | null>(null)
const embeddedApps = ref(new Map<string, EmbeddedAppState>())
const activeEmbeddedProjectId = ref<string | null>(null)
const sourceProject = ref<Record<string, unknown> | null>(null)
const showLaunchpad = ref(false)
const chatSurfaceStatus = ref<ChatSurfaceStatusSummary>({
  contextLabel: t('appShell.newChatContext'),
  contextDetail: 'The World AI',
  isLoading: false,
  pendingAuthCount: 0,
  activeTodoCount: 0,
  primaryTaskTitle: null
})
const browserAutomationHandles = new Map<string, BrowserAutomationViewHandle>()

const runningApps = ref(new Map<string, RunningApp>())
const browserApps = ref(new Map<string, RunningApp>())
const savedWebApps = ref<SavedWebApp[]>([])
const pinnedDockApps = ref<PinnedDockApp[]>([])

/** Running apps minus any that are pinned (pinned ones render in their own section). */
const dockApps = computed(() => {
  const apps = new Map(runningApps.value)
  for (const [appId, app] of browserApps.value) {
    apps.set(appId, app)
  }
  for (const pinned of pinnedDockApps.value) {
    apps.delete(pinned.id)
  }
  return apps
})

/** Pinned dock items resolved to renderable RunningApp shapes, with live run state. */
const pinnedDockItems = computed<RunningApp[]>(() => {
  return pinnedDockApps.value.map(pinned => {
    const running = runningApps.value.get(pinned.id) || browserApps.value.get(pinned.id)
    return {
      id: pinned.id,
      name: running?.name || pinned.name,
      kind: pinned.kind,
      type: running?.type || pinned.type || (pinned.kind === 'browser' ? 'browser' : 'unknown'),
      icon: running?.icon || pinned.icon,
      url: running?.url || pinned.url,
      port: running?.port,
      isWindow: running?.isWindow ?? false,
      closable: running?.closable,
      savedToLaunchpad: running?.savedToLaunchpad,
      pinned: true,
      isRunning: Boolean(running)
    }
  })
})

function resolveUrlOrigin (value: string | null | undefined): string | null {
  if (!value) return null

  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

const activePageSurface = computed<ActivePageSurfaceSummary | null>(() => {
  const appId = activeEmbeddedProjectId.value
  if (!appId) return null

  const appState = embeddedApps.value.get(appId)
  if (!appState) return null

  if (appState.kind === 'browser') {
    const browserApp = browserApps.value.get(appId)
    const url = appState.url || browserApp?.url || null
    return {
      appId,
      kind: 'browser',
      title: browserApp?.name || appState.url || appId,
      icon: browserApp?.icon || '🌐',
      url,
      origin: resolveUrlOrigin(url),
      loading: appState.loading
    }
  }

  const runningApp = runningApps.value.get(appId)
  const url = appState.url || null
  return {
    appId,
    kind: 'project',
    title: runningApp?.name || appId,
    icon: runningApp?.icon || '🧩',
    url,
    origin: resolveUrlOrigin(url),
    loading: appState.loading
  }
})

const chatShellMode = computed<ChatShellMode>(() => {
  if (showLaunchpad.value) return 'hidden'
  if (currentView.value === 'chat') return 'full'
  if (currentView.value === 'app' && appChatPresentation.value === 'overlay') return 'overlay'
  return 'hidden'
})

const showAppChatBubble = computed(() => (
  currentView.value === 'app'
  && !showLaunchpad.value
  && appChatPresentation.value === 'bubble'
  && Boolean(activeBrowserPageSurface.value)
))

const activeBrowserPageSurface = computed(() => {
  return activePageSurface.value?.kind === 'browser' ? activePageSurface.value : null
})

const shouldMountChatShell = computed(() => {
  return currentView.value !== 'app' || Boolean(activeEmbeddedProjectId.value)
})

const activePageAutomationContext = computed<ActivePageAutomationContext | null>(() => {
  if (currentView.value !== 'app') return null
  if (!activeBrowserPageSurface.value) return null

  return {
    appId: activeBrowserPageSurface.value.appId,
    kind: 'browser',
    title: activeBrowserPageSurface.value.title,
    url: activeBrowserPageSurface.value.url,
    origin: activeBrowserPageSurface.value.origin
  }
})

const dockCtx = ref<{ visible: boolean; x: number; y: number; app: RunningApp | null }>({
  visible: false,
  x: 0,
  y: 0,
  app: null
})

let projectChangedCleanup: (() => void) | null = null
let windowClosedCleanup: (() => void) | null = null
let projectOpenInShellCleanup: (() => void) | null = null
let browserOpenInDockCleanup: (() => void) | null = null
let schedulerReportRequestedCleanup: (() => void) | null = null
let pageAutomationRequestCleanup: (() => void) | null = null
let runningAppsRefreshToken = 0
let stopThemeWatcher: (() => void) | null = null
let runningAppsInterval: ReturnType<typeof setInterval> | null = null

const scheduledTaskReport = ref<ScheduledTaskRunReport | null>(null)

function clearEmbeddedApp (appId?: string) {
  if (appId) {
    const embeddedApp = embeddedApps.value.get(appId)
    embeddedApps.value.delete(appId)
    browserAutomationHandles.delete(appId)
    if (embeddedApp?.kind === 'browser') {
      const nextBrowserApps = new Map(browserApps.value)
      nextBrowserApps.delete(appId)
      browserApps.value = nextBrowserApps
    }
    if (activeEmbeddedProjectId.value === appId) {
      // Switch to another open app, or clear
      const remaining = [...embeddedApps.value.keys()]
      activeEmbeddedProjectId.value = remaining.length > 0 ? remaining[remaining.length - 1] : null
    }
    if (embeddedApps.value.size === 0) {
      appChatPresentation.value = 'full'
      currentView.value = 'chat'
    }
  } else {
    embeddedApps.value.clear()
    activeEmbeddedProjectId.value = null
    browserApps.value.clear()
    browserAutomationHandles.clear()
    appChatPresentation.value = 'full'
  }
}

function setBrowserAutomationHandle (appId: string, instance: unknown) {
  const handle = instance as BrowserAutomationViewHandle | null
  if (handle) {
    browserAutomationHandles.set(appId, handle)
    return
  }
  browserAutomationHandles.delete(appId)
}

function getActiveBrowserAutomationHandle (): BrowserAutomationViewHandle | null {
  const appId = activeEmbeddedProjectId.value
  if (!appId) return null

  const appState = embeddedApps.value.get(appId)
  if (!appState || appState.kind !== 'browser') return null

  return browserAutomationHandles.get(appId) || null
}

async function handlePageAutomationRequest (payload: PageAutomationRequestEnvelope) {
  const respond = window.electronAPI?.respondPageAutomationRequest
  if (!respond) return

  let response: PageAutomationResponseEnvelope
  try {
    const handle = getActiveBrowserAutomationHandle()
    if (!handle) {
      throw new Error(t('appShell.pageAutomationNoActivePage'))
    }

    const result = payload.request.type === 'snapshot'
      ? await handle.captureAutomationSnapshot()
      : await handle.runAutomationAction(payload.request.action)

    response = {
      requestId: payload.requestId,
      ok: true,
      result
    }
  } catch (error) {
    response = {
      requestId: payload.requestId,
      ok: false,
      error: error instanceof Error ? error.message : t('appShell.pageAutomationFailed')
    }
  }

  respond(response)
}

async function fetchProjectMeta (projectId: string) {
  if (!window.electronAPI) return { id: projectId }
  return await window.electronAPI.getProject(projectId)
}

async function getRuntimeStatus (projectId: string) {
  if (!window.electronAPI) return { status: 'unknown' } as ProjectStatus
  return await window.electronAPI.getProjectStatus(projectId) as unknown as ProjectStatus
}

function buildProjectFrameUrl (port: number): string {
  return `http://127.0.0.1:${port}`
}

function resolveSavedWebAppId (
  app: Pick<RunningApp, 'id' | 'kind' | 'url'>,
  savedApps = savedWebApps.value
): string | null {
  if (app.kind !== 'browser') return null

  const savedById = savedApps.find(entry => entry.id === app.id)
  if (savedById) return savedById.id

  const normalizedUrl = normalizeWebUrlInput(app.url || '')
  if (!normalizedUrl) return null

  const savedByUrl = savedApps.find(entry => normalizeWebUrlInput(entry.url) === normalizedUrl)
  return savedByUrl?.id || null
}

function syncBrowserAppSavedFlags (nextSavedWebApps: SavedWebApp[]) {
  const nextBrowserApps = new Map(browserApps.value)
  let hasChanges = false

  for (const [appId, app] of browserApps.value) {
    const nextSavedState = resolveSavedWebAppId(app, nextSavedWebApps) !== null
    if (app.savedToLaunchpad !== nextSavedState) {
      nextBrowserApps.set(appId, {
        ...app,
        savedToLaunchpad: nextSavedState
      })
      hasChanges = true
    }
  }

  if (hasChanges) {
    browserApps.value = nextBrowserApps
  }
}

async function loadSavedWebApps () {
  if (!window.electronAPI?.getWebApps) return

  const nextSavedWebApps = toPlainSavedWebApps(await window.electronAPI.getWebApps() as SavedWebApp[])
  logWebAppsSnapshot('loadSavedWebApps <- main', nextSavedWebApps)
  savedWebApps.value = nextSavedWebApps
  syncBrowserAppSavedFlags(nextSavedWebApps)
}

async function persistSavedWebApps (nextSavedWebApps: SavedWebApp[]) {
  if (!window.electronAPI?.saveWebApps) return

  const serializableWebApps = toPlainSavedWebApps(nextSavedWebApps)

  logWebAppsSnapshot('persistSavedWebApps -> main', serializableWebApps)

  try {
    await window.electronAPI.saveWebApps(serializableWebApps)
  } catch (err) {
    console.error('[web-apps] persistSavedWebApps failed', err)
    throw err
  }

  savedWebApps.value = serializableWebApps
  syncBrowserAppSavedFlags(serializableWebApps)
}

function upsertBrowserApp (app: RunningApp) {
  const nextBrowserApps = new Map(browserApps.value)
  nextBrowserApps.set(app.id, app)
  browserApps.value = nextBrowserApps
}

async function loadPinnedDockApps () {
  if (!window.electronAPI?.getPinnedDockApps) return
  pinnedDockApps.value = await window.electronAPI.getPinnedDockApps()
}

async function persistPinnedDockApps (next: PinnedDockApp[]) {
  pinnedDockApps.value = next
  if (!window.electronAPI?.savePinnedDockApps) return
  try {
    await window.electronAPI.savePinnedDockApps(next)
  } catch (err) {
    console.error('[dock] persistPinnedDockApps failed', err)
  }
}

function isDockAppPinned (app: RunningApp): boolean {
  return pinnedDockApps.value.some(pinned => pinned.id === app.id)
}

function isDockAppRunning (app: RunningApp): boolean {
  return Boolean(
    runningApps.value.get(app.id) ||
    browserApps.value.get(app.id) ||
    embeddedApps.value.has(app.id)
  )
}

async function pinAppToDock (app: RunningApp) {
  hideDockCtx()
  if (isDockAppPinned(app)) return

  const next: PinnedDockApp = {
    id: app.id,
    kind: app.kind,
    name: app.name,
    type: app.kind === 'project' ? app.type : undefined,
    icon: app.icon && app.icon !== '🌐' ? app.icon : undefined,
    url: app.kind === 'browser' ? app.url : undefined,
    addedAt: new Date().toISOString()
  }
  await persistPinnedDockApps([...pinnedDockApps.value, next])
}

async function unpinAppFromDock (app: RunningApp) {
  hideDockCtx()
  if (!isDockAppPinned(app)) return
  await persistPinnedDockApps(pinnedDockApps.value.filter(pinned => pinned.id !== app.id))
}

async function toggleDockPin (app: RunningApp) {
  if (isDockAppPinned(app)) {
    await unpinAppFromDock(app)
  } else {
    await pinAppToDock(app)
  }
}

interface BrowserAppOpenOptions {
  appId?: string
  name?: string
  icon?: string
  savedToLaunchpad?: boolean
}

function openChat () {
  appChatPresentation.value = 'full'
  currentView.value = 'chat'
  showLaunchpad.value = false
  hideDockCtx()
}

function openSettings () {
  appChatPresentation.value = 'full'
  currentView.value = 'settings'
  showLaunchpad.value = false
  hideDockCtx()
}

function openStudio () {
  appChatPresentation.value = 'full'
  currentView.value = 'studio'
  showLaunchpad.value = false
  hideDockCtx()
}

function optimizeProjectInChat (project: Record<string, unknown>) {
  chatProjectContext.value = project
  appChatPresentation.value = 'full'
  currentView.value = 'chat'
  showLaunchpad.value = false
}

function openPageChatOverlay () {
  if (currentView.value !== 'app' || !activeEmbeddedProjectId.value || !activeBrowserPageSurface.value) return
  appChatPresentation.value = 'overlay'
  hideDockCtx()
}

function collapsePageChatToBubble () {
  if (currentView.value !== 'app' || !activeEmbeddedProjectId.value || !activeBrowserPageSurface.value) return
  appChatPresentation.value = 'bubble'
}

function handleChatSurfaceStatusChange (status: ChatSurfaceStatusSummary) {
  chatSurfaceStatus.value = status
}

function toggleLaunchpad () {
  showLaunchpad.value = !showLaunchpad.value
  hideDockCtx()
}

/**
 * Open a project embedded in the main area.
 * Starts the project if not running, then shows its iframe directly.
 * Keeps other already-open embedded apps alive for instant switching.
 */
async function openEmbeddedProject (projectId: string) {
  if (!window.electronAPI) return

  showLaunchpad.value = false
  appChatPresentation.value = 'bubble'
  currentView.value = 'app'
  activeEmbeddedProjectId.value = projectId

  const existingApp = embeddedApps.value.get(projectId)
  if (existingApp?.url && !existingApp.loading) {
    const status = await getRuntimeStatus(projectId)
    if (status.status === 'running' && status.port && existingApp.projectPort === status.port) {
      return
    }
  }

  if (existingApp) {
    embeddedApps.value = new Map(embeddedApps.value).set(projectId, {
      ...existingApp,
      url: '',
      loading: true,
      projectPort: undefined
    })
  } else {
    embeddedApps.value.set(projectId, {
      url: '',
      loading: true,
      kind: 'project',
      sandbox: PROJECT_IFRAME_SANDBOX,
      projectPort: undefined
    })
  }

  try {
    let status = await getRuntimeStatus(projectId)

    if (status.status !== 'running') {
      const result = await window.electronAPI.startProject(projectId)
      const runtimeResult = result as { status?: string; port?: number }
      if (runtimeResult.status === 'running' || runtimeResult.status === 'already_running') {
        status = { status: 'running', port: runtimeResult.port }
      }
    }

    // If still not ready, poll for up to START_TIMEOUT_SECONDS
    if (!status.port) {
      for (let i = 0; i < START_TIMEOUT_SECONDS; i++) {
        await new Promise(r => setTimeout(r, 1000))
        status = await getRuntimeStatus(projectId)
        if (status.status === 'running' && status.port) break
      }
    }

    const appState = embeddedApps.value.get(projectId)
    if (appState && status.status === 'running' && status.port) {
      appState.url = buildProjectFrameUrl(status.port)
      appState.projectPort = status.port
    }

    await refreshRunningApps()
  } catch {
    // Start failed — remove the broken entry so we don't fall back to a
    // stale app.  Return to chat instead of leaving a dead placeholder.
    embeddedApps.value.delete(projectId)
    if (activeEmbeddedProjectId.value === projectId) {
      const remaining = [...embeddedApps.value.keys()]
      if (remaining.length > 0) {
        activeEmbeddedProjectId.value = remaining[remaining.length - 1]
      } else {
        activeEmbeddedProjectId.value = null
        appChatPresentation.value = 'full'
        currentView.value = 'chat'
      }
    }
  } finally {
    const appState = embeddedApps.value.get(projectId)
    if (appState) appState.loading = false
  }
}

function openWebLinkInApp (rawUrl: string, options: BrowserAppOpenOptions = {}) {
  const normalizedUrl = normalizeWebUrlInput(rawUrl)
  if (!normalizedUrl) return

  const appId = options.appId || createWebAppId(normalizedUrl)
  const existingBrowserApp = browserApps.value.get(appId)
  const reuseExistingMetadata = normalizeWebUrlInput(existingBrowserApp?.url || '') === normalizedUrl
  const appName = options.name || (reuseExistingMetadata ? existingBrowserApp?.name : undefined) || getWebAppNameFromUrl(normalizedUrl)
  const appIcon = options.icon || (reuseExistingMetadata ? existingBrowserApp?.icon : undefined) || '🌐'
  const savedToLaunchpad = options.savedToLaunchpad
    ?? (resolveSavedWebAppId({ id: appId, kind: 'browser', url: normalizedUrl }) !== null)

  upsertBrowserApp({
    id: appId,
    name: appName,
    kind: 'browser',
    type: 'browser',
    icon: appIcon,
    url: normalizedUrl,
    isWindow: false,
    closable: true,
    savedToLaunchpad
  })

  embeddedApps.value.set(appId, {
    url: normalizedUrl,
    loading: false,
    kind: 'browser',
    sandbox: BROWSER_IFRAME_SANDBOX
  })
  activeEmbeddedProjectId.value = appId
  appChatPresentation.value = 'bubble'
  currentView.value = 'app'
  showLaunchpad.value = false
  hideDockCtx()
}

function handleBrowserAppStateChange (payload: { appId: string; url: string; title: string; icon?: string }) {
  const existingApp = browserApps.value.get(payload.appId)
  if (!existingApp) return

  const normalizedUrl = normalizeWebUrlInput(payload.url) || existingApp.url || payload.url
  const nextName = payload.title?.trim() || existingApp.name || (normalizedUrl ? getWebAppNameFromUrl(normalizedUrl) : existingApp.id)
  const nextIcon = payload.icon || existingApp.icon || '🌐'
  const savedToLaunchpad = resolveSavedWebAppId({
    ...existingApp,
    url: normalizedUrl
  }) !== null

  upsertBrowserApp({
    ...existingApp,
    name: nextName,
    url: normalizedUrl,
    icon: nextIcon,
    savedToLaunchpad
  })

  const embeddedApp = embeddedApps.value.get(payload.appId)
  if (embeddedApp && embeddedApp.url !== normalizedUrl) {
    embeddedApps.value = new Map(embeddedApps.value).set(payload.appId, {
      ...embeddedApp,
      url: normalizedUrl
    })
  }
}

function showBrowserAppCtx (payload: { appId: string; x: number; y: number }) {
  const browserApp = browserApps.value.get(payload.appId)
  console.info('[web-apps] showBrowserAppCtx', {
    appId: payload.appId,
    x: payload.x,
    y: payload.y,
    found: Boolean(browserApp),
    knownAppIds: [...browserApps.value.keys()]
  })
  if (!browserApp) return

  dockCtx.value = {
    visible: true,
    x: payload.x,
    y: payload.y,
    app: browserApp
  }
}

async function openProjectSource (project: Record<string, unknown>) {
  if (project.kind === 'web') return
  const projectId = project.id as string | undefined
  if (!projectId) return
  showLaunchpad.value = false
  appChatPresentation.value = 'full'
  sourceProject.value = project
  currentView.value = 'source'
}

async function openProjectFromLaunchpad (project: Record<string, unknown>) {
  if (project.kind === 'web' && typeof project.url === 'string') {
    openWebLinkInApp(project.url, {
      appId: typeof project.id === 'string' ? project.id : undefined,
      name: typeof project.name === 'string' ? project.name : undefined,
      icon: typeof project.icon === 'string' ? project.icon : undefined,
      savedToLaunchpad: true
    })
    return
  }

  const projectId = project.id as string | undefined
  if (!projectId || !window.electronAPI) return

  const openWindows = await window.electronAPI.getOpenWindows()
  if (openWindows.includes(projectId)) {
    showLaunchpad.value = false
    await window.electronAPI.focusProjectWindow(projectId)
    return
  }

  await openEmbeddedProject(projectId)
}

async function openProjectInShell (projectId: string, mode: 'embed' | 'window' = 'embed') {
  if (!window.electronAPI) return

  showLaunchpad.value = false
  hideDockCtx()

  if (mode === 'window') {
    const openWindows = await window.electronAPI.getOpenWindows()
    if (openWindows.includes(projectId)) {
      await window.electronAPI.focusProjectWindow(projectId)
      return
    }

    const status = await getRuntimeStatus(projectId)
    if (status.status !== 'running') {
      await window.electronAPI.startProject(projectId)
    }

    await window.electronAPI.openProjectWindow(projectId)
    clearEmbeddedApp(projectId)
    await refreshRunningApps()
    return
  }

  await openEmbeddedProject(projectId)
}

async function switchToApp (app: RunningApp) {
  if (app.kind === 'browser') {
    // Already open — just focus it. Otherwise launch the pinned shortcut.
    if (embeddedApps.value.has(app.id)) {
      showLaunchpad.value = false
      appChatPresentation.value = 'bubble'
      currentView.value = 'app'
      activeEmbeddedProjectId.value = app.id
      return
    }

    if (app.url) {
      openWebLinkInApp(app.url, {
        appId: app.id,
        name: app.name,
        icon: app.icon,
        savedToLaunchpad: resolveSavedWebAppId({ id: app.id, kind: 'browser', url: app.url }) !== null
      })
    }
    return
  }

  if (app.isWindow) {
    showLaunchpad.value = false
    await window.electronAPI?.focusProjectWindow(app.id)
    return
  }

  await openEmbeddedProject(app.id)
}

function showDockCtx (e: MouseEvent, app: RunningApp) {
  e.preventDefault()
  e.stopPropagation()
  dockCtx.value = { visible: true, x: e.clientX, y: e.clientY, app }
}

function hideDockCtx () {
  dockCtx.value.visible = false
}

async function dockOpenWindow (app: RunningApp) {
  hideDockCtx()
  if (!window.electronAPI || app.kind !== 'project') return

  const status = await getRuntimeStatus(app.id)
  if (status.status !== 'running') {
    await window.electronAPI.startProject(app.id)
  }
  await window.electronAPI.openProjectWindow(app.id)

  // Remove from embedded panel; if no apps remain, switch to chat
  clearEmbeddedApp(app.id)

  await refreshRunningApps()
}

async function dockOpenSource (app: RunningApp) {
  hideDockCtx()
  if (app.kind !== 'project') return
  const project = await fetchProjectMeta(app.id)
  await openProjectSource(project)
}

async function dockOptimizeInChat (app: RunningApp) {
  hideDockCtx()
  if (app.kind !== 'project') return
  const project = await fetchProjectMeta(app.id)
  optimizeProjectInChat(project)
}

async function dockStopApp (app: RunningApp) {
  hideDockCtx()
  if (app.kind !== 'project') return
  await window.electronAPI?.stopProject(app.id)

  clearEmbeddedApp(app.id)

  await refreshRunningApps()
}

function closeDockApp (appId: string) {
  clearEmbeddedApp(appId)
}

async function saveBrowserAppToLaunchpad (app: RunningApp) {
  if (app.kind !== 'browser' || !app.url) return

  const normalizedUrl = normalizeWebUrlInput(app.url)
  if (!normalizedUrl) return

  const now = new Date().toISOString()
  const existingShortcut = savedWebApps.value.find(entry => (
    entry.id === app.id || normalizeWebUrlInput(entry.url) === normalizedUrl
  ))

  const nextShortcut: SavedWebApp = {
    id: existingShortcut?.id || createWebAppId(normalizedUrl),
    kind: 'web',
    type: 'browser',
    name: app.name || getWebAppNameFromUrl(normalizedUrl),
    url: normalizedUrl,
    icon: app.icon && app.icon !== '🌐' ? app.icon : undefined,
    createdAt: existingShortcut?.createdAt || now,
    updatedAt: now
  }

  const nextSavedWebApps = toPlainSavedWebApps([
    ...savedWebApps.value.filter(entry => {
      const entryUrl = normalizeWebUrlInput(entry.url)
      return entry.id !== nextShortcut.id && entryUrl !== normalizedUrl
    }),
    nextShortcut
  ])

  console.info('[web-apps] saveBrowserAppToLaunchpad', {
    runningAppId: app.id,
    runningAppName: app.name,
    normalizedUrl,
    nextShortcut,
    previousCount: savedWebApps.value.length,
    nextCount: nextSavedWebApps.length
  })

  await persistSavedWebApps(nextSavedWebApps)
  upsertBrowserApp({
    ...app,
    savedToLaunchpad: resolveSavedWebAppId(app, nextSavedWebApps) !== null,
    icon: nextShortcut.icon || app.icon
  })
}

async function removeBrowserAppFromLaunchpad (app: RunningApp) {
  if (app.kind !== 'browser') return

  const shortcutId = resolveSavedWebAppId(app)
  if (!shortcutId) return

  const nextSavedWebApps = toPlainSavedWebApps(savedWebApps.value.filter(entry => entry.id !== shortcutId))
  await persistSavedWebApps(nextSavedWebApps)

  upsertBrowserApp({
    ...app,
    savedToLaunchpad: resolveSavedWebAppId(app, nextSavedWebApps) !== null
  })
}

async function dockSaveBrowserApp (app: RunningApp) {
  hideDockCtx()
  console.info('[web-apps] dockSaveBrowserApp click', {
    appId: app.id,
    name: app.name,
    url: app.url,
    savedToLaunchpad: app.savedToLaunchpad
  })
  try {
    await saveBrowserAppToLaunchpad(app)
  } catch (err) {
    console.error('[web-apps] dockSaveBrowserApp failed', err)
  }
}

async function dockRemoveBrowserApp (app: RunningApp) {
  hideDockCtx()
  await removeBrowserAppFromLaunchpad(app)
}

/* ---- LAN Access modal ---- */
const lanModal = ref<{
  visible: boolean
  appName: string
  lanUrl: string | null
  proxyUrl: string
  qrDataUrl: string
  copied: boolean
}>({ visible: false, appName: '', lanUrl: null, proxyUrl: '', qrDataUrl: '', copied: false })

async function dockShowLanAccess (app: RunningApp) {
  hideDockCtx()
  if (!window.electronAPI || app.kind !== 'project') return

  const info = await window.electronAPI.getProjectLanUrl(app.id)
  const url = info.lanUrl || info.proxyUrl

  let qrDataUrl = ''
  try {
    qrDataUrl = await QRCode.toDataURL(url, { width: QR_CODE_WIDTH, margin: QR_CODE_MARGIN })
  } catch {
    // QR generation failed; modal will still show the link
  }

  lanModal.value = {
    visible: true,
    appName: app.name,
    lanUrl: info.lanUrl,
    proxyUrl: info.proxyUrl,
    qrDataUrl,
    copied: false
  }
}

async function copyLanUrl () {
  const url = lanModal.value.lanUrl || lanModal.value.proxyUrl
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
    lanModal.value.copied = true
    setTimeout(() => { lanModal.value.copied = false }, COPY_FEEDBACK_MS)
  } catch {
    // Clipboard write may fail without user gesture; ignore
  }
}

function closeLanModal () {
  lanModal.value.visible = false
}

function closeScheduledTaskReportDialog () {
  scheduledTaskReport.value = null
}

function syncEmbeddedProjectStates (projects: ProjectListItem[]) {
  const projectStatusMap = new Map(projects.map(project => [project.id, project.runtime ?? { status: 'unknown' }]))
  const nextEmbeddedApps = new Map(embeddedApps.value)
  let hasChanges = false

  for (const [appId, appState] of embeddedApps.value) {
    if (appState.kind !== 'project') continue

    const runtime = projectStatusMap.get(appId)
    if (runtime?.status === 'starting' && appState.loading) {
      continue
    }

    if (!runtime || runtime.status !== 'running' || !runtime.port) {
      // Project is no longer running — remove the embedded entry so the dock
      // doesn't silently fall back to a stale app after a startup failure.
      nextEmbeddedApps.delete(appId)
      hasChanges = true

      if (activeEmbeddedProjectId.value === appId) {
        const remaining = [...nextEmbeddedApps.keys()]
        if (remaining.length > 0) {
          activeEmbeddedProjectId.value = remaining[remaining.length - 1]
        } else {
          activeEmbeddedProjectId.value = null
          currentView.value = 'chat'
        }
      }
      continue
    }

    const nextUrl = buildProjectFrameUrl(runtime.port)
    if (appState.url !== nextUrl || appState.projectPort !== runtime.port) {
      nextEmbeddedApps.set(appId, {
        ...appState,
        url: nextUrl,
        loading: false,
        projectPort: runtime.port
      })
      hasChanges = true
    }
  }

  if (hasChanges) {
    embeddedApps.value = nextEmbeddedApps
  }
}

async function refreshRunningApps () {
  if (!window.electronAPI) return

  const refreshToken = ++runningAppsRefreshToken

  try {
    const [projects, openWindows] = await Promise.all([
      window.electronAPI.listProjects() as unknown as Promise<ProjectListItem[]>,
      window.electronAPI.getOpenWindows()
    ])

    if (refreshToken !== runningAppsRefreshToken) return

    const openSet = new Set(openWindows)
    const oldRunningApps = runningApps.value
    const nextRunningApps = new Map<string, RunningApp>()

    for (const proj of projects) {
      const id = proj.id as string
      const status = proj.runtime ?? { status: 'unknown' }
      if (status.status === 'running') {
        const existing = oldRunningApps.get(id)
        nextRunningApps.set(id, {
          id,
          name: (proj.name as string) || id,
          kind: 'project',
          type: (proj.type as string) || 'unknown',
          icon: proj.icon as string | undefined,
          port: status.port,
          isWindow: openSet.has(id) || (existing?.isWindow ?? false)
        })
      }
    }

    // Atomic replacement ensures Vue detects the change reliably
    runningApps.value = nextRunningApps
    syncEmbeddedProjectStates(projects)
  } catch {
    // ignore transient runtime errors
  }
}

function minimizeWindow () { window.electronAPI?.minimizeWindow() }
function maximizeWindow () { window.electronAPI?.maximizeWindow() }
function closeWindow () { window.electronAPI?.closeWindow() }
function onDocClickGlobal () { hideDockCtx() }

onMounted(async () => {
  // Keep the global titlebar-height token in sync with the platform-specific TitleBar height
  // (38px on macOS, 34px on Windows). Overlays anchored below the titlebar read this token.
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent
  if (/win/i.test(platform)) {
    document.documentElement.style.setProperty('--app-titlebar-height', '34px')
  }

  const savedThemePreference = await window.electronAPI?.getThemePreference?.().catch(() => 'system' as const)
  applyThemePreference(savedThemePreference || 'system')
  stopThemeWatcher = watchSystemThemeChange(() => {
    if (getAppliedThemePreference() === 'system') {
      applyThemePreference('system')
    }
  })

  if (isStandaloneProjectWindow) return

  await loadSavedWebApps()
  await loadPinnedDockApps()
  await refreshRunningApps()
  runningAppsInterval = setInterval(() => {
    void refreshRunningApps()
  }, RUNNING_APPS_REFRESH_INTERVAL_MS)
  document.addEventListener('click', onDocClickGlobal)

  if (window.electronAPI?.onProjectChanged) {
    projectChangedCleanup = window.electronAPI.onProjectChanged((event) => {
      if (event.action === 'deleted') {
        clearEmbeddedApp(event.projectId)
      }
      void refreshRunningApps()
    })
  }

  if (window.electronAPI?.onProjectWindowClosed) {
    windowClosedCleanup = window.electronAPI.onProjectWindowClosed((event) => {
      const app = runningApps.value.get(event.projectId)
      if (app) {
        // Create a new Map to trigger reliable reactive update
        const next = new Map(runningApps.value)
        const entry = next.get(event.projectId)
        if (entry) entry.isWindow = false
        runningApps.value = next
      }
    })
  }

  if (window.electronAPI?.onProjectOpenInShell) {
    projectOpenInShellCleanup = window.electronAPI.onProjectOpenInShell(({ projectId, mode }) => {
      void openProjectInShell(projectId, mode === 'window' ? 'window' : 'embed')
    })
  }

  if (window.electronAPI?.onBrowserOpenUrlInDock) {
    browserOpenInDockCleanup = window.electronAPI.onBrowserOpenUrlInDock(({ url }) => {
      openWebLinkInApp(url)
    })
  }

  if (window.electronAPI?.onScheduledTaskReportRequested) {
    schedulerReportRequestedCleanup = window.electronAPI.onScheduledTaskReportRequested((report) => {
      scheduledTaskReport.value = report
    })
  }

  if (window.electronAPI?.onPageAutomationRequest) {
    pageAutomationRequestCleanup = window.electronAPI.onPageAutomationRequest((payload) => {
      void handlePageAutomationRequest(payload)
    })
  }
})

onUnmounted(() => {
  stopThemeWatcher?.()
  if (runningAppsInterval) {
    clearInterval(runningAppsInterval)
    runningAppsInterval = null
  }

  if (isStandaloneProjectWindow) return

  document.removeEventListener('click', onDocClickGlobal)
  projectChangedCleanup?.()
  windowClosedCleanup?.()
  projectOpenInShellCleanup?.()
  browserOpenInDockCleanup?.()
  schedulerReportRequestedCleanup?.()
  pageAutomationRequestCleanup?.()
})
</script>

<template>
  <div :class="['app-root', { 'app-root-standalone': isStandaloneProjectWindow }]">
    <ProjectWindowShell v-if="standaloneProjectId" :project-id="standaloneProjectId" />

    <template v-else>
      <TitleBar
        @minimize="minimizeWindow"
        @maximize="maximizeWindow"
        @close="closeWindow"
      />

      <div class="app-layout">
        <DockBar
          :current-view="currentView"
          :show-launchpad="showLaunchpad"
          :running-apps="dockApps"
          :pinned-apps="pinnedDockItems"
          :embedded-project-id="activeEmbeddedProjectId"
          @open-chat="openChat"
          @open-studio="openStudio"
          @toggle-launchpad="toggleLaunchpad"
          @open-settings="openSettings"
          @switch-to-app="switchToApp"
          @close-app="closeDockApp"
          @context-menu="showDockCtx"
        />

        <main class="main-content">
          <!-- Embedded apps: each app keeps its iframe alive, only the active one is visible -->
          <div v-show="currentView === 'app'" class="embedded-app">
            <template v-for="[appId, appState] in embeddedApps" :key="appId">
              <div v-show="activeEmbeddedProjectId === appId" class="embedded-slot">
                <div v-if="appState.loading" class="embedded-loading">
                  <span class="embedded-spinner">⏳</span>
                  <p>{{ $t('appShell.embeddedAppStarting') }}</p>
                </div>
                <iframe
                  v-else-if="appState.kind === 'project' && appState.url"
                  :src="appState.url"
                  class="embedded-frame"
                  :sandbox="appState.sandbox"
                  :allow="PROJECT_IFRAME_ALLOW"
                  allowfullscreen
                ></iframe>
                <BrowserWebView
                  :ref="(instance) => setBrowserAutomationHandle(appId, instance)"
                  v-else-if="appState.kind === 'browser' && appState.url"
                  :app-id="appId"
                  :url="appState.url"
                  :title="browserApps.get(appId)?.name || appId"
                  :icon="browserApps.get(appId)?.icon"
                  class="embedded-browser-view"
                  @state-change="handleBrowserAppStateChange"
                  @context-menu="showBrowserAppCtx"
                />
                <div v-else class="embedded-unavailable">
                  <p>{{ $t('appShell.embeddedAppStartFailed') }}</p>
                  <button v-if="appState.kind === 'project'" class="embedded-retry-btn" @click="openEmbeddedProject(appId)">🔄 {{ $t('common.retry') }}</button>
                  <button v-else class="embedded-retry-btn" @click="openChat">{{ $t('appShell.returnToChat') }}</button>
                </div>
              </div>
            </template>
          </div>

          <div v-show="shouldMountChatShell" :class="['chat-shell', `chat-shell-${chatShellMode}`]">
            <div class="chat-shell-body">
              <div v-if="chatShellMode === 'overlay' && activeBrowserPageSurface" class="chat-overlay-banner">
                <div class="chat-overlay-banner-copy">
                  <span class="chat-overlay-kicker">{{ $t('appShell.pageOperationChat') }}</span>
                  <span class="chat-overlay-title">{{ activeBrowserPageSurface.title }}</span>
                  <span class="chat-overlay-subtitle">{{ activeBrowserPageSurface.origin || activeBrowserPageSurface.url || $t('appShell.currentAppPage') }}</span>
                </div>
                <button class="chat-overlay-collapse-btn" type="button" @click="collapsePageChatToBubble">{{ $t('appShell.collapseToBubble') }}</button>
              </div>

              <div class="chat-shell-panel">
                <ChatPanel
                  :projectContext="chatProjectContext"
                  :active-page-context="activePageAutomationContext"
                  @contextConsumed="chatProjectContext = null"
                  @open-web-link="openWebLinkInApp"
                  @status-change="handleChatSurfaceStatusChange"
                />
              </div>
            </div>
          </div>

          <FloatingTaskBubble
            v-if="showAppChatBubble && activeBrowserPageSurface"
            :is-loading="chatSurfaceStatus.isLoading || activeBrowserPageSurface.loading"
            :pending-auth-count="chatSurfaceStatus.pendingAuthCount"
            :active-todo-count="chatSurfaceStatus.activeTodoCount"
            @open="openPageChatOverlay"
          />

          <!-- Source code viewer -->
          <SourceViewer
            v-if="currentView === 'source' && sourceProject"
            :project="sourceProject"
            @back="sourceProject = null; openChat()"
          />

          <AISettings v-if="currentView === 'settings'" />

          <!-- Cached so the studio's in-memory task queue and form survive leaving
               the view (e.g. switching to a conversation); discarded only on app close. -->
          <KeepAlive>
            <ImageStudio v-if="currentView === 'studio'" />
          </KeepAlive>

          <Launchpad
            v-if="showLaunchpad"
            @select="openProjectFromLaunchpad"
            @viewSource="openProjectSource"
            @optimizeInChat="optimizeProjectInChat"
            @appStarted="refreshRunningApps()"
            @close="showLaunchpad = false"
          />
        </main>
      </div>

      <Teleport to="body">
        <div
          v-if="dockCtx.visible && dockCtx.app"
          class="dock-ctx-menu"
          :style="{ left: dockCtx.x + 'px', top: dockCtx.y + 'px' }"
          @click.stop
        >
          <template v-if="dockCtx.app?.kind === 'project'">
            <div class="dock-ctx-item" @click="dockOpenWindow(dockCtx.app!)">{{ $t('appShell.dockOpenIndependentWindow') }}</div>
            <div class="dock-ctx-item" @click="dockOpenSource(dockCtx.app!)">{{ $t('appShell.dockOpenSource') }}</div>
            <div class="dock-ctx-item" @click="dockOptimizeInChat(dockCtx.app!)">{{ $t('appShell.dockContinueOptimize') }}</div>
            <div class="dock-ctx-item" @click="dockShowLanAccess(dockCtx.app!)">{{ $t('appShell.dockLanAccess') }}</div>
            <div v-if="isDockAppRunning(dockCtx.app!)" class="dock-ctx-divider"></div>
            <div v-if="isDockAppRunning(dockCtx.app!)" class="dock-ctx-item dock-ctx-danger" @click="dockStopApp(dockCtx.app!)">{{ $t('appShell.dockStop') }}</div>
            <div class="dock-ctx-divider"></div>
            <div class="dock-ctx-item" @click="toggleDockPin(dockCtx.app!)">{{ isDockAppPinned(dockCtx.app!) ? $t('appShell.dockUnpin') : $t('appShell.dockPin') }}</div>
          </template>
          <template v-else>
            <div class="dock-ctx-item" @click="dockSaveBrowserApp(dockCtx.app!)">{{ dockCtx.app?.savedToLaunchpad ? $t('appShell.dockUpdateLaunchpadItem') : $t('appShell.dockAddToLaunchpad') }}</div>
            <div v-if="dockCtx.app?.savedToLaunchpad" class="dock-ctx-item" @click="dockRemoveBrowserApp(dockCtx.app!)">{{ $t('appShell.dockRemoveFromLaunchpad') }}</div>
            <div v-if="isDockAppRunning(dockCtx.app!)" class="dock-ctx-divider"></div>
            <div v-if="isDockAppRunning(dockCtx.app!)" class="dock-ctx-item dock-ctx-danger" @click="closeDockApp(dockCtx.app!.id)">{{ $t('appShell.dockCloseWebPage') }}</div>
            <div class="dock-ctx-divider"></div>
            <div class="dock-ctx-item" @click="toggleDockPin(dockCtx.app!)">{{ isDockAppPinned(dockCtx.app!) ? $t('appShell.dockUnpin') : $t('appShell.dockPin') }}</div>
          </template>
        </div>
      </Teleport>
      <Teleport to="body">
        <div
          v-if="lanModal.visible"
          class="lan-modal-overlay"
          @click.self="closeLanModal"
        >
          <div class="lan-modal">
            <div class="lan-modal-header">
              <span>{{ $t('appShell.lanAccessTitle', { name: lanModal.appName }) }}</span>
              <button class="lan-modal-close" @click="closeLanModal">✕</button>
            </div>
            <div class="lan-modal-body">
              <img v-if="lanModal.qrDataUrl" :src="lanModal.qrDataUrl" class="lan-qr-img" alt="QR Code" />
              <p class="lan-modal-hint">{{ $t('appShell.lanAccessHint') }}</p>
              <div class="lan-url-row">
                <code class="lan-url-text" @click="copyLanUrl">{{ lanModal.lanUrl || lanModal.proxyUrl }}</code>
                <button class="lan-copy-btn" @click="copyLanUrl">{{ lanModal.copied ? $t('appShell.copied') : $t('appShell.copy') }}</button>
              </div>
            </div>
          </div>
        </div>
      </Teleport>
      <ScheduledTaskReportDialog :report="scheduledTaskReport" @close="closeScheduledTaskReportDialog" />
    </template>
  </div>
</template>

<style scoped>
.app-root {
  --dock-accent: var(--app-accent);
  --dock-accent-soft: var(--app-accent-soft);
  --dock-accent-glow: var(--app-accent-glow);
  --dock-width: 56px;
  --app-frame-corner-radius: 16px;
  display: flex;
  flex-direction: column;
  height: 100vh;
  background:
    radial-gradient(circle at top left, var(--app-shell-tint-1), transparent 22%),
    radial-gradient(circle at bottom left, var(--app-shell-tint-2), transparent 18%),
    var(--app-shell-bg);
  color: var(--app-text);
  border-radius: 10px;
  overflow: hidden;
}

.app-root-standalone {
  border-radius: 0;
}

.app-layout {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}

/*
 * Fuse the TitleBar (window-control row) and the DockBar into one continuous
 * panel surface. The pseudo-element sits behind `.main-content` at the inner
 * corner where the two frame strips meet and fills the gap left by the rounded
 * content corner, so the panel wraps the curve seamlessly instead of meeting
 * at a hard 90° seam.
 */
.app-layout::before {
  content: '';
  position: absolute;
  top: 0;
  left: var(--dock-width);
  width: var(--app-frame-corner-radius);
  height: var(--app-frame-corner-radius);
  background: var(--app-panel);
  pointer-events: none;
}

.main-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  position: relative;
  background: var(--app-main-surface);
  border-top: 1px solid var(--app-border-strong);
  border-left: 1px solid var(--app-border-strong);
  border-top-left-radius: var(--app-frame-corner-radius);
}

.chat-shell {
  min-height: 0;
}

.chat-shell-body,
.chat-shell-panel {
  min-height: 0;
}

.chat-shell-full {
  display: flex;
  height: 100%;
  width: 100%;
}

.chat-shell-full .chat-shell-body {
  display: flex;
  min-width: 0;
  width: 100%;
}

.chat-shell-full .chat-shell-body,
.chat-shell-full .chat-shell-panel {
  flex: 1;
}

.chat-shell-full .chat-shell-panel {
  min-width: 0;
}

.chat-shell-overlay {
  position: absolute;
  inset: 0;
  z-index: 34;
  display: flex;
  padding: 18px clamp(16px, 2.6vw, 28px) 22px;
  background: color-mix(in srgb, var(--app-shell-bg) 28%, transparent);
  backdrop-filter: blur(10px);
}

.chat-shell-overlay .chat-shell-body {
  width: min(1220px, 100%);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  flex: 1;
  border: 1px solid var(--app-border-strong);
  border-radius: 24px;
  overflow: hidden;
  background:
    radial-gradient(circle at top left, var(--app-shell-tint-1), transparent 32%),
    var(--app-panel-strong);
  box-shadow: 0 28px 70px color-mix(in srgb, var(--app-shadow) 86%, transparent);
}

.chat-shell-overlay .chat-shell-panel {
  flex: 1;
  background: transparent;
}

.chat-shell-hidden {
  position: absolute;
  inset: 0;
  z-index: 18;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

.chat-shell-hidden .chat-shell-body,
.chat-shell-hidden .chat-shell-panel {
  height: 100%;
}

.chat-overlay-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--app-border);
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--app-accent-soft) 92%, transparent),
      color-mix(in srgb, var(--app-shell-tint-2) 88%, transparent)
    ),
    var(--app-panel);
}

.chat-overlay-banner-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.chat-overlay-kicker,
.chat-overlay-title,
.chat-overlay-subtitle {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-overlay-kicker {
  color: var(--app-accent-strong);
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.chat-overlay-title {
  color: var(--app-text-strong);
  font-size: 0.94rem;
  font-weight: 700;
}

.chat-overlay-subtitle {
  color: var(--app-text-muted);
  font-size: 0.78rem;
}

.chat-overlay-collapse-btn {
  flex-shrink: 0;
  padding: 9px 14px;
  border: 1px solid var(--app-border-strong);
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-strong);
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, transform 0.12s ease;
}

.chat-overlay-collapse-btn:hover {
  background: var(--app-accent-soft);
  border-color: color-mix(in srgb, var(--app-border-strong) 46%, var(--app-accent-glow));
  transform: translateY(-1px);
}

/* Embedded app view */
.embedded-app {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--app-shell-bg);
}

.embedded-slot {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.embedded-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}

.embedded-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--app-text-muted);
}

.embedded-spinner {
  font-size: 2em;
  animation: spin 1.2s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.embedded-loading p { margin: 0; font-size: 0.9em; }

.embedded-unavailable {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--app-text-faint);
}

.embedded-unavailable p { margin: 0; font-size: 0.95em; }

.embedded-retry-btn {
  padding: 8px 18px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  cursor: pointer;
  font-size: 0.85em;
  transition: all 0.12s;
}

.embedded-retry-btn:hover {
  background: rgba(56, 189, 248, 0.14);
  border-color: rgba(56, 189, 248, 0.3);
}

/* Dock context menu */
.dock-ctx-menu {
  position: fixed;
  z-index: 10000;
  background: var(--app-panel-strong);
  backdrop-filter: blur(20px);
  border: 1px solid var(--app-border);
  border-radius: 14px;
  padding: 4px 0;
  min-width: 180px;
  box-shadow: var(--app-shadow);
}

.dock-ctx-item {
  padding: 9px 16px;
  font-size: 0.85em;
  color: var(--app-text-soft);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s ease, color 0.12s ease;
}

.dock-ctx-item:hover {
  background: var(--dock-accent-soft);
  color: var(--app-text-strong);
}

.dock-ctx-item.dock-ctx-danger { color: var(--app-danger); }

.dock-ctx-item.dock-ctx-danger:hover {
  background: rgba(220, 38, 38, 0.92);
  color: #fff;
}

.dock-ctx-divider {
  height: 1px;
  background: var(--app-border);
  margin: 4px 0;
}

/* LAN Access Modal */
.lan-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 10100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
}

.lan-modal {
  background: var(--app-panel-strong);
  border: 1px solid var(--app-border);
  border-radius: 18px;
  box-shadow: var(--app-shadow);
  width: 340px;
  overflow: hidden;
}

.lan-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  font-size: 0.92em;
  font-weight: 600;
  border-bottom: 1px solid var(--app-border);
}

.lan-modal-close {
  background: none;
  border: none;
  color: var(--app-text-muted);
  font-size: 1em;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 8px;
  transition: background 0.12s;
}

.lan-modal-close:hover {
  background: var(--app-panel-muted);
  color: var(--app-text-strong);
}

.lan-modal-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 22px 18px 20px;
  gap: 14px;
}

.lan-qr-img {
  border-radius: 12px;
  background: #fff;
  padding: 6px;
}

.lan-modal-hint {
  margin: 0;
  font-size: 0.82em;
  color: var(--app-text-muted);
}

.lan-url-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

.lan-url-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.82em;
  padding: 8px 12px;
  background: var(--app-panel-muted);
  border: 1px solid var(--app-border);
  border-radius: 10px;
  color: var(--app-accent);
  cursor: pointer;
  transition: background 0.12s;
}

.lan-url-text:hover {
  background: rgba(56, 189, 248, 0.08);
}

.lan-copy-btn {
  flex-shrink: 0;
  padding: 8px 14px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  font-size: 0.82em;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.12s;
}

.lan-copy-btn:hover {
  background: var(--dock-accent-soft);
  border-color: rgba(56, 189, 248, 0.3);
}

@media (max-width: 720px) {
  .chat-shell-overlay {
    padding: 10px 10px 14px;
  }

  .chat-overlay-banner {
    align-items: flex-start;
    flex-direction: column;
  }

  .chat-overlay-collapse-btn {
    width: 100%;
  }
}
</style>
