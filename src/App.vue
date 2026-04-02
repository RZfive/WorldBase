<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import QRCode from 'qrcode'
import ChatPanel from './renderer/components/chat/ChatPanel.vue'
import Launchpad from './renderer/components/launchpad/Launchpad.vue'
import AISettings from './renderer/components/settings/AISettings.vue'
import SourceViewer from './renderer/components/viewer/SourceViewer.vue'
import TitleBar from './renderer/components/app/TitleBar.vue'
import DockBar from './renderer/components/app/DockBar.vue'

interface RunningApp {
  id: string
  name: string
  type: string
  port?: number
  isWindow: boolean
}

interface ProjectStatus {
  status: string
  port?: number
}

interface ProjectListItem {
  id: string
  name?: string
  type?: string
  runtime?: ProjectStatus
}

type MainView = 'chat' | 'app' | 'source' | 'settings'

interface EmbeddedAppState {
  url: string
  loading: boolean
}

/** Maximum seconds to wait for a project's port to become available after starting. */
const START_TIMEOUT_SECONDS = 15
/** QR code image dimensions. */
const QR_CODE_WIDTH = 220
const QR_CODE_MARGIN = 2
/** Duration in ms for the "copied" feedback after copying a LAN URL. */
const COPY_FEEDBACK_MS = 2000

const currentView = ref<MainView>('chat')
const chatProjectContext = ref<Record<string, unknown> | null>(null)
const embeddedApps = ref(new Map<string, EmbeddedAppState>())
const activeEmbeddedProjectId = ref<string | null>(null)
const sourceProject = ref<Record<string, unknown> | null>(null)
const showLaunchpad = ref(false)

const runningApps = ref(new Map<string, RunningApp>())

const dockCtx = ref<{ visible: boolean; x: number; y: number; app: RunningApp | null }>({
  visible: false,
  x: 0,
  y: 0,
  app: null
})

let projectChangedCleanup: (() => void) | null = null
let windowClosedCleanup: (() => void) | null = null
let runningAppsRefreshToken = 0

function clearEmbeddedProject (projectId?: string) {
  if (projectId) {
    embeddedApps.value.delete(projectId)
    if (activeEmbeddedProjectId.value === projectId) {
      // Switch to another open app, or clear
      const remaining = [...embeddedApps.value.keys()]
      activeEmbeddedProjectId.value = remaining.length > 0 ? remaining[remaining.length - 1] : null
    }
    if (embeddedApps.value.size === 0) currentView.value = 'chat'
  } else {
    embeddedApps.value.clear()
    activeEmbeddedProjectId.value = null
  }
}

async function fetchProjectMeta (projectId: string) {
  if (!window.electronAPI) return { id: projectId }
  return await window.electronAPI.getProject(projectId)
}

async function getRuntimeStatus (projectId: string) {
  if (!window.electronAPI) return { status: 'unknown' } as ProjectStatus
  return await window.electronAPI.getProjectStatus(projectId) as unknown as ProjectStatus
}

function openChat () {
  currentView.value = 'chat'
  showLaunchpad.value = false
  hideDockCtx()
}

function openSettings () {
  currentView.value = 'settings'
  showLaunchpad.value = false
  hideDockCtx()
}

function optimizeProjectInChat (project: Record<string, unknown>) {
  chatProjectContext.value = project
  currentView.value = 'chat'
  showLaunchpad.value = false
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
  currentView.value = 'app'
  activeEmbeddedProjectId.value = projectId

  // If already open, just bring it to the front
  if (embeddedApps.value.has(projectId)) return

  embeddedApps.value.set(projectId, { url: '', loading: true })

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
      appState.url = `http://localhost:${status.port}`
    }

    await refreshRunningApps()
  } catch {
    // keep the view, will show placeholder
  } finally {
    const appState = embeddedApps.value.get(projectId)
    if (appState) appState.loading = false
  }
}

async function openProjectSource (project: Record<string, unknown>) {
  const projectId = project.id as string | undefined
  if (!projectId) return
  showLaunchpad.value = false
  sourceProject.value = project
  currentView.value = 'source'
}

async function openProjectFromLaunchpad (project: Record<string, unknown>) {
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

async function switchToApp (app: RunningApp) {
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
  if (!window.electronAPI) return

  const status = await getRuntimeStatus(app.id)
  if (status.status !== 'running') {
    await window.electronAPI.startProject(app.id)
  }
  await window.electronAPI.openProjectWindow(app.id)

  // Remove from embedded panel; if no apps remain, switch to chat
  clearEmbeddedProject(app.id)

  await refreshRunningApps()
}

async function dockOpenSource (app: RunningApp) {
  hideDockCtx()
  const project = await fetchProjectMeta(app.id)
  await openProjectSource(project)
}

async function dockOptimizeInChat (app: RunningApp) {
  hideDockCtx()
  const project = await fetchProjectMeta(app.id)
  optimizeProjectInChat(project)
}

async function dockStopApp (app: RunningApp) {
  hideDockCtx()
  await window.electronAPI?.stopProject(app.id)

  clearEmbeddedProject(app.id)

  await refreshRunningApps()
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
  if (!window.electronAPI) return

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
          type: (proj.type as string) || 'unknown',
          port: status.port,
          isWindow: openSet.has(id) || (existing?.isWindow ?? false)
        })
      }
    }

    // Atomic replacement ensures Vue detects the change reliably
    runningApps.value = nextRunningApps
  } catch {
    // ignore transient runtime errors
  }
}

function minimizeWindow () { window.electronAPI?.minimizeWindow() }
function maximizeWindow () { window.electronAPI?.maximizeWindow() }
function closeWindow () { window.electronAPI?.closeWindow() }
function onDocClickGlobal () { hideDockCtx() }

onMounted(async () => {
  await refreshRunningApps()
  document.addEventListener('click', onDocClickGlobal)

  if (window.electronAPI?.onProjectChanged) {
    projectChangedCleanup = window.electronAPI.onProjectChanged((event) => {
      if (event.action === 'deleted') {
        clearEmbeddedProject(event.projectId)
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
})

onUnmounted(() => {
  document.removeEventListener('click', onDocClickGlobal)
  projectChangedCleanup?.()
  windowClosedCleanup?.()
})
</script>

<template>
  <div class="app-root">
    <TitleBar
      @minimize="minimizeWindow"
      @maximize="maximizeWindow"
      @close="closeWindow"
    />

    <div class="app-layout">
      <DockBar
        :current-view="currentView"
        :show-launchpad="showLaunchpad"
        :running-apps="runningApps"
        :embedded-project-id="activeEmbeddedProjectId"
        @open-chat="openChat"
        @toggle-launchpad="toggleLaunchpad"
        @open-settings="openSettings"
        @switch-to-app="switchToApp"
        @context-menu="showDockCtx"
      />

      <main class="main-content">
        <ChatPanel v-show="currentView === 'chat'" :projectContext="chatProjectContext" @contextConsumed="chatProjectContext = null" />

        <!-- Embedded apps: each app keeps its iframe alive, only the active one is visible -->
        <div v-show="currentView === 'app'" class="embedded-app">
          <template v-for="[appId, appState] in embeddedApps" :key="appId">
            <div v-show="activeEmbeddedProjectId === appId" class="embedded-slot">
              <div v-if="appState.loading" class="embedded-loading">
                <span class="embedded-spinner">⏳</span>
                <p>应用启动中…</p>
              </div>
              <iframe
                v-else-if="appState.url"
                :src="appState.url"
                class="embedded-frame"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                allow="clipboard-read; clipboard-write"
              ></iframe>
              <div v-else class="embedded-unavailable">
                <p>应用未能启动</p>
                <button class="embedded-retry-btn" @click="openEmbeddedProject(appId)">🔄 重试</button>
              </div>
            </div>
          </template>
        </div>

        <!-- Source code viewer -->
        <SourceViewer
          v-if="currentView === 'source' && sourceProject"
          :project="sourceProject"
          @back="sourceProject = null; currentView = 'chat'"
        />

        <AISettings v-if="currentView === 'settings'" />

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
        <div class="dock-ctx-item" @click="dockOpenWindow(dockCtx.app!)">↗️ 独立窗口打开</div>
        <div class="dock-ctx-item" @click="dockOpenSource(dockCtx.app!)">📁 打开源码</div>
        <div class="dock-ctx-item" @click="dockOptimizeInChat(dockCtx.app!)">💬 继续优化</div>
        <div class="dock-ctx-item" @click="dockShowLanAccess(dockCtx.app!)">📱 局域网访问</div>
        <div class="dock-ctx-divider"></div>
        <div class="dock-ctx-item dock-ctx-danger" @click="dockStopApp(dockCtx.app!)">⏹️ 停止</div>
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
            <span>📱 局域网访问 — {{ lanModal.appName }}</span>
            <button class="lan-modal-close" @click="closeLanModal">✕</button>
          </div>
          <div class="lan-modal-body">
            <img v-if="lanModal.qrDataUrl" :src="lanModal.qrDataUrl" class="lan-qr-img" alt="QR Code" />
            <p class="lan-modal-hint">手机扫描二维码或复制下方链接</p>
            <div class="lan-url-row">
              <code class="lan-url-text" @click="copyLanUrl">{{ lanModal.lanUrl || lanModal.proxyUrl }}</code>
              <button class="lan-copy-btn" @click="copyLanUrl">{{ lanModal.copied ? '✅ 已复制' : '📋 复制' }}</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.app-root {
  --dock-accent: #38bdf8;
  --dock-accent-soft: rgba(56, 189, 248, 0.16);
  --dock-accent-glow: rgba(56, 189, 248, 0.3);
  display: flex;
  flex-direction: column;
  height: 100vh;
  background:
    radial-gradient(circle at top left, rgba(56, 189, 248, 0.08), transparent 22%),
    radial-gradient(circle at bottom left, rgba(245, 158, 11, 0.06), transparent 18%),
    #090b0f;
  color: #e4e4e7;
  border-radius: 10px;
  overflow: hidden;
}

.app-layout {
  display: flex;
  flex: 1;
  min-height: 0;
}

.main-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  position: relative;
  background: rgba(6, 10, 16, 0.72);
}

/* Embedded app view */
.embedded-app {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #05070b;
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
  color: #94a3b8;
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
  color: #64748b;
}

.embedded-unavailable p { margin: 0; font-size: 0.95em; }

.embedded-retry-btn {
  padding: 8px 18px;
  border-radius: 10px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: rgba(255, 255, 255, 0.04);
  color: #e2e8f0;
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
  background: rgba(15, 23, 42, 0.96);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 14px;
  padding: 4px 0;
  min-width: 180px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42);
}

.dock-ctx-item {
  padding: 9px 16px;
  font-size: 0.85em;
  color: #e2e8f0;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s ease, color 0.12s ease;
}

.dock-ctx-item:hover {
  background: var(--dock-accent-soft);
  color: #f8fafc;
}

.dock-ctx-item.dock-ctx-danger { color: #fda4af; }

.dock-ctx-item.dock-ctx-danger:hover {
  background: rgba(220, 38, 38, 0.92);
  color: #fff;
}

.dock-ctx-divider {
  height: 1px;
  background: rgba(148, 163, 184, 0.14);
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
  background: rgba(15, 23, 42, 0.97);
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 18px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
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
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
}

.lan-modal-close {
  background: none;
  border: none;
  color: #94a3b8;
  font-size: 1em;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 8px;
  transition: background 0.12s;
}

.lan-modal-close:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #e2e8f0;
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
  color: #94a3b8;
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
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(148, 163, 184, 0.14);
  border-radius: 10px;
  color: #7dd3fc;
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
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: rgba(255, 255, 255, 0.04);
  color: #e2e8f0;
  font-size: 0.82em;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.12s;
}

.lan-copy-btn:hover {
  background: var(--dock-accent-soft);
  border-color: rgba(56, 189, 248, 0.3);
}
</style>
