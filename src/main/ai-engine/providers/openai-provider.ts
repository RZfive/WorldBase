import type { AILogSessionLogger } from '../../settings/ai-log-store.js'
import {
  chatCompletion as runChatCompletion,
  chatCompletionStream as runChatCompletionStream
} from './openai-provider/chat/completions.js'
import {
  editImages as runEditImages,
  generateImages as runGenerateImages,
  imageResponseCompletion
} from './openai-provider/images/completions.js'
import { isImageOutputModel } from './openai-provider/runtime/models.js'
import { normalizeBaseUrl } from './openai-provider/runtime/urls.js'
import type {
  ChatCompletionStreamEvent,
  ChatMessage,
  EditImagesOptions,
  GenerateImagesOptions,
  ImageGenerationResult,
  OpenAIProviderRuntime,
  ProviderReasoningEffort,
  RequestOptions,
  ToolDefinition,
  UsageCallback
} from './openai-provider/types.js'

export type {
  ChatContentImagePart,
  ChatContentPart,
  ChatContentTextPart,
  ChatMessage,
  EditImagesOptions,
  GenerateImagesOptions,
  ImageGenerationResult,
  MessageContent,
  ToolCall,
  ToolDefinition,
  UsageCallback
} from './openai-provider/types.js'

/**
 * OpenAIProvider — OpenAI 兼容 API 提供者
 * 支持 OpenAI, Azure OpenAI, 以及任何兼容 API
 */
export class OpenAIProvider {
  private apiKey: string
  private baseUrl: string
  private model: string
  private imageGeneration = false
  private imageEditing = false
  private enableThinking: boolean
  private reasoningEffort: ProviderReasoningEffort
  /** Configured sampling temperature; when undefined the coding default is used. */
  private temperature?: number
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

  setApiKey (key: string): void {
    this.apiKey = key
  }

  setBaseUrl (url: string): void {
    this.baseUrl = normalizeBaseUrl(url)
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

  setReasoningEffort (effort: ProviderReasoningEffort): void {
    this.reasoningEffort = effort
  }

  /**
   * Override the sampling temperature. Pass undefined to fall back to the
   * coding-tuned default. Values are clamped to the valid [0, 2] range.
   */
  setTemperature (temperature?: number): void {
    if (temperature === undefined || !Number.isFinite(temperature)) {
      this.temperature = undefined
      return
    }
    this.temperature = Math.min(Math.max(temperature, 0), 2)
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
    const runtime = this.getRuntime()
    if (isImageOutputModel(runtime.model, runtime.imageGeneration)) {
      return await imageResponseCompletion(runtime, messages, abortSignal, options)
    }

    return await runChatCompletion(runtime, messages, tools, abortSignal, options)
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
  ): AsyncGenerator<ChatCompletionStreamEvent> {
    const runtime = this.getRuntime()
    if (isImageOutputModel(runtime.model, runtime.imageGeneration)) {
      const message = await imageResponseCompletion(runtime, messages, abortSignal)
      yield { type: 'done', message }
      return
    }

    yield * runChatCompletionStream(runtime, messages, tools, abortSignal)
  }

  /**
   * Parameterized text-to-image generation for the drawing studio.
   * Uses the /images/generations endpoint with explicit size / count and an
   * optional negative prompt. Falls back to dropping the negative prompt when
   * the provider rejects it (OpenAI does not support the field).
   */
  async generateImages (opts: GenerateImagesOptions): Promise<ImageGenerationResult> {
    return await runGenerateImages(this.getRuntime(), opts)
  }

  /**
   * Parameterized image editing for the drawing studio via the multipart
   * /images/edits endpoint (gpt-image-1 / dall-e-2 style).
   */
  async editImages (opts: EditImagesOptions): Promise<ImageGenerationResult> {
    return await runEditImages(this.getRuntime(), opts)
  }

  private getRuntime (): OpenAIProviderRuntime {
    const provider = this
    return {
      get apiKey () { return provider.apiKey },
      get baseUrl () { return provider.baseUrl },
      get model () { return provider.model },
      get imageGeneration () { return provider.imageGeneration },
      get imageEditing () { return provider.imageEditing },
      get enableThinking () { return provider.enableThinking },
      get reasoningEffort () { return provider.reasoningEffort },
      get temperature () { return provider.temperature },
      get logger () { return provider.logger },
      get onUsage () { return provider.onUsage }
    }
  }
}
