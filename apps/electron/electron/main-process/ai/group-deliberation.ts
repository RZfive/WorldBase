import type { AIHarness, AIRequestOptions, ProgressEvent } from '../../../src/main/ai-harness/types.js'
import type { MessageContent } from '../../../src/main/ai-engine/providers/openai-provider.js'
import type { AgentDefinition, AgentGroupCollaborationMode, AgentGroupCollaborationPlan, AgentGroupDefinition, AgentGroupParticipant, AgentGroupProgressSnapshot, AgentGroupTranscript, AgentGroupTranscriptToolCall, AgentMemoryScope, AgentSidechatSession, ChannelBinding } from '../../../src/shared/agent-workspace-types.js'
import { t } from '../../../src/main/i18n/main-i18n.js'
import { mainState } from '../state.js'
import { buildActiveAgentSection, buildActiveGroupSection, resolveProviderConfig, resolveSkillContentsByIds } from './agent-context.js'
import { firstNonEmptyLine, getLastUserMessageText, getMessageText, serializeMessageContentForDisplay, truncateSectionText } from '../chat-message-utils.js'

const GROUP_COLLAB_TOOL_NAMES = ['message_agent', 'read_board', 'update_board', 'reply_to_user']

function mergeUniqueValues<T extends string> (...collections: Array<readonly T[] | undefined>): T[] {
  return Array.from(new Set(collections.flatMap(collection => collection ?? [])))
}

function resolveGroupToolAllowlist (allowedToolNames?: string[]): string[] {
  if (!allowedToolNames || allowedToolNames.length === 0) return []
  return mergeUniqueValues(allowedToolNames, GROUP_COLLAB_TOOL_NAMES)
}

function resolveGroupMemoryScopes (agentScopes: AgentMemoryScope[], group: AgentGroupDefinition): AgentMemoryScope[] {
  return mergeUniqueValues(agentScopes, group.sharedMemoryScopes)
}

function throwIfAborted (signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'Group deliberation aborted.'))
}

export interface GroupDeliberationResult {
  promptSection: string | null
  transcript: AgentGroupTranscript | null
}

export interface DirectGroupReplyRoute {
  targetAgentId: string
  normalizedRequest: string
}

export type GroupDeliberationMode = AgentGroupCollaborationMode

export interface ParsedGroupRouting {
  mode: GroupDeliberationMode
  selectedMemberIds: string[]
  mentionedMemberIds: string[]
  normalizedRequest: string
  plannerAgentId?: string
}

export interface GroupRoundCoordinatorPlan {
  shouldContinue: boolean
  selectedMemberIds: string[]
  request: string
  focus: string
}

export interface GroupPlannerReview {
  memberId: string
  review: string
}

export type GroupDeliberationProgressCallback = (
  stageOrEvent: string | ProgressEvent | { type: 'group_collaboration_plan'; plan: AgentGroupCollaborationPlan } | { type: 'group_session_state'; groupId: string; active: boolean } | { type: 'group_progress'; groupProgress: AgentGroupProgressSnapshot } | { type: 'agent_sidechat'; sidechat: AgentSidechatSession } | { type: 'group_board'; board: import('../../../src/shared/agent-workspace-types.js').SharedBoardSnapshot } | { type: 'group_direct_reply'; directReply: import('../../../src/shared/agent-workspace-types.js').AgentGroupDirectReply } | { type: 'group_user_injection'; injection: import('../../../src/shared/agent-workspace-types.js').AgentGroupUserInjection } | { type: 'group_peer_message'; peerMessage: import('../../../src/shared/agent-workspace-types.js').AgentGroupMessage },
  detail?: string
) => void

/**
 * The portion of an AI backend used by Electron's group-session orchestration.
 *
 * Group state, UI events, and the shared-board implementation remain in
 * Electron. Provider execution and the model/tool loop can be selected per
 * request, allowing the Rust facade to run every planner, member, and peer
 * turn without requiring the legacy AIEngine implementation.
 */
export interface GroupExecutionEngine extends Pick<AIHarness, 'chat' | 'chatStream' | 'getAvailableTools'> {}

type GroupRunContext = Pick<AIRequestOptions,
  'authMode' | 'getAuthMode' | 'hostConversationId' | 'hostSessionId' | 'workspaceRoot' | 'memoryScopes' | 'memoryEmbedding'
>

export function normalizeMentionToken (value: string): string {
  return value
    .replace(/^@+/, '')
    .replace(/[【】\[\]（）(){}<>《》「」『』"'“”‘’`~!?,.:;，。！？、：；]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase()
}

export function resolveKnownMentionMatch (candidate: string, normalizedKnownMentions: string[]): { token: string; endOffset: number } | null {
  for (const token of normalizedKnownMentions) {
    for (let endOffset = 1; endOffset <= candidate.length; endOffset++) {
      if (normalizeMentionToken(candidate.slice(0, endOffset)) === token) {
        return { token, endOffset }
      }
    }
  }

  return null
}

export function collectKnownMentionMatches (value: string, knownMentions: Iterable<string>): Array<{ start: number; end: number; token: string }> {
  const normalizedKnownMentions = Array.from(new Set(Array.from(knownMentions)
    .map(token => normalizeMentionToken(token))
    .filter(Boolean)))
    .sort((left, right) => right.length - left.length)

  if (normalizedKnownMentions.length === 0) return []

  const matches: Array<{ start: number; end: number; token: string }> = []

  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '@') continue

    const nextAt = value.indexOf('@', index + 1)
    const candidateEnd = nextAt >= 0 ? nextAt : value.length
    const candidate = value.slice(index + 1, candidateEnd)
    const resolved = resolveKnownMentionMatch(candidate, normalizedKnownMentions)
    if (!resolved) continue

    let end = index + 1 + resolved.endOffset
    while (end < value.length && /[\s【】\[\]（）(){}<>《》「」『』"'“”‘’`~!?,.:;，。！？、：；]/.test(value[end])) {
      end++
    }

    matches.push({
      start: index,
      end,
      token: resolved.token
    })

    index = Math.max(index, end - 1)
  }

  return matches
}

export function extractMentionTokens (value: string, knownMentions: Iterable<string>): string[] {
  return collectKnownMentionMatches(value, knownMentions).map(match => match.token)
}

export function stripKnownMentions (value: string, knownMentions: Iterable<string>): string {
  const matches = collectKnownMentionMatches(value, knownMentions)
  if (matches.length === 0) return value.trim()

  let result = value
  for (const match of [...matches].reverse()) {
    result = `${result.slice(0, match.start)} ${result.slice(match.end)}`
  }

  return result
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

export function sanitizeGroupMemberSelection (candidateIds: string[], selectedIds: unknown): string[] {
  const allowed = new Set(candidateIds)
  if (!Array.isArray(selectedIds)) return []
  return Array.from(new Set(selectedIds
    .map(value => typeof value === 'string' ? value.trim() : '')
    .filter((value): value is string => Boolean(value) && allowed.has(value))))
}

export function extractJsonObjectCandidate (value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fencedMatch?.[1]?.trim() || trimmed
  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    return candidate
  }
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return candidate.slice(start, end + 1)
  }
  return null
}

export function parseGroupRoundCoordinatorPlan (input: {
  rawText: string
  candidateIds: string[]
  fallbackMemberIds: string[]
  fallbackRequest: string
  fallbackShouldContinue: boolean
}): GroupRoundCoordinatorPlan {
  const fallbackSelection = sanitizeGroupMemberSelection(input.candidateIds, input.fallbackMemberIds)
  const fallbackPlan: GroupRoundCoordinatorPlan = {
    shouldContinue: input.fallbackShouldContinue && fallbackSelection.length > 0,
    selectedMemberIds: input.fallbackShouldContinue ? fallbackSelection : [],
    request: truncateSectionText(input.fallbackRequest, 600),
    focus: ''
  }
  const jsonCandidate = extractJsonObjectCandidate(input.rawText)
  if (!jsonCandidate) return fallbackPlan

  try {
    const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>
    const selectedMemberIds = sanitizeGroupMemberSelection(input.candidateIds, parsed.memberIds)
    const request = typeof parsed.request === 'string' && parsed.request.trim()
      ? truncateSectionText(parsed.request, 600)
      : fallbackPlan.request
    const focusSource = typeof parsed.focus === 'string' && parsed.focus.trim()
      ? parsed.focus
      : typeof parsed.summary === 'string' && parsed.summary.trim()
          ? parsed.summary
          : ''
    const focus = truncateSectionText(focusSource, 240)
    const shouldContinue = typeof parsed.shouldContinue === 'boolean'
      ? parsed.shouldContinue && selectedMemberIds.length > 0
      : selectedMemberIds.length > 0
    return {
      shouldContinue,
      selectedMemberIds: shouldContinue ? selectedMemberIds : [],
      request,
      focus
    }
  } catch {
    return fallbackPlan
  }
}

export function parseGroupRouting (group: AgentGroupDefinition, latestUserMessage: string): ParsedGroupRouting {
  const workerMemberIds = Array.from(new Set(group.memberAgentIds.filter(memberId => memberId && memberId !== group.coordinatorAgentId)))
  const coordinator = group.coordinatorAgentId ? mainState.agentStore?.get(group.coordinatorAgentId) || null : null
  if (workerMemberIds.length === 0) {
    return {
      mode: 'coordinator_only',
      selectedMemberIds: [],
      mentionedMemberIds: [],
      normalizedRequest: latestUserMessage.trim(),
      plannerAgentId: group.coordinatorAgentId
    }
  }

  const knownMentions = new Set<string>([
    '主agent',
    '主协调',
    '协调agent',
    'coordinator',
    'mainagent',
    'all',
    'everyone',
    '全组',
    '全员',
    '全部agent',
    '所有agent'
  ])
  const coordinatorTokens = [
    normalizeMentionToken(group.coordinatorAgentId),
    normalizeMentionToken(coordinator?.name || '')
  ].filter(Boolean)
  for (const token of coordinatorTokens) {
    knownMentions.add(token)
  }
  const memberMentions = new Map<string, string>()
  for (const memberId of workerMemberIds) {
    const agent = mainState.agentStore?.get(memberId)
    const tokens = [
      normalizeMentionToken(memberId),
      normalizeMentionToken(agent?.name || '')
    ].filter(Boolean)
    for (const token of tokens) {
      memberMentions.set(token, memberId)
      knownMentions.add(token)
    }
  }

  const mentionTokens = extractMentionTokens(latestUserMessage, knownMentions)
  const normalizedRequest = stripKnownMentions(latestUserMessage, knownMentions) || latestUserMessage.trim()
  const coordinatorOnlyRequested = mentionTokens.some(token => {
    return token === '主agent' || token === '主协调' || token === '协调agent' || token === 'coordinator' || token === 'mainagent' || coordinatorTokens.includes(token)
  })
  const fullGroupRequested = mentionTokens.some(token => {
    return token === 'all' || token === 'everyone' || token === '全组' || token === '全员' || token === '全部agent' || token === '所有agent'
  })
  const selectedMemberIds = Array.from(new Set(mentionTokens.map(token => memberMentions.get(token)).filter((value): value is string => Boolean(value))))

  if (fullGroupRequested) {
    return {
      mode: 'discussion',
      selectedMemberIds: workerMemberIds,
      mentionedMemberIds: selectedMemberIds,
      normalizedRequest,
      plannerAgentId: group.coordinatorAgentId
    }
  }

  if (coordinatorOnlyRequested) {
    return {
      mode: 'coordinator_decides',
      selectedMemberIds: workerMemberIds,
      mentionedMemberIds: selectedMemberIds,
      normalizedRequest,
      plannerAgentId: group.coordinatorAgentId
    }
  }

  if (selectedMemberIds.length === 1) {
    const plannerAgentId = selectedMemberIds[0]
    return {
      mode: 'targeted',
      selectedMemberIds,
      mentionedMemberIds: selectedMemberIds,
      normalizedRequest,
      plannerAgentId
    }
  }

  if (selectedMemberIds.length > 1) {
    return {
      mode: 'discussion',
      selectedMemberIds,
      mentionedMemberIds: selectedMemberIds,
      normalizedRequest,
      plannerAgentId: group.coordinatorAgentId
    }
  }

  return {
    mode: 'discussion',
    selectedMemberIds: workerMemberIds,
    mentionedMemberIds: [],
    normalizedRequest,
    plannerAgentId: group.coordinatorAgentId
  }
}

export function resolveDirectGroupReplyRoute (
  group: AgentGroupDefinition | null,
  messages: Array<{ role: string; content: MessageContent }>,
  routingOverride?: ParsedGroupRouting | null
): DirectGroupReplyRoute | null {
  if (!group) return null

  const latestUserMessage = getLastUserMessageText(messages)
  if (!latestUserMessage.trim()) return null

  const routing = routingOverride || parseGroupRouting(group, latestUserMessage)
  if (routing.mode !== 'targeted' || routing.selectedMemberIds.length !== 1) {
    return null
  }

  return {
    targetAgentId: routing.selectedMemberIds[0],
    normalizedRequest: routing.normalizedRequest || latestUserMessage.trim()
  }
}

export function buildDirectGroupReplyPromptSection (route: DirectGroupReplyRoute): string {
  return [
    '## Direct group mention routing',
    '- The user explicitly mentioned you inside the selected agent group.',
    '- The active agent section defines who you are. Do not claim to be the group coordinator unless the active agent and the coordinator are the same agent.',
    '- Reply directly to the user as yourself.',
    '- Do not relay through the coordinator and do not describe any internal group discussion unless asked.',
    `- Cleaned user request: ${truncateSectionText(route.normalizedRequest, 600)}`
  ].join('\n')
}

export function buildGroupMemberRoleSection (input: {
  memberName: string
  coordinatorName: string
  reportToName: string
  initiatedByName: string
  isDiscussionMode: boolean
}): string {
  return [
    '## Current role in this group turn',
    `- You are: ${input.memberName}`,
    `- Group coordinator: ${input.coordinatorName}`,
    `- This request was initiated by: ${input.initiatedByName}`,
    `- Report your work to: ${input.reportToName}`,
    '- You are not the coordinator unless your own identity exactly matches the coordinator above.',
    '- Do not speak as the coordinator, do not say you are leading the whole group, and do not present other agents\' work as your own.',
    input.isDiscussionMode
      ? '- Produce only your own internal contribution for the coordinator to review and synthesize.'
      : '- Produce only your own supporting result for the coordinator unless a direct-user reply is explicitly requested elsewhere.'
  ].join('\n')
}

export function createAgentSidechatSession (input: {
  group: AgentGroupDefinition
  memberId: string
  agentName: string
  mode: AgentSidechatSession['mode']
  initiatedByName: string
  reportToName: string
  request: string
  round: number
}): AgentSidechatSession {
  const timestamp = new Date().toISOString()
  return {
    id: `${input.group.id}_${input.memberId}_${input.round}`,
    groupId: input.group.id,
    groupName: input.group.name,
    agentId: input.memberId,
    agentName: input.agentName,
    mode: input.mode,
    initiatedByName: input.initiatedByName,
    reportToName: input.reportToName,
    request: input.request,
    response: '',
    status: 'running',
    round: input.round,
    updatedAt: timestamp,
    progress: []
  }
}

export function appendAgentSidechatProgress (session: AgentSidechatSession, stage: string, detail?: string): void {
  session.updatedAt = new Date().toISOString()
  session.progress = [...session.progress, {
    at: session.updatedAt,
    stage,
    detail
  }].slice(-6)
}

export function cloneAgentSidechatSession (session: AgentSidechatSession): AgentSidechatSession {
  return {
    ...session,
    progress: session.progress.map(step => ({ ...step }))
  }
}

export function emitAgentSidechatSession (
  onProgress: GroupDeliberationProgressCallback | undefined,
  session: AgentSidechatSession
): void {
  onProgress?.({
    type: 'agent_sidechat',
    sidechat: cloneAgentSidechatSession(session)
  })
}

export function buildGroupTranscriptSummary (
  group: AgentGroupDefinition,
  entries: AgentGroupTranscript['entries'],
  mode: Exclude<GroupDeliberationMode, 'coordinator_only'>
): string {
  const participantNames = Array.from(new Set(entries.map(entry => entry.agentName))).filter(Boolean)
  const latestFocus = entries.length > 0
    ? firstNonEmptyLine(entries[entries.length - 1].content)
    : ''
  const delimiter = t('mainDialog.groupParticipantDelimiter')
  const lines = [
    mode === 'discussion' || mode === 'coordinator_decides' || mode === 'mentioned_agent_decides'
      ? t('mainDialog.groupTranscriptDiscussionSummary', { group: group.name, rounds: Math.max(...entries.map(entry => entry.round), 0), count: entries.length })
      : t('mainDialog.groupTranscriptTargetedSummary', { group: group.name, count: entries.length }),
    participantNames.length > 0 ? t('mainDialog.groupTranscriptParticipants', { names: participantNames.join(delimiter) }) : ''
  ]

  if (latestFocus) {
    lines.push(t('mainDialog.groupTranscriptLatestFocus', { focus: truncateSectionText(latestFocus, 220) }))
  }

  return lines.filter(Boolean).join('\n')
}

export function createGroupProgressSnapshot (
  group: AgentGroupDefinition,
  memberIds: string[],
  request: string,
  totalRounds = group.maxRounds
): AgentGroupProgressSnapshot {
  const normalizedTotalRounds = Math.max(1, totalRounds)
  const timestamp = new Date().toISOString()

  return {
    groupId: group.id,
    groupName: group.name,
    request,
    status: 'running',
    activeRound: 0,
    totalRounds: normalizedTotalRounds,
    maxParallelWorkers: Math.max(1, group.maxParallelWorkers),
    queuedCount: memberIds.length,
    runningCount: 0,
    completedCount: 0,
    failedCount: 0,
    items: memberIds.map((memberId, index) => ({
      id: `${group.id}_${memberId}_${index}`,
      agentId: memberId,
      agentName: mainState.agentStore?.get(memberId)?.name || memberId,
      status: 'queued',
      currentRound: 0,
      completedRounds: 0,
      totalRounds: normalizedTotalRounds,
      stage: t('mainDialog.groupProgressWaitingStart'),
      updatedAt: timestamp,
      progress: []
    }))
  }
}

export function cloneGroupProgressSnapshot (snapshot: AgentGroupProgressSnapshot): AgentGroupProgressSnapshot {
  return {
    ...snapshot,
    items: snapshot.items.map(item => ({
      ...item,
      progress: item.progress.map(step => ({ ...step }))
    }))
  }
}

export function getGroupProgressItem (snapshot: AgentGroupProgressSnapshot, agentId: string) {
  return snapshot.items.find(item => item.agentId === agentId) || null
}

export function appendGroupProgressStep (item: AgentGroupProgressSnapshot['items'][number], stage: string, detail?: string): void {
  item.progress = [...item.progress, {
    at: new Date().toISOString(),
    stage,
    detail
  }].slice(-4)
}

export function refreshGroupProgressSnapshot (snapshot: AgentGroupProgressSnapshot): void {
  snapshot.queuedCount = snapshot.items.filter(item => item.status === 'queued').length
  snapshot.runningCount = snapshot.items.filter(item => item.status === 'running').length
  snapshot.completedCount = snapshot.items.filter(item => item.status === 'completed').length
  snapshot.failedCount = snapshot.items.filter(item => item.status === 'failed').length
  snapshot.status = snapshot.runningCount > 0 || snapshot.queuedCount > 0
    ? 'running'
    : snapshot.completedCount > 0
      ? 'completed'
      : 'failed'
}

export function emitGroupProgressSnapshot (
  onProgress: GroupDeliberationProgressCallback | undefined,
  snapshot: AgentGroupProgressSnapshot
): void {
  refreshGroupProgressSnapshot(snapshot)
  onProgress?.({
    type: 'group_progress',
    groupProgress: cloneGroupProgressSnapshot(snapshot)
  })
}

export function createGroupParticipantSummary (agentId: string): AgentGroupParticipant {
  return {
    agentId,
    agentName: mainState.agentStore?.get(agentId)?.name || agentId
  }
}

export function createGroupParticipantSummaries (agentIds: string[]): AgentGroupParticipant[] {
  return Array.from(new Set(agentIds.filter(Boolean))).map((agentId) => createGroupParticipantSummary(agentId))
}

export function buildGroupCollaborationPlanReason (input: {
  phase: AgentGroupCollaborationPlan['phase']
  mode: GroupDeliberationMode
  plannerName: string
  reportToName: string
  mentionedParticipants: AgentGroupParticipant[]
  invitedParticipants: AgentGroupParticipant[]
  round?: number
  focus?: string
  shouldContinue?: boolean
}): string {
  const mentionedNames = input.mentionedParticipants.map(participant => participant.agentName)
  const invitedNames = input.invitedParticipants.map(participant => participant.agentName)
  const delimiter = t('mainDialog.groupParticipantDelimiter')
  const invitedSummary = invitedNames.join(delimiter)
  const focus = input.focus ? truncateSectionText(input.focus, 180) : ''

  if (input.phase === 'planning') {
    if (input.mode === 'coordinator_only') {
      return t('mainDialog.groupPlanCoordinatorOnly', { planner: input.plannerName })
    }
    if (input.mode === 'mentioned_agent_decides') {
      return t('mainDialog.groupPlanMentionedAgentDecides', { planner: input.plannerName })
    }
    if (input.mode === 'coordinator_decides') {
      return t('mainDialog.groupPlanCoordinatorDecides', { planner: input.plannerName })
    }
    if (input.mode === 'discussion' && mentionedNames.length > 0) {
      return t('mainDialog.groupPlanExplicitDiscussion', { names: mentionedNames.join(delimiter) })
    }
    return t('mainDialog.groupPlanDefaultDiscussion')
  }

  if (input.phase === 'executing') {
    if (!input.shouldContinue || invitedNames.length === 0) {
      return focus
        ? t('mainDialog.groupPlanNoMoreExpansionWithFocus', { planner: input.plannerName, reportTo: input.reportToName, focus })
        : t('mainDialog.groupPlanNoMoreExpansion', { planner: input.plannerName, reportTo: input.reportToName })
    }
    if (input.mode === 'mentioned_agent_decides') {
      return focus
        ? t('mainDialog.groupPlanMentionedInviteWithFocus', { planner: input.plannerName, names: invitedSummary, focus })
        : t('mainDialog.groupPlanMentionedInvite', { planner: input.plannerName, names: invitedSummary })
    }
    return focus
      ? t('mainDialog.groupPlanRoundInviteWithFocus', { planner: input.plannerName, round: input.round || 1, names: invitedSummary, focus })
      : t('mainDialog.groupPlanRoundInvite', { planner: input.plannerName, round: input.round || 1, names: invitedSummary })
  }

  if (invitedNames.length > 0) {
    return t('mainDialog.groupPlanCompletedWithInvites', { reportTo: input.reportToName, names: invitedSummary })
  }
  return t('mainDialog.groupPlanCompletedWithoutInvites', { reportTo: input.reportToName })
}

export function createGroupCollaborationPlan (input: {
  group: AgentGroupDefinition
  routing: ParsedGroupRouting
  plannerName: string
  reportToName: string
  originalRequest: string
  phase: AgentGroupCollaborationPlan['phase']
  candidateMemberIds: string[]
  invitedMemberIds: string[]
  round?: number
  focus?: string
  shouldContinue?: boolean
}): AgentGroupCollaborationPlan {
  const plannerId = input.routing.plannerAgentId || input.group.coordinatorAgentId
  const mentionedParticipants = createGroupParticipantSummaries(input.routing.mentionedMemberIds)
  const invitedParticipants = createGroupParticipantSummaries(input.invitedMemberIds)

  return {
    groupId: input.group.id,
    groupName: input.group.name,
    mode: input.routing.mode,
    phase: input.phase,
    planner: createGroupParticipantSummary(plannerId),
    reportToName: input.reportToName,
    originalRequest: input.originalRequest,
    normalizedRequest: input.routing.normalizedRequest || input.originalRequest,
    reason: buildGroupCollaborationPlanReason({
      phase: input.phase,
      mode: input.routing.mode,
      plannerName: input.plannerName,
      reportToName: input.reportToName,
      mentionedParticipants,
      invitedParticipants,
      round: input.round,
      focus: input.focus,
      shouldContinue: input.shouldContinue
    }),
    round: input.round,
    mentionedParticipants,
    candidateParticipants: createGroupParticipantSummaries(input.candidateMemberIds),
    invitedParticipants,
    updatedAt: new Date().toISOString()
  }
}

export function cloneGroupCollaborationPlan (plan: AgentGroupCollaborationPlan): AgentGroupCollaborationPlan {
  return {
    ...plan,
    planner: { ...plan.planner },
    mentionedParticipants: plan.mentionedParticipants.map(participant => ({ ...participant })),
    candidateParticipants: plan.candidateParticipants.map(participant => ({ ...participant })),
    invitedParticipants: plan.invitedParticipants.map(participant => ({ ...participant }))
  }
}

export function emitGroupCollaborationPlan (
  onProgress: GroupDeliberationProgressCallback | undefined,
  plan: AgentGroupCollaborationPlan
): void {
  onProgress?.({
    type: 'group_collaboration_plan',
    plan: cloneGroupCollaborationPlan(plan)
  })
}

export function chunkStringArray (values: string[], chunkSize: number): string[][] {
  const chunks: string[][] = []
  const size = Math.max(1, chunkSize)
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

export function summarizeGroupNote (value: string): string {
  const firstLine = firstNonEmptyLine(value)
  return truncateSectionText(firstLine || value, 220)
}

export async function buildGroupRoundCoordinatorPlan (input: {
  runtimeAiEngine: GroupExecutionEngine
  planner: AgentDefinition | null
  group: AgentGroupDefinition
  messages: Array<{ role: string; content: MessageContent }>
  channelBinding?: ChannelBinding | null
  targetProjectId?: string | null
  fallbackReasoningStrength?: 'low' | 'medium' | 'high' | 'max'
  candidateMemberIds: string[]
  priorNotes: GroupPlannerReview[]
  latestUserMessage: string
  normalizedRequest: string
  mentionedMemberIds: string[]
  round: number
  totalRounds: number
  selectionSource: 'explicit_mentions' | 'coordinator_decides' | 'mentioned_agent_decides' | 'default_group_discussion'
  abortSignal?: AbortSignal
  runtimeRequestContext?: GroupRunContext
}): Promise<GroupRoundCoordinatorPlan> {
  throwIfAborted(input.abortSignal)
  const fallbackRequest = truncateSectionText(input.normalizedRequest || input.latestUserMessage, 600)
  const fallbackMemberIds = input.selectionSource === 'mentioned_agent_decides'
    ? []
    : input.candidateMemberIds
  const reviewedCandidateIds = new Set(input.priorNotes.map(review => review.memberId))
  const fallbackShouldContinue = fallbackMemberIds.some(memberId => !reviewedCandidateIds.has(memberId))
  if (!input.planner || input.candidateMemberIds.length === 0) {
    return {
      shouldContinue: fallbackShouldContinue,
      selectedMemberIds: fallbackShouldContinue ? fallbackMemberIds : [],
      request: fallbackRequest,
      focus: ''
    }
  }

  // Memory recall is Rust-owned; the planner prompt carries no host-side
  // memory sections.
  const candidateLines = input.candidateMemberIds.map((memberId) => {
    const member = mainState.agentStore?.get(memberId)
    return `- ${member?.name || memberId} (${memberId})`
  }).join('\n')
  const mentionedLines = input.mentionedMemberIds.map((memberId) => {
    const member = mainState.agentStore?.get(memberId)
    return `- ${member?.name || memberId} (${memberId})`
  }).join('\n')
  const latestPriorReviews = input.candidateMemberIds.map((memberId) => {
    const member = mainState.agentStore?.get(memberId)
    const latestReview = [...input.priorNotes].reverse().find(review => review.memberId === memberId)
    if (latestReview) {
      return latestReview.review
    }
    return [
      `### Latest review · ${member?.name || memberId} (${memberId})`,
      'No returned note yet.'
    ].join('\n')
  })
  const priorNotesSection = latestPriorReviews.length > 0
    ? `## Latest candidate assignment reviews\n${truncateSectionText(latestPriorReviews.join('\n\n'), 6000)}`
    : '## Latest candidate assignment reviews\n- No prior round reviews yet.'
  const planningPrompt = [
    '## Internal discussion planner instructions',
    '- Decide whether another internal discussion round is needed.',
    '- Choose only the members that should contribute in this round.',
    '- If a member\'s existing note no longer needs modification, do not select them again; omitted members with completed work will be treated as finished.',
    '- Compare each candidate member\'s latest returned note against the user request and the most recent assigned brief/focus recorded below.',
    '- The review section below already gives you the latest known review for each current candidate member. Base your decision on those latest reviews instead of continuing by default.',
    '- If a candidate\'s latest note already satisfies the assigned task and the user request for that slice, omit them so their work stops here.',
    '- Only continue a member into another round when you can name concrete defects, missing evidence, unanswered requirements, or requested revisions.',
    '- Write a clearer round brief that reflects the user request plus gaps, defects, contradictions, or missing evidence from prior notes.',
    '- Do not repeat the original request verbatim when a sharper follow-up is possible.',
    input.selectionSource === 'explicit_mentions'
      ? '- The user explicitly selected the candidate members below; you must only choose from that list.'
      : input.selectionSource === 'mentioned_agent_decides'
        ? '- You were explicitly mentioned inside the group. First decide whether you can complete the task yourself. Only if you need help should you choose some or all teammates from the candidate list below.'
        : input.selectionSource === 'default_group_discussion'
          ? '- The user did not specify exact members, so you may choose from the default candidate list below based on who is most useful.'
        : '- The coordinator may choose whichever candidate members are most useful for this round.',
    '- If no member input is needed, return shouldContinue=false and an empty memberIds array.',
    '- Respond with strict JSON only. Plain JSON is preferred; fenced JSON is tolerated as a fallback.',
    '',
    `Round: ${input.round}/${input.totalRounds}`,
    `User request: ${fallbackRequest}`,
    input.mentionedMemberIds.length > 0 ? 'Explicitly mentioned members:' : '',
    input.mentionedMemberIds.length > 0 ? mentionedLines : '',
    'Candidate members:',
    candidateLines || '- None',
    priorNotesSection,
    '',
    'Return JSON in this exact shape:',
    '{"shouldContinue":true,"memberIds":["agent_id"],"request":"clear round brief","focus":"one-line reason"}'
  ].join('\n')

  try {
    const response = await input.runtimeAiEngine.chat(input.messages, {
      ...input.runtimeRequestContext,
      agentId: input.planner.id,
      targetProjectId: input.targetProjectId ?? null,
      providerConfig: resolveProviderConfig(
        input.planner.providerId,
        input.planner.modelId,
        input.planner.reasoningStrength || input.fallbackReasoningStrength || 'medium'
      ),
      activeSkillContents: resolveSkillContentsByIds(input.planner.skillIds),
      systemPromptSections: [
        buildActiveAgentSection(input.planner),
        buildActiveGroupSection(input.group),
        planningPrompt
      ],
      deniedToolNames: input.runtimeAiEngine.getAvailableTools().map(tool => tool.name),
      abortSignal: input.abortSignal
    })
    return parseGroupRoundCoordinatorPlan({
      rawText: getMessageText(response.content),
      candidateIds: input.candidateMemberIds,
      fallbackMemberIds,
      fallbackRequest,
      fallbackShouldContinue
    })
  } catch {
    throwIfAborted(input.abortSignal)
    return {
      shouldContinue: fallbackShouldContinue,
      selectedMemberIds: fallbackShouldContinue ? fallbackMemberIds : [],
      request: fallbackRequest,
      focus: ''
    }
  }
}
