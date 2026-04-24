import { getSystemPrompt } from './prompts/system-prompt.js'
import type { OpenAIProvider, ToolDefinition, ChatMessage } from '../providers/openai-provider.js'
import { normalizeAbortReason, USER_ABORT_MESSAGE } from '../abort-utils.js'
import type { AIExecutionAuthMode } from '../../settings/settings-store.js'
import type { AILogSessionLogger } from '../../settings/ai-log-store.js'
import { PermissionEngine, type PermissionRule, type PermissionContext } from './permissions/permission-engine.js'
import { ToolResultStorage } from './tool-result-storage.js'
import { PlanEngine, type Plan } from './plan-mode.js'
import { LoopDetector } from './loop-detector.js'
import { SkillEngine } from './skill-engine.js'
import { CostTracker, type ApiUsage } from '../cost-tracker.js'

export type ProgressEvent =
  | { type: 'progress'; stage: string; detail?: string }
  | { type: 'todo_update'; items: Array<{ id: number; title: string; status: 'not-started' | 'in-progress' | 'completed' }> }
  | { type: 'file_preview_start'; filePath: string; truncated?: boolean }
  | { type: 'file_preview_chunk'; filePath: string; content: string }
  | { type: 'file_preview_end'; filePath: string; truncated?: boolean }
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
  | { type: 'file_preview_start'; filePath: string; truncated?: boolean }
  | { type: 'file_preview_chunk'; filePath: string; content: string }
  | { type: 'file_preview_end'; filePath: string; truncated?: boolean }
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
  /** Authorization mode for local sensitive actions in this conversation. */
  authMode: AIExecutionAuthMode
}

export class AgentCore {
  // Keep summaries short enough to fit comfortably back into the prompt.
  private static readonly AUTO_CONTINUE_PREFIX = '[AUTO_CONTINUE]'
  private static readonly CONTEXT_SUMMARY_PREFIX = '[CONTEXT_SUMMARY]'
  private static readonly CONTEXT_SUMMARY_CHAR_LIMIT = 1500
  private static readonly CONTEXT_SUMMARY_SOURCE_MAX_CHARS = 4000
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

    // Wire cost tracking into provider usage callback
    this.provider.setOnUsage((usage) => {
      this.costTracker.record(this.provider.getModel(), usage)
    })
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
    this.allowedToolNames = new Set((allowedToolNames || []).map(name => name.trim()).filter(Boolean))
    this.deniedToolNames = new Set((deniedToolNames || []).map(name => name.trim()).filter(Boolean))
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
    return Array.from(this.tools.entries())
      .filter(([name]) => this._isToolVisible(name))
      .map(([, tool]) => tool.definition)
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
      authMode: this.getEffectiveAuthMode()
    }
    this.planEngine.reset()
    this.loopDetector.reset()
    this.costTracker.reset()
  }

  private _isToolVisible (name: string): boolean {
    if (this.allowedToolNames.size > 0 && !this.allowedToolNames.has(name)) {
      return false
    }

    return !this.deniedToolNames.has(name)
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
    const systemMessage: ChatMessage = {
      role: 'system',
      content: getSystemPrompt({
        skillContents: this.activeSkillContents.length > 0 ? this.activeSkillContents : undefined,
        targetProjectId: this.sessionState.targetProjectId,
        systemPromptSections: this.systemPromptSections
      })
    }

    try {
      let messages: ChatMessage[] = [systemMessage, ...userMessages]
      const toolDefs = this.getToolDefinitions()
      const loopGuard = this._createLoopGuardState()
      let segmentIterations = 0

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

        if (!response.tool_calls || response.tool_calls.length === 0) {
          return {
            role: 'assistant',
            content: response.content || ''
          }
        }

        messages.push(response)
        const executions: ToolExecutionRecord[] = []

        for (const toolCall of response.tool_calls) {
          const toolName = toolCall.function.name

          let result: unknown
          let toolArgs: Record<string, unknown> = { _raw: toolCall.function.arguments }
          try {
            toolArgs = this._parseToolArguments(toolName, toolCall.function.arguments)
            result = await this._executeTool(toolName, toolArgs)
          } catch (err) {
            result = { error: (err as Error).message }
          }

          executions.push({ name: toolName, args: toolArgs, result })
          this.logger?.logToolExecution({
            name: toolName,
            rawArguments: toolCall.function.arguments,
            parsedArguments: toolArgs,
            result,
            status: result && typeof result === 'object' && 'error' in (result as Record<string, unknown>) ? 'failed' : 'completed',
            error: result && typeof result === 'object' && 'error' in (result as Record<string, unknown>) ? String((result as Record<string, unknown>).error) : undefined
          })

          // Process result through ToolResultStorage (handles large outputs)
          const resultContent = await this._processToolResult(result, toolName, toolCall.id)
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: resultContent
          })
        }

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
    const systemMessage: ChatMessage = {
      role: 'system',
      content: getSystemPrompt({
        skillContents: this.activeSkillContents.length > 0 ? this.activeSkillContents : undefined,
        targetProjectId: this.sessionState.targetProjectId,
        systemPromptSections: this.systemPromptSections
      })
    }

    try {
      let messages: ChatMessage[] = [systemMessage, ...userMessages]
      const toolDefs = this.getToolDefinitions()
      const loopGuard = this._createLoopGuardState()
      let segmentIterations = 0
      let renderedContent = ''
      let fullThinking = ''

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
        messages = await this._compressContextIfNeeded(messages, forceCompression ? undefined : onProgress, abortSignal, forceCompression)
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

      // No tool calls → final response
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
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

      // Execute tool calls
      messages.push(assistantMessage)
      const executions: ToolExecutionRecord[] = []

        for (const toolCall of assistantMessage.tool_calls) {
          const toolName = toolCall.function.name
          this._throwIfAborted(abortSignal)

          yield { type: 'tool_start', name: toolName }

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

          executions.push({ name: toolName, args: toolArgs, result })
          this.logger?.logToolExecution({
            name: toolName,
            rawArguments: toolCall.function.arguments,
            parsedArguments: toolArgs,
            result,
            status: result && typeof result === 'object' && 'error' in (result as Record<string, unknown>) ? 'failed' : 'completed',
            error: result && typeof result === 'object' && 'error' in (result as Record<string, unknown>) ? String((result as Record<string, unknown>).error) : undefined
          })

          yield { type: 'tool_end', name: toolName }

          // Process result through ToolResultStorage (handles large outputs)
          const resultContent = await this._processToolResult(result, toolName, toolCall.id)
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: resultContent
          })
        }

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

  /**
   * Execute a tool by name with given arguments.
   * Checks permissions first, then executes, then processes the result via ToolResultStorage.
   */
  async _executeTool (name: string, args: Record<string, unknown>, onProgress?: ProgressCallback): Promise<unknown> {
    if (!this._isToolVisible(name)) {
      throw new Error(`Tool not available in current agent context: ${name}`)
    }

    const tool = this.tools.get(name)
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`)
    }

    // Plan mode check — block write tools
    if (!this.planEngine.isToolAllowed(name)) {
      return { error: `当前处于规划模式，不允许执行写入操作 (${name})。请先退出规划模式。` }
    }

    // Permission check
    const permission = await this.permissionEngine.check(name, args)
    if (!permission.allowed) {
      console.log(`[Agent] Tool ${name} denied: ${permission.reason}`)
      return { error: `Permission denied: ${permission.reason}` }
    }

    console.log(`[Agent] Executing tool: ${name}`, args)
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

    const sanitizedMessages = this._removeSystemMessagesByPrefix(messages, AgentCore.AUTO_CONTINUE_PREFIX)
    const systemMessage = sanitizedMessages[0]
    const existingSummaryIndex = sanitizedMessages.findIndex((message, index) => {
      return index > 0 && this._isExistingSummaryMessage(message)
    })
    const summaryStartIndex = existingSummaryIndex >= 0 ? existingSummaryIndex + 1 : 1
    const summaryTarget = sanitizedMessages.slice(summaryStartIndex)

    if (!systemMessage || summaryTarget.length === 0) {
      return sanitizedMessages
    }

    const summaryPrompt = this._buildContextSummaryPrompt(summaryTarget)
    const summaryResponse = await this.provider.chatCompletion(summaryPrompt, [], abortSignal, {
      timeoutMs: AgentCore.CONTEXT_COMPRESSION_TIMEOUT_MS
    })
    const summaryMessage: ChatMessage = {
      role: 'system',
      content: `${AgentCore.CONTEXT_SUMMARY_PREFIX}\n${typeof summaryResponse.content === 'string' ? summaryResponse.content : ''}`
    }

    let compressed: ChatMessage[] = [systemMessage, summaryMessage]

    for (const keepCount of AgentCore.RECENT_MESSAGE_KEEP_OPTIONS) {
      if (keepCount > summaryTarget.length) {
        continue
      }

      const recentMessages = keepCount > 0 ? summaryTarget.slice(-keepCount) : []
      compressed = [systemMessage, summaryMessage, ...recentMessages]

      if (this._estimateTokens(compressed) <= warningThreshold || keepCount === 0) {
        onProgress?.('✅ Context compressed', `${this._estimateTokens(compressed)}/${contextWindow}`)
        return compressed
      }
    }

    onProgress?.('✅ Context compressed', `${this._estimateTokens(compressed)}/${contextWindow}`)
    return compressed
  }

  private _buildContextSummaryPrompt (messages: ChatMessage[]): ChatMessage[] {
    const serializedMessages = messages
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
        content: `You summarize long conversations for continued execution. Produce a concise but complete plain-text summary in English, ideally within ${AgentCore.CONTEXT_SUMMARY_CHAR_LIMIT} characters. Preserve the goal, completed work, failures, key file paths, project IDs, commands, ports, and next steps.`
      },
      {
        role: 'user',
        content: `Compress the following conversation history and output plain text only:\n\n${serializedMessages}`
      }
    ]
  }

  private _estimateTokens (messages: ChatMessage[]): number {
    return messages.reduce((total, message) => {
      const content = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content)
      return total + Math.ceil(content.length / AgentCore.ESTIMATED_CHARS_PER_TOKEN) + AgentCore.ESTIMATED_MESSAGE_OVERHEAD_TOKENS
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
