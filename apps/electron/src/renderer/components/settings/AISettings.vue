<script setup lang="ts">
import { ref, watch } from 'vue'
import AboutUpdatesPanel from './AboutUpdatesPanel.vue'
import { appUpdateState } from '../../utils/app-update-state'
import SkillManager from './SkillManager.vue'
import AgentWorkspacePanel from './AgentWorkspacePanel.vue'
import MemorySettingsPanel from './MemorySettingsPanel.vue'
import ProviderPanel from './ProviderPanel.vue'
import DatabaseViewer from './DatabaseViewer.vue'
import DailySuggestionsPanel from './DailySuggestionsPanel.vue'
import GeneralSettingsPanel from './GeneralSettingsPanel.vue'
import LogCenterPanel from './LogCenterPanel.vue'
import MCPSettingsPanel from './MCPSettingsPanel.vue'
import ProcessManagerPanel from './ProcessManagerPanel.vue'
import ScheduledTasksPanel from './ScheduledTasksPanel.vue'
import UsagePanel from './UsagePanel.vue'

type CategoryId = 'general' | 'about' | 'providers' | 'mcp' | 'skills' | 'memory' | 'agent-workspace' | 'scheduler' | 'daily-suggestions' | 'logs' | 'database' | 'processes' | 'usage'

const props = defineProps<{
  /** Category to open on mount / when it changes; unknown ids are ignored. */
  initialCategory?: string | null
  /** Provider template id to open straight into "use this template". */
  providerTemplate?: string | null
}>()

const emit = defineEmits<{
  (e: 'providerTemplateConsumed'): void
}>()

interface Category {
  id: CategoryId
  labelKey: string
}

const categories: Category[] = [
  { id: 'providers', labelKey: 'settings.nav.providers' },
  { id: 'memory', labelKey: 'settings.nav.memory' },
  { id: 'general', labelKey: 'settings.nav.general' },
  { id: 'usage', labelKey: 'settings.nav.usage' },
  { id: 'mcp', labelKey: 'settings.nav.mcp' },
  { id: 'skills', labelKey: 'settings.nav.skills' },
  { id: 'agent-workspace', labelKey: 'settings.nav.agentWorkspace' },
  { id: 'scheduler', labelKey: 'settings.nav.scheduler' },
  { id: 'daily-suggestions', labelKey: 'settings.nav.dailySuggestions' },
  { id: 'logs', labelKey: 'settings.nav.logs' },
  { id: 'database', labelKey: 'settings.nav.database' },
  { id: 'processes', labelKey: 'settings.nav.processes' },
  { id: 'about', labelKey: 'settings.nav.about' }
]

// Lucide-style stroke icons (currentColor) so the nav reads as one line-icon
// system — emoji render differently per platform and clash with the shell UI.
function navIcon (body: string): string {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
}

const NAV_ICONS: Record<CategoryId, string> = {
  general: navIcon('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  providers: navIcon('<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>'),
  usage: navIcon('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>'),
  mcp: navIcon('<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>'),
  skills: navIcon('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>'),
  'agent-workspace': navIcon('<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>'),
  memory: navIcon('<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M9 18h6"/>'),
  scheduler: navIcon('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  'daily-suggestions': navIcon('<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1.3.5 2.6 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>'),
  logs: navIcon('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
  database: navIcon('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>'),
  processes: navIcon('<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>'),
  about: navIcon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>')
}

const activeCategoryId = ref<CategoryId>('general')

const { updateAvailable } = appUpdateState

const CATEGORY_IDS = new Set<string>(categories.map(category => category.id))

watch(() => props.initialCategory, (category) => {
  if (category && CATEGORY_IDS.has(category)) activeCategoryId.value = category as CategoryId
}, { immediate: true })
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
        <span class="cat-icon" v-html="NAV_ICONS[cat.id]" />
        <span class="cat-label">{{ $t(cat.labelKey) }}</span>
        <span
          v-if="cat.id === 'about' && updateAvailable"
          class="cat-update-dot"
          :title="$t('appShell.updateAvailable')"
        />
      </button>
    </nav>

    <!-- Right content -->
    <div class="cat-content">
      <GeneralSettingsPanel v-if="activeCategoryId === 'general'" />
      <AboutUpdatesPanel v-else-if="activeCategoryId === 'about'" :active="activeCategoryId === 'about'" />
      <ProviderPanel
        v-else-if="activeCategoryId === 'providers'"
        :use-template="props.providerTemplate"
        @template-consumed="emit('providerTemplateConsumed')"
      />
      <UsagePanel v-else-if="activeCategoryId === 'usage'" />
      <MCPSettingsPanel v-else-if="activeCategoryId === 'mcp'" />
      <SkillManager v-else-if="activeCategoryId === 'skills'" />
      <MemorySettingsPanel v-else-if="activeCategoryId === 'memory'" />
      <AgentWorkspacePanel v-else-if="activeCategoryId === 'agent-workspace'" />
      <ScheduledTasksPanel v-else-if="activeCategoryId === 'scheduler'" />
      <DailySuggestionsPanel v-else-if="activeCategoryId === 'daily-suggestions'" />
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
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.cat-icon :deep(svg) {
  display: block;
}

.cat-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* "update available" badge on the About nav entry */
.cat-update-dot {
  width: 8px;
  height: 8px;
  margin-left: auto;
  flex-shrink: 0;
  border-radius: 999px;
  background: var(--app-success);
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.45);
}

/* ── Right content area ── */
.cat-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
</style>
