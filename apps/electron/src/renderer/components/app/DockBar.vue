<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { appUpdateState } from '../../utils/app-update-state'
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

const { updateAvailable } = appUpdateState

/** Gear tooltip doubles as the update hint while a newer version is pending. */
const settingsDockLabel = computed(() =>
  updateAvailable.value
    ? `${t('appShell.settings')} · ${t('appShell.updateAvailable')}`
    : t('appShell.settings')
)

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

/** design v1.7 dock: running apps render as character badges (first grapheme). */
function appInitial (app: RunningApp): string {
  const match = /[\p{L}\p{N}]/u.exec(app.name || '')
  return (match?.[0] || '·').toUpperCase()
}
</script>

<template>
  <aside class="dock-bar">
    <!-- design v1.7: core three = chat bubble / studio hexahedron SVGs -->
    <div class="dock-top">
      <div
        :class="['dock-item', { 'dock-active': props.currentView === 'chat' && !props.showLaunchpad }]"
        :title="$t('appShell.aiChatTitle')"
        :data-tip="$t('appShell.chat')"
        @click="emit('openChat')"
      >
        <span class="dock-item-surface">
          <svg class="dock-item-svg" width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.5 3.5h11v7h-6L4 13.5v-3H2.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          </svg>
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
          <svg class="dock-item-svg" width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 1.9c-3.4 0-6.1 2.6-6.1 5.8 0 3.1 2.5 5.7 5.6 5.7.9 0 1.5-.7 1.3-1.5-.2-.8.4-1.6 1.3-1.6h1.5c1.3 0 2.4-1.1 2.4-2.4 0-3.3-2.7-6-6-6z" stroke="currentColor" stroke-width="1.2" />
            <circle cx="5.3" cy="6.3" r="0.95" fill="currentColor" />
            <circle cx="8" cy="4.6" r="0.95" fill="currentColor" />
            <circle cx="10.7" cy="6.3" r="0.95" fill="currentColor" />
          </svg>
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
              <span v-else class="dock-item-badge">{{ appInitial(app) }}</span>
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
            <span v-else class="dock-item-badge">{{ appInitial(app) }}</span>
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

    <div class="dock-bottom">
      <div class="dock-divider" aria-hidden="true"></div>

      <!-- 应用中心：app grid (launchpad) -->
      <div
        :class="['dock-item', { 'dock-active': props.showLaunchpad }]"
        :title="$t('appShell.launchpad')"
        :data-tip="$t('appShell.launchpad')"
        @click="emit('toggleLaunchpad')"
      >
        <span class="dock-item-surface">
          <svg class="dock-item-svg" width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2.75" y="2.75" width="4.5" height="4.5" rx="1.3" stroke="currentColor" stroke-width="1.3" />
            <rect x="8.75" y="2.75" width="4.5" height="4.5" rx="1.3" stroke="currentColor" stroke-width="1.3" />
            <rect x="2.75" y="8.75" width="4.5" height="4.5" rx="1.3" stroke="currentColor" stroke-width="1.3" />
            <rect x="8.75" y="8.75" width="4.5" height="4.5" rx="1.3" stroke="currentColor" stroke-width="1.3" />
          </svg>
        </span>
        <span class="dock-tooltip">{{ $t('appShell.launchpad') }}</span>
      </div>

      <!-- 主题切换已移除：深浅主题在 设置 → 外观 中调整 -->
      <div
        :class="['dock-item', { 'dock-active': props.currentView === 'settings' && !props.showLaunchpad }]"
        :title="settingsDockLabel"
        :data-tip="settingsDockLabel"
        @click="emit('openSettings')"
      >
        <span class="dock-item-surface">
          <svg class="dock-item-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          <span v-if="updateAvailable" class="dock-update-dot" aria-hidden="true"></span>
        </span>
        <span class="dock-tooltip">{{ settingsDockLabel }}</span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.dock-bar {
  /* design v1.7 dock: 56px rail, 42px slots, 38px surfaces, 12px radius */
  --dock-slot-size: 42px;
  --dock-surface-size: 38px;
  --dock-icon-size: 18px;
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
  padding: 7px calc((var(--dock-width) - var(--dock-slot-size)) / 2) 7px;
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
  left: -5px;
  top: 50%;
  width: 3px;
  height: 23px;
  border-radius: 3px;
  background: linear-gradient(180deg, var(--dock-accent), var(--app-accent-strong));
  box-shadow: 0 0 10px var(--dock-accent-glow);
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
  border-radius: 12px;
  border: 1px solid transparent;
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  overflow: hidden;
  transition: transform 0.18s ease, background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, color 0.18s ease;
  color: var(--app-text-muted);
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

/* design v1.7: active slot = accent wash + accent glyph */
.dock-item.dock-active .dock-item-surface {
  background: var(--dock-accent-soft);
  border-color: color-mix(in srgb, var(--dock-accent) 26%, var(--app-border-strong));
  color: var(--app-accent-strong);
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

/* design v1.7: semantic SVG glyphs for the fixed dock icons */
.dock-item-svg {
  position: relative;
  z-index: 1;
  transition: transform 0.18s ease, filter 0.18s ease;
  filter: drop-shadow(0 8px 12px rgba(0, 0, 0, 0.22));
}

/* running/pinned apps render as character badges (first grapheme of the name) */
.dock-item-badge {
  position: relative;
  z-index: 1;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.86em;
  font-weight: 700;
  letter-spacing: 0.02em;
  line-height: 1;
  transition: transform 0.18s ease, filter 0.18s ease;
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

.dock-item:hover .dock-item-svg,
.dock-item:hover .dock-item-badge,
.dock-item:hover .dock-item-icon {
  transform: scale(1.08);
}

.dock-item.dock-active .dock-item-svg,
.dock-item.dock-active .dock-item-badge,
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

/* design v1.7: hover 关闭 — the close affordance appears on hover/active only */
.dock-item.dock-running:hover .dock-close-btn {
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

/* "update available" badge on the settings gear */
.dock-update-dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--app-success);
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.45);
  z-index: 2;
  pointer-events: none;
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
