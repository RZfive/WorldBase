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
