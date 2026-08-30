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
