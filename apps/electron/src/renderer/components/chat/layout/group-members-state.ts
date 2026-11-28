import type { RoomLocalWorker } from '../../../../shared/local-agent-types'
import type { OnlineGroup } from '../../../../shared/online-group-types.js'
import type { AgentDefinition, AgentGroupDefinition } from '../panel/types'

/**
 * The member panel's resting width, and how long it takes to fold. Both are
 * its CSS; the panel reads them while it holds its content at that width for
 * the duration of the fold.
 */
export const GROUP_MEMBERS_WIDTH = 292
export const GROUP_MEMBERS_FOLD_MS = 220

/**
 * The headcount a group's member list reports: every human plus every Agent
 * they brought along (an online group knows its roster; a local one is the
 * local human, the group's known Agents and its CLI workers).
 *
 * The member panel heading and the title row's fold toggle both read it, so
 * the two can never disagree about how many members a group has.
 */
export function countGroupMembers (
  group: AgentGroupDefinition,
  agents: AgentDefinition[],
  localWorkers: RoomLocalWorker[] | undefined,
  onlineGroup: OnlineGroup | null | undefined
): number {
  if (onlineGroup) return onlineGroup.members.length
  const agentIds = new Set([group.coordinatorAgentId, ...group.memberAgentIds].filter(Boolean))
  const knownAgents = [...agentIds].filter(id => agents.some(agent => agent.id === id)).length
  return knownAgents + (localWorkers?.length || 0) + 1
}
