<script setup lang="ts">
import { resolveProjectIcon } from '../../utils/project-icon'

interface RunningApp {
  id: string
  name: string
  kind: 'project' | 'browser'
  type: string
  icon?: string
  url?: string
  port?: number
  isWindow: boolean
  closable?: boolean
  savedToLaunchpad?: boolean
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
  (e: 'closeApp', appId: string): void
  (e: 'contextMenu', event: MouseEvent, app: RunningApp): void
}>()

function handleContextMenu (event: MouseEvent, app: RunningApp): void {
  emit('contextMenu', event, app)
}

function resolveIcon (app: RunningApp) {
  return resolveProjectIcon(app.type, app.icon)
}
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
        @contextmenu="handleContextMenu($event, app)"
      >
        <span class="dock-item-surface">
          <span class="dock-item-icon-wrap">
            <img v-if="resolveIcon(app).kind === 'image'" :src="resolveIcon(app).value" alt="" class="dock-item-icon dock-item-icon-image" />
            <span v-else class="dock-item-icon">{{ resolveIcon(app).value }}</span>
          </span>
          <span v-if="app.isWindow" class="dock-window-badge">↗</span>
          <button
            v-if="app.closable"
            class="dock-close-btn"
            type="button"
            title="关闭"
            @click.stop="emit('closeApp', app.id)"
          >
            ×
          </button>
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
  --dock-width: 70px;
  --dock-slot-size: 60px;
  --dock-surface-size: 56px;
  --dock-icon-size: 30px;
  --dock-accent: var(--app-accent);
  --dock-accent-soft: var(--app-accent-soft);
  --dock-accent-glow: var(--app-accent-glow);
  box-sizing: border-box;
  width: var(--dock-width);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 8px calc((var(--dock-width) - var(--dock-slot-size)) / 2) 7px;
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
  gap: 8px;
  padding: 8px 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.dock-apps::-webkit-scrollbar { width: 0; }

.dock-bottom { gap: 8px; }

.dock-item {
  position: relative;
  width: var(--dock-slot-size);
  height: var(--dock-slot-size);
  flex: 0 0 var(--dock-slot-size);
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
  left: 0;
  top: 50%;
  width: 4px;
  height: 24px;
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
  width: var(--dock-surface-size);
  height: var(--dock-surface-size);
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
  inset: 6px;
  border-radius: 15px;
  background: radial-gradient(circle at 50% 12%, var(--dock-accent-glow), transparent 68%);
  opacity: 0.9;
  pointer-events: none;
}

.dock-tooltip {
  position: absolute;
  left: calc(100% + 10px);
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

.dock-item-icon-wrap {
  position: relative;
  z-index: 1;
  width: var(--dock-icon-size);
  height: var(--dock-icon-size);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.dock-item-icon {
  position: relative;
  z-index: 1;
  font-size: 1.65em;
  line-height: 1;
  transition: transform 0.18s ease, filter 0.18s ease;
  filter: drop-shadow(0 8px 12px rgba(0, 0, 0, 0.22));
}

.dock-item-icon-image {
  width: calc(var(--dock-icon-size) - 2px);
  height: calc(var(--dock-icon-size) - 2px);
  object-fit: contain;
  border-radius: 6px;
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
  top: 5px;
  right: 5px;
  font-size: 0.58em;
  background: var(--dock-accent);
  color: var(--app-text-strong);
  width: 15px;
  height: 15px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  font-weight: 700;
}

.dock-close-btn {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 17px;
  height: 17px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.8);
  color: #ffffff;
  font-size: 0.72em;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.14s ease, transform 0.14s ease, background 0.14s ease;
  z-index: 2;
}

.dock-item:hover .dock-close-btn,
.dock-item.dock-active .dock-close-btn {
  opacity: 1;
}

.dock-close-btn:hover {
  background: var(--app-danger);
  transform: scale(1.08);
}

.dock-running-dot {
  position: absolute;
  bottom: 7px;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--app-success);
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.36);
}
</style>
