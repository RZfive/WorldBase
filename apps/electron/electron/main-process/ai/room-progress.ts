import type {
  AgentGroupDefinition,
  AgentGroupMessage,
  AgentGroupProgressItem,
  AgentGroupProgressSnapshot,
  AgentGroupUserInjection,
  RoomMemberMessage,
  RoomMemberStatus
} from '../../../src/shared/agent-workspace-types.js'
import { toolRunEventFromFrame } from '../../../src/main/ai-harness/tool-run-summary.js'
import type { StreamEvent } from '../../../src/main/ai-harness/types.js'
import { t } from '../../../src/main/i18n/main-i18n.js'
import type { RustEventFrame } from '../rust-harness-client.js'

type RoomTraceEvent = Extract<StreamEvent, { type: 'thinking' | 'tool_start' | 'tool_end' | 'progress' | 'reset' }>

export type RoomProgressEvent =
  | RoomTraceEvent
  | { type: 'room_message'; roomMessage: RoomMemberMessage }
  | { type: 'room_member_status'; roomMemberStatus: RoomMemberStatus }
  | { type: 'group_session_state'; groupId: string; active: boolean }
  | { type: 'group_progress'; groupProgress: AgentGroupProgressSnapshot }
  | { type: 'group_user_injection'; injection: AgentGroupUserInjection }
  | { type: 'group_peer_message'; peerMessage: AgentGroupMessage }

export function roomTraceFromFrame (frame: RustEventFrame): RoomTraceEvent | null {
  switch (frame.kind) {
    case 'thinking_delta':
      return typeof frame.text === 'string' && frame.text ? { type: 'thinking', content: frame.text } : null
    case 'tool_call':
    case 'tool_result':
      return toolRunEventFromFrame(frame)
    case 'progress':
      return typeof frame.stage === 'string' && frame.stage !== '__electron_progress__'
        ? { type: 'progress', stage: frame.stage, detail: typeof frame.detail === 'string' ? frame.detail : undefined }
        : null
    case 'reset':
      return { type: 'reset' }
    default:
      return null
  }
}

export function createRoomProgressItem (
  groupId: string,
  agent: { id: string; name: string },
  totalRounds: number
): AgentGroupProgressItem {
  return {
    id: `${groupId}_${agent.id}`,
    agentId: agent.id,
    agentName: agent.name,
    status: 'queued',
    currentRound: 0,
    completedRounds: 0,
    totalRounds,
    stage: t('mainDialog.groupProgressWaitingStart'),
    updatedAt: new Date().toISOString(),
    progress: []
  }
}

export function updateRoomProgressItem (
  item: AgentGroupProgressItem,
  status: AgentGroupProgressItem['status'],
  stage: string,
  detail?: string
): void {
  item.status = status
  item.stage = stage
  item.detail = detail
  item.updatedAt = new Date().toISOString()
  item.progress = [...item.progress, { at: item.updatedAt, stage, detail }].slice(-4)
}

export function roomProgressSnapshot (
  group: AgentGroupDefinition,
  items: AgentGroupProgressItem[],
  request: string,
  activeRound: number,
  totalRounds: number
): AgentGroupProgressSnapshot {
  const queuedCount = items.filter(item => item.status === 'queued').length
  const runningCount = items.filter(item => item.status === 'running').length
  const completedCount = items.filter(item => item.status === 'completed').length
  const failedCount = items.filter(item => item.status === 'failed').length
  return {
    groupId: group.id,
    groupName: group.name,
    request,
    status: runningCount || queuedCount ? 'running' : completedCount ? 'completed' : 'failed',
    activeRound,
    totalRounds,
    maxParallelWorkers: group.maxParallelWorkers,
    queuedCount,
    runningCount,
    completedCount,
    failedCount,
    items: items.map(item => ({ ...item, progress: [...item.progress] }))
  }
}
