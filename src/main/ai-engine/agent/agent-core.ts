import { getSystemPrompt } from './prompts/system-prompt.js'
import type { OpenAIProvider, ToolDefinition, ChatMessage } from '../providers/openai-provider.js'

export type ProgressCallback = (stage: string, detail?: string) => void

export type StreamEvent =
  | { type: 'token'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string; result: unknown }
  | { type: 'progress'; stage: string; detail?: string }
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
export class AgentCore {
  private provider: OpenAIProvider
  private services: Record<string, unknown>
  private tools = new Map<string, RegisteredTool>()
  private maxIterations = 16
  private maxStreamRetries = 3
  private activeSkillContents: string[] = []

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
  async run (userMessages: ChatMessage[]): Promise<ChatMessage> {
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
        const toolArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>

        let result: unknown
        try {
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
  async * runStream (userMessages: ChatMessage[], onProgress?: ProgressCallback): AsyncGenerator<StreamEvent> {
    const systemMessage: ChatMessage = {
      role: 'system',
      content: getSystemPrompt(this.activeSkillContents.length > 0 ? this.activeSkillContents : undefined)
    }

    let messages: ChatMessage[] = [systemMessage, ...userMessages]
    const toolDefs = this.getToolDefinitions()
    let iterations = 0
    let fullThinking = ''
    let lastAssistantContent = ''

    while (iterations < this.maxIterations) {
      iterations++
      messages = await this._compressContextIfNeeded(messages, onProgress)

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
            onProgress?.('🔄 AI 连接中断，正在重试...', `第 ${attempt} 次尝试`)
            yield { type: 'reset' }
            await this._sleep(Math.min(1000 * (2 ** (attempt - 1)), 5000))
          }

          for await (const event of this.provider.chatCompletionStream(messages, toolDefs)) {
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
      lastAssistantContent = iterationContent

      if (!assistantMessage) break

      // No tool calls → final response
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        yield {
          type: 'done',
          message: { role: 'assistant', content: iterationContent },
          thinking: fullThinking || undefined
        }
        return
      }

      // Execute tool calls
      messages.push(assistantMessage)

      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name
        const toolArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>

        yield { type: 'tool_start', name: toolName }

        let result: unknown
        try {
          result = await this._executeTool(toolName, toolArgs, onProgress)
        } catch (err) {
          result = { error: (err as Error).message }
        }

        yield { type: 'tool_end', name: toolName, result }

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
        content: lastAssistantContent || '我已经尝试了多个步骤但还没有得到最终结果。请告诉我还需要什么帮助。'
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

  private async _compressContextIfNeeded (messages: ChatMessage[], onProgress?: ProgressCallback): Promise<ChatMessage[]> {
    const contextWindow = this.provider.getContextWindow()
    const warningThreshold = Math.floor(contextWindow * 0.85)
    const currentTokens = this._estimateTokens(messages)

    if (currentTokens < warningThreshold || messages.length <= 8) {
      return messages
    }

    onProgress?.('🧠 正在压缩上下文...', `${currentTokens}/${contextWindow}`)

    const systemMessage = messages[0]
    const existingSummaryIndex = messages.findIndex((message, index) => index > 0 && typeof message.content === 'string' && message.role === 'system' && message.content.startsWith('[CONTEXT_SUMMARY]'))
    const summaryOffset = existingSummaryIndex >= 0 ? 1 : 0
    const keepCount = 6
    const recentMessages = messages.slice(Math.max(1 + summaryOffset, messages.length - keepCount))
    const summaryTarget = messages.slice(1 + summaryOffset, Math.max(1 + summaryOffset, messages.length - keepCount))

    if (summaryTarget.length === 0) {
      return messages
    }

    const summaryPrompt = this._buildContextSummaryPrompt(summaryTarget)
    const summaryResponse = await this.provider.chatCompletion(summaryPrompt)
    const summaryMessage: ChatMessage = {
      role: 'system',
      content: `[CONTEXT_SUMMARY]\n${typeof summaryResponse.content === 'string' ? summaryResponse.content : ''}`
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
        content: '你是上下文压缩助手。请把对话压缩成简洁但完整的中文摘要，长度尽量控制在 1500 字以内，保留需求、已完成工作、失败原因、关键文件路径、项目ID、命令、端口、下一步待办，避免丢失会影响继续任务的信息。'
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
      return total + Math.ceil(content.length / 4) + 12
    }, 0)
  }

  private async _sleep (ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms))
  }
}
