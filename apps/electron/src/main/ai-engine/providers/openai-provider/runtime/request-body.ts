import { applyPromptCaching, normalizeOutgoingMessages } from './messages.js'
import {
  isAnthropicProvider,
  isImageOutputModel,
  resolveReasoningEffort,
  resolveTemperature
} from './models.js'
import type {
  ChatCompletionBody,
  ChatMessage,
  OpenAIProviderRuntime,
  ToolDefinition
} from '../types.js'

export function buildRequestBody (
  runtime: OpenAIProviderRuntime,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  stream: boolean
): ChatCompletionBody {
  const body: ChatCompletionBody = {
    model: runtime.model,
    messages: applyPromptCaching(
      normalizeOutgoingMessages(messages),
      isAnthropicProvider(runtime.baseUrl, runtime.model)
    ),
    stream
  }

  const temperature = resolveTemperature(runtime.baseUrl, runtime.model, runtime.temperature)
  if (temperature !== undefined) {
    body.temperature = temperature
  }

  // Request usage data in stream responses.
  if (stream && runtime.onUsage) {
    body.stream_options = { include_usage: true }
  }

  if (isImageOutputModel(runtime.model, runtime.imageGeneration)) {
    body.stream = false
    body.modalities = ['text', 'image']
    return body
  }

  const reasoningEffort = resolveReasoningEffort(
    runtime.baseUrl,
    runtime.model,
    runtime.enableThinking,
    runtime.reasoningEffort
  )
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
