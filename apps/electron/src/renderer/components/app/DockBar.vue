<script setup lang="ts">
import { useI18n } from 'vue-i18n'
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
  pinned?: boolean
  isRunning?: boolean
}

const props = defineProps<{
  currentView: 'chat' | 'app' | 'source' | 'settings' | 'studio'
  showLaunchpad: boolean
  runningApps: Map<string, RunningApp>
  pinnedApps: RunningApp[]
  embeddedProjectId: string | null
}>()

const emit = defineEmits<{
  (e: 'openChat'): void
  (e: 'openStudio'): void
  (e: 'toggleLaunchpad'): void
  (e: 'openSettings'): void
  (e: 'switchToApp', app: RunningApp): void
  (e: 'closeApp', appId: string): void
  (e: 'contextMenu', event: MouseEvent, app: RunningApp): void
}>()

const { t } = useI18n()

function handleContextMenu (event: MouseEvent, app: RunningApp): void {
  emit('contextMenu', event, app)
}

function resolveIcon (app: RunningApp) {
  return resolveProjectIcon(app.type, app.icon)
}

function appTitle (app: RunningApp): string {
  return app.name + (app.isWindow ? t('appShell.independentWindowSuffix') : '')
}

function canCloseApp (app: RunningApp): boolean {
  return Boolean(app.closable && (app.isRunning ?? true))
}

function closeTitle (app: RunningApp): string {
  return app.kind === 'project' ? t('appShell.dockStop') : t('appShell.dockCloseWebPage')
}
</script>

<template>
  <aside class="dock-bar">
    <div class="dock-top">
      <div
        :class="['dock-item', { 'dock-active': props.currentView === 'chat' && !props.showLaunchpad }]"
        :title="$t('appShell.aiChatTitle')"
        :data-tip="$t('appShell.chat')"
        @click="emit('openChat')"
      >
        <span class="dock-item-surface">
          <span class="dock-item-icon">💬</span>
        </span>
        <span class="dock-tooltip">{{ $t('appShell.chat') }}</span>
      </div>

      <div
        :class="['dock-item', { 'dock-active': props.currentView === 'studio' && !props.showLaunchpad }]"
        :title="$t('appShell.studioTitle')"
        :data-tip="$t('appShell.studio')"
        @click="emit('openStudio')"
      >
        <span class="dock-item-surface">
          <span class="dock-item-icon">🎨</span>
        </span>
        <span class="dock-tooltip">{{ $t('appShell.studio') }}</span>
      </div>
    </div>

    <div class="dock-divider" aria-hidden="true"></div>

    <div class="dock-apps">
      <template v-if="props.pinnedApps.length">
        <div
          v-for="app in props.pinnedApps"
          :key="'pin-' + app.id"
          :class="['dock-item', 'dock-app', 'dock-pinned', { 'dock-active': props.currentView === 'app' && props.embeddedProjectId === app.id, 'dock-windowed': app.isWindow, 'dock-running': app.isRunning }]"
          :title="appTitle(app)"
          :data-tip="app.name"
          @click="emit('switchToApp', app)"
          @contextmenu="handleContextMenu($event, app)"
        >
          <span class="dock-item-surface">
            <span class="dock-item-icon-wrap">
              <img v-if="resolveIcon(app).kind === 'image'" :src="resolveIcon(app).value" alt="" class="dock-item-icon dock-item-icon-image" />
              <span v-else class="dock-item-icon">{{ resolveIcon(app).value }}</span>
            </span>
            <span class="dock-pin-badge" :title="$t('appShell.pinnedToDock')">📌</span>
            <span v-if="app.isWindow" class="dock-window-badge">↗</span>
            <button
              v-if="canCloseApp(app)"
              class="dock-close-btn"
              type="button"
              :title="closeTitle(app)"
              :aria-label="closeTitle(app)"
              @click.stop="emit('closeApp', app.id)"
            >
              ×
            </button>
            <span v-if="app.isRunning" class="dock-running-dot"></span>
          </span>
          <span class="dock-tooltip">{{ app.name }}</span>
        </div>

        <div v-if="props.runningApps.size" class="dock-divider dock-divider-inline" aria-hidden="true"></div>
      </template>

      <div
        v-for="[appId, app] in props.runningApps"
        :key="appId"
        :class="['dock-item', 'dock-app', { 'dock-active': props.currentView === 'app' && props.embeddedProjectId === appId, 'dock-windowed': app.isWindow, 'dock-running': app.closable }]"
        :title="appTitle(app)"
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
            v-if="canCloseApp(app)"
            class="dock-close-btn"
            type="button"
            :title="closeTitle(app)"
            :aria-label="closeTitle(app)"
            @click.stop="emit('closeApp', app.id)"
          >
            ×
          </button>
          <span class="dock-running-dot"></span>
        </span>
        <span class="dock-tooltip">{{ app.name }}</span>
      </div>
    </div>

    <div class="dock-divider" aria-hidden="true"></div>

    <div class="dock-bottom">
      <div
        :class="['dock-item', { 'dock-active': props.showLaunchpad }]"
        :title="$t('appShell.launchpad')"
        :data-tip="$t('appShell.launchpad')"
        @click="emit('toggleLaunchpad')"
      >
        <span class="dock-item-surface">
          <span class="dock-item-icon">🚀</span>
        </span>
        <span class="dock-tooltip">{{ $t('appShell.launchpad') }}</span>
      </div>

      <div
        :class="['dock-item', { 'dock-active': props.currentView === 'settings' && !props.showLaunchpad }]"
        :title="$t('appShell.settings')"
        :data-tip="$t('appShell.settings')"
        @click="emit('openSettings')"
      >
        <span class="dock-item-surface">
          <span class="dock-item-icon">⚙️</span>
        </span>
        <span class="dock-tooltip">{{ $t('appShell.settings') }}</span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.dock-bar {
  --dock-slot-size: 46px;
  --dock-surface-size: 42px;
  --dock-icon-size: 22px;
  --dock-accent: var(--app-accent);
  --dock-accent-soft: var(--app-accent-soft);
  --dock-accent-glow: var(--app-accent-glow);
  box-sizing: border-box;
  width: var(--dock-width);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 6px calc((var(--dock-width) - var(--dock-slot-size)) / 2) 6px;
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-strong) 55%, var(--app-panel));
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
  gap: 6px;
  padding: 6px 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.dock-apps::-webkit-scrollbar { width: 0; }

.dock-bottom { gap: 6px; }
.dock-top { gap: 6px; }

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
  border-radius: 14px;
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
  inset: 5px;
  border-radius: 11px;
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
  font-size: 1.35em;
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
  top: 4px;
  right: 4px;
  font-size: 0.58em;
  background: var(--dock-accent);
  color: var(--app-text-strong);
  width: 13px;
  height: 13px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  font-weight: 700;
}

.dock-close-btn {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.86);
  color: #ffffff;
  font-size: 0.78em;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.14s ease, transform 0.14s ease, background 0.14s ease;
  z-index: 2;
}

.dock-item.dock-running .dock-close-btn {
  opacity: 0.86;
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
  bottom: 5px;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--app-success);
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.36);
}

.dock-divider {
  width: 26px;
  height: 1px;
  flex-shrink: 0;
  background: var(--app-border-strong);
  opacity: 0.7;
}

.dock-divider-inline {
  margin: 3px 0;
}

.dock-pin-badge {
  position: absolute;
  top: 3px;
  left: 3px;
  font-size: 0.5em;
  line-height: 1;
  opacity: 0.5;
  pointer-events: none;
  transition: opacity 0.14s ease;
  z-index: 2;
}

.dock-item:hover .dock-pin-badge {
  opacity: 1;
}
</style>
