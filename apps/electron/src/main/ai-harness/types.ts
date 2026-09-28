import type { AILogSessionLogger } from '../settings/ai-log-store.js'
import type { AIExecutionAuthMode } from '../settings/settings-store.js'
import type { ChatMessage, ToolDefinition } from './contracts.js'
import type { MemoryEmbeddingRuntimeConfig, MemorySearchScope } from '../../shared/agent-workspace-types.js'

export type { ChatMessage, MessageContent, ToolDefinition } from './contracts.js'

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
  | ProgressEvent
  | { type: 'reset' }
  | { type: 'plan_mode'; active: boolean; plan?: { goal: string; summary: string; steps: Array<{ description: string; files?: string[] }>; createdAt: number } }
  | { type: 'cost_update'; totalCost: number; inputTokens: number; outputTokens: number }
  | { type: 'done'; message: ChatMessage; thinking?: string }
  | { type: 'error'; error: string }

export interface CustomToolRegistration {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
  /** Explicitly replace an equally named Rust builtin with an Electron host tool. */
  domain?: 'electron_host_override' | 'host'
}

export interface AIConfigInput {
  apiKey?: string
  baseUrl?: string
  model?: string
  apiProtocol?: 'openai' | 'openai-chat' | 'openai-responses' | 'anthropic'
  providerId?: string
  providerName?: string
  imageGeneration?: boolean
  imageEditing?: boolean
  enableThinking?: boolean
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
  contextWindow?: number
  temperature?: number
}

export interface AIRequestOptions {
  /**
   * The selected agent is a run-scoped identity. Keeping it on the request
   * prevents the Rust conversation record from being rebound to a default
   * agent when Electron routes a group or channel turn.
   */
  agentId?: string | null
  targetProjectId?: string | null
  workspaceRoot?: string | null
  providerConfig?: AIConfigInput
  abortSignal?: AbortSignal
  conversationId?: string
  sessionId?: string
  /**
   * Electron UI routing for nested Rust runs. These remain stable while the
   * nested run receives its own conversation/session IDs in the Rust store.
   */
  hostConversationId?: string
  hostSessionId?: string
  authMode?: AIExecutionAuthMode
  getAuthMode?: () => AIExecutionAuthMode
  aiLogger?: AILogSessionLogger
  activeSkillContents?: string[]
  allowedMcpServerIds?: string[]
  systemPromptSections?: string[]
  allowedToolNames?: string[]
  deniedToolNames?: string[]
  /** Resolved scopes for Rust-owned memory retrieval. */
  memoryScopes?: MemorySearchScope[]
  /** Per-request embedding config for Rust-side semantic recall. */
  memoryEmbedding?: MemoryEmbeddingRuntimeConfig
  customTools?: CustomToolRegistration[]
  /** Internal nesting depth for Electron-hosted subagent runs. */
  subagentNestingDepth?: number
  /** Explicit per-run opt-in for OS-level Computer Use tools. */
  computerUseEnabled?: boolean
}

/** Minimal model/tool-loop surface shared by the legacy and Rust harnesses. */
export interface AIExecutionEngine {
  chat (messages: ChatMessage[], options?: AIRequestOptions): Promise<ChatMessage>
  chatStream (messages: ChatMessage[], onProgress?: ProgressCallback, options?: AIRequestOptions): AsyncGenerator<StreamEvent>
  getAvailableTools (): ToolDefinition[]
}

/** Electron-facing contract implemented by the Rust harness adapter. */
export interface AIHarness extends AIExecutionEngine {
  start (): Promise<void>
  setTargetProjectId (projectId: string | null): void
  setActiveSkills (contents: string[]): void
  configure (config: AIConfigInput): void
  setPlanMode (active: boolean): void
  getPlanMode (): boolean
  setCustomModelPricing (pricing: Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number }>): void
  setBudgetLimit(limit: number | null): void
}
