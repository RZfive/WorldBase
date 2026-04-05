<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import TitleBar from './TitleBar.vue'
import { getProjectIcon } from '../../utils/project-icon'

interface ProjectMeta {
  id: string
  name?: string
  type?: string
  icon?: string
}

interface ProjectStatus {
  status?: string
  port?: number
}

const props = defineProps<{
  projectId: string
}>()

const START_TIMEOUT_SECONDS = 15

const project = ref<ProjectMeta | null>(null)
const iframeUrl = ref('')
const loading = ref(true)
const error = ref('')
const isMaximized = ref(false)
const frameVersion = ref(0)

let projectChangedCleanup: (() => void) | null = null

const projectTitle = computed(() => {
  return project.value?.name || props.projectId
})

const projectIcon = computed(() => {
  return getProjectIcon(project.value?.type, project.value?.icon)
})

const projectSubtitle = computed(() => {
  if (typeof project.value?.type === 'string' && project.value.type) {
    return `${project.value.type} 独立窗口`
  }
  return '独立窗口'
})

async function refreshWindowState () {
  isMaximized.value = await window.electronAPI?.isMaximized?.() ?? false
}

async function loadProjectMeta () {
  if (!window.electronAPI) return
  project.value = await window.electronAPI.getProject(props.projectId) as unknown as ProjectMeta
}

async function getRuntimeStatus () {
  if (!window.electronAPI) return { status: 'unknown' } as ProjectStatus
  return await window.electronAPI.getProjectStatus(props.projectId) as ProjectStatus
}

async function resolveProjectUrl () {
  if (!window.electronAPI) return

  loading.value = true
  error.value = ''

  try {
    await loadProjectMeta()
    let status = await getRuntimeStatus()

    if (status.status !== 'running') {
      const result = await window.electronAPI.startProject(props.projectId)
      const runtimeResult = result as { status?: string; port?: number }
      if (runtimeResult.status === 'running' || runtimeResult.status === 'already_running') {
        status = { status: 'running', port: runtimeResult.port }
      }
    }

    if (!status.port) {
      for (let index = 0; index < START_TIMEOUT_SECONDS; index++) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        status = await getRuntimeStatus()
        if (status.status === 'running' && status.port) break
      }
    }

    if (status.status === 'running' && status.port) {
      iframeUrl.value = `http://localhost:${status.port}`
      frameVersion.value += 1
    } else {
      iframeUrl.value = ''
      error.value = '应用未能在独立窗口中启动。'
    }
  } catch (err) {
    iframeUrl.value = ''
    error.value = (err as Error).message || '应用启动失败'
  } finally {
    loading.value = false
    await refreshWindowState()
  }
}

async function minimizeWindow () {
  await window.electronAPI?.minimizeWindow?.()
}

async function maximizeWindow () {
  await window.electronAPI?.maximizeWindow?.()
  await refreshWindowState()
}

async function closeWindow () {
  await window.electronAPI?.closeWindow?.()
}

onMounted(async () => {
  await resolveProjectUrl()
  projectChangedCleanup = window.electronAPI?.onProjectChanged?.((event) => {
    if (event.projectId !== props.projectId) return

    if (event.action === 'deleted') {
      void closeWindow()
      return
    }

    if (event.action === 'stopped') {
      iframeUrl.value = ''
      error.value = '应用已停止运行。'
      loading.value = false
      void loadProjectMeta()
      return
    }

    void resolveProjectUrl()
  }) ?? null
})

onUnmounted(() => {
  projectChangedCleanup?.()
})
</script>

<template>
  <div class="project-window-shell">
    <TitleBar
      :title="projectTitle"
      :icon="projectIcon"
      :subtitle="projectSubtitle"
      :is-maximized="isMaximized"
      @minimize="minimizeWindow"
      @maximize="maximizeWindow"
      @close="closeWindow"
    />

    <div class="project-window-body">
      <div v-if="loading" class="project-window-loading">
        <div class="project-window-spinner"></div>
        <p>正在连接 {{ projectTitle }}…</p>
      </div>

      <div v-else-if="error" class="project-window-error">
        <div class="project-window-error-icon">⚠️</div>
        <h3>独立窗口连接失败</h3>
        <p>{{ error }}</p>
        <button class="project-window-retry" @click="resolveProjectUrl">重新连接</button>
      </div>

      <iframe
        v-else
        :key="frameVersion"
        :src="iframeUrl"
        class="project-window-frame"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        allow="clipboard-read; clipboard-write"
      ></iframe>
    </div>
  </div>
</template>

<style scoped>
.project-window-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  background:
    radial-gradient(circle at top left, rgba(56, 189, 248, 0.1), transparent 22%),
    linear-gradient(180deg, #071019, #050a11 55%, #04080e);
}

.project-window-body {
  flex: 1;
  min-height: 0;
  position: relative;
}

.project-window-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #ffffff;
}

.project-window-loading,
.project-window-error {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: #cbd5e1;
}

.project-window-spinner {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  border: 3px solid rgba(125, 211, 252, 0.18);
  border-top-color: #38bdf8;
  animation: project-window-spin 0.9s linear infinite;
}

.project-window-loading p,
.project-window-error p,
.project-window-error h3 {
  margin: 0;
}

.project-window-error {
  padding: 24px;
  text-align: center;
}

.project-window-error-icon {
  font-size: 2.2em;
}

.project-window-retry {
  height: 42px;
  padding: 0 16px;
  border-radius: 14px;
  border: 1px solid rgba(56, 189, 248, 0.28);
  background: rgba(56, 189, 248, 0.12);
  color: #e0f2fe;
  cursor: pointer;
}

@keyframes project-window-spin {
  to { transform: rotate(360deg); }
}
</style>