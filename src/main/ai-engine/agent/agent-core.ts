import { getSystemPrompt } from './prompts/system-prompt.js'
import type { OpenAIProvider, ToolDefinition, ChatMessage } from '../providers/openai-provider.js'

export type ProgressEvent =
  | { type: 'progress'; stage: string; detail?: string }
  | { type: 'file_preview_start'; filePath: string; truncated?: boolean }
  | { type: 'file_preview_chunk'; filePath: string; content: string }
  | { type: 'file_preview_end'; filePath: string; truncated?: boolean }

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
  | { type: 'file_preview_start'; filePath: string; truncated?: boolean }
  | { type: 'file_preview_chunk'; filePath: string; content: string }
  | { type: 'file_preview_end'; filePath: string; truncated?: boolean }
  | { type: 'reset' }
  | { type: 'done'; message: ChatMessage; thinking?: string }
  | { type: 'error'; error: string }

interface RegisteredTool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
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
}

export class AgentCore {
  // Keep summaries short enough to fit comfortably back into the prompt.
  private static readonly CONTEXT_SUMMARY_PREFIX = '[CONTEXT_SUMMARY]'
  private static readonly CONTEXT_SUMMARY_CHAR_LIMIT = 1500
  // Lightweight heuristic for providers without tokenizer access.
  private static readonly ESTIMATED_CHARS_PER_TOKEN = 4
  private static readonly ESTIMATED_MESSAGE_OVERHEAD_TOKENS = 12
  private provider: OpenAIProvider
  private services: Record<string, unknown>
  private tools = new Map<string, RegisteredTool>()
  // Allow a few extra repair attempts after create/edit/start tool loops.
  private maxIterations = 16
  private maxStreamRetries = 3
  private activeSkillContents: string[] = []
  /** Shared mutable state accessible by tool handlers within a session. */
  public sessionState: SessionState = { createdProjectId: null, targetProjectId: null }

  constructor (provider: OpenAIProvider, services: Record<string, unknown>) {
    this.provider = provider
    this.services = services
  }

  /** Set skill contents to inject into the system prompt. */
  setActiveSkills (contents: string[]): void {
    this.activeSkillContents = contents
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
    return Array.from(this.tools.values()).map(t => t.definition)
  }

  /**
   * Run the agent loop with the given messages (non-streaming, kept for compat).
   */
  /** Set a target project ID for the current session (edit/optimize mode). */
  setTargetProjectId (projectId: string | null): void {
    this.sessionState.targetProjectId = projectId
  }

  private _resetSessionState (): void {
    this.sessionState = {
      createdProjectId: null,
      targetProjectId: this.sessionState.targetProjectId
    }
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

  async run (userMessages: ChatMessage[]): Promise<ChatMessage> {
    this._resetSessionState()
    const systemMessage: ChatMessage = {
      role: 'system',
      content: getSystemPrompt(this.activeSkillContents.length > 0 ? this.activeSkillContents : undefined)
    }

    let messages: ChatMessage[] = [systemMessage, ...userMessages]
    const toolDefs = this.getToolDefinitions()

    let iterations = 0

    while (iterations < this.maxIterations) {
      iterations++
      messages = await this._compressContextIfNeeded(messages)

      const response = await this.provider.chatCompletion(messages, toolDefs)

      if (!response.tool_calls || response.tool_calls.length === 0) {
        return {
          role: 'assistant',
          content: response.content || ''
        }
      }

      messages.push(response)

      for (const toolCall of response.tool_calls) {
        const toolName = toolCall.function.name

        let result: unknown
        try {
          const toolArgs = this._parseToolArguments(toolName, toolCall.function.arguments)
          result = await this._executeTool(toolName, toolArgs)
        } catch (err) {
          result = { error: (err as Error).message }
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        })
      }
    }

    return {
      role: 'assistant',
      content: '我已经尝试了多个步骤但还没有得到最终结果。请告诉我还需要什么帮助。'
    }
  }

  /**
   * Run the agent loop in streaming mode.
   * Yields tokens in real-time and tool execution events.
   */
  async * runStream (userMessages: ChatMessage[], onProgress?: ProgressCallback, abortSignal?: AbortSignal): AsyncGenerator<StreamEvent> {
    this._resetSessionState()
    const systemMessage: ChatMessage = {
      role: 'system',
      content: getSystemPrompt(this.activeSkillContents.length > 0 ? this.activeSkillContents : undefined)
    }

    let messages: ChatMessage[] = [systemMessage, ...userMessages]
    const toolDefs = this.getToolDefinitions()
    let iterations = 0
    let renderedContent = ''
    let fullThinking = ''

    while (iterations < this.maxIterations) {
      this._throwIfAborted(abortSignal)
      iterations++
      messages = await this._compressContextIfNeeded(messages, onProgress, abortSignal)

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

      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name
        this._throwIfAborted(abortSignal)

        yield { type: 'tool_start', name: toolName }

        let result: unknown
        try {
          const toolArgs = this._parseToolArguments(toolName, toolCall.function.arguments)
          result = await this._executeTool(toolName, toolArgs, onProgress)
          this._throwIfAborted(abortSignal)
        } catch (err) {
          result = { error: (err as Error).message }
        }

        yield { type: 'tool_end', name: toolName }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        })
      }
    }

    yield {
      type: 'done',
      message: {
        role: 'assistant',
        content: renderedContent || '我已经尝试了多个步骤但还没有得到最终结果。请告诉我还需要什么帮助。'
      },
      thinking: fullThinking || undefined
    }
  }

  /**
   * Execute a tool by name with given arguments.
   */
  async _executeTool (name: string, args: Record<string, unknown>, onProgress?: ProgressCallback): Promise<unknown> {
    const tool = this.tools.get(name)
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`)
    }

    console.log(`[Agent] Executing tool: ${name}`, args)
    const result = await tool.handler(args, onProgress)
    console.log(`[Agent] Tool result:`, typeof result === 'string' ? result.substring(0, 200) : result)

    return result
  }

  private async _compressContextIfNeeded (messages: ChatMessage[], onProgress?: ProgressCallback, abortSignal?: AbortSignal): Promise<ChatMessage[]> {
    const contextWindow = this.provider.getContextWindow()
    const warningThreshold = Math.floor(contextWindow * 0.85)
    const currentTokens = this._estimateTokens(messages)

    if (currentTokens < warningThreshold || messages.length <= 8) {
      return messages
    }

    onProgress?.('🧠 正在压缩上下文...', `${currentTokens}/${contextWindow}`)

    const systemMessage = messages[0]
    const existingSummaryIndex = messages.findIndex((message, index) => {
      return index > 0 && this._isExistingSummaryMessage(message)
    })
    const summaryOffset = existingSummaryIndex >= 0 ? 1 : 0
    const keepCount = 6
    const recentMessages = messages.slice(Math.max(1 + summaryOffset, messages.length - keepCount))
    const summaryTarget = messages.slice(1 + summaryOffset, Math.max(1 + summaryOffset, messages.length - keepCount))

    if (summaryTarget.length === 0) {
      return messages
    }

    const summaryPrompt = this._buildContextSummaryPrompt(summaryTarget)
    const summaryResponse = await this.provider.chatCompletion(summaryPrompt, [], abortSignal)
    const summaryMessage: ChatMessage = {
      role: 'system',
      content: `${AgentCore.CONTEXT_SUMMARY_PREFIX}\n${typeof summaryResponse.content === 'string' ? summaryResponse.content : ''}`
    }

    const compressed = [systemMessage, summaryMessage, ...recentMessages]
    onProgress?.('✅ 上下文已压缩', `${this._estimateTokens(compressed)}/${contextWindow}`)
    return compressed
  }

  private _buildContextSummaryPrompt (messages: ChatMessage[]): ChatMessage[] {
    const serializedMessages = messages
      .map((message, index) => {
        const content = typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content)
        return `#${index + 1} [${message.role}]\n${content}`
      })
      .join('\n\n')

    return [
      {
        role: 'system',
        content: `你是上下文压缩助手。请把对话压缩成简洁但完整的中文摘要，长度尽量控制在 ${AgentCore.CONTEXT_SUMMARY_CHAR_LIMIT} 字以内，保留需求、已完成工作、失败原因、关键文件路径、项目ID、命令、端口、下一步待办，避免丢失会影响继续任务的信息。`
      },
      {
        role: 'user',
        content: `请压缩以下历史上下文，输出纯文本摘要：\n\n${serializedMessages}`
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
    if (abortSignal.reason instanceof Error) {
      throw abortSignal.reason
    }
    if (typeof abortSignal.reason === 'string' && abortSignal.reason.trim().length > 0) {
      throw new Error(abortSignal.reason)
    }
    throw new Error('AI generation stopped by user')
  }
}
