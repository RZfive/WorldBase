import type { AIEngine, ProgressCallback, ProgressEvent } from '../../../src/main/ai-engine/ai-engine.js'
import type { MessageContent } from '../../../src/main/ai-engine/providers/openai-provider.js'
import type { AgentDefinition, AgentGroupCollaborationMode, AgentGroupCollaborationPlan, AgentGroupDefinition, AgentGroupParticipant, AgentGroupProgressSnapshot, AgentGroupTranscript, AgentSidechatSession, ChannelBinding } from '../../../src/shared/agent-workspace-types.js'
import { t } from '../../../src/main/i18n/main-i18n.js'
import { mainState } from '../state.js'
import { buildActiveAgentSection, buildActiveGroupSection, resolveProviderConfig, resolveSkillContentsByIds } from './agent-context.js'
import { firstNonEmptyLine, getLastUserMessageText, getMessageText, serializeMessageContentForDisplay, truncateSectionText } from '../chat-message-utils.js'

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
  stageOrEvent: string | ProgressEvent | { type: 'group_collaboration_plan'; plan: AgentGroupCollaborationPlan } | { type: 'group_progress'; groupProgress: AgentGroupProgressSnapshot } | { type: 'agent_sidechat'; sidechat: AgentSidechatSession },
  detail?: string
) => void

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
  runtimeAiEngine: AIEngine
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
}): Promise<GroupRoundCoordinatorPlan> {
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

  const plannerMemory = mainState.memoryEngine?.buildPromptContext({
    agent: input.planner,
    group: input.group,
    channelBinding: input.channelBinding,
    userMessage: input.latestUserMessage,
    targetProjectId: input.targetProjectId,
    userId: 'local-user',
    enabledScopeTypes: input.planner.memoryScopes
  })
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
        ...(plannerMemory?.sections || []),
        planningPrompt
      ],
      deniedToolNames: input.runtimeAiEngine.getAvailableTools().map(tool => tool.name)
    })
    return parseGroupRoundCoordinatorPlan({
      rawText: getMessageText(response.content),
      candidateIds: input.candidateMemberIds,
      fallbackMemberIds,
      fallbackRequest,
      fallbackShouldContinue
    })
  } catch {
    return {
      shouldContinue: fallbackShouldContinue,
      selectedMemberIds: fallbackShouldContinue ? fallbackMemberIds : [],
      request: fallbackRequest,
      focus: ''
    }
  }
}

export async function buildGroupDeliberationSection (input: {
  messages: Array<{ role: string; content: MessageContent }>
  group: AgentGroupDefinition
  routing?: ParsedGroupRouting
  channelBinding?: ChannelBinding | null
  targetProjectId?: string | null
  fallbackReasoningStrength?: 'low' | 'medium' | 'high' | 'max'
  onProgress?: GroupDeliberationProgressCallback
}): Promise<GroupDeliberationResult> {
  if (!mainState.aiEngine || !mainState.agentStore) {
    return { promptSection: null, transcript: null }
  }

  const runtimeAiEngine = mainState.aiEngine
  const runtimeAgentStore = mainState.agentStore

  const allToolNames = runtimeAiEngine.getAvailableTools().map(tool => tool.name)
  const latestUserMessage = getLastUserMessageText(input.messages)
  const routing = input.routing || parseGroupRouting(input.group, latestUserMessage)
  const coordinator = runtimeAgentStore.get(input.group.coordinatorAgentId)
  const planner = routing.mode === 'mentioned_agent_decides' && routing.plannerAgentId
    ? runtimeAgentStore.get(routing.plannerAgentId)
    : coordinator
  const isDiscussionMode = routing.mode === 'discussion' || routing.mode === 'coordinator_decides' || routing.mode === 'mentioned_agent_decides'
  const memberIds = routing.selectedMemberIds
  const totalRounds = isDiscussionMode ? input.group.maxRounds : 1
  const plannerName = planner?.name || coordinator?.name || t('mainDialog.defaultAgentName')
  const coordinatorName = coordinator?.name || plannerName
  const reportToName = routing.mode === 'mentioned_agent_decides' ? plannerName : coordinatorName
  const initiatorName = routing.mode === 'targeted' ? t('mainDialog.localUserName') : reportToName
  const sidechatMode: AgentSidechatSession['mode'] = isDiscussionMode
    ? 'group_deliberation'
    : 'user_targeted'
  const discussionRequest = truncateSectionText(routing.normalizedRequest || latestUserMessage, 600)
  const snapshot = createGroupProgressSnapshot(input.group, memberIds, discussionRequest, totalRounds)
  const discussionSelectionSource = routing.mode === 'discussion'
    ? (routing.mentionedMemberIds.length > 0 ? 'explicit_mentions' : 'default_group_discussion')
    : routing.mode === 'mentioned_agent_decides'
      ? 'mentioned_agent_decides'
      : 'coordinator_decides'
  const originalRequest = latestUserMessage.trim()
  const initialInvitedMemberIds = routing.mode === 'discussion' ? memberIds : []
  let latestInvitedMemberIds = [...initialInvitedMemberIds]

  emitGroupCollaborationPlan(input.onProgress, createGroupCollaborationPlan({
    group: input.group,
    routing,
    plannerName,
    reportToName,
    originalRequest,
    phase: 'planning',
    candidateMemberIds: memberIds,
    invitedMemberIds: initialInvitedMemberIds
  }))

  if (memberIds.length === 0 || routing.mode === 'coordinator_only') {
    emitGroupCollaborationPlan(input.onProgress, createGroupCollaborationPlan({
      group: input.group,
      routing,
      plannerName,
      reportToName,
      originalRequest,
      phase: 'completed',
      candidateMemberIds: memberIds,
      invitedMemberIds: [],
      shouldContinue: false
    }))
    return { promptSection: null, transcript: null }
  }

  const notes: string[] = []
  const plannerNotes: GroupPlannerReview[] = []
  const entries: AgentGroupTranscript['entries'] = []

  emitGroupProgressSnapshot(input.onProgress, snapshot)

  for (let round = 1; round <= totalRounds; round++) {
    snapshot.activeRound = round
    const candidateMemberIds = memberIds.filter(memberId => {
      const item = getGroupProgressItem(snapshot, memberId)
      if (!item) return false
      return item.status !== 'failed' && item.status !== 'completed'
    })

    if (candidateMemberIds.length === 0) {
      break
    }

    const roundPlan = isDiscussionMode
      ? await buildGroupRoundCoordinatorPlan({
          runtimeAiEngine,
          planner,
          group: input.group,
          messages: input.messages,
          channelBinding: input.channelBinding,
          targetProjectId: input.targetProjectId,
          fallbackReasoningStrength: input.fallbackReasoningStrength,
          candidateMemberIds,
          priorNotes: plannerNotes,
          latestUserMessage,
          normalizedRequest: discussionRequest,
          mentionedMemberIds: routing.mentionedMemberIds,
          round,
          totalRounds,
          selectionSource: discussionSelectionSource
        })
      : {
          shouldContinue: candidateMemberIds.length > 0,
          selectedMemberIds: candidateMemberIds,
          request: discussionRequest,
          focus: ''
        }
    const roundMemberIds = roundPlan.selectedMemberIds.filter(memberId => candidateMemberIds.includes(memberId))
    latestInvitedMemberIds = [...roundMemberIds]

    emitGroupCollaborationPlan(input.onProgress, createGroupCollaborationPlan({
      group: input.group,
      routing,
      plannerName,
      reportToName,
      originalRequest,
      phase: 'executing',
      candidateMemberIds,
      invitedMemberIds: roundMemberIds,
      round,
      focus: roundPlan.focus,
      shouldContinue: roundPlan.shouldContinue
    }))

    if (isDiscussionMode) {
      for (const memberId of candidateMemberIds) {
        if (roundMemberIds.includes(memberId)) continue
        const item = getGroupProgressItem(snapshot, memberId)
        if (!item || item.status === 'failed') continue
        item.currentRound = round
        const canFinishWithoutMoreChanges = roundPlan.shouldContinue && item.completedRounds > 0
        item.status = canFinishWithoutMoreChanges ? 'completed' : 'queued'
        item.stage = canFinishWithoutMoreChanges ? t('mainDialog.groupProgressCompleted') : t('mainDialog.groupProgressWaitingNextRound')
        item.detail = canFinishWithoutMoreChanges
          ? t('mainDialog.groupProgressNoMoreChanges')
          : (roundPlan.shouldContinue ? t('mainDialog.groupProgressNotSelectedThisRound') : t('mainDialog.groupProgressDiscussionEndedByCoordinator'))
        item.updatedAt = new Date().toISOString()
        appendGroupProgressStep(item, canFinishWithoutMoreChanges ? t('mainDialog.groupProgressDone') : t('mainDialog.groupProgressWaiting'), item.detail)
      }
      emitGroupProgressSnapshot(input.onProgress, snapshot)
    }

    if (!roundPlan.shouldContinue || roundMemberIds.length === 0) {
      break
    }

    for (const batch of chunkStringArray(roundMemberIds, input.group.maxParallelWorkers)) {
      const priorNotesSection = isDiscussionMode && notes.length > 0
        ? `## Prior agent group notes\n${truncateSectionText(notes.slice(-6).join('\n\n'), 3000)}`
        : null
      const roundBriefSection = isDiscussionMode
        ? [
            '## Discussion round brief',
            `- Round: ${round}/${totalRounds}`,
            roundPlan.focus ? `- Focus: ${roundPlan.focus}` : '',
            `- Coordinator request: ${roundPlan.request}`,
            '- Address this refined brief instead of repeating the original request.',
            '- Identify concrete fixes, remaining defects, or evidence gaps that still need attention.'
          ].filter(Boolean).join('\n')
        : [
            '## Targeted sidechat assignment',
            `- User request: ${discussionRequest}`,
            '- Reply for the coordinator, not directly for the end user.',
            '- Focus on the assigned topic only and provide a concise actionable result.'
          ].join('\n')

      const results = await Promise.all(batch.map(async memberId => {
        const item = getGroupProgressItem(snapshot, memberId)
        if (!item) {
          return { memberId, member: null, error: 'Missing progress item for member', noteText: '', noteDisplayText: '' }
        }

        const member = runtimeAgentStore.get(memberId)
        if (!member) {
          item.status = 'failed'
          item.currentRound = round
          item.stage = t('mainDialog.groupProgressInvalidConfig')
          item.detail = t('mainDialog.groupProgressAgentNotFound', { id: memberId })
          item.updatedAt = new Date().toISOString()
          appendGroupProgressStep(item, t('mainDialog.groupProgressInvalidConfig'), item.detail)
          emitGroupProgressSnapshot(input.onProgress, snapshot)
          return { memberId, member: null, error: item.detail, noteText: '', noteDisplayText: '' }
        }

        item.agentName = member.name
        item.status = 'running'
        item.currentRound = round
        item.stage = t('mainDialog.groupProgressPrepareContext')
        item.detail = t('mainDialog.groupProgressRoundDetail', { round })
        item.updatedAt = new Date().toISOString()
        appendGroupProgressStep(item, t('mainDialog.groupProgressPrepareContext'), item.detail)
        emitGroupProgressSnapshot(input.onProgress, snapshot)

        const memberMemory = mainState.memoryEngine?.buildPromptContext({
          agent: member,
          group: input.group,
          channelBinding: input.channelBinding,
          userMessage: latestUserMessage,
          targetProjectId: input.targetProjectId,
          userId: 'local-user',
          enabledScopeTypes: member.memoryScopes
        })
        const sidechatSession = createAgentSidechatSession({
          group: input.group,
          memberId,
          agentName: member.name,
          mode: sidechatMode,
          initiatedByName: initiatorName,
          reportToName,
          request: isDiscussionMode ? roundPlan.request : (routing.normalizedRequest || latestUserMessage),
          round
        })
        emitAgentSidechatSession(input.onProgress, sidechatSession)

        item.stage = isDiscussionMode ? t('mainDialog.groupProgressGroupCollaboration') : t('mainDialog.groupProgressTargetedSidechat')
        item.detail = roundPlan.focus || t('mainDialog.groupProgressRoundDetail', { round })
        item.updatedAt = new Date().toISOString()
        appendGroupProgressStep(item, item.stage, item.detail)
        emitGroupProgressSnapshot(input.onProgress, snapshot)
        appendAgentSidechatProgress(sidechatSession, item.stage, item.detail)
        emitAgentSidechatSession(input.onProgress, sidechatSession)

        try {
          let noteText = ''
          let noteDisplayText = ''
          const sidechatProgress = ((progressEventOrStage: string | ProgressEvent, detail?: string) => {
            if (typeof progressEventOrStage === 'string') {
              appendAgentSidechatProgress(sidechatSession, progressEventOrStage, detail)
            } else if (progressEventOrStage.type === 'progress') {
              appendAgentSidechatProgress(sidechatSession, progressEventOrStage.stage, progressEventOrStage.detail)
            }
            emitAgentSidechatSession(input.onProgress, sidechatSession)
          }) as unknown as ProgressCallback
          for await (const sidechatEvent of runtimeAiEngine.chatStream(input.messages, sidechatProgress, {
            targetProjectId: input.targetProjectId ?? null,
            providerConfig: resolveProviderConfig(
              member.providerId,
              member.modelId,
              member.reasoningStrength || input.fallbackReasoningStrength || 'medium'
            ),
            activeSkillContents: resolveSkillContentsByIds(member.skillIds),
            systemPromptSections: [
              buildActiveAgentSection(member),
              buildActiveGroupSection(input.group),
              buildGroupMemberRoleSection({
                memberName: member.name,
                coordinatorName,
                reportToName,
                initiatedByName: initiatorName,
                isDiscussionMode
              }),
              isDiscussionMode
                ? '## Internal group deliberation instructions\n- You are producing an internal working note for the selected agent group.\n- Do not address the user directly.\n- Do not claim to be the coordinator.\n- Use the refined round brief below, plus prior notes, to deepen or correct the group result.\n- Focus on your unique contribution, defects to fix, missing evidence, and recommended next actions.\n- Be concise and concrete.\n- Do not use any tools in this internal round.'
                : '## Targeted sidechat instructions\n- The user explicitly routed this turn to you inside the selected agent group.\n- Provide supporting material for the coordinator, not a coordinator-style response.\n- Do not address the end user directly unless another prompt section explicitly asks for a direct reply.\n- Focus on the assigned topic only and provide a concise actionable result.\n- If you use tools, keep the final answer short and grounded in what you observed.',
              roundBriefSection,
              ...(memberMemory?.sections || []),
              ...(priorNotesSection ? [priorNotesSection] : [])
            ],
            allowedToolNames: member.allowedTools || [],
            deniedToolNames: isDiscussionMode ? allToolNames : (member.deniedTools || [])
          })) {
            if (sidechatEvent.type === 'token' && sidechatEvent.content) {
              sidechatSession.response += sidechatEvent.content
              sidechatSession.updatedAt = new Date().toISOString()
              emitAgentSidechatSession(input.onProgress, sidechatSession)
            } else if (sidechatEvent.type === 'thinking' && sidechatEvent.content) {
              appendAgentSidechatProgress(sidechatSession, t('mainDialog.groupProgressThinking'), truncateSectionText(sidechatEvent.content, 120))
              emitAgentSidechatSession(input.onProgress, sidechatSession)
            } else if (sidechatEvent.type === 'tool_start' && sidechatEvent.name) {
              appendAgentSidechatProgress(sidechatSession, t('mainDialog.groupProgressToolStart'), sidechatEvent.name)
              emitAgentSidechatSession(input.onProgress, sidechatSession)
            } else if (sidechatEvent.type === 'tool_end' && sidechatEvent.name) {
              appendAgentSidechatProgress(sidechatSession, t('mainDialog.groupProgressToolEnd'), sidechatEvent.name)
              emitAgentSidechatSession(input.onProgress, sidechatSession)
            } else if (sidechatEvent.type === 'progress' && sidechatEvent.stage) {
              appendAgentSidechatProgress(sidechatSession, sidechatEvent.stage, sidechatEvent.detail)
              emitAgentSidechatSession(input.onProgress, sidechatSession)
            } else if (sidechatEvent.type === 'done') {
              noteText = getMessageText(sidechatEvent.message.content)
              noteDisplayText = serializeMessageContentForDisplay(sidechatEvent.message.content) || noteText
              sidechatSession.response = noteDisplayText
              sidechatSession.status = 'completed'
              sidechatSession.updatedAt = new Date().toISOString()
              appendAgentSidechatProgress(sidechatSession, t('mainDialog.groupProgressSidechatDone'), t('mainDialog.groupProgressRoundDetail', { round }))
              emitAgentSidechatSession(input.onProgress, sidechatSession)
            } else if (sidechatEvent.type === 'error') {
              throw new Error(sidechatEvent.error)
            }
          }

          return {
            memberId,
            member,
            noteText,
            noteDisplayText,
            error: ''
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          sidechatSession.status = 'failed'
          sidechatSession.error = truncateSectionText(errorMessage, 200)
          sidechatSession.updatedAt = new Date().toISOString()
          appendAgentSidechatProgress(sidechatSession, t('mainDialog.groupProgressFailed'), sidechatSession.error)
          emitAgentSidechatSession(input.onProgress, sidechatSession)
          item.status = 'failed'
          item.stage = t('mainDialog.groupProgressFailed')
          item.detail = truncateSectionText(errorMessage, 200)
          item.updatedAt = new Date().toISOString()
          appendGroupProgressStep(item, t('mainDialog.groupProgressFailed'), item.detail)
          emitGroupProgressSnapshot(input.onProgress, snapshot)
          return { memberId, member, error: errorMessage, noteText: '', noteDisplayText: '' }
        }
      }))

      for (const result of results) {
        const item = getGroupProgressItem(snapshot, result.memberId)
        if (!item) continue
        if (item.status === 'failed') {
          if (result.error) {
            notes.push(`### Round ${round} · ${result.member?.name || item.agentName}\n${t('mainDialog.groupProgressFailureNote', { message: truncateSectionText(result.error, 300) })}`)
            plannerNotes.push({
              memberId: result.memberId,
              review: [
              `### Latest review · ${result.member?.name || item.agentName} (${result.memberId})`,
              `Round: ${round}/${totalRounds}`,
              `Assigned brief: ${roundPlan.request}`,
              roundPlan.focus ? `Assigned focus: ${roundPlan.focus}` : '',
              `User request alignment target: ${discussionRequest}`,
              `Result: failed`,
              `Failure detail: ${truncateSectionText(result.error, 300)}`
            ].filter(Boolean).join('\n')
            })
          }
          continue
        }

        item.currentRound = round
        item.completedRounds = Math.max(item.completedRounds, round)
        item.updatedAt = new Date().toISOString()

        if (result.noteText) {
          entries.push({
            id: `${input.group.id}_${round}_${result.memberId}_${entries.length}`,
            round,
            agentId: result.memberId,
            agentName: result.member?.name || item.agentName,
            content: result.noteDisplayText || result.noteText
          })
          notes.push(`### Round ${round} · ${result.member?.name || item.agentName}\n${result.noteText}`)
          plannerNotes.push({
            memberId: result.memberId,
            review: [
            `### Latest review · ${result.member?.name || item.agentName} (${result.memberId})`,
            `Round: ${round}/${totalRounds}`,
            `Assigned brief: ${roundPlan.request}`,
            roundPlan.focus ? `Assigned focus: ${roundPlan.focus}` : '',
            `User request alignment target: ${discussionRequest}`,
            'Returned note excerpt:',
            truncateSectionText(result.noteText, 1200)
          ].filter(Boolean).join('\n')
          })
          item.summary = summarizeGroupNote(result.noteText)
        } else {
          plannerNotes.push({
            memberId: result.memberId,
            review: [
            `### Latest review · ${result.member?.name || item.agentName} (${result.memberId})`,
            `Round: ${round}/${totalRounds}`,
            `Assigned brief: ${roundPlan.request}`,
            roundPlan.focus ? `Assigned focus: ${roundPlan.focus}` : '',
            `User request alignment target: ${discussionRequest}`,
            'Returned note: (empty)'
          ].filter(Boolean).join('\n')
          })
          item.summary = undefined
        }

        const finishedDetail = result.noteText
          ? t('mainDialog.groupProgressRoundCompleted', { round })
          : t('mainDialog.groupProgressRoundNoNote', { round })
        item.status = round >= totalRounds ? 'completed' : 'queued'
        item.stage = round >= totalRounds ? t('mainDialog.groupProgressCompleted') : t('mainDialog.groupProgressWaitingNextRound')
        item.detail = round >= totalRounds ? t('mainDialog.groupProgressAllRoundsDone') : finishedDetail
        appendGroupProgressStep(item, result.noteText ? t('mainDialog.groupProgressRoundDone') : t('mainDialog.groupProgressNoNote'), finishedDetail)
        emitGroupProgressSnapshot(input.onProgress, snapshot)
      }
    }
  }

  for (const item of snapshot.items) {
    if (item.status === 'queued') {
      item.status = 'completed'
      item.stage = t('mainDialog.groupProgressCompleted')
      item.detail = item.completedRounds > 0 ? t('mainDialog.groupProgressDiscussionEnded') : t('mainDialog.groupProgressNotScheduled')
      item.updatedAt = new Date().toISOString()
    }
  }

  emitGroupProgressSnapshot(input.onProgress, snapshot)
  emitGroupCollaborationPlan(input.onProgress, createGroupCollaborationPlan({
    group: input.group,
    routing,
    plannerName,
    reportToName,
    originalRequest,
    phase: 'completed',
    candidateMemberIds: memberIds,
    invitedMemberIds: latestInvitedMemberIds,
    round: snapshot.activeRound || undefined,
    shouldContinue: false
  }))

  if (notes.length === 0) {
    return { promptSection: null, transcript: null }
  }

  return {
    promptSection: [
      isDiscussionMode
        ? '## Agent group internal deliberation'
        : '## Targeted agent sidechat results',
      isDiscussionMode
        ? '- These are internal working notes synthesized from the selected group members.'
        : '- These are targeted sidechat results from the explicitly mentioned group members.',
      '- Use them to improve the final answer, but do not expose the full transcript unless the user asks for it.',
      '',
      truncateSectionText(notes.join('\n\n'), input.group.visibility === 'summary_only' ? 4000 : 8000)
    ].join('\n'),
    transcript: entries.length > 0
        ? {
          groupId: input.group.id,
          groupName: input.group.name,
          request: discussionRequest,
          visibility: input.group.visibility,
          roundCount: Math.max(...entries.map(entry => entry.round), 0),
          entryCount: entries.length,
          summary: buildGroupTranscriptSummary(input.group, entries, routing.mode),
          entries: input.group.visibility === 'expandable_internal_transcript'
            ? entries
            : []
        }
      : null
  }
}
