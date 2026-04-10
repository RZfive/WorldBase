export interface SavedWebApp {
  id: string
  kind: 'web'
  type: 'browser'
  name: string
  url: string
  icon?: string
  createdAt: string
  updatedAt: string
}

function hashString (value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

export function normalizeWebUrlInput (input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

export function canInterpretAsWebUrl (input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed) return false
  return normalizeWebUrlInput(trimmed) !== null
}

export function getWebAppNameFromUrl (value: string | URL): string {
  const url = typeof value === 'string' ? new URL(value) : value
  let pathLabel = ''
  if (url.pathname && url.pathname !== '/') {
    const rawSegment = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean).slice(-1)[0] || ''
    try {
      pathLabel = decodeURIComponent(rawSegment)
    } catch {
      pathLabel = rawSegment
    }
  }
  return pathLabel ? `${url.hostname}/${pathLabel}` : url.hostname
}

export function createWebAppId (url: string): string {
  const normalizedUrl = normalizeWebUrlInput(url) || url.trim()
  const parsed = new URL(normalizedUrl)
  const slugSource = `${parsed.hostname}${parsed.pathname}`.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'site'
  return `web_${slugSource.slice(0, 48)}_${hashString(normalizedUrl)}`
}