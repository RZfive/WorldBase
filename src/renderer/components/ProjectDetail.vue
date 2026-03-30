<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'

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

const props = defineProps<{
  project: Record<string, unknown>
}>()

const emit = defineEmits<{
  (e: 'back'): void
}>()

const fileTree = ref<FileTreeItem[]>([])
const selectedFile = ref<FileTreeItem | null>(null)
const fileContent = ref<string>('')
const dataSummary = ref<DataSummary | null>(null)
const isLoading = ref<boolean>(false)

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

  try {
    if (window.electronAPI) {
      fileContent.value = await window.electronAPI.readFile(props.project.id as string, file.path)
    } else {
      const res = await fetch(`/api/projects/${props.project.id}/files/${file.path}`)
      const data = await res.json()
      fileContent.value = data.content || ''
    }
  } catch (err) {
    fileContent.value = `Error: ${(err as Error).message}`
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

async function startProject () {
  isLoading.value = true
  try {
    if (window.electronAPI) {
      await window.electronAPI.startProject(props.project.id as string)
    } else {
      await fetch(`/api/projects/${props.project.id}/start`, { method: 'POST' })
    }
  } catch (err) {
    console.error('Failed to start project:', err)
  } finally {
    isLoading.value = false
  }
}

async function stopProject () {
  isLoading.value = true
  try {
    if (window.electronAPI) {
      await window.electronAPI.stopProject(props.project.id as string)
    } else {
      await fetch(`/api/projects/${props.project.id}/stop`, { method: 'POST' })
    }
  } catch (err) {
    console.error('Failed to stop project:', err)
  } finally {
    isLoading.value = false
  }
}

onMounted(() => {
  loadFileTree()
  loadDataSummary()
})

watch(() => props.project.id, () => {
  loadFileTree()
  loadDataSummary()
  selectedFile.value = null
  fileContent.value = ''
})
</script>

<template>
  <div class="project-detail">
    <div class="detail-header">
      <button class="back-btn" @click="emit('back')">← 返回</button>
      <div class="project-info">
        <h2>{{ project.name || project.id }}</h2>
        <span class="project-type">{{ project.type }}</span>
      </div>
      <div class="project-actions">
        <button @click="startProject" :disabled="isLoading" class="btn-start">
          ▶ 启动
        </button>
        <button @click="stopProject" :disabled="isLoading" class="btn-stop">
          ⏹ 停止
        </button>
      </div>
    </div>

    <div class="detail-body">
      <!-- File Tree -->
      <div class="file-explorer">
        <h3>📁 文件结构</h3>
        <div class="file-tree">
          <template v-for="item in fileTree" :key="item.path">
            <div
              :class="['tree-item', { active: selectedFile?.path === item.path }]"
              @click="openFile(item)"
            >
              {{ item.type === 'directory' ? '📁' : '📄' }}
              {{ item.name }}
            </div>
            <template v-if="item.children">
              <div
                v-for="child in item.children"
                :key="child.path"
                :class="['tree-item indent', { active: selectedFile?.path === child.path }]"
                @click="openFile(child)"
              >
                {{ child.type === 'directory' ? '📁' : '📄' }}
                {{ child.name }}
              </div>
            </template>
          </template>
        </div>
      </div>

      <!-- File Content / Data Summary -->
      <div class="content-area">
        <div v-if="selectedFile" class="file-viewer">
          <h3>📄 {{ selectedFile.path }}</h3>
          <pre class="code-block">{{ fileContent }}</pre>
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
  padding: 16px 24px;
  border-bottom: 1px solid #27272a;
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
}

.project-info h2 {
  margin: 0;
  font-size: 1.1em;
}

.project-type {
  font-size: 0.8em;
  color: #71717a;
}

.project-actions {
  display: flex;
  gap: 8px;
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

.btn-stop {
  background: #450a0a;
  color: #f87171;
}

.btn-stop:hover:not(:disabled) {
  background: #7f1d1d;
}

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

.tree-item.indent {
  padding-left: 24px;
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

.code-block {
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 8px;
  padding: 16px;
  font-size: 0.8em;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: 'Fira Code', 'Cascadia Code', monospace;
  line-height: 1.6;
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
</style>
