export function normalizeBaseUrl (url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  return trimmed.replace(/\/+$/, '')
}

export function getChatCompletionUrl (baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  if (normalized.endsWith('/chat/completions')) {
    return normalized
  }
  return `${normalized}/chat/completions`
}

export function getResponsesUrl (baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  if (normalized.endsWith('/responses')) {
    return normalized
  }
  if (normalized.endsWith('/chat/completions')) {
    return `${normalized.slice(0, -'/chat/completions'.length)}/responses`
  }
  return `${normalized}/responses`
}

export function getImagesGenerationsUrl (baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  if (normalized.endsWith('/images/generations')) {
    return normalized
  }
  if (normalized.endsWith('/chat/completions')) {
    return `${normalized.slice(0, -'/chat/completions'.length)}/images/generations`
  }
  if (normalized.endsWith('/responses')) {
    return `${normalized.slice(0, -'/responses'.length)}/images/generations`
  }
  return `${normalized}/images/generations`
}

export function getImagesEditsUrl (baseUrl: string): string {
  const generationsUrl = getImagesGenerationsUrl(baseUrl)
  return generationsUrl.replace(/\/images\/generations$/, '/images/edits')
}
