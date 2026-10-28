import type { ToolDefinition } from '../../../ai-harness/contracts.js'
import type { ProgressCallback } from '../agent-core.js'
import type {
  BrowserAutomationAction,
  BrowserAutomationActionResult,
  BrowserAutomationArticle,
  BrowserAutomationDiagnostics,
  BrowserAutomationInputField,
  BrowserAutomationScreenshot,
  BrowserAutomationSearchResults,
  BrowserAutomationSnapshot,
  PageAutomationRendererRequest,
  PageAutomationRendererResult
} from '../../../../shared/page-automation-types.js'
import type { DocumentArtifact } from '../../../document-workbench/document-types.js'
import type { ToolServices } from './index.js'

type ReadPageMode = 'interactive' | 'article' | 'search_results' | 'screenshot' | 'diagnostics'
type SnapshotMode = 'interactive' | 'article' | 'search_results'
type WaitForActionWithTextList = Omit<Extract<BrowserAutomationAction, { type: 'wait_for' }>, 'text'> & { text?: string | string[] }
type ScreenshotRequestWithTimeout = Extract<PageAutomationRendererRequest, { type: 'screenshot' }> & { timeoutMs?: number }

interface ReadCurrentPageArgs {
  mode?: ReadPageMode
  max_chars?: number
  tab_id?: string
  full_page?: boolean
  max_width?: number
  format?: 'png' | 'jpeg'
  quality?: number
  clear_diagnostics?: boolean
  timeout_ms?: number
}

interface InteractCurrentPageArgs {
  action: BrowserAutomationAction['type']
  tab_id?: string
  selector?: string
  ref?: string
  text?: string
  append?: boolean
  top?: number
  left?: number
  timeout_ms?: number
  value?: string
  label?: string
  index?: number
  fields?: BrowserAutomationInputField[]
  offset?: number
  max_chars?: number
  script?: string
  key?: string
  modifiers?: string[]
  actions?: Array<Record<string, unknown>>
  role?: string
  name?: string
  url?: string
  state?: 'load' | 'domcontentloaded'
  limit?: number
  ignore_cache?: boolean
  width?: number
  height?: number
  reset?: boolean
  media?: 'screen' | 'print'
  color_scheme?: 'light' | 'dark' | 'no-preference'
  reduced_motion?: 'reduce' | 'no-preference'
  user_agent?: string
  device_scale_factor?: number
  mobile?: boolean
}

interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

const DEFAULT_MAX_CHARS = 8000
const MAX_TEXT_CHARS = 60000
const EXTRACT_MAX_CHARS = 60000

function truncateText (value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`
}

/** Accept numeric strings too: model output occasionally quotes numbers. */
function finiteNumber (value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function nonNegativeNumber (value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number == null ? undefined : Math.max(0, number)
}

/** `timeout` is the documented alias for `timeout_ms`. */
function actionTimeoutMs (args: Record<string, unknown>): number | undefined {
  return nonNegativeNumber(args.timeout_ms) ?? nonNegativeNumber(args.timeout)
}

function normalizedTextList (value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function normalizeWaitForText (value: unknown): string | string[] | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const texts = normalizedTextList(JSON.parse(trimmed) as unknown)
        if (texts.length > 0) return texts
      } catch {
        // Not a JSON array: treat the value as literal text below.
      }
    }
    return value ? value : undefined
  }
  const texts = normalizedTextList(value)
  return texts.length > 0 ? texts : undefined
}

function normalizeTabId (args: Record<string, unknown>): string | undefined {
  return typeof args.tab_id === 'string' && args.tab_id.trim() ? args.tab_id.trim() : undefined
}

function normalizeReadArgs (args: Record<string, unknown>): ReadCurrentPageArgs {
  const mode = args.mode === 'article' || args.mode === 'interactive' || args.mode === 'search_results' || args.mode === 'screenshot' || args.mode === 'diagnostics'
    ? args.mode
    : undefined
  return {
    mode,
    max_chars: finiteNumber(args.max_chars),
    tab_id: normalizeTabId(args),
    full_page: args.full_page === true,
    max_width: finiteNumber(args.max_width),
    format: args.format === 'jpeg' ? 'jpeg' : args.format === 'png' ? 'png' : undefined,
    quality: finiteNumber(args.quality),
    clear_diagnostics: args.clear_diagnostics === true,
    timeout_ms: actionTimeoutMs(args)
  }
}

function targetFromArgs (args: Record<string, unknown>): { selector?: string; ref?: string } {
  const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
  const ref = typeof args.ref === 'string' ? args.ref.trim() : ''
  return {
    ...(selector ? { selector } : {}),
    ...(ref ? { ref } : {})
  }
}

function requireTarget (action: string, args: Record<string, unknown>): { selector?: string; ref?: string } {
  const target = targetFromArgs(args)
  if (!target.selector && !target.ref) {
    throw new Error(`${action} requires a selector or a ref from read_current_page.`)
  }
  return target
}

function normalizeInteractArgs (args: Record<string, unknown>): BrowserAutomationAction {
  const action = String(args.action || '').trim() as BrowserAutomationAction['type']

  if (action === 'click') {
    return { type: 'click', ...requireTarget(action, args) }
  }

  if (action === 'input') {
    return {
      type: 'input',
      ...requireTarget(action, args),
      text: String(args.text || ''),
      append: Boolean(args.append)
    }
  }

  if (action === 'select') {
    const value = typeof args.value === 'string' ? args.value : undefined
    const label = typeof args.label === 'string' ? args.label : undefined
    const index = finiteNumber(args.index)
    if (value === undefined && label === undefined && index === undefined) {
      throw new Error('select requires one of value, label, or index.')
    }
    return {
      type: 'select',
      ...requireTarget(action, args),
      value,
      label,
      index
    }
  }

  if (action === 'batch_input') {
    const rawFields = Array.isArray(args.fields) ? args.fields : []
    const fields: BrowserAutomationInputField[] = rawFields
      .filter((field): field is Record<string, unknown> => typeof field === 'object' && field !== null)
      .map((field) => ({
        ...targetFromArgs(field),
        text: String(field.text || ''),
        append: Boolean(field.append)
      }))
      .filter((field) => field.selector || field.ref)
    return { type: 'batch_input', fields }
  }

  if (action === 'extract') {
    return {
      type: 'extract',
      ...targetFromArgs(args),
      offset: nonNegativeNumber(args.offset),
      maxChars: nonNegativeNumber(args.max_chars)
    }
  }

  if (action === 'evaluate') {
    const script = String(args.script || '')
    if (!script.trim()) throw new Error('evaluate requires a non-empty script.')
    return {
      type: 'evaluate',
      script,
      timeoutMs: actionTimeoutMs(args)
    }
  }

  if (action === 'hover') {
    return { type: 'hover', ...requireTarget(action, args) }
  }

  if (action === 'focus') {
    return { type: 'focus', ...requireTarget(action, args) }
  }

  if (action === 'press_key') {
    const key = String(args.key || '')
    if (!key) throw new Error('press_key requires a non-empty key.')
    return {
      type: 'press_key',
      ...targetFromArgs(args),
      key,
      modifiers: Array.isArray(args.modifiers)
        ? args.modifiers.map(modifier => String(modifier)).filter(Boolean)
        : undefined
    }
  }

  if (action === 'scroll') {
    return {
      type: 'scroll',
      top: finiteNumber(args.top) ?? 0,
      left: finiteNumber(args.left)
    }
  }

  if (action === 'wait') {
    return {
      type: 'wait',
      timeoutMs: actionTimeoutMs(args) ?? 0
    }
  }

  if (action === 'wait_for') {
    const waitForText = normalizeWaitForText(args.text)
    const waitForAction: WaitForActionWithTextList = {
      type: 'wait_for',
      selector: typeof args.selector === 'string' && args.selector.trim() ? args.selector.trim() : undefined,
      ref: typeof args.ref === 'string' && args.ref.trim() ? args.ref.trim() : undefined,
      ...(waitForText !== undefined ? { text: waitForText } : {}),
      url: typeof args.url === 'string' && args.url ? args.url : undefined,
      state: args.state === 'load' || args.state === 'domcontentloaded' ? args.state : undefined,
      timeoutMs: actionTimeoutMs(args)
    }
    return waitForAction as unknown as BrowserAutomationAction
  }

  if (action === 'find') {
    return {
      type: 'find',
      selector: typeof args.selector === 'string' && args.selector.trim() ? args.selector.trim() : undefined,
      role: typeof args.role === 'string' && args.role.trim() ? args.role.trim() : undefined,
      name: typeof args.name === 'string' && args.name ? args.name : undefined,
      text: typeof args.text === 'string' && args.text ? args.text : undefined,
      limit: finiteNumber(args.limit)
    }
  }

  if (action === 'navigate') {
    const url = String(args.url || '').trim()
    if (!url) throw new Error('navigate requires a non-empty url.')
    return {
      type: 'navigate',
      url,
      timeoutMs: actionTimeoutMs(args)
    }
  }

  if (action === 'reload') {
    return {
      type: 'reload',
      ignoreCache: args.ignore_cache === true,
      timeoutMs: actionTimeoutMs(args)
    }
  }

  if (action === 'back' || action === 'forward') {
    return {
      type: action,
      timeoutMs: actionTimeoutMs(args)
    }
  }

  if (action === 'resize') {
    return {
      type: 'resize',
      width: finiteNumber(args.width),
      height: finiteNumber(args.height),
      reset: args.reset === true
    }
  }

  if (action === 'emulate') {
    if (args.media !== undefined && args.media !== 'screen' && args.media !== 'print') {
      throw new Error('emulate media must be "screen" or "print".')
    }
    if (
      args.color_scheme !== undefined &&
      args.color_scheme !== 'light' &&
      args.color_scheme !== 'dark' &&
      args.color_scheme !== 'no-preference'
    ) {
      throw new Error('emulate color_scheme must be "light", "dark", or "no-preference".')
    }
    if (
      args.reduced_motion !== undefined &&
      args.reduced_motion !== 'reduce' &&
      args.reduced_motion !== 'no-preference'
    ) {
      throw new Error('emulate reduced_motion must be "reduce" or "no-preference".')
    }
    if (args.user_agent !== undefined && (typeof args.user_agent !== 'string' || !args.user_agent.trim())) {
      throw new Error('emulate user_agent must be a non-empty string.')
    }
    const width = finiteNumber(args.width)
    const height = finiteNumber(args.height)
    const deviceScaleFactor = finiteNumber(args.device_scale_factor)
    if (width !== undefined && (width < 320 || width > 4096)) {
      throw new Error('emulate width must be between 320 and 4096 CSS pixels.')
    }
    if (height !== undefined && (height < 320 || height > 4096)) {
      throw new Error('emulate height must be between 320 and 4096 CSS pixels.')
    }
    if (deviceScaleFactor !== undefined && (deviceScaleFactor < 0.5 || deviceScaleFactor > 4)) {
      throw new Error('emulate device_scale_factor must be between 0.5 and 4.')
    }
    if (args.mobile !== undefined && typeof args.mobile !== 'boolean') {
      throw new Error('emulate mobile must be a boolean.')
    }
    const reset = args.reset === true
    const hasOverrides = args.media !== undefined ||
      args.color_scheme !== undefined ||
      args.reduced_motion !== undefined ||
      args.user_agent !== undefined ||
      width !== undefined ||
      height !== undefined ||
      deviceScaleFactor !== undefined ||
      args.mobile !== undefined
    if (!reset && !hasOverrides) {
      throw new Error('emulate requires at least one emulation option or reset=true.')
    }
    const timeoutMs = actionTimeoutMs(args)
    return {
      type: 'emulate',
      ...(reset ? { reset: true } : {}),
      ...(args.media !== undefined ? { media: args.media as 'screen' | 'print' } : {}),
      ...(args.color_scheme !== undefined ? { colorScheme: args.color_scheme as 'light' | 'dark' | 'no-preference' } : {}),
      ...(args.reduced_motion !== undefined ? { reducedMotion: args.reduced_motion as 'reduce' | 'no-preference' } : {}),
      ...(args.user_agent !== undefined ? { userAgent: String(args.user_agent) } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(deviceScaleFactor !== undefined ? { deviceScaleFactor } : {}),
      ...(args.mobile !== undefined ? { mobile: args.mobile as boolean } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {})
    }
  }

  if (action === 'batch') {
    const rawActions = Array.isArray(args.actions) ? args.actions : []
    if (rawActions.length === 0) throw new Error('batch requires a non-empty actions array.')
    const actions = rawActions
      .filter((step): step is Record<string, unknown> => typeof step === 'object' && step !== null)
      .map((step) => {
        if (String(step.action || '').trim() === 'batch') {
          throw new Error('Nested batch actions are not supported.')
        }
        return normalizeInteractArgs(step)
      })
    return { type: 'batch', actions }
  }

  throw new Error('Unsupported page action.')
}

function sanitizeSnapshot (snapshot: BrowserAutomationSnapshot, maxChars: number): BrowserAutomationSnapshot {
  return {
    ...snapshot,
    textPreview: truncateText(snapshot.textPreview, Math.min(Math.max(400, maxChars), MAX_TEXT_CHARS))
  }
}

function isArticle (value: unknown): value is BrowserAutomationArticle {
  return typeof value === 'object' && value !== null && 'text' in value && 'wordCount' in value
}

function isSearchResults (value: unknown): value is BrowserAutomationSearchResults {
  return typeof value === 'object' && value !== null && 'results' in value && Array.isArray((value as BrowserAutomationSearchResults).results)
}

function isScreenshot (value: unknown): value is BrowserAutomationScreenshot {
  return typeof value === 'object' && value !== null && 'dataUrl' in value && typeof (value as BrowserAutomationScreenshot).dataUrl === 'string'
}

function isDiagnostics (value: unknown): value is BrowserAutomationDiagnostics {
  return typeof value === 'object' && value !== null && 'console' in value && 'network' in value
}

async function runRawPageRequest (
  services: ToolServices,
  request: PageAutomationRendererRequest,
  tabId?: string
): Promise<PageAutomationRendererResult> {
  if (!services.runPageAutomation) {
    throw new Error('Page automation is unavailable in this session.')
  }
  return await services.runPageAutomation(request, tabId, services.conversationId)
}

async function ensurePageSnapshot (
  services: ToolServices,
  mode: SnapshotMode = 'interactive',
  tabId?: string
): Promise<BrowserAutomationSnapshot | BrowserAutomationArticle | BrowserAutomationSearchResults> {
  if (services.runPageAutomation) {
    const result = await services.runPageAutomation({ type: 'snapshot', mode }, tabId, services.conversationId)
    if (isArticle(result) || isSearchResults(result)) return result
    return result as BrowserAutomationSnapshot
  }
  if (!services.readActivePage) {
    throw new Error('Current page automation is unavailable in this session.')
  }
  return await services.readActivePage(mode, tabId, services.conversationId) as BrowserAutomationSnapshot | BrowserAutomationArticle | BrowserAutomationSearchResults
}

async function ensureInteractiveSnapshot (services: ToolServices, tabId?: string): Promise<BrowserAutomationSnapshot> {
  const result = await ensurePageSnapshot(services, 'interactive', tabId)
  if (isArticle(result) || isSearchResults(result)) {
    throw new Error('Interactive page snapshot is unavailable for this page surface.')
  }
  return result
}

async function ensurePageActionResult (
  services: ToolServices,
  action: BrowserAutomationAction,
  tabId?: string
): Promise<BrowserAutomationActionResult> {
  if (services.runPageAutomation) {
    return await services.runPageAutomation({ type: 'action', action }, tabId, services.conversationId) as BrowserAutomationActionResult
  }
  if (!services.interactWithActivePage) {
    throw new Error('Current page interaction is unavailable in this session.')
  }
  return await services.interactWithActivePage(action, tabId, services.conversationId)
}

type NavigationAwareActionResult = BrowserAutomationActionResult & {
  navigated?: boolean
  navigationTimedOut?: boolean
}

function describeActionResultFailure (result: BrowserAutomationActionResult): { error?: string; warning?: string } {
  if (result.ok === false) {
    return { error: result.error || 'Page action failed.' }
  }
  if (result.type === 'batch_input') {
    const filled = typeof result.filled === 'number' ? result.filled : 0
    const skipped = typeof result.skipped === 'number' ? result.skipped : 0
    if (skipped > 0) {
      const detail = `Filled ${filled} field(s), skipped ${skipped} field(s).`
      return filled === 0 ? { error: detail } : { warning: detail }
    }
  }
  if (result.type === 'batch' && Array.isArray(result.results)) {
    const warnings: string[] = []
    for (const step of result.results) {
      const stepFailure = describeActionResultFailure(step)
      if (stepFailure.error) return stepFailure
      if (stepFailure.warning) warnings.push(stepFailure.warning)
    }
    if (warnings.length > 0) return { warning: warnings.join(' ') }
  }
  return {}
}

function buildReadPageGuidance (fullTextAvailable: boolean): string {
  const lines = [
    'Use interact_current_page to click, type, scroll, select dropdowns, batch-fill forms, extract text by offset, run scripts, press keys, navigate/reload/history, wait for page state, batch actions, or find elements.',
    'For long pages, call interact_current_page with action "extract" and offset/max_chars to paginate, or use save_current_page_as_document to persist the page as a chunked document and read it with read_document.'
  ]
  if (!fullTextAvailable) {
    lines.push('The snapshot preview was truncated; use extract or save_current_page_as_document to read the full page.')
  }
  return lines.join(' ')
}

const TAB_ID_PROPERTY = {
  type: 'string',
  description: 'Optional workspace tab id from manage_workspace_tabs. Omit to use the active page tab.'
} as const

const TARGET_PROPERTIES = {
  selector: {
    type: 'string',
    description: 'CSS selector of the target element. Selectors come from read_current_page or action "find".'
  },
  ref: {
    type: 'string',
    description: 'Stable element ref from read_current_page/find (e1, e2, ...). Prefer it over fragile CSS selectors.'
  }
} as const

function actionSchema (): Record<string, unknown> {
  return {
    type: 'string',
    enum: [
      'click', 'input', 'select', 'batch_input', 'extract', 'evaluate', 'hover', 'focus',
      'press_key', 'scroll', 'wait', 'wait_for', 'find', 'navigate', 'reload', 'back',
      'forward', 'resize', 'emulate', 'batch'
    ],
    description: 'Action to perform on the active page. "emulate" is the built-in replacement for chrome-devtools-mcp "emulate" (media, color scheme, reduced motion, user agent, mobile viewport).'
  }
}

export function toolReadCurrentPage (services: ToolServices): Tool {
  return {
    definition: {
      name: 'read_current_page',
      description: 'Inspect the active in-app browser/project page. Modes: "interactive" (default) returns title, URL, readable text, interactive elements with stable refs/selectors, and form fields; "article" returns readability-style primary content as markdown; "search_results" extracts result titles/URLs/snippets from a search engine page; "screenshot" returns a current viewport (or full-page) image for visual verification and accepts timeout/timeout_ms for long captures; "diagnostics" returns console output, uncaught errors, recent fetch/XHR/resource activity, viewport and history state. These built-in page tools replace chrome/playwright browser MCP for navigation, screenshots, console/network reads, viewport changes, DOM inspection, and script evaluation; use external browser MCP only for capabilities the built-in surface lacks (CDP-level network interception, performance tracing, or CI browser matrices). When web_search/web_fetch reports access "blocked"/"degraded", open the page with open_workspace_tab(kind="browser") and read it here with mode "article".',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['interactive', 'article', 'search_results', 'screenshot', 'diagnostics'],
            description: 'interactive (default): DOM snapshot with refs and form selectors. article: readable primary-content text. search_results: title/URL/snippet list from the current search page. screenshot: image of the page for visual design verification. diagnostics: console/errors/network/viewport state.'
          },
          max_chars: {
            type: 'integer',
            description: `Maximum characters from the live page text preview to return (interactive mode). Default ${DEFAULT_MAX_CHARS}, maximum ${MAX_TEXT_CHARS}.`
          },
          tab_id: TAB_ID_PROPERTY,
          full_page: {
            type: 'boolean',
            description: 'screenshot only: capture the full scrollable page instead of the visible viewport.'
          },
          max_width: {
            type: 'integer',
            description: 'screenshot only: maximum image width in pixels (default 1280, max 4096).'
          },
          format: {
            type: 'string',
            enum: ['png', 'jpeg'],
            description: 'screenshot only: image format. Default png.'
          },
          quality: {
            type: 'integer',
            description: 'screenshot only: JPEG quality 10-100 (default 80).'
          },
          timeout_ms: {
            type: 'integer',
            description: 'screenshot only: capture timeout in milliseconds. The page surface clamps it to its supported screenshot budget.'
          },
          timeout: {
            type: 'integer',
            description: 'screenshot only: alias for timeout_ms.'
          },
          clear_diagnostics: {
            type: 'boolean',
            description: 'diagnostics only: clear the buffered console/error/network entries after returning the current snapshot.'
          }
        }
      }
    },
    handler: async (args, onProgress) => {
      const normalized = normalizeReadArgs(args)
      if (normalized.mode === 'screenshot') {
        onProgress?.('📸 Capturing current page', normalized.full_page ? 'full page' : 'visible viewport')
        const screenshotRequest: ScreenshotRequestWithTimeout = {
          type: 'screenshot',
          fullPage: normalized.full_page,
          maxWidth: normalized.max_width,
          format: normalized.format,
          quality: normalized.quality,
          ...(normalized.timeout_ms !== undefined ? { timeoutMs: normalized.timeout_ms } : {})
        }
        const result = await runRawPageRequest(services, screenshotRequest, normalized.tab_id)
        if (!isScreenshot(result)) throw new Error('The page surface did not return a screenshot.')
        onProgress?.('✅ Screenshot captured', `${result.width}x${result.height}`)
        return {
          ok: true,
          mode: 'screenshot',
          image_url: result.dataUrl,
          width: result.width,
          height: result.height,
          full_page: result.fullPage,
          page: { url: result.url, title: result.title },
          ...(result.note ? { note: result.note } : {}),
          guidance: 'The screenshot is attached as a multimodal observation. Use interact_current_page with action "resize", "navigate", or "click" to change the page, then capture again to compare.'
        }
      }

      if (normalized.mode === 'diagnostics') {
        onProgress?.('🩺 Inspecting current page', 'console, errors, network and viewport')
        const result = await runRawPageRequest(services, {
          type: 'diagnostics',
          clear: normalized.clear_diagnostics
        }, normalized.tab_id)
        if (!isDiagnostics(result)) throw new Error('The page surface did not return diagnostics.')
        onProgress?.('✅ Diagnostics captured', `${result.console.length} console, ${result.errors.length} error(s)`)
        return {
          ok: true,
          mode: 'diagnostics',
          page: result,
          guidance: 'Use action "wait_for" or "reload" after fixing a runtime issue, then read diagnostics again. Use interact_current_page action "batch" to reproduce a user path and collect further console/network output.'
        }
      }

      if (normalized.mode === 'article') {
        onProgress?.('🌐 Reading current page', 'Extracting readable article content from the active embedded browser page')
        const result = await ensurePageSnapshot(services, 'article', normalized.tab_id)
        if (!isArticle(result)) throw new Error('Article extraction is unavailable for this page surface.')
        onProgress?.('✅ Current page captured', result.title || result.url)
        return {
          ok: true,
          mode: 'article',
          page: result,
          guidance: [
            'The page content above is the primary article text (headings, paragraphs, lists) as markdown.',
            result.truncated
              ? `Text was truncated around ${result.text.length} characters; use interact_current_page with action "extract" plus offset/max_chars, or save_current_page_as_document, to read the remainder.`
              : '',
            'Call this tool with mode "interactive" when you need clickable elements and form selectors instead of article text.'
          ].filter(Boolean).join(' ')
        }
      }

      if (normalized.mode === 'search_results') {
        onProgress?.('🔎 Reading search results', 'Extracting result titles, URLs and snippets')
        const result = await ensurePageSnapshot(services, 'search_results', normalized.tab_id)
        if (!isSearchResults(result)) throw new Error('Search-result extraction is unavailable for this page surface.')
        onProgress?.('✅ Search results captured', `${result.results.length} result(s)`)
        return {
          ok: true,
          mode: 'search_results',
          page: result,
          guidance: 'Use open_workspace_tab(kind="browser", url=...) or interact_current_page(action="navigate") to open a result, then read it with mode "article".'
        }
      }

      onProgress?.('🌐 Reading current page', 'Collecting a live snapshot from the active embedded browser page')
      const snapshot = await ensureInteractiveSnapshot(services, normalized.tab_id)
      const sanitized = sanitizeSnapshot(snapshot, normalized.max_chars || DEFAULT_MAX_CHARS)
      onProgress?.('✅ Current page captured', sanitized.title || sanitized.url)
      return {
        ok: true,
        page: sanitized,
        guidance: buildReadPageGuidance(sanitized.fullTextAvailable)
      }
    }
  }
}

export function toolInteractCurrentPage (services: ToolServices): Tool {
  return {
    definition: {
      name: 'interact_current_page',
      description: 'Operate the active in-app browser/project page. Actions: click, input, select, batch_input, extract, evaluate, hover, focus, press_key (real keyboard), scroll, wait, wait_for, find (semantic element lookup), navigate, reload, back, forward, resize (viewport), emulate (print/screen media, prefers-color-scheme, prefers-reduced-motion, user agent, mobile viewport/device scale), batch (multiple actions in one round trip). For wait_for, selector/ref/text are evaluated in the current document, while state/url wait across navigations; text accepts a string or an array of strings and matches when ANY value is present. Set include_snapshot=false to skip the post-action interactive page snapshot and save tokens. Use timeout or timeout_ms to bound wait/wait_for/navigate/reload/back/forward/evaluate. Action "emulate" is the built-in replacement for chrome-devtools-mcp "emulate". These built-in page tools replace chrome/playwright browser MCP for navigation, screenshots, console/network reads, viewport resizing/emulation, DOM inspection, and script evaluation; use external browser MCP only for capabilities the built-in surface lacks (CDP-level network interception, performance tracing, or CI browser matrices). Use selectors or stable refs from read_current_page.',
      parameters: {
        type: 'object',
        properties: {
          action: actionSchema(),
          tab_id: TAB_ID_PROPERTY,
          include_snapshot: {
            type: 'boolean',
            description: 'Default true. Set false to skip the post-action interactive page snapshot and save tokens; action_result is still returned.'
          },
          ...TARGET_PROPERTIES,
          text: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } }
            ],
            description: 'For input: text to type into the target field (required, string). For wait_for: a string or an array of strings; the wait succeeds when ANY value is present.'
          },
          append: {
            type: 'boolean',
            description: 'For input/batch_input: append text instead of replacing the current value.'
          },
          top: {
            type: 'number',
            description: 'Required for scroll. Vertical scroll offset in pixels.'
          },
          left: {
            type: 'number',
            description: 'Optional horizontal scroll offset in pixels for scroll.'
          },
          timeout_ms: {
            type: 'integer',
            description: 'For wait/wait_for/navigate/reload/back/forward/evaluate: timeout in milliseconds. Alias: timeout.'
          },
          timeout: {
            type: 'integer',
            description: 'Alias for timeout_ms on wait/wait_for/navigate/reload/back/forward/evaluate.'
          },
          value: {
            type: 'string',
            description: 'For select: the option value to select.'
          },
          label: {
            type: 'string',
            description: 'For select: the visible text label of the option to select.'
          },
          index: {
            type: 'integer',
            description: 'For select: the zero-based index of the option to select.'
          },
          fields: {
            type: 'array',
            description: 'Required for batch_input. Array of {selector|ref, text, append?} objects.',
            items: {
              type: 'object',
              properties: {
                selector: { type: 'string' },
                ref: { type: 'string' },
                text: { type: 'string' },
                append: { type: 'boolean' }
              },
              required: ['text']
            }
          },
          offset: {
            type: 'integer',
            description: 'For extract: zero-based character offset to start reading from.'
          },
          max_chars: {
            type: 'integer',
            description: 'For extract: maximum characters to return per page. Default 60000.'
          },
          script: {
            type: 'string',
            description: 'For evaluate: JavaScript expression, async function, or statements to run in the page. Async and top-level await are supported; the result is serialized.'
          },
          key: {
            type: 'string',
            description: 'Required for press_key. Key name (e.g. "Enter", "Tab", "ArrowLeft", "a").'
          },
          modifiers: {
            type: 'array',
            items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
            description: 'Optional key modifiers for press_key.'
          },
          role: {
            type: 'string',
            description: 'For find: accessible role filter (button, link, textbox, checkbox, ...).'
          },
          name: {
            type: 'string',
            description: 'For find: accessible-name substring filter.'
          },
          url: {
            type: 'string',
            description: 'For navigate: target URL. For wait_for: URL substring to wait for.'
          },
          state: {
            type: 'string',
            enum: ['load', 'domcontentloaded'],
            description: 'For wait_for: document load state to wait for.'
          },
          limit: {
            type: 'integer',
            description: 'For find: maximum matches to return (default 20, max 50).'
          },
          ignore_cache: {
            type: 'boolean',
            description: 'For reload: bypass the HTTP cache.'
          },
          width: {
            type: 'integer',
            description: 'For resize/emulate: viewport width in CSS pixels. emulate accepts 320-4096; a missing dimension keeps the current viewport size.'
          },
          height: {
            type: 'integer',
            description: 'For resize/emulate: viewport height in CSS pixels. emulate accepts 320-4096; a missing dimension keeps the current viewport size.'
          },
          reset: {
            type: 'boolean',
            description: 'For resize/emulate: reset the agent viewport and page emulation back to the panel defaults.'
          },
          media: {
            type: 'string',
            enum: ['screen', 'print'],
            description: 'For emulate: emulated CSS media type. Use "print" to verify print styles.'
          },
          color_scheme: {
            type: 'string',
            enum: ['light', 'dark', 'no-preference'],
            description: 'For emulate: emulate prefers-color-scheme.'
          },
          reduced_motion: {
            type: 'string',
            enum: ['reduce', 'no-preference'],
            description: 'For emulate: emulate prefers-reduced-motion.'
          },
          user_agent: {
            type: 'string',
            description: 'For emulate: override the page user agent. Must be non-empty.'
          },
          device_scale_factor: {
            type: 'number',
            description: 'For emulate: device pixel ratio from 0.5 to 4 (default 1 when a viewport is supplied).'
          },
          mobile: {
            type: 'boolean',
            description: 'For emulate: mobile viewport flag.'
          },
          actions: {
            type: 'array',
            description: 'Required for batch. Array of action objects, each with an "action" field and its own parameters.',
            items: { type: 'object' }
          }
        },
        required: ['action']
      }
    },
    handler: async (args, onProgress) => {
      const tabId = normalizeTabId(args)
      const includeSnapshot = args.include_snapshot !== false
      const action = normalizeInteractArgs(args)
      onProgress?.('🖱️ Interacting with current page', `${action.type}${'selector' in action && action.selector ? `: ${action.selector}` : ''}`)
      const actionResult = await ensurePageActionResult(services, action, tabId)
      const failure = describeActionResultFailure(actionResult)
      if (failure.error) {
        onProgress?.('❌ Page interaction failed', failure.error)
        return { ok: false, error: failure.error, action_result: actionResult }
      }
      const navigationAware = actionResult as NavigationAwareActionResult
      const navigated = navigationAware.navigated === true
      const navigationTimedOut = navigationAware.navigationTimedOut === true
      const shouldAttachSnapshot = includeSnapshot &&
        action.type !== 'evaluate' &&
        action.type !== 'find' &&
        action.type !== 'wait_for' &&
        action.type !== 'resize' &&
        !navigated
      const snapshot = shouldAttachSnapshot
        ? sanitizeSnapshot(await ensureInteractiveSnapshot(services, tabId), DEFAULT_MAX_CHARS)
        : undefined
      onProgress?.('✅ Page interaction complete', action.type)
      return {
        ok: true,
        ...(failure.warning ? { warning: failure.warning } : {}),
        action_result: actionResult,
        ...(snapshot ? { page: snapshot } : {}),
        ...(navigated
          ? {
              guidance: navigationTimedOut
                ? 'The action triggered a navigation that did not finish within the timeout. Call read_current_page to inspect the current page.'
                : 'The action triggered a navigation; the pre-navigation interactive snapshot was skipped. Call read_current_page to inspect the new page.'
            }
          : {})
      }
    }
  }
}

export function toolFillCurrentPageForm (services: ToolServices): Tool {
  return {
    definition: {
      name: 'fill_current_page_form',
      description: 'Batch-fill form fields on the active in-app browser/project page. Provide an array of field entries with selectors or refs from read_current_page and the text to enter. This is the built-in replacement for chrome/playwright browser MCP form helpers and a convenience wrapper around interact_current_page action=batch_input.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: TAB_ID_PROPERTY,
          fields: {
            type: 'array',
            description: 'Array of {selector|ref, text, append?} objects.',
            items: {
              type: 'object',
              properties: {
                selector: { type: 'string', description: 'CSS selector of the input, textarea, or select element.' },
                ref: { type: 'string', description: 'Stable ref from read_current_page.' },
                text: { type: 'string', description: 'Text or option value to set.' },
                append: { type: 'boolean', description: 'If true, append instead of replacing.' }
              },
              required: ['text']
            }
          }
        },
        required: ['fields']
      }
    },
    handler: async (args, onProgress) => {
      const tabId = normalizeTabId(args)
      const rawFields = Array.isArray(args.fields) ? args.fields : []
      const fields: BrowserAutomationInputField[] = rawFields
        .filter((field): field is Record<string, unknown> => typeof field === 'object' && field !== null)
        .map((field) => ({
          ...targetFromArgs(field),
          text: String(field.text || ''),
          append: Boolean(field.append)
        }))
        .filter((field) => field.selector || field.ref)

      if (fields.length === 0) {
        throw new Error('At least one valid field with a selector or ref is required.')
      }

      onProgress?.('📝 Filling current page form', `${fields.length} field(s)`)
      const actionResult = await ensurePageActionResult(services, { type: 'batch_input', fields }, tabId)
      const failure = describeActionResultFailure(actionResult)
      if (failure.error) {
        onProgress?.('❌ Form fill failed', failure.error)
        return { ok: false, error: failure.error, action_result: actionResult }
      }
      const snapshot = sanitizeSnapshot(await ensureInteractiveSnapshot(services, tabId), DEFAULT_MAX_CHARS)
      onProgress?.('✅ Form fill complete', `filled ${(actionResult as BrowserAutomationActionResult).filled ?? '?'} field(s)`)
      return {
        ok: true,
        ...(failure.warning ? { warning: failure.warning } : {}),
        action_result: actionResult,
        page: snapshot
      }
    }
  }
}

interface SaveCurrentPageAsDocumentArgs {
  selector?: string
  ref?: string
  file_name?: string
}

function splitTextIntoNodes (text: string): Array<{ id: string; text: string }> {
  const blocks = text.split(/\n\s*\n+/).map((block) => block.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return blocks.map((block) => ({
    id: crypto.randomUUID(),
    text: block
  }))
}

function buildPageDocumentArtifact (args: SaveCurrentPageAsDocumentArgs, fullText: string): DocumentArtifact {
  const now = new Date().toISOString()
  const fileName = (args.file_name || 'current-page').replace(/[\\/:*?"<>|]/g, '_')
  const nodes = splitTextIntoNodes(fullText)

  return {
    id: crypto.randomUUID(),
    filePath: `page://${fileName}`,
    fileName: `${fileName}.txt`,
    fileSize: fullText.length,
    fileType: 'unknown',
    plainText: fullText,
    nodes: nodes.map((node, index) => ({
      id: node.id,
      type: 'paragraph' as const,
      text: node.text,
      level: 1,
      pageIndex: index + 1
    })),
    importedAt: now,
    render: {
      kind: 'html' as const,
      source: 'fallback' as const,
      status: 'unavailable' as const,
      generatedAt: now
    }
  }
}

interface ExtractedPageText {
  text: string
  totalLength: number
  truncated: boolean
}

const MAX_EXTRACT_CHUNKS = 100

async function extractPageText (
  services: ToolServices,
  target: { selector?: string; ref?: string },
  tabId?: string
): Promise<ExtractedPageText> {
  const first = await ensurePageActionResult(services, { type: 'extract', ...target, maxChars: 0 }, tabId)
  if (first.ok === false) {
    throw new Error(first.error || 'Page text extraction failed.')
  }
  let text = typeof first.text === 'string' ? first.text : ''
  if (!text) return { text, totalLength: 0, truncated: false }

  let totalLength = typeof first.totalLength === 'number' && first.totalLength >= text.length
    ? first.totalLength
    : text.length
  let offset = text.length
  let guard = 0
  while (offset < totalLength && guard < MAX_EXTRACT_CHUNKS) {
    const next = await ensurePageActionResult(services, {
      type: 'extract',
      ...target,
      offset,
      maxChars: EXTRACT_MAX_CHARS
    }, tabId)
    if (next.ok === false) {
      throw new Error(next.error || 'Page text extraction failed.')
    }
    const chunk = typeof next.text === 'string' ? next.text : ''
    if (!chunk) break
    text += chunk
    offset += chunk.length
    if (typeof next.totalLength === 'number') {
      totalLength = Math.max(totalLength, next.totalLength)
    }
    guard += 1
  }

  return {
    text,
    totalLength,
    truncated: offset < totalLength
  }
}

export function toolSaveCurrentPageAsDocument (services: ToolServices): Tool {
  return {
    definition: {
      name: 'save_current_page_as_document',
      description: 'Save the full text of the active in-app browser/project page as a document artifact. Long pages are extracted in chunks; if a safety cap is reached the result includes truncated/expected length metadata plus guidance for reading the remainder. Returns an artifact_id that can be read with read_document in chunks, searched, and revisited later. Useful for long pages or when the model needs to search or repeatedly reference the page content. Prefer this built-in tool over external browser MCP when you need a durable, searchable copy of page content.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'Optional CSS selector to extract only a portion of the page. Defaults to the full page body.'
          },
          ref: {
            type: 'string',
            description: 'Optional stable ref from read_current_page to extract only that element.'
          },
          file_name: {
            type: 'string',
            description: 'Optional display name for the saved document. Defaults to "current-page".'
          },
          tab_id: TAB_ID_PROPERTY
        }
      }
    },
    handler: async (args, onProgress) => {
      if (!services.persistDocumentArtifact) {
        throw new Error('Document persistence is unavailable in this session.')
      }

      const tabId = normalizeTabId(args)
      const normalized: SaveCurrentPageAsDocumentArgs = {
        selector: typeof args.selector === 'string' ? args.selector.trim() : undefined,
        ref: typeof args.ref === 'string' ? args.ref.trim() : undefined,
        file_name: typeof args.file_name === 'string' ? args.file_name.trim() : undefined
      }

      onProgress?.('📄 Saving current page as document', normalized.file_name || 'current-page')
      const extraction = await extractPageText(
        services,
        targetFromArgs({ selector: normalized.selector, ref: normalized.ref }),
        tabId
      )
      if (extraction.text.length === 0) {
        throw new Error('No text could be extracted from the current page.')
      }

      const artifact = buildPageDocumentArtifact(normalized, extraction.text)
      services.persistDocumentArtifact(artifact as unknown as Record<string, unknown> & { id: string })
      onProgress?.('✅ Page saved as document', `${artifact.fileName} (${artifact.plainText.length} chars)`)
      return {
        ok: true,
        artifact_id: artifact.id,
        file_name: artifact.fileName,
        total_length: artifact.plainText.length,
        source_length: extraction.totalLength,
        node_count: artifact.nodes.length,
        ...(extraction.truncated
          ? {
              truncated: true,
              warning: `Saved ${artifact.plainText.length} of ${extraction.totalLength} characters before the extraction safety cap.`,
              guidance: `The saved document is partial. Use interact_current_page with action "extract", offset=${artifact.plainText.length}, and max_chars to continue, or save a narrower selector/ref. Use read_document with artifact_id="${artifact.id}" for the saved portion.`
            }
          : {
              guidance: `Use read_document with artifact_id="${artifact.id}" to read the page in chunks.`
            })
      }
    }
  }
}
