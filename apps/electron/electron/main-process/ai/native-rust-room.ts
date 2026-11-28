import { randomUUID } from 'node:crypto'
import type { MessageContent } from '../../../src/main/ai-harness/contracts.js'
import type { AIRequestOptions } from '../../../src/main/ai-harness/types.js'
import { t } from '../../../src/main/i18n/main-i18n.js'
import { isLocalCliAgent, roomLocalWorkerAgent } from '../../../src/main/local-agents/catalog.js'
import { localGroupRuntimeTools } from '../../../src/main/local-agents/group-runtime.js'
import { getRoomToolDefinitions } from '../../../src/main/local-agents/group-tools.js'
import type { LocalAgentRegistry } from '../../../src/main/local-agents/registry.js'
import type {
  AgentDefinition,
  AgentGroupDefinition,
  AgentGroupMessage,
  RoomApprovalRequest,
  RoomMemberMessage,
  RoomReplyStatus
} from '../../../src/shared/agent-workspace-types.js'
import {
  formatRoomHandoffMessage,
  isVerbatimRoomForward,
  resolveRoomAddress,
  stripRedundantHandoffInstructions
} from '../../../src/shared/group-mentions.js'
import { localRoomSessionKey, nativeRoomId } from '../../../src/shared/room-context.js'
import type { RoomLocalWorker, RoomLocalWorkspace } from '../../../src/shared/local-agent-types.js'
import { getMessageText, truncateSectionText } from '../chat-message-utils.js'
import type { RustChatOptions, RustCustomToolRegistration, RustHarnessClient } from '../rust-harness-client.js'
import { createRoomProgressItem, roomProgressSnapshot, roomTraceFromFrame, updateRoomProgressItem, type RoomProgressEvent } from './room-progress.js'

export interface NativeRoomInput {
  client: RustHarnessClient
  hostTools?: { createElectronHostToolRegistrations: (options?: AIRequestOptions) => RustCustomToolRegistration[] }
  group: AgentGroupDefinition
  agents: AgentDefinition[]
  localAgentRegistry?: LocalAgentRegistry | null
  localWorkspace?: RoomLocalWorkspace
  requestWorkspaceApproval?: (request: RoomApprovalRequest, signal: AbortSignal) => Promise<boolean>
  messages: Array<{ role: string; content: MessageContent }>
  sessionId: string
  abortSignal?: AbortSignal
  onProgress?: (event: RoomProgressEvent) => void
  context?: Pick<RustChatOptions,
    | 'authMode'
    | 'workspaceRoot'
    | 'targetProjectId'
    | 'allowedMcpServerIds'
    | 'enableThinking'
    | 'reasoningEffort'
    | 'temperature'
    | 'budgetLimit'
    | 'systemPromptSections'
    | 'memoryScopes'
    | 'memoryQuery'
    | 'memoryEmbedding'
    | 'computerUseEnabled'
  > & {
    getAuthMode?: () => 'strict' | 'auto'
    hostConversationId?: string
  }
  onMembershipChanged?: (group: AgentGroupDefinition) => void
}

interface ActiveNativeRoom {
  client: RustHarnessClient
  group: AgentGroupDefinition
  nativeGroupId: string
  agents: Map<string, AgentDefinition>
  currentRound: number
  currentMemberIds: string[]
  onProgress?: NativeRoomInput['onProgress']
}

const sessions = new Map<string, ActiveNativeRoom>()
const activeRoomIds = new Set<string>()
const updatingRoomContextIds = new Set<string>()
const retiredRoomTools = [
  'enter_plan_mode', 'exit_plan_mode', 'read_board', 'update_board', 'reply_to_user',
  'message_agent', 'spawn_subagents', 'spawn_subagentstasks'
]

export function hasNativeRustGroupSession (sessionId: string): boolean {
  return sessions.has(sessionId)
}

export function isNativeRoomRunning (groupId: string): boolean {
  return activeRoomIds.has(groupId) || updatingRoomContextIds.has(groupId)
}

export async function clearNativeRoomContext (
  client: RustHarnessClient,
  groupId: string,
  registry: LocalAgentRegistry | null,
  clearConversation: (group: AgentGroupDefinition) => Promise<void>,
  conversationIds?: string[]
): Promise<void> {
  await withIdleRoom(groupId, async () => {
    const { group, previousContextId } = await client.clearRoomContext(groupId, conversationIds)
    releaseRoomBindings(registry, group.id, previousContextId ?? undefined)
    await clearConversation(group)
  })
}

export async function deleteNativeRoom (
  client: RustHarnessClient,
  groupId: string,
  registry: LocalAgentRegistry | null,
  deleteConversations: () => Promise<void>,
  conversationIds: string[]
): Promise<boolean> {
  return await withIdleRoom(groupId, async () => {
    const group = await client.getAgentGroup(groupId)
    if (!group || !await client.deleteAgentGroup(group.id, conversationIds)) return false
    releaseRoomBindings(registry, group.id, group.roomContextId)
    await deleteConversations()
    return true
  })
}

async function withIdleRoom<T> (groupId: string, operation: () => Promise<T>): Promise<T> {
  if (isNativeRoomRunning(groupId)) throw new Error(t('mainDialog.roomStopBeforeClearing'))
  updatingRoomContextIds.add(groupId)
  try {
    return await operation()
  } finally {
    updatingRoomContextIds.delete(groupId)
  }
}

function releaseRoomBindings (registry: LocalAgentRegistry | null, groupId: string, roomContextId?: string): void {
  const keys = new Set([localRoomSessionKey({ id: groupId, roomContextId }), groupId])
  for (const key of keys) {
    try {
      registry?.releaseRoomSessions(key)
    } catch (error) {
      console.warn('[room] Could not release old CLI session bindings:', error)
    }
  }
}

export async function injectNativeRustGroup (
  sessionId: string,
  groupId: string,
  content: string,
  targetAgentIds?: string[]
): Promise<{ ok: boolean; injected: boolean; queued?: number; error?: string }> {
  const session = sessions.get(sessionId)
  if (!session || session.group.id !== groupId) {
    return { ok: false, injected: false, error: 'No active room belongs to this stream.' }
  }
  const text = content.trim()
  if (!text) return { ok: false, injected: false, error: 'content is required.' }
  const explicitIds = [...new Set(targetAgentIds?.map(id => id.trim()).filter(Boolean))]
  const address = resolveRoomAddress(text, [...session.agents.values()], session.group.coordinatorAgentId)
  const targets = explicitIds.length ? explicitIds : address.explicit ? address.agentIds : session.currentMemberIds
  const invalidTarget = targets.find(id => !session.agents.has(id))
  if (invalidTarget) {
    return { ok: false, injected: false, error: `group injection: target agent "${invalidTarget}" is not a member of this group.` }
  }

  try {
    const result = await session.client.injectNativeGroup(sessionId, session.nativeGroupId, text, targets)
    session.onProgress?.({ type: 'group_user_injection', injection: {
      id: `rust-injection-${randomUUID()}`,
      groupId,
      groupName: session.group.name,
      content: text,
      targetAgentIds: targets,
      round: session.currentRound,
      at: new Date().toISOString()
    } })
    return { ok: true, injected: true, queued: result?.queued ?? 0 }
  } catch (error) {
    return { ok: false, injected: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function formatRoomReplies (messages: RoomMemberMessage[]): string {
  return messages.length === 1
    ? messages[0].content
    : messages.map(message => `${message.speakerName}:\n${message.content}`).join('\n\n')
}

export async function runNativeRoom (input: NativeRoomInput): Promise<RoomMemberMessage[]> {
  const groupId = input.group.id
  input.abortSignal?.throwIfAborted()
  if (isNativeRoomRunning(groupId)) throw new Error(t('mainDialog.roomAlreadyRunning'))
  activeRoomIds.add(groupId)
  try {
    const group = await input.client.getAgentGroup(groupId)
    if (!group) throw new Error(t('mainDialog.roomNotFound'))
    return await runRoomTurn({ ...input, group })
  } finally {
    activeRoomIds.delete(groupId)
  }
}

async function runRoomTurn (input: NativeRoomInput): Promise<RoomMemberMessage[]> {
  const { client, group, sessionId, abortSignal, onProgress } = input
  abortSignal?.throwIfAborted()
  const groupSessionId = nativeRoomId(group)
  const memoryScopes = input.context?.memoryScopes?.filter(scope => scope.scopeType !== 'agent').map(scope => (
    group.roomContextId && scope.scopeType === 'group' && scope.scopeId === group.id
      ? { ...scope, scopeId: groupSessionId }
      : scope
  ))

  const knownAgents = new Map(input.agents.map(agent => [agent.id, agent]))
  const memberIds = [...new Set([group.coordinatorAgentId, ...group.memberAgentIds])]
  const workers = new Map((group.localWorkers || []).map(worker => [worker.id, worker]))
  const agents = [...memberIds.flatMap(id => knownAgents.get(id) || []), ...[...workers.values()].map(roomLocalWorkerAgent)]
  const agentsById = new Map(agents.map(agent => [agent.id, agent]))
  const latestUser = [...input.messages].reverse().find(message => message.role === 'user')
  const text = getMessageText(latestUser?.content ?? '').trim()
  const address = resolveRoomAddress(text, agents, group.coordinatorAgentId)
  const request = address.agentIds.length > 1 && !address.broadcast ? text : address.request
  const roomMessages: RoomMemberMessage[] = []
  const publishReply = (speaker: Pick<AgentDefinition, 'name' | 'icon'>, content: string) => {
    const roomMessage = { ...speakerFor(speaker), content }
    roomMessages.push(roomMessage)
    onProgress?.({ type: 'room_message', roomMessage })
  }
  if (!request || !address.agentIds.length) {
    publishReply(group, t(request ? 'mainDialog.roomNoResult' : 'mainDialog.roomDescribeTask'))
    return roomMessages
  }

  const singleRecipient = address.agentIds.length === 1 ? agentsById.get(address.agentIds[0]) : undefined
  const tracksMember = (memberId: string) => singleRecipient?.id === memberId && roomMessages.length === 0
  const totalRounds = Math.max(1, group.maxRounds)
  const progressById = new Map(address.agentIds.map(id => [id, createRoomProgressItem(group.id, agentsById.get(id)!, totalRounds)]))
  const handoffs: AgentGroupMessage[] = []
  const handoffKeys = new Set<string>()
  const announcedHandoffs = new Set<string>()
  const completedWorkers = new Set<string>()
  const workspaceGrants = new Map<string, Promise<boolean>>()
  const localWorkspace = input.localWorkspace ?? (input.context?.workspaceRoot
    ? { path: input.context.workspaceRoot, source: 'task' as const }
    : undefined)
  const allowInvites = Boolean(input.requestWorkspaceApproval && localWorkspace && group.workspaceRoot)
  let lastSingleStatus: RoomReplyStatus | undefined
  let nativeGroupId = ''
  let currentRound = 0
  let clarificationTargets: string[] = []
  let session: ActiveNativeRoom | undefined

  const updateRoomMembers = (updated: AgentGroupDefinition) => {
    const current = updated.localWorkers || []
    const ids = new Set(current.map(worker => worker.id))
    for (const id of workers.keys()) {
      if (ids.has(id)) continue
      workers.delete(id)
      agentsById.delete(id)
    }
    for (const worker of current) {
      workers.set(worker.id, worker)
      agentsById.set(worker.id, roomLocalWorkerAgent(worker))
    }
    if (session) session.group = updated
    input.onMembershipChanged?.(updated)
  }

  const retireWorker = async (workerId: string) => {
    const result = await client.removeRoomLocalWorker(group.id, workerId)
    updateRoomMembers(result.group)
    if (result.removed) {
      try {
        input.localAgentRegistry?.releaseWorkerSessions(localRoomSessionKey(group), workerId)
      } catch (error) {
        console.warn('[room] Worker left but its session binding could not be released:', error)
      }
    }
  }

  const queueHandoff = async (
    key: string,
    from: AgentDefinition,
    task: string,
    recipient: () => Promise<AgentDefinition>,
    options: { autoCallback?: boolean } = {}
  ) => {
    if (handoffKeys.has(key)) return null
    if (handoffKeys.size >= 25) throw new Error(t('mainDialog.roomHandoffLimit'))
    if (currentRound >= totalRounds) throw new Error(t('mainDialog.roomNoRoundsForHandoff'))
    handoffKeys.add(key)
    try {
      const deliveredTask = stripRedundantHandoffInstructions(task) || request
      if (isVerbatimRoomForward(deliveredTask, request)) {
        throw new Error('Handoff must assign a specific subtask. Do not forward the user request.')
      }
      const to = await recipient()
      const returningToRequester = handoffs.some(handoff => (
        handoff.fromAgentId === to.id
        && handoff.toAgentId === from.id
        && handoff.round <= currentRound
      ))
      await client.recordRoomHandoff(nativeGroupId, from.id, to.id, deliveredTask)
      const handoff: AgentGroupMessage = {
        id: randomUUID(),
        kind: 'handoff',
        groupId: group.id,
        fromAgentId: from.id,
        fromAgentName: from.name,
        toAgentId: to.id,
        toAgentName: to.name,
        request: deliveredTask,
        response: '',
        status: 'pending',
        round: currentRound + 1,
        createdAt: new Date().toISOString(),
        ...((options.autoCallback ?? returningToRequester) ? { autoCallback: true } : {})
      }
      handoffs.push(handoff)
      return to
    } catch (error) {
      handoffKeys.delete(key)
      throw error
    }
  }

  const publishProgress = () => {
    if (!singleRecipient) {
      onProgress?.({ type: 'group_progress', groupProgress: roomProgressSnapshot(group, [...progressById.values()], request, currentRound, totalRounds) })
      return
    }
    const status = progressById.get(singleRecipient.id)?.status
    const visibleStatus = abortSignal?.aborted && status !== 'completed' ? 'stopped' : status
    if (!visibleStatus || visibleStatus === lastSingleStatus) return
    lastSingleStatus = visibleStatus
    onProgress?.({ type: 'room_member_status', roomMemberStatus: { ...speakerFor(singleRecipient), status: visibleStatus } })
  }
  const currentAuthMode = () => input.context?.getAuthMode?.() ?? input.context?.authMode ?? 'strict'
  const createHostTools = (streamId: string) => input.hostTools?.createElectronHostToolRegistrations({
    ...input.context,
    sessionId: streamId,
    conversationId: input.context?.hostConversationId,
    hostSessionId: sessionId,
    authMode: currentAuthMode(),
    memoryScopes,
    abortSignal
  }) || []
  const createHostToolsForStream = (streamId: string, streamSignal: AbortSignal): RustCustomToolRegistration[] => {
    const hostTools = createHostTools(streamId)
    const agent = agentsById.get(memberIdFromStream(nativeGroupId, streamId))
    if (!agent) return hostTools
    const signal = abortSignal ? AbortSignal.any([abortSignal, streamSignal]) : streamSignal
    return [...hostTools, ...localGroupRuntimeTools({
      group,
      nativeGroupId,
      agent,
      workspace: localWorkspace,
      registry: input.localAgentRegistry,
      allowInvites,
      userRequest: request,
      authorizeWorkspace: async () => {
        signal.throwIfAborted()
        if (!localWorkspace || !input.requestWorkspaceApproval) throw new Error(t('mainDialog.roomApprovalRequired'))
        if (currentAuthMode() === 'auto') return
        let approval = workspaceGrants.get(agent.id)
        if (!approval) {
          approval = input.requestWorkspaceApproval({
            purpose: 'room_workspace',
            title: t('mainDialog.roomWorkspaceApprovalTitle', { name: agent.name }),
            detail: t('mainDialog.roomWorkspaceApprovalDetail', { path: localWorkspace.path })
          }, signal)
          workspaceGrants.set(agent.id, approval)
        }
        if (!await approval) throw new Error(t('mainDialog.roomWorkspaceDenied'))
      },
      signal,
      onThinking: content => {
        if (tracksMember(agent.id)) onProgress?.({ type: 'thinking', content })
      },
      getMembers: () => [...agentsById.values()],
      readMessages: async () => await client.listConversationMessages(`group-${nativeGroupId}`),
      onJoined: updateRoomMembers,
      onHandoff: async (from, to, task) => Boolean(await queueHandoff(JSON.stringify([from.id, to.id, task]), from, task, async () => to)),
      onInvite: async (from, platformId, role, task, invite) => await queueHandoff(
        JSON.stringify([from.id, platformId, role.trim().replace(/\s+/g, ' ').toLowerCase(), task]), from, task, invite
      )
    })]
  }
  const roomMemberRoster = agents.map(agent => (
    `- @${agent.name} (${agent.id}): ${agent.description?.trim() || 'No additional role description'}`
  )).join('\n')
  const roomCollaborationSections = agents.length > 1
    ? [
        '- Work as an autonomous teammate. Complete your own part, then check whether the next step belongs to another member.',
        '- Treat the user message as the overall goal, not as text to forward. First decide and do your own contribution, then split concrete subtasks for collaborators.',
        '- Never forward or lightly paraphrase the user’s original request as a handoff. Each handoff must state the recipient’s specific responsibility, relevant inputs/constraints, and the real deliverable or evidence you need.',
        '- Proactively call handoff_room_task when the next step needs another member’s execution, specialist input, discussion, review, verification, or decision. Its task must contain the concrete request, current context, evidence, and acceptance criteria; the room displays it as your direct @member message.',
        '- The runtime already injects every member’s name, role description and persona. In a handoff, write only the concrete task and useful context/evidence. Never write role-play, identity, greeting, tone, formatting, or “please act as X/introduce yourself” instructions for the recipient; include acceptance criteria only when they are real deliverables of the task.',
        '- For multi-step or cross-domain work, split it into concrete parts and hand off independent parts immediately. Do not wait for the user to name every participant.',
        '- Queue every needed handoff in the current turn, then finish this turn immediately. Recipients start only after your turn ends.',
        '- The runtime returns each recipient’s result to you as a visible @reply in a later round. Do not read the room, wait, or poll for that event; simply end your current turn after queueing the handoff.',
        '- Do not call read_room_messages, wait, poll, or read the transcript to check for a recipient’s reply in the same turn. Never impersonate or invent their answer.',
        '- Before calling ask_user, check whether a safe, reversible default exists. If it does, choose it, state the assumption, and keep working; do not pause for confirmation or preference-only questions.',
        '- When an answer truly blocks the next step, bundle every current blocking decision into one ask_user call so the user can answer them together.',
        '- Do not hand coordination back to the user. Do not ask the user to @ someone, relay a request, or decide who should continue when you can hand off directly.',
        '- The handoff itself is already visible as your @member message. Add only a brief result or next-step note if needed; do not repeat the task or emit a separate handoff report. Do not speak or claim completion for the recipient.',
        '- Reply to the user directly only when your part is complete and no follow-up is needed, or when you are genuinely blocked on missing user input, authorization, or a user-owned decision.'
      ]
    : [
        '- You are the only member in this room. Complete the task yourself and reply to the user; ask only for missing input, authorization, or a user-owned decision.'
      ]
  const runContext: RustChatOptions = {
    ...input.context,
    authMode: currentAuthMode(),
    planModeActive: false,
    activeSkillContents: [],
    memoryScopes,
    allowedToolNames: [],
    deniedToolNames: retiredRoomTools,
    customTools: createHostTools(`${sessionId}:catalog`),
    systemPromptSections: [
      ...(input.context?.systemPromptSections || []),
      '## Shared room collaboration',
      `Room members:\n${roomMemberRoster}`,
      ...roomCollaborationSections,
      '- If one message names several members with different tasks, perform only the task addressed to you.',
      '- Stay within the current request and later user clarifications. Use read_room_messages when earlier messages are relevant.',
      ...(allowInvites ? ['- For distinct work that needs a new Worker, use discover_local_agents then invite_local_agent with each Worker’s role and task. The same CLI can host multiple Workers; avoid overlapping file edits.'] : [])
    ]
  }

  const stop = () => { void client.stopSession(sessionId).catch(() => {}) }
  abortSignal?.addEventListener('abort', stop, { once: true })
  try {
    publishProgress()
    const nativeGroup = await client.createNativeGroup({
      sessionId: groupSessionId,
      logicalGroupId: group.id,
      room: true,
      topic: group.description?.trim() || group.name,
      mode: agents.length === 1 ? 'coordinator_only' : 'targeted',
      members: agents.map(agent => ({
        agentId: agent.id,
        name: agent.name,
        persona: [agent.description?.trim(), agent.systemPrompt?.trim()].filter(Boolean).join('\n\n') || agent.name,
        allowedToolNames: agent.allowedTools || [],
        deniedToolNames: [...new Set([...(agent.deniedTools || []), ...retiredRoomTools])],
        localRuntime: isLocalCliAgent(agent)
      })),
      coordinator: agents[0].name,
      maxParallelWorkers: group.maxParallelWorkers
    })
    abortSignal?.throwIfAborted()
    nativeGroupId = nativeGroup.id
    session = { client, group, nativeGroupId, agents: agentsById, currentRound: 1, currentMemberIds: address.agentIds, onProgress }
    sessions.set(sessionId, session)
    onProgress?.({ type: 'group_session_state', groupId: group.id, active: true })

    let nextMemberIds = address.agentIds
    for (let round = 1; round <= totalRounds && nextMemberIds.length; round++) {
      abortSignal?.throwIfAborted()
      const roundMemberIds = nextMemberIds
      const assignments = handoffs.filter(handoff => handoff.status === 'pending' && handoff.round <= round)
      currentRound = session.currentRound = round
      session.currentMemberIds = roundMemberIds
      for (const id of roundMemberIds) {
        completedWorkers.delete(id)
        const item = progressById.get(id) ?? createRoomProgressItem(group.id, agentsById.get(id)!, totalRounds)
        item.currentRound = round
        updateRoomProgressItem(item, 'queued', t('mainDialog.groupProgressWaitingStart'))
        progressById.set(id, item)
      }
      publishProgress()
      const replies = new Map<string, string>()
      const visibleAgentText = new Map<string, string>()
      let roundTerminal: 'complete' | 'error' | undefined
      let roundError: string | undefined

      const takeHandoffMessages = (memberId: string, roundNumber: number): string => {
        const pending = handoffs.filter(handoff => (
          handoff.fromAgentId === memberId &&
          handoff.round === roundNumber + 1 &&
          !announcedHandoffs.has(handoff.id)
        ))
        for (const handoff of pending) announcedHandoffs.add(handoff.id)
        return pending.map(handoff => formatRoomHandoffMessage(handoff.toAgentName, handoff.request)).join('\n\n')
      }

      await client.startNativeGroupRound({
        sessionId,
        groupId: nativeGroupId,
        text: request,
        round,
        memberIds: roundMemberIds,
        memberRequests: Object.fromEntries(roundMemberIds.flatMap(id => {
          const briefs = assignments.filter(handoff => handoff.toAgentId === id).map(handoff => `From ${handoff.fromAgentName}:\n${handoff.request}`)
          return briefs.length ? [[id, briefs.join('\n\n')]] : []
        })),
        recordMessage: round === 1,
        authMode: currentAuthMode(),
        context: runContext,
        customToolDefinitions: getRoomToolDefinitions(allowInvites),
        customToolsForStream: createHostToolsForStream,
        onEvent: frame => {
          const childId = memberIdFromStream(nativeGroupId, frame.groupMemberStreamId)
          const child = progressById.get(childId)
          if (child && (frame.kind === 'start' || frame.kind === 'tool_call' || frame.kind === 'progress' ||
            (frame.kind === 'thinking_delta' && child.status === 'queued'))) {
            const detail = frame.kind === 'tool_call' ? `Running ${String(frame.name || 'tool')}` : stringValue(frame.detail)
            updateRoomProgressItem(child, 'running', stringValue(frame.stage) || t('mainDialog.groupProgressThinking'), detail)
            publishProgress()
          }
          if (tracksMember(childId)) {
            const trace = roomTraceFromFrame(frame)
            if (trace) onProgress?.(trace)
          }
          if (frame.kind === 'group_message') {
            const id = stringValue(frame.agentId) || childId || agents.find(agent => agent.name === frame.member)?.id || ''
            const content = stringValue(frame.content)
            const member = agentsById.get(id)
            if (!member || !content.trim()) return
            const item = progressById.get(id)
            const primaryAssignment = assignments.find(handoff => (
              handoff.toAgentId === id
              && !handoff.autoCallback
              && handoff.fromAgentId !== id
            ))
            const source = primaryAssignment ? agentsById.get(primaryAssignment.fromAgentId) : undefined
            const alreadyMentionsSource = source
              ? (() => {
                  const address = resolveRoomAddress(content, [...agentsById.values()], group.coordinatorAgentId)
                  return address.explicit && address.agentIds.includes(source.id)
                })()
              : false
            const replyContent = source && !alreadyMentionsSource
              ? formatRoomHandoffMessage(source.name, content)
              : content
            const visibleContent = [takeHandoffMessages(id, round), replyContent].filter(Boolean).join('\n\n')
            replies.set(id, visibleContent)
            visibleAgentText.set(id, content)
            if (item) {
              item.completedRounds = Math.max(item.completedRounds, round)
              item.summary = truncateSectionText(visibleContent, 220)
              updateRoomProgressItem(item, 'completed', t('mainDialog.groupProgressRoundDone'), item.summary)
            }
            publishReply(member, visibleContent)
            publishProgress()
          } else if (frame.kind === 'group_member_failed') {
            const item = progressById.get(stringValue(frame.agentId))
            const error = stringValue(frame.message)
            roundError ||= error
            if (item) {
              updateRoomProgressItem(item, 'failed', t('mainDialog.groupProgressFailed'), error)
              publishProgress()
            }
          } else if (frame.kind === 'error' && !childId) {
            roundError = stringValue(frame.message)
            roundTerminal = 'error'
          } else if (frame.kind === 'notice') {
            const notice = stringValue(frame.text)
            if (notice.startsWith('Native group failed:') || notice.startsWith('Persist group message failed:')) {
              roundError ||= notice
            }
          } else if (frame.kind === 'done') {
            if (frame.stopReason === 'group_complete') roundTerminal = 'complete'
            if (frame.stopReason === 'group_error') roundTerminal = 'error'
          }
        }
      })
      await client.waitForSessionEnd(sessionId)
      abortSignal?.throwIfAborted()
      if (roundTerminal !== 'complete') throw new Error(roundError || 'Rust native room ended without a successful round.')

      for (const id of roundMemberIds) {
        const handoffMessage = takeHandoffMessages(id, round)
        if (!handoffMessage) continue
        const member = agentsById.get(id)
        if (!member) continue
        replies.set(id, handoffMessage)
        const item = progressById.get(id)
        if (item && item.status !== 'failed') {
          item.completedRounds = Math.max(item.completedRounds, round)
          item.summary = truncateSectionText(handoffMessage, 220)
          updateRoomProgressItem(item, 'completed', t('mainDialog.groupProgressRoundDone'), item.summary)
        }
        publishReply(member, handoffMessage)
      }
      for (const id of roundMemberIds) {
        const item = progressById.get(id)!
        if (!replies.has(id) && item.status !== 'failed') {
          updateRoomProgressItem(item, 'failed', t('mainDialog.roomNoResult'))
        }
      }
      // Models do not always call handoff_room_task even when told to. A
      // direct @member sentence is still an actionable handoff, so route it
      // through the same queue instead of silently ending the room without
      // waking the addressed member.
      for (const [sourceId, content] of visibleAgentText) {
        const source = agentsById.get(sourceId)
        if (!source) continue
        const mentioned = resolveRoomAddress(content, [...agentsById.values()], group.coordinatorAgentId)
        if (!mentioned.explicit) continue
        const task = stripRedundantHandoffInstructions(mentioned.request.trim()) || mentioned.request.trim()
        if (!task) continue
        for (const targetId of mentioned.agentIds) {
          if (targetId === sourceId) continue
          const target = agentsById.get(targetId)
          if (!target) continue
          try {
            await queueHandoff(
              JSON.stringify([sourceId, targetId, task]),
              source,
              task,
              async () => target
            )
          } catch (error) {
            // The visible @ message is already in the transcript. A duplicate
            // or an exhausted round budget must not fail the completed round.
            console.warn('[room] Could not queue a visible @mention handoff:', error)
          }
        }
      }
      // A handoff is a request for work, not a fire-and-forget message. When
      // the recipient returns without explicitly @mentioning the requester,
      // create the same visible @reply as a real group chat and schedule the
      // requester in the next round. No member needs to poll the transcript.
      for (const assignment of assignments) {
        if (assignment.autoCallback || currentRound >= totalRounds) continue
        const source = agentsById.get(assignment.fromAgentId)
        const target = agentsById.get(assignment.toAgentId)
        const targetText = visibleAgentText.get(assignment.toAgentId)?.trim()
        if (!source || !target || !targetText || source.id === target.id) continue
        const explicitReturn = handoffs.some(handoff => (
          handoff.fromAgentId === target.id
          && handoff.toAgentId === source.id
          && handoff.status === 'pending'
          && handoff.round >= currentRound + 1
        ))
        if (explicitReturn) continue
        try {
          await queueHandoff(
            JSON.stringify([target.id, source.id, 'callback', targetText]),
            target,
            targetText.slice(0, 5000),
            async () => source,
            { autoCallback: true }
          )
        } catch (error) {
          console.warn('[room] Could not queue the handoff return callback:', error)
        }
      }
      publishProgress()
      for (const handoff of assignments) {
        const reply = replies.get(handoff.toAgentId)
        handoff.status = reply ? 'completed' : 'failed'
        handoff.response = reply || ''
        handoff.resolvedAt = new Date().toISOString()
      }
      for (const id of replies.keys()) {
        if (workers.get(id)?.exitAfterTask) completedWorkers.add(id)
      }
      const persisted = await client.getNativeGroup(nativeGroupId)
      abortSignal?.throwIfAborted()
      clarificationTargets = pendingClarificationTargets(persisted.pendingInjections, roundMemberIds).filter(id => agentsById.has(id))
      nextMemberIds = [...new Set([
        ...handoffs.filter(handoff => handoff.status === 'pending').map(handoff => handoff.toAgentId),
        ...clarificationTargets
      ])]
    }

    if (!roomMessages.length) publishReply(singleRecipient || group, t('mainDialog.roomNoResult'))
    if (nextMemberIds.length) {
      const names = nextMemberIds.map(id => agentsById.get(id)?.name || id).join(t('mainDialog.groupParticipantDelimiter'))
      publishReply(group, t('mainDialog.roomRoundLimit', { names }))
    }
    for (const id of completedWorkers) {
      if (nextMemberIds.includes(id)) continue
      try {
        await retireWorker(id)
      } catch (error) {
        console.warn('[room] Could not automatically remove completed Worker:', error)
      }
    }
    return roomMessages
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    for (const item of progressById.values()) {
      if (item.status === 'queued' || item.status === 'running') updateRoomProgressItem(item, 'failed', t('mainDialog.groupProgressFailed'), message)
    }
    publishProgress()
    for (const handoff of handoffs.filter(item => item.status === 'pending')) {
      handoff.status = 'failed'
      handoff.error = message
    }
    throw error
  } finally {
    abortSignal?.removeEventListener('abort', stop)
    if (session && sessions.get(sessionId) === session) {
      sessions.delete(sessionId)
      onProgress?.({ type: 'group_session_state', groupId: group.id, active: false })
    }
  }
}

function speakerFor (speaker: Pick<AgentDefinition, 'name' | 'icon'>) {
  return { speakerName: speaker.name, speakerIcon: speaker.icon?.trim() || '🤖' }
}

function memberIdFromStream (groupId: string, value: unknown): string {
  const streamId = stringValue(value)
  const prefix = `${groupId}:member:`
  return streamId.startsWith(prefix) ? streamId.slice(prefix.length).split(':', 1)[0].trim() : ''
}

function stringValue (value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function pendingClarificationTargets (value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const targets = Array.isArray(item?.targetAgentIds) && item.targetAgentIds.length ? item.targetAgentIds : fallback
    const delivered = Array.isArray(item?.deliveredToAgentIds) ? item.deliveredToAgentIds : []
    return targets.filter((id: unknown): id is string => typeof id === 'string' && !delivered.includes(id))
  })
}
