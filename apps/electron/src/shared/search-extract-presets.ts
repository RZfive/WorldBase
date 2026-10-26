/**
 * Search-result page extraction presets used by the built-in workspace
 * browser (`read_current_page` mode "search_results"). Selectors are kept
 * intentionally small and list-shaped so the extraction stays cheap and does
 * not depend on any specific engine's markup beyond its result list.
 */
export interface SearchExtractPreset {
  id: string
  /** Host suffixes that select this preset. */
  hosts: string[]
  /** Optional hostname regexes for regional/country domains. */
  hostPatterns?: string[]
  /** Candidate result containers, tried in order. */
  resultSelectors: string[]
  titleSelectors: string[]
  snippetSelectors: string[]
  linkSelectors: string[]
}

export const SEARCH_EXTRACT_PRESETS: SearchExtractPreset[] = [
  {
    id: 'bing',
    hosts: ['bing.com'],
    resultSelectors: ['#b_results > li.b_algo', '#b_results > li'],
    titleSelectors: ['h2 a', 'h2'],
    snippetSelectors: ['.b_caption p', '.b_lineclamp2', '.b_lineclamp3', 'p'],
    linkSelectors: ['h2 a', 'a']
  },
  {
    id: 'duckduckgo',
    hosts: ['duckduckgo.com'],
    resultSelectors: ['[data-testid="result"]', '.result', '.results_links'],
    titleSelectors: ['[data-testid="result-title-a"]', 'h2 a', 'h2'],
    snippetSelectors: ['[data-result="snippet"]', '.result__snippet', 'p'],
    linkSelectors: ['[data-testid="result-title-a"]', 'h2 a', 'a']
  },
  {
    id: 'google',
    hosts: ['google.com'],
    hostPatterns: ['(^|\\.)google\\.[a-z]{2,3}(\\.[a-z]{2})?$'],
    resultSelectors: ['div.MjjYud', 'div.g', 'div[data-hveid]'],
    titleSelectors: ['h3', 'h2'],
    snippetSelectors: ['[data-sncf]', '.VwiC3b', 'div[style*="-webkit-line-clamp"]', 'span'],
    linkSelectors: ['a[href^="http"]', 'a']
  },
  {
    id: 'brave',
    hosts: ['search.brave.com'],
    resultSelectors: ['#results .snippet[data-type="web"]', '#results .snippet', '.snippet'],
    titleSelectors: ['.title', 'a .title', 'h3'],
    snippetSelectors: ['.snippet-description', '.snippet-content', 'p'],
    linkSelectors: ['a[href]']
  },
  {
    id: 'startpage',
    hosts: ['startpage.com'],
    resultSelectors: ['.w-gl__result', '.result'],
    titleSelectors: ['.w-gl__result-title', 'h3', 'h2'],
    snippetSelectors: ['.w-gl__description', 'p'],
    linkSelectors: ['.w-gl__result-title a', 'a[href]']
  },
  {
    id: 'ecosia',
    hosts: ['ecosia.org'],
    resultSelectors: ['article.result', '.result'],
    titleSelectors: ['.result__title a', 'h2 a', 'h2'],
    snippetSelectors: ['.result__description', 'p'],
    linkSelectors: ['.result__title a', 'a[href]']
  },
  {
    id: 'baidu',
    hosts: ['baidu.com'],
    resultSelectors: ['#content_left > div.result', '#content_left > div[class*="result"]', '#content_left div.c-container'],
    titleSelectors: ['h3 a', 'h3'],
    snippetSelectors: ['[class*="content-right"]', '.c-abstract', '[class*="abstract"]'],
    linkSelectors: ['h3 a', 'a[href]']
  },
  {
    id: 'sogou',
    hosts: ['sogou.com'],
    resultSelectors: ['.vrwrap', '.rb'],
    titleSelectors: ['h3 a', 'h3'],
    snippetSelectors: ['.str_info', '.text-layout', '[class*="abstract"]'],
    linkSelectors: ['h3 a', 'a[href]']
  },
  {
    id: 'yandex',
    hosts: ['yandex.com', 'yandex.ru'],
    hostPatterns: ['(^|\\.)yandex\\.[a-z]{2,3}$'],
    resultSelectors: ['.serp-item', 'li.serp-item'],
    titleSelectors: ['.OrganicTitle-Link', 'h2 a', 'h2'],
    snippetSelectors: ['.OrganicTextContentSpan', '.TextContainer', 'p'],
    linkSelectors: ['.OrganicTitle-Link', 'h2 a', 'a[href]']
  },
  {
    id: 'github',
    hosts: ['github.com'],
    resultSelectors: ['.search-title', '.repo-list-item', '[data-testid="results-list"] > div'],
    titleSelectors: ['a', 'h3'],
    snippetSelectors: ['p', '.mb-1'],
    linkSelectors: ['a[href]']
  }
]

function matchesPresetHost (preset: SearchExtractPreset, host: string): boolean {
  if (preset.hosts.some(candidate => host === candidate || host.endsWith(`.${candidate}`))) return true
  return (preset.hostPatterns || []).some(pattern => {
    try {
      return new RegExp(pattern).test(host)
    } catch {
      return false
    }
  })
}

export function findSearchExtractPreset (url: string): SearchExtractPreset | null {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  return SEARCH_EXTRACT_PRESETS.find(preset => matchesPresetHost(preset, host)) || null
}
