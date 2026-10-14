<script setup lang="ts">
import { nextTick, onActivated, onBeforeUnmount, onMounted, ref } from 'vue'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { PromptEolMarkFilter } from '../../../../../electron/main-process/terminal/terminal-ansi'
import { workspaceStore, workspaceTerminalSurfaces } from '../workspace-store'
import type { WorkspaceTabInstance } from '../tab-registry'

const props = defineProps<{
  /** The owning workspace tab; state carries { cwd, sessionId }. */
  tab: WorkspaceTabInstance
}>()

const emit = defineEmits<{
  (e: 'updateWorkspace', state: Record<string, unknown> | null): void
}>()

const state = props.tab.state as { cwd?: string; sessionId?: string } | undefined
const initialCwd = (state?.cwd || '').trim() || workspaceStore.folderRootPath.value || ''
const persistedSessionId = (state?.sessionId || '').trim()

const hostRef = ref<HTMLDivElement | null>(null)
let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null
let dataCleanup: (() => void) | null = null
let exitCleanup: (() => void) | null = null
let sessionId = ''
let exited = false
/** Streams PTY data through the zsh partial-line-mark filter before display. */
const eolMarkFilter = new PromptEolMarkFilter()

/** Reactive so the container background and xterm palette switch in lockstep. */
const colorScheme = ref<'dark' | 'light'>(currentColorScheme())

/** Canvas palettes; colors mirror the app surfaces of each theme. */
const DARK_PALETTE: ITheme = {
  background: '#1b1f27',
  foreground: '#d7dce5',
  cursor: '#d7dce5',
  selectionBackground: 'rgba(96, 130, 200, 0.35)'
}
const LIGHT_PALETTE: ITheme = {
  background: '#f4f5f9',
  foreground: '#1d2133',
  cursor: '#1d2133',
  selectionBackground: 'rgba(67, 83, 214, 0.22)'
}

/** Resolved theme lands on <html data-theme> (App.vue, async at startup);
 * before it does, follow the same system hint utils/theme.ts uses. */
function currentColorScheme (): 'dark' | 'light' {
  const applied = document.documentElement.dataset.theme
  if (applied === 'light' || applied === 'dark') return applied
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function paletteFor (scheme: 'dark' | 'light'): ITheme {
  return scheme === 'light' ? LIGHT_PALETTE : DARK_PALETTE
}

function persistState (): void {
  emit('updateWorkspace', {
    cwd: initialCwd || undefined,
    sessionId,
    title: props.tab.title
  })
}

function registerSurface (): void {
  if (!sessionId) return
  workspaceTerminalSurfaces.set(props.tab.id, {
    sessionId,
    cwd: initialCwd || ''
  })
}

async function createSession (): Promise<void> {
  if (!window.electronAPI?.createTerminalSession) return
  // A persisted sessionId cannot be revived across app restarts - PTYs are
  // process-bound - so always start a fresh session in the persisted cwd.
  // Columns MUST match the fitted xterm or the shell wraps/misaligns output.
  const info = await window.electronAPI.createTerminalSession({
    cwd: initialCwd || undefined,
    cols: term?.cols || 80,
    rows: term?.rows || 24,
    colorScheme: colorScheme.value
  })
  sessionId = info.id

  if (!props.tab.title) {
    const label = initialCwd ? initialCwd.split(/[\\/]/).filter(Boolean).pop() || initialCwd : 'terminal'
    props.tab.title = `term · ${label}`
  }
  registerSurface()
  persistState()
  void window.electronAPI.setActiveTerminalSession(sessionId)

  dataCleanup = window.electronAPI.onTerminalData(sessionId, event => {
    term?.write(eolMarkFilter.push(event.data))
  })
  exitCleanup = window.electronAPI.onTerminalExit(sessionId, event => {
    if (event.sessionId !== sessionId) return
    exited = true
    term?.write(`\r\n\x1b[90m[${event.exitCode ?? 'exited'}]\x1b[0m\r\n`)
    workspaceTerminalSurfaces.delete(props.tab.id)
  })
}

onMounted(async () => {
  await nextTick()
  const host = hostRef.value
  if (!host) return

  term = new Terminal({
    fontSize: 12.5,
    fontFamily: 'var(--app-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    // Shell/prompt themes tuned for the opposite brightness emit near-invisible
    // text; the renderer lifts any color below WCAG AA contrast so echoes stay
    // readable on either canvas.
    minimumContrastRatio: 4.5,
    theme: paletteFor(colorScheme.value)
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(host)
  try {
    fitAddon.fit()
  } catch {
    // Fit before layout settles can throw; the ResizeObserver retries.
  }

  term.onData(data => {
    if (sessionId && !exited && window.electronAPI?.writeTerminalSession) {
      void window.electronAPI.writeTerminalSession(sessionId, data)
    }
  })

  resizeObserver = new ResizeObserver(() => {
    try {
      fitAddon?.fit()
      if (sessionId && term && !exited && window.electronAPI?.resizeTerminalSession) {
        void window.electronAPI.resizeTerminalSession(sessionId, term.cols, term.rows)
      }
    } catch {
      // Hidden containers cannot fit; retried on activation.
    }
  })
  resizeObserver.observe(host)

  // Theme is applied imperatively to <html data-theme> (utils/theme.ts); live
  // xterm colors must follow it the same way CSS consumers do.
  themeObserver = new MutationObserver(() => {
    colorScheme.value = currentColorScheme()
    if (term) term.options.theme = paletteFor(colorScheme.value)
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  await createSession()
})

onActivated(() => {
  try {
    fitAddon?.fit()
  } catch { /* retried by ResizeObserver */ }
  if (sessionId && !exited && window.electronAPI?.setActiveTerminalSession) {
    void window.electronAPI.setActiveTerminalSession(sessionId)
  }
  registerSurface()
  term?.focus()
})

onBeforeUnmount(() => {
  themeObserver?.disconnect()
  themeObserver = null
  resizeObserver?.disconnect()
  resizeObserver = null
  dataCleanup?.()
  dataCleanup = null
  exitCleanup?.()
  exitCleanup = null
  if (sessionId && window.electronAPI?.killTerminalSession) {
    void window.electronAPI.killTerminalSession(sessionId)
  }
  workspaceTerminalSurfaces.delete(props.tab.id)
  term?.dispose()
  term = null
})

async function clear (): Promise<void> {
  term?.clear()
  term?.focus()
}

async function copyOutput (): Promise<void> {
  if (!sessionId || !window.electronAPI?.snapshotTerminalSession) return
  const snapshot = await window.electronAPI.snapshotTerminalSession(sessionId, { maxChars: 100000 })
  try {
    await navigator.clipboard.writeText(snapshot.text)
  } catch {
    // Clipboard writes can fail without permissions; the action is best-effort.
  }
}

/** Focuses the chat composer; the AI terminal tools operate from there. */
async function aiOperate (): Promise<void> {
  window.dispatchEvent(new CustomEvent('world:focus-composer'))
}

defineExpose({
  clear,
  copyOutput,
  aiOperate
})
</script>

<template>
  <div class="terminal-workspace-tab" :class="{ 'scheme-light': colorScheme === 'light' }">
    <div ref="hostRef" class="terminal-host"></div>
  </div>
</template>

<style scoped>
.terminal-workspace-tab {
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* Must match the active xterm canvas palette exactly — a seam would show
     around the terminal grid. */
  background: #1b1f27;
  overflow: hidden;
  padding: 6px 4px 6px 8px;
}

.terminal-workspace-tab.scheme-light {
  background: #f4f5f9;
}

.terminal-host {
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.terminal-host :deep(.xterm) {
  height: 100%;
  padding: 4px 0;
}

/* xterm.css paints the viewport #000 (so macOS scrollbars read as opaque) and
   only syncs the theme color onto its inner scrollable node — the grid rounds
   down to whole rows, leaving #000 slivers above/below the screen. Transparent
   lets the theme-following container show through instead. */
.terminal-host :deep(.xterm .xterm-viewport) {
  background-color: transparent;
}
</style>
