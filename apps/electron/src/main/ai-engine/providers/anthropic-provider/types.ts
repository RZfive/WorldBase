import type { AILogSessionLogger } from '../../../settings/ai-log-store.js'
import type {
  ChatMessage,
  ProviderReasoningEffort,
  UsageCallback
} from '../openai-provider/types.js'

/** Runtime slice the Anthropic Messages adapter needs from its provider. */
export interface AnthropicRuntime {
  apiKey: string
  baseUrl: string
  model: string
  enableThinking: boolean
  reasoningEffort: ProviderReasoningEffort
  temperature?: number
  logger?: AILogSessionLogger
  onUsage?: UsageCallback
}

/** Anthropic prompt-caching breakpoint; up to 4 blocks per request. */
export interface AnthropicCacheControl {
  type: 'ephemeral'
}

export interface AnthropicTextBlock {
  type: 'text'
  text: string
  cache_control?: AnthropicCacheControl
}

export interface AnthropicImageBlock {
  type: 'image'
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string }
}

export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>
}

export interface AnthropicThinkingBlock {
  type: 'thinking'
  thinking: string
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock

export interface AnthropicApiMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export interface AnthropicSystemBlock {
  type: 'text'
  text: string
  cache_control?: AnthropicCacheControl
}

export interface AnthropicThinkingConfig {
  type: 'enabled'
  budget_tokens: number
}

/**
 * Request body for the Anthropic Messages API (POST /v1/messages).
 * Mirrors the shape documented at docs.anthropic.com; only the fields the
 * engine actually sends are declared.
 */
export interface AnthropicMessagesBody {
  model: string
  max_tokens: number
  system?: AnthropicSystemBlock[]
  messages: AnthropicApiMessage[]
  temperature?: number
  stream?: boolean
  tools?: Array<{
    name: string
    description: string
    input_schema: Record<string, unknown>
  }>
  tool_choice?: { type: 'auto' }
  thinking?: AnthropicThinkingConfig
}

export interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** Non-streaming Messages API response (only fields the engine reads). */
export interface AnthropicMessagesResponse {
  content?: AnthropicContentBlock[]
  stop_reason?: string | null
  usage?: AnthropicUsage
  error?: { type?: string; message?: string }
}

export type AnthropicStreamEvent =
  | { type: 'message_start'; message?: { usage?: AnthropicUsage } }
  | { type: 'content_block_start'; index: number; content_block?: { type?: string; id?: string; name?: string } }
  | { type: 'content_block_delta'; index: number; delta?: { type?: string; text?: string; thinking?: string; partial_json?: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta?: { stop_reason?: string | null }; usage?: AnthropicUsage }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error?: { type?: string; message?: string } }

/** Normalized assistant message plus the mapped usage payload. */
export interface AnthropicNormalizedResponse {
  message: ChatMessage
  usage?: Parameters<UsageCallback>[0]
}
