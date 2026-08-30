import { AnthropicProvider } from './anthropic-provider.js'
import { OpenAIProvider } from './openai-provider.js'
import { resolveApiProtocol } from './openai-provider/runtime/models.js'
import type { ProviderApiProtocol } from './openai-provider/types.js'
import type { ChatProvider } from './chat-provider.js'

export type { ChatProvider } from './chat-provider.js'

/** Inputs the factory needs to pick a provider class; the rest is set via setters. */
export interface ProviderFactoryInput {
  baseUrl?: string
  /** Explicit protocol override; unset -> auto-detect from baseUrl. */
  apiProtocol?: ProviderApiProtocol
}

/**
 * Instantiate the chat provider matching the configured wire protocol.
 * This is the single dispatch point for provider channels - everything
 * upstream (engine, agent core) only sees the ChatProvider interface.
 */
export function createProvider (input: ProviderFactoryInput = {}): ChatProvider {
  const protocol = resolveApiProtocol(input.baseUrl ?? '', input.apiProtocol)
  return protocol === 'anthropic'
    ? new AnthropicProvider()
    : new OpenAIProvider()
}
