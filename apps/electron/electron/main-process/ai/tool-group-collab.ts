import type { ToolDefinition } from '../../../src/main/ai-engine/providers/openai-provider/types.js'
import type { CustomToolRegistration, ProgressCallback } from '../../../src/main/ai-engine/ai-engine.js'
import type { SharedBoardUpdate } from '../../../src/shared/agent-workspace-types.js'
import type { GroupSession } from './group-session.js'

/**
 * The three group-collaboration tools, bound to one (session, calling-agent)
 * pair. Injected per chatStream call via `AIRequestOptions.customTools` so each
 * member gets tools addressed to its own identity and the shared session.
 *
 *   message_agent   - R1 P2P consult another group member (sync, bounded)
 *   read_board      - R2 read the shared board snapshot
 *   update_board    - R2 mutate one board field (field-level merge + audit)
 *   reply_to_user   - R6 post a direct user-visible reply
 */
export function buildGroupCollabTools (
  session: GroupSession,
  agentId: string,
  agentName: string,
  abortSignal?: AbortSignal,
  resolveAgentName?: (agentId: string) => string | undefined
): CustomToolRegistration[] {
  const messageAgent: CustomToolRegistration = {
    domain: 'electron_host_override',
    definition: {
      name: 'message_agent',
      description: [
        'Send a direct message to another agent in the current group and wait for their reply.',
        'Use this to consult a member whose expertise you need mid-task, instead of guessing or waiting for the next round.',
        'The target agent runs with its own context and tools and returns a text reply.',
        'Recursion is bounded: an agent handling your request may consult one more layer deep, but no further.',
        'Avoid calling this in a cycle (A->B->A) - it will be rejected as a deadlock; reply with what you have instead.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          target_agent_id: {
            type: 'string',
            description: 'The id of the group member to consult. Must be a participant in the current group.'
          },
          message: {
            type: 'string',
            description: 'The question or request for the target agent. Be specific and self-contained.'
          }
        },
        required: ['target_agent_id', 'message'],
        additionalProperties: false
      }
    },
    handler: async (args) => {
      const targetAgentId = typeof args.target_agent_id === 'string' ? args.target_agent_id.trim() : ''
      const message = typeof args.message === 'string' ? args.message : ''
      if (!targetAgentId) return { error: 'target_agent_id is required.' }
      if (!message.trim()) return { error: 'message is required.' }

      // Resolve the target's display name via the caller-supplied resolver (the
      // session only stores ids); fall back to the id when unavailable.
      try {
        const response = await session.sendMessage({
          fromAgentId: agentId,
          fromAgentName: agentName,
          toAgentId: targetAgentId,
          toAgentName: resolveAgentName?.(targetAgentId) ?? targetAgentId,
          request: message,
          abortSignal
        })
        return { status: 'completed', reply: response }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        return { status: 'failed', error: errorMessage }
      }
    }
  }

  const readBoard: CustomToolRegistration = {
    domain: 'electron_host_override',
    definition: {
      name: 'read_board',
      description: 'Read the current state of the shared group board (goal, assumptions, tasks, decisions, evidence, open questions). Read this before posting updates so you do not duplicate work or contradict a decision another member already recorded.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    handler: async () => {
      return { board: session.readBoard() }
    }
  }

  const updateBoard: CustomToolRegistration = {
    domain: 'electron_host_override',
    definition: {
      name: 'update_board',
      description: [
        'Mutate one field of the shared group board. Apply changes incrementally so concurrent writers do not clobber each other.',
        'Fields: goal (string), assumptions/decisions/evidenceRefs/openQuestions (string lists), tasks (task objects).',
        'Ops: set (replace), add (append, idempotent), update (merge by id, tasks only), remove (by value or task id/title).',
        'Always include a short reason so the audit log records why.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: ['goal', 'assumptions', 'tasks', 'decisions', 'evidenceRefs', 'openQuestions'] },
          op: { type: 'string', enum: ['set', 'add', 'update', 'remove'] },
          payload: {
            description: 'Value depends on field+op: a string for goal-set / list-add / list-remove; a string[] for list-set; a task object {id,title,ownerAgentId?,status,summary?} for tasks-add/update; a task id/title string for tasks-remove.'
          },
          reason: { type: 'string', description: 'Short justification, recorded in the audit log.' }
        },
        required: ['field', 'op', 'payload'],
        additionalProperties: false
      }
    },
    handler: async (args) => {
      const field = args.field as SharedBoardUpdate['field'] | undefined
      const op = args.op as SharedBoardUpdate['op'] | undefined
      if (!field || !op) return { error: 'field and op are required.' }
      try {
        const update = session.updateBoard({
          agentId,
          agentName,
          field,
          op,
          payload: args.payload,
          reason: typeof args.reason === 'string' ? args.reason : undefined
        })
        return { status: 'applied', update }
      } catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
      }
    }
  }

  const replyToUser: CustomToolRegistration = {
    domain: 'electron_host_override',
    definition: {
      name: 'reply_to_user',
      description: [
        'Post a reply that the user sees directly in the main conversation stream, bypassing the coordinator relay.',
        'Use only when you were explicitly @mentioned and the user clearly wants your direct answer, or when the coordinator assigned you to answer directly.',
        'Do not use this for internal notes - use update_board or your normal working output for those.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The user-visible reply. Be concise and direct.' }
        },
        required: ['content'],
        additionalProperties: false
      }
    },
    handler: async (args) => {
      const content = typeof args.content === 'string' ? args.content.trim() : ''
      if (!content) return { error: 'content is required.' }
      const reply = session.postDirectReply({ agentId, agentName, content, endorsed: false })
      return { status: 'posted', reply }
    }
  }

  return [messageAgent, readBoard, updateBoard, replyToUser]
}

/** Type helper so the tool file's Tool interface matches the registry's. */
export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}
