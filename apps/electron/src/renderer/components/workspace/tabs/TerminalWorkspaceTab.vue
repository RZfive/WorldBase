<script setup lang="ts">
import { nextTick, onActivated, onBeforeUnmount, onMounted, ref } from 'vue'
import { Terminal } from '@xterm/xterm'
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
let dataCleanup: (() => void) | null = null
let exitCleanup: (() => void) | null = null
let sessionId = ''
let exited = false
/** Streams PTY data through the zsh partial-line-mark filter before display. */
const eolMarkFilter = new PromptEolMarkFilter()

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
    rows: term?.rows || 24
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
    theme: {
      background: '#1b1f27',
      foreground: '#d7dce5',
      cursor: '#d7dce5',
      selectionBackground: 'rgba(96, 130, 200, 0.35)'
    }
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
  <div class="terminal-workspace-tab">
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
  background: #1b1f27;
  overflow: hidden;
  padding: 6px 4px 6px 8px;
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
</style>
