import type { RustCustomToolDefinition, RustCustomToolRegistration } from '../../../electron/main-process/rust-harness-client.js'

const roomToolDefinitions: RustCustomToolDefinition[] = [
  {
    definition: {
      name: 'discover_local_agents',
      description: 'List supported coding CLI agents installed on this computer and available to invite to the current room.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    domain: 'host',
    permission: 'allow'
  },
  {
    definition: {
      name: 'invite_local_agent',
      description: 'Create an independent room Worker from an installed CLI and queue its specific task. The same CLI can run several Workers with separate roles and sessions.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Stable ID returned by discover_local_agents.' },
          role: { type: 'string', description: 'Short role such as UI reviewer or test author.', maxLength: 48 },
          instructions: { type: 'string', description: 'Optional role-specific boundaries.', maxLength: 2000 },
          exitAfterTask: { type: 'boolean', description: 'Leave the room after reporting a successful result. Defaults to true for a delegated Worker.' },
          task: { type: 'string', description: 'Concrete task, relevant handoff context and expected evidence. Do not include identity, role-play or greeting instructions.' }
        },
        required: ['agentId', 'task'],
        additionalProperties: false
      }
    },
    domain: 'host',
    permission: 'allow'
  },
  {
    definition: {
      name: 'handoff_room_task',
      description: 'Proactively @mention another room member and assign a specific piece of work, review, verification, or decision. Use this instead of asking the user to relay a request or @ the member. Treat the user message as the overall goal: complete your own contribution and split the recipient’s specific part; never forward or lightly paraphrase the user’s original request. The recipient already receives its own name, role, persona, and style from the runtime: the task must contain only the concrete assignment and useful context/evidence, never role-play, identity, greeting, tone, formatting, or self-introduction instructions. The task is shown as your direct @member message. Queue all needed handoffs, then end the current turn immediately because recipients start only after this turn. The runtime later returns the recipient’s result as a visible @reply event and reawakens you in a new round; do not wait or poll for replies.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Stable room member ID or @ followed by the exact member name. Do not use @all.' },
          task: { type: 'string', description: 'The recipient’s specific responsibility, relevant context/evidence and real deliverable. Do not copy the user request verbatim; do not restate the recipient role or ask for a greeting/self-introduction.' }
        },
        required: ['agentId', 'task'],
        additionalProperties: false
      }
    },
    domain: 'host',
    permission: 'allow'
  }
]

type ToolHandler = RustCustomToolRegistration['handler']

export function getRoomToolDefinitions (allowInvites: boolean): RustCustomToolDefinition[] {
  return allowInvites ? roomToolDefinitions : roomToolDefinitions.filter(tool => tool.definition.name === 'handoff_room_task')
}

export function bindRoomTools (handlers: Record<string, ToolHandler>, allowInvites: boolean): RustCustomToolRegistration[] {
  return getRoomToolDefinitions(allowInvites).map(tool => ({ ...tool, handler: handlers[tool.definition.name] }))
}

export function requiredRoomText (args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim() || value.length > 12_000) {
    throw new Error(`${key} must contain 1–12000 characters.`)
  }
  return value.trim()
}
