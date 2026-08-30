import type { AILogSessionLogger } from '../../settings/ai-log-store.js'
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

/**
 * Protocol-agnostic chat provider contract. Every concrete provider (OpenAI
 * chat/completions, native Anthropic Messages, future channels) implements
 * this surface; the agent core and engine only ever see this interface, so
 * adding a protocol never ripples past providers/index.ts.
 *
 * Conversations use the internal OpenAI-shaped ChatMessage format; each
 * provider translates at its own HTTP boundary.
 */
export interface ChatProvider {
  setApiKey (key: string): void
  setBaseUrl (url: string): void
  setModel (model: string): void
  setImageGeneration (enabled: boolean): void
  setImageEditing (enabled: boolean): void
  getModel (): string
  setContextWindow (contextWindow: number): void
  getContextWindow (): number
  setEnableThinking (enable: boolean): void
  setReasoningEffort (effort: ProviderReasoningEffort): void
  setTemperature (temperature?: number): void
  setLogger (logger?: AILogSessionLogger): void
  setOnUsage (callback?: UsageCallback): void

  chatCompletion (
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    abortSignal?: AbortSignal,
    options?: RequestOptions
  ): Promise<ChatMessage>

  chatCompletionStream (
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    abortSignal?: AbortSignal
  ): AsyncGenerator<ChatCompletionStreamEvent>

  generateImages (opts: GenerateImagesOptions): Promise<ImageGenerationResult>
  editImages (opts: EditImagesOptions): Promise<ImageGenerationResult>
}
