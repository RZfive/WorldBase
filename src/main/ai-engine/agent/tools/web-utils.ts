import dns from 'node:dns/promises'
import { isIP } from 'node:net'

export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const DEFAULT_FETCH_MAX_CHARS = 12_000
export const ABSOLUTE_FETCH_MAX_CHARS = 40_000
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000
export const MAX_FETCH_TIMEOUT_MS = 30_000

export interface FetchWebpageEntry {
  url: string
  final_url?: string
  ok: boolean
  status?: number
  status_text?: string
  content_type?: string
  title?: string
  description?: string
  content: string
  excerpt_strategy?: 'query_snippets' | 'leading_text'
  query_snippets?: string[]
  query_match_count?: number
  truncated: boolean
  fetched_at: string
  error?: string
}

export interface FetchPublicWebpageOptions {
  query?: string
  maxChars?: number
  timeoutMs?: number
}

export interface SearchLocaleProfile {
  bingLanguage: string
  bingCountry: string
  duckduckgoRegion: string
  acceptLanguage: string
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1'
])

const SEARCH_LOCALE_PROFILES: Array<{ pattern: RegExp; profile: SearchLocaleProfile }> = [
  {
    pattern: /[\u4e00-\u9fff]/,
    profile: {
      bingLanguage: 'zh-CN',
      bingCountry: 'cn',
      duckduckgoRegion: 'cn-zh',
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.7'
    }
  },
  {
    pattern: /[\u3040-\u30ff]/,
    profile: {
      bingLanguage: 'ja-JP',
      bingCountry: 'jp',
      duckduckgoRegion: 'jp-jp',
      acceptLanguage: 'ja-JP,ja;q=0.9,en;q=0.7'
    }
  },
  {
    pattern: /[\uac00-\ud7af]/,
    profile: {
      bingLanguage: 'ko-KR',
      bingCountry: 'kr',
      duckduckgoRegion: 'kr-kr',
      acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.7'
    }
  },
  {
    pattern: /[а-яё]/i,
    profile: {
      bingLanguage: 'ru-RU',
      bingCountry: 'ru',
      duckduckgoRegion: 'ru-ru',
      acceptLanguage: 'ru-RU,ru;q=0.9,en;q=0.7'
    }
  }
]

const DEFAULT_SEARCH_LOCALE_PROFILE: SearchLocaleProfile = {
  bingLanguage: 'en-US',
  bingCountry: 'us',
  duckduckgoRegion: 'us-en',
  acceptLanguage: 'en-US,en;q=0.9'
}

export function detectSearchLocale (query?: string): SearchLocaleProfile {
  const sample = String(query || '').trim()
  for (const entry of SEARCH_LOCALE_PROFILES) {
    if (entry.pattern.test(sample)) {
      return entry.profile
    }
  }
  return DEFAULT_SEARCH_LOCALE_PROFILE
}

export function buildAcceptLanguageHeader (query?: string): string {
  return detectSearchLocale(query).acceptLanguage
}

export function isPrivateIpAddress (address: string): boolean {
  const lower = address.toLowerCase()
  const ipType = isIP(lower)

  if (ipType === 4) {
    const [a, b] = lower.split('.').map(Number)
    if (a === 10) return true
    if (a === 127) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
    return false
  }

  if (ipType === 6) {
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')
  }

  return false
}

export async function isBlockedPublicTarget (target: URL): Promise<boolean> {
  const hostname = target.hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    return true
  }

  if (isPrivateIpAddress(hostname)) {
    return true
  }

  try {
    const resolved = await dns.lookup(hostname, { all: true, verbatim: true })
    return resolved.some(entry => isPrivateIpAddress(entry.address))
  } catch {
    return false
  }
}

export async function readLimitedResponseText (response: Response, maxBytes = DEFAULT_MAX_RESPONSE_BYTES): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') || '0')
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Response too large: ${contentLength} bytes (max ${maxBytes})`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > maxBytes) {
    throw new Error(`Response body exceeded ${maxBytes} bytes`)
  }

  return buffer.toString('utf-8')
}

export function decodeHtmlEntities (input: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' '
  }

  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase()
    if (normalized[0] === '#') {
      const isHex = normalized[1] === 'x'
      const value = Number.parseInt(normalized.slice(isHex ? 2 : 1), isHex ? 16 : 10)
      return Number.isFinite(value) ? String.fromCodePoint(value) : match
    }

    return namedEntities[normalized] || match
  })
}

export function stripHtmlToText (input: string): string {
  return decodeHtmlEntities(input)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractMetaContent (html: string, attrName: string, attrValue: string): string | undefined {
  const regex = new RegExp(`<meta[^>]+${attrName}=["']${attrValue}["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+${attrName}=["']${attrValue}["'][^>]*>`, 'i')
  const match = html.match(regex)
  const content = match?.[1] || match?.[2]
  return content ? decodeHtmlEntities(content.trim()) : undefined
}

function extractPrimaryContentHtml (html: string, sourceUrl?: string): string {
  let hostname = ''
  try {
    hostname = sourceUrl ? new URL(sourceUrl).hostname.toLowerCase() : ''
  } catch {
    hostname = ''
  }

  if (hostname === 'github.com') {
    const githubReadme = html.match(/<article[^>]+class=["'][^"']*markdown-body[^"']*["'][\s\S]*?<\/article>/i)
    if (githubReadme?.[0]) {
      return githubReadme[0]
    }
  }

  const focusedPatterns = [
    /<main\b[\s\S]*?<\/main>/i,
    /<article\b[\s\S]*?<\/article>/i,
    /<section\b[^>]+(?:id|class)=["'][^"']*(?:content|documentation|docs|article|post|readme|markdown-body)[^"']*["'][\s\S]*?<\/section>/i
  ]

  for (const pattern of focusedPatterns) {
    const match = html.match(pattern)
    if (match?.[0]) {
      return match[0]
    }
  }

  return html
}

function htmlFragmentToText (html: string): string {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|nav|footer|header|aside|form|dialog)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match, code: string) => `\n\n${stripHtmlToText(code)}\n\n`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_match, code: string) => ` ${stripHtmlToText(code)} `)
    .replace(/<(br|\/p|\/div|\/section|\/article|\/li|\/ul|\/ol|\/tr|\/table|\/h[1-6]|\/header|\/footer|\/main|\/aside)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<tr[^>]*>/gi, '\n')
    .replace(/<td[^>]*>/gi, ' ')
    .replace(/<th[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')

  return decodeHtmlEntities(withoutNoise)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function extractReadableTextFromHtml (html: string, sourceUrl?: string): { title?: string; description?: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/\s+/g, ' ').trim()) : undefined
  const description = extractMetaContent(html, 'name', 'description') || extractMetaContent(html, 'property', 'og:description')

  const focusedHtml = extractPrimaryContentHtml(html, sourceUrl)
  const focusedText = htmlFragmentToText(focusedHtml)
  const fallbackText = focusedHtml === html ? focusedText : htmlFragmentToText(html)
  const text = focusedText.length >= Math.min(400, fallbackText.length) ? focusedText : fallbackText

  return { title, description, text }
}

function buildSearchTerms (query?: string): string[] {
  const trimmed = (query || '').trim().toLowerCase()
  if (!trimmed) return []

  if (/[\u4e00-\u9fff]/.test(trimmed) && !/\s/.test(trimmed)) {
    return [trimmed]
  }

  const terms = trimmed.split(/[^a-z0-9\u4e00-\u9fff]+/i).filter(term => term.length >= 2)
  return Array.from(new Set(terms)).slice(0, 8)
}

function truncatePreservingWords (text: string, limit: number): { content: string; truncated: boolean } {
  if (text.length <= limit) {
    return { content: text, truncated: false }
  }

  const slice = text.slice(0, limit)
  const lastBreak = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '))
  const end = lastBreak > limit * 0.7 ? lastBreak : limit
  return {
    content: `${slice.slice(0, end).trimEnd()}\n\n...[truncated]...`,
    truncated: true
  }
}

function extractRelevantSnippets (text: string, query?: string): string[] {
  const terms = buildSearchTerms(query)
  if (terms.length === 0) return []

  const blocks = text
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean)

  const scored = blocks
    .map((block, index) => {
      const lower = block.toLowerCase()
      let score = 0
      for (const term of terms) {
        if (lower.includes(term)) {
          score += 1
        }
      }
      return { block, index, score }
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 5)
    .map(entry => truncatePreservingWords(entry.block, 500).content)

  return Array.from(new Set(scored))
}

function formatFetchedContent (sourceText: string, maxChars: number, query?: string): { content: string; truncated: boolean; strategy: 'query_snippets' | 'leading_text'; snippets: string[] } {
  const snippets = extractRelevantSnippets(sourceText, query)

  if (snippets.length > 0) {
    const merged = snippets.join('\n\n---\n\n')
    const truncated = truncatePreservingWords(merged, maxChars)
    return {
      content: truncated.content,
      truncated: truncated.truncated,
      strategy: 'query_snippets',
      snippets
    }
  }

  const leading = truncatePreservingWords(sourceText, maxChars)
  return {
    content: leading.content,
    truncated: leading.truncated,
    strategy: 'leading_text',
    snippets: []
  }
}

export async function fetchPublicWebpage (rawUrl: string, options: FetchPublicWebpageOptions = {}): Promise<FetchWebpageEntry> {
  const fetchedAt = new Date().toISOString()

  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawUrl)
  } catch {
    return {
      url: rawUrl,
      ok: false,
      content: '',
      truncated: false,
      fetched_at: fetchedAt,
      error: 'Invalid URL'
    }
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return {
      url: rawUrl,
      ok: false,
      content: '',
      truncated: false,
      fetched_at: fetchedAt,
      error: 'Only http and https URLs are allowed'
    }
  }

  if (await isBlockedPublicTarget(parsedUrl)) {
    return {
      url: rawUrl,
      ok: false,
      content: '',
      truncated: false,
      fetched_at: fetchedAt,
      error: 'Blocked target host'
    }
  }

  const maxChars = Math.min(Math.max(500, options.maxChars || DEFAULT_FETCH_MAX_CHARS), ABSOLUTE_FETCH_MAX_CHARS)
  const timeoutMs = Math.min(Math.max(1000, options.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS), MAX_FETCH_TIMEOUT_MS)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(parsedUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,text/*;q=0.8,*/*;q=0.2',
        'accept-language': buildAcceptLanguageHeader(options.query),
        'user-agent': 'WorldBase AI Agent/1.0'
      }
    })

    const contentType = (response.headers.get('content-type') || '').toLowerCase()
    const responseText = await readLimitedResponseText(response)
    let title: string | undefined
    let description: string | undefined
    let sourceText = responseText

    if (contentType.includes('html') || contentType.includes('xml')) {
      const extracted = extractReadableTextFromHtml(responseText, response.url || parsedUrl.toString())
      title = extracted.title
      description = extracted.description
      sourceText = extracted.text
    } else if (contentType.includes('json')) {
      try {
        sourceText = JSON.stringify(JSON.parse(responseText), null, 2)
      } catch {
        sourceText = responseText
      }
    } else if (!contentType.includes('text') && contentType) {
      return {
        url: rawUrl,
        final_url: response.url,
        ok: false,
        status: response.status,
        status_text: response.statusText,
        content_type: contentType,
        content: '',
        truncated: false,
        fetched_at: fetchedAt,
        error: `Unsupported content type: ${contentType}`
      }
    }

    const formatted = formatFetchedContent(sourceText, maxChars, options.query)

    return {
      url: rawUrl,
      final_url: response.url,
      ok: response.ok,
      status: response.status,
      status_text: response.statusText,
      content_type: contentType || undefined,
      title,
      description,
      content: formatted.content,
      excerpt_strategy: formatted.strategy,
      query_snippets: formatted.snippets.length > 0 ? formatted.snippets : undefined,
      query_match_count: formatted.snippets.length > 0 ? formatted.snippets.length : undefined,
      truncated: formatted.truncated,
      fetched_at: fetchedAt,
      error: response.ok ? undefined : `HTTP ${response.status} ${response.statusText}`
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      url: rawUrl,
      ok: false,
      content: '',
      truncated: false,
      fetched_at: fetchedAt,
      error: message
    }
  } finally {
    clearTimeout(timer)
  }
}
