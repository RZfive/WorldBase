<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import QRCode from 'qrcode'

interface StatusBadge {
  text: string
  class: string
}

interface ProjectRuntime {
  status?: string
  port?: number
}

interface Project {
  id: string
  name?: string
  type?: string
  runtime?: ProjectRuntime
  [key: string]: unknown
}

interface LanUrlInfo {
  projectPort: number | null
  lanUrl: string | null
  proxyUrl: string
  lanIp: string
}

const emit = defineEmits<{
  (e: 'select', project: Project): void
  (e: 'optimizeInChat', project: Project): void
}>()

const projects = ref<Project[]>([])
const isLoading = ref(false)
const error = ref<string | null>(null)

// Context menu state
const contextMenu = ref<{ visible: boolean; x: number; y: number; project: Project | null }>({
  visible: false,
  x: 0,
  y: 0,
  project: null
})

// QR code modal state
const qrModal = ref<{ visible: boolean; url: string; projectName: string; dataUrl: string }>({
  visible: false,
  url: '',
  projectName: '',
  dataUrl: ''
})

// Project changes listener cleanup
let projectChangedCleanup: (() => void) | null = null

async function loadProjects () {
  isLoading.value = true
  error.value = null

  try {
    if (window.electronAPI) {
      projects.value = await window.electronAPI.listProjects() as Project[]
    } else {
      const res = await fetch('/api/projects')
      const data = await res.json()
      projects.value = data.projects || []
    }
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    isLoading.value = false
  }
}

function getStatusBadge (status?: string): StatusBadge {
  const badges: Record<string, StatusBadge> = {
    running: { text: '运行中', class: 'badge-green' },
    stopped: { text: '已停止', class: 'badge-gray' },
    crashed: { text: '已崩溃', class: 'badge-red' },
    starting: { text: '启动中', class: 'badge-yellow' },
    not_started: { text: '未启动', class: 'badge-gray' }
  }
  return (status ? badges[status] : undefined) || badges.not_started
}

// Context menu handlers
function showContextMenu (e: MouseEvent, project: Project) {
  e.preventDefault()
  e.stopPropagation()
  contextMenu.value = {
    visible: true,
    x: e.clientX,
    y: e.clientY,
    project
  }
}

function hideContextMenu () {
  contextMenu.value.visible = false
}

async function openSourceCode () {
  if (!contextMenu.value.project || !window.electronAPI) return
  await window.electronAPI.openProjectFolder(contextMenu.value.project.id)
  hideContextMenu()
}

function viewProjectDetail () {
  if (!contextMenu.value.project) return
  emit('select', contextMenu.value.project)
  hideContextMenu()
}

async function showQrCode () {
  if (!contextMenu.value.project || !window.electronAPI) return
  const project = contextMenu.value.project
  try {
    const lanInfo: LanUrlInfo = await window.electronAPI.getProjectLanUrl(project.id) as LanUrlInfo
    const url = lanInfo.lanUrl || lanInfo.proxyUrl
    const dataUrl = await QRCode.toDataURL(url, {
      width: 200,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    })
    qrModal.value = {
      visible: true,
      url,
      projectName: (project.name || project.id) as string,
      dataUrl
    }
  } catch (err) {
    console.error('Failed to generate QR code:', err)
  }
  hideContextMenu()
}

function closeQrModal () {
  qrModal.value.visible = false
}

async function startProject (project: Project) {
  if (!window.electronAPI) return
  try {
    await window.electronAPI.startProject(project.id)
    await loadProjects()
  } catch (err) {
    console.error('Failed to start project:', err)
  }
  hideContextMenu()
}

async function stopProject (project: Project) {
  if (!window.electronAPI) return
  try {
    await window.electronAPI.stopProject(project.id)
    await loadProjects()
  } catch (err) {
    console.error('Failed to stop project:', err)
  }
  hideContextMenu()
}

function optimizeInChat () {
  if (!contextMenu.value.project) return
  emit('optimizeInChat', contextMenu.value.project)
  hideContextMenu()
}

function handleDocumentClick () {
  hideContextMenu()
}

onMounted(() => {
  loadProjects()
  document.addEventListener('click', handleDocumentClick)

  // Listen for project changes from main process
  if (window.electronAPI?.onProjectChanged) {
    projectChangedCleanup = window.electronAPI.onProjectChanged(() => {
      loadProjects()
    })
  }
})

onUnmounted(() => {
  document.removeEventListener('click', handleDocumentClick)
  if (projectChangedCleanup) {
    projectChangedCleanup()
  }
})
</script>

<template>
  <div class="project-list">
    <div class="list-header">
      <h2>📦 项目管理</h2>
      <button class="refresh-btn" @click="loadProjects" :disabled="isLoading">
        🔄 刷新
      </button>
    </div>

    <div v-if="isLoading" class="loading-state">
      加载中...
    </div>

    <div v-else-if="error" class="error-state">
      ❌ {{ error }}
    </div>

    <div v-else-if="projects.length === 0" class="empty-state">
      <p>还没有项目</p>
      <p class="hint">在 AI 对话中要求创建一个新项目吧！</p>
    </div>

    <div v-else class="projects-grid">
      <div
        v-for="project in projects"
        :key="project.id"
        class="project-card"
        @click="emit('select', project)"
        @contextmenu="showContextMenu($event, project)"
      >
        <div class="card-header">
          <div class="project-name">{{ project.name || project.id }}</div>
          <button class="menu-btn" @click.stop="showContextMenu($event, project)" title="菜单">
            ⋮
          </button>
        </div>
        <div class="project-type">{{ project.type || 'unknown' }}</div>
        <div class="project-meta">
          <span
            :class="['status-badge', getStatusBadge(project.runtime?.status).class]"
          >
            {{ getStatusBadge(project.runtime?.status).text }}
          </span>
          <span v-if="project.runtime?.port" class="port">
            :{{ project.runtime.port }}
          </span>
        </div>
      </div>
    </div>

    <!-- Context Menu -->
    <Teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @click.stop
      >
        <div class="context-menu-item" @click="viewProjectDetail">
          📂 查看项目详情
        </div>
        <div class="context-menu-item" @click="openSourceCode">
          💻 打开源码目录
        </div>
        <div class="context-menu-divider"></div>
        <div
          v-if="contextMenu.project?.runtime?.status !== 'running'"
          class="context-menu-item"
          @click="contextMenu.project && startProject(contextMenu.project)"
        >
          ▶️ 启动项目
        </div>
        <div
          v-if="contextMenu.project?.runtime?.status === 'running'"
          class="context-menu-item"
          @click="contextMenu.project && stopProject(contextMenu.project)"
        >
          ⏹️ 停止项目
        </div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" @click="showQrCode">
          📱 生成二维码 (局域网访问)
        </div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" @click="optimizeInChat">
          💬 继续优化此应用
        </div>
      </div>
    </Teleport>

    <!-- QR Code Modal -->
    <Teleport to="body">
      <div v-if="qrModal.visible" class="qr-modal-overlay" @click="closeQrModal">
        <div class="qr-modal" @click.stop>
          <div class="qr-modal-header">
            <h3>📱 {{ qrModal.projectName }}</h3>
            <button class="qr-close-btn" @click="closeQrModal">×</button>
          </div>
          <div class="qr-modal-body">
            <div class="qr-code">
              <img v-if="qrModal.dataUrl" :src="qrModal.dataUrl" alt="QR Code" width="200" height="200" />
            </div>
            <p class="qr-url">{{ qrModal.url }}</p>
            <p class="qr-hint">扫描二维码或在局域网浏览器中打开上方地址</p>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.project-list {
  padding: 24px;
  height: 100%;
  overflow-y: auto;
}

.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.list-header h2 {
  margin: 0;
  font-size: 1.1em;
}

.refresh-btn {
  padding: 6px 12px;
  background: #27272a;
  border: 1px solid #3f3f46;
  border-radius: 6px;
  color: #e4e4e7;
  font-size: 0.8em;
  cursor: pointer;
}

.refresh-btn:hover:not(:disabled) {
  background: #3f3f46;
}

.loading-state,
.error-state,
.empty-state {
  text-align: center;
  padding: 60px 0;
  color: #71717a;
}

.hint {
  font-size: 0.85em;
  color: #52525b;
}

.projects-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 16px;
}

.project-card {
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 12px;
  padding: 20px;
  cursor: pointer;
  transition: all 0.15s;
}

.project-card:hover {
  border-color: #3b82f6;
  background: #1c1c20;
}

.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.project-name {
  font-size: 1em;
  font-weight: 600;
  margin-bottom: 4px;
  flex: 1;
}

.menu-btn {
  background: none;
  border: none;
  color: #71717a;
  font-size: 1.2em;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  border-radius: 4px;
  flex-shrink: 0;
}

.menu-btn:hover {
  background: #3f3f46;
  color: #e4e4e7;
}

.project-type {
  font-size: 0.8em;
  color: #71717a;
  margin-bottom: 12px;
}

.project-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-badge {
  font-size: 0.75em;
  padding: 2px 8px;
  border-radius: 999px;
}

.badge-green {
  background: #052e16;
  color: #4ade80;
}

.badge-gray {
  background: #27272a;
  color: #71717a;
}

.badge-red {
  background: #450a0a;
  color: #f87171;
}

.badge-yellow {
  background: #422006;
  color: #fbbf24;
}

.port {
  font-size: 0.75em;
  color: #52525b;
  font-family: monospace;
}

/* Context Menu */
.context-menu {
  position: fixed;
  z-index: 10000;
  background: #1e1e22;
  border: 1px solid #3f3f46;
  border-radius: 8px;
  padding: 4px 0;
  min-width: 200px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.context-menu-item {
  padding: 8px 16px;
  font-size: 0.85em;
  color: #e4e4e7;
  cursor: pointer;
  white-space: nowrap;
}

.context-menu-item:hover {
  background: #3b82f6;
  color: white;
}

.context-menu-divider {
  height: 1px;
  background: #3f3f46;
  margin: 4px 0;
}

/* QR Code Modal */
.qr-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10001;
}

.qr-modal {
  background: #1e1e22;
  border: 1px solid #3f3f46;
  border-radius: 12px;
  width: 340px;
  overflow: hidden;
}

.qr-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #27272a;
}

.qr-modal-header h3 {
  margin: 0;
  font-size: 1em;
}

.qr-close-btn {
  background: none;
  border: none;
  color: #71717a;
  font-size: 1.4em;
  cursor: pointer;
  line-height: 1;
}

.qr-close-btn:hover {
  color: #e4e4e7;
}

.qr-modal-body {
  padding: 24px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.qr-code {
  background: white;
  padding: 12px;
  border-radius: 8px;
}

.qr-url {
  font-size: 0.8em;
  color: #3b82f6;
  word-break: break-all;
  text-align: center;
  margin: 0;
}

.qr-hint {
  font-size: 0.75em;
  color: #71717a;
  text-align: center;
  margin: 0;
}
</style>
