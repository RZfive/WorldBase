<script setup lang="ts">
import { ref, onMounted, watch, onUnmounted, computed } from 'vue'

interface FileTreeItem {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeItem[]
}

interface DataSummary {
  hasData?: boolean
  tables?: Array<{ name: string; rowCount: number }>
}

interface ProjectStatus {
  status: string
  port?: number
}

const props = defineProps<{
  project: Record<string, unknown>
  defaultTab?: 'preview' | 'files'
}>()

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'optimizeInChat', project: Record<string, unknown>): void
  (e: 'appStarted'): void
  (e: 'appStopped'): void
}>()

const fileTree = ref<FileTreeItem[]>([])
const selectedFile = ref<FileTreeItem | null>(null)
const fileContent = ref<string>('')
const editorContent = ref<string>('')
const dataSummary = ref<DataSummary | null>(null)
const isLoading = ref<boolean>(false)
const isSaving = ref<boolean>(false)
const projectStatus = ref<ProjectStatus>({ status: 'not_started' })
const previewUrl = ref<string>('')
const activeTab = ref<'preview' | 'files'>(props.defaultTab ?? 'preview')
const startError = ref<string>('')
const fileError = ref<string>('')
const saveMessage = ref<string>('')
const showLaunchPicker = ref<boolean>(false)
const launchMode = ref<'embed' | 'window'>('embed')
const isStandaloneOpen = ref<boolean>(false)

let statusInterval: ReturnType<typeof setInterval> | null = null
let projectChangedCleanup: (() => void) | null = null

const flatFileTree = computed(() => flattenFileTree(fileTree.value))
const isDirty = computed(() => selectedFile.value?.type === 'file' && editorContent.value !== fileContent.value)

function flattenFileTree (items: FileTreeItem[], depth = 0): Array<FileTreeItem & { depth: number }> {
  const flat: Array<FileTreeItem & { depth: number }> = []
  for (const item of items) {
    flat.push({ ...item, depth })
    if (item.children?.length) {
      flat.push(...flattenFileTree(item.children, depth + 1))
    }
  }
  return flat
}

async function refreshStatus () {
  try {
    if (window.electronAPI) {
      const status = await window.electronAPI.getProjectStatus(props.project.id as string) as unknown as ProjectStatus
      projectStatus.value = status
      if (status.status === 'running' && status.port) {
        previewUrl.value = `http://localhost:${status.port}`
      } else {
        previewUrl.value = ''
      }
    }
  } catch {
    // ignore
  }
}

async function loadFileTree () {
  try {
    if (window.electronAPI) {
      fileTree.value = await window.electronAPI.getFileTree(props.project.id as string) as unknown as FileTreeItem[]
    } else {
      const res = await fetch(`/api/projects/${props.project.id}/files`)
      const data = await res.json()
      fileTree.value = data.files || []
    }
  } catch {
    fileTree.value = []
  }
}

async function openFile (file: FileTreeItem) {
  if (file.type !== 'file') return
  selectedFile.value = file
  fileError.value = ''
  saveMessage.value = ''

  try {
    if (window.electronAPI) {
      fileContent.value = await window.electronAPI.readFile(props.project.id as string, file.path)
      editorContent.value = fileContent.value
    } else {
      const res = await fetch(`/api/projects/${props.project.id}/files/${file.path}`)
      const data = await res.json()
      fileContent.value = data.content || ''
      editorContent.value = fileContent.value
    }
  } catch (err) {
    fileError.value = `读取失败：${(err as Error).message}`
    fileContent.value = ''
    editorContent.value = ''
  }
}

async function saveFile () {
  if (!selectedFile.value || selectedFile.value.type !== 'file' || !window.electronAPI || !isDirty.value) return
  isSaving.value = true
  fileError.value = ''
  saveMessage.value = ''
  try {
    await window.electronAPI.writeFile(props.project.id as string, selectedFile.value.path, editorContent.value)
    fileContent.value = editorContent.value
    saveMessage.value = '已保存'
  } catch (err) {
    fileError.value = `保存失败：${(err as Error).message}`
  } finally {
    isSaving.value = false
  }
}

async function loadDataSummary () {
  try {
    if (window.electronAPI) {
      dataSummary.value = await window.electronAPI.getDataSummary(props.project.id as string) as DataSummary
    } else {
      const res = await fetch(`/api/projects/${props.project.id}/data/summary`)
      dataSummary.value = await res.json()
    }
  } catch {
    dataSummary.value = null
  }
}

/** Show launch mode picker before starting */
function requestStart () {
  showLaunchPicker.value = true
}

/** Start the project with the selected launch mode. */
async function startProject (mode: 'embed' | 'window') {
  showLaunchPicker.value = false
  launchMode.value = mode
  isLoading.value = true
  startError.value = ''

  // Remember user preference
  try { window.electronAPI?.saveLaunchMode(props.project.id as string, mode) } catch { /* ignore */ }

  try {
    if (window.electronAPI) {
      const result = await window.electronAPI.startProject(props.project.id as string) as Record<string, unknown>
      if (result.status === 'running' || result.status === 'already_running') {
        await refreshStatus()
        if (mode === 'window' && previewUrl.value) {
          // Open in standalone window
          await window.electronAPI.openProjectWindow(
            props.project.id as string
          )
          isStandaloneOpen.value = true
        } else {
          activeTab.value = 'preview'
        }
        emit('appStarted')
      } else if (result.status === 'no_backend') {
        startError.value = '无法检测项目启动方式，请确保项目包含 package.json 或 index.html'
      }
      await refreshStatus()
    }
  } catch (err) {
    startError.value = `启动失败: ${(err as Error).message}`
    console.error('Failed to start project:', err)
  } finally {
    isLoading.value = false
  }
}

async function stopProject () {
  isLoading.value = true
  startError.value = ''
  try {
    if (window.electronAPI) {
      await window.electronAPI.stopProject(props.project.id as string)
      isStandaloneOpen.value = false
      await refreshStatus()
      emit('appStopped')
    }
  } catch (err) {
    console.error('Failed to stop project:', err)
  } finally {
    isLoading.value = false
  }
}

function reloadPreview () {
  // Force reload by toggling the URL
  const url = previewUrl.value
  previewUrl.value = ''
  setTimeout(() => { previewUrl.value = url }, 50)
}

function focusStandaloneWindow () {
  window.electronAPI?.focusProjectWindow(props.project.id as string)
}

onMounted(async () => {
  loadFileTree()
  loadDataSummary()
  refreshStatus()

  // Load saved launch mode preference
  if (window.electronAPI?.getLaunchMode) {
    try {
      const saved = await window.electronAPI.getLaunchMode(props.project.id as string)
      launchMode.value = (saved as 'embed' | 'window') || 'embed'
    } catch { /* ignore */ }
  }

  // Check if this project already has a standalone window
  if (window.electronAPI?.getOpenWindows) {
    try {
      const wins = await window.electronAPI.getOpenWindows()
      isStandaloneOpen.value = wins.includes(props.project.id as string)
    } catch { /* ignore */ }
  }

  // Poll status every 3 seconds
  statusInterval = setInterval(refreshStatus, 3000)

  if (window.electronAPI?.onProjectChanged) {
    projectChangedCleanup = window.electronAPI.onProjectChanged(() => {
      refreshStatus()
    })
  }
})

onUnmounted(() => {
  if (statusInterval) clearInterval(statusInterval)
  if (projectChangedCleanup) projectChangedCleanup()
})

watch(() => props.project.id, () => {
  loadFileTree()
  loadDataSummary()
  refreshStatus()
  activeTab.value = props.defaultTab ?? 'preview'
  selectedFile.value = null
  fileContent.value = ''
  editorContent.value = ''
  startError.value = ''
  fileError.value = ''
  saveMessage.value = ''
})

watch(() => props.defaultTab, (tab) => {
  activeTab.value = tab ?? 'preview'
})
</script>

<template>
  <div class="project-detail">
    <div class="detail-header">
      <button class="back-btn" @click="emit('back')">← 返回</button>
      <div class="project-info">
        <h2>{{ project.name || project.id }}</h2>
        <span class="project-type">{{ project.type }}</span>
        <span
          :class="['status-indicator', projectStatus.status === 'running' ? 'status-running' : 'status-stopped']"
        >
          {{ projectStatus.status === 'running' ? '● 运行中' : '○ 未运行' }}
          <template v-if="projectStatus.port">:{{ projectStatus.port }}</template>
        </span>
      </div>
      <div class="project-actions">
        <div class="tab-switcher">
          <button
            :class="['tab-btn', { active: activeTab === 'preview' }]"
            @click="activeTab = 'preview'"
          >
            🖥 预览
          </button>
          <button
            :class="['tab-btn', { active: activeTab === 'files' }]"
            @click="activeTab = 'files'"
          >
            📁 文件
          </button>
        </div>
        <button
          v-if="projectStatus.status !== 'running'"
          @click="requestStart"
          :disabled="isLoading"
          class="btn-start"
        >
          {{ isLoading ? '⏳ 启动中...' : '▶ 启动' }}
        </button>
        <button
          v-else
          @click="stopProject"
          :disabled="isLoading"
          class="btn-stop"
        >
          ⏹ 停止
        </button>
        <button
          v-if="projectStatus.status === 'running'"
          @click="reloadPreview"
          class="btn-reload"
          title="刷新预览"
        >
          🔄
        </button>
        <button @click="emit('optimizeInChat', props.project)" class="btn-optimize">
          💬 优化
        </button>
      </div>
    </div>

    <!-- Error banner -->
    <div v-if="startError" class="error-banner">
      ⚠️ {{ startError }}
      <button class="error-close" @click="startError = ''">×</button>
    </div>

    <!-- Standalone window notice -->
    <div v-if="isStandaloneOpen && projectStatus.status === 'running'" class="standalone-banner">
      ↗ 此应用已在独立窗口中打开
      <button class="standalone-focus-btn" @click="focusStandaloneWindow">切换到窗口</button>
    </div>

    <!-- Launch mode picker -->
    <div v-if="showLaunchPicker" class="launch-picker-overlay" @click.self="showLaunchPicker = false">
      <div class="launch-picker">
        <h3>选择启动方式</h3>
        <div class="launch-options">
          <button class="launch-option" :class="{ preferred: launchMode === 'embed' }" @click="startProject('embed')">
            <span class="launch-option-icon">🖥</span>
            <span class="launch-option-label">应用内打开</span>
            <span class="launch-option-desc">在预览区域显示</span>
          </button>
          <button class="launch-option" :class="{ preferred: launchMode === 'window' }" @click="startProject('window')">
            <span class="launch-option-icon">↗</span>
            <span class="launch-option-label">独立窗口打开</span>
            <span class="launch-option-desc">新建浏览器窗口</span>
          </button>
        </div>
        <p class="launch-hint">上次选择的方式已高亮</p>
      </div>
    </div>

    <!-- Preview Tab -->
    <div v-if="activeTab === 'preview'" class="preview-area">
      <div v-if="projectStatus.status === 'running' && previewUrl" class="preview-frame-wrapper">
        <iframe
          :src="previewUrl"
          class="preview-frame"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          allow="clipboard-read; clipboard-write"
        ></iframe>
      </div>
      <div v-else class="preview-placeholder">
        <div class="placeholder-content">
          <div class="placeholder-icon">🖥</div>
          <p v-if="isLoading">⏳ 项目启动中，请稍候...</p>
          <template v-else>
            <p>项目未运行</p>
            <p class="placeholder-hint">点击「▶ 启动」按钮运行项目，预览将在此处显示</p>
            <button class="btn-start-large" @click="requestStart" :disabled="isLoading">
              ▶ 启动项目
            </button>
          </template>
        </div>
      </div>
    </div>

    <!-- Files Tab -->
    <div v-if="activeTab === 'files'" class="detail-body">
      <!-- File Tree -->
      <div class="file-explorer">
        <h3>📁 文件结构</h3>
        <div class="file-tree">
          <template v-for="item in flatFileTree" :key="item.path">
            <div
              :class="['tree-item', `depth-${item.depth}`, { active: selectedFile?.path === item.path, 'tree-dir': item.type === 'directory' }]"
              :style="{ paddingLeft: `${8 + item.depth * 18}px` }"
              @click="openFile(item)"
            >
              {{ item.type === 'directory' ? '📁' : '📄' }}
              {{ item.name }}
            </div>
          </template>
        </div>
      </div>

      <!-- File Content / Data Summary -->
      <div class="content-area">
        <div v-if="selectedFile" class="file-viewer">
          <div class="file-toolbar">
            <h3>📄 {{ selectedFile.path }}</h3>
            <div class="file-actions">
              <span v-if="fileError" class="file-status file-error">{{ fileError }}</span>
              <span v-else-if="saveMessage" class="file-status file-success">{{ saveMessage }}</span>
              <span v-else-if="isDirty" class="file-status">未保存</span>
              <button class="btn-save" :disabled="!isDirty || isSaving" @click="saveFile">
                {{ isSaving ? '保存中...' : '保存' }}
              </button>
            </div>
          </div>
          <textarea
            v-model="editorContent"
            class="code-editor"
            spellcheck="false"
            @keydown.meta.s.prevent="saveFile"
            @keydown.ctrl.s.prevent="saveFile"
          ></textarea>
        </div>

        <div v-else-if="dataSummary?.hasData" class="data-summary">
          <h3>📊 数据概览</h3>
          <div class="summary-cards">
            <div
              v-for="table in dataSummary.tables"
              :key="table.name"
              class="summary-card"
            >
              <div class="table-name">{{ table.name }}</div>
              <div class="row-count">{{ table.rowCount }} 条记录</div>
            </div>
          </div>
        </div>

        <div v-else class="empty-content">
          <p>选择左侧文件查看内容</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.project-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 24px;
  border-bottom: 1px solid #27272a;
  flex-shrink: 0;
}

.back-btn {
  padding: 6px 12px;
  background: #27272a;
  border: 1px solid #3f3f46;
  border-radius: 6px;
  color: #e4e4e7;
  cursor: pointer;
  font-size: 0.85em;
}

.project-info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
}

.project-info h2 {
  margin: 0;
  font-size: 1.1em;
}

.project-type {
  font-size: 0.8em;
  color: #71717a;
}

.status-indicator {
  font-size: 0.75em;
  padding: 2px 8px;
  border-radius: 999px;
}

.status-running {
  background: #052e16;
  color: #4ade80;
}

.status-stopped {
  background: #27272a;
  color: #71717a;
}

.project-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.tab-switcher {
  display: flex;
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 6px;
  overflow: hidden;
  margin-right: 8px;
}

.tab-btn {
  padding: 5px 12px;
  border: none;
  background: transparent;
  color: #71717a;
  font-size: 0.8em;
  cursor: pointer;
  transition: all 0.12s;
}

.tab-btn.active {
  background: #3f3f46;
  color: #e4e4e7;
}

.tab-btn:hover:not(.active) {
  color: #a1a1aa;
}

.btn-start, .btn-stop {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  font-size: 0.8em;
  cursor: pointer;
}

.btn-start {
  background: #052e16;
  color: #4ade80;
}

.btn-start:hover:not(:disabled) {
  background: #064e3b;
}

.btn-start:disabled {
  opacity: 0.6;
  cursor: wait;
}

.btn-stop {
  background: #450a0a;
  color: #f87171;
}

.btn-stop:hover:not(:disabled) {
  background: #7f1d1d;
}

.btn-reload {
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: #27272a;
  color: #e4e4e7;
  font-size: 0.8em;
  cursor: pointer;
}

.btn-reload:hover {
  background: #3f3f46;
}

.btn-optimize {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  font-size: 0.8em;
  cursor: pointer;
  background: #1e3a5f;
  color: #60a5fa;
}

.btn-optimize:hover {
  background: #1e40af;
}

/* Error banner */
.error-banner {
  padding: 8px 24px;
  background: #450a0a;
  color: #fca5a5;
  font-size: 0.85em;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.error-close {
  background: none;
  border: none;
  color: #fca5a5;
  font-size: 1.2em;
  cursor: pointer;
  padding: 0 4px;
}

/* Preview area */
.preview-area {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.preview-frame-wrapper {
  flex: 1;
  background: #fff;
}

.preview-frame {
  width: 100%;
  height: 100%;
  border: none;
}

.preview-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.placeholder-content {
  text-align: center;
  color: #52525b;
}

.placeholder-icon {
  font-size: 3em;
  margin-bottom: 16px;
  opacity: 0.5;
}

.placeholder-hint {
  font-size: 0.85em;
  color: #3f3f46;
  margin-top: 4px;
}

.btn-start-large {
  margin-top: 20px;
  padding: 10px 28px;
  border: none;
  border-radius: 8px;
  background: #052e16;
  color: #4ade80;
  font-size: 0.95em;
  cursor: pointer;
  transition: background 0.12s;
}

.btn-start-large:hover:not(:disabled) {
  background: #064e3b;
}

.btn-start-large:disabled {
  opacity: 0.6;
  cursor: wait;
}

/* Files tab */
.detail-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.file-explorer {
  width: 260px;
  border-right: 1px solid #27272a;
  padding: 16px;
  overflow-y: auto;
  flex-shrink: 0;
}

.file-explorer h3 {
  font-size: 0.9em;
  margin: 0 0 12px 0;
}

.tree-item {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 0.8em;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-item:hover {
  background: #27272a;
}

.tree-item.active {
  background: #3f3f46;
}

.tree-item.tree-dir {
  color: #a1a1aa;
}

.content-area {
  flex: 1;
  padding: 16px 24px;
  overflow-y: auto;
}

.content-area h3 {
  font-size: 0.9em;
  margin: 0 0 12px 0;
}

.file-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.file-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.file-status {
  font-size: 0.78em;
  color: #a1a1aa;
}

.file-status.file-error {
  color: #fca5a5;
}

.file-status.file-success {
  color: #86efac;
}

.btn-save {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  background: #0f766e;
  color: #ecfeff;
  font-size: 0.8em;
  cursor: pointer;
}

.btn-save:hover:not(:disabled) {
  background: #0d9488;
}

.btn-save:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.code-editor {
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 8px;
  padding: 16px;
  color: #e4e4e7;
  font-size: 0.8em;
  width: 100%;
  min-height: 520px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: 'Fira Code', 'Cascadia Code', monospace;
  line-height: 1.6;
  resize: vertical;
}

.code-editor:focus {
  outline: 1px solid #38bdf8;
  border-color: #38bdf8;
}

.summary-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}

.summary-card {
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 8px;
  padding: 16px;
}

.table-name {
  font-weight: 600;
  margin-bottom: 4px;
}

.row-count {
  font-size: 0.8em;
  color: #71717a;
}

.empty-content {
  text-align: center;
  padding: 60px 0;
  color: #52525b;
}

/* Standalone banner */
.standalone-banner {
  padding: 8px 24px;
  background: #1e1b4b;
  color: #a5b4fc;
  font-size: 0.85em;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.standalone-focus-btn {
  padding: 4px 12px;
  background: #6366f1;
  color: #fff;
  border: none;
  border-radius: 5px;
  font-size: 0.82em;
  cursor: pointer;
}

.standalone-focus-btn:hover {
  background: #4f46e5;
}

/* Launch mode picker */
.launch-picker-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.launch-picker {
  background: #1e1e22;
  border: 1px solid #3f3f46;
  border-radius: 14px;
  padding: 24px 28px;
  min-width: 360px;
  text-align: center;
}

.launch-picker h3 {
  margin: 0 0 18px 0;
  font-size: 1.05em;
  color: #f4f4f5;
}

.launch-options {
  display: flex;
  gap: 12px;
}

.launch-option {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 18px 14px;
  background: #27272a;
  border: 2px solid #3f3f46;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s;
  color: #e4e4e7;
}

.launch-option:hover {
  border-color: #6366f1;
  background: #2a2a30;
}

.launch-option.preferred {
  border-color: #6366f180;
  background: #1e1b4b40;
}

.launch-option-icon {
  font-size: 1.6em;
}

.launch-option-label {
  font-size: 0.9em;
  font-weight: 500;
}

.launch-option-desc {
  font-size: 0.75em;
  color: #71717a;
}

.launch-hint {
  margin: 14px 0 0;
  font-size: 0.72em;
  color: #52525b;
}
</style>
