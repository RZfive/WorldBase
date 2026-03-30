<script setup>
import { ref } from 'vue'
import ChatPanel from './renderer/components/ChatPanel.vue'
import ProjectList from './renderer/components/ProjectList.vue'
import ProjectDetail from './renderer/components/ProjectDetail.vue'

const currentView = ref('chat')
const selectedProject = ref(null)

function selectProject (project) {
  selectedProject.value = project
  currentView.value = 'project'
}
</script>

<template>
  <div class="app-layout">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <h1 class="app-title">🌍 The World</h1>
      </div>
      <nav class="sidebar-nav">
        <button
          :class="{ active: currentView === 'chat' }"
          @click="currentView = 'chat'"
        >
          💬 AI 对话
        </button>
        <button
          :class="{ active: currentView === 'projects' }"
          @click="currentView = 'projects'"
        >
          📦 项目管理
        </button>
      </nav>
      <div class="sidebar-footer">
        <span class="version">v0.1.0</span>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="main-content">
      <ChatPanel v-if="currentView === 'chat'" />
      <ProjectList
        v-else-if="currentView === 'projects'"
        @select="selectProject"
      />
      <ProjectDetail
        v-else-if="currentView === 'project'"
        :project="selectedProject"
        @back="currentView = 'projects'"
      />
    </main>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
  background: #0f0f10;
  color: #e4e4e7;
}

.sidebar {
  width: 220px;
  background: #18181b;
  border-right: 1px solid #27272a;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-header {
  padding: 20px 16px;
  border-bottom: 1px solid #27272a;
}

.app-title {
  font-size: 1.2em;
  font-weight: 700;
  margin: 0;
}

.sidebar-nav {
  flex: 1;
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sidebar-nav button {
  display: block;
  width: 100%;
  padding: 10px 12px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: #a1a1aa;
  font-size: 0.9em;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s;
}

.sidebar-nav button:hover {
  background: #27272a;
  color: #e4e4e7;
}

.sidebar-nav button.active {
  background: #3f3f46;
  color: #ffffff;
}

.sidebar-footer {
  padding: 12px 16px;
  border-top: 1px solid #27272a;
}

.version {
  font-size: 0.75em;
  color: #52525b;
}

.main-content {
  flex: 1;
  overflow: hidden;
}
</style>
