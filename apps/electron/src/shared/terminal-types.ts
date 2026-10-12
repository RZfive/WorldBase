/** Shared shapes for workspace terminal sessions (main ↔ renderer). */

export interface TerminalSessionCreateOptions {
  cwd?: string
  cols?: number
  rows?: number
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

export interface TerminalDataEvent {
  sessionId: string
  data: string
}

export interface TerminalExitEvent {
  sessionId: string
  exitCode: number | null
}

/** Summary of the active terminal, attached to chat streams for prompt injection. */
export interface ActiveTerminalContext {
  sessionId: string
  cwd: string
}
