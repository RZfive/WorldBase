<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import ChatPanel from './renderer/components/ChatPanel.vue'
import ProjectList from './renderer/components/ProjectList.vue'
import ProjectDetail from './renderer/components/ProjectDetail.vue'
import AISettings from './renderer/components/AISettings.vue'
import SkillManager from './renderer/components/SkillManager.vue'

interface RunningApp {
  id: string
  name: string
  type: string
  port?: number
  isWindow: boolean // opened in standalone window
}

const currentView = ref<string>('chat')
const selectedProject = ref<Record<string, unknown> | null>(null)
const sidebarCollapsed = ref(false)
const chatProjectContext = ref<Record<string, unknown> | null>(null)
/** Embedded project view — projectId being viewed in the main content area */
const embeddedProjectId = ref<string | null>(null)

/** Running apps registry */
const runningApps = reactive(new Map<string, RunningApp>())

let projectChangedCleanup: (() => void) | null = null
let windowClosedCleanup: (() => void) | null = null

function selectProject (project: Record<string, unknown>) {
  selectedProject.value = project
  currentView.value = 'project'
}

function optimizeProjectInChat (project: Record<string, unknown>) {
  chatProjectContext.value = project
  currentView.value = 'chat'
}

function toggleSidebar () {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

/** Switch to a running app (embedded or focus its window). */
function switchToApp (app: RunningApp) {
  if (app.isWindow) {
    window.electronAPI?.focusProjectWindow(app.id)
  } else {
    // Switch to embedded preview of this project
    const project = { id: app.id, name: app.name, type: app.type }
    selectedProject.value = project
    embeddedProjectId.value = app.id
    currentView.value = 'project'
  }
}

/** Refresh the running apps list from the runtime statuses. */
async function refreshRunningApps () {
  if (!window.electronAPI) return
  try {
    const projects = await window.electronAPI.listProjects()
    const openWindows = await window.electronAPI.getOpenWindows()
    const openSet = new Set(openWindows)

    // Check each project status
    for (const proj of projects) {
      const id = proj.id as string
      const status = await window.electronAPI.getProjectStatus(id) as { status: string; port?: number }
      if (status.status === 'running') {
        const existing = runningApps.get(id)
        runningApps.set(id, {
          id,
          name: (proj.name as string) || id,
          type: (proj.type as string) || 'unknown',
          port: status.port,
          isWindow: openSet.has(id) || (existing?.isWindow ?? false)
        })
      } else {
        runningApps.delete(id)
      }
    }
  } catch { /* ignore */ }
}

function minimizeWindow () {
  window.electronAPI?.minimizeWindow()
}

function maximizeWindow () {
  window.electronAPI?.maximizeWindow()
}

function closeWindow () {
  window.electronAPI?.closeWindow()
}

onMounted(async () => {
  await refreshRunningApps()

  // Listen for project status changes
  if (window.electronAPI?.onProjectChanged) {
    projectChangedCleanup = window.electronAPI.onProjectChanged(() => {
      refreshRunningApps()
    })
  }

  // Listen for standalone window close events
  if (window.electronAPI?.onProjectWindowClosed) {
    windowClosedCleanup = window.electronAPI.onProjectWindowClosed((event) => {
      const app = runningApps.get(event.projectId)
      if (app) {
        app.isWindow = false
      }
    })
  }
})

onUnmounted(() => {
  projectChangedCleanup?.()
  windowClosedCleanup?.()
})
</script>

<template>
  <div class="app-root">
    <!-- Custom Title Bar -->
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
      <!-- App Dock — running apps icons -->
      <div v-if="runningApps.size > 0" class="app-dock">
        <div
          v-for="[appId, app] in runningApps"
          :key="appId"
          :class="['dock-item', { 'dock-active': currentView === 'project' && embeddedProjectId === appId, 'dock-windowed': app.isWindow }]"
          :title="app.name + (app.isWindow ? ' (独立窗口)' : '') + (app.port ? ` :${app.port}` : '')"
          @click="switchToApp(app)"
        >
          <span class="dock-icon">{{ app.type === 'frontend' ? '🎨' : app.type === 'backend' ? '⚙️' : '📦' }}</span>
          <span v-if="app.isWindow" class="dock-window-badge" title="独立窗口">↗</span>
          <span class="dock-indicator"></span>
        </div>
      </div>

      <!-- Sidebar -->
      <aside :class="['sidebar', { collapsed: sidebarCollapsed }]">
        <div class="sidebar-toggle" @click="toggleSidebar">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 3h12v1.5H2zm0 4.25h12v1.5H2zm0 4.25h12v1.5H2z"/>
          </svg>
        </div>

        <nav class="sidebar-nav">
          <button
            :class="{ active: currentView === 'chat' }"
            @click="currentView = 'chat'"
            :title="sidebarCollapsed ? 'AI 对话' : ''"
          >
            <span class="nav-icon">💬</span>
            <span v-if="!sidebarCollapsed" class="nav-text">AI 对话</span>
          </button>
          <button
            :class="{ active: currentView === 'projects' }"
            @click="currentView = 'projects'"
            :title="sidebarCollapsed ? '项目管理' : ''"
          >
            <span class="nav-icon">📦</span>
            <span v-if="!sidebarCollapsed" class="nav-text">项目管理</span>
          </button>
          <button
            :class="{ active: currentView === 'skills' }"
            @click="currentView = 'skills'"
            :title="sidebarCollapsed ? 'Skill 管理' : ''"
          >
            <span class="nav-icon">🧠</span>
            <span v-if="!sidebarCollapsed" class="nav-text">Skill 管理</span>
          </button>
        </nav>

        <div class="sidebar-footer">
          <button
            :class="['settings-btn', { active: currentView === 'settings' }]"
            @click="currentView = 'settings'"
            :title="sidebarCollapsed ? 'AI 设置' : ''"
          >
            <span class="nav-icon">⚙️</span>
            <span v-if="!sidebarCollapsed" class="nav-text">设置</span>
          </button>
          <span v-if="!sidebarCollapsed" class="version">v0.1.0</span>
        </div>
      </aside>

      <!-- Main Content -->
      <main class="main-content">
        <ChatPanel v-show="currentView === 'chat'" :projectContext="chatProjectContext" @contextConsumed="chatProjectContext = null" />
        <ProjectList
          v-if="currentView === 'projects'"
          @select="selectProject"
          @optimizeInChat="optimizeProjectInChat"
        />
        <ProjectDetail
          v-if="currentView === 'project' && selectedProject"
          :project="selectedProject"
          @back="currentView = 'projects'; embeddedProjectId = null"
          @optimizeInChat="optimizeProjectInChat"
          @appStarted="refreshRunningApps()"
          @appStopped="refreshRunningApps()"
        />
        <SkillManager v-if="currentView === 'skills'" />
        <AISettings v-if="currentView === 'settings'" />
      </main>
    </div>
  </div>
</template>

<style scoped>
.app-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #0f0f10;
  color: #e4e4e7;
  border-radius: 10px;
  overflow: hidden;
}

/* Custom Title Bar */
.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 38px;
  background: #141416;
  border-bottom: 1px solid #27272a;
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
  color: #71717a;
  font-weight: 500;
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
  color: #a1a1aa;
  cursor: pointer;
  transition: all 0.12s;
}

.titlebar-btn:hover {
  background: #27272a;
  color: #e4e4e7;
}

.titlebar-btn.close:hover {
  background: #dc2626;
  color: #fff;
}

/* App Layout */
.app-layout {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* Sidebar */
.sidebar {
  width: 200px;
  background: #18181b;
  border-right: 1px solid #27272a;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: width 0.2s ease;
}

.sidebar.collapsed {
  width: 54px;
}

.sidebar-toggle {
  padding: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #71717a;
  cursor: pointer;
  transition: color 0.15s;
  border-bottom: 1px solid #27272a;
}

.sidebar-toggle:hover {
  color: #e4e4e7;
}

.sidebar-nav {
  flex: 1;
  padding: 8px 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sidebar-nav button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: #a1a1aa;
  font-size: 0.88em;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
  overflow: hidden;
}

.sidebar.collapsed .sidebar-nav button {
  justify-content: center;
  padding: 10px;
}

.sidebar-nav button:hover {
  background: #27272a;
  color: #e4e4e7;
}

.sidebar-nav button.active {
  background: #3f3f46;
  color: #ffffff;
}

.nav-icon {
  flex-shrink: 0;
  font-size: 1.1em;
  width: 22px;
  text-align: center;
}

.nav-text {
  overflow: hidden;
}

/* Sidebar Footer */
.sidebar-footer {
  padding: 8px 6px;
  border-top: 1px solid #27272a;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: stretch;
}

.settings-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: #a1a1aa;
  font-size: 0.88em;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
  overflow: hidden;
}

.sidebar.collapsed .settings-btn {
  justify-content: center;
  padding: 10px;
}

.settings-btn:hover {
  background: #27272a;
  color: #e4e4e7;
}

.settings-btn.active {
  background: #3f3f46;
  color: #ffffff;
}

.version {
  font-size: 0.7em;
  color: #3f3f46;
  text-align: center;
  padding: 2px 0;
}

/* App Dock — running apps strip */
.app-dock {
  width: 48px;
  background: #111113;
  border-right: 1px solid #27272a;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  gap: 6px;
  flex-shrink: 0;
  overflow-y: auto;
}

.dock-item {
  position: relative;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  cursor: pointer;
  background: #1e1e22;
  transition: all 0.15s;
}

.dock-item:hover {
  background: #2a2a30;
  transform: scale(1.08);
}

.dock-item.dock-active {
  background: #3f3f46;
  box-shadow: 0 0 0 2px #6366f1;
}

.dock-item.dock-windowed {
  border: 1px dashed #6366f180;
}

.dock-icon {
  font-size: 1.15em;
}

.dock-window-badge {
  position: absolute;
  top: -2px;
  right: -2px;
  font-size: 0.6em;
  background: #6366f1;
  color: #fff;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.dock-indicator {
  position: absolute;
  bottom: -3px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #22c55e;
}

/* Main Content */
.main-content {
  flex: 1;
  overflow: hidden;
}
</style>
