/**
 * AI-driven workspace tab management (`manage_workspace_tabs` tool). The tab
 * state itself lives in the renderer's workspace store; these envelopes carry
 * list/activate/close requests from the main process and the results back.
 */

/** Kind-agnostic summary of one workspace panel tab, as the AI sees it. */
export interface WorkspaceTabSummary {
  id: string
  kind: string
  title: string
  /** Whether this tab is the panel's active tab. */
  active: boolean
  /** browser tab: current URL. */
  url?: string
  /** terminal tab: working directory. */
  cwd?: string
  /** document tab: absolute file path. */
  filePath?: string
  /** project tab: developed-app id. */
  projectId?: string
  /** folder tab: bound code workspace root. */
  rootPath?: string
}

export type WorkspaceTabControlAction = 'list' | 'activate' | 'close'

export interface WorkspaceTabControlRequest {
  action: WorkspaceTabControlAction
  /**
   * Chat conversation the AI run belongs to. The renderer routes the request
   * to that conversation's workspace: the live panel only when it is the
   * conversation currently displayed, otherwise the conversation's stored
   * workspace snapshot — never another conversation's open workspace.
   */
  conversationId?: string
  /** Exact tab id from a previous `list`; wins over the match fields below. */
  tabId?: string
  /** Tab kind filter; with a match field below it locates one specific tab. */
  kind?: string
  /** browser only: matches an existing tab by URL (same rule as open dedupe). */
  url?: string
  /** terminal only: matches an existing tab by working directory. */
  cwd?: string
  /** document only: matches an existing tab by file path. */
  filePath?: string
}

export interface WorkspaceTabControlResult {
  ok: boolean
  action: WorkspaceTabControlAction
  /** Full tab strip snapshot after the action (also the `list` payload). */
  tabs?: WorkspaceTabSummary[]
  /** Tab the action landed on (activate/close). */
  tab?: WorkspaceTabSummary
}

export interface WorkspaceTabControlRequestEnvelope {
  requestId: string
  request: WorkspaceTabControlRequest
}

export interface WorkspaceTabControlResponseEnvelope {
  requestId: string
  ok: boolean
  result?: WorkspaceTabControlResult
  error?: string
}
