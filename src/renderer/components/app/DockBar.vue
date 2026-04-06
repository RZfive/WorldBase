<script setup lang="ts">
import { getProjectIcon } from '../../utils/project-icon'

interface RunningApp {
  id: string
  name: string
  type: string
  icon?: string
  port?: number
  isWindow: boolean
}

const props = defineProps<{
  currentView: 'chat' | 'app' | 'source' | 'settings'
  showLaunchpad: boolean
  runningApps: Map<string, RunningApp>
  embeddedProjectId: string | null
}>()

const emit = defineEmits<{
  (e: 'openChat'): void
  (e: 'toggleLaunchpad'): void
  (e: 'openSettings'): void
  (e: 'switchToApp', app: RunningApp): void
  (e: 'contextMenu', event: MouseEvent, app: RunningApp): void
}>()
</script>

<template>
  <aside class="dock-bar">
    <div class="dock-top">
      <div
        :class="['dock-item', { 'dock-active': props.currentView === 'chat' && !props.showLaunchpad }]"
        title="AI 对话"
        data-tip="对话"
        @click="emit('openChat')"
      >
        <span class="dock-item-surface">
          <span class="dock-item-icon">💬</span>
        </span>
        <span class="dock-tooltip">对话</span>
      </div>
    </div>

    <div class="dock-apps">
      <div
        v-for="[appId, app] in props.runningApps"
        :key="appId"
        :class="['dock-item', 'dock-app', { 'dock-active': props.currentView === 'app' && props.embeddedProjectId === appId, 'dock-windowed': app.isWindow }]"
        :title="app.name + (app.isWindow ? ' (独立窗口)' : '')"
        :data-tip="app.name"
        @click="emit('switchToApp', app)"
        @contextmenu="emit('contextMenu', $event, app)"
      >
        <span class="dock-item-surface">
          <span class="dock-item-icon">{{ getProjectIcon(app.type, app.icon) }}</span>
          <span v-if="app.isWindow" class="dock-window-badge">↗</span>
          <span class="dock-running-dot"></span>
        </span>
        <span class="dock-tooltip">{{ app.name }}</span>
      </div>
    </div>

    <div class="dock-bottom">
      <div
        :class="['dock-item', { 'dock-active': props.showLaunchpad }]"
        title="启动台"
        data-tip="启动台"
        @click="emit('toggleLaunchpad')"
      >
        <span class="dock-item-surface">
          <span class="dock-item-icon">🚀</span>
        </span>
        <span class="dock-tooltip">启动台</span>
      </div>

      <div
        :class="['dock-item', { 'dock-active': props.currentView === 'settings' && !props.showLaunchpad }]"
        title="设置"
        data-tip="设置"
        @click="emit('openSettings')"
      >
        <span class="dock-item-surface">
          <span class="dock-item-icon">⚙️</span>
        </span>
        <span class="dock-tooltip">设置</span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.dock-bar {
  --dock-accent: var(--app-accent);
  --dock-accent-soft: var(--app-accent-soft);
  --dock-accent-glow: var(--app-accent-glow);
  width: 90px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 16px 12px 18px;
  background: linear-gradient(180deg, var(--app-panel-strong), var(--app-panel));
  border-right: 1px solid var(--app-border);
}

.dock-top,
.dock-bottom,
.dock-apps {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}

.dock-apps {
  flex: 1;
  gap: 10px;
  padding: 10px 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.dock-apps::-webkit-scrollbar { width: 0; }

.dock-bottom { gap: 10px; }

.dock-item {
  position: relative;
  width: 60px;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  isolation: isolate;
}

.dock-item::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 50%;
  width: 4px;
  height: 22px;
  border-radius: 999px;
  background: linear-gradient(180deg, var(--dock-accent), var(--app-accent-strong));
  box-shadow: 0 0 14px var(--dock-accent-glow);
  transform: translateY(-50%) scaleY(0.4);
  transform-origin: center;
  opacity: 0;
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.dock-item-surface {
  position: relative;
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 20px;
  border: 1px solid transparent;
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  overflow: hidden;
  transition: transform 0.18s ease, background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
}

.dock-item-surface::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(circle at 50% 12%, rgba(255, 255, 255, 0.16), transparent 56%);
  opacity: 0.6;
  pointer-events: none;
}

.dock-item:hover .dock-item-surface {
  transform: translateY(-2px);
  background: linear-gradient(180deg, var(--app-panel-strong), var(--app-panel-muted));
  border-color: var(--app-border-strong);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.06),
    inset 0 -14px 22px rgba(255, 255, 255, 0.02);
}

.dock-item:active .dock-item-surface {
  transform: translateY(0) scale(0.98);
}

.dock-item.dock-active::before {
  opacity: 1;
  transform: translateY(-50%) scaleY(1);
}

.dock-item.dock-active .dock-item-surface {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent),
    linear-gradient(180deg, var(--dock-accent-soft), rgba(255, 255, 255, 0.02));
  border-color: var(--dock-accent-glow);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.04),
    inset 0 -18px 28px rgba(255, 255, 255, 0.03);
}

.dock-item.dock-active .dock-item-surface::after {
  content: '';
  position: absolute;
  inset: 7px;
  border-radius: 15px;
  background: radial-gradient(circle at 50% 12%, var(--dock-accent-glow), transparent 68%);
  opacity: 0.9;
  pointer-events: none;
}

.dock-tooltip {
  position: absolute;
  left: calc(100% + 12px);
  top: 50%;
  transform: translateY(-50%) translateX(-4px);
  background: var(--app-panel-strong);
  color: var(--app-text-soft);
  font-size: 0.72em;
  line-height: 1;
  white-space: nowrap;
  padding: 7px 10px;
  border-radius: 10px;
  border: 1px solid var(--app-border);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28);
  opacity: 0;
  pointer-events: none;
  z-index: 4;
  transition: opacity 0.14s ease, transform 0.14s ease;
}

.dock-item:hover .dock-tooltip {
  opacity: 1;
  transform: translateY(-50%) translateX(0);
}

.dock-item-icon {
  position: relative;
  z-index: 1;
  font-size: 1.5em;
  line-height: 1;
  transition: transform 0.18s ease, filter 0.18s ease;
  filter: drop-shadow(0 8px 12px rgba(0, 0, 0, 0.22));
}

.dock-item:hover .dock-item-icon {
  transform: scale(1.08);
  filter: drop-shadow(0 12px 16px rgba(0, 0, 0, 0.22));
}

.dock-item.dock-active .dock-item-icon {
  transform: scale(1.08);
  filter: drop-shadow(0 0 10px var(--dock-accent-glow));
}

.dock-app.dock-windowed .dock-item-surface {
  border-style: dashed;
}

.dock-window-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  font-size: 0.56em;
  background: var(--dock-accent);
  color: var(--app-text-strong);
  width: 14px;
  height: 14px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  font-weight: 700;
}

.dock-running-dot {
  position: absolute;
  bottom: 6px;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--app-success);
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.36);
}
</style>
