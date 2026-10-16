<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import './tab-registry-entries'
import {
  getWorkspaceTabDefinition,
  listWorkspaceTabDefinitions,
  type WorkspaceTabInstance
} from './tab-registry'

const props = withDefaults(defineProps<{
  visible: boolean
  tabs: WorkspaceTabInstance[]
  activeTabId?: string | null
  workspaceWidth?: number
}>(), {
  activeTabId: null,
  workspaceWidth: 980
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'closeTab', tabId: string): void
  (e: 'activateTab', tabId: string): void
  (e: 'addTab', kind: string): void
  (e: 'updateWidth', width: number): void
  (e: 'insertSelectionTag', tag: string): void
  (e: 'updateTabState', tab: WorkspaceTabInstance, state: unknown): void
}>()

const { t } = useI18n()

const panelRoot = ref<HTMLElement | null>(null)
const showAddMenu = ref(false)
const showTabActions = ref(false)
/** Live instance of the active tab body; action ids map to its exposed methods. */
const tabBodyRef = ref<{ [key: string]: () => unknown } | null>(null)

// The actions menu sits 6px below its button; without a grace timer the menu
// closes the instant the pointer crosses that gap, making it unreachable.
let tabActionsCloseTimer = 0

function openTabActions (): void {
  window.clearTimeout(tabActionsCloseTimer)
  if (activeTabActions.value.length > 0) showTabActions.value = true
}

function scheduleCloseTabActions (): void {
  window.clearTimeout(tabActionsCloseTimer)
  tabActionsCloseTimer = window.setTimeout(() => {
    showTabActions.value = false
  }, 200)
}

function hideTabActionsNow (): void {
  window.clearTimeout(tabActionsCloseTimer)
  showTabActions.value = false
}

const CONVERSATION_SIDEBAR_WIDTH = 252
const MIN_CHAT_MAIN_WIDTH = 640
const FALLBACK_MIN_WIDTH = 720
const FALLBACK_MAX_WIDTH = 1320

let resizeStartX = 0
let resizeStartWidth = 0
let resizing = false
let layoutObserver: ResizeObserver | null = null

const activeTab = computed<WorkspaceTabInstance | null>(() => {
  return props.tabs.find(tab => tab.id === props.activeTabId) || null
})

const activeDefinition = computed(() => {
  return activeTab.value ? getWorkspaceTabDefinition(activeTab.value.kind) : null
})

const activeTabComponent = computed(() => activeDefinition.value?.component || null)

/** Reactive prop bag resolved by the active tab kind (folder/document read the workspace store). */
const activeTabProps = computed<Record<string, unknown>>(() => {
  const tab = activeTab.value
  if (!tab) return {}
  return activeDefinition.value?.resolveProps?.(tab) || {}
})

const addableDefinitions = computed(() => {
  return listWorkspaceTabDefinitions()
    .filter(definition => {
      if (!definition.singleton) return true
      return !props.tabs.some(tab => tab.kind === definition.kind)
    })
})

const activeTabActions = computed(() => {
  const tab = activeTab.value
  if (!tab) return []
  return activeDefinition.value?.getActions?.(tab) ?? []
})

function getTabDefinition (tab: WorkspaceTabInstance) {
  return getWorkspaceTabDefinition(tab.kind)
}

function getTabLabel (tab: WorkspaceTabInstance): string {
  return tab.title || t(getTabDefinition(tab)?.titleKey || 'chatUi.workspaceTabUnknown')
}

function getChatLayoutWidth (): number {
  return panelRoot.value?.parentElement?.clientWidth || Math.max(0, window.innerWidth - CONVERSATION_SIDEBAR_WIDTH)
}

function getMaxWorkspaceWidth (): number {
  const maxByParent = getChatLayoutWidth() - MIN_CHAT_MAIN_WIDTH
  const kindMax = activeDefinition.value?.maxWidth ?? FALLBACK_MAX_WIDTH
  return Math.max(320, Math.min(kindMax, Math.round(maxByParent)))
}

function clampWidth (value: number): number {
  const kindMin = activeDefinition.value?.minWidth ?? FALLBACK_MIN_WIDTH
  const maxWorkspaceWidth = getMaxWorkspaceWidth()
  const minWorkspaceWidth = Math.min(kindMin, maxWorkspaceWidth)
  return Math.min(maxWorkspaceWidth, Math.max(minWorkspaceWidth, Math.round(value)))
}

function startResize (event: MouseEvent): void {
  resizeStartX = event.clientX
  resizeStartWidth = clampWidth(props.workspaceWidth)
  resizing = true
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = 'ew-resize'
  document.body.style.userSelect = 'none'
}

/** Double-clicking the handle snaps the panel back to the kind's default width. */
function resetToDefaultWidth (): void {
  const defaultWidth = activeDefinition.value?.defaultWidth
  if (typeof defaultWidth === 'number') {
    emit('updateWidth', clampWidth(defaultWidth))
  }
}

function onResizeMove (event: MouseEvent): void {
  const delta = resizeStartX - event.clientX
  emit('updateWidth', clampWidth(resizeStartWidth + delta))
}

function stopResize (): void {
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  resizing = false
}

function bindLayoutObserver (): void {
  if (typeof ResizeObserver === 'undefined') return
  const parent = panelRoot.value?.parentElement
  if (!parent) return

  layoutObserver?.disconnect()
  layoutObserver = new ResizeObserver(() => {
    if (resizing || !props.visible) return
    const next = clampWidth(props.workspaceWidth)
    if (next !== props.workspaceWidth) emit('updateWidth', next)
  })
  layoutObserver.observe(parent)
}

// Activating a tab with different bounds re-clamps the shared panel width.
watch(
  () => props.activeTabId,
  async () => {
    showAddMenu.value = false
    showTabActions.value = false
    tabContextMenu.value = null
    if (!props.visible) return
    await nextTick()
    const next = clampWidth(props.workspaceWidth)
    if (next !== props.workspaceWidth) emit('updateWidth', next)
    void scrollActiveTabIntoView()
  }
)

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) {
      stopResize()
      showAddMenu.value = false
      tabContextMenu.value = null
      layoutObserver?.disconnect()
      layoutObserver = null
      unbindTabsScrollObserver()
      return
    }
    await nextTick()
    bindLayoutObserver()
    bindTabsScrollObserver()
    updateTabsScrollState()
    void scrollActiveTabIntoView()
  },
  { immediate: true }
)

onMounted(() => {
  if (!props.visible) return
  void nextTick(() => {
    bindLayoutObserver()
    bindTabsScrollObserver()
    updateTabsScrollState()
  })
})

onBeforeUnmount(() => {
  stopResize()
  window.clearTimeout(tabActionsCloseTimer)
  window.removeEventListener('keydown', onContextMenuKeydown)
  layoutObserver?.disconnect()
  layoutObserver = null
  unbindTabsScrollObserver()
})

function handleAddTab (kind: string): void {
  showAddMenu.value = false
  emit('addTab', kind)
}

function handleTabStateUpdate (state: unknown): void {
  const tab = activeTab.value
  if (tab) emit('updateTabState', tab, state)
}

/** Dispatches a page action to the active tab body's exposed method. */
function runTabAction (actionId: string): void {
  hideTabActionsNow()
  void tabBodyRef.value?.[actionId]?.()
}

// --- Tab quick close: middle click + right-click context menu ---

/** Middle-click closes the tab, matching the common browser/editor convention. */
function onTabMouseDown (event: MouseEvent, tabId: string): void {
  if (event.button !== 1) return
  event.preventDefault()
  emit('closeTab', tabId)
}

const tabContextMenu = ref<{ tab: WorkspaceTabInstance; x: number; y: number } | null>(null)

const CONTEXT_MENU_MIN_WIDTH = 176
const CONTEXT_MENU_EST_HEIGHT = 116

function openTabContextMenu (tab: WorkspaceTabInstance, event: MouseEvent): void {
  tabContextMenu.value = {
    tab,
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - CONTEXT_MENU_MIN_WIDTH - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - CONTEXT_MENU_EST_HEIGHT - 8))
  }
}

function closeTabContextMenu (): void {
  tabContextMenu.value = null
}

function onContextMenuKeydown (event: KeyboardEvent): void {
  if (event.key === 'Escape') closeTabContextMenu()
}

watch(tabContextMenu, (menu) => {
  if (menu) window.addEventListener('keydown', onContextMenuKeydown)
  else window.removeEventListener('keydown', onContextMenuKeydown)
})

const contextTabCountToRight = computed(() => {
  const menu = tabContextMenu.value
  if (!menu) return 0
  const index = props.tabs.findIndex(tab => tab.id === menu.tab.id)
  return index < 0 ? 0 : props.tabs.length - 1 - index
})

function handleContextCloseTab (): void {
  const tab = tabContextMenu.value?.tab
  closeTabContextMenu()
  if (tab) emit('closeTab', tab.id)
}

/** Closes every other tab through the same closeTab pipeline; the anchor stays. */
function handleContextCloseOtherTabs (): void {
  const keepTabId = tabContextMenu.value?.tab.id
  closeTabContextMenu()
  if (!keepTabId) return
  for (const tab of props.tabs) {
    if (tab.id !== keepTabId) emit('closeTab', tab.id)
  }
}

function handleContextCloseTabsToRight (): void {
  const menu = tabContextMenu.value
  closeTabContextMenu()
  if (!menu) return
  const index = props.tabs.findIndex(tab => tab.id === menu.tab.id)
  if (index < 0) return
  for (const tab of props.tabs.slice(index + 1)) emit('closeTab', tab.id)
}

// --- Tab strip overflow: edge fade hints + keep active tab in view ---

const TABS_FADE_WIDTH = 24

const tabsScrollRef = ref<HTMLElement | null>(null)
const tabsCanScrollLeft = ref(false)
const tabsCanScrollRight = ref(false)
let tabsScrollObserver: ResizeObserver | null = null

function updateTabsScrollState (): void {
  const el = tabsScrollRef.value
  if (!el) return
  tabsCanScrollLeft.value = el.scrollLeft > 1
  tabsCanScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
}

/** Mask vars drive the edge fade; a 0px stop renders as a hard (invisible) edge. */
const tabsScrollStyle = computed(() => ({
  '--tabs-fade-left': `${tabsCanScrollLeft.value ? TABS_FADE_WIDTH : 0}px`,
  '--tabs-fade-right': `${tabsCanScrollRight.value ? TABS_FADE_WIDTH : 0}px`
}))

function bindTabsScrollObserver (): void {
  if (typeof ResizeObserver === 'undefined') return
  const el = tabsScrollRef.value
  if (!el) return
  tabsScrollObserver?.disconnect()
  tabsScrollObserver = new ResizeObserver(() => updateTabsScrollState())
  tabsScrollObserver.observe(el)
}

function unbindTabsScrollObserver (): void {
  tabsScrollObserver?.disconnect()
  tabsScrollObserver = null
}

/** Scrolls the activated tab into view when the strip overflows. */
async function scrollActiveTabIntoView (): Promise<void> {
  await nextTick()
  const strip = tabsScrollRef.value
  const activeEl = strip?.querySelector<HTMLElement>('.workspace-tab.active')
  if (!strip || !activeEl) return
  const stripRect = strip.getBoundingClientRect()
  const rect = activeEl.getBoundingClientRect()
  const start = rect.left - stripRect.left + strip.scrollLeft
  const end = start + rect.width
  if (start - 12 < strip.scrollLeft) {
    strip.scrollTo({ left: Math.max(0, start - 12), behavior: 'smooth' })
  } else if (end + 12 > strip.scrollLeft + strip.clientWidth) {
    strip.scrollTo({ left: Math.min(strip.scrollWidth - strip.clientWidth, end - strip.clientWidth + 12), behavior: 'smooth' })
  }
}

watch(
  () => props.tabs,
  async () => {
    await nextTick()
    updateTabsScrollState()
  },
  { deep: true }
)
</script>

<template>
  <aside
    v-if="visible"
    ref="panelRoot"
    class="workspace-panel"
    :style="{ width: `${workspaceWidth}px`, flexBasis: `${workspaceWidth}px`, maxWidth: `${workspaceWidth}px` }"
  >
    <div
      class="workspace-resize-handle"
      @mousedown.prevent="startResize"
      @dblclick.prevent="resetToDefaultWidth"
    ></div>

    <div class="workspace-panel-shell">
      <header class="workspace-tab-strip">
        <div
          ref="tabsScrollRef"
          class="workspace-tabs-scroll"
          :style="tabsScrollStyle"
          @scroll.passive="updateTabsScrollState"
        >
          <div
            v-for="tab in tabs"
            :key="tab.id"
            :class="['workspace-tab', { active: tab.id === activeTabId }]"
            role="button"
            tabindex="0"
            :title="getTabLabel(tab)"
            @click="emit('activateTab', tab.id)"
            @keydown.enter.prevent="emit('activateTab', tab.id)"
            @mousedown="onTabMouseDown($event, tab.id)"
            @contextmenu.prevent="openTabContextMenu(tab, $event)"
          >
            <svg class="workspace-tab-icon" viewBox="0 0 24 24" aria-hidden="true" v-html="getTabDefinition(tab)?.icon || ''"></svg>
            <span class="workspace-tab-label">{{ getTabLabel(tab) }}</span>
            <button
              class="workspace-tab-close"
              type="button"
              :title="t('common.close')"
              @click.stop="emit('closeTab', tab.id)"
            >×</button>
          </div>
        </div>

        <div class="workspace-tab-strip-actions">
          <div class="workspace-add-wrap">
            <button
              class="workspace-add-btn"
              type="button"
              :title="t('chatUi.addWorkspaceTab')"
              :disabled="addableDefinitions.length === 0"
              @click="showAddMenu = !showAddMenu"
            >+</button>
            <div v-if="showAddMenu" class="workspace-add-backdrop" @click="showAddMenu = false"></div>
            <div v-if="showAddMenu" class="workspace-add-menu">
              <button
                v-for="definition in addableDefinitions"
                :key="definition.kind"
                class="workspace-add-option"
                type="button"
                @click="handleAddTab(definition.kind)"
              >
                <svg class="workspace-add-option-icon" viewBox="0 0 24 24" aria-hidden="true" v-html="definition.icon"></svg>
                <span>{{ t(definition.titleKey) }}</span>
              </button>
            </div>
          </div>

          <div
            class="workspace-actions-wrap"
            @mouseenter="openTabActions"
            @mouseleave="scheduleCloseTabActions"
          >
            <button
              class="workspace-actions-btn"
              type="button"
              :title="t('chatUi.workspaceTabActions')"
              :disabled="activeTabActions.length === 0"
              @click="showTabActions = !showTabActions"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/>
              </svg>
            </button>
            <div
              v-if="showTabActions"
              class="workspace-actions-menu"
              @mouseenter="openTabActions"
              @mouseleave="scheduleCloseTabActions"
            >
              <button
                v-for="action in activeTabActions"
                :key="action.id"
                class="workspace-actions-option"
                type="button"
                @mousedown.prevent
                @click="runTabAction(action.id)"
              >{{ t(action.labelKey) }}</button>
            </div>
          </div>

          <button class="workspace-panel-close" type="button" :title="t('chatUi.closeWorkspace')" @click="emit('close')">×</button>
        </div>
      </header>

      <div class="workspace-panel-content">
        <KeepAlive>
          <component
            :is="activeTabComponent"
            v-if="activeTab && activeTabComponent"
            ref="tabBodyRef"
            :key="activeTab.id"
            :tab="activeTab"
            :workspace-width="workspaceWidth"
            v-bind="activeTabProps"
            @insert-selection-tag="(tag: string) => emit('insertSelectionTag', tag)"
            @update-workspace="handleTabStateUpdate"
          />
        </KeepAlive>

        <div v-if="!activeTab" class="workspace-panel-empty">
          <div class="workspace-panel-empty-title">{{ t('chatUi.workspaceEmpty') }}</div>
          <div class="workspace-panel-empty-actions">
            <button
              v-for="definition in addableDefinitions"
              :key="definition.kind"
              class="workspace-panel-empty-btn"
              type="button"
              @click="handleAddTab(definition.kind)"
            >
              <svg class="workspace-panel-empty-icon" viewBox="0 0 24 24" aria-hidden="true" v-html="definition.icon"></svg>
              <span>{{ t(definition.titleKey) }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <template v-if="tabContextMenu">
      <div
        class="workspace-tab-context-backdrop"
        @click="closeTabContextMenu"
        @contextmenu.prevent="closeTabContextMenu"
      ></div>
      <div
        class="workspace-tab-context-menu"
        :style="{ left: `${tabContextMenu.x}px`, top: `${tabContextMenu.y}px` }"
      >
        <button class="workspace-tab-context-option" type="button" @click="handleContextCloseTab">
          {{ t('chatUi.closeWorkspaceTab') }}
        </button>
        <button
          class="workspace-tab-context-option"
          type="button"
          :disabled="tabs.length <= 1"
          @click="handleContextCloseOtherTabs"
        >{{ t('chatUi.closeOtherWorkspaceTabs') }}</button>
        <button
          class="workspace-tab-context-option"
          type="button"
          :disabled="contextTabCountToRight === 0"
          @click="handleContextCloseTabsToRight"
        >{{ t('chatUi.closeRightWorkspaceTabs') }}</button>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.workspace-panel {
  position: relative;
  flex: 0 0 auto;
  min-width: 0;
  height: 100%;
  /* The divider is drawn by .workspace-resize-handle (single 1px hairline that
     doubles as the drag affordance) instead of a border here. */
  background: var(--app-panel);
  color: var(--app-text);
  overflow: hidden;
  animation: workspace-panel-enter 0.24s cubic-bezier(0.22, 1, 0.36, 1);
  transform-origin: right center;
}

@keyframes workspace-panel-enter {
  from {
    opacity: 0;
    transform: translateX(18px);
  }

  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.workspace-resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  z-index: 6;
  /* The ::before hairline below is the visible divider; this invisible
     full-height band overlays it so the drag can start anywhere along the seam.
     Narrow enough (8px) to stay clear of the tab strip's 10px inset. */
  width: 8px;
  cursor: ew-resize;
  touch-action: none;
}

/* Hover affordance: the hairline tints accent and thickens to 2px in place. */
.workspace-resize-handle::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--app-border);
  transition: width 0.14s ease, background 0.14s ease;
}

.workspace-resize-handle:hover::before,
.workspace-resize-handle:active::before {
  width: 2px;
  background: color-mix(in srgb, var(--app-accent-strong, #3b82f6) 62%, transparent);
}

.workspace-panel-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.workspace-tab-strip {
  flex: 0 0 auto;
  /* Mirrors ChatHeader's 49px so both top bars and their hairlines align
     across the divider when the workspace is open. */
  height: 49px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px 6px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 55%, transparent);
  background: linear-gradient(180deg, var(--app-panel-subtle), var(--app-panel));
}

.workspace-tabs-scroll {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
  /* Edge fade hints that more tabs lie beyond the visible strip; the custom
     properties jump between 0px (hard edge) and the fade width as overflow
     appears/disappears on each side. Masks paint only — hit targets stay whole. */
  --tabs-fade-left: 0px;
  --tabs-fade-right: 0px;
  -webkit-mask-image: linear-gradient(to right, transparent, #000 var(--tabs-fade-left), #000 calc(100% - var(--tabs-fade-right)), transparent);
  mask-image: linear-gradient(to right, transparent, #000 var(--tabs-fade-left), #000 calc(100% - var(--tabs-fade-right)), transparent);
}

.workspace-tabs-scroll::-webkit-scrollbar {
  display: none;
}

.workspace-tab {
  flex: 0 0 auto;
  max-width: 180px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 6px 0 10px;
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--app-border) 62%, transparent);
  color: var(--app-text-muted);
  cursor: pointer;
  user-select: none;
}

.workspace-tab:hover {
  background: color-mix(in srgb, var(--app-panel-muted) 72%, transparent);
  color: var(--app-text);
}

.workspace-tab.active {
  border-color: color-mix(in srgb, var(--app-accent) 46%, transparent);
  background: color-mix(in srgb, var(--app-accent-soft) 46%, var(--app-panel));
  color: var(--app-text-strong);
}

.workspace-tab-icon {
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
}

.workspace-tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.78rem;
  font-weight: 700;
}

.workspace-tab-close {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  opacity: 0;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}

.workspace-tab:hover .workspace-tab-close,
.workspace-tab.active .workspace-tab-close {
  opacity: 0.75;
}

.workspace-tab-close:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--app-danger) 18%, transparent);
  color: var(--app-text-strong);
}

.workspace-tab-strip-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.workspace-add-wrap,
.workspace-actions-wrap {
  position: relative;
}

.workspace-actions-btn {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  background: color-mix(in srgb, var(--app-panel) 92%, transparent);
  color: var(--app-text-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.workspace-actions-btn:hover:not(:disabled) {
  color: var(--app-text-strong);
  border-color: color-mix(in srgb, var(--app-accent) 36%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 38%, var(--app-panel));
}

.workspace-actions-btn:disabled {
  cursor: default;
  opacity: 0.4;
}

.workspace-actions-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 21;
  min-width: 170px;
  padding: 5px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  background: color-mix(in srgb, var(--app-panel) 97%, transparent);
  backdrop-filter: blur(14px);
  box-shadow: 0 16px 38px rgba(15, 23, 42, 0.24);
}

/* Bridges the 6px gap above the menu so the hover target is continuous. */
.workspace-actions-menu::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -7px;
  height: 7px;
}

.workspace-actions-option {
  width: 100%;
  display: flex;
  align-items: center;
  padding: 8px 10px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--app-text);
  font-size: 0.8rem;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}

.workspace-actions-option:hover {
  background: color-mix(in srgb, var(--app-accent-soft) 46%, transparent);
}

.workspace-tab-context-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}

.workspace-tab-context-menu {
  position: fixed;
  z-index: 41;
  min-width: 176px;
  padding: 5px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  background: color-mix(in srgb, var(--app-panel) 97%, transparent);
  backdrop-filter: blur(14px);
  box-shadow: 0 16px 38px rgba(15, 23, 42, 0.24);
}

.workspace-tab-context-option {
  width: 100%;
  display: flex;
  align-items: center;
  padding: 8px 10px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--app-text);
  font-size: 0.8rem;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}

.workspace-tab-context-option:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-accent-soft) 46%, transparent);
}

.workspace-tab-context-option:disabled {
  cursor: default;
  opacity: 0.4;
}

.workspace-add-btn {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  background: color-mix(in srgb, var(--app-panel) 92%, transparent);
  color: var(--app-text-muted);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}

.workspace-add-btn:hover:not(:disabled) {
  color: var(--app-text-strong);
  border-color: color-mix(in srgb, var(--app-accent) 36%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 38%, var(--app-panel));
}

.workspace-add-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.workspace-add-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
}

.workspace-add-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 21;
  min-width: 180px;
  padding: 5px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  background: color-mix(in srgb, var(--app-panel) 97%, transparent);
  backdrop-filter: blur(14px);
  box-shadow: 0 16px 38px rgba(15, 23, 42, 0.24);
}

.workspace-add-option {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--app-text);
  font-size: 0.8rem;
  text-align: left;
  cursor: pointer;
}

.workspace-add-option:hover {
  background: color-mix(in srgb, var(--app-accent-soft) 46%, transparent);
}

.workspace-add-option-icon {
  width: 16px;
  height: 16px;
  color: var(--app-text-muted);
}

.workspace-panel-close {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  background: color-mix(in srgb, var(--app-panel) 92%, transparent);
  color: var(--app-text-muted);
  font-size: 1.15rem;
  line-height: 1;
  cursor: pointer;
}

.workspace-panel-close:hover {
  color: var(--app-text-strong);
  border-color: color-mix(in srgb, var(--app-accent) 36%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 38%, var(--app-panel));
}

.workspace-panel-content {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.workspace-panel-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
}

.workspace-panel-empty-title {
  color: var(--app-text-muted);
  font-size: 0.88rem;
  font-weight: 700;
}

.workspace-panel-empty-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.workspace-panel-empty-btn {
  min-width: 200px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 36px;
  padding: 0 16px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  background: color-mix(in srgb, var(--app-panel) 92%, transparent);
  color: var(--app-text);
  font-size: 0.82rem;
  font-weight: 700;
  cursor: pointer;
}

.workspace-panel-empty-btn:hover {
  border-color: color-mix(in srgb, var(--app-accent) 36%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 38%, var(--app-panel));
}

.workspace-panel-empty-icon {
  width: 16px;
  height: 16px;
  color: var(--app-text-muted);
}
</style>
