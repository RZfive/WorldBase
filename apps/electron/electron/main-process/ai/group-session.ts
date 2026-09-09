import type {
  AgentGroupDirectReply,
  AgentGroupMessage,
  AgentGroupUserInjection,
  SharedBoard,
  SharedBoardSnapshot,
  SharedBoardTask,
  SharedBoardUpdate
} from '../../../src/shared/agent-workspace-types.js'

/**
 * GroupSession · the shared coordination core for one group deliberation run.
 *
 * Owns the three primitives that turn "parallel note-passing" into "agents that
 * actually talk to each other":
 *
 *   R1 · GroupMessageBus      - peer-to-peer messaging with timeout, recursion
 *                               depth limiting, and wait-for-graph deadlock detect.
 *   R2 · SharedBoardStore     - the shared blackboard with field-level merge +
 *                               an audit log; members read/write concurrently.
 *   R5 · injection queue       - user clarifications injected mid-deliberation.
 *
 * Everything is in-memory and scoped to a single deliberation run; the registry
 * (`GroupSessionRegistry`) keeps a handle alive so the IPC layer can push HITL
 * injections into a running session.
 */

export interface GroupSessionEvent {
  type: 'peer_message' | 'board_update' | 'direct_reply' | 'injection'
  message?: AgentGroupMessage
  update?: SharedBoardUpdate
  snapshot?: SharedBoardSnapshot
  reply?: AgentGroupDirectReply
  injection?: AgentGroupUserInjection
}

export interface GroupSessionConfig {
  groupId: string
  groupName: string
  coordinatorId: string
  /** All agent ids that may appear as sender or receiver, including the coordinator. */
  participantIds: string[]
  /** Agents that may receive user injections. Defaults to non-coordinator participants. */
  injectionRecipientIds?: string[]
  /** Current deliberation round (1-based). Updated by the runtime between rounds. */
  round: number
  /** Max nested peer-request depth per agent. Default 2. */
  maxRecursionDepth?: number
  /** Per peer-message timeout. Default 60s. */
  messageTimeoutMs?: number
  /** Per-member per-round tool-call budget (R3 guardrail). Default 12. */
  perMemberToolBudget?: number
  /** Cancels peer requests when the parent deliberation is stopped. */
  abortSignal?: AbortSignal
  /**
   * Runs the target agent's reply to a peer request. The implementation lives in
   * group-deliberation.ts (it needs the AI engine + agent context); this inject
   * keeps GroupSession free of those dependencies.
   */
  runPeerReply: (input: {
    targetAgentId: string
    request: string
    fromAgentId: string
    fromAgentName: string
    abortSignal: AbortSignal
  }) => Promise<string>
  onEvent?: (event: GroupSessionEvent) => void
}

type GroupInjectionListener = (injection: AgentGroupUserInjection) => void

function abortReason (signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason || fallback))
}

function emptyBoard (): SharedBoard {
  return {
    goal: '',
    assumptions: [],
    tasks: [],
    decisions: [],
    evidenceRefs: [],
    openQuestions: []
  }
}

function nowIso (): string {
  return new Date().toISOString()
}

function genId (prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

function isStringArray (value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isTask (value: unknown): value is SharedBoardTask {
  return value !== null && typeof value === 'object' && typeof (value as SharedBoardTask).title === 'string'
}

export class GroupSession {
  readonly groupId: string
  readonly groupName: string
  readonly coordinatorId: string
  private readonly participantIds: Set<string>
  private readonly injectionRecipientIds: Set<string>
  private round: number
  private readonly maxRecursionDepth: number
  private readonly messageTimeoutMs: number
  private readonly perMemberToolBudget: number
  private readonly abortSignal?: AbortSignal
  private readonly runPeerReply: GroupSessionConfig['runPeerReply']
  private readonly onEvent: (event: GroupSessionEvent) => void

  // R2 · shared board + audit log
  private board: SharedBoard = emptyBoard()
  private readonly auditLog: SharedBoardUpdate[] = []

  // R6 · direct replies posted by each agent (for transcript enrichment)
  private readonly directRepliesByAgent = new Map<string, AgentGroupDirectReply[]>()

  // R1 · bus state
  /** agentId -> how many peer requests it is currently handling (nested). */
  private readonly activeDepth = new Map<string, number>()
  /** agentId -> the agent it is currently blocked waiting on (for deadlock detect). */
  private readonly waitingFor = new Map<string, string>()
  /** agentId -> peer messages it sent or received (for transcript replay). */
  private readonly peerMessagesByAgent = new Map<string, AgentGroupMessage[]>()

  // R3 · per-member tool-call counter for the current round
  private readonly toolCallCount = new Map<string, number>()

  // R5 · pending user injections, acknowledged independently by each recipient.
  private readonly pendingInjections: Array<{
    injection: AgentGroupUserInjection
    remainingAgentIds: Set<string>
  }> = []
  private readonly injections: AgentGroupUserInjection[] = []
  private readonly injectionListeners = new Map<string, Set<GroupInjectionListener>>()
  private availableInjectionRecipientIds = new Set<string>()

  constructor (config: GroupSessionConfig) {
    this.groupId = config.groupId
    this.groupName = config.groupName
    this.coordinatorId = config.coordinatorId
    this.participantIds = new Set(config.participantIds)
    this.injectionRecipientIds = new Set(
      config.injectionRecipientIds ?? config.participantIds.filter(agentId => agentId !== config.coordinatorId)
    )
    this.availableInjectionRecipientIds = new Set(this.injectionRecipientIds)
    this.round = config.round
    this.maxRecursionDepth = config.maxRecursionDepth ?? 2
    this.messageTimeoutMs = config.messageTimeoutMs ?? 60_000
    this.perMemberToolBudget = config.perMemberToolBudget ?? 12
    this.abortSignal = config.abortSignal
    this.runPeerReply = config.runPeerReply
    this.onEvent = config.onEvent ?? (() => {})
  }

  setRound (round: number): void {
    this.round = round
    // Reset the per-member tool budget at the start of each round.
    this.toolCallCount.clear()
  }

  setInjectionRecipients (agentIds: string[]): void {
    this.availableInjectionRecipientIds = new Set(
      agentIds.filter(agentId => this.injectionRecipientIds.has(agentId))
    )
  }

  finishInjectionTurn (agentId: string): void {
    this.availableInjectionRecipientIds.delete(agentId)
  }

  onInjection (agentId: string, listener: GroupInjectionListener): () => void {
    if (!this.injectionRecipientIds.has(agentId)) return () => {}
    const listeners = this.injectionListeners.get(agentId) ?? new Set<GroupInjectionListener>()
    listeners.add(listener)
    this.injectionListeners.set(agentId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.injectionListeners.delete(agentId)
    }
  }

  getRound (): number {
    return this.round
  }

  // ─────────────────────────────────────────────────────────────────────────
  // R1 · Peer-to-peer messaging
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send `request` from `fromAgentId` to `toAgentId` and resolve with the
   * target's reply. Enforces recursion depth + a wait-for-graph to break
   * deadlocks (A waits B while B waits A).
   */
  async sendMessage (input: {
    fromAgentId: string
    fromAgentName: string
    toAgentId: string
    toAgentName: string
    request: string
    abortSignal?: AbortSignal
  }): Promise<string> {
    const { fromAgentId, fromAgentName, toAgentId, toAgentName, request } = input
    if (this.abortSignal?.aborted) {
      throw abortReason(this.abortSignal, 'Group deliberation aborted.')
    }
    if (input.abortSignal?.aborted) {
      throw abortReason(input.abortSignal, 'Group peer request aborted.')
    }

    if (!this.participantIds.has(toAgentId)) {
      throw new Error(`message_agent: target agent "${toAgentName}" is not a participant in this group.`)
    }
    if (toAgentId === fromAgentId) {
      throw new Error('message_agent: an agent cannot send a peer message to itself.')
    }

    const senderDepth = this.activeDepth.get(fromAgentId) ?? 0
    if (senderDepth >= this.maxRecursionDepth) {
      throw new Error(`message_agent: recursion depth limit (${this.maxRecursionDepth}) reached. Resolve the current peer request before consulting another agent.`)
    }

    // Deadlock check: would waiting for `toAgentId` close a cycle back to `fromAgentId`?
    if (this.wouldDeadlock(fromAgentId, toAgentId)) {
      throw new Error(`message_agent: deadlock detected - "${toAgentName}" is already (transitively) waiting on "${fromAgentName}". Break the cycle by replying with what you have.`)
    }

    const message: AgentGroupMessage = {
      id: genId('pmsg'),
      groupId: this.groupId,
      fromAgentId,
      fromAgentName,
      toAgentId,
      toAgentName,
      request,
      response: '',
      status: 'pending',
      round: this.round,
      createdAt: nowIso()
    }
    this.recordPeerMessage(fromAgentId, message)
    this.recordPeerMessage(toAgentId, message)
    this.onEvent({ type: 'peer_message', message: { ...message } })

    this.waitingFor.set(fromAgentId, toAgentId)
    // Chain depth: the target handles this request one level deeper than the sender.
    const previousTargetDepth = this.activeDepth.get(toAgentId)
    this.activeDepth.set(toAgentId, senderDepth + 1)

    const requestAbort = new AbortController()
    const requestSignals = [this.abortSignal, input.abortSignal, requestAbort.signal]
      .filter((signal): signal is AbortSignal => Boolean(signal))
    const requestSignal = requestSignals.length > 1
      ? AbortSignal.any(requestSignals)
      : requestSignals[0]
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    let abortListener: (() => void) | null = null
    const timer = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const error = new Error(`message_agent: timed out after ${this.messageTimeoutMs}ms waiting for "${toAgentName}".`)
        requestAbort.abort(error)
        reject(error)
      }, this.messageTimeoutMs)
      // Allow the Node process to exit even if the timer is pending.
      if (typeof timeoutHandle === 'object' && timeoutHandle && 'unref' in timeoutHandle && typeof timeoutHandle.unref === 'function') {
        timeoutHandle.unref()
      }
    })
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => {
        reject(abortReason(requestSignal, 'Group peer request aborted.'))
      }
      if (requestSignal.aborted) abortListener()
      else requestSignal.addEventListener('abort', abortListener, { once: true })
    })

    try {
      const response = await Promise.race([
        this.runPeerReply({ targetAgentId: toAgentId, request, fromAgentId, fromAgentName, abortSignal: requestSignal }),
        timer,
        aborted
      ])
      message.response = response
      message.status = 'completed'
      message.resolvedAt = nowIso()
      this.onEvent({ type: 'peer_message', message: { ...message } })
      return response
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      message.status = error.includes('timed out') ? 'timeout' : 'failed'
      message.error = error
      message.resolvedAt = nowIso()
      this.onEvent({ type: 'peer_message', message: { ...message } })
      throw err
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (abortListener) requestSignal.removeEventListener('abort', abortListener)
      this.waitingFor.delete(fromAgentId)
      // Restore the target's previous depth (conservative under concurrency).
      if (previousTargetDepth === undefined) this.activeDepth.delete(toAgentId)
      else this.activeDepth.set(toAgentId, previousTargetDepth)
    }
  }

  /** Walk the wait-for graph: does a path `start` -> ... -> `target` exist? */
  private wouldDeadlock (fromAgentId: string, toAgentId: string): boolean {
    // We are about to make `fromAgentId` wait on `toAgentId`. A deadlock occurs
    // if `toAgentId` is already (transitively) waiting on `fromAgentId`.
    let cursor: string | undefined = toAgentId
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      if (cursor === fromAgentId) return true
      seen.add(cursor)
      cursor = this.waitingFor.get(cursor)
    }
    return false
  }

  private recordPeerMessage (agentId: string, message: AgentGroupMessage): void {
    const list = this.peerMessagesByAgent.get(agentId) ?? []
    list.push(message)
    this.peerMessagesByAgent.set(agentId, list)
  }

  getPeerMessages (agentId: string): AgentGroupMessage[] {
    return (this.peerMessagesByAgent.get(agentId) ?? []).map(message => ({ ...message }))
  }

  // ─────────────────────────────────────────────────────────────────────────
  // R2 · Shared board
  // ─────────────────────────────────────────────────────────────────────────

  readBoard (): SharedBoard {
    return this.cloneBoard()
  }

  snapshot (): SharedBoardSnapshot {
    return {
      groupId: this.groupId,
      groupName: this.groupName,
      board: this.cloneBoard(),
      recentUpdates: this.auditLog.slice(-12).map(update => ({ ...update })),
      updatedAt: nowIso()
    }
  }

  /**
   * Apply a field-level update. Concurrency is last-writer-wins per field, but
   * `add`/`remove` ops on list fields merge idempotently so unrelated writers
   * don't clobber each other. Every update is appended to the audit log.
   */
  updateBoard (input: {
    agentId: string
    agentName: string
    field: SharedBoardUpdate['field']
    op: SharedBoardUpdate['op']
    payload: unknown
    reason?: string
  }): SharedBoardUpdate {
    const update: SharedBoardUpdate = {
      id: genId('board'),
      groupId: this.groupId,
      agentId: input.agentId,
      agentName: input.agentName,
      field: input.field,
      op: input.op,
      payload: input.payload,
      reason: input.reason,
      at: nowIso()
    }
    this.applyBoardUpdate(update)
    this.auditLog.push(update)
    this.onEvent({ type: 'board_update', update: { ...update }, snapshot: this.snapshot() })
    return update
  }

  private applyBoardUpdate (update: SharedBoardUpdate): void {
    const { field, op, payload } = update
    if (field === 'goal') {
      if (op === 'set' && typeof payload === 'string') this.board.goal = payload
      return
    }
    if (field === 'tasks') {
      this.applyTaskUpdate(op, payload)
      return
    }
    // String-list fields: assumptions / decisions / evidenceRefs / openQuestions
    const list = this.board[field] as string[]
    if (op === 'set' && isStringArray(payload)) {
      this.board[field] = [...payload] as SharedBoard[typeof field]
      return
    }
    if (op === 'add' && typeof payload === 'string') {
      const trimmed = payload.trim()
      if (trimmed && !list.includes(trimmed)) list.push(trimmed)
      return
    }
    if (op === 'remove' && typeof payload === 'string') {
      const idx = list.indexOf(payload)
      if (idx >= 0) list.splice(idx, 1)
      return
    }
  }

  private applyTaskUpdate (op: SharedBoardUpdate['op'], payload: unknown): void {
    if (op === 'set' && Array.isArray(payload) && payload.every(isTask)) {
      this.board.tasks = (payload as SharedBoardTask[]).map(task => ({ ...task }))
      return
    }
    if (op === 'add' && isTask(payload)) {
      const task = payload as SharedBoardTask
      if (!this.board.tasks.some(existing => existing.id === task.id || existing.title === task.title)) {
        this.board.tasks.push({ ...task })
      }
      return
    }
    if (op === 'update' && payload !== null && typeof payload === 'object' && typeof (payload as SharedBoardTask).id === 'string') {
      const task = payload as Partial<SharedBoardTask> & { id: string }
      const idx = this.board.tasks.findIndex(existing => existing.id === task.id)
      if (idx >= 0) this.board.tasks[idx] = { ...this.board.tasks[idx], ...task }
      return
    }
    if (op === 'remove' && typeof payload === 'string') {
      const idx = this.board.tasks.findIndex(existing => existing.id === payload || existing.title === payload)
      if (idx >= 0) this.board.tasks.splice(idx, 1)
      return
    }
  }

  private cloneBoard (): SharedBoard {
    return {
      goal: this.board.goal,
      assumptions: [...this.board.assumptions],
      tasks: this.board.tasks.map(task => ({ ...task })),
      decisions: [...this.board.decisions],
      evidenceRefs: [...this.board.evidenceRefs],
      openQuestions: [...this.board.openQuestions]
    }
  }

  /** Build a compact prompt section describing the current board (diff-aware). */
  buildBoardPromptSection (lastSeenUpdateId?: string): { section: string; newUpdateId?: string } {
    const snapshot = this.readBoard()
    const lines: string[] = ['## Shared group board (read with read_board, mutate with update_board)']
    if (snapshot.goal) lines.push(`- Goal: ${snapshot.goal}`)
    if (snapshot.assumptions.length > 0) lines.push(`- Assumptions: ${snapshot.assumptions.join('; ')}`)
    if (snapshot.tasks.length > 0) {
      lines.push('- Tasks:')
      for (const task of snapshot.tasks) {
        const owner = task.ownerAgentId ? ` [owner: ${task.ownerAgentId}]` : ''
        lines.push(`    · [${task.status}] ${task.title}${owner}${task.summary ? ` — ${task.summary}` : ''}`)
      }
    }
    if (snapshot.decisions.length > 0) lines.push(`- Decisions: ${snapshot.decisions.join('; ')}`)
    if (snapshot.evidenceRefs.length > 0) lines.push(`- Evidence: ${snapshot.evidenceRefs.join('; ')}`)
    if (snapshot.openQuestions.length > 0) lines.push(`- Open questions: ${snapshot.openQuestions.join('; ')}`)
    if (lines.length === 1) lines.push('- (board is empty - consider posting the goal and claiming tasks)')
    const lastUpdate = this.auditLog[this.auditLog.length - 1]
    return { section: lines.join('\n'), newUpdateId: lastUpdate?.id }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // R3 · tool-call guardrail
  // ─────────────────────────────────────────────────────────────────────────

  /** Increment the member's tool-call count; return whether it may proceed. */
  consumeToolBudget (agentId: string): { allowed: boolean; remaining: number } {
    const used = (this.toolCallCount.get(agentId) ?? 0) + 1
    this.toolCallCount.set(agentId, used)
    const remaining = Math.max(0, this.perMemberToolBudget - used)
    return { allowed: used <= this.perMemberToolBudget, remaining }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // R6 · direct reply
  // ─────────────────────────────────────────────────────────────────────────

  postDirectReply (input: {
    agentId: string
    agentName: string
    content: string
    endorsed: boolean
  }): AgentGroupDirectReply {
    const reply: AgentGroupDirectReply = {
      id: genId('direct'),
      groupId: this.groupId,
      groupName: this.groupName,
      agentId: input.agentId,
      agentName: input.agentName,
      content: input.content,
      round: this.round,
      endorsed: input.endorsed,
      at: nowIso()
    }
    const list = this.directRepliesByAgent.get(input.agentId) ?? []
    list.push({ ...reply })
    this.directRepliesByAgent.set(input.agentId, list)
    this.onEvent({ type: 'direct_reply', reply: { ...reply } })
    return reply
  }

  getDirectReplies (agentId: string): AgentGroupDirectReply[] {
    return (this.directRepliesByAgent.get(agentId) ?? []).map(reply => ({ ...reply }))
  }

  /** R8 · board updates authored by an agent (for transcript enrichment). */
  getBoardUpdatesByAgent (agentId: string): SharedBoardUpdate[] {
    return this.auditLog.filter(update => update.agentId === agentId).map(update => ({ ...update }))
  }

  // ─────────────────────────────────────────────────────────────────────────
  // R5 · human-in-the-loop injection
  // ─────────────────────────────────────────────────────────────────────────

  /** Called from the IPC layer when the user injects a clarification. */
  inject (input: { content: string; targetAgentIds?: string[] }): AgentGroupUserInjection {
    const requestedTargetIds = Array.from(new Set((input.targetAgentIds ?? []).map(agentId => agentId.trim()).filter(Boolean)))
    const invalidTargetId = requestedTargetIds.find(agentId => !this.injectionRecipientIds.has(agentId))
    if (invalidTargetId) {
      throw new Error(`group injection: target agent "${invalidTargetId}" cannot receive injections in this session.`)
    }
    const unavailableTargetId = requestedTargetIds.find(agentId => !this.availableInjectionRecipientIds.has(agentId))
    if (unavailableTargetId) {
      throw new Error(`group injection: target agent "${unavailableTargetId}" has no pending turn in this session.`)
    }
    const recipientIds = requestedTargetIds.length > 0
      ? requestedTargetIds
      : Array.from(this.availableInjectionRecipientIds)
    if (recipientIds.length === 0) {
      throw new Error('group injection: no group member has a pending turn that can receive this clarification.')
    }

    const injection: AgentGroupUserInjection = {
      id: genId('inj'),
      groupId: this.groupId,
      groupName: this.groupName,
      content: input.content,
      targetAgentIds: requestedTargetIds,
      round: this.round,
      at: nowIso()
    }
    this.pendingInjections.push({
      injection,
      remainingAgentIds: new Set(recipientIds)
    })
    this.injections.push(injection)
    this.onEvent({ type: 'injection', injection: { ...injection } })
    for (const agentId of recipientIds) {
      for (const listener of this.injectionListeners.get(agentId) ?? []) {
        listener({ ...injection, targetAgentIds: [...injection.targetAgentIds] })
      }
    }
    return injection
  }

  /** A member drains injections addressed to it (or to everyone) before its turn. */
  drainInjections (agentId: string): AgentGroupUserInjection[] {
    const mine: AgentGroupUserInjection[] = []
    for (const pending of this.pendingInjections) {
      if (!pending.remainingAgentIds.delete(agentId)) continue
      mine.push({ ...pending.injection, targetAgentIds: [...pending.injection.targetAgentIds] })
    }
    for (let index = this.pendingInjections.length - 1; index >= 0; index--) {
      if (this.pendingInjections[index].remainingAgentIds.size === 0) this.pendingInjections.splice(index, 1)
    }
    return mine
  }

  hasPendingInjections (): boolean {
    return this.pendingInjections.length > 0
  }

  getInjections (): AgentGroupUserInjection[] {
    return this.injections.map(injection => ({
      ...injection,
      targetAgentIds: [...injection.targetAgentIds]
    }))
  }
}

/**
 * Registry of active group sessions, keyed by stream session id. The IPC layer looks up
 * a session here to push user injections into a running deliberation.
 */
export class GroupSessionRegistry {
  private readonly sessions = new Map<string, GroupSession>()

  register (sessionId: string, session: GroupSession): void {
    this.sessions.set(sessionId, session)
  }

  get (sessionId: string): GroupSession | undefined {
    return this.sessions.get(sessionId)
  }

  release (sessionId: string, expectedSession?: GroupSession): boolean {
    if (expectedSession && this.sessions.get(sessionId) !== expectedSession) return false
    return this.sessions.delete(sessionId)
  }
}

export const groupSessionRegistry = new GroupSessionRegistry()
