import { mainState } from '../../../electron/main-process/state.js'
import type { AgentDefinition, AgentGroupDefinition } from '../../shared/agent-workspace-types.js'
import { localAgentCatalogEntry, LOCAL_AGENT_RUNTIME_KEY } from './catalog.js'
import { localAgentKindFromId } from './registry.js'
import { assertFolderWorkspaceRoot } from '../folder-workspace/folder-workspace-fs.js'
import { realpath } from 'node:fs/promises'
import type { RoomLocalWorkerOptions } from '../../shared/local-agent-types.js'
import { localRoomSessionKey } from '../../shared/room-context.js'
import { t } from '../i18n/main-i18n.js'

export async function discoverLocalAgents () {
  return await mainState.localAgentRegistry?.discover() || []
}

export async function discoverLocalAgentSessions (agentId: string, workspaceRoot: string) {
  if (!localAgentKindFromId(agentId)) throw new Error('Invalid local CLI agent ID.')
  const registry = mainState.localAgentRegistry
  if (!registry) return []
  const root = await assertFolderWorkspaceRoot(workspaceRoot)
  return await registry.discoverSessions(agentId, root)
}

export async function inviteRoomLocalWorker (
  agentId: string,
  groupId: string,
  options: RoomLocalWorkerOptions,
  nativeGroupId?: string,
  signal?: AbortSignal
) {
  const kind = typeof agentId === 'string' ? localAgentKindFromId(agentId) : null
  if (!kind) throw new Error('Invalid local CLI agent ID.')
  if (!options || typeof options.role !== 'string' || typeof options.exitAfterTask !== 'boolean' ||
      (options.instructions != null && typeof options.instructions !== 'string')) {
    throw new Error(t('mainDialog.roomWorkerInvalidRole'))
  }
  const role = options.role.trim().replace(/\s+/gu, ' ')
  const instructions = options.instructions?.trim() || ''
  if (!role || /[@＠\u0000-\u001f]/u.test(role) || role.length > 48 || instructions.length > 2000) {
    throw new Error(t('mainDialog.roomWorkerInvalidRole'))
  }
  const { localAgentRegistry: registry, rustHarness: client } = mainState
  if (!registry || !client) throw new Error('Local Agent Registry is unavailable.')
  if (!(await registry.get(agentId))?.available) throw new Error(`Local agent is unavailable: ${agentId}`)
  signal?.throwIfAborted()
  const result = await client.addRoomLocalWorker(groupId, kind, { role, instructions, exitAfterTask: options.exitAfterTask }, nativeGroupId)
  mainState.agentGroupStore?.save(result.group)
  return result
}

export async function removeRoomLocalWorker (groupId: string, workerId: string) {
  const { localAgentRegistry: registry, rustHarness: client } = mainState
  if (!client) throw new Error('Local Agent Registry is unavailable.')
  const result = await client.removeRoomLocalWorker(groupId, workerId)
  mainState.agentGroupStore?.save(result.group)
  if (result.removed) {
    try {
      registry?.releaseWorkerSessions(localRoomSessionKey(result.group), workerId)
    } catch (error) {
      console.warn('[local-agents] Worker left the room, but its session binding could not be released:', error)
    }
  }
  return result
}

export async function addLocalAgentToGroup (agentId: string, groupId: string, resume?: { sessionId: string; workspaceRoot: string }, nativeGroupId?: string, signal?: AbortSignal): Promise<{ agent: AgentDefinition; group: AgentGroupDefinition; added: boolean; joinedLive: boolean }> {
  if (!localAgentKindFromId(agentId)) throw new Error('Invalid local CLI agent ID.')
  const store = mainState.agentStore
  const registry = mainState.localAgentRegistry
  const client = mainState.rustHarness
  if (!store || !registry || !client) throw new Error('Local Agent Registry is unavailable.')
  const profile = (await registry.discover()).find(item => item.agentId === agentId && item.available)
  if (!profile) throw new Error(`Local agent is unavailable: ${agentId}`)
  const group = await client.getAgentGroup(groupId)
  if (!group) throw new Error('Group not found.')
  const sessionKey = localRoomSessionKey(group)
  let resumeRoot: string | undefined
  if (resume) {
    if (!profile.supportsSessionDiscovery) throw new Error('This platform does not expose supported session discovery.')
    if (!resume.sessionId.trim() || !resume.workspaceRoot.trim()) throw new Error('A session and workspace are required.')
    resumeRoot = await realpath(await assertFolderWorkspaceRoot(resume.workspaceRoot))
    const bound = registry.getSession(sessionKey, agentId, resumeRoot)
    const sessions = bound?.sessionId === resume.sessionId ? [] : await registry.discoverSessions(agentId, resumeRoot)
    if (bound?.sessionId !== resume.sessionId && !sessions.some(item => item.sessionId === resume.sessionId)) {
      throw new Error('The selected local session is not available for this platform and workspace.')
    }
  }
  signal?.throwIfAborted()
  const agent = await client.saveAgent(localAgentCatalogEntry(profile, store))
  signal?.throwIfAborted()
  store.save(agent)
  const joined = await client.addNativeGroupMember(groupId, agent.id, nativeGroupId)
  mainState.agentGroupStore?.save(joined.group)
  if (resume && resumeRoot) {
    if (localRoomSessionKey(joined.group) !== sessionKey) throw new Error(t('mainDialog.roomContextChanged'))
    registry.bindSession(sessionKey, agentId, resumeRoot, resume.sessionId)
  }
  return { agent, ...joined }
}

/** Preserve the local CLI runtime marker when ordinary Agent edits are saved. */
export function preserveLocalAgentRuntime (agent: Partial<AgentDefinition>): Partial<AgentDefinition> {
  const existing = agent.id ? mainState.agentStore?.get(agent.id) : null
  return existing?.providerId === LOCAL_AGENT_RUNTIME_KEY
    ? { ...agent, providerId: existing.providerId, modelId: existing.modelId }
    : agent
}
