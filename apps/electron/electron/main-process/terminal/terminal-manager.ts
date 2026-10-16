import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import { broadcastToAppWindows } from '../windows.js'
import { buildTerminalSnapshot } from './terminal-ansi.js'

/**
 * TerminalManager — 主进程 PTY 会话池
 *
 * 工作区终端 tab 通过 IPC 在这里创建/读写会话；Rust 宿主请求
 * `terminal_automation` 也直达这里（read/write 激活会话），因此 AI 与
 * 用户共享同一 PTY——AI 敲的每条命令用户在终端 tab 里全程可见。
 */

const SCROLLBACK_CHAR_LIMIT = 200_000
const MAX_SESSIONS = 12

export interface TerminalSessionCreateOptions {
  cwd?: string
  cols?: number
  rows?: number
  /** Brightness of the creating xterm canvas; selects the spawn-time COLORFGBG. */
  colorScheme?: 'dark' | 'light'
}

export interface TerminalSessionInfo {
  id: string
  cwd: string
  cols: number
  rows: number
  active: boolean
  exited: boolean
  exitCode: number | null
  createdAt: number
}

export interface TerminalSnapshotRequest {
  lines?: number
  maxChars?: number
}

export interface TerminalSnapshot extends TerminalSessionInfo {
  text: string
  truncated: boolean
}

export interface TerminalWriteRequest {
  text: string
  execute?: boolean
  waitMs?: number
  maxChars?: number
}

export interface TerminalWriteResult {
  ok: boolean
  sessionId: string
  wrote: number
  output?: TerminalSnapshot
}

interface InternalSession {
  info: TerminalSessionInfo
  pty: pty.IPty | null
  scrollback: string
}

function resolveShell (): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe'
  return process.env.SHELL || '/bin/zsh'
}

export class TerminalManager {
  private sessions = new Map<string, InternalSession>()
  private activeSessionId: string | null = null

  listSessions (): TerminalSessionInfo[] {
    return [...this.sessions.values()].map(session => ({ ...session.info }))
  }

  getSession (id: string): TerminalSessionInfo | null {
    const session = this.sessions.get(id)
    return session ? { ...session.info } : null
  }

  getActiveSession (): TerminalSessionInfo | null {
    if (!this.activeSessionId) return null
    return this.getSession(this.activeSessionId)
  }

  setActive (id: string | null): void {
    if (id !== null && !this.sessions.has(id)) return
    this.activeSessionId = id
    for (const session of this.sessions.values()) {
      session.info.active = session.info.id === id
    }
  }

  createSession (options: TerminalSessionCreateOptions = {}): TerminalSessionInfo {
    if (this.sessions.size >= MAX_SESSIONS) {
      // Drop the oldest exited session first; otherwise refuse.
      const exited = [...this.sessions.values()].filter(session => session.info.exited)
      if (exited.length > 0) {
        this.disposeSession(exited[0].info.id, false)
      } else {
        throw new Error('Too many terminal sessions open')
      }
    }

    const cwd = this.resolveCwd(options.cwd)
    const cols = Math.min(500, Math.max(20, Math.floor(options.cols || 80)))
    const rows = Math.min(200, Math.max(5, Math.floor(options.rows || 24)))
    const id = randomUUID()

    const ptyProcess = pty.spawn(resolveShell(), [], {
      name: 'xterm-256color',
      cwd,
      cols,
      rows,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        // 如实声明画布明暗（15;0=浅字深底，0;15=深字浅底），覆盖从宿主终端
        // 泄漏进来的旧值，自适应 shell 主题与 vim 等据此选择文字颜色。会话
        // 中途切换主题时 env 无法改写，程序靠 OSC 11 查询拿到实时背景色；
        // 不自适应的主题由渲染端 minimumContrastRatio 兜底。
        COLORFGBG: options.colorScheme === 'light' ? '0;15' : '15;0'
      } as Record<string, string>
    })

    const session: InternalSession = {
      info: {
        id,
        cwd,
        cols,
        rows,
        active: false,
        exited: false,
        exitCode: null,
        createdAt: Date.now()
      },
      pty: ptyProcess,
      scrollback: ''
    }
    this.sessions.set(id, session)

    ptyProcess.onData(data => {
      session.scrollback = appendCapped(session.scrollback, data, SCROLLBACK_CHAR_LIMIT)
      broadcastToAppWindows(`terminal:data:${id}`, { sessionId: id, data })
    })
    ptyProcess.onExit(({ exitCode }) => {
      session.info.exited = true
      session.info.exitCode = exitCode
      session.pty = null
      broadcastToAppWindows(`terminal:exit:${id}`, { sessionId: id, exitCode })
      if (this.activeSessionId === id) this.activeSessionId = null
    })

    return { ...session.info }
  }

  write (id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session) throw new Error('Terminal session not found')
    if (session.info.exited || !session.pty) throw new Error('Terminal session has exited')
    session.pty.write(data)
  }

  resize (id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    const safeCols = Math.min(500, Math.max(20, Math.floor(cols)))
    const safeRows = Math.min(200, Math.max(5, Math.floor(rows)))
    session.info.cols = safeCols
    session.info.rows = safeRows
    try {
      session.pty?.resize(safeCols, safeRows)
    } catch {
      // Resizing a mid-exit PTY can throw; the next session is unaffected.
    }
  }

  kill (id: string): void {
    this.disposeSession(id, true)
  }

  snapshot (id: string, request: TerminalSnapshotRequest = {}): TerminalSnapshot {
    const session = this.sessions.get(id)
    if (!session) throw new Error('Terminal session not found')
    const { text, truncated } = buildTerminalSnapshot(session.scrollback, request)
    return { ...session.info, text, truncated }
  }

  /** AI entry point: reads the active session (cwd + cleaned output tail). */
  readActiveTerminal (request: TerminalSnapshotRequest = {}): TerminalSnapshot {
    const active = this.getActiveSession()
    if (!active) throw new Error('No active terminal session')
    return this.snapshot(active.id, request)
  }

  /** AI entry point: writes to the active session and optionally waits for output. */
  async writeActiveTerminal (request: TerminalWriteRequest): Promise<TerminalWriteResult> {
    const active = this.getActiveSession()
    if (!active) throw new Error('No active terminal session')

    const session = this.sessions.get(active.id)!
    // Empty text types nothing: the call is a wait-only poll for output of an
    // already-running command (matches the Rust tool contract).
    const text = request.text ? (request.execute ? `${request.text}\r` : request.text) : ''
    const before = session.scrollback.length
    if (text) this.write(active.id, text)

    const waitMs = Math.min(120_000, Math.max(0, Math.floor(request.waitMs ?? 0)))
    if (waitMs === 0) {
      return { ok: true, sessionId: active.id, wrote: text.length }
    }

    await new Promise<void>(resolve => { setTimeout(resolve, waitMs) })
    const raw = session.scrollback.slice(before)
    const { text: output, truncated } = buildTerminalSnapshot(raw, { maxChars: request.maxChars })
    return {
      ok: true,
      sessionId: active.id,
      wrote: text.length,
      output: { ...session.info, text: output, truncated }
    }
  }

  disposeAll (): void {
    for (const id of [...this.sessions.keys()]) {
      this.disposeSession(id, true)
    }
  }

  private disposeSession (id: string, broadcast: boolean): void {
    const session = this.sessions.get(id)
    if (!session) return
    try {
      session.pty?.kill()
    } catch {
      // Already dead.
    }
    session.pty = null
    session.info.exited = true
    this.sessions.delete(id)
    if (this.activeSessionId === id) this.activeSessionId = null
    if (broadcast) {
      broadcastToAppWindows(`terminal:exit:${id}`, { sessionId: id, exitCode: null })
    }
  }

  private resolveCwd (requested?: string): string {
    const fallback = os.homedir()
    if (!requested || !path.isAbsolute(requested)) return fallback
    return requested
  }
}

function appendCapped (current: string, chunk: string, limit: number): string {
  const next = current + chunk
  if (next.length <= limit) return next
  return next.slice(next.length - limit)
}
