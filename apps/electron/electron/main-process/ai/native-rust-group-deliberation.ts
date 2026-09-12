import { randomUUID } from 'node:crypto'
import type { MessageContent } from '../../../src/main/ai-engine/providers/openai-provider.js'
import type {
  AgentDefinition,
  AgentGroupDefinition,
  AgentGroupDirectReply,
  AgentGroupMessage,
  AgentGroupProgressSnapshot,
  AgentGroupTranscript,
  AgentGroupTranscriptEntry,
  AgentGroupUserInjection,
  AgentSidechatSession,
  SharedBoard,
  SharedBoardSnapshot,
  SharedBoardTask,
  SharedBoardUpdate
} from '../../../src/shared/agent-workspace-types.js'
import type {
  RustChatOptions,
  RustCustomToolRegistration,
  RustEventFrame,
  RustHarnessClient
} from '../rust-harness-client.js'
import type { AIExecutionEngine, AIRequestOptions } from '../../../src/main/ai-harness/types.js'
import { getLastUserMessageText, truncateSectionText } from '../chat-message-utils.js'
import {
  appendGroupProgressStep,
  buildGroupTranscriptSummary,
  createAgentSidechatSession,
  createGroupCollaborationPlan,
  createGroupProgressSnapshot,
  buildGroupRoundCoordinatorPlan,
  emitAgentSidechatSession,
  emitGroupCollaborationPlan,
  emitGroupProgressSnapshot,
  getGroupProgressItem,
  summarizeGroupNote,
  type GroupDeliberationProgressCallback,
  type ParsedGroupRouting
} from './group-deliberation.js'

/**
 * Electron keeps renderer-specific presentation state, but the group session,
 * member execution, board, injection queue, and cancellation handle live in
 * the Rust app-server. This module deliberately never imports GroupSession.
 */

export interface RustNativeGroupDeliberationInput {
  client: RustHarnessClient
  /** The selected Rust engine supplies planner calls too; no TS engine is used. */
  planner?: AIExecutionEngine & Partial<ElectronHostToolProvider>
  group: AgentGroupDefinition
  agents: AgentDefinition[]
  messages: Array<{ role: string; content: MessageContent }>
  routing: ParsedGroupRouting
  sessionId: string
  abortSignal?: AbortSignal
  onProgress?: GroupDeliberationProgressCallback
  context?: Pick<
    RustChatOptions,
    | 'authMode'
    | 'workspaceRoot'
    | 'targetProjectId'
    | 'allowedMcpServerIds'
    | 'enableThinking'
    | 'reasoningEffort'
    | 'temperature'
    | 'planModeActive'
    | 'budgetLimit'
    | 'systemPromptSections'
    | 'activeSkillContents'
    | 'memoryScopes'
    | 'memoryQuery'
    | 'computerUseEnabled'
  > & {
    /** Live Electron authorization mode used by Node-hosted tool handlers. */
    getAuthMode?: () => 'strict' | 'auto'
    /** Outer Electron conversation that owns auth/ask-user cards. */
    hostConversationId?: string
  }
}

interface ElectronHostToolProvider {
  createElectronHostToolRegistrations: (options?: AIRequestOptions) => RustCustomToolRegistration[]
}

export interface RustNativeGroupDeliberationResult {
  promptSection: string | null
  transcript: AgentGroupTranscript | null
}

interface NativeGroupRegistration {
  client: RustHarnessClient
  logicalGroupId: string
  logicalGroupName: string
  nativeGroupId: string
  memberIds: Set<string>
  currentRound: number
  onProgress?: GroupDeliberationProgressCallback
}

const activeNativeGroups = new Map<string, NativeGroupRegistration>()

/** The IPC layer uses this to route a live clarification to the Rust queue. */
export async function injectNativeRustGroup (
  sessionId: string,
  logicalGroupId: string,
  content: string,
  targetAgentIds?: string[]
): Promise<{ ok: boolean; injected: boolean; queued?: number; error?: string }> {
  const registration = activeNativeGroups.get(sessionId)
  if (!registration) {
    return { ok: false, injected: false, error: 'No active native Rust group session for this stream.' }
  }
  if (registration.logicalGroupId !== logicalGroupId) {
    return { ok: false, injected: false, error: 'The active native group session does not match this conversation.' }
  }
  const normalizedContent = content.trim()
  if (!normalizedContent) {
    return { ok: false, injected: false, error: 'content is required.' }
  }
  const requestedTargets = normalizeIds(targetAgentIds)
  const invalidTarget = requestedTargets.find(agentId => !registration.memberIds.has(agentId))
  if (invalidTarget) {
    return { ok: false, injected: false, error: `group injection: target agent "${invalidTarget}" is not a member of this group.` }
  }

  try {
    const result = await registration.client.injectNativeGroup(
      sessionId,
      registration.nativeGroupId,
      normalizedContent,
      requestedTargets
    )
    const injection: AgentGroupUserInjection = {
      id: `rust-injection-${randomUUID()}`,
      groupId: registration.logicalGroupId,
      groupName: registration.logicalGroupName,
      content: normalizedContent,
      targetAgentIds: requestedTargets,
      round: registration.currentRound,
      at: new Date().toISOString()
    }
    registration.onProgress?.({ type: 'group_user_injection', injection })
    return { ok: true, injected: true, queued: nonNegativeInteger(result?.queued) }
  } catch (error) {
    return {
      ok: false,
      injected: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function hasNativeRustGroupSession (sessionId: string): boolean {
  return activeNativeGroups.has(sessionId)
}

/**
 * Run a complete group deliberation through Rust. The returned prompt is fed
 * into the normal final coordinator response, preserving the existing chat
 * UI while ensuring the collaboration itself never enters the TS GroupSession
 * implementation when the Rust harness is selected.
 */
export async function buildNativeRustGroupDeliberation (
  input: RustNativeGroupDeliberationInput
): Promise<RustNativeGroupDeliberationResult> {
  throwIfAborted(input.abortSignal)
  // A group with no worker is a coordinator-only chat in the established
  // Electron contract. Keep that direct Rust chat path instead of requiring a
  // synthetic second participant just to open a native group session.
  if (input.routing.mode === 'coordinator_only') {
    return { promptSection: null, transcript: null }
  }
  const agentsById = new Map(input.agents.map(agent => [agent.id, agent]))
  const members = nativeGroupMembers(input.group, agentsById)
  if (members.length < 2) {
    throw new Error('The selected group needs at least two valid agents for a native Rust group session.')
  }
  const coordinator = agentsById.get(input.group.coordinatorAgentId)
  if (!coordinator) {
    throw new Error('The selected group coordinator is not available for a native Rust group session.')
  }

  const request = getLastUserMessageText(input.messages).trim()
  if (!request) {
    return { promptSection: null, transcript: null }
  }
  const normalizedRequest = input.routing.normalizedRequest || request
  const totalRounds = nativeRoundCount(input.group, input.routing)
  const workerIds = members
    .map(member => member.agentId)
    .filter((agentId): agentId is string => Boolean(agentId && agentId !== coordinator.id))
  // Electron's mention and mode parser remains the UI routing boundary. Rust
  // receives the resolved participant IDs and owns all actual group work; do
  // not let its default all-member route overwrite an explicit user choice.
  const selectedMemberIds = uniqueStrings(input.routing.selectedMemberIds)
    .filter(agentId => workerIds.includes(agentId))
  if (selectedMemberIds.length === 0) {
    return { promptSection: null, transcript: null }
  }
  const snapshot = createGroupProgressSnapshot(input.group, selectedMemberIds, normalizedRequest, totalRounds)
  const entries: AgentGroupTranscriptEntry[] = []
  let lastBoard: SharedBoardSnapshot | null = null
  let nativeGroupId = ''
  let registration: NativeGroupRegistration | null = null
  const createHostToolsForStream = (streamId: string): RustCustomToolRegistration[] => {
    return input.planner?.createElectronHostToolRegistrations?.(
      nativeGroupHostToolContext(input, streamId)
    ) || []
  }
  const commonContext: RustChatOptions = {
    ...nativeGroupContext(input),
    // Descriptors travel with group.message. Handlers are rebuilt lazily for
    // each child stream below so mutable Electron tool state stays isolated.
    customTools: createHostToolsForStream(`${input.sessionId}:catalog`)
  }
  const nativePlanner = input.planner
  const planningAgentId = input.routing.plannerAgentId || coordinator.id
  const planningAgent = agentsById.get(planningAgentId) || coordinator
  const isPlannerDriven = input.routing.mode === 'coordinator_decides' || input.routing.mode === 'mentioned_agent_decides'
  const plannerNotes: Array<{ memberId: string; review: string }> = []

  emitGroupCollaborationPlan(input.onProgress, createGroupCollaborationPlan({
    group: input.group,
    routing: input.routing,
    plannerName: coordinator.name,
    reportToName: coordinator.name,
    originalRequest: request,
    phase: 'planning',
    candidateMemberIds: selectedMemberIds,
    invitedMemberIds: isPlannerDriven ? [] : selectedMemberIds
  }))
  emitGroupProgressSnapshot(input.onProgress, snapshot)

  const stopNativeGroup = () => {
    void input.client.stopSession(input.sessionId).catch(() => {})
  }
  input.abortSignal?.addEventListener('abort', stopNativeGroup, { once: true })

  try {
    const session = await input.client.createNativeGroup({
      topic: input.group.description?.trim() || input.group.name,
      mode: input.routing.mode,
      members,
      coordinator: coordinator.name,
      maxParallelWorkers: input.group.maxParallelWorkers
    })
    nativeGroupId = session.id
    registration = {
      client: input.client,
      logicalGroupId: input.group.id,
      logicalGroupName: input.group.name,
      nativeGroupId,
      memberIds: new Set(selectedMemberIds),
      currentRound: 1,
      onProgress: input.onProgress
    }
    activeNativeGroups.set(input.sessionId, registration)
    input.onProgress?.({ type: 'group_session_state', groupId: input.group.id, active: true })

    for (let round = 1; round <= totalRounds; round++) {
      throwIfAborted(input.abortSignal)
      registration.currentRound = round
      snapshot.activeRound = round
      markRoundStarted(snapshot, round)
      const candidateMemberIds = selectedMemberIds.filter(memberId => {
        const item = getGroupProgressItem(snapshot, memberId)
        return item?.status !== 'failed'
      })
      const roundPlan = isPlannerDriven
        ? nativePlanner
          ? await buildGroupRoundCoordinatorPlan({
            runtimeAiEngine: nativePlanner,
            planner: planningAgent,
            group: input.group,
            messages: input.messages,
            targetProjectId: input.context?.targetProjectId,
            fallbackReasoningStrength: input.context?.reasoningEffort,
            candidateMemberIds,
            priorNotes: plannerNotes,
            latestUserMessage: request,
            normalizedRequest,
            mentionedMemberIds: input.routing.mentionedMemberIds,
            round,
            totalRounds,
            selectionSource: input.routing.mode === 'mentioned_agent_decides'
              ? 'mentioned_agent_decides'
              : 'coordinator_decides',
            abortSignal: input.abortSignal,
            runtimeRequestContext: {
              workspaceRoot: commonContext.workspaceRoot,
              authMode: currentNativeGroupAuthMode(input),
              getAuthMode: input.context?.getAuthMode,
              hostConversationId: input.context?.hostConversationId,
              hostSessionId: input.sessionId,
              memoryScopes: commonContext.memoryScopes
            }
          })
          // The selected Rust engine must be supplied for planner-driven
          // modes. Avoid reaching the legacy TS planner as a fallback.
          : {
              shouldContinue: candidateMemberIds.length > 0,
              selectedMemberIds: candidateMemberIds,
              request: normalizedRequest,
              focus: ''
            }
        : {
            shouldContinue: candidateMemberIds.length > 0,
            selectedMemberIds: candidateMemberIds,
            request: normalizedRequest,
            focus: ''
          }
      const roundMemberIds = uniqueStrings(roundPlan.selectedMemberIds)
        .filter(memberId => candidateMemberIds.includes(memberId))
      if (!roundPlan.shouldContinue || roundMemberIds.length === 0) break

      emitGroupCollaborationPlan(input.onProgress, createGroupCollaborationPlan({
        group: input.group,
        routing: input.routing,
        plannerName: coordinator.name,
        reportToName: coordinator.name,
        originalRequest: request,
        phase: 'executing',
        candidateMemberIds,
        invitedMemberIds: roundMemberIds,
        round,
        focus: roundPlan.focus,
        shouldContinue: roundPlan.shouldContinue
      }))
      emitGroupProgressSnapshot(input.onProgress, snapshot)

      let roundTerminal: 'complete' | 'error' | null = null
      let roundError: Error | null = null
      await input.client.startNativeGroupRound({
        sessionId: input.sessionId,
        groupId: nativeGroupId,
        text: roundPlan.request || normalizedRequest,
        round,
        memberIds: roundMemberIds,
        authMode: currentNativeGroupAuthMode(input),
        context: commonContext,
        customToolsForStream: createHostToolsForStream,
        onEvent: frame => {
          const outcome = handleNativeGroupFrame({
            frame,
            nativeGroupId,
            group: input.group,
            agentsById,
            snapshot,
            entries,
            currentRound: round,
            onProgress: input.onProgress
          })
          if (outcome.board) {
            lastBoard = outcome.board
            input.onProgress?.({ type: 'group_board', board: outcome.board })
          }
          if (outcome.error) roundError = outcome.error
          if (outcome.terminal) roundTerminal = outcome.terminal
        }
      })
      await input.client.waitForSessionEnd(input.sessionId)
      throwIfAborted(input.abortSignal)
      if (roundError) throw roundError
      if (roundTerminal === 'error') {
        throw new Error('Rust native group round did not complete.')
      }
      if (roundTerminal !== 'complete') {
        throw new Error('Rust native group ended without a terminal completion event.')
      }
      for (const entry of entries) {
        if (entry.round !== round || !roundMemberIds.includes(entry.agentId)) continue
        const index = plannerNotes.findIndex(note => note.memberId === entry.agentId)
        const note = { memberId: entry.agentId, review: entry.content }
        if (index >= 0) plannerNotes[index] = note
        else plannerNotes.push(note)
      }

      // The dispatcher persists the board after the terminal frame. Read it
      // back once so an event-order race cannot leave the renderer stale.
      const persisted = await input.client.getNativeGroup(nativeGroupId)
      const persistedBoard = toBoardSnapshot(input.group, persisted.board, persisted.boardUpdates)
      if (persistedBoard) {
        lastBoard = persistedBoard
        input.onProgress?.({ type: 'group_board', board: persistedBoard })
      }
    }

    markRoundFinished(snapshot, totalRounds)
    emitGroupProgressSnapshot(input.onProgress, snapshot)
    emitGroupCollaborationPlan(input.onProgress, createGroupCollaborationPlan({
      group: input.group,
      routing: input.routing,
      plannerName: coordinator.name,
      reportToName: coordinator.name,
      originalRequest: request,
      phase: 'completed',
      candidateMemberIds: workerIds,
      invitedMemberIds: workerIds,
      round: totalRounds,
      shouldContinue: false
    }))
    if (lastBoard) input.onProgress?.({ type: 'group_board', board: lastBoard })

    return nativeGroupResult(input.group, input.routing, normalizedRequest, entries)
  } catch (error) {
    const nativeError = error instanceof Error ? error : new Error(String(error))
    markRoundFailed(snapshot, nativeError.message)
    emitGroupProgressSnapshot(input.onProgress, snapshot)
    throw nativeError
  } finally {
    input.abortSignal?.removeEventListener('abort', stopNativeGroup)
    if (registration && activeNativeGroups.get(input.sessionId) === registration) {
      activeNativeGroups.delete(input.sessionId)
    }
    if (nativeGroupId) {
      input.onProgress?.({ type: 'group_session_state', groupId: input.group.id, active: false })
    }
  }
}

function nativeGroupMembers (group: AgentGroupDefinition, agentsById: Map<string, AgentDefinition>) {
  const ids = Array.from(new Set([
    group.coordinatorAgentId,
    ...group.memberAgentIds
  ].map(id => id.trim()).filter(Boolean)))
  return ids.flatMap(agentId => {
    const agent = agentsById.get(agentId)
    if (!agent) return []
    const persona = [agent.description, agent.systemPrompt]
      .map(value => value?.trim())
      .filter((value): value is string => Boolean(value))
      .join('\n\n') || agent.name
    return [{
      name: agent.name,
      persona,
      agentId: agent.id,
      allowedToolNames: agent.allowedTools || [],
      deniedToolNames: agent.deniedTools || []
    }]
  })
}

function nativeGroupContext (input: RustNativeGroupDeliberationInput): RustChatOptions {
  // Per-member allow/deny policy is carried by group.create and applied by
  // Rust's group runner. An outer coordinator policy must not accidentally
  // overwrite every participant's policy.
  return {
    authMode: currentNativeGroupAuthMode(input),
    workspaceRoot: input.context?.workspaceRoot,
    targetProjectId: input.context?.targetProjectId,
    allowedMcpServerIds: input.context?.allowedMcpServerIds,
    enableThinking: input.context?.enableThinking,
    reasoningEffort: input.context?.reasoningEffort,
    temperature: input.context?.temperature,
    planModeActive: input.context?.planModeActive,
    budgetLimit: input.context?.budgetLimit,
    memoryScopes: input.context?.memoryScopes,
    memoryQuery: input.context?.memoryQuery,
    computerUseEnabled: input.context?.computerUseEnabled === true,
    systemPromptSections: uniqueStrings(input.context?.systemPromptSections),
    activeSkillContents: uniqueStrings(input.context?.activeSkillContents),
    allowedToolNames: [],
    deniedToolNames: []
  }
}

function currentNativeGroupAuthMode (
  input: RustNativeGroupDeliberationInput
): 'strict' | 'auto' | undefined {
  return input.context?.getAuthMode?.() ?? input.context?.authMode
}

function nativeGroupHostToolContext (
  input: RustNativeGroupDeliberationInput,
  streamId: string
): AIRequestOptions {
  const hostConversationId = input.context?.hostConversationId?.trim() || undefined
  return {
    sessionId: streamId,
    conversationId: hostConversationId,
    // Permission prompts and progress still belong to the outer Electron
    // chat, even though each member gets isolated handler state.
    hostSessionId: input.sessionId,
    hostConversationId,
    authMode: currentNativeGroupAuthMode(input),
    getAuthMode: input.context?.getAuthMode,
    workspaceRoot: input.context?.workspaceRoot,
    targetProjectId: input.context?.targetProjectId,
    allowedMcpServerIds: input.context?.allowedMcpServerIds,
    activeSkillContents: input.context?.activeSkillContents,
    systemPromptSections: input.context?.systemPromptSections,
    memoryScopes: input.context?.memoryScopes,
    abortSignal: input.abortSignal
  }
}

function nativeRoundCount (group: AgentGroupDefinition, routing: ParsedGroupRouting): number {
  return routing.mode === 'discussion' || routing.mode === 'coordinator_decides' || routing.mode === 'mentioned_agent_decides'
    ? Math.max(1, Math.floor(group.maxRounds || 1))
    : 1
}

function handleNativeGroupFrame (input: {
  frame: RustEventFrame
  nativeGroupId: string
  group: AgentGroupDefinition
  agentsById: Map<string, AgentDefinition>
  snapshot: AgentGroupProgressSnapshot
  entries: AgentGroupTranscriptEntry[]
  currentRound: number
  onProgress?: GroupDeliberationProgressCallback
}): { board?: SharedBoardSnapshot; error?: Error; terminal?: 'complete' | 'error' } {
  const { frame, nativeGroupId, group, agentsById, snapshot, entries, currentRound, onProgress } = input
  const childAgentId = agentIdFromMemberStream(nativeGroupId, frame.groupMemberStreamId)
  if (childAgentId) {
    const item = getGroupProgressItem(snapshot, childAgentId)
    if (item && (frame.kind === 'start' || frame.kind === 'delta' || frame.kind === 'tool_call')) {
      item.status = 'running'
      item.currentRound = currentRound
      item.stage = 'Rust native group'
      item.detail = frame.kind === 'tool_call' ? `Running ${String(frame.name || 'tool')}` : 'Working'
      item.updatedAt = new Date().toISOString()
      appendGroupProgressStep(item, item.stage, item.detail)
      emitGroupProgressSnapshot(onProgress, snapshot)
    }
  }

  if (frame.kind === 'group_message') {
    const memberName = stringValue(frame.member)
    const agent = findAgentByName(agentsById, memberName)
    const agentId = agent?.id || childAgentId || memberName
    const content = stringValue(frame.content)
    const round = positiveInteger(frame.round) || currentRound
    const entry: AgentGroupTranscriptEntry = {
      id: `rust-group-${group.id}-${round}-${agentId}-${entries.length}`,
      round,
      agentId,
      agentName: memberName || agent?.name || agentId,
      content
    }
    entries.push(entry)
    const item = getGroupProgressItem(snapshot, agentId)
    if (item) {
      item.currentRound = round
      item.completedRounds = Math.max(item.completedRounds, round)
      item.status = round >= item.totalRounds ? 'completed' : 'queued'
      item.stage = round >= item.totalRounds ? 'Completed' : 'Waiting for next Rust round'
      item.detail = summarizeGroupNote(content)
      item.summary = summarizeGroupNote(content)
      item.updatedAt = new Date().toISOString()
      appendGroupProgressStep(item, item.stage, item.detail)
      emitGroupProgressSnapshot(onProgress, snapshot)
    }
    const sidechat: AgentSidechatSession = createAgentSidechatSession({
      group,
      memberId: agentId,
      agentName: entry.agentName,
      mode: 'group_deliberation',
      initiatedByName: 'Rust group',
      reportToName: findAgentById(agentsById, group.coordinatorAgentId)?.name || group.coordinatorAgentId,
      request: '',
      round
    })
    sidechat.response = content
    sidechat.status = 'completed'
    sidechat.updatedAt = new Date().toISOString()
    emitAgentSidechatSession(onProgress, sidechat)
    return {}
  }

  if (frame.kind === 'board_update') {
    const board = toBoardSnapshot(group, frame.board, frame.update)
    return board ? { board } : {}
  }
  if (frame.kind === 'group_direct_reply') {
    const directReply = toDirectReply(group, frame.reply)
    if (directReply) onProgress?.({ type: 'group_direct_reply', directReply })
    return {}
  }
  if (frame.kind === 'group_peer_message') {
    const peerMessage = toPeerMessage(group, frame.message)
    if (peerMessage) onProgress?.({ type: 'group_peer_message', peerMessage })
    return {}
  }
  if (frame.kind === 'notice') {
    onProgress?.('Rust native group', stringValue(frame.text))
    return {}
  }
  if (frame.kind === 'error') {
    return { error: new Error(stringValue(frame.message) || 'Rust native group failed.') }
  }
  if (frame.kind === 'done') {
    if (frame.stopReason === 'group_complete') return { terminal: 'complete' }
    if (frame.stopReason === 'group_error') return { terminal: 'error' }
  }
  return {}
}

function nativeGroupResult (
  group: AgentGroupDefinition,
  routing: ParsedGroupRouting,
  request: string,
  entries: AgentGroupTranscriptEntry[]
): RustNativeGroupDeliberationResult {
  if (entries.length === 0) return { promptSection: null, transcript: null }
  const notes = entries.map(entry => [
    `### ${entry.agentName} · round ${entry.round}`,
    entry.content
  ].join('\n'))
  const summaryMode = routing.mode === 'coordinator_only' ? 'discussion' : routing.mode
  const transcript: AgentGroupTranscript = {
    groupId: group.id,
    groupName: group.name,
    request,
    visibility: group.visibility,
    roundCount: Math.max(...entries.map(entry => entry.round), 0),
    entryCount: entries.length,
    summary: buildGroupTranscriptSummary(group, entries, summaryMode),
    entries: group.visibility === 'expandable_internal_transcript' ? entries : []
  }
  return {
    promptSection: [
      '## Rust-native agent group deliberation',
      '- The following are internal working notes from the Rust group session.',
      '- Use them to improve the final answer without exposing the full transcript unless asked.',
      '',
      truncateSectionText(notes.join('\n\n'), group.visibility === 'summary_only' ? 4000 : 8000)
    ].join('\n'),
    transcript
  }
}

function toBoardSnapshot (
  group: AgentGroupDefinition,
  value: unknown,
  updates?: unknown
): SharedBoardSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const board: SharedBoard = {
    goal: stringValue(raw.goal),
    assumptions: strings(raw.assumptions),
    tasks: boardTasks(group, raw.tasks),
    decisions: strings(raw.decisions),
    evidenceRefs: strings(raw.evidenceRefs),
    openQuestions: strings(raw.openQuestions)
  }
  const recentUpdates = boardUpdates(group, updates === undefined ? raw.boardUpdates : updates)
  return {
    groupId: group.id,
    groupName: group.name,
    board,
    recentUpdates,
    updatedAt: recentUpdates.at(-1)?.at || new Date().toISOString()
  }
}

function boardTasks (group: AgentGroupDefinition, value: unknown): SharedBoardTask[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((item, index) => {
    if (typeof item === 'string') {
      const title = item.trim()
      if (!title) return []
      const id = `rust-task-${group.id}-${index}`
      seen.add(id)
      return [{ id, title, status: 'todo' as const }]
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const task = item as Record<string, unknown>
    const title = stringValue(task.title)
    if (!title) return []
    let id = stringValue(task.id) || `rust-task-${group.id}-${index}`
    while (seen.has(id)) id = `${id}-${index}`
    seen.add(id)
    const ownerAgentId = stringValue(task.ownerAgentId) || stringValue(task.owner_agent_id)
    const summary = stringValue(task.summary)
    return [{
      id,
      title,
      ...(ownerAgentId ? { ownerAgentId } : {}),
      status: boardTaskStatus(task.status),
      ...(summary ? { summary } : {})
    }]
  })
}

function boardTaskStatus (value: unknown): SharedBoardTask['status'] {
  const status = stringValue(value)
  return status === 'running' || status === 'blocked' || status === 'done' ? status : 'todo'
}

function boardUpdates (group: AgentGroupDefinition, value: unknown): SharedBoardUpdate[] {
  const items = Array.isArray(value) ? value : value ? [value] : []
  return items.flatMap((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const raw = item as Record<string, unknown>
    const field = boardUpdateField(raw.field)
    const op = boardUpdateOperation(raw.op)
    if (!field || !op) return []
    const reason = stringValue(raw.reason)
    const payload = Object.prototype.hasOwnProperty.call(raw, 'payload')
      ? raw.payload
      : Object.prototype.hasOwnProperty.call(raw, 'value') ? raw.value : null
    return [{
      id: stringValue(raw.id) || `rust-board-${group.id}-${index}`,
      groupId: group.id,
      agentId: stringValue(raw.agentId) || 'rust-group',
      agentName: stringValue(raw.agentName) || 'Rust group',
      field,
      op,
      payload,
      ...(reason ? { reason } : {}),
      at: stringValue(raw.at) || new Date().toISOString()
    }]
  }).slice(-12)
}

function boardUpdateField (value: unknown): SharedBoardUpdate['field'] | null {
  const field = stringValue(value)
  return field === 'goal' || field === 'assumptions' || field === 'tasks' || field === 'decisions' || field === 'evidenceRefs' || field === 'openQuestions'
    ? field
    : null
}

function boardUpdateOperation (value: unknown): SharedBoardUpdate['op'] | null {
  const operation = stringValue(value)
  return operation === 'set' || operation === 'add' || operation === 'update' || operation === 'remove'
    ? operation
    : null
}

function toDirectReply (group: AgentGroupDefinition, value: unknown): AgentGroupDirectReply | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const agentId = stringValue(raw.agentId)
  const content = stringValue(raw.content)
  if (!agentId || !content) return null
  return {
    id: stringValue(raw.id) || `rust-direct-${group.id}-${agentId}-${positiveInteger(raw.round) || 1}`,
    groupId: group.id,
    groupName: group.name,
    agentId,
    agentName: stringValue(raw.agentName) || agentId,
    content,
    round: positiveInteger(raw.round) || 1,
    endorsed: raw.endorsed === true,
    at: stringValue(raw.at) || new Date().toISOString()
  }
}

function toPeerMessage (group: AgentGroupDefinition, value: unknown): AgentGroupMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const fromAgentId = stringValue(raw.fromAgentId)
  const toAgentId = stringValue(raw.toAgentId)
  const status = peerMessageStatus(raw.status)
  if (!fromAgentId || !toAgentId || !status) return null
  const resolvedAt = stringValue(raw.resolvedAt)
  const error = stringValue(raw.error)
  return {
    id: stringValue(raw.id) || `rust-peer-${group.id}-${fromAgentId}-${toAgentId}-${positiveInteger(raw.round) || 1}`,
    groupId: group.id,
    fromAgentId,
    fromAgentName: stringValue(raw.fromAgentName) || fromAgentId,
    toAgentId,
    toAgentName: stringValue(raw.toAgentName) || toAgentId,
    request: stringValue(raw.request),
    response: stringValue(raw.response),
    status,
    round: positiveInteger(raw.round) || 1,
    createdAt: stringValue(raw.createdAt) || new Date().toISOString(),
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(error ? { error } : {})
  }
}

function peerMessageStatus (value: unknown): AgentGroupMessage['status'] | null {
  const status = stringValue(value)
  return status === 'pending' || status === 'completed' || status === 'failed' || status === 'timeout' || status === 'rejected'
    ? status
    : null
}

function markRoundStarted (snapshot: AgentGroupProgressSnapshot, round: number): void {
  for (const item of snapshot.items) {
    item.currentRound = round
    if (item.status === 'completed') continue
    item.status = 'queued'
    item.stage = 'Queued for Rust native group'
    item.detail = `Round ${round}`
    item.updatedAt = new Date().toISOString()
    appendGroupProgressStep(item, item.stage, item.detail)
  }
}

function markRoundFinished (snapshot: AgentGroupProgressSnapshot, totalRounds: number): void {
  for (const item of snapshot.items) {
    if (item.status === 'failed') continue
    item.currentRound = Math.max(item.currentRound, totalRounds)
    item.status = 'completed'
    item.stage = 'Completed'
    item.detail = item.summary || 'Rust native group completed.'
    item.updatedAt = new Date().toISOString()
  }
}

function markRoundFailed (snapshot: AgentGroupProgressSnapshot, error: string): void {
  for (const item of snapshot.items) {
    if (item.status === 'completed') continue
    item.status = 'failed'
    item.stage = 'Rust native group failed'
    item.detail = error
    item.updatedAt = new Date().toISOString()
    appendGroupProgressStep(item, item.stage, error)
  }
}

function agentIdFromMemberStream (nativeGroupId: string, value: unknown): string | null {
  const streamId = stringValue(value)
  const prefix = `${nativeGroupId}:member:`
  if (!streamId.startsWith(prefix)) return null
  const agentId = streamId.slice(prefix.length).split(':', 1)[0]?.trim()
  return agentId || null
}

function findAgentByName (agentsById: Map<string, AgentDefinition>, name: string): AgentDefinition | undefined {
  return Array.from(agentsById.values()).find(agent => agent.name === name)
}

function findAgentById (agentsById: Map<string, AgentDefinition>, id: string): AgentDefinition | undefined {
  return agentsById.get(id)
}

function throwIfAborted (signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'Rust native group aborted.'))
}

function uniqueStrings(values?: string[]): string[] {
  return Array.from(new Set((values || []).map(value => value.trim()).filter(Boolean)))
}

function normalizeIds(values?: string[]): string[] {
  return uniqueStrings(values)
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
    : []
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInteger(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

function nonNegativeInteger(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0
}
