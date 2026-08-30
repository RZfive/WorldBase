import type { ChatCompletionBody, ProviderApiProtocol, ProviderReasoningEffort } from '../types.js'

export const CODING_TEMPERATURE = 0.3

export function isOpenAIProvider (baseUrl: string, model: string): boolean {
  const normalizedBaseUrl = baseUrl.toLowerCase()
  const normalizedModel = model.toLowerCase()
  return normalizedBaseUrl.includes('openai') ||
    normalizedModel.startsWith('gpt-') ||
    /^o[1234]/.test(normalizedModel)
}

export function isDeepSeekProvider (baseUrl: string, model: string): boolean {
  const normalizedBaseUrl = baseUrl.toLowerCase()
  const normalizedModel = model.toLowerCase()
  return normalizedBaseUrl.includes('deepseek') || normalizedModel.includes('deepseek')
}

export function isAnthropicProvider (baseUrl: string, model: string): boolean {
  const normalizedBaseUrl = baseUrl.toLowerCase()
  const normalizedModel = model.toLowerCase()
  return normalizedBaseUrl.includes('anthropic') || normalizedModel.includes('claude')
}

/**
 * Resolve which wire protocol to use. An explicit provider setting always
 * wins; otherwise a native Anthropic base URL implies the Messages API while
 * everything else (including Claude models served through OpenAI-compatible
 * gateways like OpenRouter) stays on chat/completions.
 */
export function resolveApiProtocol (baseUrl: string, explicit?: ProviderApiProtocol): ProviderApiProtocol {
  if (explicit === 'anthropic' || explicit === 'openai') return explicit
  return baseUrl.toLowerCase().includes('anthropic.com') ? 'anthropic' : 'openai'
}

export function resolveReasoningEffort (
  baseUrl: string,
  model: string,
  enableThinking: boolean,
  reasoningEffort: ProviderReasoningEffort
): ChatCompletionBody['reasoning_effort'] | undefined {
  if (!enableThinking) return undefined

  if (isOpenAIProvider(baseUrl, model) && model.toLowerCase().startsWith('gpt-5')) {
    if (reasoningEffort === 'low') return 'minimal'
    if (reasoningEffort === 'medium') return 'low'
    if (reasoningEffort === 'high') return 'medium'
    return 'high'
  }

  if (isDeepSeekProvider(baseUrl, model)) {
    if (reasoningEffort === 'max') return 'high'
    return reasoningEffort
  }

  if (reasoningEffort === 'max') return 'high'
  return reasoningEffort
}

/**
 * Some OpenAI reasoning models (the o-series and gpt-5) only accept the
 * default sampling temperature and error on any custom value. Detect them so
 * the request omits temperature entirely for those models.
 */
export function modelRejectsCustomTemperature (baseUrl: string, model: string): boolean {
  if (!isOpenAIProvider(baseUrl, model)) return false
  const normalizedModel = model.toLowerCase()
  return normalizedModel.startsWith('gpt-5') || /^o[1-9]/.test(normalizedModel)
}

/**
 * Resolve the temperature to send. Coding/editing benefits from determinism,
 * so the default is low; callers can override via AIConfigInput.temperature
 * for creative work. Returns undefined for models that reject a custom value
 * (the o-series and gpt-5), so the request omits temperature for them.
 */
export function resolveTemperature (baseUrl: string, model: string, temperature?: number): number | undefined {
  if (modelRejectsCustomTemperature(baseUrl, model)) return undefined
  return temperature ?? CODING_TEMPERATURE
}

export function isImageOutputModel (model: string, imageGeneration: boolean): boolean {
  const normalized = model.toLowerCase()
  return imageGeneration ||
    normalized.includes('image-preview') ||
    normalized.includes('gpt-image') ||
    normalized.includes('imagen') ||
    normalized.includes('-image') ||
    normalized.includes('image-') ||
    normalized.includes('flux')
}

/**
 * Returns true when the model is a dedicated image generation model
 * that should use the /images/generations endpoint (DALL-E, gpt-image, etc.).
 */
export function isDedicatedImageModel (model: string): boolean {
  const normalized = model.toLowerCase()
  return normalized.includes('dall-e') ||
    normalized.includes('dalle') ||
    normalized.includes('gpt-image')
}

export function isGptImageModel (model: string): boolean {
  return model.toLowerCase().includes('gpt-image')
}

export function isDallEModel (model: string): boolean {
  const normalized = model.toLowerCase()
  return normalized.includes('dall-e') || normalized.includes('dalle')
}
