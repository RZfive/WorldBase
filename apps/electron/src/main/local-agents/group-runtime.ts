import type { AgentDefinition, AgentGroupDefinition } from '../../shared/agent-workspace-types.js'
import type { RoomLocalWorkspace } from '../../shared/local-agent-types.js'
import {
  isVerbatimRoomForward,
  normalizeMentionToken,
  stripRedundantHandoffInstructions
} from '../../shared/group-mentions.js'
import { localRoomSessionKey } from '../../shared/room-context.js'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { RustCustomToolRegistration } from '../../../electron/main-process/rust-harness-client.js'
import { isLocalCliAgent, roomLocalWorkerAgent } from './catalog.js'
import { bindRoomTools, requiredRoomText } from './group-tools.js'
import type { LocalAgentRegistry } from './registry.js'
import { prepareRoomLocalWorkspace } from './room-workspace.js'
import { runLocalAgent, type LocalAgentRunResult } from './runtime.js'
import { inviteRoomLocalWorker } from './service.js'

export interface LocalGroupRuntimeOptions {
  group: AgentGroupDefinition
  workspace?: RoomLocalWorkspace
  nativeGroupId: string
  agent: AgentDefinition
  userRequest: string
  registry?: LocalAgentRegistry | null
  authorizeWorkspace: () => Promise<void>
  allowInvites: boolean
  signal: AbortSignal
  onThinking: (content: string) => void
  getMembers: () => AgentDefinition[]
  readMessages: () => Promise<unknown[]>
  onJoined: (group: AgentGroupDefinition) => void
  onHandoff: (from: AgentDefinition, to: AgentDefinition, task: string) => Promise<boolean>
  onInvite: (from: AgentDefinition, platformId: string, role: string, task: string, invite: () => Promise<AgentDefinition>) => Promise<AgentDefinition | null>
}

function parseRoomReply (result: LocalAgentRunResult): { text: string; handoffs: unknown[] } {
  const raw = result.text.trim().replace(/^```(?:json)?\s+([\s\S]*?)\s*```$/i, '$1')
  try {
    const reply = JSON.parse(raw)
    if (typeof reply?.message === 'string' && reply.message.trim() && Array.isArray(reply.handoffs)) {
      return { text: reply.message.trim(), handoffs: reply.handoffs.slice(0, 4) }
    }
  } catch {
    return { text: result.text, handoffs: [] }
  }
  return { text: result.text, handoffs: [] }
}

export function localGroupRuntimeTools (options: LocalGroupRuntimeOptions): RustCustomToolRegistration[] {
  const { group, workspace, nativeGroupId, agent, userRequest, registry, authorizeWorkspace, allowInvites, signal, getMembers, readMessages, onJoined, onHandoff, onInvite } = options
  const discover = async () => (await registry?.discover() || [])
    .filter(profile => profile.available)
    .map(({ agentId, kind, name, version }) => ({ agentId, kind, name, version }))
  const assign = async (args: Record<string, unknown>, allowInvite: boolean) => {
    signal.throwIfAborted()
    const recipient = requiredRoomText(args, 'agentId').replace(/^[@＠]+/u, '').trim()
    const rawTask = requiredRoomText(args, 'task')
    const task = stripRedundantHandoffInstructions(rawTask) || rawTask
    if (isVerbatimRoomForward(task, userRequest)) {
      throw new Error('Handoff must assign a specific subtask. Do not forward the user request.')
    }
    const members = getMembers()
    let member = members.find(candidate => candidate.id === recipient)
    if (!member) {
      const token = normalizeMentionToken(recipient)
      const matches = token ? members.filter(candidate => normalizeMentionToken(candidate.name) === token) : []
      if (matches.length > 1) throw new Error('This mention matches multiple room members. Use the stable member ID.')
      member = matches[0]
    }
    if (allowInvite && (args.role !== undefined || !member)) {
      if (!workspace) throw new Error('No working directory was resolved for this room.')
      const profile = (await discover()).find(candidate => candidate.agentId === recipient)
      if (!profile) throw new Error('Use a platform ID from discover_local_agents to invite a Worker.')
      const role = args.role === undefined ? profile.name : requiredRoomText(args, 'role')
      const queued = await onInvite(agent, recipient, role, task, async () => {
        const joined = await inviteRoomLocalWorker(recipient, group.id, {
          role,
          instructions: args.instructions as string | undefined,
          exitAfterTask: (args.exitAfterTask ?? true) as boolean
        }, nativeGroupId, signal)
        onJoined(joined.group)
        return roomLocalWorkerAgent(joined.worker)
      })
      return queued
        ? {
            status: 'queued',
            member: { id: queued.id, name: queued.name },
            endTurn: true,
            next: 'The recipient starts only after this turn ends. End the turn now; do not wait or poll for a reply.'
          }
        : {
            status: 'already_queued',
            endTurn: true,
            next: 'This handoff is already queued. End the turn now; do not wait or poll for a reply.'
          }
    }
    if (!member) throw new Error('The handoff recipient must be a room member.')
    if (member.id === agent.id) throw new Error('Choose another member for the handoff.')
    signal.throwIfAborted()
    const queued = await onHandoff(agent, member, task)
    return {
      status: queued ? 'queued' : 'already_queued',
      member: { id: member.id, name: member.name },
      endTurn: true,
      next: 'The recipient starts only after this turn ends. End the turn now; do not wait or poll for a reply.'
    }
  }

  const tools = bindRoomTools({
    discover_local_agents: async () => ({ agents: await discover() }),
    invite_local_agent: async args => await assign(args, true),
    handoff_room_task: async args => await assign(args, false)
  }, allowInvites)
  if (!isLocalCliAgent(agent)) return tools

  return [...tools, {
    definition: { name: 'run_local_cli', description: 'Run the selected local Agent.', parameters: { type: 'object' } },
    domain: 'host',
    handler: async (args, onProgress) => {
      if (!registry) throw new Error('Local Agent Registry is unavailable.')
      if (!workspace) throw new Error('No working directory was resolved for this room.')
      const task = typeof args.task === 'string' ? args.task : ''
      if (!task.trim()) throw new Error('The local Agent assignment is empty.')
      await authorizeWorkspace()
      signal.throwIfAborted()
      const catalog = allowInvites ? await discover() : []
      signal.throwIfAborted()
      const workspaceRoot = await prepareRoomLocalWorkspace(workspace)
      signal.throwIfAborted()
      const contextDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'worldbase-room-')))
      try {
        const historyPath = path.join(contextDirectory, 'messages.json')
        await writeFile(historyPath, JSON.stringify(await readMessages()), { mode: 0o400 })
        const prompt = [
          task,
          `## Your room role\nName: ${agent.name}\nRole: ${agent.description}\n${agent.systemPrompt}`,
          '## WorldBase room collaboration',
          `The shared room message archive is readable at ${historyPath}. Read this file to recover earlier user instructions, progress, results and handoffs.`,
          `Room members:\n${getMembers().map(member => (
            `- @${member.name} (${member.id}): ${member.description?.trim() || 'No additional role description'}`
          )).join('\n')}`,
          ...(catalog.length ? [
            `Installed CLI platforms: ${catalog.map(item => `${item.name} (${item.agentId})`).join(', ')}`,
            'To create a Worker for a distinct assignment, use a platform ID in the handoff and include a short "role". Multiple Workers can use one platform. The Worker leaves after its result unless you include "exitAfterTask": false.'
          ] : []),
          'Work as an autonomous teammate, not an assistant waiting for the user to dispatch others.',
          'Treat the user message as the overall goal, not as a handoff payload. Decide and do your own contribution first, then split concrete subtasks for collaborators.',
          'Never forward or lightly paraphrase the user’s original request as a handoff. Tell the recipient exactly which part they own, what inputs/constraints matter, and what real deliverable or evidence you need back.',
          'When the next step needs another member’s execution, specialist input, discussion, review, verification, or decision, queue the handoff yourself. Do not ask the user to @ someone, relay the request, or decide who should continue.',
          'Every member already receives its own name, role description and persona in its runtime prompt. A handoff must contain only the concrete task and useful context/evidence. Do not write identity, role-play, greeting, tone, formatting, or “act as/introduce yourself” instructions, and do not add acceptance criteria that only test roleplay or a greeting.',
          'For multi-step or cross-domain work, split it into concrete parts and hand off independent parts immediately. Do not wait for the user to name every participant.',
          'Queue every needed handoff in the current turn, then finish this turn immediately. The room runs recipients only after your turn ends.',
          'The runtime returns each recipient’s result to you as a visible @reply in a later round. Do not read the room, wait, or poll for that event; end the current turn after queueing the handoff.',
          'Do not wait, poll, or keep reading room messages for a recipient’s reply in the same turn. Never impersonate or invent their answer.',
          'Before asking the user, check whether a safe, reversible default exists. If it does, state the assumption and continue. Only stop for a question whose answer truly blocks the next action, and then ask once with all blocking decisions together.',
          'Answer as plain text only when your part is complete and no follow-up is needed, or when you are genuinely blocked on user input, authorization, or a user-owned decision.',
          'If one message assigns different tasks to several members, perform only the task addressed to your displayed name or role.',
          'When the current request needs another member to do specific follow-up work, return only a JSON object with this shape:',
          '{"message":"your visible result", "handoffs":[{"agentId":"stable ID or @exact member name","task":"specific next task with evidence and acceptance criteria"}]}',
          'The handoff is shown as your direct @member message with the full task. Add only a brief result or next-step note if needed; do not repeat the task or emit a separate handoff report. Do not request a handoff for an ordinary chat reply or unrelated task.'
        ].join('\n\n')
        const result = await runLocalAgent({
          groupId: localRoomSessionKey(group),
          agentId: agent.id,
          prompt,
          workspaceRoot,
          contextDirectory,
          allowWorkspaceWrites: true,
          abortSignal: signal,
          onEvent: event => {
            if (event.kind === 'thinking') options.onThinking(`${event.detail}\n\n`)
            else onProgress?.(agent.name, event.detail)
          }
        }, registry)
        const reply = parseRoomReply(result)
        const failures: string[] = []
        for (const handoff of reply.handoffs) {
          if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) continue
          try {
            await assign(handoff as Record<string, unknown>, allowInvites)
          } catch (error) {
            signal.throwIfAborted()
            failures.push(error instanceof Error ? error.message : String(error))
          }
        }
        return { ...result, text: [reply.text, ...failures.map(error => `Handoff failed: ${error}`)].join('\n\n') }
      } finally {
        await rm(contextDirectory, { recursive: true, force: true })
      }
    }
  }]
}
