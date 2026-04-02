<script setup lang="ts">
import { ref } from 'vue'
import SkillManager from './SkillManager.vue'
import ProviderPanel from './settings/ProviderPanel.vue'
import DatabaseViewer from './settings/DatabaseViewer.vue'

const activeTab = ref('ai')
</script>

<template>
  <div class="settings-panel">
    <div class="settings-header">
      <h2>⚙️ AI 设置</h2>
      <span class="settings-hint">管理多个 AI 供应商，支持 OpenAI 及兼容 API</span>
    </div>

    <div class="settings-tabs">
      <button :class="['tab-btn', { active: activeTab === 'ai' }]" @click="activeTab = 'ai'">AI 供应商</button>
      <button :class="['tab-btn', { active: activeTab === 'skills' }]" @click="activeTab = 'skills'">Skill 管理</button>
      <button :class="['tab-btn', { active: activeTab === 'db' }]" @click="activeTab = 'db'">数据库管理</button>
    </div>

    <div v-show="activeTab === 'ai'" class="settings-body">
      <ProviderPanel />
    </div>

    <div v-show="activeTab === 'skills'" class="skills-tab-body">
      <SkillManager />
    </div>

    <div v-show="activeTab === 'db'" class="db-tab-body">
      <DatabaseViewer :active="activeTab === 'db'" />
    </div>
  </div>
</template>

<style scoped>
.settings-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.settings-header {
  padding: 16px 24px;
  border-bottom: 1px solid #27272a;
}

.settings-header h2 {
  margin: 0 0 4px 0;
  font-size: 1.1em;
}

.settings-hint {
  font-size: 0.8em;
  color: #71717a;
}

.settings-tabs {
  display: flex;
  gap: 4px;
  padding: 10px 24px;
  border-bottom: 1px solid #27272a;
  background: #141416;
}

.tab-btn {
  padding: 8px 18px;
  background: transparent;
  color: #a1a1aa;
  border: 1px solid transparent;
  cursor: pointer;
  border-radius: 8px;
  font-size: 0.85em;
  transition: all 0.15s;
}

.tab-btn:hover { background: #27272a; color: #e4e4e7; }
.tab-btn.active { background: #3f3f46; color: #ffffff; border-color: #52525b; }

.settings-body {
  flex: 1;
  overflow-y: auto;
}

.skills-tab-body {
  flex: 1;
  overflow: hidden;
}

.db-tab-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
