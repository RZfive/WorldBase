import type { AgentDefinition } from '../../shared/agent-workspace-types.js'
import type { AgentStore } from '../settings/agent-store.js'
import { roomLocalWorkerName, type LocalAgentProfile, type RoomLocalWorker } from '../../shared/local-agent-types.js'

export const LOCAL_AGENT_RUNTIME_KEY = 'local-cli'

export function localAgentDefinition (profile: LocalAgentProfile): AgentDefinition {
  const timestamp = new Date().toISOString()
  return {
    id: profile.agentId,
    name: profile.name,
    icon: '⌘',
    description: profile.description,
    providerId: LOCAL_AGENT_RUNTIME_KEY,
    modelId: profile.kind,
    systemPrompt: [
      `You are ${profile.name}, a local CLI coding agent in a shared WorldBase room.`,
      'Complete concrete work rather than only discussing it. Publish concise progress and evidence.',
      'Use handoff_room_task for another member, or discover_local_agents and invite_local_agent for an installed platform.',
      'Ask collaborators to return results for review. Report remaining gaps and never claim work completed without evidence.'
    ].join('\n'),
    skillIds: [],
    allowedTools: [],
    deniedTools: [],
    memoryScopes: ['group', 'project'],
    memoryWritePolicy: {
      allowUserTraits: false,
      allowAgentSkills: false,
      allowSteps: true,
      allowKnowledge: true
    },
    autoReplyPolicy: { enabled: false, requireMention: true },
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

export function isLocalCliAgent (agent?: AgentDefinition | null): boolean {
  return agent?.providerId === LOCAL_AGENT_RUNTIME_KEY
}

export function roomLocalWorkerAgent (worker: RoomLocalWorker): AgentDefinition {
  return {
    id: worker.id,
    name: roomLocalWorkerName(worker),
    description: worker.role,
    systemPrompt: worker.instructions || '',
    icon: '⌘',
    providerId: LOCAL_AGENT_RUNTIME_KEY,
    modelId: worker.kind,
    skillIds: [],
    memoryScopes: [],
    memoryWritePolicy: { allowUserTraits: false, allowAgentSkills: false, allowSteps: false, allowKnowledge: false },
    createdAt: '',
    updatedAt: ''
  }
}

/** Materialize only user-selected/discovered local agents; no auto-join. */
export function localAgentCatalogEntry (profile: LocalAgentProfile, store: AgentStore): AgentDefinition {
  const existing = store.get(profile.agentId)
  return existing
    ? { ...existing, providerId: LOCAL_AGENT_RUNTIME_KEY, modelId: profile.kind }
    : localAgentDefinition(profile)
}
