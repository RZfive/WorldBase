<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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

const props = defineProps<{
  /** The owning workspace tab; state carries { url, title }. */
  tab: WorkspaceTabInstance
}>()

const emit = defineEmits<{
  (e: 'insertSelectionTag', tag: string): void
}>()

const state = props.tab.state as { url?: string; title?: string } | undefined
const initialUrl = (state?.url || 'about:blank').trim() || 'about:blank'
const initialTitle = (state?.title || '').trim()

const browserRef = ref<InstanceType<typeof BrowserWebView> | null>(null)
let disposed = false

const appId = computed(() => `wsb-${props.tab.id}`)
const url = computed(() => initialUrl)
const title = computed(() => initialTitle)

function registerSurface (): void {
  if (disposed) return
  workspaceBrowserSurfaces.set(props.tab.id, {
    kind: 'browser',
    url: initialUrl,
    title: initialTitle || initialUrl,
    handle: browserRef.value
  })
}

/** Keeps the tab strip label and the panel's active-page surface in sync. */
function handleStateChange (payload: BrowserAppStatePayload): void {
  if (disposed) return
  if (!props.tab.state) props.tab.state = {}
  props.tab.state.url = payload.url
  props.tab.title = payload.title || payload.url || props.tab.id
  workspaceBrowserSurfaces.set(props.tab.id, {
    kind: 'browser',
    url: payload.url,
    title: props.tab.title,
    handle: browserRef.value
  })
}

onMounted(async () => {
  await nextTick()
  if (disposed) return
  registerSurface()
})

watch(browserRef, (handle) => {
  if (handle) registerSurface()
})

onBeforeUnmount(() => {
  disposed = true
  workspaceBrowserSurfaces.delete(props.tab.id)
})

async function reload (): Promise<void> {
  browserRef.value?.reload?.()
}

async function copyUrl (): Promise<void> {
  const url = (props.tab.state?.url as string | undefined) || initialUrl
  try {
    await navigator.clipboard.writeText(url)
  } catch {
    // Clipboard writes can fail without permissions; the action is best-effort.
  }
}

/** Parks the captured page content and appends a `[[web:]]` tag to the composer. */
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

defineExpose({
  reload,
  copyUrl,
  aiOperate
})
</script>

<template>
  <div class="browser-workspace-tab">
    <BrowserWebView
      ref="browserRef"
      :app-id="appId"
      :url="url"
      :title="title"
      @state-change="handleStateChange"
      @context-add="handleContextAdd"
      @ai-operate-request="aiOperate"
    />
  </div>
</template>

<style scoped>
.browser-workspace-tab {
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--app-panel);
  overflow: hidden;
}
</style>
