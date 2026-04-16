import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import {
  DEFAULT_FETCH_MAX_CHARS,
  DEFAULT_FETCH_TIMEOUT_MS,
  MAX_FETCH_TIMEOUT_MS,
  ABSOLUTE_FETCH_MAX_CHARS,
  decodeHtmlEntities,
  fetchPublicWebpage,
  isBlockedPublicTarget,
  readLimitedResponseText,
  stripHtmlToText,
  type FetchWebpageEntry
} from './web-utils.js'

interface WebSearchArgs {
  query: string
  limit?: number
  auto_fetch_top_n?: number
  fetch_max_chars?: number
  fetch_timeout_ms?: number
}

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
  engine: 'bing'
  results: WebSearchResultItem[]
  fetched_results?: FetchWebpageEntry[]
  auto_fetched_count?: number
  fetched_at: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

const DEFAULT_LIMIT = 6
const MAX_LIMIT = 10
const MAX_AUTO_FETCH = 5
const BING_SEARCH_ENDPOINT = 'https://www.bing.com/search'

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

function normalizeSnippet (raw: string): string {
  return stripHtmlToText(raw)
    .replace(/\s+/g, ' ')
    .trim()
}

async function searchBing (query: string, limit: number): Promise<WebSearchResultItem[]> {
  const searchUrl = new URL(BING_SEARCH_ENDPOINT)
  searchUrl.searchParams.set('format', 'rss')
  searchUrl.searchParams.set('q', query)

  const response = await fetch(searchUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      accept: 'application/rss+xml,application/xml,text/xml;q=0.9,text/plain;q=0.5,*/*;q=0.1',
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

    let parsedUrl: URL
    try {
      parsedUrl = new URL(link)
    } catch {
      continue
    }

    if ((parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') || await isBlockedPublicTarget(parsedUrl)) {
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

export function toolWebSearch (): Tool {
  return {
    definition: {
      name: 'web_search',
      description: 'Search the public web for external documentation, changelogs, or reference material when you do not yet know the exact URL. Use fetch_webpage on the most relevant result URLs after searching.',
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
      const autoFetchTopN = Math.min(Math.max(0, Number(args.auto_fetch_top_n) || 0), MAX_AUTO_FETCH, limit)
      const fetchMaxChars = Math.min(Math.max(500, Number(args.fetch_max_chars) || DEFAULT_FETCH_MAX_CHARS), ABSOLUTE_FETCH_MAX_CHARS)
      const fetchTimeoutMs = Math.min(Math.max(1000, Number(args.fetch_timeout_ms) || DEFAULT_FETCH_TIMEOUT_MS), MAX_FETCH_TIMEOUT_MS)

      if (!query) {
        throw new Error('web_search requires a non-empty query')
      }

      onProgress?.('🔎 Searching the web...', query)
      const results = await searchBing(query, limit)
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
        engine: 'bing',
        results,
        fetched_results: fetchedResults.length > 0 ? fetchedResults : undefined,
        auto_fetched_count: fetchedResults.length > 0 ? fetchedResults.length : undefined,
        fetched_at: new Date().toISOString()
      }
    }
  }
}