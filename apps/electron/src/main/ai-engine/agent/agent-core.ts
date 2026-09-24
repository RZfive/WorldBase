/**
 * Agent-loop contract types.
 *
 * The TypeScript agent loop has been removed — the Rust harness is the only
 * execution backend. This module now exists purely for the host tool layer
 * (`agent/tools/*` and `electron-tool-registry.ts`): tools receive these
 * types so they stay independent of any concrete loop implementation.
 */

import type { ChatMessage, ToolDefinition } from '../providers/openai-provider.js'
import type { AIExecutionAuthMode } from '../../settings/settings-store.js'
import type { PlanEngine, Plan } from './plan-mode.js'
import type { SkillEngine } from './skill-engine.js'
import type { PermissionRule, PermissionContext } from './permissions/permission-engine.js'

export type ProgressEvent =
  | { type: 'progress'; stage: string; detail?: string }
  | { type: 'todo_update'; items: Array<{ id: number; title: string; status: 'not-started' | 'in-progress' | 'completed' }> }
  | { type: 'file_preview_start'; filePath: string }
  | { type: 'file_preview_end'; filePath: string; lineCount?: number; added?: number; removed?: number }
  | { type: 'web_search_result'; query: string; engine: string; results: Array<{ rank: number; title: string; url: string; snippet: string; source: string; published_at?: string }> }
  | { type: 'web_fetch_result'; query?: string; result: { url: string; final_url?: string; ok: boolean; status?: number; status_text?: string; content_type?: string; title?: string; description?: string; content: string; excerpt_strategy?: 'query_snippets' | 'leading_text'; query_snippets?: string[]; query_match_count?: number; truncated: boolean; fetched_at: string; error?: string } }

export interface ProgressCallback {
  (stage: string, detail?: string): void
  (event: ProgressEvent): void
}

export type StreamEvent =
  | { type: 'token'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string }
  | { type: 'progress'; stage: string; detail?: string }
  | { type: 'todo_update'; items: Array<{ id: number; title: string; status: 'not-started' | 'in-progress' | 'completed' }> }
  | { type: 'file_preview_start'; filePath: string }
  | { type: 'file_preview_end'; filePath: string; lineCount?: number; added?: number; removed?: number }
  | { type: 'web_search_result'; query: string; engine: string; results: Array<{ rank: number; title: string; url: string; snippet: string; source: string; published_at?: string }> }
  | { type: 'web_fetch_result'; query?: string; result: { url: string; final_url?: string; ok: boolean; status?: number; status_text?: string; content_type?: string; title?: string; description?: string; content: string; excerpt_strategy?: 'query_snippets' | 'leading_text'; query_snippets?: string[]; query_match_count?: number; truncated: boolean; fetched_at: string; error?: string } }
  | { type: 'reset' }
  | { type: 'plan_mode'; active: boolean; plan?: Plan }
  | { type: 'cost_update'; totalCost: number; inputTokens: number; outputTokens: number }
  | { type: 'done'; message: ChatMessage; thinking?: string }
  | { type: 'error'; error: string }

export interface SessionState {
  /** The project ID created during this session (prevents duplicates). */
  createdProjectId: string | null
  /** An existing project ID the user wants to edit/optimize (set via chat context). */
  targetProjectId: string | null
  /** User-selected local folder workspace for this conversation. */
  workspaceRoot?: string | null
  /** Conversation identifier that owns the current execution. */
  conversationId?: string
  /** Renderer-side streaming session identifier for routing UI events back to the right chat. */
  sessionId?: string
  /** Authorization mode for local sensitive actions in this conversation. */
  authMode: AIExecutionAuthMode
}

/** One parallel subagent task handed to the host subagent runner. */
export interface SubagentTask {
  description: string
  prompt: string
  allowedTools?: string[]
  deniedTools?: string[]
  systemPromptSections?: string[]
}

export interface SubagentResult {
  description: string
  status: 'completed' | 'failed'
  result?: unknown
  error?: string
  tokenUsage?: { inputTokens: number; outputTokens: number }
}

/**
 * Structural subagent-runner surface. The Rust path implements this over the
 * harness's native subagent support; no TypeScript loop is involved.
 */
export interface SubagentService {
  runParallel (
    tasks: SubagentTask[],
    onProgress?: ProgressCallback,
    abortSignal?: AbortSignal
  ): Promise<SubagentResult[]>
}

/**
 * Structural surface the host tool layer needs from a running agent. The
 * Rust harness passes a lightweight shim implementing exactly this — there
 * is no TypeScript loop behind it anymore.
 */
export interface AgentCore {
  id: string
  sessionState: SessionState
  getAbortSignal (): AbortSignal | null
  getEffectiveAuthMode (): AIExecutionAuthMode
  getPlanEngine (): PlanEngine
  getSkillEngine (): SkillEngine
  getToolDefinitions (): ToolDefinition[]
  registerTool (name: string, definition: ToolDefinition, handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>): void
}

export type { PermissionRule, PermissionContext }
