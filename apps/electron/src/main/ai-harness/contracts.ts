/**
 * Stable Electron-facing chat/tool contract.
 *
 * The Rust harness owns provider execution and the agent loop. These types
 * remain in Electron because renderer IPC, domain tools, and log storage all
 * exchange the same message shape.
 */
export interface ChatContentTextPart {
  type: 'text'
  text: string
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
