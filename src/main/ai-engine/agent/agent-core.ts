import { getSystemPrompt } from './prompts/system-prompt.js'
import type { OpenAIProvider, ToolDefinition, ChatMessage, ToolCall } from '../providers/openai-provider.js'
import { normalizeAbortReason, USER_ABORT_MESSAGE } from '../abort-utils.js'
import type { AIExecutionAuthMode } from '../../settings/settings-store.js'
import type { AILogSessionLogger } from '../../settings/ai-log-store.js'
import { PermissionEngine, type PermissionRule, type PermissionContext } from './permissions/permission-engine.js'
import { ToolResultStorage } from './tool-result-storage.js'
import { PlanEngine, type Plan } from './plan-mode.js'
import { LoopDetector } from './loop-detector.js'
import { SkillEngine } from './skill-engine.js'
import { CostTracker, type ApiUsage } from '../cost-tracker.js'
import type { UsageStore } from '../../settings/usage-store.js'

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

interface RegisteredTool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

interface ToolExecutionRecord {
  name: string
  args: Record<string, unknown>
  result: unknown
}

interface LoopGuardState {
  startedAt: number
  totalIterations: number
  segmentIndex: number
  consecutiveDuplicateIterations: number
  lastIterationFingerprint: string | null
}

/**
 * AgentCore — AI Agent 核心循环
 * 实现 思考 → 行动 → 观察 的循环
 */
/**
 * Per-session state shared between the agent core and tool handlers.
 * Reset at the start of each run/runStream call.
 */
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

export class AgentCore {
  // Keep summaries short enough to fit comfortably back into the prompt.
  private static readonly AUTO_CONTINUE_PREFIX = '[AUTO_CONTINUE]'
  private static readonly FINISH_TASK_NUDGE_PREFIX = '[FINISH_TASK_NUDGE]'
  private static readonly FINISH_TASK_TOOL_NAME = 'finish_task'
  private static readonly MAX_FINISH_TASK_NUDGES = 2
  private static readonly FINISH_TASK_TOOL_DEFINITION: ToolDefinition = {
    name: AgentCore.FINISH_TASK_TOOL_NAME,
    description: 'Signal that the current user request is fully complete. Use this as the final action after tool-based or multi-step work. The task summary is printed as the visible closing message, so make it concrete and do not use this tool while work remains.',
    parameters: {
      type: 'object',
      properties: {
        task_summary: {
          type: 'string',
          description: 'Required visible task summary in the user\'s language. State the outcome, important completed work, verification performed, and any remaining caveats or next steps. Write the Markdown body only; the runtime adds the heading.'
        },
        final_response: {
          type: 'string',
          description: 'Optional short handoff shown after the task summary. Do not repeat the summary. Retained for compatibility with older callers.'
        },
        status: {
          type: 'string',
          enum: ['completed', 'partial', 'blocked'],
          description: 'Completion status for the request.'
        }
      },
      required: ['task_summary']
    }
  }
  private static readonly CONTEXT_SUMMARY_PREFIX = '[CONTEXT_SUMMARY]'
  private static readonly CONTEXT_GOAL_ANCHOR_PREFIX = '[CONTEXT_GOAL_ANCHOR]'
  private static readonly CONTEXT_SUMMARY_CHAR_LIMIT = 1500
  private static readonly CONTEXT_SUMMARY_SOURCE_MAX_CHARS = 2500
  private static readonly CONTEXT_SUMMARY_MAX_SOURCE_MESSAGES = 48
  private static readonly CONTEXT_GOAL_ANCHOR_MAX_CHARS = 2000
  private static readonly CONTEXT_RECENT_MESSAGE_MAX_CHARS = 3000
  private static readonly CONTEXT_RECENT_TOOL_RESULT_MAX_CHARS = 2500
  private static readonly CONTEXT_RECENT_TOOL_ARGUMENT_MAX_CHARS = 800
  private static readonly CONTEXT_HEADROOM_RATIO = 0.15
  private static readonly CONTEXT_MIN_HEADROOM_TOKENS = 2048
  private static readonly CONTEXT_MAX_HEADROOM_TOKENS = 8192
  private static readonly CONTEXT_COMPRESSION_TIMEOUT_MS = 5 * 60 * 1000
  private static readonly RECENT_MESSAGE_KEEP_OPTIONS = [6, 4, 2, 0] as const
  // Lightweight heuristic for providers without tokenizer access.
  private static readonly ESTIMATED_CHARS_PER_TOKEN = 4
  private static readonly ESTIMATED_MESSAGE_OVERHEAD_TOKENS = 12
  private static readonly FINGERPRINT_MAX_DEPTH = 4
  private static readonly FINGERPRINT_MAX_ARRAY_ITEMS = 8
  private static readonly FINGERPRINT_MAX_OBJECT_KEYS = 12
  private static readonly FINGERPRINT_MAX_STRING_CHARS = 240
  /**
   * Tools that only read state and have no side effects, so several of them can
   * safely run concurrently within a single assistant turn. Mirrors Claude
   * Code's "concurrency-safe" partition: read/search/list/status tools fan out
   * in parallel while any write/run/build tool stays serial. MCP tools and
   * anything not listed here are treated as serial (the safe default).
   */
  private static readonly CONCURRENCY_SAFE_TOOLS: ReadonlySet<string> = new Set([
    'read_project_file',
    'list_project_files',
    'read_workspace_file',
    'list_workspace_files',
    'grep_workspace',
    'glob_workspace',
    'get_workspace_command_status',
    'list_projects',
    'get_project_status',
    'get_project_logs',
    'get_project_command_status',
    'grep_search',
    'glob_search',
    'read_document',
    'list_documents',
    'local_read_file',
    'read_current_page',
    'list_skills',
    'list_scheduled_tasks',
    'list_agent_workspace_catalog',
    'web_search',
    'fetch_webpage'
  ])
  private static readonly TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
    ['spawn_subagentstasks', 'spawn_subagents']
  ])
  private provider: OpenAIProvider
  private services: Record<string, unknown>
  private tools = new Map<string, RegisteredTool>()
  // Per-segment iteration budget before the agent automatically compacts and continues.
  private maxIterations = 128
  // Periodically force a silent context compaction so long sessions can keep going.
  private proactiveCompressionInterval = 16
  // Long-running build/debug tasks may legitimately span hours, so keep the guard aligned with the product limit.
  private maxRunDurationMs = 8 * 60 * 60 * 1000
  private maxDuplicateIterationFingerprints = 6
  private maxStreamRetries = 3
  private activeSkillContents: string[] = []
  private systemPromptSections: string[] = []
  private allowedToolNames = new Set<string>()
  private deniedToolNames = new Set<string>()
  private logger?: AILogSessionLogger
  private permissionEngine: PermissionEngine
  private resultStorage: ToolResultStorage
  private planEngine: PlanEngine
  private loopDetector: LoopDetector
  private skillEngine: SkillEngine
  private costTracker: CostTracker
  private usageStore?: UsageStore
  /** 供应商 id/名称快照（由 createAgent 从 providerConfig 注入，用量统计分组用）。 */
  private providerId?: string
  private providerName?: string
  private currentAbortSignal?: AbortSignal
  private authModeResolver?: () => AIExecutionAuthMode
  /** Shared mutable state accessible by tool handlers within a session. */
  public sessionState: SessionState = { createdProjectId: null, targetProjectId: null, authMode: 'strict' }

  constructor (provider: OpenAIProvider, services: Record<string, unknown>) {
    this.provider = provider
    this.services = services
    this.permissionEngine = new PermissionEngine({})
    this.resultStorage = new ToolResultStorage()
    this.planEngine = new PlanEngine()
    this.loopDetector = new LoopDetector(this.maxDuplicateIterationFingerprints)
    this.skillEngine = new SkillEngine()
    this.costTracker = new CostTracker()
    this.usageStore = services.usageStore as UsageStore | undefined

    // Wire cost tracking into provider usage callback
    this.provider.setOnUsage((usage) => {
      this.costTracker.record(this.provider.getModel(), usage)
      // 持久化真实 token 用量（按天 × 供应商 × 模型聚合），用于设置页用量统计。
      if (this.usageStore) {
        this.usageStore.record({
          providerId: this.providerId || 'unknown',
          providerName: this.providerName || this.providerId || 'unknown',
          model: this.provider.getModel(),
          usage: usage as Record<string, unknown> | null
        })
      }
    })
  }

  /** Set the provider id/name snapshot for usage statistics grouping. */
  setProviderIdentity (providerId?: string, providerName?: string): void {
    this.providerId = providerId
    this.providerName = providerName
  }

  /** Set skill contents to inject into the system prompt. */
  setActiveSkills (contents: string[]): void {
    this.activeSkillContents = contents
    // 解析 skill 内容并注册到 SkillEngine
    this.skillEngine.clear()
    for (const content of contents) {
      this.skillEngine.registerFromContent(content)
    }
  }

  setSystemPromptSections (sections: string[]): void {
    this.systemPromptSections = sections
      .map(section => section.trim())
      .filter(Boolean)
  }

  setToolVisibilityFilters (allowedToolNames?: string[], deniedToolNames?: string[]): void {
    this.allowedToolNames = new Set(this._normalizeToolNameCollection(allowedToolNames))
    this.deniedToolNames = new Set(this._normalizeToolNameCollection(deniedToolNames))
  }

  /** Get the plan engine instance (used by plan mode tools). */
  getPlanEngine (): PlanEngine {
    return this.planEngine
  }

  /** Get the skill engine instance (used by run_skill tool). */
  getSkillEngine (): SkillEngine {
    return this.skillEngine
  }

  /** Get the cost tracker instance. */
  getCostTracker (): CostTracker {
    return this.costTracker
  }

  getAbortSignal (): AbortSignal | undefined {
    return this.currentAbortSignal
  }

  getEffectiveAuthMode (): AIExecutionAuthMode {
    return this.authModeResolver?.() ?? this.sessionState.authMode
  }

  /**
   * Register a tool for the agent to use.
   */
  registerTool (name: string, definition: ToolDefinition, handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>): void {
    this.tools.set(name, { definition, handler })
  }

  /**
   * Get all tool definitions (for LLM function calling).
   */
  getToolDefinitions (): ToolDefinition[] {
    const runtimeTools = Array.from(this.tools.entries())
      .filter(([name]) => this._isToolVisible(name))
      .map(([, tool]) => tool.definition)

    if (runtimeTools.some(tool => tool.name === AgentCore.FINISH_TASK_TOOL_NAME)) {
      return runtimeTools
    }

    return [...runtimeTools, AgentCore.FINISH_TASK_TOOL_DEFINITION]
  }

  /**
   * Run the agent loop with the given messages (non-streaming, kept for compat).
   */
  /** Set a target project ID for the current session (edit/optimize mode). */
  setTargetProjectId (projectId: string | null): void {
    this.sessionState.targetProjectId = projectId
  }

  setAuthMode (authMode: AIExecutionAuthMode): void {
    this.sessionState.authMode = authMode
  }

  setAuthModeResolver (resolver?: () => AIExecutionAuthMode): void {
    this.authModeResolver = resolver
  }

  setLogger (logger?: AILogSessionLogger): void {
    this.logger = logger
  }

  /** Configure the permission engine with context for user-auth dialogs. */
  setPermissionContext (context: PermissionContext): void {
    this.permissionEngine = new PermissionEngine(context)
  }

  /** Load user-configured permission rules. */
  setPermissionRules (rules: PermissionRule[]): void {
    this.permissionEngine.loadRules(rules)
  }

  private _resetSessionState (): void {
    this.sessionState = {
      createdProjectId: null,
      targetProjectId: this.sessionState.targetProjectId,
      authMode: this.getEffectiveAuthMode(),
      // Preserve routing context so tool-level requestUserAuth can find the conversation.
      conversationId: this.sessionState.conversationId,
      sessionId: this.sessionState.sessionId
    }
    this.planEngine.reset()
    this.loopDetector.reset()
    this.costTracker.reset()
  }

  private _isToolVisible (name: string): boolean {
    const canonicalName = this._resolveToolName(name)
    if (this.allowedToolNames.size > 0 && !this.allowedToolNames.has(canonicalName)) {
      return false
    }

    return !this.deniedToolNames.has(canonicalName)
  }

  private _resolveToolName (name: string): string {
    return AgentCore.TOOL_ALIASES.get(name) || name
  }

  private _normalizeToolNameCollection (names?: string[]): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const name of names || []) {
      const normalized = this._resolveToolName(name.trim())
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      result.push(normalized)
    }
    return result
  }

  private _resolveFinalAssistantContent (assistantContent: ChatMessage['content'], renderedContent: string): ChatMessage['content'] {
    if (Array.isArray(assistantContent)) {
      if (!renderedContent) {
        return assistantContent
      }

      const imageParts = assistantContent.filter(part => part.type === 'image_url')
      if (imageParts.length === 0) {
        return renderedContent
      }

      return [
        { type: 'text', text: renderedContent },
        ...imageParts
      ]
    }

    if (renderedContent) {
      return renderedContent
    }

    return assistantContent || ''
  }

  private _isFinishTaskToolCall (toolCall: ToolCall): boolean {
    return this._resolveToolName(toolCall.function.name) === AgentCore.FINISH_TASK_TOOL_NAME
  }

  private _splitFinishTaskToolCalls (toolCalls?: ToolCall[]): { finishCall: ToolCall | null; regularCalls: ToolCall[] } {
    const calls = toolCalls || []
    const finishCall = calls.find(call => this._isFinishTaskToolCall(call)) || null
    return {
      finishCall,
      regularCalls: calls.filter(call => !this._isFinishTaskToolCall(call))
    }
  }

  private _buildFinishTaskMessage (toolCall: ToolCall, fallbackContent: ChatMessage['content'] = ''): ChatMessage {
    try {
      const args = this._parseToolArguments(AgentCore.FINISH_TASK_TOOL_NAME, toolCall.function.arguments)
      const taskSummary = typeof args.task_summary === 'string'
        ? args.task_summary.trim()
        : ''
      const finalResponse = typeof args.final_response === 'string'
        ? args.final_response.trim()
        : ''
      const fallbackText = this._serializeMessageContentForSummary(fallbackContent)
      const summaryBlock = taskSummary
        ? `## \u4efb\u52a1\u5c0f\u7ed3\n\n${taskSummary}`
        : ''
      const content = summaryBlock
        ? (finalResponse && finalResponse !== taskSummary
            ? `${summaryBlock}\n\n${finalResponse}`
            : summaryBlock)
        : (finalResponse || fallbackText)
      return {
        role: 'assistant',
        content
      }
    } catch {
      return {
        role: 'assistant',
        content: this._serializeMessageContentForSummary(fallbackContent)
      }
    }
  }

  private _shouldRequireFinishTask (hasExecutedTools: boolean, finishNudgeCount: number): boolean {
    return hasExecutedTools && finishNudgeCount < AgentCore.MAX_FINISH_TASK_NUDGES
  }

  private _withFinishTaskNudge (messages: ChatMessage[], nudgeCount: number): ChatMessage[] {
    const withoutPreviousNudge = this._removeSystemMessagesByPrefix(messages, AgentCore.FINISH_TASK_NUDGE_PREFIX)
    return this._insertSystemDirective(
      withoutPreviousNudge,
      `${AgentCore.FINISH_TASK_NUDGE_PREFIX}\n上一轮 assistant 没有调用任何工具，也没有调用 ${AgentCore.FINISH_TASK_TOOL_NAME}，因此不能仅凭普通文本判断任务已经完成。请在下一步二选一：\n- 如果任务已经完成并且已经做过必要验证，调用 ${AgentCore.FINISH_TASK_TOOL_NAME}，在 task_summary 中写明结果、已完成工作、验证和剩余注意事项；这段小结会被直接打印给用户。\n- 如果任务还没完成，调用下一步真正需要的工具继续执行。\n不要再次只输出普通文本来表示“我会继续”或“已完成”。这是第 ${nudgeCount + 1} 次完成信号校验。`
    )
  }

  private _parseToolArguments (toolName: string, rawArguments: string): Record<string, unknown> {
    const normalized = rawArguments.trim()
    if (!normalized) {
      return {}
    }

    const tried = new Set<string>()
    const candidates = this._buildToolArgumentCandidates(normalized)

    for (const candidate of candidates) {
      const value = candidate.trim()
      if (!value || tried.has(value)) {
        continue
      }
      tried.add(value)

      const parsed = this._tryParseToolArgumentCandidate(value)
      if (parsed) {
        if (value !== normalized) {
          console.warn(`[Agent] Repaired malformed arguments for tool ${toolName}`)
        }
        return parsed
      }
    }

    const snippet = normalized.length > 200 ? `${normalized.slice(0, 200)}...` : normalized
    throw new Error(`Invalid JSON arguments for tool ${toolName}: ${snippet}`)
  }

  private _tryParseToolArgumentCandidate (candidate: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(candidate) as unknown
      return this._normalizeParsedToolArguments(parsed)
    } catch {
      return null
    }
  }

  private _normalizeParsedToolArguments (parsed: unknown): Record<string, unknown> | null {
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }

    if (typeof parsed === 'string') {
      const nested = parsed.trim()
      if (!nested) {
        return {}
      }
      if (nested.startsWith('{') || nested.startsWith('[')) {
        return this._tryParseToolArgumentCandidate(nested)
      }
    }

    return null
  }

  private _buildToolArgumentCandidates (rawArguments: string): string[] {
    const candidates = [rawArguments]
    const unfenced = rawArguments
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim()

    if (unfenced && unfenced !== rawArguments) {
      candidates.push(unfenced)
    }

    const extracted = this._extractFirstBalancedJson(unfenced || rawArguments)
    if (extracted) {
      candidates.push(extracted)
    }

    const segments = this._splitBalancedJsonSegments(unfenced || rawArguments)
    if (segments.length > 1) {
      const merged = this._mergeToolArgumentSegments(segments)
      if (merged) {
        candidates.push(JSON.stringify(merged))
      }
    }

    return candidates
  }

  private _extractFirstBalancedJson (raw: string): string | null {
    const firstObject = raw.indexOf('{')
    const firstArray = raw.indexOf('[')
    const startIndexes = [firstObject, firstArray].filter(index => index >= 0)
    if (startIndexes.length === 0) {
      return null
    }

    const start = Math.min(...startIndexes)
    let depth = 0
    let inString = false
    let escaping = false

    for (let index = start; index < raw.length; index++) {
      const ch = raw[index]

      if (inString) {
        if (escaping) {
          escaping = false
          continue
        }
        if (ch === '\\') {
          escaping = true
          continue
        }
        if (ch === '"') {
          inString = false
        }
        continue
      }

      if (ch === '"') {
        inString = true
        continue
      }

      if (ch === '{' || ch === '[') {
        depth++
        continue
      }

      if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) {
          return raw.slice(start, index + 1)
        }
      }
    }

    return null
  }

  private _splitBalancedJsonSegments (raw: string): string[] {
    const segments: string[] = []
    let segmentStart = -1
    let depth = 0
    let inString = false
    let escaping = false

    for (let index = 0; index < raw.length; index++) {
      const ch = raw[index]

      if (inString) {
        if (escaping) {
          escaping = false
          continue
        }
        if (ch === '\\') {
          escaping = true
          continue
        }
        if (ch === '"') {
          inString = false
        }
        continue
      }

      if (ch === '"') {
        inString = true
        continue
      }

      if (ch === '{' || ch === '[') {
        if (depth === 0) {
          segmentStart = index
        }
        depth++
        continue
      }

      if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0 && segmentStart >= 0) {
          segments.push(raw.slice(segmentStart, index + 1))
          segmentStart = -1
        }
      }
    }

    return segments
  }

  private _mergeToolArgumentSegments (segments: string[]): Record<string, unknown> | null {
    const merged: Record<string, unknown> = {}

    for (const segment of segments) {
      const parsed = this._tryParseToolArgumentCandidate(segment)
      if (!parsed) {
        return null
      }
      Object.assign(merged, parsed)
    }

    return Object.keys(merged).length > 0 ? merged : null
  }

  private _createLoopGuardState (): LoopGuardState {
    return {
      startedAt: Date.now(),
      totalIterations: 0,
      segmentIndex: 1,
      consecutiveDuplicateIterations: 0,
      lastIterationFingerprint: null
    }
  }

  private _getLoopStopReason (state: LoopGuardState): string | null {
    const elapsed = Date.now() - state.startedAt
    if (elapsed >= this.maxRunDurationMs) {
      const minutes = Math.max(1, Math.ceil(elapsed / 60000))
      return `The current task has been running for about ${minutes} minutes without finishing, so it has been stopped to avoid holding resources indefinitely. Please continue later or split it into smaller steps.`
    }

    if (state.consecutiveDuplicateIterations >= this.maxDuplicateIterationFingerprints) {
      return `The AI repeated the same tool calls and results for ${state.consecutiveDuplicateIterations} consecutive iterations, so this run has been stopped to avoid looping. Adjust the prompt, inspect tool output, or try a different strategy.`
    }

    return null
  }

  private _buildStopMessage (reason: string): ChatMessage {
    return {
      role: 'assistant',
      content: reason
    }
  }

  private _appendStopReason (renderedContent: string, reason: string): string {
    return renderedContent.trim().length > 0
      ? `${renderedContent}\n\n${reason}`
      : reason
  }

  private async _prepareAutomaticContinuation (messages: ChatMessage[], state: LoopGuardState, onProgress?: ProgressCallback, abortSignal?: AbortSignal): Promise<ChatMessage[]> {
    const nextSegmentIndex = state.segmentIndex + 1
    onProgress?.('♻️ Auto-continuing...', `Segment ${nextSegmentIndex}, ${state.totalIterations} total iterations`)

    const compressedMessages = await this._compressContextIfNeeded(
      this._removeSystemMessagesByPrefix(messages, AgentCore.AUTO_CONTINUE_PREFIX),
      onProgress,
      abortSignal,
      true
    )

    state.segmentIndex = nextSegmentIndex
    return this._insertSystemDirective(
      compressedMessages,
      `${AgentCore.AUTO_CONTINUE_PREFIX}\n你正在继续同一个尚未完成的任务。这不是新任务，不要重复已经成功完成的步骤，也不要重复执行刚刚已成功且结果无变化的工具。优先基于最近的工具结果继续推进；如果同一错误连续出现，请改变策略并明确说明新的处理思路。当前为自动续跑第 ${state.segmentIndex} 段。`
    )
  }

  private _removeSystemMessagesByPrefix (messages: ChatMessage[], prefix: string): ChatMessage[] {
    return messages.filter((message, index) => {
      return !(index > 0 &&
        message.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.startsWith(prefix))
    })
  }

  private _findSystemMessageByPrefix (messages: ChatMessage[], prefix: string): ChatMessage | null {
    return messages.find((message, index) => {
      return index > 0 &&
        message.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.startsWith(prefix)
    }) || null
  }

  private _insertSystemDirective (messages: ChatMessage[], content: string): ChatMessage[] {
    const nextMessages = [...this._removeSystemMessagesByPrefix(messages, AgentCore.AUTO_CONTINUE_PREFIX)]
    const insertIndex = nextMessages.findIndex((message, index) => index > 0 && this._isExistingSummaryMessage(message))
    nextMessages.splice(insertIndex >= 0 ? insertIndex + 1 : 1, 0, {
      role: 'system',
      content
    })
    return nextMessages
  }

  private _recordIterationActivity (state: LoopGuardState, executions: ToolExecutionRecord[]): void {
    if (executions.length === 0) {
      return
    }

    const fingerprint = this._buildIterationFingerprint(executions)
    if (state.lastIterationFingerprint === fingerprint) {
      state.consecutiveDuplicateIterations++
      return
    }

    state.lastIterationFingerprint = fingerprint
    state.consecutiveDuplicateIterations = 1
  }

  private _buildIterationFingerprint (executions: ToolExecutionRecord[]): string {
    return JSON.stringify(executions.map(execution => ({
      name: execution.name,
      args: this._normalizeFingerprintValue(execution.args),
      result: this._normalizeFingerprintValue(execution.result)
    })))
  }

  private _normalizeFingerprintValue (value: unknown, depth = 0): unknown {
    if (depth >= AgentCore.FINGERPRINT_MAX_DEPTH) {
      return '[max-depth]'
    }

    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      return value
    }

    if (typeof value === 'string') {
      return this._truncateString(value, AgentCore.FINGERPRINT_MAX_STRING_CHARS)
    }

    if (typeof value === 'bigint') {
      return value.toString()
    }

    if (Array.isArray(value)) {
      const normalized = value
        .slice(0, AgentCore.FINGERPRINT_MAX_ARRAY_ITEMS)
        .map(item => this._normalizeFingerprintValue(item, depth + 1))

      if (value.length > AgentCore.FINGERPRINT_MAX_ARRAY_ITEMS) {
        normalized.push(`[+${value.length - AgentCore.FINGERPRINT_MAX_ARRAY_ITEMS} more items]`)
      }

      return normalized
    }

    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))

      const normalized: Record<string, unknown> = {}
      for (const [key, entryValue] of entries.slice(0, AgentCore.FINGERPRINT_MAX_OBJECT_KEYS)) {
        normalized[key] = this._normalizeFingerprintValue(entryValue, depth + 1)
      }

      if (entries.length > AgentCore.FINGERPRINT_MAX_OBJECT_KEYS) {
        normalized.__truncatedKeys = entries.length - AgentCore.FINGERPRINT_MAX_OBJECT_KEYS
      }

      return normalized
    }

    return String(value)
  }

  private _truncateString (value: string, maxChars: number): string {
    if (value.length <= maxChars) {
      return value
    }

    const suffix = `...[truncated ${value.length - maxChars} chars]`
    const headLength = Math.max(0, maxChars - suffix.length)
    return `${value.slice(0, headLength)}${suffix}`
  }

  private _serializeMessageContentForSummary (content: ChatMessage['content']): string {
    if (typeof content === 'string') {
      return this._truncateString(content, AgentCore.CONTEXT_SUMMARY_SOURCE_MAX_CHARS)
    }

    const rendered = content
      .map(part => part.type === 'text' ? part.text : '[image omitted]')
      .join('\n')

    return this._truncateString(rendered, AgentCore.CONTEXT_SUMMARY_SOURCE_MAX_CHARS)
  }

  private _serializeMessageContentForGoalAnchor (content: ChatMessage['content']): string {
    const rendered = typeof content === 'string'
      ? content
      : content
        .map(part => part.type === 'text' ? part.text : '[image omitted]')
        .join('\n')
    return this._truncateString(rendered.trim(), AgentCore.CONTEXT_GOAL_ANCHOR_MAX_CHARS)
  }

  private _extractGoalAnchorFieldFallback (content: string, label: string): string | null {
    const marker = `${label}:\n`
    const start = content.indexOf(marker)
    if (start < 0) return null
    const valueStart = start + marker.length
    const valueEnd = content.indexOf('\n\n', valueStart)
    const value = content.slice(valueStart, valueEnd >= 0 ? valueEnd : undefined).trim()
    return value || null
  }

  private _parseGoalAnchorPayload (content: string): { originalUserRequest?: string; latestUserRequest?: string } | null {
    const payloadText = content.slice(AgentCore.CONTEXT_GOAL_ANCHOR_PREFIX.length).trim()
    if (!payloadText) return null

    try {
      const parsed = JSON.parse(payloadText) as Record<string, unknown>
      return {
        originalUserRequest: typeof parsed.originalUserRequest === 'string' ? parsed.originalUserRequest.trim() : undefined,
        latestUserRequest: typeof parsed.latestUserRequest === 'string' ? parsed.latestUserRequest.trim() : undefined
      }
    } catch {
      return {
        originalUserRequest: this._extractGoalAnchorFieldFallback(content, 'Original user request sent to AI') || undefined,
        latestUserRequest: this._extractGoalAnchorFieldFallback(content, 'Latest user request') || undefined
      }
    }
  }

  private _buildContextGoalAnchorMessage (messages: ChatMessage[], previousAnchor?: ChatMessage | null): ChatMessage | null {
    const userMessages = messages
      .filter(message => message.role === 'user')
      .map(message => this._serializeMessageContentForGoalAnchor(message.content))
      .filter(Boolean)

    const previousAnchorContent = typeof previousAnchor?.content === 'string' ? previousAnchor.content : ''
    const previousAnchorPayload = previousAnchorContent ? this._parseGoalAnchorPayload(previousAnchorContent) : null
    const previousOriginalGoal = previousAnchorPayload?.originalUserRequest || null
    const previousLatestGoal = previousAnchorPayload?.latestUserRequest || null
    const originalGoal = previousOriginalGoal || userMessages[0]
    const latestGoal = userMessages[userMessages.length - 1] || previousLatestGoal || originalGoal

    if (!originalGoal && !latestGoal) return null

    return {
      role: 'system',
      content: `${AgentCore.CONTEXT_GOAL_ANCHOR_PREFIX}\n${JSON.stringify({
        instruction: 'Authoritative task anchor preserved across automatic context compression. This is not a new user request. If any generated summary conflicts with this anchor, follow this anchor.',
        originalUserRequest: originalGoal || latestGoal || '',
        latestUserRequest: latestGoal || originalGoal || '',
        targetProjectId: this.sessionState.targetProjectId || undefined,
        workspaceRoot: this.sessionState.workspaceRoot || undefined
      }, null, 2)}`
    }
  }

  private _getContextCompressionThreshold (contextWindow: number): number {
    const reservedTokens = Math.min(
      Math.max(
        Math.floor(contextWindow * AgentCore.CONTEXT_HEADROOM_RATIO),
        AgentCore.CONTEXT_MIN_HEADROOM_TOKENS
      ),
      AgentCore.CONTEXT_MAX_HEADROOM_TOKENS
    )

    return Math.max(1, contextWindow - reservedTokens)
  }

  async run (userMessages: ChatMessage[]): Promise<ChatMessage> {
    this._resetSessionState()
    this.currentAbortSignal = undefined
    const toolDefs = this.getToolDefinitions()
    const systemMessage: ChatMessage = {
      role: 'system',
      content: getSystemPrompt({
        skillContents: this.activeSkillContents.length > 0 ? this.activeSkillContents : undefined,
        availableTools: toolDefs,
        targetProjectId: this.sessionState.targetProjectId,
        planModeActive: this.planEngine.active,
        systemPromptSections: this.systemPromptSections
      })
    }

    try {
      let messages: ChatMessage[] = [systemMessage, ...userMessages]
      const loopGuard = this._createLoopGuardState()
      let segmentIterations = 0
      let hasExecutedTools = false
      let finishNudgeCount = 0

      while (true) {
        const stopReason = this._getLoopStopReason(loopGuard)
        if (stopReason) {
          return this._buildStopMessage(stopReason)
        }

        if (segmentIterations >= this.maxIterations) {
          messages = await this._prepareAutomaticContinuation(messages, loopGuard)
          segmentIterations = 0
        }

        const forceCompression = segmentIterations > 0 && segmentIterations % this.proactiveCompressionInterval === 0
        messages = await this._compressContextIfNeeded(messages, undefined, undefined, forceCompression)
        segmentIterations++
        loopGuard.totalIterations++

        const response = await this.provider.chatCompletion(messages, toolDefs)
        const { finishCall, regularCalls } = this._splitFinishTaskToolCalls(response.tool_calls)

        if (finishCall && regularCalls.length === 0) {
          return this._buildFinishTaskMessage(finishCall, response.content)
        }

        if (regularCalls.length === 0) {
          if (this._shouldRequireFinishTask(hasExecutedTools, finishNudgeCount)) {
            messages.push({
              ...response,
              tool_calls: undefined
            })
            messages = this._withFinishTaskNudge(messages, finishNudgeCount)
            finishNudgeCount++
            continue
          }
          return {
            role: 'assistant',
            content: response.content || ''
          }
        }

        messages.push({
          ...response,
          tool_calls: regularCalls
        })
        const executions: ToolExecutionRecord[] = []

        // Read-only tools within a group run concurrently; writes stay serial.
        for (const group of this._groupToolCalls(regularCalls)) {
          const groupResults = group.length === 1
            ? [await this._executeToolCall(group[0])]
            : await Promise.all(group.map(call => this._executeToolCall(call)))
          for (const { execution, message } of groupResults) {
            executions.push(execution)
            messages.push(message)
          }
        }
        hasExecutedTools = true
        finishNudgeCount = 0

        this._recordIterationActivity(loopGuard, executions)

        // Enhanced loop detection with SHA-256 hashing
        const loopResult = this.loopDetector.record(executions)
        if (loopResult.looping) {
          return this._buildStopMessage(loopResult.reason!)
        }
      }
    } finally {
      this.currentAbortSignal = undefined
    }
  }

  /**
   * Run the agent loop in streaming mode.
   * Yields tokens in real-time and tool execution events.
   */
  async * runStream (userMessages: ChatMessage[], onProgress?: ProgressCallback, abortSignal?: AbortSignal): AsyncGenerator<StreamEvent> {
    this._resetSessionState()
    this.currentAbortSignal = abortSignal
    const toolDefs = this.getToolDefinitions()
    const systemMessage: ChatMessage = {
      role: 'system',
      content: getSystemPrompt({
        skillContents: this.activeSkillContents.length > 0 ? this.activeSkillContents : undefined,
        availableTools: toolDefs,
        targetProjectId: this.sessionState.targetProjectId,
        planModeActive: this.planEngine.active,
        systemPromptSections: this.systemPromptSections
      })
    }

    try {
      let messages: ChatMessage[] = [systemMessage, ...userMessages]
      const loopGuard = this._createLoopGuardState()
      let segmentIterations = 0
      let renderedContent = ''
      let fullThinking = ''
      let hasExecutedTools = false
      let finishNudgeCount = 0

      while (true) {
        this._throwIfAborted(abortSignal)
        const stopReason = this._getLoopStopReason(loopGuard)
        if (stopReason) {
          yield {
            type: 'done',
            message: {
              role: 'assistant',
              content: this._appendStopReason(renderedContent, stopReason)
            },
            thinking: fullThinking || undefined
          }
          return
        }

        if (segmentIterations >= this.maxIterations) {
          messages = await this._prepareAutomaticContinuation(messages, loopGuard, onProgress, abortSignal)
          segmentIterations = 0
        }

        const forceCompression = segmentIterations > 0 && segmentIterations % this.proactiveCompressionInterval === 0
        messages = await this._compressContextIfNeeded(messages, onProgress, abortSignal, forceCompression)
        segmentIterations++
        loopGuard.totalIterations++

      let assistantMessage: ChatMessage | null = null
      let iterationThinking = ''
      let iterationContent = ''
      let streamError: Error | null = null

      for (let attempt = 1; attempt <= this.maxStreamRetries; attempt++) {
        assistantMessage = null
        iterationThinking = ''
        iterationContent = ''

        try {
          if (attempt > 1) {
            this._throwIfAborted(abortSignal)
            onProgress?.('🔄 AI 连接中断，正在重试...', `第 ${attempt} 次尝试`)
            yield { type: 'reset' }
            await this._sleep(Math.min(1000 * (2 ** (attempt - 1)), 5000))
          }

          for await (const event of this.provider.chatCompletionStream(messages, toolDefs, abortSignal)) {
            if (event.type === 'thinking') {
              iterationThinking += event.content
              yield { type: 'thinking', content: event.content }
            } else if (event.type === 'token') {
              iterationContent += event.content
              yield { type: 'token', content: event.content }
            } else if (event.type === 'tool_calls') {
              assistantMessage = event.message
            } else if (event.type === 'done') {
              if (!assistantMessage) {
                assistantMessage = event.message
              }
            }
          }
          streamError = null
          break
        } catch (err) {
          streamError = err as Error
          if (attempt === this.maxStreamRetries) {
            throw streamError
          }
        }
      }

      if (streamError) {
        throw streamError
      }

      fullThinking += iterationThinking
      renderedContent += iterationContent

      if (!assistantMessage) break

      const { finishCall, regularCalls } = this._splitFinishTaskToolCalls(assistantMessage.tool_calls)
      if (finishCall && regularCalls.length === 0) {
        const finishMessage = this._buildFinishTaskMessage(
          finishCall,
          this._resolveFinalAssistantContent(assistantMessage.content, renderedContent)
        )
        const visibleSummary = this._serializeMessageContentForSummary(finishMessage.content)
        if (visibleSummary) {
          // Create a content block after the final tool run. When the text only
          // arrives with `done`, the renderer may backfill the initial empty
          // block and make a long task appear to stop without a closing summary.
          yield { type: 'token', content: visibleSummary }
        }
        yield {
          type: 'done',
          message: finishMessage,
          thinking: fullThinking || undefined
        }
        return
      }

      // No regular tool calls → either final response (simple chat/no tools used)
      // or a missing explicit finish signal after tool-based work.
      if (regularCalls.length === 0) {
        if (this._shouldRequireFinishTask(hasExecutedTools, finishNudgeCount)) {
          messages.push({
            ...assistantMessage,
            content: this._resolveFinalAssistantContent(assistantMessage.content, iterationContent),
            tool_calls: undefined
          })
          messages = this._withFinishTaskNudge(messages, finishNudgeCount)
          finishNudgeCount++
          continue
        }

        yield {
          type: 'done',
          message: {
            role: 'assistant',
            content: this._resolveFinalAssistantContent(assistantMessage.content, renderedContent)
          },
          thinking: fullThinking || undefined
        }
        return
      }

      // Execute tool calls — read-only tools within a group run concurrently,
      // writes and other side-effecting tools stay serial.
      messages.push({
        ...assistantMessage,
        tool_calls: regularCalls
      })
      const executions: ToolExecutionRecord[] = []

        for (const group of this._groupToolCalls(regularCalls)) {
          this._throwIfAborted(abortSignal)

          for (const toolCall of group) {
            yield { type: 'tool_start', name: toolCall.function.name }
          }

          const groupResults = group.length === 1
            ? [await this._executeToolCall(group[0], onProgress, abortSignal)]
            : await Promise.all(group.map(call => this._executeToolCall(call, onProgress, abortSignal)))

          for (const toolCall of group) {
            yield { type: 'tool_end', name: toolCall.function.name }
          }

          for (const { execution, message } of groupResults) {
            executions.push(execution)
            messages.push(message)
          }
        }
        hasExecutedTools = true
        finishNudgeCount = 0

        this._recordIterationActivity(loopGuard, executions)

        // Enhanced loop detection with SHA-256 hashing
        const loopResult = this.loopDetector.record(executions)
        if (loopResult.looping) {
          yield {
            type: 'done',
            message: {
              role: 'assistant',
              content: this._appendStopReason(renderedContent, loopResult.reason!)
            },
            thinking: fullThinking || undefined
          }
          return
        }
      }

      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: renderedContent || '本次流式响应提前结束，未返回完整结果。请继续处理，或重试一次。'
        },
        thinking: fullThinking || undefined
      }
    } finally {
      this.currentAbortSignal = undefined
    }
  }

  /** Whether a tool only reads state and can run concurrently with its peers. */
  private _isConcurrencySafeTool (name: string): boolean {
    return AgentCore.CONCURRENCY_SAFE_TOOLS.has(this._resolveToolName(name))
  }

  /**
   * Partition an assistant turn's tool calls into ordered execution groups.
   * Consecutive concurrency-safe (read-only) calls are batched so they can run
   * in parallel; every other call becomes its own single-element group so writes
   * and side-effecting tools stay strictly serial. Relative order is preserved,
   * so a read that precedes an edit still runs (and updates shared state such as
   * the read tracker) before that edit does.
   */
  private _groupToolCalls (toolCalls: ToolCall[]): ToolCall[][] {
    const groups: ToolCall[][] = []
    for (const toolCall of toolCalls) {
      const lastGroup = groups[groups.length - 1]
      const canBatch = this._isConcurrencySafeTool(toolCall.function.name) &&
        lastGroup !== undefined &&
        this._isConcurrencySafeTool(lastGroup[0].function.name)
      if (canBatch) {
        lastGroup.push(toolCall)
      } else {
        groups.push([toolCall])
      }
    }
    return groups
  }

  /**
   * Execute a single tool call end-to-end: parse arguments, run the tool, log
   * the execution, and serialize the result into a tool message. Shared by the
   * blocking and streaming loops. When an abortSignal is supplied, an abort is
   * re-thrown (normalized) instead of being captured as a tool error.
   */
  private async _executeToolCall (
    toolCall: ToolCall,
    onProgress?: ProgressCallback,
    abortSignal?: AbortSignal
  ): Promise<{ execution: ToolExecutionRecord; message: ChatMessage }> {
    const toolName = this._resolveToolName(toolCall.function.name)

    let result: unknown
    let toolArgs: Record<string, unknown> = { _raw: toolCall.function.arguments }
    try {
      toolArgs = this._parseToolArguments(toolName, toolCall.function.arguments)
      result = await this._executeTool(toolName, toolArgs, onProgress)
      this._throwIfAborted(abortSignal)
    } catch (err) {
      if (abortSignal?.aborted || (err as Error).message === USER_ABORT_MESSAGE) {
        throw normalizeAbortReason(abortSignal?.reason ?? err, USER_ABORT_MESSAGE)
      }
      result = { error: (err as Error).message }
    }

    const isError = result !== null && typeof result === 'object' && 'error' in (result as Record<string, unknown>)
    const execution: ToolExecutionRecord = { name: toolName, args: toolArgs, result }
    this.logger?.logToolExecution({
      name: toolName,
      rawArguments: toolCall.function.arguments,
      parsedArguments: toolArgs,
      result,
      status: isError ? 'failed' : 'completed',
      error: isError ? String((result as Record<string, unknown>).error) : undefined
    })

    const resultContent = await this._processToolResult(result, toolName, toolCall.id)
    const message: ChatMessage = {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: resultContent
    }
    return { execution, message }
  }

  /**
   * Execute a tool by name with given arguments.
   * Checks permissions first, then executes, then processes the result via ToolResultStorage.
   */
  async _executeTool (name: string, args: Record<string, unknown>, onProgress?: ProgressCallback): Promise<unknown> {
    const canonicalName = this._resolveToolName(name)

    if (!this._isToolVisible(canonicalName)) {
      throw new Error(`Tool not available in current agent context: ${name}`)
    }

    const tool = this.tools.get(canonicalName)
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`)
    }

    // Plan mode check — block write tools
    if (!this.planEngine.isToolAllowed(canonicalName)) {
      return { error: `当前处于规划模式，不允许执行写入操作 (${canonicalName})。请先退出规划模式。` }
    }

    // Permission check
    const permission = await this.permissionEngine.check(canonicalName, args)
    if (!permission.allowed) {
      console.log(`[Agent] Tool ${canonicalName} denied: ${permission.reason}`)
      return { error: `Permission denied: ${permission.reason}` }
    }

    console.log(`[Agent] Executing tool: ${canonicalName}`, args)
    const result = await tool.handler(args, onProgress)
    console.log(`[Agent] Tool result:`, typeof result === 'string' ? result.substring(0, 200) : result)

    return result
  }

  /**
   * Serialize and process a tool result through ToolResultStorage.
   * Large results are truncated or persisted to disk automatically.
   */
  async _processToolResult (result: unknown, toolName: string, callId: string): Promise<string> {
    const processed = await this.resultStorage.process(result, toolName, callId)
    if (processed.strategy !== 'inline') {
      console.log(`[Agent] Tool result ${processed.strategy}: ${processed.originalLength} chars → ${processed.content.length} chars`)
    }
    return processed.content
  }

  private async _compressContextIfNeeded (messages: ChatMessage[], onProgress?: ProgressCallback, abortSignal?: AbortSignal, force = false): Promise<ChatMessage[]> {
    const contextWindow = this.provider.getContextWindow()
    const warningThreshold = this._getContextCompressionThreshold(contextWindow)
    const currentTokens = this._estimateTokens(messages)

    if (!force && currentTokens < warningThreshold) {
      return messages
    }

    onProgress?.('🧠 Compressing context...', `${currentTokens}/${contextWindow}`)

    const withoutAutoContinue = this._removeSystemMessagesByPrefix(messages, AgentCore.AUTO_CONTINUE_PREFIX)
    const previousGoalAnchor = this._findSystemMessageByPrefix(withoutAutoContinue, AgentCore.CONTEXT_GOAL_ANCHOR_PREFIX)
    const sanitizedMessages = this._removeSystemMessagesByPrefix(withoutAutoContinue, AgentCore.CONTEXT_GOAL_ANCHOR_PREFIX)
    const systemMessage = sanitizedMessages[0]
    const summaryTarget = sanitizedMessages.slice(1)
    const recentSourceMessages = summaryTarget.filter(message => !this._isExistingSummaryMessage(message))

    if (!systemMessage || summaryTarget.length === 0) {
      return sanitizedMessages
    }

    let summaryContent = ''
    try {
      const summaryPrompt = this._buildContextSummaryPrompt(summaryTarget)
      const summaryResponse = await this.provider.chatCompletion(summaryPrompt, [], abortSignal, {
        timeoutMs: AgentCore.CONTEXT_COMPRESSION_TIMEOUT_MS
      })
      summaryContent = typeof summaryResponse.content === 'string' ? summaryResponse.content : ''
    } catch (error) {
      this._throwIfAborted(abortSignal)
      console.warn('[Agent] Context compression model summary failed, using deterministic fallback:', (error as Error).message)
      onProgress?.('⚠️ Context compression fallback', (error as Error).message)
      summaryContent = this._buildDeterministicContextSummary(summaryTarget)
    }
    const summaryMessage: ChatMessage = {
      role: 'system',
      content: `${AgentCore.CONTEXT_SUMMARY_PREFIX}\n${summaryContent}`
    }
    const goalAnchorMessage = this._buildContextGoalAnchorMessage(sanitizedMessages, previousGoalAnchor)
    const compressedBase = goalAnchorMessage
      ? [systemMessage, summaryMessage, goalAnchorMessage]
      : [systemMessage, summaryMessage]

    let compressed: ChatMessage[] = compressedBase

    for (const keepCount of AgentCore.RECENT_MESSAGE_KEEP_OPTIONS) {
      if (keepCount > recentSourceMessages.length) {
        continue
      }

      const recentMessages = keepCount > 0 ? this._sliceRecentMessagesForCompression(recentSourceMessages, keepCount) : []
      compressed = [...compressedBase, ...recentMessages]

      if (this._estimateTokens(compressed) <= warningThreshold || keepCount === 0) {
        onProgress?.('✅ Context compressed', `${this._estimateTokens(compressed)}/${contextWindow}`)
        return compressed
      }
    }

    onProgress?.('✅ Context compressed', `${this._estimateTokens(compressed)}/${contextWindow}`)
    return compressed
  }

  private _sliceRecentMessagesForCompression (messages: ChatMessage[], keepCount: number): ChatMessage[] {
    const candidateMessages = messages.slice(-keepCount)
    let startIndex = 0

    while (startIndex < candidateMessages.length && candidateMessages[startIndex].role === 'tool') {
      startIndex++
    }

    return candidateMessages
      .slice(startIndex)
      .map(message => this._compactRecentMessageForCompression(message))
  }

  private _buildContextSummaryPrompt (messages: ChatMessage[]): ChatMessage[] {
    const sourceMessages = this._selectMessagesForSummaryPrompt(messages)
    const serializedMessages = sourceMessages
      .map((message, index) => {
        const sections = [`#${index + 1} [${message.role}]`, this._serializeMessageContentForSummary(message.content)]

        if (message.reasoning_content) {
          sections.push(`[thinking]\n${this._truncateString(message.reasoning_content, AgentCore.CONTEXT_SUMMARY_SOURCE_MAX_CHARS)}`)
        }

        if (message.tool_calls && message.tool_calls.length > 0) {
          const toolCallLines = message.tool_calls.map(toolCall => {
            return `${toolCall.function.name}(${this._truncateString(toolCall.function.arguments, AgentCore.FINGERPRINT_MAX_STRING_CHARS)})`
          })
          sections.push(`[tool_calls]\n${toolCallLines.join('\n')}`)
        }

        return sections.filter(section => section.trim().length > 0).join('\n')
      })
      .join('\n\n')

    return [
      {
        role: 'system',
        content: `You summarize long conversations for continued execution. Produce a concise but complete plain-text summary in English, ideally within ${AgentCore.CONTEXT_SUMMARY_CHAR_LIMIT} characters. Preserve the original user goal, the latest user request, completed work, failures, key file paths, project IDs, commands, ports, and next steps. Do not replace the original goal with a recent "continue" or retry instruction.`
      },
      {
        role: 'user',
        content: `Compress the following conversation history and output plain text only:\n\n${serializedMessages}`
      }
    ]
  }

  private _selectMessagesForSummaryPrompt (messages: ChatMessage[]): ChatMessage[] {
    if (messages.length <= AgentCore.CONTEXT_SUMMARY_MAX_SOURCE_MESSAGES) {
      return messages
    }

    const keepTailCount = AgentCore.CONTEXT_SUMMARY_MAX_SOURCE_MESSAGES - 2
    const selected = new Set<ChatMessage>()
    const result: ChatMessage[] = []
    const add = (message: ChatMessage | undefined) => {
      if (!message || selected.has(message)) return
      selected.add(message)
      result.push(message)
    }

    add(messages.find(message => this._isExistingSummaryMessage(message)))
    add(messages.find(message => message.role === 'user'))

    for (const message of messages.slice(-keepTailCount)) {
      add(message)
    }

    return result
  }

  private _compactRecentMessageForCompression (message: ChatMessage): ChatMessage {
    if (message.role === 'tool') {
      return {
        role: 'assistant',
        content: [
          `[compressed tool result: ${message.tool_call_id || 'unknown call'}]`,
          this._truncateString(this._serializeMessageContentForSummary(message.content), AgentCore.CONTEXT_RECENT_TOOL_RESULT_MAX_CHARS)
        ].join('\n')
      }
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCalls = message.tool_calls
        .map(toolCall => {
          const args = this._truncateString(toolCall.function.arguments || '{}', AgentCore.CONTEXT_RECENT_TOOL_ARGUMENT_MAX_CHARS)
          return `- ${toolCall.function.name}(${args})`
        })
        .join('\n')
      const content = this._serializeMessageContentForSummary(message.content)
      const parts = [
        content ? this._truncateString(content, AgentCore.CONTEXT_RECENT_MESSAGE_MAX_CHARS) : '',
        `[compressed previous tool calls]\n${toolCalls}`
      ].filter(Boolean)
      return {
        role: message.role,
        content: parts.join('\n\n')
      }
    }

    const compacted: ChatMessage = {
      role: message.role,
      content: this._truncateString(this._serializeMessageContentForSummary(message.content), AgentCore.CONTEXT_RECENT_MESSAGE_MAX_CHARS)
    }
    if (message.reasoning_content) {
      compacted.reasoning_content = this._truncateString(message.reasoning_content, AgentCore.CONTEXT_RECENT_MESSAGE_MAX_CHARS)
    }
    return compacted
  }

  private _buildDeterministicContextSummary (messages: ChatMessage[]): string {
    const selected = this._selectMessagesForSummaryPrompt(messages)
    const lines = [
      'Deterministic fallback summary because model-based context compression failed.',
      'Preserve the explicit CONTEXT_GOAL_ANCHOR if present; continue the same task without restarting.'
    ]

    for (const message of selected) {
      const content = this._serializeMessageContentForSummary(message.content)
      const toolCalls = message.tool_calls?.map(toolCall => toolCall.function.name).join(', ')
      lines.push([
        `[${message.role}]`,
        content,
        toolCalls ? `[tool calls: ${toolCalls}]` : ''
      ].filter(Boolean).join('\n'))
    }

    return this._truncateString(lines.join('\n\n'), AgentCore.CONTEXT_SUMMARY_CHAR_LIMIT * 2)
  }

  private _estimateTokens (messages: ChatMessage[]): number {
    return messages.reduce((total, message) => {
      const content = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content)
      const toolCalls = message.tool_calls
        ?.map(toolCall => `${toolCall.id}:${toolCall.function.name}:${toolCall.function.arguments}`)
        .join('\n') || ''
      const estimatedContent = [
        message.role,
        content,
        message.tool_call_id || '',
        message.reasoning_content || '',
        toolCalls
      ].filter(Boolean).join('\n')
      return total + Math.ceil(estimatedContent.length / AgentCore.ESTIMATED_CHARS_PER_TOKEN) + AgentCore.ESTIMATED_MESSAGE_OVERHEAD_TOKENS
    }, 0)
  }

  private _isExistingSummaryMessage (message: ChatMessage): boolean {
    return message.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.startsWith(AgentCore.CONTEXT_SUMMARY_PREFIX)
  }

  private async _sleep (ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  private _throwIfAborted (abortSignal?: AbortSignal): void {
    if (!abortSignal?.aborted) return
    throw normalizeAbortReason(abortSignal.reason, USER_ABORT_MESSAGE)
  }
}
