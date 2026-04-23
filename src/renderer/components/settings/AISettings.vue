<script setup lang="ts">
import { ref } from 'vue'
import SkillManager from './SkillManager.vue'
import ProviderPanel from './ProviderPanel.vue'
import DatabaseViewer from './DatabaseViewer.vue'
import GeneralSettingsPanel from './GeneralSettingsPanel.vue'
import LogCenterPanel from './LogCenterPanel.vue'
import MCPSettingsPanel from './MCPSettingsPanel.vue'
import ProcessManagerPanel from './ProcessManagerPanel.vue'
import ScheduledTasksPanel from './ScheduledTasksPanel.vue'

type CategoryId = 'general' | 'providers' | 'mcp' | 'skills' | 'scheduler' | 'logs' | 'database' | 'processes'

interface Category {
  id: CategoryId
  icon: string
  label: string
}

const categories: Category[] = [
  { id: 'general', icon: '⚙️', label: '通用设置' },
  { id: 'providers', icon: '🤖', label: '模型服务' },
  { id: 'mcp', icon: '🔌', label: 'MCP 管理' },
  { id: 'skills', icon: '✦', label: 'Skill 管理' },
  { id: 'scheduler', icon: '⏱', label: '定时任务' },
  { id: 'logs', icon: '🧾', label: '日志中心' },
  { id: 'database', icon: '🗄', label: '数据设置' },
  { id: 'processes', icon: '📊', label: '进程管理' }
]

const activeCategoryId = ref<CategoryId>('general')
</script>

<template>
  <div class="settings-root">
    <!-- Left category nav -->
    <nav class="cat-nav">
      <button
        v-for="cat in categories"
        :key="cat.id"
        :class="['cat-item', { active: activeCategoryId === cat.id }]"
        @click="activeCategoryId = cat.id"
      >
        <span class="cat-icon">{{ cat.icon }}</span>
        <span class="cat-label">{{ cat.label }}</span>
      </button>
    </nav>

    <!-- Right content -->
    <div class="cat-content">
      <GeneralSettingsPanel v-if="activeCategoryId === 'general'" />
      <ProviderPanel v-else-if="activeCategoryId === 'providers'" />
      <MCPSettingsPanel v-else-if="activeCategoryId === 'mcp'" />
      <SkillManager v-else-if="activeCategoryId === 'skills'" />
      <ScheduledTasksPanel v-else-if="activeCategoryId === 'scheduler'" />
      <LogCenterPanel v-else-if="activeCategoryId === 'logs'" />
      <DatabaseViewer v-else-if="activeCategoryId === 'database'" :active="activeCategoryId === 'database'" />
      <ProcessManagerPanel v-else-if="activeCategoryId === 'processes'" :active="activeCategoryId === 'processes'" />
    </div>
  </div>
</template>

<style scoped>
.settings-root {
  display: flex;
  height: 100%;
  background: var(--app-main-surface);
  color: var(--app-text);
}

/* ── Left category nav ── */
.cat-nav {
  width: 180px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 16px 10px;
  border-right: 1px solid var(--app-border);
  overflow-y: auto;
}

.cat-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 14px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--app-text-soft);
  font-size: 0.88em;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s, color 0.12s;
}

.cat-item:hover {
  background: var(--app-panel-subtle);
  color: var(--app-text);
}

.cat-item.active {
  background: var(--app-accent-soft);
  color: var(--app-accent);
  font-weight: 600;
}

.cat-icon {
  width: 22px;
  text-align: center;
  font-size: 1em;
  flex-shrink: 0;
}

.cat-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Right content area ── */
.cat-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
</style>
