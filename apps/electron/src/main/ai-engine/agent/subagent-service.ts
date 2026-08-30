import type { AgentCore, ProgressCallback, ProgressEvent } from './agent-core.js'
import type { ChatMessage } from '../providers/openai-provider.js'

export interface SubagentTaskConfig {
  /** Short label (3-5 words) identifying what this subagent does. */
  description: string
  /** Full detailed instruction for the subagent to execute. */
  prompt: string
  /** Optional extra system-prompt sections to prepend. */
  systemPromptSections?: string[]
  /** Optional: restrict subagent to only these tool names. Omit for full tool access. */
  allowedTools?: string[]
  /** Optional: deny these tool names for the subagent. */
  deniedTools?: string[]
}

export interface SubagentResult {
  description: string
  result: string
  status: 'completed' | 'failed'
  error?: string
  /** Approximate token usage collected during the run. */
  tokenUsage?: { inputTokens: number; outputTokens: number; totalCost: number }
}

/** Factory function that creates a fresh AgentCore instance for a subagent. */
export type SubagentCoreFactory = (options?: {
  allowedTools?: string[]
  deniedTools?: string[]
  systemPromptSections?: string[]
}) => AgentCore

/**
 * SubagentService — spawns and runs isolated sub-agents in parallel.
 *
 * Each subagent gets its own AgentCore instance so it has an independent
 * conversation history and tool state. The parent agent awaits ALL results
 * before its tool call returns, enabling parallel task decomposition similar
 * to Claude Code's AgentTool.
 */
export class SubagentService {
  constructor (private readonly createAgentCore: SubagentCoreFactory) {}

  /**
   * Run a single subagent to completion and return its final text response.
   *
   * Progress events (tool use, compression, etc.) are forwarded to the
   * parent agent's onProgress callback with a `[description]` prefix so
   * the user can track multiple subagents simultaneously.
   */
  async runSubagent (
    config: SubagentTaskConfig,
    onProgress: ProgressCallback | undefined,
    abortSignal?: AbortSignal
  ): Promise<SubagentResult> {
    const label = config.description || 'subagent'

    const agent = this.createAgentCore({
      allowedTools: config.allowedTools,
      deniedTools: config.deniedTools,
      systemPromptSections: config.systemPromptSections
    })

    const userMessages: ChatMessage[] = [
      { role: 'user', content: config.prompt }
    ]

    onProgress?.(`[${label}] 启动`)

    let finalResult = ''
    let failed = false
    let errorMessage = ''

    try {
      // Use runStream to forward tool-level progress events to the parent.
      // Cast to unknown first because TypeScript cannot infer the union
      // parameter type from an overloaded ProgressCallback interface.
      const subagentProgress = ((stageOrEvent: string | ProgressEvent, detail?: string) => {
        if (typeof stageOrEvent === 'string') {
          onProgress?.(`[${label}] ${stageOrEvent}`, detail)
        } else if (stageOrEvent.type === 'progress') {
          onProgress?.(`[${label}] ${stageOrEvent.stage}`, stageOrEvent.detail)
        } else {
          // Forward non-progress ProgressEvents (todo_update, file_preview_*, etc.) as-is.
          onProgress?.(stageOrEvent as ProgressEvent)
        }
      }) as unknown as ProgressCallback

      for await (const event of agent.runStream(userMessages, subagentProgress, abortSignal)) {
        if (event.type === 'done') {
          const content = event.message.content
          if (typeof content === 'string') {
            finalResult = content
          } else if (Array.isArray(content)) {
            finalResult = content
              .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
              .map(part => part.text)
              .join('')
          }
        } else if (event.type === 'error') {
          failed = true
          errorMessage = event.error
        }
      }
    } catch (err) {
      failed = true
      errorMessage = (err as Error).message ?? String(err)
    }

    // Collect cost information from the subagent's cost tracker.
    let tokenUsage: SubagentResult['tokenUsage']
    try {
      const report = agent.getCostTracker().getUsageReport()
      tokenUsage = {
        inputTokens: report.totalInputTokens,
        outputTokens: report.totalOutputTokens,
        totalCost: report.totalCost
      }
    } catch {
      // Silently skip if cost tracker is unavailable.
    }

    if (failed) {
      onProgress?.(`[${label}] ❌ 失败: ${errorMessage}`)
      return {
        description: label,
        result: '',
        status: 'failed',
        error: errorMessage,
        tokenUsage
      }
    }

    onProgress?.(`[${label}] ✅ 完成`)
    return {
      description: label,
      result: finalResult,
      status: 'completed',
      tokenUsage
    }
  }

  /**
   * Run multiple subagents concurrently and collect all results.
   * Returns only after every subagent has finished (or failed).
   */
  async runParallel (
    configs: SubagentTaskConfig[],
    onProgress: ProgressCallback | undefined,
    abortSignal?: AbortSignal
  ): Promise<SubagentResult[]> {
    return Promise.all(
      configs.map(config => this.runSubagent(config, onProgress, abortSignal))
    )
  }
}
