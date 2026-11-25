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
          task: { type: 'string', description: 'Task, relevant handoff context and expected evidence.' }
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
      description: 'Proactively mention another room member and queue the next piece of work, review, verification, or decision. Use this instead of asking the user to relay a request or @ the member. The recipient replies as themselves in the room.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Stable room member ID or @ followed by the exact member name. Do not use @all.' },
          task: { type: 'string', description: 'Task, current status, evidence and next action.' }
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
