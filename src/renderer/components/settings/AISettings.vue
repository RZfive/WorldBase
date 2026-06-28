<script setup lang="ts">
import { ref } from 'vue'
import AboutUpdatesPanel from './AboutUpdatesPanel.vue'
import SkillManager from './SkillManager.vue'
import AgentWorkspacePanel from './AgentWorkspacePanel.vue'
import ProviderPanel from './ProviderPanel.vue'
import DatabaseViewer from './DatabaseViewer.vue'
import GeneralSettingsPanel from './GeneralSettingsPanel.vue'
import LogCenterPanel from './LogCenterPanel.vue'
import MCPSettingsPanel from './MCPSettingsPanel.vue'
import ProcessManagerPanel from './ProcessManagerPanel.vue'
import ScheduledTasksPanel from './ScheduledTasksPanel.vue'
import UsagePanel from './UsagePanel.vue'

type CategoryId = 'general' | 'about' | 'providers' | 'mcp' | 'skills' | 'agent-workspace' | 'scheduler' | 'logs' | 'database' | 'processes' | 'usage'

interface Category {
  id: CategoryId
  icon: string
  labelKey: string
}

const categories: Category[] = [
  { id: 'general', icon: '⚙️', labelKey: 'settings.nav.general' },
  { id: 'providers', icon: '🤖', labelKey: 'settings.nav.providers' },
  { id: 'usage', icon: '📈', labelKey: 'settings.nav.usage' },
  { id: 'mcp', icon: '🔌', labelKey: 'settings.nav.mcp' },
  { id: 'skills', icon: '✦', labelKey: 'settings.nav.skills' },
  { id: 'agent-workspace', icon: '🧠', labelKey: 'settings.nav.agentWorkspace' },
  { id: 'scheduler', icon: '⏱', labelKey: 'settings.nav.scheduler' },
  { id: 'logs', icon: '🧾', labelKey: 'settings.nav.logs' },
  { id: 'database', icon: '🗄', labelKey: 'settings.nav.database' },
  { id: 'processes', icon: '📊', labelKey: 'settings.nav.processes' },
  { id: 'about', icon: 'ℹ️', labelKey: 'settings.nav.about' }
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
        <span class="cat-label">{{ $t(cat.labelKey) }}</span>
      </button>
    </nav>

    <!-- Right content -->
    <div class="cat-content">
      <GeneralSettingsPanel v-if="activeCategoryId === 'general'" />
      <AboutUpdatesPanel v-else-if="activeCategoryId === 'about'" :active="activeCategoryId === 'about'" />
      <ProviderPanel v-else-if="activeCategoryId === 'providers'" />
      <UsagePanel v-else-if="activeCategoryId === 'usage'" />
      <MCPSettingsPanel v-else-if="activeCategoryId === 'mcp'" />
      <SkillManager v-else-if="activeCategoryId === 'skills'" />
      <AgentWorkspacePanel v-else-if="activeCategoryId === 'agent-workspace'" />
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
