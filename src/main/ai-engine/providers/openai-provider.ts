export interface ChatMessage {
  role: string
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  tool_calls?: ToolCall[]
  tool_call_id?: string
  reasoning_content?: string
}

export interface ToolCall {
  id: string
  function: {
    name: string
    arguments: string
  }
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

interface ChatCompletionBody {
  model: string
  messages: ChatMessage[]
  temperature?: number
  stream?: boolean
  tools?: { type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }[]
  tool_choice?: string
}

interface StreamDelta {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>
}

/**
 * OpenAIProvider — OpenAI 兼容 API 提供者
 * 支持 OpenAI, Azure OpenAI, 以及任何兼容 API
 */
export class OpenAIProvider {
  private apiKey: string
  private baseUrl: string
  private model: string
  private enableThinking: boolean
  private contextWindow: number

  constructor () {
    this.apiKey = process.env.OPENAI_API_KEY || ''
    this.baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    this.model = process.env.OPENAI_MODEL || 'gpt-4o'
    this.enableThinking = false
    this.contextWindow = 32000
  }

  setApiKey (key: string): void {
    this.apiKey = key
  }

  setBaseUrl (url: string): void {
    this.baseUrl = url
  }

  setModel (model: string): void {
    this.model = model
  }

  getModel (): string {
    return this.model
  }

  setContextWindow (contextWindow: number): void {
    if (Number.isFinite(contextWindow) && contextWindow > 0) {
      this.contextWindow = Math.floor(contextWindow)
    }
  }

  getContextWindow (): number {
    return this.contextWindow
  }

  setEnableThinking (enable: boolean): void {
    this.enableThinking = enable
  }

  /**
   * Make a chat completion request with function calling support.
   */
  async chatCompletion (messages: ChatMessage[], tools: ToolDefinition[] = []): Promise<ChatMessage> {
    const body: ChatCompletionBody = {
      model: this.model,
      messages,
      temperature: 0.7
    }

    if (tools.length > 0) {
      body.tools = tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }))
      body.tool_choice = 'auto'
    }

    const response = await this.fetchWithRetry(body, false)

    const data = await response.json() as { choices: { message: ChatMessage }[] }
    return data.choices[0].message
  }

  /**
   * Streaming chat completion. Yields content tokens as they arrive.
   * When tool_calls are present in the stream, they are accumulated
   * and returned as a complete ChatMessage at the end.
   * Supports reasoning_content (thinking) from compatible models.
   */
  async * chatCompletionStream (
    messages: ChatMessage[],
    tools: ToolDefinition[] = []
  ): AsyncGenerator<
    | { type: 'token'; content: string }
    | { type: 'thinking'; content: string }
    | { type: 'tool_calls'; message: ChatMessage }
    | { type: 'done'; message: ChatMessage }
  > {
    const body: ChatCompletionBody = {
      model: this.model,
      messages,
      temperature: 0.7,
      stream: true
    }

    if (tools.length > 0) {
      body.tools = tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }))
      body.tool_choice = 'auto'
    }

    const response = await this.fetchWithRetry(body, true)

    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''
    let fullContent = ''
    let fullReasoning = ''
    const toolCallsMap = new Map<number, { id: string; function: { name: string; arguments: string } }>()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const jsonStr = trimmed.slice(6)
          if (jsonStr === '[DONE]') continue

          let parsed: { choices: Array<{ delta: StreamDelta; finish_reason?: string | null }> }
          try {
            parsed = JSON.parse(jsonStr)
          } catch {
            continue
          }

          const delta = parsed.choices?.[0]?.delta
          if (!delta) continue

          // Handle reasoning_content (thinking) from compatible models
          if (delta.reasoning_content) {
            fullReasoning += delta.reasoning_content
            yield { type: 'thinking', content: delta.reasoning_content }
          }

          if (delta.content) {
            fullContent += delta.content
            yield { type: 'token', content: delta.content }
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!toolCallsMap.has(tc.index)) {
                toolCallsMap.set(tc.index, {
                  id: tc.id || '',
                  function: { name: '', arguments: '' }
                })
              }
              const existing = toolCallsMap.get(tc.index)!
              if (tc.id) existing.id = tc.id
              if (tc.function?.name) existing.function.name += tc.function.name
              if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    const message: ChatMessage = {
      role: 'assistant',
      content: fullContent || ''
    }

    if (fullReasoning) {
      message.reasoning_content = fullReasoning
    }

    if (toolCallsMap.size > 0) {
      message.tool_calls = Array.from(toolCallsMap.values())
      yield { type: 'tool_calls', message }
    }

    yield { type: 'done', message }
  }

  private async fetchWithRetry (body: ChatCompletionBody, stream: boolean): Promise<Response> {
    const maxAttempts = 3
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), stream ? 90000 : 60000)

      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        })

        if (response.ok) {
          clearTimeout(timeout)
          return response
        }

        const errorText = await response.text()
        const error = new Error(`OpenAI API error (${response.status}): ${errorText}`)
        clearTimeout(timeout)

        if (!this.isRetryableStatus(response.status) || attempt === maxAttempts) {
          throw error
        }

        lastError = error
      } catch (err) {
        clearTimeout(timeout)
        const normalized = this.normalizeRequestError(err)
        if (!this.isRetryableError(normalized) || attempt === maxAttempts) {
          throw normalized
        }
        lastError = normalized
      }

      await this.delay(Math.min(1000 * (2 ** (attempt - 1)), 5000))
    }

    throw lastError || new Error('AI request failed')
  }

  private isRetryableStatus (status: number): boolean {
    return status === 408 || status === 429 || (status >= 500 && status <= 504)
  }

  private isRetryableError (error: Error): boolean {
    const message = error.message.toLowerCase()
    return message.includes('terminated') ||
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('network') ||
      message.includes('fetch failed') ||
      message.includes('socket hang up') ||
      message.includes('econnreset') ||
      message.includes('eai_again') ||
      message.includes('aborted') ||
      message.includes('unexpected end of json input')
  }

  private normalizeRequestError (error: unknown): Error {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return new Error('AI request timed out')
      }
      return error
    }
    return new Error(String(error))
  }

  private async delay (ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms))
  }
}
