import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import {
  DEFAULT_FETCH_MAX_CHARS,
  DEFAULT_FETCH_TIMEOUT_MS,
  MAX_FETCH_TIMEOUT_MS,
  ABSOLUTE_FETCH_MAX_CHARS,
  buildAcceptLanguageHeader,
  decodeHtmlEntities,
  detectSearchLocale,
  fetchPublicWebpage,
  isBlockedPublicTarget,
  readLimitedResponseText,
  stripHtmlToText,
  type FetchWebpageEntry
} from './web-utils.js'

interface WebSearchArgs {
  query: string
  limit?: number
  sources?: SearchSource[]
  allowed_domains?: string[]
  blocked_domains?: string[]
  auto_fetch_top_n?: number
  fetch_max_chars?: number
  fetch_timeout_ms?: number
}

type SearchSource = 'bing' | 'duckduckgo' | 'github'

export interface WebSearchResultItem {
  rank: number
  title: string
  url: string
  snippet: string
  source: string
  published_at?: string
}

interface WebSearchResult {
  query: string
  engine: string
  sources_used: SearchSource[]
  query_variants?: string[]
  results: WebSearchResultItem[]
  source_errors?: Array<{ source: SearchSource; error: string }>
  fetched_results?: FetchWebpageEntry[]
  auto_fetched_count?: number
  fetched_at: string
}

interface SearchCandidate extends WebSearchResultItem {
  search_engine: SearchSource
  score: number
  matched_terms: string[]
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

const DEFAULT_LIMIT = 6
const MAX_LIMIT = 10
const MAX_AUTO_FETCH = 5
const MAX_QUERY_VARIANTS = 2
const SEARCH_CANDIDATE_FACTOR = 3
const BING_SEARCH_ENDPOINT = 'https://www.bing.com/search'
const DUCKDUCKGO_SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/'
const GITHUB_REPOSITORY_SEARCH_ENDPOINT = 'https://api.github.com/search/repositories'
const VALID_SEARCH_SOURCES: SearchSource[] = ['bing', 'duckduckgo', 'github']
const DEFAULT_SEARCH_SOURCES: SearchSource[] = ['bing', 'duckduckgo']
const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'for', 'with', 'from', 'into', 'about', 'that', 'this', 'those', 'these',
  'public', 'list', 'testing', 'test', 'latest', 'current', 'official', 'available'
])

const DOC_HOST_HINT = /(docs?|developer|api|reference|guide|readme|github|npmjs|pypi|modelcontextprotocol|readthedocs|mozilla|microsoft|openai|anthropic)/i
const LOW_SIGNAL_TITLE_HINT = /(sign in|login|store(?:\s|$)|shop|buy|cart|product|iphone|store locator|training support|certification|account)/i
const TECH_QUERY_HINT = /(\bmcp\b|model context protocol|github|repo|repository|package|sdk|api|docs?|documentation|server|protocol|typescript|javascript|node|python|java|go|rust|react|vue|release|changelog|library|tool)/i

function normalizeHostname (value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, '')
}

function normalizeDomainFilters (value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(
    value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map(item => normalizeHostname(item))
  ))
}

function matchesDomainFilter (hostname: string, domain: string): boolean {
  const normalizedHostname = normalizeHostname(hostname)
  const normalizedDomain = normalizeHostname(domain)
  return normalizedHostname === normalizedDomain || normalizedHostname.endsWith(`.${normalizedDomain}`)
}

function isTechnicalQuery (query: string): boolean {
  return TECH_QUERY_HINT.test(query)
}

function buildSearchTerms (query: string): string[] {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return []

  if (/[\u4e00-\u9fff]/.test(trimmed) && !/\s/.test(trimmed)) {
    return [trimmed]
  }

  return Array.from(new Set(
    trimmed
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map(term => term.trim())
      .filter(term => term.length >= 2 && !SEARCH_STOP_WORDS.has(term))
  )).slice(0, 12)
}

function buildSearchQueryVariants (query: string): string[] {
  const variants = [query.trim()]
  if (/\bmcp\b/i.test(query) && !/model context protocol/i.test(query)) {
    variants.push(query.replace(/\bmcp\b/ig, 'Model Context Protocol'))
  }
  return Array.from(new Set(variants.filter(Boolean))).slice(0, MAX_QUERY_VARIANTS)
}

function resolveSearchSources (value: unknown, query: string): SearchSource[] {
  if (Array.isArray(value)) {
    const requested = Array.from(new Set(
      value.filter((item): item is SearchSource => typeof item === 'string' && VALID_SEARCH_SOURCES.includes(item as SearchSource))
    ))
    if (requested.length > 0) return requested
  }

  const resolved = [...DEFAULT_SEARCH_SOURCES]
  if (isTechnicalQuery(query)) {
    resolved.push('github')
  }
  return Array.from(new Set(resolved))
}

function normalizeSnippet (raw: string): string {
  return stripHtmlToText(raw)
    .replace(/\s+/g, ' ')
    .trim()
}

function unwrapDuckDuckGoUrl (rawHref: string): string {
  const decodedHref = decodeHtmlEntities(rawHref).trim()
  if (!decodedHref) return ''

  const absoluteHref = decodedHref.startsWith('//') ? `https:${decodedHref}` : decodedHref
  try {
    const parsed = new URL(absoluteHref, DUCKDUCKGO_SEARCH_ENDPOINT)
    const redirected = parsed.searchParams.get('uddg')
    return redirected ? decodeURIComponent(redirected) : parsed.toString()
  } catch {
    return absoluteHref
  }
}

function sourcePriority (source: SearchSource, techQuery: boolean): number {
  if (!techQuery) {
    return source === 'duckduckgo' ? 2 : (source === 'bing' ? 1 : 0)
  }

  if (source === 'github') return 3
  if (source === 'duckduckgo') return 2
  return 1
}

function scoreSearchCandidate (candidate: WebSearchResultItem, query: string, terms: string[], techQuery: boolean): { score: number; matchedTerms: string[] } {
  const title = candidate.title.toLowerCase()
  const snippet = candidate.snippet.toLowerCase()
  const url = candidate.url.toLowerCase()
  const source = candidate.source.toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()

  let score = 0
  const matchedTerms = new Set<string>()

  if (normalizedQuery && (title.includes(normalizedQuery) || snippet.includes(normalizedQuery) || url.includes(normalizedQuery))) {
    score += 14
  }

  for (const term of terms) {
    if (title.includes(term)) {
      score += 7
      matchedTerms.add(term)
      continue
    }
    if (url.includes(term)) {
      score += 5
      matchedTerms.add(term)
      continue
    }
    if (snippet.includes(term)) {
      score += 4
      matchedTerms.add(term)
    }
  }

  if (DOC_HOST_HINT.test(source) || DOC_HOST_HINT.test(url) || DOC_HOST_HINT.test(title)) {
    score += 4
  }

  if (techQuery && source === 'github.com') {
    score += 5
  }

  if (LOW_SIGNAL_TITLE_HINT.test(title) || LOW_SIGNAL_TITLE_HINT.test(url)) {
    score -= 8
  }

  if (terms.length >= 3 && matchedTerms.size <= 1) {
    score -= 6
  }

  return {
    score,
    matchedTerms: Array.from(matchedTerms)
  }
}

async function buildUrlValidator (allowedDomains: string[], blockedDomains: string[]) {
  const hostSafetyCache = new Map<string, boolean>()

  return async (rawUrl: string): Promise<URL | null> => {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(rawUrl)
    } catch {
      return null
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return null
    }

    const hostname = normalizeHostname(parsedUrl.hostname)
    if (blockedDomains.some(domain => matchesDomainFilter(hostname, domain))) {
      return null
    }
    if (allowedDomains.length > 0 && !allowedDomains.some(domain => matchesDomainFilter(hostname, domain))) {
      return null
    }

    if (!hostSafetyCache.has(hostname)) {
      hostSafetyCache.set(hostname, await isBlockedPublicTarget(parsedUrl))
    }
    if (hostSafetyCache.get(hostname)) {
      return null
    }

    return parsedUrl
  }
}

function unwrapXmlValue (value: string | undefined): string {
  if (!value) return ''
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .trim()
}

function extractXmlTag (xml: string, tagName: string): string {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\/${tagName}>`, 'i'))
  return unwrapXmlValue(match?.[1])
}

async function searchBing (
  query: string,
  limit: number,
  validateUrl: (rawUrl: string) => Promise<URL | null>
): Promise<WebSearchResultItem[]> {
  const locale = detectSearchLocale(query)
  const searchUrl = new URL(BING_SEARCH_ENDPOINT)
  searchUrl.searchParams.set('format', 'rss')
  searchUrl.searchParams.set('q', query)
  searchUrl.searchParams.set('cc', locale.bingCountry)
  searchUrl.searchParams.set('setlang', locale.bingLanguage)

  const response = await fetch(searchUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      accept: 'application/rss+xml,application/xml,text/xml;q=0.9,text/plain;q=0.5,*/*;q=0.1',
      'accept-language': buildAcceptLanguageHeader(query),
      'user-agent': 'The World AI Agent/1.0'
    }
  })

  if (!response.ok) {
    throw new Error(`Search request failed: HTTP ${response.status} ${response.statusText}`)
  }

  const xml = await readLimitedResponseText(response)
  const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/gi) || []
  const results: WebSearchResultItem[] = []
  const seenUrls = new Set<string>()

  for (const [index, itemXml] of itemMatches.entries()) {
    const title = decodeHtmlEntities(extractXmlTag(itemXml, 'title'))
    const link = decodeHtmlEntities(extractXmlTag(itemXml, 'link'))
    const snippet = normalizeSnippet(extractXmlTag(itemXml, 'description'))
    const publishedAtRaw = extractXmlTag(itemXml, 'pubDate')

    if (!link) continue

    const parsedUrl = await validateUrl(link)
    if (!parsedUrl) {
      continue
    }

    const normalizedUrl = parsedUrl.toString()
    if (seenUrls.has(normalizedUrl)) continue
    seenUrls.add(normalizedUrl)

    const publishedAt = Date.parse(publishedAtRaw)
    results.push({
      rank: results.length + 1,
      title: title || normalizedUrl,
      url: normalizedUrl,
      snippet,
      source: parsedUrl.hostname.replace(/^www\./, ''),
      published_at: Number.isFinite(publishedAt) ? new Date(publishedAt).toISOString() : undefined
    })

    if (results.length >= limit) break
    if (index >= MAX_LIMIT * 3) break
  }

  return results
}

async function searchDuckDuckGo (
  query: string,
  limit: number,
  validateUrl: (rawUrl: string) => Promise<URL | null>
): Promise<WebSearchResultItem[]> {
  const locale = detectSearchLocale(query)
  const searchUrl = new URL(DUCKDUCKGO_SEARCH_ENDPOINT)
  searchUrl.searchParams.set('q', query)
  searchUrl.searchParams.set('kl', locale.duckduckgoRegion)

  const response = await fetch(searchUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
      'accept-language': buildAcceptLanguageHeader(query),
      'user-agent': 'The World AI Agent/1.0'
    }
  })

  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: HTTP ${response.status} ${response.statusText}`)
  }

  const html = await readLimitedResponseText(response)
  const results: WebSearchResultItem[] = []
  const seenUrls = new Set<string>()
  const titleRegex = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  let scanned = 0

  while ((match = titleRegex.exec(html)) && results.length < limit && scanned < limit * SEARCH_CANDIDATE_FACTOR) {
    scanned += 1
    const rawHref = match[1]
    const title = normalizeSnippet(match[2])
    const snippetWindow = html.slice(match.index, Math.min(html.length, match.index + 2500))
    const snippetMatch = snippetWindow.match(/<(?:a|div)[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i)
    const snippet = normalizeSnippet(snippetMatch?.[1] || '')
    const resolvedUrl = unwrapDuckDuckGoUrl(rawHref)
    const parsedUrl = await validateUrl(resolvedUrl)
    if (!parsedUrl) continue

    const normalizedUrl = parsedUrl.toString()
    if (seenUrls.has(normalizedUrl)) continue
    seenUrls.add(normalizedUrl)

    results.push({
      rank: results.length + 1,
      title: title || normalizedUrl,
      url: normalizedUrl,
      snippet,
      source: parsedUrl.hostname.replace(/^www\./, '')
    })
  }

  return results
}

async function searchGitHubRepositories (
  query: string,
  limit: number,
  validateUrl: (rawUrl: string) => Promise<URL | null>
): Promise<WebSearchResultItem[]> {
  const searchUrl = new URL(GITHUB_REPOSITORY_SEARCH_ENDPOINT)
  searchUrl.searchParams.set('q', query)
  searchUrl.searchParams.set('sort', 'stars')
  searchUrl.searchParams.set('order', 'desc')
  searchUrl.searchParams.set('per_page', String(Math.min(limit * 2, MAX_LIMIT * 2)))

  const response = await fetch(searchUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'The World AI Agent/1.0'
    }
  })

  if (response.status === 403 || response.status === 429) {
    throw new Error('GitHub repository search is temporarily rate-limited')
  }

  if (!response.ok) {
    throw new Error(`GitHub repository search failed: HTTP ${response.status} ${response.statusText}`)
  }

  const payload = JSON.parse(await readLimitedResponseText(response)) as {
    items?: Array<{
      html_url?: string
      full_name?: string
      description?: string | null
      language?: string | null
      stargazers_count?: number
      topics?: string[]
    }>
  }

  const results: WebSearchResultItem[] = []
  const seenUrls = new Set<string>()

  for (const item of payload.items || []) {
    const repositoryUrl = typeof item.html_url === 'string' ? item.html_url : ''
    const parsedUrl = await validateUrl(repositoryUrl)
    if (!parsedUrl) continue

    const normalizedUrl = parsedUrl.toString()
    if (seenUrls.has(normalizedUrl)) continue
    seenUrls.add(normalizedUrl)

    const parts = [item.description || '']
    if (typeof item.language === 'string' && item.language.trim()) {
      parts.push(`Language: ${item.language.trim()}`)
    }
    if (typeof item.stargazers_count === 'number' && Number.isFinite(item.stargazers_count)) {
      parts.push(`Stars: ${item.stargazers_count}`)
    }
    if (Array.isArray(item.topics) && item.topics.length > 0) {
      parts.push(`Topics: ${item.topics.slice(0, 6).join(', ')}`)
    }

    results.push({
      rank: results.length + 1,
      title: item.full_name || normalizedUrl,
      url: normalizedUrl,
      snippet: parts.filter(Boolean).join(' · '),
      source: parsedUrl.hostname.replace(/^www\./, '')
    })

    if (results.length >= limit) break
  }

  return results
}

async function searchBySource (
  source: SearchSource,
  query: string,
  limit: number,
  validateUrl: (rawUrl: string) => Promise<URL | null>
): Promise<WebSearchResultItem[]> {
  if (source === 'duckduckgo') {
    return searchDuckDuckGo(query, limit, validateUrl)
  }
  if (source === 'github') {
    return searchGitHubRepositories(query, limit, validateUrl)
  }
  return searchBing(query, limit, validateUrl)
}

function rerankSearchResults (candidates: SearchCandidate[], query: string, limit: number): WebSearchResultItem[] {
  const queryVariants = buildSearchQueryVariants(query)
  const scoringTerms = Array.from(new Set(queryVariants.flatMap(buildSearchTerms)))
  const techQuery = isTechnicalQuery(query)
  const deduped = new Map<string, SearchCandidate>()

  for (const candidate of candidates) {
    const evaluated = scoreSearchCandidate(candidate, query, scoringTerms, techQuery)
    const nextCandidate: SearchCandidate = {
      ...candidate,
      score: evaluated.score + sourcePriority(candidate.search_engine, techQuery),
      matched_terms: evaluated.matchedTerms
    }

    const existing = deduped.get(candidate.url)
    if (!existing || nextCandidate.score > existing.score) {
      deduped.set(candidate.url, nextCandidate)
    }
  }

  const ranked = Array.from(deduped.values())
    .filter(candidate => candidate.score > 0 && (candidate.matched_terms.length > 0 || candidate.title.toLowerCase().includes(query.toLowerCase()) || candidate.snippet.toLowerCase().includes(query.toLowerCase())))
    .sort((left, right) => right.score - left.score || right.matched_terms.length - left.matched_terms.length || left.rank - right.rank)
    .slice(0, limit)

  const fallback = ranked.length > 0
    ? ranked
    : Array.from(deduped.values())
      .sort((left, right) => right.score - left.score || left.rank - right.rank)
      .slice(0, limit)

  return fallback.map((candidate, index) => ({
    rank: index + 1,
    title: candidate.title,
    url: candidate.url,
    snippet: candidate.snippet,
    source: candidate.source,
    published_at: candidate.published_at
  }))
}

export function toolWebSearch (): Tool {
  return {
    definition: {
      name: 'web_search',
      description: 'Search the public web for external documentation, changelogs, registry pages, repositories, or other reference material when you do not yet know the exact URL. Uses multiple search sources, reranks results by query relevance, and supports domain allow/block filters similar to Claude Code web search.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query describing the topic you need to find.'
          },
          limit: {
            type: 'integer',
            description: `Maximum number of search results to return. Default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}.`
          },
          sources: {
            type: 'array',
            description: 'Optional search sources to use. Supported: bing, duckduckgo, github. Defaults to multiple sources automatically chosen by the query.',
            items: {
              type: 'string',
              enum: VALID_SEARCH_SOURCES
            }
          },
          allowed_domains: {
            type: 'array',
            description: 'Optional allowlist of result domains. Only results from these domains or their subdomains will be returned.',
            items: {
              type: 'string'
            }
          },
          blocked_domains: {
            type: 'array',
            description: 'Optional blocklist of result domains. Results from these domains or their subdomains will be excluded.',
            items: {
              type: 'string'
            }
          },
          auto_fetch_top_n: {
            type: 'integer',
            description: `Automatically fetch the top N result pages after searching. Optional. Maximum ${MAX_AUTO_FETCH}.`
          },
          fetch_max_chars: {
            type: 'integer',
            description: `When auto_fetch_top_n is used, maximum characters to return per fetched page. Default ${DEFAULT_FETCH_MAX_CHARS}, maximum ${ABSOLUTE_FETCH_MAX_CHARS}.`
          },
          fetch_timeout_ms: {
            type: 'integer',
            description: `When auto_fetch_top_n is used, per-page fetch timeout in milliseconds. Default ${DEFAULT_FETCH_TIMEOUT_MS}, maximum ${MAX_FETCH_TIMEOUT_MS}.`
          }
        },
        required: ['query']
      }
    },
    handler: async (args, onProgress): Promise<WebSearchResult> => {
      const query = String(args.query || '').trim()
      const limit = Math.min(Math.max(1, Number(args.limit) || DEFAULT_LIMIT), MAX_LIMIT)
      const sources = resolveSearchSources(args.sources, query)
      const allowedDomains = normalizeDomainFilters((args as unknown as WebSearchArgs).allowed_domains)
      const blockedDomains = normalizeDomainFilters((args as unknown as WebSearchArgs).blocked_domains)
      const autoFetchTopN = Math.min(Math.max(0, Number(args.auto_fetch_top_n) || 0), MAX_AUTO_FETCH, limit)
      const fetchMaxChars = Math.min(Math.max(500, Number(args.fetch_max_chars) || DEFAULT_FETCH_MAX_CHARS), ABSOLUTE_FETCH_MAX_CHARS)
      const fetchTimeoutMs = Math.min(Math.max(1000, Number(args.fetch_timeout_ms) || DEFAULT_FETCH_TIMEOUT_MS), MAX_FETCH_TIMEOUT_MS)

      if (!query) {
        throw new Error('web_search requires a non-empty query')
      }
      if (allowedDomains.length > 0 && blockedDomains.length > 0) {
        throw new Error('web_search cannot use allowed_domains and blocked_domains in the same request')
      }

      const queryVariants = buildSearchQueryVariants(query)
      const validateUrl = await buildUrlValidator(allowedDomains, blockedDomains)
      const candidateLimit = Math.min(MAX_LIMIT * SEARCH_CANDIDATE_FACTOR, limit * SEARCH_CANDIDATE_FACTOR)

      onProgress?.('🔎 Searching the web...', `${query} (${sources.join(', ')})`)
      const searchTasks = sources.flatMap(source => {
        return queryVariants.map(async (queryVariant) => {
          const items = await searchBySource(source, queryVariant, candidateLimit, validateUrl)
          return items.map((item): SearchCandidate => ({
            ...item,
            search_engine: source,
            score: 0,
            matched_terms: []
          }))
        })
      })

      const settled = await Promise.allSettled(searchTasks)
      const sourceErrors: Array<{ source: SearchSource; error: string }> = []
      const candidates: SearchCandidate[] = []

      let taskIndex = 0
      for (const source of sources) {
        for (const _queryVariant of queryVariants) {
          const taskResult = settled[taskIndex]
          if (taskResult.status === 'fulfilled') {
            candidates.push(...taskResult.value)
          } else {
            sourceErrors.push({
              source,
              error: taskResult.reason instanceof Error ? taskResult.reason.message : String(taskResult.reason)
            })
          }
          taskIndex += 1
        }
      }

      const results = rerankSearchResults(candidates, query, limit)
      const fetchedResults: FetchWebpageEntry[] = []

      onProgress?.({ type: 'web_search_result', query, engine: 'bing', results })

      if (autoFetchTopN > 0) {
        const fetchCandidates = results.slice(0, autoFetchTopN)
        onProgress?.('🌐 Auto-fetching top search results...', `${fetchCandidates.length} pages`)

        for (let index = 0; index < fetchCandidates.length; index++) {
          const candidate = fetchCandidates[index]
          onProgress?.('🌐 Fetching webpage...', `${index + 1}/${fetchCandidates.length}: ${candidate.url}`)
          const fetched = await fetchPublicWebpage(candidate.url, {
            query,
            maxChars: fetchMaxChars,
            timeoutMs: fetchTimeoutMs
          })
          fetchedResults.push(fetched)
          onProgress?.({ type: 'web_fetch_result', query, result: fetched })
        }
      }

      onProgress?.('✅ Web search complete', `${results.length} results`)

      return {
        query,
        engine: sources.join(' + '),
        sources_used: sources,
        query_variants: queryVariants.length > 1 ? queryVariants : undefined,
        results,
        source_errors: sourceErrors.length > 0 ? sourceErrors : undefined,
        fetched_results: fetchedResults.length > 0 ? fetchedResults : undefined,
        auto_fetched_count: fetchedResults.length > 0 ? fetchedResults.length : undefined,
        fetched_at: new Date().toISOString()
      }
    }
  }
}