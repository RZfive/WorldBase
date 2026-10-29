<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import BrowserWebView, { type BrowserContextAddPayload } from '../../app/BrowserWebView.vue'
import { workspaceBrowserSurfaces } from '../workspace-store'
import { addWebQuote } from '../../chat/panel/web-quote-state'
import type { WorkspaceTabInstance } from '../tab-registry'

interface BrowserAppStatePayload {
  appId: string
  url: string
  title: string
  icon?: string
}

interface ProjectRuntimeStatus {
  status?: string
  port?: number
}

const props = defineProps<{
  /** The owning workspace tab; state carries { projectId, name? }. */
  tab: WorkspaceTabInstance
}>()

const emit = defineEmits<{
  (e: 'insertSelectionTag', tag: string): void
}>()

const state = props.tab.state as { projectId?: string; name?: string } | undefined
const projectId = (state?.projectId || '').trim()

const browserRef = ref<InstanceType<typeof BrowserWebView> | null>(null)
const phase = ref<'starting' | 'running' | 'error' | 'missing'>('starting')
const resolvedPort = ref<number | null>(null)
const errorMessage = ref('')
let pollTimer: ReturnType<typeof setInterval> | null = null
let watchTimer: ReturnType<typeof setInterval> | null = null
let disposed = false

const appId = computed(() => `wsb-${props.tab.id}`)
const appUrl = computed(() => (resolvedPort.value ? `http://127.0.0.1:${resolvedPort.value}` : ''))
const projectName = computed(() => (state?.name || '').trim() || props.tab.title || projectId)

if (projectId && !props.tab.title) {
  props.tab.title = projectName.value || 'app'
}

async function fetchStatus (): Promise<ProjectRuntimeStatus | null> {
  if (!projectId || !window.electronAPI?.getProjectStatus) return null
  return await window.electronAPI.getProjectStatus(projectId) as unknown as ProjectRuntimeStatus
}

/** Mirrors the launchpad's openEmbeddedProject flow: start, then wait for a port. */
async function resolveRuntime (allowStart: boolean): Promise<void> {
  if (!projectId) {
    phase.value = 'missing'
    stopPolling()
    workspaceBrowserSurfaces.delete(props.tab.id)
    return
  }

  phase.value = 'starting'
  errorMessage.value = ''
  registerSurface()

  try {
    let status = await fetchStatus()
    if (disposed) return
    if (allowStart && status?.status !== 'running' && window.electronAPI?.startProject) {
      await window.electronAPI.startProject(projectId)
      if (disposed) return
      status = await fetchStatus()
      if (disposed) return
    }
    if (status?.status === 'running' && status.port) {
      resolvedPort.value = status.port
      phase.value = 'running'
      await nextTick()
      if (disposed) return
      registerSurface()
      return
    }

    // Poll up to 15s for the dev server to report a ready port.
    const deadline = Date.now() + 15_000
    pollTimer = setInterval(() => {
      void (async () => {
        const latest = await fetchStatus()
        if (disposed) return
        if (latest?.status === 'running' && latest.port) {
          stopPolling()
          resolvedPort.value = latest.port
          phase.value = 'running'
          await nextTick()
          if (disposed) return
          registerSurface()
          return
        }
        if (Date.now() > deadline) {
          stopPolling()
          phase.value = 'error'
          errorMessage.value = latest?.status || 'timeout'
          workspaceBrowserSurfaces.delete(props.tab.id)
        }
      })()
    }, 1_000)
  } catch (error) {
    if (disposed) return
    stopPolling()
    phase.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : String(error)
    workspaceBrowserSurfaces.delete(props.tab.id)
  }
}

function stopPolling (): void {
  if (pollTimer != null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/** Keeps the URL honest across project restarts (ports are re-allocated). */
function startRuntimeWatch (): void {
  if (watchTimer != null || !projectId) return
  watchTimer = setInterval(() => {
    if (phase.value !== 'running') return
    void (async () => {
      const latest = await fetchStatus()
      if (disposed) return
      if (latest?.status === 'running' && latest.port && latest.port !== resolvedPort.value) {
        resolvedPort.value = latest.port
        await nextTick()
        if (disposed) return
        registerSurface()
      } else if (latest?.status && latest.status !== 'running' && latest.status !== 'starting') {
        phase.value = 'error'
        errorMessage.value = latest.status
        workspaceBrowserSurfaces.delete(props.tab.id)
      }
    })()
  }, 5_000)
}

function registerSurface (): void {
  if (disposed || phase.value === 'error' || phase.value === 'missing') return
  workspaceBrowserSurfaces.set(props.tab.id, {
    kind: 'project',
    url: appUrl.value || '',
    title: projectName.value,
    handle: browserRef.value
  })
}

function handleStateChange (payload: BrowserAppStatePayload): void {
  if (disposed || phase.value !== 'running') return
  if (!props.tab.state) props.tab.state = {}
  props.tab.state.port = resolvedPort.value
  workspaceBrowserSurfaces.set(props.tab.id, {
    kind: 'project',
    url: payload.url || appUrl.value,
    title: projectName.value,
    handle: browserRef.value
  })
}

onMounted(async () => {
  await nextTick()
  if (disposed) return
  registerSurface()
  void resolveRuntime(true)
  startRuntimeWatch()
})

watch(browserRef, (handle) => {
  if (handle) registerSurface()
})

watch(appUrl, () => {
  registerSurface()
})

onActivated(() => {
  // Returning to the tab re-validates the runtime before the surface is used.
  if (phase.value === 'running') registerSurface()
})

onBeforeUnmount(() => {
  disposed = true
  stopPolling()
  if (watchTimer != null) {
    clearInterval(watchTimer)
    watchTimer = null
  }
  workspaceBrowserSurfaces.delete(props.tab.id)
})

/** Parks captured app page content and appends a `[[web:]]` tag to the composer. */
function handleContextAdd (payload: BrowserContextAddPayload): void {
  const tag = addWebQuote({
    url: payload.url,
    title: payload.title,
    kind: payload.kind,
    text: payload.text,
    selector: payload.selector,
    tag: payload.tag
  })
  emit('insertSelectionTag', tag)
}

/** Focuses the chat composer; the page tools operate on this tab from there. */
async function aiOperate (): Promise<void> {
  window.dispatchEvent(new CustomEvent('world:focus-composer'))
}

async function reload (): Promise<void> {
  await resolveRuntime(true)
  browserRef.value?.reload?.()
}

async function copyUrl (): Promise<void> {
  if (!appUrl.value) return
  try {
    await navigator.clipboard.writeText(appUrl.value)
  } catch {
    // Clipboard writes can fail without permissions; the action is best-effort.
  }
}

defineExpose({
  reload,
  copyUrl,
  aiOperate
})
</script>

<template>
  <div class="project-app-workspace-tab">
    <template v-if="phase === 'running' && appUrl">
      <BrowserWebView
        ref="browserRef"
        :app-id="appId"
        :url="appUrl"
        :title="projectName"
        @state-change="handleStateChange"
        @context-add="handleContextAdd"
        @ai-operate-request="aiOperate"
      />
    </template>

    <div v-else-if="phase === 'starting'" class="project-app-state">
      <span class="project-app-spinner">⏳</span>
      <p>{{ $t('chatUi.projectAppStarting', { name: projectName }) }}</p>
    </div>

    <div v-else class="project-app-state">
      <p>
        {{ phase === 'missing'
          ? $t('chatUi.projectAppMissing')
          : $t('chatUi.projectAppStartFailed', { name: projectName }) }}
      </p>
      <p v-if="errorMessage" class="project-app-error">{{ errorMessage }}</p>
      <button class="project-app-retry-btn" type="button" @click="resolveRuntime(true)">
        🔄 {{ $t('common.retry') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.project-app-workspace-tab {
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--app-panel);
  overflow: hidden;
}

.project-app-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  color: var(--app-text-muted);
  text-align: center;
}

.project-app-spinner {
  font-size: 1.6rem;
}

.project-app-error {
  max-width: 80%;
  overflow-wrap: anywhere;
  font-size: 0.78rem;
  opacity: 0.75;
}

.project-app-retry-btn {
  padding: 8px 16px;
  border: 1px solid var(--app-border-strong);
  border-radius: 10px;
  background: var(--app-panel-muted);
  color: var(--app-text-strong);
  cursor: pointer;
}
</style>
