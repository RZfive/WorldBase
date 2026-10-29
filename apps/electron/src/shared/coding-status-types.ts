export type CodingPhase =
  | 'idle'
  | 'plan'
  | 'inspect'
  | 'edit'
  | 'verify'
  | 'diagnose'
  | 'repair'
  | 'complete'
  | 'blocked'

export type CodingDiagnosticSeverity = 'error' | 'warning' | 'info'

export interface CodingDiagnostic {
  severity: CodingDiagnosticSeverity
  message: string
  code?: string
  file?: string
  line?: number
  column?: number
  confidence?: number
  raw?: string
}

export interface CodingCommandOutcome {
  kind: string
  program: string
  args: string[]
  exitCode?: number
  timedOut: boolean
  cancelled: boolean
  durationMs: number
  stdout?: string
  stderr?: string
}

export interface CodingDependencyIssue {
  kind: string
  package?: string
  message: string
  command?: string
}

export interface CodingStatus {
  phase: CodingPhase
  repairRound: number
  maxRepairRounds?: number
  verificationAttempts: number
  changedFiles: string[]
  commands: CodingCommandOutcome[]
  diagnostics: CodingDiagnostic[]
  dependencyIssues: CodingDependencyIssue[]
  repairInstructions: string[]
  stopReason?: string
  summary?: string
  updatedAt: number
}

export interface CodingDiffChange {
  operation: string
  before: string
  after: string
  startByte?: number
  endByte?: number
}

export interface CodingDiffFile {
  filePath: string
  operationCount: number
  changes: CodingDiffChange[]
}

export interface CodingDiffState {
  files: CodingDiffFile[]
  updatedAt: number
}

/** Diagnostics below this confidence are advisory, never auto-applied. */
export const CODING_CONFIDENCE_SUGGESTION_THRESHOLD = 0.75

/** i18n keys for the stop reasons produced by the coding harness. */
export const CODING_STOP_REASON_LABEL_KEYS: Record<string, string> = {
  verificationPassed: 'chatUi.codingStopVerificationPassed',
  verificationFailed: 'chatUi.codingStopVerificationFailed',
  maxRepairRounds: 'chatUi.codingStopMaxRepairRounds',
  repeatedFailure: 'chatUi.codingStopRepeatedFailure',
  noRepairableIssue: 'chatUi.codingStopNoRepairableIssue',
  verificationUnavailable: 'chatUi.codingStopVerificationUnavailable',
  budgetExhausted: 'chatUi.codingStopBudgetExhausted',
  cancelled: 'chatUi.codingStopCancelled',
  nonRecoverable: 'chatUi.codingStopNonRecoverable'
}

const ACTIVE_CODING_PHASES: ReadonlySet<CodingPhase> = new Set([
  'plan',
  'inspect',
  'edit',
  'verify',
  'diagnose',
  'repair'
])

const RETRYABLE_CODING_STOP_REASONS: ReadonlySet<string> = new Set([
  'verificationFailed',
  'maxRepairRounds',
  'repeatedFailure',
  'noRepairableIssue',
  'verificationUnavailable',
  'budgetExhausted',
  'cancelled',
  'nonRecoverable'
])

export function isCodingStatusActive (status: CodingStatus | null | undefined): boolean {
  return status != null && ACTIVE_CODING_PHASES.has(status.phase)
}

export function isCodingStatusRetryable (status: CodingStatus | null | undefined): boolean {
  if (!status) return false
  if (status.phase === 'blocked') return true
  if (status.phase === 'complete' || status.phase === 'idle') return false
  return status.stopReason != null && RETRYABLE_CODING_STOP_REASONS.has(status.stopReason)
}

export function isLowConfidenceDiagnostic (diagnostic: CodingDiagnostic): boolean {
  return diagnostic.confidence != null &&
    diagnostic.confidence < CODING_CONFIDENCE_SUGGESTION_THRESHOLD
}

/**
 * A user stop ends the active coding run without pretending verification
 * passed or failed. Completed/blocked runs keep their terminal state.
 */
export function codingStatusForCancelledRun (
  previous: CodingStatus | null | undefined
): CodingStatus | null {
  if (!previous) return null
  if (previous.phase === 'complete' || previous.phase === 'blocked') return previous
  return {
    ...previous,
    phase: 'blocked',
    stopReason: 'cancelled',
    updatedAt: Date.now()
  }
}
