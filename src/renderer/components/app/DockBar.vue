<script setup lang="ts">
interface RunningApp {
  id: string
  name: string
  type: string
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
        <span class="dock-item-icon">💬</span>
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
        <span class="dock-item-icon">{{ app.type === 'frontend' ? '🎨' : app.type === 'backend' ? '⚙️' : '📦' }}</span>
        <span v-if="app.isWindow" class="dock-window-badge">↗</span>
        <span class="dock-running-dot"></span>
      </div>
    </div>

    <div class="dock-bottom">
      <div
        :class="['dock-item', { 'dock-active': props.showLaunchpad }]"
        title="启动台"
        data-tip="启动台"
        @click="emit('toggleLaunchpad')"
      >
        <span class="dock-item-icon">🚀</span>
      </div>

      <div
        :class="['dock-item', { 'dock-active': props.currentView === 'settings' && !props.showLaunchpad }]"
        title="设置"
        data-tip="设置"
        @click="emit('openSettings')"
      >
        <span class="dock-item-icon">⚙️</span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.dock-bar {
  --dock-accent: #38bdf8;
  --dock-accent-soft: rgba(56, 189, 248, 0.16);
  --dock-accent-glow: rgba(56, 189, 248, 0.3);
  width: 82px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 14px 10px 16px;
  background: linear-gradient(180deg, rgba(10, 14, 20, 0.96), rgba(7, 10, 15, 0.92));
  border-right: 1px solid rgba(148, 163, 184, 0.12);
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
  padding: 8px 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.dock-apps::-webkit-scrollbar { width: 0; }

.dock-bottom { gap: 10px; }

.dock-item {
  position: relative;
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 18px;
  cursor: pointer;
  user-select: none;
  transition: transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
  background: rgba(255, 255, 255, 0.03);
}

.dock-item:hover {
  transform: translateX(3px) scale(1.05);
  background: rgba(255, 255, 255, 0.06);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.24);
}

.dock-item:active { transform: translateX(1px) scale(0.98); }

.dock-item.dock-active {
  background: var(--dock-accent-soft);
  box-shadow: inset 0 0 0 1px rgba(125, 211, 252, 0.18), 0 12px 30px rgba(0, 0, 0, 0.28);
}

.dock-item.dock-active::before {
  content: '';
  position: absolute;
  left: -6px;
  width: 3px;
  height: 24px;
  border-radius: 999px;
  background: var(--dock-accent);
  box-shadow: 0 0 10px var(--dock-accent-glow);
}

.dock-item::after {
  content: attr(data-tip);
  position: absolute;
  left: calc(100% + 12px);
  top: 50%;
  transform: translateY(-50%) translateX(-4px);
  background: rgba(15, 23, 42, 0.96);
  color: #e2e8f0;
  font-size: 0.72em;
  line-height: 1;
  white-space: nowrap;
  padding: 7px 10px;
  border-radius: 10px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.14s ease, transform 0.14s ease;
}

.dock-item:hover::after {
  opacity: 1;
  transform: translateY(-50%) translateX(0);
}

.dock-item-icon {
  font-size: 1.5em;
  line-height: 1;
  filter: drop-shadow(0 8px 12px rgba(0, 0, 0, 0.26));
}

.dock-app.dock-windowed {
  outline: 1px dashed rgba(125, 211, 252, 0.34);
  outline-offset: -2px;
}

.dock-window-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  font-size: 0.56em;
  background: var(--dock-accent);
  color: #082f49;
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
  background: #22c55e;
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.55);
}
</style>
