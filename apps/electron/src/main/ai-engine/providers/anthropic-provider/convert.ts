import { CODING_TEMPERATURE } from '../openai-provider/runtime/models.js'
import { CONTINUATION_USER_MESSAGE } from '../openai-provider/runtime/messages.js'
import type {
  ChatContentPart,
  ChatMessage,
  MessageContent,
  ProviderReasoningEffort,
  ToolCall,
  ToolDefinition,
  UsageCallback
} from '../openai-provider/types.js'
import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessagesBody,
  AnthropicMessagesResponse,
  AnthropicNormalizedResponse,
  AnthropicRuntime,
  AnthropicSystemBlock,
  AnthropicTextBlock,
  AnthropicThinkingConfig,
  AnthropicUsage
} from './types.js'

/**
 * Anthropic requires an explicit max_tokens on every request. 8192 is the
 * safest ceiling that works across every Claude generation (older 3.5 models
 * cap at 8192 output tokens); thinking budgets raise it as needed.
 */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192

/** Thinking budget per reasoning-effort level. */
const THINKING_BUDGETS: Record<ProviderReasoningEffort, number> = {
  low: 2048,
  medium: 4096,
  high: 16384,
  max: 32000
}

export function resolveAnthropicThinking (runtime: AnthropicRuntime): AnthropicThinkingConfig | undefined {
  if (!runtime.enableThinking) return undefined
  return {
    type: 'enabled',
    budget_tokens: THINKING_BUDGETS[runtime.reasoningEffort] ?? THINKING_BUDGETS.medium
  }
}

export function resolveAnthropicMaxTokens (thinking?: AnthropicThinkingConfig): number {
  if (!thinking) return DEFAULT_ANTHROPIC_MAX_TOKENS
  // max_tokens must strictly exceed the thinking budget.
  return thinking.budget_tokens + 4096
}

/**
 * Build a Messages API request body from the engine's internal (OpenAI-shaped)
 * conversation. System messages are hoisted into the top-level system field,
 * tool calls / tool results become content blocks, and Anthropic's
 * first-message-must-be-user / no-consecutive-same-role constraints are
 * enforced so callers never have to think about them.
 */
export function buildAnthropicRequestBody (
  runtime: AnthropicRuntime,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  stream: boolean
): AnthropicMessagesBody {
  const systemParts: string[] = []
  const turns: Array<{ role: 'user' | 'assistant'; blocks: AnthropicContentBlock[] }> = []

  for (const message of messages) {
    const role = message.role

    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content)
      if (text) systemParts.push(text)
      continue
    }

    if (role === 'tool') {
      const block = toToolResultBlock(message)
      if (block) pushTurn(turns, 'user', block)
      continue
    }

    if (role === 'assistant') {
      const blocks = toAssistantBlocks(message)
      if (blocks.length > 0) pushTurn(turns, 'assistant', ...blocks)
      continue
    }

    // user (and anything unrecognized falls back to user)
    const blocks = toUserBlocks(message)
    if (blocks.length > 0) pushTurn(turns, 'user', ...blocks)
  }

  const mergedTurns = mergeConsecutiveTurns(turns)
  if (mergedTurns.length === 0 || mergedTurns[0].role !== 'user') {
    mergedTurns.unshift({ role: 'user', blocks: [{ type: 'text', text: CONTINUATION_USER_MESSAGE }] })
  }

  const thinking = resolveAnthropicThinking(runtime)
  const body: AnthropicMessagesBody = {
    model: runtime.model,
    max_tokens: resolveAnthropicMaxTokens(thinking),
    messages: mergedTurns.map(turn => ({
      role: turn.role,
      content: turn.blocks
    }))
  }

  if (systemParts.length > 0) {
    const system: AnthropicSystemBlock[] = [{
      type: 'text',
      text: systemParts.join('\n\n')
    }]
    // Cache the (large, stable) system prompt across turns.
    system[0].cache_control = { type: 'ephemeral' }
    body.system = system
  }

  // Extended thinking requires temperature to stay at the default (1).
  if (!thinking) {
    body.temperature = runtime.temperature ?? CODING_TEMPERATURE
  }

  if (thinking) {
    body.thinking = thinking
  }

  if (stream) {
    body.stream = true
  }

  if (tools.length > 0) {
    body.tools = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }))
    body.tool_choice = { type: 'auto' }
  }

  return body
}

function pushTurn (
  turns: Array<{ role: 'user' | 'assistant'; blocks: AnthropicContentBlock[] }>,
  role: 'user' | 'assistant',
  ...blocks: AnthropicContentBlock[]
): void {
  const last = turns[turns.length - 1]
  if (last && last.role === role) {
    last.blocks.push(...blocks)
  } else {
    turns.push({ role, blocks: [...blocks] })
  }
}

function mergeConsecutiveTurns (
  turns: Array<{ role: 'user' | 'assistant'; blocks: AnthropicContentBlock[] }>
): Array<{ role: 'user' | 'assistant'; blocks: AnthropicContentBlock[] }> {
  const merged: Array<{ role: 'user' | 'assistant'; blocks: AnthropicContentBlock[] }> = []
  for (const turn of turns) {
    const last = merged[merged.length - 1]
    if (last && last.role === turn.role) {
      last.blocks.push(...turn.blocks)
    } else {
      merged.push({ role: turn.role, blocks: [...turn.blocks] })
    }
  }
  return merged
}

function contentToText (content: MessageContent): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => part.type === 'text' ? part.text : '')
    .join('')
}

function toUserBlocks (message: ChatMessage): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = []
  const content = message.content

  if (typeof content === 'string') {
    if (content) blocks.push({ type: 'text', text: content })
    return blocks
  }

  if (!Array.isArray(content)) return blocks

  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text })
      continue
    }
    const image = toImageBlock(part)
    if (image) blocks.push(image)
  }

  return blocks
}

function toAssistantBlocks (message: ChatMessage): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = []
  if (typeof message.content === 'string') {
    if (message.content) blocks.push({ type: 'text', text: message.content })
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') {
        if (part.text) blocks.push({ type: 'text', text: part.text })
      } else if (part.type === 'image_url') {
        const image = toImageBlock(part)
        if (image) blocks.push(image)
      } else if (part.type === 'thinking') {
        blocks.push({
          type: 'thinking',
          thinking: part.thinking,
          signature: part.signature
        })
      } else if (part.type === 'redacted_thinking') {
        blocks.push({ type: 'redacted_thinking', data: part.data })
      }
    }
  }

  for (const toolCall of message.tool_calls || []) {
    blocks.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.function.name,
      input: parseToolArguments(toolCall.function.arguments)
    })
  }

  return blocks
}

function toToolResultBlock (message: ChatMessage): AnthropicToolResultBlockSafe | null {
  const toolUseId = message.tool_call_id?.trim()
  if (!toolUseId) return null

  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: toolResultContent(message.content)
  }
}

type AnthropicToolResultBlockSafe = Extract<AnthropicContentBlock, { type: 'tool_result' }>

function toolResultContent (content: MessageContent): string | Array<AnthropicTextBlock | AnthropicImageBlock> {
  if (typeof content === 'string') {
    return content || '(empty result)'
  }

  if (!Array.isArray(content) || content.length === 0) {
    return '(empty result)'
  }

  const blocks: Array<AnthropicTextBlock | AnthropicImageBlock> = []
  for (const part of content) {
    if (part.type === 'text' && part.text) {
      blocks.push({ type: 'text', text: part.text })
      continue
    }
    const image = part.type === 'image_url' ? toImageBlock(part) : null
    if (image) blocks.push(image)
  }

  return blocks.length > 0 ? blocks : '(empty result)'
}

function toImageBlock (part: ChatContentPart): AnthropicImageBlock | null {
  if (part.type !== 'image_url') return null
  const url = part.image_url?.url
  if (!url) return null

  const dataUrlMatch = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (dataUrlMatch) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: dataUrlMatch[1],
        data: dataUrlMatch[2]
      }
    }
  }

  return {
    type: 'image',
    source: { type: 'url', url }
  }
}

function parseToolArguments (raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed }
  } catch {
    return { raw_arguments: raw }
  }
}

/** Map Messages API usage to the engine-wide usage-callback shape. */
export function mapAnthropicUsage (usage?: AnthropicUsage): Parameters<UsageCallback>[0] | undefined {
  if (!usage) return undefined
  const promptTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
  return {
    prompt_tokens: promptTokens || undefined,
    completion_tokens: usage.output_tokens,
    total_tokens: (promptTokens || 0) + (usage.output_tokens ?? 0) || undefined,
    prompt_tokens_details: usage.cache_read_input_tokens
      ? { cached_tokens: usage.cache_read_input_tokens }
      : undefined
  }
}

/** Normalize a non-streaming Messages API response into the internal shape. */
export function normalizeAnthropicResponse (data: AnthropicMessagesResponse): AnthropicNormalizedResponse {
  const textParts: string[] = []
  const thinkingParts: string[] = []
  const toolCalls: ToolCall[] = []
  const contentParts: ChatContentPart[] = []
  let hasReplayableProviderThinking = false

  for (const block of data.content || []) {
    if (block.type === 'text') {
      textParts.push(block.text)
      contentParts.push({ type: 'text', text: block.text })
    } else if (block.type === 'thinking') {
      thinkingParts.push(block.thinking)
      if (block.signature) {
        hasReplayableProviderThinking = true
        contentParts.push({ type: 'thinking', thinking: block.thinking, signature: block.signature })
      }
    } else if (block.type === 'redacted_thinking') {
      hasReplayableProviderThinking = true
      contentParts.push({ type: 'redacted_thinking', data: block.data })
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {})
        }
      })
    }
  }

  const message: ChatMessage = {
    role: 'assistant',
    content: hasReplayableProviderThinking ? contentParts : textParts.join('')
  }
  if (thinkingParts.length > 0) {
    message.reasoning_content = thinkingParts.join('')
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls
  }

  return { message, usage: mapAnthropicUsage(data.usage) }
}
