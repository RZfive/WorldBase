export interface ChatContentTextPart {
  type: 'text'
  text: string
}

export interface ChatContentImagePart {
  type: 'image_url'
  image_url: { url: string }
}

export type ChatContentPart = ChatContentTextPart | ChatContentImagePart
export type MessageContent = string | ChatContentPart[]

export interface ChatMessage {
  role: string
  content: MessageContent
  tool_calls?: ToolCall[]
  tool_call_id?: string
  reasoning_content?: string
}

export interface ToolCall {
  id: string
  type: 'function'
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
  modalities?: string[]
  tools?: { type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }[]
  tool_choice?: string
}

interface MultiModalContentPart {
  text?: string
  inline_data?: {
    data: string
    mime_type?: string
  }
}

interface ApiChatMessage {
  role?: string
  content?: MessageContent | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  reasoning_content?: string
  multi_mod_content?: MultiModalContentPart[]
}

interface StreamDelta {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    type?: string
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

  private isImageOutputModel (): boolean {
    const normalized = this.model.toLowerCase()
    return normalized.includes('image-preview') ||
      normalized.includes('gpt-image') ||
      normalized.includes('imagen') ||
      normalized.includes('-image') ||
      normalized.includes('image-') ||
      normalized.includes('flux')
  }

  private buildRequestBody (messages: ChatMessage[], tools: ToolDefinition[], stream: boolean): ChatCompletionBody {
    const body: ChatCompletionBody = {
      model: this.model,
      messages: this.normalizeOutgoingMessages(messages),
      temperature: 0.7,
      stream
    }

    if (this.isImageOutputModel()) {
      body.stream = false
      body.modalities = ['text', 'image']
      return body
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

    return body
  }

  private normalizeMessageContent (message: ApiChatMessage): MessageContent {
    const multiModalContent = this.normalizeMultiModalContent(message.multi_mod_content)
    if (multiModalContent !== null) {
      return multiModalContent
    }

    if (Array.isArray(message.content)) {
      return message.content
    }

    return typeof message.content === 'string' ? message.content : ''
  }

  private normalizeMultiModalContent (parts?: MultiModalContentPart[]): MessageContent | null {
    if (!Array.isArray(parts) || parts.length === 0) {
      return null
    }

    const normalizedParts: ChatContentPart[] = []
    let hasImage = false

    for (const part of parts) {
      if (typeof part.text === 'string' && part.text.length > 0) {
        normalizedParts.push({
          type: 'text',
          text: part.text
        })
      }

      if (part.inline_data?.data) {
        hasImage = true
        const mimeType = part.inline_data.mime_type?.trim() || 'image/png'
        normalizedParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${mimeType};base64,${part.inline_data.data}`
          }
        })
      }
    }

    if (normalizedParts.length === 0) {
      return ''
    }

    if (!hasImage && normalizedParts.every(part => part.type === 'text')) {
      return normalizedParts
        .map(part => part.type === 'text' ? part.text : '')
        .join('')
    }

    return normalizedParts
  }

  private normalizeAssistantMessage (message: ApiChatMessage): ChatMessage {
    return {
      role: message.role || 'assistant',
      content: this.normalizeMessageContent(message),
      tool_calls: this.normalizeToolCalls(message.tool_calls),
      tool_call_id: message.tool_call_id,
      reasoning_content: message.reasoning_content
    }
  }

  private normalizeToolCalls (toolCalls?: ToolCall[]): ToolCall[] | undefined {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return undefined
    }

    return toolCalls.map(toolCall => ({
      id: toolCall.id || '',
      type: 'function',
      function: {
        name: toolCall.function?.name || '',
        arguments: toolCall.function?.arguments || ''
      }
    }))
  }

  private normalizeOutgoingMessages (messages: ChatMessage[]): ChatMessage[] {
    return messages.map(message => {
      if (!message.tool_calls || message.tool_calls.length === 0) {
        return message
      }

      return {
        ...message,
        tool_calls: this.normalizeToolCalls(message.tool_calls)
      }
    })
  }

  private normalizeBaseUrl (url: string): string {
    const trimmed = url.trim()
    if (!trimmed) return ''
    return trimmed.replace(/\/+$/, '')
  }

  private getChatCompletionUrl (): string {
    const normalized = this.normalizeBaseUrl(this.baseUrl)
    if (normalized.endsWith('/chat/completions')) {
      return normalized
    }
    return `${normalized}/chat/completions`
  }

  private validateConfig (): void {
    if (!this.apiKey.trim()) {
      throw new Error('当前供应商未配置 API Key')
    }
    if (!this.baseUrl.trim()) {
      throw new Error('当前供应商未配置 API 地址')
    }
    if (!this.model.trim()) {
      throw new Error('当前供应商未选择模型')
    }
  }

  setApiKey (key: string): void {
    this.apiKey = key
  }

  setBaseUrl (url: string): void {
    this.baseUrl = this.normalizeBaseUrl(url)
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
    const body = this.buildRequestBody(messages, tools, false)

    const response = await this.fetchWithRetry(body, false)

    const data = await response.json() as { choices: Array<{ message: ApiChatMessage }> }
    return this.normalizeAssistantMessage(data.choices[0].message)
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
    const body = this.buildRequestBody(messages, tools, true)

    if (this.isImageOutputModel()) {
      const response = await this.fetchWithRetry(body, false)
      const data = await response.json() as { choices: Array<{ message: ApiChatMessage }> }
      const message = this.normalizeAssistantMessage(data.choices[0].message)
      yield { type: 'done', message }
      return
    }

    const response = await this.fetchWithRetry(body, true)

    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''
    let fullContent = ''
    let fullReasoning = ''
    const toolCallsMap = new Map<number, ToolCall>()

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
                  type: 'function',
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
    this.validateConfig()

    const maxAttempts = 3
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), stream ? 90000 : 60000)

      try {
        const response = await fetch(this.getChatCompletionUrl(), {
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
