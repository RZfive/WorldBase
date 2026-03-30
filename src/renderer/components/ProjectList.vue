<script setup>
import { ref, onMounted } from 'vue'

const emit = defineEmits(['select'])

const projects = ref([])
const isLoading = ref(false)
const error = ref(null)

async function loadProjects () {
  isLoading.value = true
  error.value = null

  try {
    if (window.electronAPI) {
      projects.value = await window.electronAPI.listProjects()
    } else {
      const res = await fetch('/api/projects')
      const data = await res.json()
      projects.value = data.projects || []
    }
  } catch (err) {
    error.value = err.message
  } finally {
    isLoading.value = false
  }
}

function getStatusBadge (status) {
  const badges = {
    running: { text: '运行中', class: 'badge-green' },
    stopped: { text: '已停止', class: 'badge-gray' },
    crashed: { text: '已崩溃', class: 'badge-red' },
    starting: { text: '启动中', class: 'badge-yellow' },
    not_started: { text: '未启动', class: 'badge-gray' }
  }
  return badges[status] || badges.not_started
}

onMounted(() => {
  loadProjects()
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
      >
        <div class="project-name">{{ project.name || project.id }}</div>
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

.project-name {
  font-size: 1em;
  font-weight: 600;
  margin-bottom: 4px;
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
</style>
