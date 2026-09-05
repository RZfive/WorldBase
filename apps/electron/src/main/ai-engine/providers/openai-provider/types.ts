import type { AILogSessionLogger } from '../../../settings/ai-log-store.js'

export interface ChatContentTextPart {
  type: 'text'
  text: string
  /**
   * Anthropic prompt-caching breakpoint. Honored by Anthropic and
   * Anthropic-compatible gateways (e.g. OpenRouter) to cache everything up to
   * and including this block; ignored by providers that don't support it.
   */
  cache_control?: { type: 'ephemeral' }
}

export interface ChatContentImagePart {
  type: 'image_url'
  image_url: { url: string }
}

/** Provider-private Anthropic block retained for tool continuations. */
export interface ChatContentThinkingPart {
  type: 'thinking'
  thinking: string
  signature: string
}

/** Opaque Anthropic encrypted/redacted thinking block. */
export interface ChatContentRedactedThinkingPart {
  type: 'redacted_thinking'
  data: string
}

export type ChatContentPart = ChatContentTextPart | ChatContentImagePart | ChatContentThinkingPart | ChatContentRedactedThinkingPart
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

export interface RequestOptions {
  timeoutMs?: number
}

export type UsageCallback = (usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }) => void

export interface ChatCompletionBody {
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

export interface ResponsesContentTextPart {
  type: 'input_text'
  text: string
}

export interface ResponsesContentImagePart {
  type: 'input_image'
  image_url: string
}

export interface ResponsesInputMessage {
  role: string
  content: Array<ResponsesContentTextPart | ResponsesContentImagePart>
}

export interface ResponsesBody {
  model: string
  input: ResponsesInputMessage[]
  stream?: boolean
  tools?: Array<{ type: 'image_generation' }>
}

export interface ResponsesOutputTextPart {
  type?: string
  text?: string
}

export interface ResponsesOutputImagePart {
  type?: string
  image_url?: string | { url?: string }
  b64_json?: string
  result?: string
  mime_type?: string
}

export interface ResponsesOutputMessage {
  type?: string
  role?: string
  content?: Array<ResponsesOutputTextPart | ResponsesOutputImagePart>
}

export interface ResponsesApiResponse {
  output?: Array<ResponsesOutputMessage | ResponsesOutputImagePart | ResponsesOutputTextPart>
  output_text?: string
  usage?: Record<string, unknown>
}

export interface ImagesGenerationsBody {
  model: string
  prompt: string
  n?: number
  size?: string
  response_format?: 'url' | 'b64_json'
  negative_prompt?: string
  quality?: 'auto' | 'low' | 'medium' | 'high' | 'standard' | 'hd'
  output_format?: 'png' | 'jpeg' | 'webp'
}

/** Result of a parameterized image generation / edit request. */
export interface ImageGenerationResult {
  /** Generated images as data URLs or remote URLs. */
  images: string[]
  /** Provider-revised prompt, when returned. */
  revisedPrompt?: string
}

/** Options for the parameterized text-to-image generation entrypoint. */
export interface GenerateImagesOptions {
  prompt: string
  negativePrompt?: string
  size?: string
  quality?: 'auto' | 'low' | 'medium' | 'high'
  outputFormat?: 'png' | 'jpeg' | 'webp'
  n?: number
  abortSignal?: AbortSignal
}

/** Options for the parameterized image-edit entrypoint (/images/edits). */
export interface EditImagesOptions {
  prompt: string
  /** Source images as data URLs. */
  images: string[]
  /** Optional mask as a data URL. */
  mask?: string
  size?: string
  quality?: 'auto' | 'low' | 'medium' | 'high'
  outputFormat?: 'png' | 'jpeg' | 'webp'
  n?: number
  abortSignal?: AbortSignal
}

export interface ImagesGenerationsResponse {
  created?: number
  data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>
  usage?: Record<string, unknown>
}

export interface MultiModalContentPart {
  text?: string
  inline_data?: {
    data: string
    mime_type?: string
  }
}

export interface ApiChatMessage {
  role?: string
  content?: MessageContent | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  reasoning_content?: string
  multi_mod_content?: MultiModalContentPart[]
}

export interface StreamDelta {
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

export type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>

export type ProviderReasoningEffort = 'low' | 'medium' | 'high' | 'max'

/** Wire protocol the provider speaks: OpenAI-compatible or native Anthropic Messages. */
export type ProviderApiProtocol = 'openai' | 'anthropic'

export interface OpenAIProviderRuntime {
  apiKey: string
  baseUrl: string
  model: string
  imageGeneration: boolean
  imageEditing: boolean
  enableThinking: boolean
  reasoningEffort: ProviderReasoningEffort
  temperature?: number
  logger?: AILogSessionLogger
  onUsage?: UsageCallback
}

export type ChatCompletionStreamEvent =
  | { type: 'token'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_calls'; message: ChatMessage }
  | { type: 'done'; message: ChatMessage }
