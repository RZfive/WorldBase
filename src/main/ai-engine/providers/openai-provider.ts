import { normalizeAbortReason } from '../abort-utils.js'
import type { AILogSessionLogger } from '../../settings/ai-log-store.js'

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

interface RequestOptions {
  timeoutMs?: number
}

export type UsageCallback = (usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }) => void

interface ChatCompletionBody {
  model: string
  messages: ChatMessage[]
  temperature?: number
  stream?: boolean
  stream_options?: { include_usage: boolean }
  modalities?: string[]
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high'
  tools?: { type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }[]
  tool_choice?: string
}

interface ResponsesContentTextPart {
  type: 'input_text'
  text: string
}

interface ResponsesContentImagePart {
  type: 'input_image'
  image_url: string
}

interface ResponsesInputMessage {
  role: string
  content: Array<ResponsesContentTextPart | ResponsesContentImagePart>
}

interface ResponsesBody {
  model: string
  input: ResponsesInputMessage[]
  stream?: boolean
  tools?: Array<{ type: 'image_generation' }>
}

interface ResponsesOutputTextPart {
  type?: string
  text?: string
}

interface ResponsesOutputImagePart {
  type?: string
  image_url?: string | { url?: string }
  b64_json?: string
  result?: string
  mime_type?: string
}

interface ResponsesOutputMessage {
  type?: string
  role?: string
  content?: Array<ResponsesOutputTextPart | ResponsesOutputImagePart>
}

interface ResponsesApiResponse {
  output?: Array<ResponsesOutputMessage | ResponsesOutputImagePart | ResponsesOutputTextPart>
  output_text?: string
  usage?: Record<string, unknown>
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

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>

/**
 * OpenAIProvider — OpenAI 兼容 API 提供者
 * 支持 OpenAI, Azure OpenAI, 以及任何兼容 API
 */
export class OpenAIProvider {
  /** Standard requests should fail fast to surface provider issues promptly. */
  private static readonly STANDARD_REQUEST_TIMEOUT_MS = 60000
  /** Streaming responses should only time out when no bytes arrive for too long. */
  private static readonly STREAM_IDLE_TIMEOUT_MS = 90000
  private static readonly STREAM_IDLE_TIMEOUT_MESSAGE = 'AI stream idle timed out'
  private apiKey: string
  private baseUrl: string
  private model: string
  private imageGeneration = false
  private imageEditing = false
  private enableThinking: boolean
  private reasoningEffort: 'low' | 'medium' | 'high' | 'max'
  private contextWindow: number
  private logger?: AILogSessionLogger
  private onUsage?: UsageCallback

  constructor () {
    this.apiKey = process.env.OPENAI_API_KEY || ''
    this.baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    this.model = process.env.OPENAI_MODEL || 'gpt-4o'
    this.enableThinking = false
    this.reasoningEffort = 'medium'
    this.contextWindow = 32000
  }

  private isOpenAIProvider (): boolean {
    const normalizedBaseUrl = this.baseUrl.toLowerCase()
    const normalizedModel = this.model.toLowerCase()
    return normalizedBaseUrl.includes('openai') ||
      normalizedModel.startsWith('gpt-') ||
      /^o[1234]/.test(normalizedModel)
  }

  private isDeepSeekProvider (): boolean {
    const normalizedBaseUrl = this.baseUrl.toLowerCase()
    const normalizedModel = this.model.toLowerCase()
    return normalizedBaseUrl.includes('deepseek') || normalizedModel.includes('deepseek')
  }

  private resolveReasoningEffort (): ChatCompletionBody['reasoning_effort'] | undefined {
    if (!this.enableThinking) return undefined

    if (this.isOpenAIProvider() && this.model.toLowerCase().startsWith('gpt-5')) {
      if (this.reasoningEffort === 'low') return 'minimal'
      if (this.reasoningEffort === 'medium') return 'low'
      if (this.reasoningEffort === 'high') return 'medium'
      return 'high'
    }

    if (this.isDeepSeekProvider()) {
      if (this.reasoningEffort === 'max') return 'high'
      return this.reasoningEffort
    }

    if (this.reasoningEffort === 'max') return 'high'
    return this.reasoningEffort
  }

  private isImageOutputModel (): boolean {
    const normalized = this.model.toLowerCase()
    return this.imageGeneration ||
      normalized.includes('image-preview') ||
      normalized.includes('gpt-image') ||
      normalized.includes('imagen') ||
      normalized.includes('-image') ||
      normalized.includes('image-') ||
      normalized.includes('flux')
  }

  private supportsImageEditing (): boolean {
    return this.imageEditing
  }

  private buildRequestBody (messages: ChatMessage[], tools: ToolDefinition[], stream: boolean): ChatCompletionBody {
    const body: ChatCompletionBody = {
      model: this.model,
      messages: this.normalizeOutgoingMessages(messages),
      temperature: 0.7,
      stream
    }

    // Request usage data in stream responses
    if (stream && this.onUsage) {
      body.stream_options = { include_usage: true }
    }

    if (this.isImageOutputModel()) {
      body.stream = false
      body.modalities = ['text', 'image']
      return body
    }

    const reasoningEffort = this.resolveReasoningEffort()
    if (reasoningEffort) {
      body.reasoning_effort = reasoningEffort
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
    const normalized = messages.map(message => {
      if (!message.tool_calls || message.tool_calls.length === 0) {
        return message
      }

      return {
        ...message,
        tool_calls: this.normalizeToolCalls(message.tool_calls)
      }
    })

    return this.ensureUserMessage(this.sanitizeToolMessageSequence(normalized))
  }

  private sanitizeToolMessageSequence (messages: ChatMessage[]): ChatMessage[] {
    const sanitized: ChatMessage[] = []

    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]

      if (message.role === 'tool') {
        continue
      }

      if (message.role !== 'assistant' || !message.tool_calls || message.tool_calls.length === 0) {
        sanitized.push(message)
        continue
      }

      const normalizedToolCalls = this.normalizeToolCalls(message.tool_calls)
      if (!normalizedToolCalls || normalizedToolCalls.length === 0) {
        sanitized.push({
          ...message,
          tool_calls: undefined
        })
        continue
      }

      const expectedToolCallIds = new Set(normalizedToolCalls.map(toolCall => toolCall.id.trim()).filter(Boolean))
      if (expectedToolCallIds.size !== normalizedToolCalls.length) {
        continue
      }

      const toolMessages: ChatMessage[] = []
      let nextIndex = index + 1
      while (nextIndex < messages.length && messages[nextIndex].role === 'tool') {
        toolMessages.push(messages[nextIndex])
        nextIndex++
      }

      const matchedToolCallIds = new Set<string>()
      let hasInvalidToolResponse = toolMessages.length === 0

      for (const toolMessage of toolMessages) {
        const toolCallId = toolMessage.tool_call_id?.trim()
        if (!toolCallId || !expectedToolCallIds.has(toolCallId) || matchedToolCallIds.has(toolCallId)) {
          hasInvalidToolResponse = true
          break
        }

        matchedToolCallIds.add(toolCallId)
      }

      if (!hasInvalidToolResponse && matchedToolCallIds.size === expectedToolCallIds.size) {
        sanitized.push({
          ...message,
          tool_calls: normalizedToolCalls
        })
        sanitized.push(...toolMessages)
      }

      index = nextIndex - 1
    }

    return sanitized
  }

  private ensureUserMessage (messages: ChatMessage[]): ChatMessage[] {
    if (messages.some(message => message.role === 'user')) {
      return messages
    }

    return [
      ...messages,
      {
        role: 'user',
        content: 'Continue the current task from the existing context. Do not repeat completed steps.'
      }
    ]
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

  private getResponsesUrl (): string {
    const normalized = this.normalizeBaseUrl(this.baseUrl)
    if (normalized.endsWith('/responses')) {
      return normalized
    }
    if (normalized.endsWith('/chat/completions')) {
      return `${normalized.slice(0, -'/chat/completions'.length)}/responses`
    }
    return `${normalized}/responses`
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

  setImageGeneration (enabled: boolean): void {
    this.imageGeneration = enabled
  }

  setImageEditing (enabled: boolean): void {
    this.imageEditing = enabled
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

  setReasoningEffort (effort: 'low' | 'medium' | 'high' | 'max'): void {
    this.reasoningEffort = effort
  }

  setLogger (logger?: AILogSessionLogger): void {
    this.logger = logger
  }

  setOnUsage (callback?: UsageCallback): void {
    this.onUsage = callback
  }

  /**
   * Make a chat completion request with function calling support.
   */
  async chatCompletion (
    messages: ChatMessage[],
    tools: ToolDefinition[] = [],
    abortSignal?: AbortSignal,
    options?: RequestOptions
  ): Promise<ChatMessage> {
    if (this.isImageOutputModel()) {
      return await this.imageResponseCompletion(messages, abortSignal, options)
    }

    const body = this.buildRequestBody(messages, tools, false)
    const callId = this.logger?.logProviderCallStart({
      stream: false,
      model: this.model,
      baseUrl: this.getChatCompletionUrl(),
      messages: body.messages,
      tools
    })

    try {
      const response = await this.fetchWithRetry(this.getChatCompletionUrl(), body, false, abortSignal, options)
      const data = await response.json() as { choices: Array<{ message: ApiChatMessage }>; usage?: Record<string, unknown> }
      const message = this.normalizeAssistantMessage(data.choices[0].message)
      if (data.usage && this.onUsage) {
        this.onUsage(data.usage as Parameters<UsageCallback>[0])
      }
      if (callId) {
        this.logger?.logProviderCallSuccess(callId, { message, raw: data })
      }
      return message
    } catch (error) {
      if (callId) {
        this.logger?.logProviderCallFailure(callId, this.normalizeRequestError(error), { stream: false, model: this.model })
      }
      throw error
    }
  }

  /**
   * Streaming chat completion. Yields content tokens as they arrive.
   * When tool_calls are present in the stream, they are accumulated
   * and returned as a complete ChatMessage at the end.
   * Supports reasoning_content (thinking) from compatible models.
   */
  async * chatCompletionStream (
    messages: ChatMessage[],
    tools: ToolDefinition[] = [],
    abortSignal?: AbortSignal
  ): AsyncGenerator<
    | { type: 'token'; content: string }
    | { type: 'thinking'; content: string }
    | { type: 'tool_calls'; message: ChatMessage }
    | { type: 'done'; message: ChatMessage }
  > {
    if (this.isImageOutputModel()) {
      const message = await this.imageResponseCompletion(messages, abortSignal)
      yield { type: 'done', message }
      return
    }

    const body = this.buildRequestBody(messages, tools, true)
    const callId = this.logger?.logProviderCallStart({
      stream: !this.isImageOutputModel(),
      model: this.model,
      baseUrl: this.getChatCompletionUrl(),
      messages: body.messages,
      tools
    })

    try {
      const response = await this.fetchWithRetry(this.getChatCompletionUrl(), body, true, abortSignal)

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''
      const fullContentChunks: string[] = []
      const fullReasoningChunks: string[] = []
      const toolCallsMap = new Map<number, ToolCall>()

      try {
        while (true) {
          if (abortSignal?.aborted) {
            throw normalizeAbortReason(abortSignal.reason)
          }
          const { done, value } = await this.readStreamChunkWithIdleTimeout(reader, OpenAIProvider.STREAM_IDLE_TIMEOUT_MS)
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.startsWith('data: ')) continue
            const jsonStr = trimmed.slice(6)
            if (jsonStr === '[DONE]') continue

            let parsed: { choices?: Array<{ delta: StreamDelta; finish_reason?: string | null }>; usage?: Record<string, unknown> }
            try {
              parsed = JSON.parse(jsonStr)
            } catch {
              continue
            }

            // Extract usage from the final stream chunk (OpenAI sends it when stream_options.include_usage is true)
            if (parsed.usage && this.onUsage) {
              this.onUsage(parsed.usage as Parameters<UsageCallback>[0])
            }

            const delta = parsed.choices?.[0]?.delta
            if (!delta) continue

            // Handle reasoning_content (thinking) from compatible models
            if (delta.reasoning_content) {
              fullReasoningChunks.push(delta.reasoning_content)
              yield { type: 'thinking', content: delta.reasoning_content }
            }

            if (delta.content) {
              fullContentChunks.push(delta.content)
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
      const fullContent = fullContentChunks.join('')
      const fullReasoning = fullReasoningChunks.join('')
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

      if (callId) {
        this.logger?.logProviderCallSuccess(callId, { message })
      }
      yield { type: 'done', message }
    } catch (err) {
      const normalized = abortSignal?.aborted
        ? normalizeAbortReason(abortSignal.reason)
        : this.normalizeRequestError(err)
      if (callId) {
        this.logger?.logProviderCallFailure(callId, normalized, { stream: true, model: this.model })
      }
      throw normalized
    }
  }

  private buildResponsesInput (messages: ChatMessage[]): ResponsesInputMessage[] {
    const normalizedMessages = this.normalizeOutgoingMessages(messages)
    if (!this.supportsImageEditing()) {
      const hasImageInput = normalizedMessages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url' && Boolean(part.image_url?.url)))
      if (hasImageInput) {
        throw new Error('当前模型未开启图片编辑支持，请先在设置中为该模型开启“图片编辑”')
      }
    }

    const responseMessages = normalizedMessages.map((message) => {
      const parts: Array<ResponsesContentTextPart | ResponsesContentImagePart> = []

      if (typeof message.content === 'string') {
        if (message.content) {
          parts.push({ type: 'input_text', text: message.content })
        }
      } else {
        for (const part of message.content) {
          if (part.type === 'text' && part.text) {
            parts.push({ type: 'input_text', text: part.text })
          } else if (part.type === 'image_url' && part.image_url?.url && this.supportsImageEditing()) {
            parts.push({ type: 'input_image', image_url: part.image_url.url })
          }
        }
      }

      return {
        role: message.role === 'assistant' || message.role === 'system' ? message.role : 'user',
        content: parts
      }
    }).filter(message => message.content.length > 0)

    if (responseMessages.length > 0) {
      return responseMessages
    }

    return [{
      role: 'user',
      content: [{ type: 'input_text', text: 'Continue the current task from the existing context. Do not repeat completed steps.' }]
    }]
  }

  private buildResponsesBody (messages: ChatMessage[]): ResponsesBody {
    const body: ResponsesBody = {
      model: this.model,
      input: this.buildResponsesInput(messages),
      stream: false
    }

    body.tools = [{ type: 'image_generation' }]
    return body
  }

  private resolveResponseImageUrl (part: ResponsesOutputImagePart): string | null {
    if (typeof part.image_url === 'string' && part.image_url) {
      return part.image_url
    }

    if (part.image_url && typeof part.image_url === 'object' && typeof part.image_url.url === 'string' && part.image_url.url) {
      return part.image_url.url
    }

    const base64 = typeof part.result === 'string' && part.result
      ? part.result
      : (typeof part.b64_json === 'string' ? part.b64_json : '')
    if (!base64) {
      return null
    }

    const mimeType = part.mime_type?.trim() || 'image/png'
    return `data:${mimeType};base64,${base64}`
  }

  private normalizeResponsesMessage (data: ResponsesApiResponse): ChatMessage {
    const contentParts: ChatContentPart[] = []

    const pushText = (text?: string) => {
      if (typeof text !== 'string' || text.length === 0) return
      contentParts.push({ type: 'text', text })
    }

    const pushImage = (part: ResponsesOutputImagePart) => {
      const url = this.resolveResponseImageUrl(part)
      if (!url) return
      contentParts.push({
        type: 'image_url',
        image_url: { url }
      })
    }

    for (const outputItem of data.output || []) {
      if (outputItem && typeof outputItem === 'object' && Array.isArray((outputItem as ResponsesOutputMessage).content)) {
        for (const part of (outputItem as ResponsesOutputMessage).content || []) {
          if (part && typeof part === 'object' && 'text' in part) {
            pushText((part as ResponsesOutputTextPart).text)
          } else if (part && typeof part === 'object') {
            pushImage(part as ResponsesOutputImagePart)
          }
        }
        continue
      }

      if (outputItem && typeof outputItem === 'object' && 'text' in outputItem) {
        pushText((outputItem as ResponsesOutputTextPart).text)
      } else if (outputItem && typeof outputItem === 'object') {
        pushImage(outputItem as ResponsesOutputImagePart)
      }
    }

    if (contentParts.length === 0 && data.output_text) {
      return {
        role: 'assistant',
        content: data.output_text
      }
    }

    if (contentParts.length === 0) {
      return {
        role: 'assistant',
        content: ''
      }
    }

    if (contentParts.every(part => part.type === 'text')) {
      return {
        role: 'assistant',
        content: contentParts.map(part => part.type === 'text' ? part.text : '').join('')
      }
    }

    return {
      role: 'assistant',
      content: contentParts
    }
  }

  private shouldRetryImageRequestWithoutTool (error: Error): boolean {
    const message = error.message.toLowerCase()
    return message.includes('image_generation') ||
      message.includes('unknown tool') ||
      message.includes('invalid tool') ||
      message.includes('unsupported tool')
  }

  private async imageResponseCompletion (
    messages: ChatMessage[],
    abortSignal?: AbortSignal,
    options?: RequestOptions
  ): Promise<ChatMessage> {
    const body = this.buildResponsesBody(messages)
    const callId = this.logger?.logProviderCallStart({
      stream: false,
      model: this.model,
      baseUrl: this.getResponsesUrl(),
      messages: this.normalizeOutgoingMessages(messages),
      tools: []
    })

    try {
      let response: Response
      try {
        response = await this.fetchWithRetry(this.getResponsesUrl(), body, false, abortSignal, options)
      } catch (error) {
        const normalized = this.normalizeRequestError(error)
        if (!body.tools || !this.shouldRetryImageRequestWithoutTool(normalized)) {
          throw normalized
        }

        response = await this.fetchWithRetry(this.getResponsesUrl(), { ...body, tools: undefined }, false, abortSignal, options)
      }

      const data = await response.json() as ResponsesApiResponse
      const message = this.normalizeResponsesMessage(data)
      if (data.usage && this.onUsage) {
        this.onUsage(data.usage as Parameters<UsageCallback>[0])
      }
      if (callId) {
        this.logger?.logProviderCallSuccess(callId, { message, raw: data })
      }
      return message
    } catch (error) {
      if (callId) {
        this.logger?.logProviderCallFailure(callId, this.normalizeRequestError(error), { stream: false, model: this.model })
      }
      throw error
    }
  }

  private async fetchWithRetry (
    url: string,
    body: ChatCompletionBody | ResponsesBody,
    stream: boolean,
    abortSignal?: AbortSignal,
    options?: RequestOptions
  ): Promise<Response> {
    this.validateConfig()

    const maxAttempts = 3
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController()
      const onAbort = () => {
        if (!abortSignal) return
        controller.abort(normalizeAbortReason(abortSignal.reason))
      }
      if (abortSignal) {
        if (abortSignal.aborted) {
          throw normalizeAbortReason(abortSignal.reason)
        }
        abortSignal.addEventListener('abort', onAbort, { once: true })
      }
      const timeoutMs = options?.timeoutMs ?? (stream ? undefined : OpenAIProvider.STANDARD_REQUEST_TIMEOUT_MS)
      const timeout = timeoutMs !== undefined
        ? setTimeout(() => controller.abort(new Error('AI request timed out')), timeoutMs)
        : null

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        })

        if (response.ok) {
          if (timeout) clearTimeout(timeout)
          if (abortSignal) {
            abortSignal.removeEventListener('abort', onAbort)
          }
          return response
        }

        const errorText = await response.text()
        const error = new Error(`OpenAI API error (${response.status}): ${errorText}`)
        if (timeout) clearTimeout(timeout)
        if (abortSignal) {
          abortSignal.removeEventListener('abort', onAbort)
        }

        if (!this.isRetryableStatus(response.status) || attempt === maxAttempts) {
          throw error
        }

        lastError = error
      } catch (err) {
        if (timeout) clearTimeout(timeout)
        if (abortSignal) {
          abortSignal.removeEventListener('abort', onAbort)
        }
        if (abortSignal?.aborted) {
          throw normalizeAbortReason(abortSignal.reason)
        }
        if (controller.signal.aborted) {
          throw normalizeAbortReason(controller.signal.reason)
        }
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
        return normalizeAbortReason(error.cause)
      }
      return error
    }
    return new Error(String(error))
  }

  private async delay (ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  private async readStreamChunkWithIdleTimeout (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeoutMs: number
  ): Promise<StreamReadResult> {
    let timeout: ReturnType<typeof setTimeout> | null = null

    try {
      const readPromise = reader.read()
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          void reader.cancel(OpenAIProvider.STREAM_IDLE_TIMEOUT_MESSAGE).catch(() => {
            // Ignore reader cancellation failures and surface the timeout instead.
          })
          reject(new Error(OpenAIProvider.STREAM_IDLE_TIMEOUT_MESSAGE))
        }, timeoutMs)
      })

      return await Promise.race([readPromise, timeoutPromise])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}
