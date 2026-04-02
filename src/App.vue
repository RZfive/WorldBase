<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue'
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

/** Maximum seconds to wait for a project's port to become available after starting. */
const START_TIMEOUT_SECONDS = 15

const currentView = ref<MainView>('chat')
const chatProjectContext = ref<Record<string, unknown> | null>(null)
const embeddedProjectId = ref<string | null>(null)
const embeddedAppUrl = ref<string>('')
const embeddedAppLoading = ref(false)
const sourceProject = ref<Record<string, unknown> | null>(null)
const showLaunchpad = ref(false)

const runningApps = reactive(new Map<string, RunningApp>())

const dockCtx = ref<{ visible: boolean; x: number; y: number; app: RunningApp | null }>({
  visible: false,
  x: 0,
  y: 0,
  app: null
})

let projectChangedCleanup: (() => void) | null = null
let windowClosedCleanup: (() => void) | null = null
let runningAppsRefreshToken = 0

function clearEmbeddedProject () {
  embeddedProjectId.value = null
  embeddedAppUrl.value = ''
  embeddedAppLoading.value = false
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
 */
async function openEmbeddedProject (projectId: string) {
  if (!window.electronAPI) return

  showLaunchpad.value = false
  embeddedProjectId.value = projectId
  embeddedAppUrl.value = ''
  embeddedAppLoading.value = true
  currentView.value = 'app'

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

    if (status.status === 'running' && status.port) {
      embeddedAppUrl.value = `http://localhost:${status.port}`
    }

    await refreshRunningApps()
  } catch {
    // keep the view, will show placeholder
  } finally {
    embeddedAppLoading.value = false
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

  // When opened in a standalone window, base shows chat
  if (embeddedProjectId.value === app.id) {
    clearEmbeddedProject()
  }
  currentView.value = 'chat'

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

  if (embeddedProjectId.value === app.id) {
    clearEmbeddedProject()
    currentView.value = 'chat'
  }

  await refreshRunningApps()
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
    const nextRunningApps = new Map<string, RunningApp>()

    for (const proj of projects) {
      const id = proj.id as string
      const status = proj.runtime ?? { status: 'unknown' }
      if (status.status === 'running') {
        const existing = runningApps.get(id)
        nextRunningApps.set(id, {
          id,
          name: (proj.name as string) || id,
          type: (proj.type as string) || 'unknown',
          port: status.port,
          isWindow: openSet.has(id) || (existing?.isWindow ?? false)
        })
      }
    }

    runningApps.clear()
    for (const [id, app] of nextRunningApps) {
      runningApps.set(id, app)
    }
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
      if (event.action === 'deleted' && embeddedProjectId.value === event.projectId) {
        clearEmbeddedProject()
        currentView.value = 'chat'
      }
      void refreshRunningApps()
    })
  }

  if (window.electronAPI?.onProjectWindowClosed) {
    windowClosedCleanup = window.electronAPI.onProjectWindowClosed((event) => {
      const app = runningApps.get(event.projectId)
      if (app) app.isWindow = false
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
        :embedded-project-id="embeddedProjectId"
        @open-chat="openChat"
        @toggle-launchpad="toggleLaunchpad"
        @open-settings="openSettings"
        @switch-to-app="switchToApp"
        @context-menu="showDockCtx"
      />

      <main class="main-content">
        <ChatPanel v-show="currentView === 'chat'" :projectContext="chatProjectContext" @contextConsumed="chatProjectContext = null" />

        <!-- Embedded app: full-area iframe, no controls -->
        <div v-if="currentView === 'app'" class="embedded-app">
          <div v-if="embeddedAppLoading" class="embedded-loading">
            <span class="embedded-spinner">⏳</span>
            <p>应用启动中…</p>
          </div>
          <iframe
            v-else-if="embeddedAppUrl"
            :src="embeddedAppUrl"
            class="embedded-frame"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            allow="clipboard-read; clipboard-write"
          ></iframe>
          <div v-else class="embedded-unavailable">
            <p>应用未能启动</p>
            <button class="embedded-retry-btn" @click="embeddedProjectId && openEmbeddedProject(embeddedProjectId)">🔄 重试</button>
          </div>
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
        <div class="dock-ctx-divider"></div>
        <div class="dock-ctx-item dock-ctx-danger" @click="dockStopApp(dockCtx.app!)">⏹️ 停止</div>
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
</style>
