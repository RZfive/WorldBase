import { getSystemPrompt } from './prompts/system-prompt.js'
import type { OpenAIProvider, ToolDefinition, ChatMessage } from '../providers/openai-provider.js'

export type ProgressCallback = (stage: string, detail?: string) => void

export type StreamEvent =
  | { type: 'token'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string; result: unknown }
  | { type: 'progress'; stage: string; detail?: string }
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
  private maxIterations = 10
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

    const messages: ChatMessage[] = [systemMessage, ...userMessages]
    const toolDefs = this.getToolDefinitions()

    let iterations = 0

    while (iterations < this.maxIterations) {
      iterations++

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

    const messages: ChatMessage[] = [systemMessage, ...userMessages]
    const toolDefs = this.getToolDefinitions()
    let iterations = 0
    let fullContent = ''
    let fullThinking = ''

    while (iterations < this.maxIterations) {
      iterations++

      let assistantMessage: ChatMessage | null = null

      for await (const event of this.provider.chatCompletionStream(messages, toolDefs)) {
        if (event.type === 'thinking') {
          fullThinking += event.content
          yield { type: 'thinking', content: event.content }
        } else if (event.type === 'token') {
          fullContent += event.content
          yield { type: 'token', content: event.content }
        } else if (event.type === 'tool_calls') {
          assistantMessage = event.message
        } else if (event.type === 'done') {
          if (!assistantMessage) {
            assistantMessage = event.message
          }
        }
      }

      if (!assistantMessage) break

      // No tool calls → final response
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        yield {
          type: 'done',
          message: { role: 'assistant', content: fullContent },
          thinking: fullThinking || undefined
        }
        return
      }

      // Execute tool calls
      messages.push(assistantMessage)
      fullContent = '' // reset for next iteration

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
        content: fullContent || '我已经尝试了多个步骤但还没有得到最终结果。请告诉我还需要什么帮助。'
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
}
