import type { AILogSessionLogger } from '../../settings/ai-log-store.js'
import {
  anthropicChatCompletion,
  anthropicChatCompletionStream
} from './anthropic-provider/client.js'
import { normalizeBaseUrl } from './openai-provider/runtime/urls.js'
import { t } from '../../i18n/main-i18n.js'
import type {
  ChatCompletionStreamEvent,
  ChatMessage,
  EditImagesOptions,
  GenerateImagesOptions,
  ImageGenerationResult,
  ProviderReasoningEffort,
  RequestOptions,
  ToolDefinition,
  UsageCallback
} from './openai-provider/types.js'
import type { ChatProvider } from './chat-provider.js'
import type { AnthropicRuntime } from './anthropic-provider/types.js'

/**
 * AnthropicProvider - native Anthropic Messages API provider.
 *
 * Speaks the internal OpenAI-shaped ChatMessage format and translates at the
 * HTTP boundary (see anthropic-provider/). Compatible with the official API
 * (api.anthropic.com) and Anthropic-protocol gateways (Volcengine Ark, etc.).
 */
export class AnthropicProvider implements ChatProvider {
  private apiKey: string
  private baseUrl: string
  private model: string
  private enableThinking: boolean
  private reasoningEffort: ProviderReasoningEffort
  /** Configured sampling temperature; when undefined the coding default is used. */
  private temperature?: number
  private contextWindow: number
  private logger?: AILogSessionLogger
  private onUsage?: UsageCallback

  constructor () {
    this.apiKey = ''
    this.baseUrl = 'https://api.anthropic.com/v1'
    this.model = 'claude-sonnet-4-5'
    this.enableThinking = false
    this.reasoningEffort = 'medium'
    this.contextWindow = 200000
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

  // The Messages API has no image generation endpoints.
  setImageGeneration (_enabled: boolean): void {}
  setImageEditing (_enabled: boolean): void {}

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

  async chatCompletion (
    messages: ChatMessage[],
    tools: ToolDefinition[] = [],
    abortSignal?: AbortSignal,
    options?: RequestOptions
  ): Promise<ChatMessage> {
    return await anthropicChatCompletion(this.getRuntime(), messages, tools, abortSignal, options)
  }

  async * chatCompletionStream (
    messages: ChatMessage[],
    tools: ToolDefinition[] = [],
    abortSignal?: AbortSignal
  ): AsyncGenerator<ChatCompletionStreamEvent> {
    yield * anthropicChatCompletionStream(this.getRuntime(), messages, tools, abortSignal)
  }

  async generateImages (_opts: GenerateImagesOptions): Promise<ImageGenerationResult> {
    throw new Error(t('mainDialog.providerAnthropicImagesUnsupported'))
  }

  async editImages (_opts: EditImagesOptions): Promise<ImageGenerationResult> {
    throw new Error(t('mainDialog.providerAnthropicImagesUnsupported'))
  }

  private getRuntime (): AnthropicRuntime {
    const provider = this
    return {
      get apiKey () { return provider.apiKey },
      get baseUrl () { return provider.baseUrl },
      get model () { return provider.model },
      get enableThinking () { return provider.enableThinking },
      get reasoningEffort () { return provider.reasoningEffort },
      get temperature () { return provider.temperature },
      get logger () { return provider.logger },
      get onUsage () { return provider.onUsage }
    }
  }
}
