export interface ActivePageAutomationContext {
  appId: string
  kind: 'browser' | 'project'
  title: string
  url: string | null
  origin: string | null
}

export interface BrowserAutomationElementBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserAutomationSnapshotElement {
  /** Stable snapshot ref (e1, e2, ...) usable as `ref` in page actions. */
  ref?: string
  selector: string
  tag: string
  text: string
  role: string | null
  name?: string | null
  type?: string | null
  value?: string | null
  href?: string | null
  placeholder?: string | null
  title?: string | null
  checked?: boolean | null
  disabled?: boolean
  visible?: boolean
  bounds?: BrowserAutomationElementBounds | null
}

export interface BrowserAutomationSnapshotFormFieldOption {
  value: string
  label: string
}

export interface BrowserAutomationSnapshotFormField {
  ref?: string
  selector: string
  tag: string
  type: string | null
  name: string | null
  label: string | null
  placeholder: string | null
  value: string
  options?: BrowserAutomationSnapshotFormFieldOption[]
}

export interface BrowserAutomationSnapshot {
  url: string
  title: string
  origin: string | null
  textPreview: string
  fullTextAvailable: boolean
  interactiveElements: BrowserAutomationSnapshotElement[]
  formFields: BrowserAutomationSnapshotFormField[]
  capturedAt: number
}

/**
 * Reading-mode extraction of the active page (readability-style): markdown-ish
 * text of the primary content container. Built for information retrieval —
 * use `BrowserAutomationSnapshot` when the page must be operated instead.
 */
export interface BrowserAutomationArticle {
  url: string
  title: string
  origin: string | null
  text: string
  wordCount: number
  truncated: boolean
  capturedAt: number
}

export interface BrowserAutomationSearchResultItem {
  rank: number
  title: string
  url: string
  snippet: string
}

export interface BrowserAutomationSearchResults {
  url: string
  title: string
  origin: string | null
  results: BrowserAutomationSearchResultItem[]
  capturedAt: number
}

export interface BrowserAutomationConsoleEntry {
  level: 'debug' | 'info' | 'warning' | 'error'
  message: string
  source?: string | null
  line?: number | null
  timestamp: number
}

export interface BrowserAutomationPageError {
  kind: 'error' | 'unhandledrejection' | 'load' | 'crash'
  message: string
  source?: string | null
  line?: number | null
  column?: number | null
  stack?: string | null
  timestamp: number
}

export interface BrowserAutomationNetworkEntry {
  url: string
  method?: string | null
  status?: number | null
  ok?: boolean | null
  type: string
  durationMs?: number | null
  transferSize?: number | null
  error?: string | null
  timestamp: number
}

/**
 * Live page diagnostics for AI debugging: runtime errors, console output,
 * recent network activity, viewport/scroll geometry and history state.
 * Read-only; does not mutate page state.
 */
export interface BrowserAutomationDiagnostics {
  url: string
  title: string
  origin: string | null
  readyState: string
  visibilityState: string
  viewport: { width: number; height: number; devicePixelRatio: number }
  scroll: { x: number; y: number; width: number; height: number }
  historyLength: number
  canGoBack: boolean
  canGoForward: boolean
  userAgent: string
  console: BrowserAutomationConsoleEntry[]
  errors: BrowserAutomationPageError[]
  network: BrowserAutomationNetworkEntry[]
  capturedAt: number
}

export interface BrowserAutomationScreenshot {
  url: string
  title: string
  dataUrl: string
  width: number
  height: number
  fullPage: boolean
  note?: string
  capturedAt: number
}

export interface BrowserAutomationInputField {
  selector?: string
  ref?: string
  text: string
  append?: boolean
}

export interface BrowserAutomationTarget {
  selector?: string
  /** Stable element ref from read_current_page (e1, e2, ...). */
  ref?: string
}

export type BrowserEmulationMedia = 'screen' | 'print'
export type BrowserEmulationColorScheme = 'light' | 'dark' | 'no-preference'
export type BrowserEmulationReducedMotion = 'reduce' | 'no-preference'

/** Emulation metadata mirrored from the main-process emulation session. */
export interface BrowserAutomationEmulatedState {
  media?: string
  colorScheme?: string
  reducedMotion?: string
  userAgent?: string | null
  viewport?: {
    width: number
    height: number
    deviceScaleFactor: number
    mobile: boolean
  }
}

/**
 * Built-in page emulation: media type, prefers-color-scheme,
 * prefers-reduced-motion, user agent and mobile device viewport. This is the
 * local replacement for chrome-devtools-mcp `emulate`.
 */
export interface BrowserAutomationEmulateAction {
  type: 'emulate'
  media?: BrowserEmulationMedia
  colorScheme?: BrowserEmulationColorScheme
  reducedMotion?: BrowserEmulationReducedMotion
  userAgent?: string
  width?: number
  height?: number
  deviceScaleFactor?: number
  mobile?: boolean
  reset?: boolean
  timeoutMs?: number
}


export type BrowserAutomationAction =
  | ({ type: 'click' } & BrowserAutomationTarget)
  | ({ type: 'input'; text: string; append?: boolean } & BrowserAutomationTarget)
  | { type: 'scroll'; top: number; left?: number }
  | { type: 'wait'; timeoutMs: number }
  | ({ type: 'select'; value?: string; label?: string; index?: number } & BrowserAutomationTarget)
  | { type: 'batch_input'; fields: BrowserAutomationInputField[] }
  | ({ type: 'extract'; offset?: number; maxChars?: number } & BrowserAutomationTarget)
  | { type: 'evaluate'; script: string; timeoutMs?: number }
  | ({ type: 'hover' } & BrowserAutomationTarget)
  | ({ type: 'focus' } & BrowserAutomationTarget)
  | ({ type: 'press_key'; key: string; modifiers?: string[] } & BrowserAutomationTarget)
  | {
      type: 'wait_for'
      selector?: string
      ref?: string
      text?: string | string[]
      url?: string
      state?: 'load' | 'domcontentloaded'
      timeoutMs?: number
    }
  | { type: 'find'; selector?: string; role?: string; name?: string; text?: string; limit?: number }
  | { type: 'navigate'; url: string; timeoutMs?: number }
  | { type: 'reload'; ignoreCache?: boolean; timeoutMs?: number }
  | { type: 'back'; timeoutMs?: number }
  | { type: 'forward'; timeoutMs?: number }
  | { type: 'resize'; width?: number; height?: number; reset?: boolean }
  | BrowserAutomationEmulateAction
  | { type: 'batch'; actions: BrowserAutomationAction[] }

export interface BrowserAutomationActionResult {
  ok: boolean
  type: BrowserAutomationAction['type']
  selector?: string
  ref?: string
  textLength?: number
  top?: number
  left?: number
  timeoutMs?: number
  text?: string
  offset?: number
  truncated?: boolean
  totalLength?: number
  result?: unknown
  resultType?: string
  filled?: number
  skipped?: number
  key?: string
  url?: string
  title?: string
  canGoBack?: boolean
  canGoForward?: boolean
  width?: number
  height?: number
  matches?: BrowserAutomationSnapshotElement[]
  results?: BrowserAutomationActionResult[]
  completed?: number
  error?: string
  note?: string
  emulated?: BrowserAutomationEmulatedState
  /** True when the action triggered a main-frame navigation. */
  navigated?: boolean
  /** True when a navigation started but did not finish before the wait timeout. */
  navigationTimedOut?: boolean
}

export type PageAutomationSnapshotMode = 'interactive' | 'article' | 'search_results'

export type PageAutomationRendererRequest =
  | { type: 'snapshot'; mode?: PageAutomationSnapshotMode }
  | { type: 'action'; action: BrowserAutomationAction }
  | { type: 'screenshot'; fullPage?: boolean; maxWidth?: number; format?: 'png' | 'jpeg'; quality?: number; timeoutMs?: number }
  | { type: 'diagnostics'; clear?: boolean }

export type PageAutomationRendererResult =
  | BrowserAutomationSnapshot
  | BrowserAutomationArticle
  | BrowserAutomationSearchResults
  | BrowserAutomationScreenshot
  | BrowserAutomationDiagnostics
  | BrowserAutomationActionResult

export interface BrowserPageContextMenuParams {
  x: number
  y: number
  selectionText: string
  linkURL: string
  mediaType: 'none' | 'image' | 'audio' | 'video' | 'canvas' | 'file' | 'text'
  srcURL: string
  isEditable: boolean
}

export interface BrowserPageContextMenuPayload {
  webContentsId: number
  params: BrowserPageContextMenuParams
}

export interface PageAutomationRequestEnvelope {
  requestId: string
  /** Workspace tab id when the tool targets a specific tab. */
  tabId?: string
  /** Conversation that owns the run; background targets are rejected in the renderer. */
  conversationId?: string
  request: PageAutomationRendererRequest
}

export interface PageAutomationResponseEnvelope {
  requestId: string
  ok: boolean
  result?: PageAutomationRendererResult
  error?: string
}

export interface BrowserPageScreenshotRequest {
  webContentsId: number
  fullPage?: boolean
  format?: 'png' | 'jpeg'
  quality?: number
  timeoutMs?: number
}

export interface BrowserPageScreenshotResult {
  dataUrl: string
  width: number
  height: number
  fullPage: boolean
  note?: string
}

export interface BrowserPageKeyDispatchRequest {
  webContentsId: number
  key: string
  modifiers?: string[]
}

export interface BrowserPageKeyDispatchResult {
  ok: boolean
}
