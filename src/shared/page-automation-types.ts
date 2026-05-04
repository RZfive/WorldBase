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

export interface BrowserAutomationSnapshot {
  url: string
  title: string
  origin: string | null
  textPreview: string
  interactiveElements: BrowserAutomationSnapshotElement[]
  capturedAt: number
}

export type BrowserAutomationAction =
  | { type: 'click'; selector: string }
  | { type: 'input'; selector: string; text: string }
  | { type: 'scroll'; top: number; left?: number }
  | { type: 'wait'; timeoutMs: number }

export interface BrowserAutomationActionResult {
  ok: boolean
  type: BrowserAutomationAction['type']
  selector?: string
  textLength?: number
  top?: number
  left?: number
  timeoutMs?: number
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