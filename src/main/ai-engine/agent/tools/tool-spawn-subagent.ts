import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import type { SubagentService } from '../subagent-service.js'

interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

interface SubagentTaskInput {
  description: string
  prompt: string
  allowed_tools?: string[]
  denied_tools?: string[]
  system_prompt?: string
}

function normalizeTaskList (raw: unknown): SubagentTaskInput[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is SubagentTaskInput => {
    return (
      item !== null &&
      typeof item === 'object' &&
      typeof (item as SubagentTaskInput).description === 'string' &&
      typeof (item as SubagentTaskInput).prompt === 'string'
    )
  })
}

function normalizeStringArray (value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
  return items.length > 0 ? items : undefined
}

/**
 * tool-spawn-subagent — Parallel subagent dispatcher.
 *
 * Allows the AI agent to create one or more independent subagents that run
 * concurrently. All subagents execute in parallel and the tool returns only
 * after every subagent has finished (or failed). This mirrors the Claude Code
 * AgentTool pattern for task decomposition and parallel acceleration.
 *
 * Each subagent:
 * - Gets its own isolated AgentCore with an independent conversation
 * - Has access to the full tool set (unless restricted via allowed/denied lists)
 * - Forwards its progress to the parent via the onProgress callback
 * - Returns a text result that the parent collects and reasons over
 */
export function toolSpawnSubagents (
  getSubagentService: () => SubagentService | undefined,
  getAbortSignal: () => AbortSignal | undefined
): Tool {
  return {
    definition: {
      name: 'spawn_subagents',
      description: [
        'Spawn one or more independent subagents that execute their tasks in parallel.',
        'All subagents run concurrently; the tool blocks until every subagent has completed or failed.',
        'Use this tool to decompose a large task into independent subtasks and accelerate execution through parallelism.',
        'Each subagent has access to all standard tools and runs with its own isolated conversation context.',
        'Subagents cannot spawn their own subagents — nesting is not supported.',
        'Prefer this tool when subtasks are independent and can proceed without each other\'s intermediate results.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'List of tasks to execute in parallel. Each task runs as an independent subagent.',
            items: {
              type: 'object',
              properties: {
                description: {
                  type: 'string',
                  description: 'Short label (3-5 words) identifying what this subagent does. Used in progress display.'
                },
                prompt: {
                  type: 'string',
                  description: 'Full detailed instruction for the subagent to execute. Be specific and self-contained — the subagent has no access to the parent conversation history.'
                },
                allowed_tools: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional: restrict the subagent to only these tool names. Omit to allow all tools.'
                },
                denied_tools: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Optional: deny these tool names for the subagent.'
                },
                system_prompt: {
                  type: 'string',
                  description: 'Optional: additional system prompt section to inject for this subagent only.'
                }
              },
              required: ['description', 'prompt'],
              additionalProperties: false
            },
            minItems: 1
          }
        },
        required: ['tasks'],
        additionalProperties: false
      }
    },
    handler: async (args, onProgress) => {
      const subagentService = getSubagentService()
      if (!subagentService) {
        return {
          error: 'Subagent service is not available in this runtime context.'
        }
      }

      const tasks = normalizeTaskList(args.tasks)
      if (tasks.length === 0) {
        return { error: 'tasks must be a non-empty array with valid description and prompt fields.' }
      }

      const abortSignal = getAbortSignal()

      onProgress?.(`🚀 启动 ${tasks.length} 个并行子 Agent`, tasks.map(t => t.description).join(' | '))

      // Track per-subagent status for the summary.
      const startedAt = Date.now()

      const results = await subagentService.runParallel(
        tasks.map(task => ({
          description: task.description,
          prompt: task.prompt,
          allowedTools: normalizeStringArray(task.allowed_tools),
          deniedTools: normalizeStringArray(task.denied_tools),
          systemPromptSections: task.system_prompt ? [task.system_prompt] : undefined
        })),
        onProgress,
        abortSignal
      )

      const elapsedMs = Date.now() - startedAt
      const completedCount = results.filter(r => r.status === 'completed').length
      const failedCount = results.filter(r => r.status === 'failed').length
      const elapsedSec = (elapsedMs / 1000).toFixed(1)

      onProgress?.(
        `✅ 所有子 Agent 执行完毕`,
        `${completedCount} 成功 / ${failedCount} 失败 · 耗时 ${elapsedSec}s`
      )

      return {
        results: results.map(r => ({
          description: r.description,
          status: r.status,
          result: r.result,
          ...(r.error ? { error: r.error } : {}),
          ...(r.tokenUsage ? { token_usage: r.tokenUsage } : {})
        })),
        summary: `${completedCount}/${tasks.length} 个子 Agent 成功完成，耗时 ${elapsedSec}s`
      }
    }
  }
}
