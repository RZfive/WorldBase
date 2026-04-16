import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import {
  ABSOLUTE_FETCH_MAX_CHARS,
  DEFAULT_FETCH_MAX_CHARS,
  DEFAULT_FETCH_TIMEOUT_MS,
  MAX_FETCH_TIMEOUT_MS,
  fetchPublicWebpage,
  type FetchWebpageEntry
} from './web-utils.js'

interface FetchWebpageArgs {
  urls: string[]
  query?: string
  max_chars?: number
  timeout_ms?: number
}

interface FetchWebpageResult {
  query?: string
  results: FetchWebpageEntry[]
  success_count: number
  failure_count: number
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

const MAX_URLS = 5

export function toolFetchWebpage (): Tool {
  return {
    definition: {
      name: 'fetch_webpage',
      description: 'Fetch public http(s) web pages and extract readable text or JSON content. Useful for reading external documentation, release notes, API docs, or blog posts. Blocks localhost and private-network targets.',
      parameters: {
        type: 'object',
        properties: {
          urls: {
            type: 'array',
            description: 'One or more public http(s) URLs to fetch. Maximum 5 URLs per call.',
            items: {
              type: 'string'
            }
          },
          query: {
            type: 'string',
            description: 'Optional topic or text to focus on when extracting relevant snippets from the fetched page.'
          },
          max_chars: {
            type: 'integer',
            description: `Maximum characters to return per page. Default ${DEFAULT_FETCH_MAX_CHARS}, maximum ${ABSOLUTE_FETCH_MAX_CHARS}.`
          },
          timeout_ms: {
            type: 'integer',
            description: `Per-request timeout in milliseconds. Default ${DEFAULT_FETCH_TIMEOUT_MS}, maximum ${MAX_FETCH_TIMEOUT_MS}.`
          }
        },
        required: ['urls']
      }
    },
    handler: async (args, onProgress): Promise<FetchWebpageResult> => {
      const { urls, query, max_chars, timeout_ms } = args as unknown as FetchWebpageArgs

      if (!Array.isArray(urls) || urls.length === 0) {
        return {
          query,
          results: [{
            url: '',
            ok: false,
            content: '',
            truncated: false,
            fetched_at: new Date().toISOString(),
            error: 'At least one URL is required'
          }],
          success_count: 0,
          failure_count: 1
        }
      }

      const normalizedUrls = urls.map(String).map(url => url.trim()).filter(Boolean).slice(0, MAX_URLS)
      const maxChars = Math.min(Math.max(500, max_chars || DEFAULT_FETCH_MAX_CHARS), ABSOLUTE_FETCH_MAX_CHARS)
      const timeoutMs = Math.min(Math.max(1000, timeout_ms || DEFAULT_FETCH_TIMEOUT_MS), MAX_FETCH_TIMEOUT_MS)
      const results: FetchWebpageEntry[] = []

      for (let i = 0; i < normalizedUrls.length; i++) {
        const url = normalizedUrls[i]
        onProgress?.('🌐 Fetching webpage...', `${i + 1}/${normalizedUrls.length}: ${url}`)
        const result = await fetchPublicWebpage(url, { query, maxChars, timeoutMs })
        results.push(result)
        onProgress?.({ type: 'web_fetch_result', query, result })
      }

      const successCount = results.filter(result => result.ok).length
      onProgress?.('✅ Web fetch complete', `${successCount}/${results.length} pages fetched successfully`)

      return {
        query,
        results,
        success_count: successCount,
        failure_count: results.length - successCount
      }
    }
  }
}