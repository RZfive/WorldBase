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

export type PageAutomationRendererRequest =
  | { type: 'snapshot' }
  | { type: 'action'; action: BrowserAutomationAction }

export type PageAutomationRendererResult = BrowserAutomationSnapshot | BrowserAutomationActionResult

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
