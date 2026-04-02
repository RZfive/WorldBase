<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import ChatPanel from './renderer/components/ChatPanel.vue'
import Launchpad from './renderer/components/Launchpad.vue'
import AISettings from './renderer/components/AISettings.vue'
import SourceViewer from './renderer/components/SourceViewer.vue'

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

  try {
    const projects = await window.electronAPI.listProjects()
    const openWindows = await window.electronAPI.getOpenWindows()
    const openSet = new Set(openWindows)
    const nextIds = new Set<string>()

    for (const proj of projects) {
      const id = proj.id as string
      const status = await getRuntimeStatus(id)
      if (status.status === 'running') {
        const existing = runningApps.get(id)
        runningApps.set(id, {
          id,
          name: (proj.name as string) || id,
          type: (proj.type as string) || 'unknown',
          port: status.port,
          isWindow: openSet.has(id) || (existing?.isWindow ?? false)
        })
        nextIds.add(id)
      }
    }

    for (const id of Array.from(runningApps.keys())) {
      if (!nextIds.has(id)) runningApps.delete(id)
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
    <div class="titlebar">
      <div class="titlebar-drag">
        <span class="titlebar-title">🌍 The World</span>
      </div>
      <div class="titlebar-controls">
        <button class="titlebar-btn minimize" @click="minimizeWindow" title="最小化">
          <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="1" fill="currentColor"/></svg>
        </button>
        <button class="titlebar-btn maximize" @click="maximizeWindow" title="最大化">
          <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1"/></svg>
        </button>
        <button class="titlebar-btn close" @click="closeWindow" title="关闭">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>

    <div class="app-layout">
      <aside class="dock-bar">
        <div class="dock-top">
          <div
            :class="['dock-item', { 'dock-active': currentView === 'chat' && !showLaunchpad }]"
            title="AI 对话"
            data-tip="对话"
            @click="openChat"
          >
            <span class="dock-item-icon">💬</span>
          </div>
        </div>

        <div class="dock-apps">
          <div
            v-for="[appId, app] in runningApps"
            :key="appId"
            :class="['dock-item', 'dock-app', { 'dock-active': currentView === 'app' && embeddedProjectId === appId, 'dock-windowed': app.isWindow }]"
            :title="app.name + (app.isWindow ? ' (独立窗口)' : '')"
            :data-tip="app.name"
            @click="switchToApp(app)"
            @contextmenu="showDockCtx($event, app)"
          >
            <span class="dock-item-icon">{{ app.type === 'frontend' ? '🎨' : app.type === 'backend' ? '⚙️' : '📦' }}</span>
            <span v-if="app.isWindow" class="dock-window-badge">↗</span>
            <span class="dock-running-dot"></span>
          </div>
        </div>

        <div class="dock-bottom">
          <div
            :class="['dock-item', { 'dock-active': showLaunchpad }]"
            title="启动台"
            data-tip="启动台"
            @click="toggleLaunchpad"
          >
            <span class="dock-item-icon">🚀</span>
          </div>

          <div
            :class="['dock-item', { 'dock-active': currentView === 'settings' && !showLaunchpad }]"
            title="设置"
            data-tip="设置"
            @click="openSettings"
          >
            <span class="dock-item-icon">⚙️</span>
          </div>
        </div>
      </aside>

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
      </main>
    </div>

    <Launchpad
      v-if="showLaunchpad"
      @select="openProjectFromLaunchpad"
      @viewSource="openProjectSource"
      @optimizeInChat="optimizeProjectInChat"
      @appStarted="refreshRunningApps()"
      @close="showLaunchpad = false"
    />

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

.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 38px;
  background: rgba(15, 18, 24, 0.92);
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
  flex-shrink: 0;
  user-select: none;
}

.titlebar-drag {
  flex: 1;
  -webkit-app-region: drag;
  height: 100%;
  display: flex;
  align-items: center;
  padding-left: 16px;
}

.titlebar-title {
  font-size: 0.82em;
  color: #7dd3fc;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.titlebar-controls {
  display: flex;
  height: 100%;
  -webkit-app-region: no-drag;
}

.titlebar-btn {
  width: 46px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  transition: all 0.12s;
}

.titlebar-btn:hover { background: rgba(30, 41, 59, 0.65); color: #e2e8f0; }
.titlebar-btn.close:hover { background: #dc2626; color: #fff; }

.app-layout {
  display: flex;
  flex: 1;
  min-height: 0;
}

.dock-bar {
  width: 82px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 14px 10px 16px;
  background: linear-gradient(180deg, rgba(10, 14, 20, 0.96), rgba(7, 10, 15, 0.92));
  border-right: 1px solid rgba(148, 163, 184, 0.12);
}

.dock-top,
.dock-bottom,
.dock-apps {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}

.dock-apps {
  flex: 1;
  gap: 10px;
  padding: 8px 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.dock-apps::-webkit-scrollbar {
  width: 0;
}

.dock-bottom {
  gap: 10px;
}

.main-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  background: rgba(6, 10, 16, 0.72);
}

.dock-item {
  position: relative;
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 18px;
  cursor: pointer;
  user-select: none;
  transition: transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
  background: rgba(255, 255, 255, 0.03);
}

.dock-item:hover {
  transform: translateX(3px) scale(1.05);
  background: rgba(255, 255, 255, 0.06);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.24);
}

.dock-item:active {
  transform: translateX(1px) scale(0.98);
}

.dock-item.dock-active {
  background: var(--dock-accent-soft);
  box-shadow: inset 0 0 0 1px rgba(125, 211, 252, 0.18), 0 12px 30px rgba(0, 0, 0, 0.28);
}

.dock-item.dock-active::before {
  content: '';
  position: absolute;
  left: -6px;
  width: 3px;
  height: 24px;
  border-radius: 999px;
  background: var(--dock-accent);
  box-shadow: 0 0 10px var(--dock-accent-glow);
}

.dock-item::after {
  content: attr(data-tip);
  position: absolute;
  left: calc(100% + 12px);
  top: 50%;
  transform: translateY(-50%) translateX(-4px);
  background: rgba(15, 23, 42, 0.96);
  color: #e2e8f0;
  font-size: 0.72em;
  line-height: 1;
  white-space: nowrap;
  padding: 7px 10px;
  border-radius: 10px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.14s ease, transform 0.14s ease;
}

.dock-item:hover::after {
  opacity: 1;
  transform: translateY(-50%) translateX(0);
}

.dock-item-icon {
  font-size: 1.5em;
  line-height: 1;
  filter: drop-shadow(0 8px 12px rgba(0, 0, 0, 0.26));
}

.dock-app.dock-windowed {
  outline: 1px dashed rgba(125, 211, 252, 0.34);
  outline-offset: -2px;
}

.dock-window-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  font-size: 0.56em;
  background: var(--dock-accent);
  color: #082f49;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  font-weight: 700;
}

.dock-running-dot {
  position: absolute;
  bottom: 6px;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: #22c55e;
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.55);
}

.project-stage {
  width: 100%;
  height: 100%;
  background: #05070b;
}

.project-stage-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}

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

.embedded-loading p {
  margin: 0;
  font-size: 0.9em;
}

.embedded-unavailable {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: #64748b;
}

.embedded-unavailable p {
  margin: 0;
  font-size: 0.95em;
}

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

.project-stage-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}

.project-stage-card {
  max-width: 420px;
  padding: 28px 30px;
  border-radius: 24px;
  background: linear-gradient(180deg, rgba(15, 23, 42, 0.84), rgba(10, 15, 24, 0.92));
  border: 1px solid rgba(148, 163, 184, 0.16);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.32);
}

.project-stage-kicker {
  display: inline-block;
  font-size: 0.74em;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #7dd3fc;
  margin-bottom: 10px;
}

.project-stage-title {
  margin: 0;
  font-size: 1.4em;
  color: #f8fafc;
}

.project-stage-text {
  margin: 12px 0 0;
  color: #94a3b8;
  line-height: 1.7;
}

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

.dock-ctx-item.dock-ctx-danger {
  color: #fda4af;
}

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
