export type LongTermGoalStatus = 'active' | 'paused' | 'completed' | 'archived'
export type LongTermGoalRunStatus = 'running' | 'reviewing' | 'completed' | 'failed'
export type LongTermGoalNotificationLevel = 'silent' | 'badge' | 'notify'
export type LongTermGoalActivityActor = 'ai' | 'user' | 'system' | 'tool'
export type LongTermGoalActivityType =
  | 'goal_created'
  | 'goal_changed'
  | 'run_started'
  | 'task_completed'
  | 'gap_found'
  | 'plan_updated'
  | 'memory_written'
  | 'memory_compacted'
  | 'user_decision'
  | 'blocked'
  | 'milestone_completed'
  | 'review_completed'

export type LongTermGoalMemoryKind =
  | 'goal_profile'
  | 'execution_brief'
  | 'achievement'
  | 'skill'
  | 'progress_summary'
  | 'daily_review'
  | 'decision'
  | 'blocker'
  | 'plan'
  | 'artifact'

export type LongTermGoalSchedule =
  | {
    kind: 'once'
    runAt: string
  }
  | {
    kind: 'interval'
    everyMinutes: number
    startAt?: string
  }
  | {
    kind: 'daily'
    timeOfDay: string
  }
  | {
    kind: 'weekly'
    weekdays: number[]
    timeOfDay: string
  }
  | {
    kind: 'dates'
    dates: string[]
  }

export interface LongTermGoalNextTask {
  id: string
  title: string
  reason?: string
  priority: 'high' | 'medium' | 'low'
  status: 'todo' | 'running' | 'done' | 'skipped'
  dueAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface LongTermGoalInterventionQuestion {
  id: string
  question: string
  options: string[]
  reason?: string
}

export interface LongTermGoalIntervention {
  id: string
  goalId: string
  status: 'open' | 'answered' | 'dismissed'
  severity: 'decision' | 'blocked' | 'authorization' | 'info'
  title: string
  summary: string
  questions: LongTermGoalInterventionQuestion[]
  createdAt: string
  resolvedAt?: string | null
}

export interface LongTermGoalDefinition {
  id: string
  title: string
  objective: string
  status: LongTermGoalStatus
  providerId?: string | null
  modelId?: string | null
  schedule: LongTermGoalSchedule
  scheduleTaskId?: string | null
  reviewScheduleTaskId?: string | null
  dailyReviewTimeOfDay?: string
  selectedSkillIds: string[]
  selectedMcpServerIds: string[]
  notificationPolicy: 'minimal' | 'normal'
  currentPhase?: string
  progressSummary?: string
  gapSummary?: string
  todayFocus?: string
  nextRunAt?: string | null
  nextReviewAt?: string | null
  lastRunAt?: string | null
  lastReviewAt?: string | null
  lastRunStatus?: LongTermGoalRunStatus | null
  nextTasks: LongTermGoalNextTask[]
  openInterventions: LongTermGoalIntervention[]
  memorySummary?: string
  createdAt: string
  updatedAt: string
}

export interface LongTermGoalActivityArtifact {
  kind: 'file' | 'url' | 'report' | 'memory' | 'conversation' | 'task'
  title: string
  ref: string
}

export interface LongTermGoalActivityEvent {
  id: string
  goalId: string
  runId?: string | null
  actor: LongTermGoalActivityActor
  type: LongTermGoalActivityType
  title: string
  summary: string
  details?: string
  artifacts: LongTermGoalActivityArtifact[]
  createdAt: string
}

export interface LongTermGoalMemoryEntry {
  id: string
  goalId: string
  kind: LongTermGoalMemoryKind
  title: string
  content: string
  importance: number
  sourceRunId?: string | null
  createdAt: string
  updatedAt: string
}

export interface LongTermGoalDailyReview {
  id: string
  goalId: string
  date: string
  runId?: string | null
  progressSummary: string
  gapAnalysis: string
  nextPlan: string[]
  blockers: string[]
  notificationLevel: LongTermGoalNotificationLevel
  needsUserInput: boolean
  createdAt: string
  updatedAt: string
}

export interface LongTermGoalRunProgressEntry {
  at: string
  stage: string
  detail?: string
  kind?: 'progress' | 'thinking' | 'tool_start' | 'tool_end' | 'todo' | 'file' | 'web'
  toolName?: string
}

export interface LongTermGoalRunToolRun {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
  progress: Array<{
    stage: string
    detail?: string
  }>
}

export interface LongTermGoalRun {
  id: string
  goalId: string
  scheduledReportId?: string | null
  status: LongTermGoalRunStatus
  startedAt: string
  finishedAt?: string | null
  progressSummary: string
  gapToGoal: string
  resultText?: string
  thinkingText?: string
  progress: LongTermGoalRunProgressEntry[]
  toolRuns: LongTermGoalRunToolRun[]
  error?: string
  notificationLevel: LongTermGoalNotificationLevel
  createdAt: string
  updatedAt: string
}

export interface LongTermGoalConversationTurn {
  id: string
  goalId: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  toolRuns?: LongTermGoalRunToolRun[]
  createdAt: string
  appliedChangeId?: string | null
}

export interface LongTermGoalChangeSet {
  id: string
  goalId: string
  sourceTurnId: string
  summary: string
  before: Partial<LongTermGoalDefinition>
  after: Partial<LongTermGoalDefinition>
  requiresConfirmation: boolean
  status: 'draft' | 'applied' | 'cancelled'
  createdAt: string
  appliedAt?: string | null
}

export interface LongTermGoalSnapshot {
  goals: LongTermGoalDefinition[]
  runs: LongTermGoalRun[]
  reviews: LongTermGoalDailyReview[]
  activities: LongTermGoalActivityEvent[]
  memories: LongTermGoalMemoryEntry[]
  conversations: LongTermGoalConversationTurn[]
  changeSets: LongTermGoalChangeSet[]
}

export type LongTermGoalSaveInput = Partial<LongTermGoalDefinition> & {
  title: string
  objective: string
  schedule?: LongTermGoalSchedule
}

export interface LongTermGoalMessageResult {
  turn: LongTermGoalConversationTurn
  assistantTurn: LongTermGoalConversationTurn
  changeSet?: LongTermGoalChangeSet | null
  goal: LongTermGoalDefinition
  phase?: 'clarifying' | 'proposal'
  thinking?: string
  toolRuns?: LongTermGoalRunToolRun[]
  proposal?: {
    title: string
    objective: string
    summary: string
    before: Partial<LongTermGoalDefinition>
    after: Partial<LongTermGoalDefinition>
    questions: Array<{ id: string; question: string; options: string[]; reason?: string }>
  } | null
}

export interface LongTermGoalStreamEvent {
  type: 'thinking' | 'token' | 'tool_start' | 'tool_end' | 'progress' | 'web_search_result' | 'web_fetch_result' | 'done' | 'error'
  content?: string
  name?: string
  message?: { role?: string; content?: string }
  thinking?: string
  error?: string
  stage?: string
  detail?: string
  query?: string
  engine?: string
  results?: Array<{ rank: number; title: string; url: string; snippet: string; source: string; published_at?: string }>
  result?: { url: string; title?: string; [key: string]: unknown }
}
