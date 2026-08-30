<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'

interface FileTreeItem {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeItem[]
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
const fileError = ref<string>('')
const isLoadingFile = ref(false)
const { t } = useI18n()

/* Expand / collapse state for directories */
const expandedDirs = ref<Set<string>>(new Set())

const flatFileTree = computed(() => flattenFileTree(fileTree.value))

function flattenFileTree (items: FileTreeItem[], depth = 0): Array<FileTreeItem & { depth: number }> {
  const flat: Array<FileTreeItem & { depth: number }> = []
  for (const item of items) {
    flat.push({ ...item, depth })
    if (item.type === 'directory' && item.children?.length && expandedDirs.value.has(item.path)) {
      flat.push(...flattenFileTree(item.children, depth + 1))
    }
  }
  return flat
}

function toggleDir (item: FileTreeItem) {
  if (item.type !== 'directory') return
  if (expandedDirs.value.has(item.path)) {
    expandedDirs.value.delete(item.path)
  } else {
    expandedDirs.value.add(item.path)
  }
}

/* Expand all top-level directories on first load */
function expandTopLevel () {
  for (const item of fileTree.value) {
    if (item.type === 'directory') expandedDirs.value.add(item.path)
  }
}

async function loadFileTree () {
  try {
    if (window.electronAPI) {
      fileTree.value = await window.electronAPI.getFileTree(props.project.id as string) as unknown as FileTreeItem[]
      expandTopLevel()
    }
  } catch {
    fileTree.value = []
  }
}

async function openFile (item: FileTreeItem) {
  if (item.type === 'directory') {
    toggleDir(item)
    return
  }
  selectedFile.value = item
  fileError.value = ''
  isLoadingFile.value = true
  try {
    if (window.electronAPI) {
      fileContent.value = await window.electronAPI.readFile(props.project.id as string, item.path)
    }
  } catch (err) {
    fileError.value = t('viewer.readFailed', { message: (err as Error).message })
    fileContent.value = ''
  } finally {
    isLoadingFile.value = false
    nextTick(highlightCode)
  }
}

/* ---- Syntax highlighting ---- */
const codeRef = ref<HTMLElement | null>(null)

function getLanguage (filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    vue: 'xml', html: 'xml', htm: 'xml', svg: 'xml',
    css: 'css', scss: 'scss', less: 'less',
    json: 'json', md: 'markdown', yaml: 'yaml', yml: 'yaml',
    py: 'python', rb: 'ruby', java: 'java', go: 'go', rs: 'rust',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    sql: 'sql', xml: 'xml', toml: 'ini', ini: 'ini',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
    swift: 'swift', kt: 'kotlin', php: 'php',
    dockerfile: 'dockerfile'
  }
  return ext ? map[ext] : undefined
}

function highlightCode () {
  if (!codeRef.value) return
  // Reset previous highlight
  codeRef.value.removeAttribute('data-highlighted')
  const lang = selectedFile.value ? getLanguage(selectedFile.value.path) : undefined
  if (lang) {
    try {
      codeRef.value.className = `language-${lang}`
      hljs.highlightElement(codeRef.value)
    } catch {
      // fall back to auto-detect
      codeRef.value.className = ''
      hljs.highlightElement(codeRef.value)
    }
  } else {
    codeRef.value.className = ''
    hljs.highlightElement(codeRef.value)
  }
}

const lineCount = computed(() => {
  if (!fileContent.value) return 0
  return fileContent.value.split('\n').length
})

onMounted(() => {
  loadFileTree()
})

watch(() => props.project.id, () => {
  loadFileTree()
  selectedFile.value = null
  fileContent.value = ''
  fileError.value = ''
  expandedDirs.value.clear()
})
</script>

<template>
  <div class="source-viewer">
    <!-- File tree sidebar -->
    <aside class="sv-sidebar">
      <div class="sv-sidebar-header">
        <button class="sv-back-btn" @click="emit('back')" :title="$t('viewer.back')">←</button>
        <span class="sv-project-name">{{ project.name || project.id }}</span>
      </div>
      <div class="sv-file-tree">
        <div
          v-for="item in flatFileTree"
          :key="item.path"
          :class="[
            'sv-tree-item',
            { 'sv-active': selectedFile?.path === item.path, 'sv-dir': item.type === 'directory' }
          ]"
          :style="{ paddingLeft: `${12 + item.depth * 16}px` }"
          @click="openFile(item)"
        >
          <span class="sv-tree-icon">
            <template v-if="item.type === 'directory'">{{ expandedDirs.has(item.path) ? '📂' : '📁' }}</template>
            <template v-else>📄</template>
          </span>
          <span class="sv-tree-name">{{ item.name }}</span>
        </div>
        <div v-if="flatFileTree.length === 0" class="sv-tree-empty">{{ $t('viewer.noFiles') }}</div>
      </div>
    </aside>

    <!-- Code panel -->
    <main class="sv-code-panel">
      <template v-if="selectedFile">
        <div class="sv-file-header">
          <span class="sv-file-path">{{ selectedFile.path }}</span>
          <span v-if="lineCount > 0" class="sv-line-info">{{ $t('viewer.lineCount', { count: lineCount }) }}</span>
        </div>
        <div v-if="fileError" class="sv-error">{{ fileError }}</div>
        <div v-else-if="isLoadingFile" class="sv-loading">{{ $t('common.loading') }}</div>
        <div v-else class="sv-code-wrapper">
          <div class="sv-line-numbers" aria-hidden="true">
            <span v-for="n in lineCount" :key="n">{{ n }}</span>
          </div>
          <pre class="sv-pre"><code ref="codeRef">{{ fileContent }}</code></pre>
        </div>
      </template>
      <div v-else class="sv-placeholder">
        <div class="sv-placeholder-icon">💻</div>
        <p>{{ $t('viewer.selectFile') }}</p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.source-viewer {
  display: flex;
  height: 100%;
  background: #0a0c10;
  color: #e4e4e7;
}

/* ---- Sidebar ---- */
.sv-sidebar {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid rgba(148, 163, 184, 0.12);
  background: rgba(10, 14, 20, 0.96);
}

.sv-sidebar-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.10);
  flex-shrink: 0;
}

.sv-back-btn {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(148, 163, 184, 0.14);
  color: #94a3b8;
  cursor: pointer;
  font-size: 0.9em;
  transition: all 0.12s;
}
.sv-back-btn:hover {
  background: rgba(56, 189, 248, 0.14);
  color: #e2e8f0;
}

.sv-project-name {
  font-size: 0.85em;
  font-weight: 600;
  color: #7dd3fc;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sv-file-tree {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
}

.sv-file-tree::-webkit-scrollbar { width: 4px; }
.sv-file-tree::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.18); border-radius: 4px; }

.sv-tree-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  font-size: 0.82em;
  cursor: pointer;
  color: #cbd5e1;
  transition: background 0.1s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sv-tree-item:hover { background: rgba(255, 255, 255, 0.04); }
.sv-tree-item.sv-active { background: rgba(56, 189, 248, 0.12); color: #f8fafc; }
.sv-tree-item.sv-dir { color: #94a3b8; }
.sv-tree-icon { font-size: 0.9em; flex-shrink: 0; }
.sv-tree-name { overflow: hidden; text-overflow: ellipsis; }
.sv-tree-empty { padding: 24px 16px; color: #475569; text-align: center; font-size: 0.82em; }

/* ---- Code panel ---- */
.sv-code-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.sv-file-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.10);
  flex-shrink: 0;
  background: rgba(15, 23, 42, 0.6);
}

.sv-file-path {
  font-size: 0.8em;
  color: #94a3b8;
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
}

.sv-line-info {
  font-size: 0.72em;
  color: #475569;
}

.sv-error {
  padding: 16px;
  color: #fda4af;
  font-size: 0.85em;
}

.sv-loading {
  padding: 16px;
  color: #64748b;
  font-size: 0.85em;
}

.sv-code-wrapper {
  flex: 1;
  display: flex;
  overflow: auto;
  background: #0d1117;
}

.sv-code-wrapper::-webkit-scrollbar { width: 6px; height: 6px; }
.sv-code-wrapper::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.18); border-radius: 4px; }
.sv-code-wrapper::-webkit-scrollbar-corner { background: transparent; }

.sv-line-numbers {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  padding: 16px 12px 16px 16px;
  background: rgba(13, 17, 23, 0.95);
  border-right: 1px solid rgba(148, 163, 184, 0.08);
  user-select: none;
  flex-shrink: 0;
  position: sticky;
  left: 0;
  z-index: 1;
}

.sv-line-numbers span {
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  font-size: 0.78em;
  line-height: 1.6;
  color: #3b4252;
  min-width: 2.5em;
  text-align: right;
}

.sv-pre {
  margin: 0;
  padding: 16px;
  flex: 1;
  overflow: visible;
  background: transparent !important;
}

.sv-pre code {
  font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
  font-size: 0.82em;
  line-height: 1.6;
  background: transparent !important;
  padding: 0 !important;
}

/* ---- Placeholder ---- */
.sv-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #475569;
}

.sv-placeholder-icon {
  font-size: 2.4em;
  opacity: 0.5;
}

.sv-placeholder p {
  margin: 0;
  font-size: 0.9em;
}
</style>
