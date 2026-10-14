export interface ActivePageAutomationContext {
  appId: string
  kind: 'browser' | 'project'
  title: string
  url: string | null
  origin: string | null
}

export interface BrowserAutomationSnapshotElement {
  selector: string
  tag: string
  text: string
  role: string | null
}

export interface BrowserAutomationSnapshotFormFieldOption {
  value: string
  label: string
}

export interface BrowserAutomationSnapshotFormField {
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

export interface BrowserAutomationInputField {
  selector: string
  text: string
  append?: boolean
}

export type BrowserAutomationAction =
  | { type: 'click'; selector: string }
  | { type: 'input'; selector: string; text: string; append?: boolean }
  | { type: 'scroll'; top: number; left?: number }
  | { type: 'wait'; timeoutMs: number }
  | { type: 'select'; selector: string; value?: string; label?: string; index?: number }
  | { type: 'batch_input'; fields: BrowserAutomationInputField[] }
  | { type: 'extract'; selector?: string; offset?: number; maxChars?: number }
  | { type: 'evaluate'; script: string }
  | { type: 'hover'; selector: string }
  | { type: 'focus'; selector: string }
  | { type: 'press_key'; selector?: string; key: string }

export interface BrowserAutomationActionResult {
  ok: boolean
  type: BrowserAutomationAction['type']
  selector?: string
  textLength?: number
  top?: number
  left?: number
  timeoutMs?: number
  text?: string
  offset?: number
  truncated?: boolean
  totalLength?: number
  result?: unknown
  filled?: number
  skipped?: number
  key?: string
}

export type PageAutomationSnapshotMode = 'interactive' | 'article'

export type PageAutomationRendererRequest =
  | { type: 'snapshot'; mode?: PageAutomationSnapshotMode }
  | { type: 'action'; action: BrowserAutomationAction }

export type PageAutomationRendererResult =
  | BrowserAutomationSnapshot
  | BrowserAutomationArticle
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
  request: PageAutomationRendererRequest
}

export interface PageAutomationResponseEnvelope {
  requestId: string
  ok: boolean
  result?: PageAutomationRendererResult
  error?: string
}
