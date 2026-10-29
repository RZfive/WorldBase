import type {
  CodingCommandOutcome,
  CodingDependencyIssue,
  CodingDiagnostic,
  CodingDiffChange,
  CodingDiffFile,
  CodingDiffState,
  CodingPhase,
  CodingStatus
} from '../../../../shared/coding-status-types.js'

/**
 * Renderer-side persistence for the coding status/diff surfaces. Runs are
 * keyed by conversation so reopening a conversation (or reloading the window)
 * restores the last known diagnostics instead of dropping them.
 */
export const CODING_STATE_STORAGE_PREFIX = 'worldbase.coding-state.v1:'
export const MAX_CODING_DIFF_BYTES = 256 * 1024
export const CODING_STATE_SAVE_DEBOUNCE_MS = 250

const CODING_PHASES: ReadonlySet<CodingPhase> = new Set([
  'idle',
  'plan',
  'inspect',
  'edit',
  'verify',
  'diagnose',
  'repair',
  'complete',
  'blocked'
])

const EMPTY_SNAPSHOT: CodingStateSnapshot = { status: null, diff: null }
const pendingSaves = new Map<string, { snapshot: CodingStateSnapshot; timer: ReturnType<typeof setTimeout> }>()

export interface CodingStateSnapshot {
  status: CodingStatus | null
  diff: CodingDiffState | null
}

interface PersistedCodingState extends CodingStateSnapshot {
  version: 1
  savedAt: number
}

interface CodingStorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function toFiniteNumber (value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function toNonNegativeInteger (value: unknown, fallback: number): number {
  const numeric = toFiniteNumber(value, fallback)
  return numeric >= 0 ? Math.floor(numeric) : fallback
}

function optionalFiniteNumber (value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalString (value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function stringArray (value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function sanitizeCommand (value: unknown): CodingCommandOutcome | null {
  if (!isRecord(value) || typeof value.program !== 'string') return null
  return {
    kind: typeof value.kind === 'string' ? value.kind : 'command',
    program: value.program,
    args: stringArray(value.args),
    ...(optionalFiniteNumber(value.exitCode) != null ? { exitCode: optionalFiniteNumber(value.exitCode) } : {}),
    timedOut: value.timedOut === true,
    cancelled: value.cancelled === true,
    durationMs: Math.max(0, toFiniteNumber(value.durationMs, 0)),
    ...(optionalString(value.stdout) != null ? { stdout: optionalString(value.stdout) } : {}),
    ...(optionalString(value.stderr) != null ? { stderr: optionalString(value.stderr) } : {})
  }
}

function sanitizeDiagnostic (value: unknown): CodingDiagnostic | null {
  if (!isRecord(value) || typeof value.message !== 'string') return null
  const severity = value.severity === 'error' || value.severity === 'warning' || value.severity === 'info'
    ? value.severity
    : 'info'
  return {
    severity,
    message: value.message,
    ...(optionalString(value.code) != null ? { code: optionalString(value.code) } : {}),
    ...(optionalString(value.file) != null ? { file: optionalString(value.file) } : {}),
    ...(optionalFiniteNumber(value.line) != null ? { line: optionalFiniteNumber(value.line) } : {}),
    ...(optionalFiniteNumber(value.column) != null ? { column: optionalFiniteNumber(value.column) } : {}),
    ...(optionalFiniteNumber(value.confidence) != null ? { confidence: optionalFiniteNumber(value.confidence) } : {}),
    ...(optionalString(value.raw) != null ? { raw: optionalString(value.raw) } : {})
  }
}

function sanitizeDependencyIssue (value: unknown): CodingDependencyIssue | null {
  if (!isRecord(value) || typeof value.message !== 'string') return null
  return {
    kind: typeof value.kind === 'string' ? value.kind : 'unknown',
    message: value.message,
    ...(optionalString(value.package) != null ? { package: optionalString(value.package) } : {}),
    ...(optionalString(value.command) != null ? { command: optionalString(value.command) } : {})
  }
}

export function sanitizeCodingStatus (value: unknown): CodingStatus | null {
  if (!isRecord(value) || typeof value.phase !== 'string') return null
  if (!CODING_PHASES.has(value.phase as CodingPhase)) return null
  const maxRepairRounds = optionalFiniteNumber(value.maxRepairRounds)
  return {
    phase: value.phase as CodingPhase,
    repairRound: toNonNegativeInteger(value.repairRound, 0),
    ...(maxRepairRounds != null ? { maxRepairRounds } : {}),
    verificationAttempts: toNonNegativeInteger(value.verificationAttempts, 0),
    changedFiles: stringArray(value.changedFiles),
    commands: Array.isArray(value.commands)
      ? value.commands.map(sanitizeCommand).filter((item): item is CodingCommandOutcome => item != null)
      : [],
    diagnostics: Array.isArray(value.diagnostics)
      ? value.diagnostics.map(sanitizeDiagnostic).filter((item): item is CodingDiagnostic => item != null)
      : [],
    dependencyIssues: Array.isArray(value.dependencyIssues)
      ? value.dependencyIssues.map(sanitizeDependencyIssue).filter((item): item is CodingDependencyIssue => item != null)
      : [],
    repairInstructions: stringArray(value.repairInstructions),
    ...(optionalString(value.stopReason) != null ? { stopReason: optionalString(value.stopReason) } : {}),
    ...(optionalString(value.summary) != null ? { summary: optionalString(value.summary) } : {}),
    updatedAt: Math.max(0, toFiniteNumber(value.updatedAt, 0))
  }
}

function sanitizeDiffChange (value: unknown): CodingDiffChange | null {
  if (!isRecord(value) || typeof value.before !== 'string' || typeof value.after !== 'string') return null
  return {
    operation: typeof value.operation === 'string' ? value.operation : 'change',
    before: value.before,
    after: value.after,
    ...(optionalFiniteNumber(value.startByte) != null ? { startByte: optionalFiniteNumber(value.startByte) } : {}),
    ...(optionalFiniteNumber(value.endByte) != null ? { endByte: optionalFiniteNumber(value.endByte) } : {})
  }
}

function sanitizeDiffFile (value: unknown): CodingDiffFile | null {
  if (!isRecord(value) || typeof value.filePath !== 'string' || !value.filePath.trim()) return null
  const changes = Array.isArray(value.changes)
    ? value.changes.map(sanitizeDiffChange).filter((item): item is CodingDiffChange => item != null)
    : []
  return {
    filePath: value.filePath,
    operationCount: toNonNegativeInteger(value.operationCount, changes.length),
    changes
  }
}

export function sanitizeCodingDiffState (value: unknown): CodingDiffState | null {
  if (!isRecord(value) || !Array.isArray(value.files)) return null
  return {
    files: value.files.map(sanitizeDiffFile).filter((item): item is CodingDiffFile => item != null),
    updatedAt: Math.max(0, toFiniteNumber(value.updatedAt, 0))
  }
}

function byteLength (value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length
  return value.length * 2
}

/** Keeps the newest diff files while staying under the localStorage budget. */
export function capCodingDiffState (
  value: unknown,
  maxBytes = MAX_CODING_DIFF_BYTES
): CodingDiffState | null {
  const sanitized = sanitizeCodingDiffState(value)
  if (!sanitized) return null
  const candidate: CodingDiffState = {
    updatedAt: sanitized.updatedAt,
    files: sanitized.files.map(file => ({ ...file, changes: [...file.changes] }))
  }

  while (true) {
    if (byteLength(JSON.stringify(candidate)) <= maxBytes) return candidate
    if (candidate.files.length > 1) {
      candidate.files.shift()
      continue
    }
    const onlyFile = candidate.files[0]
    if (onlyFile && onlyFile.changes.length > 0) {
      onlyFile.changes.shift()
      continue
    }
    return null
  }
}

export function encodeCodingState (
  snapshot: CodingStateSnapshot,
  maxDiffBytes = MAX_CODING_DIFF_BYTES
): string | null {
  const status = sanitizeCodingStatus(snapshot.status)
  const diff = capCodingDiffState(snapshot.diff, maxDiffBytes)
  if (!status && !diff) return null
  const payload: PersistedCodingState = {
    version: 1,
    savedAt: Date.now(),
    status,
    diff
  }
  return JSON.stringify(payload)
}

/** Accepts the current envelope plus legacy direct/aliased payload shapes. */
export function decodeCodingState (raw: string | null | undefined): CodingStateSnapshot {
  if (!raw) return { ...EMPTY_SNAPSHOT }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...EMPTY_SNAPSHOT }
  }
  if (!isRecord(parsed)) return { ...EMPTY_SNAPSHOT }

  const statusCandidate = parsed.status ?? parsed.codingStatus ??
    (typeof parsed.phase === 'string' ? parsed : null)
  const diffCandidate = parsed.diff ?? parsed.codingDiff ??
    (Array.isArray(parsed.files) ? parsed : null)

  return {
    status: sanitizeCodingStatus(statusCandidate),
    diff: sanitizeCodingDiffState(diffCandidate)
  }
}

export function codingStateStorageKey (conversationId: string): string {
  return `${CODING_STATE_STORAGE_PREFIX}${encodeURIComponent(conversationId)}`
}

function resolveStorage (): CodingStorageLike | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  } catch {
    return null
  }
  return null
}

export function loadCodingState (
  conversationId: string,
  storage: CodingStorageLike | null = resolveStorage()
): CodingStateSnapshot {
  if (!conversationId || !storage) return { ...EMPTY_SNAPSHOT }
  try {
    return decodeCodingState(storage.getItem(codingStateStorageKey(conversationId)))
  } catch {
    return { ...EMPTY_SNAPSHOT }
  }
}

export function saveCodingStateNow (
  conversationId: string,
  snapshot: CodingStateSnapshot,
  storage: CodingStorageLike | null = resolveStorage()
): void {
  if (!conversationId || !storage) return
  const key = codingStateStorageKey(conversationId)
  const raw = encodeCodingState(snapshot)
  try {
    if (!raw) {
      storage.removeItem(key)
      return
    }
    storage.setItem(key, raw)
  } catch {
    // Quota or security errors should never break streaming. Retry with the
    // status only so diagnostics survive even when a large diff does not.
    try {
      const statusOnly = encodeCodingState({ status: snapshot.status, diff: null })
      if (statusOnly) storage.setItem(key, statusOnly)
      else storage.removeItem(key)
    } catch {
      // Give up silently; the in-memory maps remain authoritative for the run.
    }
  }
}

export function scheduleCodingStateSave (
  conversationId: string,
  snapshot: CodingStateSnapshot,
  delayMs = CODING_STATE_SAVE_DEBOUNCE_MS
): void {
  if (!conversationId) return
  const pending = pendingSaves.get(conversationId)
  if (pending) {
    pending.snapshot = snapshot
    return
  }
  const timer = setTimeout(() => {
    const current = pendingSaves.get(conversationId)
    pendingSaves.delete(conversationId)
    if (current) saveCodingStateNow(conversationId, current.snapshot)
  }, delayMs)
  pendingSaves.set(conversationId, { snapshot, timer })
}

export function flushCodingStateSave (conversationId: string): void {
  const pending = pendingSaves.get(conversationId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingSaves.delete(conversationId)
  saveCodingStateNow(conversationId, pending.snapshot)
}

export function clearCodingState (conversationId: string): void {
  if (!conversationId) return
  const pending = pendingSaves.get(conversationId)
  if (pending) {
    clearTimeout(pending.timer)
    pendingSaves.delete(conversationId)
  }
  const storage = resolveStorage()
  if (!storage) return
  try {
    storage.removeItem(codingStateStorageKey(conversationId))
  } catch {
    // Ignore storage failures; clearing the in-memory map still resets the UI.
  }
}
