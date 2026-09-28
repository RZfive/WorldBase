import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import readline from 'node:readline'
import { resolveResourcesPath } from '../../src/main/app-update/hot-payload-store.js'
import { USER_ABORT_MESSAGE } from '../../src/main/ai-engine/abort-utils.js'
import { resolveModelPricing, type ModelPricing } from '../../src/main/ai-engine/cost-tracker.js'
import type { MCPServerSnapshot, MCPStateSnapshot } from '../../src/main/mcp/mcp-service.js'
import type { AIProvidersConfig, MCPServerConfig } from '../../src/main/settings/settings-store.js'
import type { AgentDefinition, AgentGroupDefinition, MemoryEmbeddingRuntimeConfig, MemoryEntry, MemorySearchScope, MemoryType } from '../../src/shared/agent-workspace-types.js'
import type { ImageStudioGenerateRequest, ImageStudioTask } from '../../src/shared/image-studio-types.js'
import type { ToolDefinition } from '../../src/main/ai-harness/contracts.js'

const moduleRequire = createRequire(import.meta.url)

export type JsonRpcResult = Record<string, unknown> | unknown[] | string | number | boolean | null

export interface RustEventFrame {
  streamId: string
  seq: number
  ts: string
  kind: string
  [key: string]: unknown
}

export interface RustHostRequest {
  requestId: string
  requestKind: string
  payload: Record<string, unknown>
  streamId: string
}

/** Conversation history representation accepted by `conversation.sync`. */
export interface RustSyncMessage {
  role: string
  content: unknown
  tool_calls?: unknown
  tool_call_id?: unknown
}

export interface RustToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  domain?: string
  permission?: string
  /** Rust owns execution in Electron; no TypeScript host override is needed. */
  electronNative?: boolean
}

/** A Rust Studio image record emitted on the `studio.generate` event stream. */
export interface RustStudioImageEntry extends Record<string, unknown> {
  id?: string
  file?: string
  createdAt?: string
  providerId?: string
  model?: string
  prompt?: string
  folder?: string
  tags?: string[]
  meta?: Record<string, unknown>
}

export interface RustStudioGenerateResult {
  streamId: string
  entries: RustStudioImageEntry[]
}

/** Rust-owned Image Studio library records returned by `studio.library.*`. */
export interface RustStudioLibraryPage {
  images?: RustStudioImageEntry[]
  total?: number
  nextOffset?: number | null
}

export interface RustStudioLibraryReadResult {
  dataUrl?: string
  sourceDataUrls?: string[]
  entry?: RustStudioImageEntry
}

export type RustProgressCallback = (stage: string, detail?: string) => void

/** A domain tool kept in Electron while Rust owns the model/tool loop. */
export interface RustCustomToolRegistration {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: RustProgressCallback) => Promise<unknown>
  /** Explicitly delegate a Rust builtin name back to Electron. */
  domain?: 'electron_host_override' | 'host'
  permission?: 'allow' | 'ask' | 'deny'
}

export interface RustChatOptions {
  providerId?: string
  model?: string
  agentId?: string
  authMode?: 'strict' | 'auto'
  history?: RustSyncMessage[]
  contentParts?: unknown
  systemPromptSections?: string[]
  activeSkillContents?: string[]
  allowedToolNames?: string[]
  deniedToolNames?: string[]
  customTools?: RustCustomToolRegistration[]
  workspaceRoot?: string | null
  targetProjectId?: string | null
  /** Restrict native Rust MCP calls to servers authorized for this run. */
  allowedMcpServerIds?: string[]
  /** Match the Node providers: reasoning is sent only when thinking is enabled. */
  enableThinking?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  temperature?: number
  /** Initialize Rust's per-run plan guard before the first provider call. */
  planModeActive?: boolean
  /** Stop before the next model-loop iteration once this run reaches the cap. */
  budgetLimit?: number | null
  /** Resolved Agent Workspace memory scopes owned by the Rust store. */
  memoryScopes?: MemorySearchScope[]
  /** Current user message used for Rust-side memory retrieval. */
  memoryQuery?: string
  /** Per-request embedding config for Rust-side semantic recall. */
  memoryEmbedding?: MemoryEmbeddingRuntimeConfig
  /** Explicit per-run opt-in for OS-level Computer Use tools. */
  computerUseEnabled?: boolean
}

/** Durable member identity supplied when Electron opens a Rust group session. */
export interface RustNativeGroupMember {
  name: string
  persona: string
  agentId?: string | null
  allowedToolNames?: string[]
  deniedToolNames?: string[]
}

export interface RustNativeGroupSession extends Record<string, unknown> {
  id: string
  topic?: string
  mode?: string
  coordinator?: string | null
  maxParallelWorkers?: number
  board?: Record<string, unknown>
}

export interface RustNativeGroupRoundOptions {
  /** Electron chat stream that owns renderer updates and interruption. */
  sessionId: string
  /** Rust group session ID returned from `group.create`. */
  groupId: string
  text: string
  round?: number
  memberIds?: string[]
  authMode?: 'strict' | 'auto'
  context?: RustChatOptions
  /** Build isolated Electron handlers lazily for each Rust member stream. */
  customToolsForStream?: (streamId: string) => RustCustomToolRegistration[]
  onEvent?: (frame: RustEventFrame) => void
}

export interface RustHarnessClientOptions {
  workspace: string
  dataDir: string
  /** Read the Electron provider catalog used to configure the Rust process. */
  getProviders?: () => AIProvidersConfig
  /** Read the Electron agent catalog used to configure the Rust process. */
  getAgents?: () => AgentDefinition[]
  /** Persist the Rust agent catalog into Electron's migration mirror. */
  onAgentsHandoff?: (agents: AgentDefinition[]) => void | Promise<void>
  /** Read the Electron group catalog used to configure the Rust process. */
  getAgentGroups?: () => AgentGroupDefinition[]
  /** Persist the Rust catalog into Electron's migration mirror on handoff. */
  onAgentGroupsHandoff?: (groups: AgentGroupDefinition[]) => void | Promise<void>
  /** Read the Electron MCP catalog used to configure the Rust process. */
  getMcpServers?: () => MCPServerConfig[]
  onEvent: (sessionId: string, frame: RustEventFrame) => void
  onHostRequest?: (request: RustHostRequest) => Promise<JsonRpcResult> | JsonRpcResult
  onPermissionRequest?: (request: { requestId: string; toolName: string; argsSummary: string; sessionId: string }) => Promise<boolean> | boolean
}

interface PendingRequest {
  resolve: (value: JsonRpcResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface RustResponse {
  jsonrpc?: string
  id?: number | string | null
  result?: JsonRpcResult
  error?: { code?: number; message?: string }
}

/**
 * Small JSON-RPC client used during the TS -> Rust harness migration. Keeping
 * this transport independent from renderer IPC makes the backend switch
 * reversible and lets unsupported Electron services continue using TS.
 */
export class RustHarnessClient {
  private readonly options: RustHarnessClientOptions
  private child: ChildProcessWithoutNullStreams | null = null
  private reader: readline.Interface | null = null
  private nextRequestId = 1
  private starting: Promise<void> | null = null
  private disposed = false
  private readonly pending = new Map<string, PendingRequest>()
  private readonly streamToSession = new Map<string, string>()
  private readonly sessionToStream = new Map<string, string>()
  private readonly startingSessions = new Set<string>()
  private readonly stopRequested = new Set<string>()
  private readonly handlers = new Map<string, (frame: RustEventFrame) => void>()
  private readonly sessionAuthModes = new Map<string, 'strict' | 'auto'>()
  private readonly backlog = new Map<string, RustEventFrame[]>()
  private readonly terminalWaiters = new Map<string, Set<() => void>>()
  private readonly sessionCustomTools = new Map<string, Map<string, RustCustomToolRegistration>>()
  /** Electron stream session -> durable Rust group session. */
  private readonly nativeGroups = new Map<string, string>()
  /** Electron stream session -> factory for isolated native-group member tools. */
  private readonly nativeGroupToolFactories = new Map<string, (streamId: string) => RustCustomToolRegistration[]>()
  /** Original Rust member stream -> its stateful Electron handler set. */
  private readonly nativeGroupMemberTools = new Map<string, Map<string, RustCustomToolRegistration>>()
  private readonly nativeGroupMemberStreams = new Map<string, Set<string>>()
  private modelPricing: Record<string, ModelPricing> = {}
  private availableTools: RustToolDescriptor[] = []
  private providerSyncFingerprint: string | null = null
  private agentSyncFingerprint: string | null = null
  private agentGroupSyncFingerprint: string | null = null
  private mcpSyncFingerprint: string | null = null
  private settingsSync: Promise<void> | null = null

  constructor (options: RustHarnessClientOptions) {
    this.options = options
  }

  /** Spawn and handshake once. Concurrent callers share the same startup. */
  async start (): Promise<void> {
    if (this.starting) return await this.starting
    if (this.child && !this.child.killed && this.child.exitCode === null) return
    this.starting = this.spawnAndInitialize()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  async call<T extends JsonRpcResult = JsonRpcResult> (method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.start()
    return await this.request<T>(method, params)
  }

  /**
   * Send an RPC only to the current app-server process. Event-forwarding
   * paths use this after ownership handoff begins so a late browser event
   * cannot start a fresh Rust harness behind the selected TypeScript backend.
   */
  async callRunning<T extends JsonRpcResult = JsonRpcResult> (method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.isRunning()) throw new Error('Rust harness is not running')
    return await this.request<T>(method, params)
  }

  /** Check whether the packaged/development Rust executable is present. */
  isAvailable (): boolean {
    return Boolean(resolveHarnessBinary())
  }

  /** True only when an already-started harness process can receive RPCs. */
  isRunning (): boolean {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null)
  }

  /**
   * Stop Rust-owned project processes without starting a harness just to shut
   * it down. This is used while handing project ownership back to the TS
   * RuntimeManager.
   */
  async stopAllProjects (): Promise<void> {
    if (!this.isRunning()) return
    await this.request('project.gateway.stopAll', {})
  }

  /**
   * Finish a Rust -> TypeScript handoff. Disposing the app-server also drops
   * Rust-owned MCP transports, preventing both harnesses from keeping the
   * same stdio server or remote session alive after the switch.
   */
  async handoffToTypeScript (): Promise<void> {
    let handoffError: unknown = null
    try {
      // Read directly from Rust before disposing.  Do not call syncSettings()
      // here: that would push the (possibly stale) TS mirror back into Rust
      // immediately before the handoff.
      if (this.isRunning() && this.options.onAgentGroupsHandoff) {
        try {
          const result = await this.request<{ groups?: unknown }>('agentGroup.list', {})
          const groups = Array.isArray(result?.groups)
            ? result.groups.filter((group): group is AgentGroupDefinition => Boolean(group && typeof group === 'object' && !Array.isArray(group)))
            : []
          await this.options.onAgentGroupsHandoff(groups)
        } catch (error) {
          handoffError = error
        }
      }
      if (this.isRunning() && this.options.onAgentsHandoff) {
        try {
          const result = await this.request<{ agents?: unknown }>('agent.list', {})
          const agents = Array.isArray(result?.agents)
            ? result.agents.filter((agent): agent is AgentDefinition => Boolean(agent && typeof agent === 'object' && !Array.isArray(agent)))
            : []
          await this.options.onAgentsHandoff(agents)
        } catch (error) {
          handoffError = handoffError || error
        }
      }
      await this.stopAllProjects()
    } finally {
      this.dispose()
    }
    if (handoffError) throw handoffError
  }

  /** Synchronous snapshot populated by the initialize handshake. */
  getAvailableTools (): RustToolDescriptor[] {
    return this.availableTools.map(tool => ({
      ...tool,
      inputSchema: { ...tool.inputSchema }
    }))
  }

  /**
   * Electron owns pricing preferences. Keep the Rust provider catalog in sync
   * before the next run so Rust-side accounting and budget checks use them.
   */
  setModelPricing (pricing: Record<string, ModelPricing>): void {
    this.modelPricing = Object.fromEntries(Object.entries(pricing)
      .filter(([model, value]) => Boolean(model.trim()) && isValidModelPricing(value))
      .map(([model, value]) => [model.trim(), {
        inputPerMillion: value.inputPerMillion,
        outputPerMillion: value.outputPerMillion,
        cacheReadPerMillion: value.cacheReadPerMillion
      }]))
    this.providerSyncFingerprint = null
  }

  private async request<T extends JsonRpcResult = JsonRpcResult> (method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.child?.stdin.writable) throw new Error('Rust harness is not running')

    const id = String(this.nextRequestId++)
    // JSON.stringify preserves lone UTF-16 surrogates as \udXXX escapes, but
    // serde_json correctly rejects those escapes. Sanitize every value and
    // object key at the transport boundary so page/tool payloads cannot turn
    // into an uncorrelated JSON-RPC parse error.
    const message = JSON.stringify(
      sanitizeJsonRpcValue({ jsonrpc: '2.0', id, method, params }),
      (_key, value) => typeof value === 'string' ? sanitizeJsonRpcText(value) : value
    ) + '\n'
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Rust harness request timed out: ${method}`))
      }, method === 'chat.send'
        || method === 'project.dev.start'
        || method.startsWith('project.build.')
        || method.startsWith('project.package.')
        || method === 'project.gateway.startAll'
        || method === 'project.gateway.stopAll'
        || method === 'mcp.refresh'
        || method === 'studio.library.export'
        ? 300_000
        // Protocol detection probes up to three wire protocols sequentially.
        : method === 'provider.detectProtocol'
        ? 90_000
        : 15_000)
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer
      })
      this.child?.stdin.write(message, error => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  async ensureConversation (conversationId: string, title?: string, agentId?: string): Promise<void> {
    await this.call('conversation.ensure', {
      id: conversationId,
      title: title || 'Electron conversation',
      agentId: agentId || null
    })
  }

  /**
   * Run a native Rust Studio request and collect its terminal image events.
   * Studio has the same asynchronous event transport as chat, but does not
   * have a conversation or tool-loop session. Keeping the stream mapping here
   * means Electron can import the resulting files into its existing gallery
   * without running the TypeScript image provider path.
   */
  async studioGenerate (params: Record<string, unknown>, onEvent?: (frame: RustEventFrame) => void): Promise<RustStudioGenerateResult> {
    const sessionId = `studio_${this.nextRequestId}_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const entries: RustStudioImageEntry[] = []
    let settled = false
    let resolveTerminal: ((value: RustStudioGenerateResult) => void) | null = null
    let rejectTerminal: ((error: Error) => void) | null = null
    let streamId = ''
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (error) rejectTerminal?.(error)
      else resolveTerminal?.({ streamId, entries })
    }
    const handler = (frame: RustEventFrame): void => {
      if (frame.kind === 'image_ready' && frame.entry && typeof frame.entry === 'object' && !Array.isArray(frame.entry)) {
        entries.push(frame.entry as RustStudioImageEntry)
      }
      if (frame.kind === 'error') finish(new Error(String(frame.message || 'Rust Studio request failed')))
      if (frame.kind === 'done') finish()
      onEvent?.(frame)
    }

    this.startingSessions.add(sessionId)
    this.handlers.set(sessionId, handler)
    try {
      await this.start()
      await this.syncSettings()
      // Install terminal callbacks before `studio.generate` is written. The
      // app-server can emit a cached/instant event before its RPC response is
      // observed, in which case it is replayed from `backlog` below.
      const terminal = new Promise<RustStudioGenerateResult>((resolve, reject) => {
        resolveTerminal = resolve
        rejectTerminal = reject
      })
      const result = await this.request<{ streamId?: string; stream_id?: string }>('studio.generate', params)
      streamId = result.streamId || result.stream_id || ''
      if (!streamId) throw new Error('Rust Studio did not return a stream id')
      timer = setTimeout(() => finish(new Error('Rust Studio request timed out')), 300_000)
      this.streamToSession.set(streamId, sessionId)
      this.sessionToStream.set(sessionId, streamId)
      const queued = this.backlog.get(streamId)
      if (queued) {
        this.backlog.delete(streamId)
        for (const frame of queued) this.handleEvent(frame)
      }
      return await terminal
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      this.startingSessions.delete(sessionId)
      if (timer) clearTimeout(timer)
      // Studio streams have no caller that waits for `done` separately, so
      // always release their temporary handler/mapping when this promise
      // settles (including the terminal event path).
      this.completeSession(sessionId, streamId || undefined)
    }
  }

  /** The full Image Studio gallery API is owned by Rust in Rust mode. */
  async studioLibraryQuery (params: Record<string, unknown>): Promise<RustStudioLibraryPage> {
    return await this.call('studio.library.query', params) as RustStudioLibraryPage
  }

  async studioLibraryRead (id: string, variant: 'thumb' | 'full' = 'full'): Promise<RustStudioLibraryReadResult | null> {
    const result = await this.call('studio.library.read', { id, variant }) as RustStudioLibraryReadResult
    return result && typeof result === 'object' ? result : null
  }

  async studioLibraryDeleteMany (ids: string[]): Promise<{ removed: number }> {
    return await this.call('studio.library.deleteMany', { ids }) as { removed: number }
  }

  async studioLibrarySetFolder (ids: string[], folder: string | undefined): Promise<{ updated: number }> {
    return await this.call('studio.library.setFolder', { ids, folder: folder || null }) as { updated: number }
  }

  async studioLibrarySetTags (id: string, tags: string[]): Promise<{ updated: boolean }> {
    return await this.call('studio.library.setTags', { id, tags }) as { updated: boolean }
  }

  async studioLibraryListFolders (): Promise<Array<Record<string, unknown>>> {
    const result = await this.call('studio.library.listFolders', {}) as { folders?: Array<Record<string, unknown>> }
    return Array.isArray(result?.folders) ? result.folders : []
  }

  async studioLibraryCreateFolder (name: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.call('studio.library.createFolder', { name }) as { folders?: Array<Record<string, unknown>> }
    return Array.isArray(result?.folders) ? result.folders : []
  }

  async studioLibraryRenameFolder (oldName: string, newName: string): Promise<{ updated: number }> {
    return await this.call('studio.library.renameFolder', { oldName, newName }) as { updated: number }
  }

  async studioLibraryDeleteFolder (name: string): Promise<{ updated: number }> {
    return await this.call('studio.library.deleteFolder', { name }) as { updated: number }
  }

  async studioLibraryListTags (): Promise<string[]> {
    const result = await this.call('studio.library.listTags', {}) as { tags?: string[] }
    return Array.isArray(result?.tags) ? result.tags.filter((tag): tag is string => typeof tag === 'string') : []
  }

  async studioLibraryExport (folder: string, destination: string): Promise<{ filePath?: string; count?: number }> {
    return await this.call('studio.library.export', { folder, destination }) as { filePath?: string; count?: number }
  }

  /** Rust-owned Studio queue checkpoint used by the Electron renderer. */
  async studioTasksLoad (): Promise<ImageStudioTask[]> {
    const result = await this.call<{ tasks?: unknown[] }>('studio.tasks.load', {})
    return Array.isArray(result?.tasks) ? result.tasks as ImageStudioTask[] : []
  }

  async studioTasksSave (tasks: ImageStudioTask[]): Promise<void> {
    await this.call('studio.tasks.save', { tasks: Array.isArray(tasks) ? tasks : [] })
  }

  /** Atomically hand native-agent image requests to the renderer scheduler. */
  async studioTasksDrain (): Promise<ImageStudioGenerateRequest[]> {
    const result = await this.call<{ tasks?: unknown[] }>('studio.tasks.drain', {})
    return Array.isArray(result?.tasks) ? result.tasks as ImageStudioGenerateRequest[] : []
  }

  /**
   * Open a Rust-owned group session. Electron supplies durable agent IDs for
   * UI selection only; all round state, board state, and injections remain in
   * the Rust harness after this call.
   */
  async createNativeGroup (params: {
    topic: string
    mode: string
    members: RustNativeGroupMember[]
    coordinator?: string | null
    maxParallelWorkers?: number
  }): Promise<RustNativeGroupSession> {
    const topic = params.topic.trim()
    if (!topic) throw new Error('A native Rust group requires a topic.')
    const members = params.members
      .filter(member => Boolean(member?.name?.trim()))
      .map(member => ({
        name: member.name.trim(),
        persona: member.persona?.trim() || member.name.trim(),
        agentId: normalizeOptionalString(member.agentId),
        allowedToolNames: normalizeStringArray(member.allowedToolNames),
        deniedToolNames: normalizeStringArray(member.deniedToolNames)
      }))
    if (members.length < 2) throw new Error('A native Rust group requires at least two members.')
    await this.start()
    await this.syncSettings()
    const result = await this.request<RustNativeGroupSession>('group.create', {
      topic,
      mode: params.mode || 'discussion',
      members,
      coordinator: normalizeOptionalString(params.coordinator),
      maxParallelWorkers: normalizeNativeGroupParallelWorkers(params.maxParallelWorkers)
    })
    if (!result || typeof result.id !== 'string' || !result.id.trim()) {
      throw new Error('Rust harness did not return a group session id.')
    }
    return result
  }

  async getNativeGroup (groupId: string): Promise<RustNativeGroupSession> {
    const id = groupId.trim()
    if (!id) throw new Error('A Rust group id is required.')
    return await this.call('group.get', { id }) as RustNativeGroupSession
  }

  /**
   * Rust-owned Agent Workspace group catalog.  These methods intentionally
   * use dedicated RPCs instead of exposing the generic settings key so the
   * Electron IPC contract stays typed and Rust can apply the same defaults as
   * the legacy AgentGroupStore.
   */
  async listAgentGroups (): Promise<AgentGroupDefinition[]> {
    await this.start()
    await this.syncSettings()
    const result = await this.request<{ groups?: unknown }>('agentGroup.list', {})
    return Array.isArray(result?.groups)
      ? result.groups.filter((group): group is AgentGroupDefinition => Boolean(group && typeof group === 'object' && !Array.isArray(group)))
      : []
  }

  async getAgentGroup (id: string): Promise<AgentGroupDefinition | null> {
    const normalizedId = id.trim()
    if (!normalizedId) throw new Error('An Agent Workspace group id is required.')
    await this.start()
    await this.syncSettings()
    const result = await this.request<{ group?: unknown }>('agentGroup.get', { id: normalizedId })
    return result?.group && typeof result.group === 'object' && !Array.isArray(result.group)
      ? result.group as AgentGroupDefinition
      : null
  }

  async saveAgentGroup (group: Partial<AgentGroupDefinition>, fallbackName?: string): Promise<AgentGroupDefinition> {
    if (!group || typeof group !== 'object') throw new Error('An Agent Workspace group is required.')
    await this.start()
    await this.syncSettings()
    const result = await this.request<{ group?: unknown }>('agentGroup.save', {
      group,
      fallbackName: typeof fallbackName === 'string' ? fallbackName : undefined
    })
    if (!result?.group || typeof result.group !== 'object' || Array.isArray(result.group)) {
      throw new Error('Rust harness did not return a saved Agent Workspace group.')
    }
    return result.group as AgentGroupDefinition
  }

  async deleteAgentGroup (id: string): Promise<boolean> {
    const normalizedId = id.trim()
    if (!normalizedId) throw new Error('An Agent Workspace group id is required.')
    await this.start()
    await this.syncSettings()
    const result = await this.request<{ deleted?: unknown }>('agentGroup.delete', { id: normalizedId })
    return result?.deleted === true
  }

  /** Rust-owned Agent Workspace agent catalog. */
  async listAgents (): Promise<AgentDefinition[]> {
    await this.start()
    await this.syncSettings()
    const result = await this.request<{ agents?: unknown }>('agent.list', {})
    return Array.isArray(result?.agents)
      ? result.agents.filter((agent): agent is AgentDefinition => Boolean(agent && typeof agent === 'object' && !Array.isArray(agent)))
      : []
  }

  async getAgent (id: string): Promise<AgentDefinition | null> {
    const normalizedId = id.trim()
    if (!normalizedId) throw new Error('An Agent Workspace agent id is required.')
    await this.start()
    await this.syncSettings()
    const result = await this.request<{ agent?: unknown }>('agent.get', { id: normalizedId })
    return result?.agent && typeof result.agent === 'object' && !Array.isArray(result.agent)
      ? result.agent as AgentDefinition
      : null
  }

  async saveAgent (agent: Partial<AgentDefinition>, fallbackName?: string): Promise<AgentDefinition> {
    if (!agent || typeof agent !== 'object') throw new Error('An Agent Workspace agent is required.')
    await this.start()
    await this.syncSettings()
    const result = await this.request<{ agent?: unknown }>('agent.save', {
      agent,
      fallbackName: typeof fallbackName === 'string' ? fallbackName : undefined
    })
    if (!result?.agent || typeof result.agent !== 'object' || Array.isArray(result.agent)) {
      throw new Error('Rust harness did not return a saved Agent Workspace agent.')
    }
    return result.agent as AgentDefinition
  }

  async deleteAgent (id: string): Promise<boolean> {
    const normalizedId = id.trim()
    if (!normalizedId) throw new Error('An Agent Workspace agent id is required.')
    await this.start()
    await this.syncSettings()
    const result = await this.request<{ deleted?: unknown }>('agent.delete', { id: normalizedId })
    return result?.deleted === true
  }

  /**
   * Start one Rust group round and route all group and derived member events
   * through the Electron chat stream. A child member `done` is deliberately
   * non-terminal; only `group_complete` / `group_error` releases this mapping.
   */
  async startNativeGroupRound (options: RustNativeGroupRoundOptions): Promise<{ streamId: string; round: number }> {
    const sessionId = options.sessionId.trim()
    const groupId = options.groupId.trim()
    const text = options.text.trim()
    if (!sessionId || !groupId || !text) throw new Error('sessionId, groupId, and text are required for a Rust group round.')

    const existingGroupId = this.nativeGroups.get(sessionId)
    if (existingGroupId && existingGroupId !== groupId) {
      throw new Error('The Electron stream is already attached to a different Rust group.')
    }
    this.startingSessions.add(sessionId)
    this.stopRequested.delete(sessionId)
    if (!this.sessionAuthModes.has(sessionId)) {
      this.sessionAuthModes.set(sessionId, options.authMode === 'auto' ? 'auto' : 'strict')
    }
    const handler = (frame: RustEventFrame) => options.onEvent
      ? options.onEvent(frame)
      : this.options.onEvent(sessionId, frame)
    this.handlers.set(sessionId, handler)
    this.nativeGroups.set(sessionId, groupId)
    this.streamToSession.set(groupId, sessionId)
    this.sessionToStream.set(sessionId, groupId)
    if (options.customToolsForStream) {
      this.nativeGroupToolFactories.set(sessionId, options.customToolsForStream)
    } else {
      this.nativeGroupToolFactories.delete(sessionId)
    }

    try {
      await this.start()
      await this.syncSettings()
      if (this.stopRequested.delete(sessionId)) throw new Error(USER_ABORT_MESSAGE)
      const result = await this.request<{ streamId?: string; stream_id?: string; round?: number }>('group.message', {
        id: groupId,
        text,
        round: typeof options.round === 'number' && Number.isFinite(options.round)
          ? Math.max(1, Math.floor(options.round))
          : undefined,
        memberIds: normalizeStringArray(options.memberIds),
        context: nativeGroupContext(options.context)
      })
      const streamId = result.streamId || result.stream_id || groupId
      if (streamId !== groupId) throw new Error('Rust group round returned an unexpected stream id.')
      const queued = this.backlog.get(groupId)
      if (queued) {
        this.backlog.delete(groupId)
        for (const frame of queued) this.handleEvent(frame)
      }
      if (this.stopRequested.delete(sessionId) && this.sessionToStream.has(sessionId)) {
        await this.call('chat.abort', { streamId: groupId })
      }
      return {
        streamId: groupId,
        round: typeof result.round === 'number' && Number.isFinite(result.round)
          ? result.round
          : typeof options.round === 'number' ? options.round : 1
      }
    } catch (error) {
      this.completeSession(sessionId, groupId)
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      this.startingSessions.delete(sessionId)
    }
  }

  async injectNativeGroup (sessionId: string, groupId: string, content: string, targetAgentIds?: string[]): Promise<{ queued?: number }> {
    const expectedGroupId = this.nativeGroups.get(sessionId)
    if (!expectedGroupId || expectedGroupId !== groupId) {
      throw new Error('No active Rust group session matches this stream.')
    }
    const text = content.trim()
    if (!text) throw new Error('Group injection content is required.')
    return await this.call('group.inject', {
      id: groupId,
      content: text,
      targetAgentIds: normalizeStringArray(targetAgentIds)
    }) as { queued?: number }
  }

  async updateNativeGroupBoard (sessionId: string, groupId: string, field: string, op: string, value: string): Promise<{ board?: Record<string, unknown> }> {
    if (this.nativeGroups.get(sessionId) !== groupId) {
      throw new Error('No active Rust group session matches this stream.')
    }
    return await this.call('group.board.update', { id: groupId, field, op, value }) as { board?: Record<string, unknown> }
  }

  getNativeGroupId (sessionId: string): string | null {
    return this.nativeGroups.get(sessionId) || null
  }

  async chatStream (sessionId: string, conversationId: string, text: string, options?: RustChatOptions, onEvent?: (frame: RustEventFrame) => void): Promise<{ streamId: string }> {
    this.startingSessions.add(sessionId)
    this.stopRequested.delete(sessionId)
    try {
      await this.start()
    } catch (error) {
      this.startingSessions.delete(sessionId)
      this.stopRequested.delete(sessionId)
      throw error
    }
    // An authorization-mode update can arrive while startup is still in
    // progress. Preserve that update instead of overwriting it with the mode
    // captured when the renderer initially invoked chatStream.
    if (!this.sessionAuthModes.has(sessionId)) {
      this.sessionAuthModes.set(sessionId, options?.authMode === 'auto' ? 'auto' : 'strict')
    }
    const handler = (frame: RustEventFrame) => onEvent ? onEvent(frame) : this.options.onEvent(sessionId, frame)
    this.handlers.set(sessionId, handler)
    this.sessionCustomTools.set(sessionId, new Map(
      (options?.customTools || [])
        .filter(tool => Boolean(tool.definition?.name?.trim()))
        .map(tool => [tool.definition.name, tool])
    ))
    try {
      await this.syncSettings()
      await this.ensureConversation(conversationId, undefined, options?.agentId)
      // An explicitly supplied empty history is meaningful: it clears any
      // messages left in the Rust store when the Electron conversation was
      // reset or imported from the TS store.
      if (options?.history !== undefined) {
        await this.syncConversationHistory(conversationId, options.history)
      }
      // A renderer stop can arrive while settings, conversation history, or
      // MCP context is being prepared. Do not send a prompt that has already
      // been cancelled; once `request` writes chat.send, the normal post-send
      // abort path below owns cancellation.
      if (this.stopRequested.delete(sessionId)) {
        throw new Error(USER_ABORT_MESSAGE)
      }
      const enableThinking = options?.enableThinking
      const reasoningEffort = enableThinking === false ? undefined : options?.reasoningEffort
      const result = await this.request<{ streamId?: string; stream_id?: string }>('chat.send', {
        conversationId,
        text,
        agentId: options?.agentId || null,
        providerId: options?.providerId || null,
        model: options?.model || null,
        contentParts: normalizeContentParts(options?.contentParts),
        systemPromptSections: normalizeStringArray(options?.systemPromptSections),
        activeSkillContents: normalizeStringArray(options?.activeSkillContents),
        allowedToolNames: normalizeStringArray(options?.allowedToolNames),
        deniedToolNames: normalizeStringArray(options?.deniedToolNames),
        customTools: (options?.customTools || []).map(toRustToolDescriptor),
        workspaceRoot: normalizeOptionalString(options?.workspaceRoot),
        targetProjectId: normalizeOptionalString(options?.targetProjectId),
        // Electron treats an empty MCP selection as unrestricted. Keep Rust
        // on that contract instead of turning an empty persisted array into a
        // deny-all policy.
        allowedMcpServerIds: normalizeMcpServerSelection(options?.allowedMcpServerIds),
        ...(enableThinking !== undefined ? { enableThinking } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        temperature: normalizeTemperature(options?.temperature),
        planModeActive: options?.planModeActive === true,
        budgetLimit: normalizeBudgetLimit(options?.budgetLimit),
        memoryScopes: Array.isArray(options?.memoryScopes) ? options.memoryScopes : [],
        memoryQuery: normalizeOptionalString(options?.memoryQuery || text),
        ...(options?.memoryEmbedding ? { memoryEmbedding: options.memoryEmbedding } : {}),
        computerUseEnabled: options?.computerUseEnabled === true
      })
      const streamId = result.streamId || result.stream_id
      if (!streamId) throw new Error('Rust harness did not return a stream id')
      this.streamToSession.set(streamId, sessionId)
      this.sessionToStream.set(sessionId, streamId)
      const queued = this.backlog.get(streamId)
      if (queued) {
        this.backlog.delete(streamId)
        // Events can arrive between chat.send being dispatched and its
        // response.  Replay through handleEvent so queued host/permission
        // requests are answered too, instead of only reaching the renderer.
        for (const frame of queued) this.handleEvent(frame)
      }
      if (this.stopRequested.delete(sessionId) && this.sessionToStream.has(sessionId)) {
        try {
          await this.call('chat.abort', { streamId })
        } catch (error) {
          // The stream already exists, so surface a terminal error instead of
          // letting IPC fall back and send the user's prompt a second time.
          handler({
            streamId,
            seq: 0,
            ts: new Date().toISOString(),
            kind: 'error',
            message: error instanceof Error ? error.message : String(error)
          })
          this.completeSession(sessionId, streamId)
        }
      }
      return { streamId }
    } catch (error) {
      this.completeSession(sessionId)
      throw error
    } finally {
      this.startingSessions.delete(sessionId)
    }
  }

  async stopSession (sessionId: string): Promise<boolean> {
    const streamId = this.sessionToStream.get(sessionId)
    if (!streamId) {
      if (!this.startingSessions.has(sessionId)) return false
      this.stopRequested.add(sessionId)
      return true
    }
    // Keep the session mapping until the Rust run publishes its terminal
    // frame.  Removing it immediately races the cancellation path and makes
    // the renderer wait forever for the corresponding `done` event.
    await this.call('chat.abort', { streamId })
    return true
  }

  setSessionAuthMode (sessionId: string, authMode: 'strict' | 'auto'): void {
    this.sessionAuthModes.set(sessionId, authMode)
  }

  hasSession (sessionId: string): boolean {
    return this.sessionToStream.has(sessionId) || this.startingSessions.has(sessionId)
  }

  /** Wait until a mapped Rust stream emits `done`/`error` or the process exits. */
  async waitForSessionEnd (sessionId: string, timeoutMs = 300_000): Promise<void> {
    if (!this.sessionToStream.has(sessionId)) return
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const waiters = this.terminalWaiters.get(sessionId)
        waiters?.delete(finish)
        if (waiters && waiters.size === 0) this.terminalWaiters.delete(sessionId)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      const waiters = this.terminalWaiters.get(sessionId) || new Set<() => void>()
      waiters.add(finish)
      this.terminalWaiters.set(sessionId, waiters)
    })
  }

  async respondHost (requestId: string, result: JsonRpcResult): Promise<void> {
    // Host handlers can finish after their originating stream or process has
    // already exited. Never let that late reply start a fresh harness and
    // deliver an obsolete request id to the replacement process.
    await this.callRunning('host.respond', { requestId, result })
  }

  /** Refresh provider definitions after Electron settings change or before a chat. */
  async syncProviders (): Promise<void> {
    await this.start()
    await this.syncSettings()
  }

  /** Apply Electron's durable MCP catalog without creating a TS MCP client. */
  async syncMcpServers (): Promise<void> {
    await this.start()
    await this.syncMcpSettings()
  }

  /** Rust-owned replacement for Electron MCPService.getState in Rust mode. */
  async getMcpState (): Promise<MCPStateSnapshot> {
    await this.start()
    await this.syncMcpSettings()
    return await this.request('mcp.status', {}) as unknown as MCPStateSnapshot
  }

  /** Rediscover one Rust MCP server, or every enabled server when omitted. */
  async refreshMcpServer (serverId?: string): Promise<MCPStateSnapshot | MCPServerSnapshot> {
    await this.start()
    await this.syncMcpSettings()
    const params = serverId?.trim() ? { serverId: serverId.trim() } : {}
    return await this.request('mcp.refresh', params) as unknown as MCPStateSnapshot | MCPServerSnapshot
  }

  /** Drop one Rust MCP connection while preserving its discovery metadata. */
  async disconnectMcpServer (serverId: string): Promise<MCPServerSnapshot> {
    await this.start()
    await this.syncMcpSettings()
    return await this.request('mcp.disconnect', { serverId }) as unknown as MCPServerSnapshot
  }

  async listMemory (options: { query?: string; scopes?: MemorySearchScope[]; memoryTypes?: MemoryType[]; limit?: number } = {}): Promise<MemoryEntry[]> {
    const result = await this.call<{ entries?: unknown[] }>('memory.list', {
      query: options.query,
      scopes: options.scopes,
      memoryTypes: options.memoryTypes,
      limit: options.limit
    })
    return Array.isArray(result?.entries) ? result.entries as MemoryEntry[] : []
  }

  async saveMemory (entry: Partial<MemoryEntry>): Promise<MemoryEntry> {
    const result = await this.call<{ entry?: unknown }>('memory.save', { entry })
    if (!result?.entry || typeof result.entry !== 'object' || Array.isArray(result.entry)) {
      throw new Error('Rust harness did not return a saved memory entry.')
    }
    return result.entry as MemoryEntry
  }

  async pinMemory (id: string, pinned: boolean): Promise<boolean> {
    const result = await this.call<{ updated?: unknown }>('memory.pin', { id, pinned })
    return result?.updated === true
  }

  async deleteWorkspaceMemory (id: string): Promise<boolean> {
    const result = await this.call<{ deleted?: unknown }>('memory.delete', { id })
    return result?.deleted === true
  }

  async compactWorkspaceMemory (plan: Record<string, unknown>): Promise<JsonRpcResult> {
    return await this.call('memory.compact', { plan })
  }

  async getWorkspaceMemoryCompactionStatus (): Promise<JsonRpcResult> {
    return await this.call('memory.compactStatus', {})
  }

  async ingestMemory (input: {
    scopes: MemorySearchScope[]
    agent?: unknown
    userMessages: string[]
    finalAssistantText?: string
    toolNames?: string[]
    targetProjectId?: string | null
    sourceConversationId?: string
    sourceSessionId?: string
  }): Promise<MemoryEntry[]> {
    const result = await this.call<{ entries?: unknown[] }>('memory.ingest', input as unknown as Record<string, unknown>)
    return Array.isArray(result?.entries) ? result.entries as MemoryEntry[] : []
  }

  private async syncSettings (): Promise<void> {
    if (this.settingsSync) {
      await this.settingsSync
      return
    }
    const sync = (async () => {
      await this.syncProviderSettings()
      await this.syncAgentSettings()
      await this.syncAgentGroupSettings()
      await this.syncMcpSettings()
    })()
    this.settingsSync = sync
    try {
      await sync
    } finally {
      if (this.settingsSync === sync) this.settingsSync = null
    }
  }

  private async syncConversationHistory (conversationId: string, messages: RustSyncMessage[]): Promise<void> {
    const normalized = sanitizeSyncMessageSequence(messages)
      .map(message => {
        const isToolResult = message.role === 'tool'
        return {
          role: message.role === 'assistant' ? 'assistant' : message.role === 'system' || message.role === 'developer' ? 'system' : 'user',
          // Rust represents provider tool responses as a user-role message whose
          // content consists only of ToolResult blocks. Copying the text field as
          // well would emit a second ordinary user message to OpenAI-compatible
          // providers.
          content: isToolResult ? '' : textFromMessageContent(message.content),
          parts: isToolResult ? [] : normalizeContentParts(message.content),
          toolCalls: normalizeToolCalls(message.tool_calls),
          toolResults: normalizeToolResults(message)
        }
      })
      .filter(message => message.content.length > 0 || message.parts.length > 0 || message.toolCalls.length > 0 || message.toolResults.length > 0)
    await this.call('conversation.sync', {
      id: conversationId,
      authoritative: true,
      messages: normalized
    })
  }

  dispose (): void {
    this.disposed = true
    this.reader?.close()
    this.reader = null
    const child = this.child
    this.child = null
    if (child && !child.killed) child.kill()
    const error = new Error('Rust harness stopped')
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer)
      request.reject(error)
      this.pending.delete(id)
    }
    this.handlers.clear()
    this.sessionAuthModes.clear()
    this.streamToSession.clear()
    this.sessionToStream.clear()
    this.startingSessions.clear()
    this.stopRequested.clear()
    this.backlog.clear()
    this.sessionCustomTools.clear()
    this.nativeGroups.clear()
    this.nativeGroupToolFactories.clear()
    this.nativeGroupMemberTools.clear()
    this.nativeGroupMemberStreams.clear()
    for (const waiters of this.terminalWaiters.values()) {
      for (const finish of waiters) finish()
    }
    this.terminalWaiters.clear()
    this.providerSyncFingerprint = null
    this.agentSyncFingerprint = null
    this.agentGroupSyncFingerprint = null
    this.mcpSyncFingerprint = null
    this.settingsSync = null
  }

  private async spawnAndInitialize (): Promise<void> {
    this.disposed = false
    const binary = resolveHarnessBinary()
    if (!binary) {
      throw new Error('Rust harness binary not found. Build worldbase-app-server or set WORLDBASE_RUST_HARNESS.')
    }
    const child = spawn(binary, [
      '--workspace', this.options.workspace,
      '--data-dir', this.options.dataDir
    ], {
      cwd: this.options.workspace,
      env: {
        ...process.env,
        WORLDBASE_HOME: this.options.dataDir,
        // Rust owns project child processes in Rust mode. Give it the same
        // Electron-bundled Node/pnpm runtime that the TS RuntimeManager uses,
        // so packaged builds do not depend on a host-installed toolchain.
        WORLDBASE_RUNTIME_NODE: process.execPath,
        WORLDBASE_RUNTIME_NODE_IS_ELECTRON: '1',
        WORLDBASE_RUNTIME_PNPM: resolveBundledPnpmCli() || undefined
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    child.stderr.on('data', chunk => {
      const text = String(chunk).trim()
      if (text) console.warn(`[rust-harness] ${text}`)
    })
    child.on('error', error => {
      if (this.child === child) this.handleExit(error)
    })
    child.on('close', (code, signal) => {
      // A previous handshake can finish closing after a new client has been
      // spawned. Only the currently owned child may tear down client state.
      if (this.child === child && !this.disposed) {
        this.handleExit(new Error(`Rust harness exited (${code ?? signal ?? 'unknown'})`))
      }
    })
    this.reader = readline.createInterface({ input: child.stdout })
    this.reader.on('line', line => this.handleLine(line))

    try {
      const initialize = await this.request<{
        availableTools?: RustToolDescriptor[]
        available_tools?: RustToolDescriptor[]
      }>('initialize', {
        protocolVersion: '1.0',
        capabilities: {
          platform: 'electron',
          features: ['subprocess', 'port_binding', 'webhook_receiver', 'webview_automation', 'interactive', 'computer_screen_capture', 'computer_input_injection'],
          excludes: []
        }
      })
      this.availableTools = (initialize.availableTools || initialize.available_tools || [])
        .filter((tool): tool is RustToolDescriptor => Boolean(tool && typeof tool.name === 'string'))
      await this.syncSettings()
    } catch (error) {
      // A timeout during handshake/settings sync leaves a child alive unless
      // we terminate it explicitly.  Otherwise the next request can race the
      // half-initialized process and leak one Rust server per failed attempt.
      if (this.child === child) {
        this.disposed = true
        if (!child.killed) child.kill()
        this.handleExit(error instanceof Error ? error : new Error(String(error)))
      }
      throw error
    }
  }

  /**
   * Probe-based wire-protocol auto-detection. The Rust harness sends the
   * minimal message "hi" through Responses → Chat Completions → Anthropic and
   * reports the first protocol that answers with a matching response shape.
   */
  async detectProviderProtocol (input: { baseUrl: string; apiKey: string; model: string }): Promise<{
    protocol: 'openai-chat' | 'openai-responses' | 'anthropic' | null
    probes: Array<{ protocol: string; ok: boolean; error?: string }>
  }> {
    const result = await this.request<{
      protocol?: 'openai-chat' | 'openai-responses' | 'anthropic' | null
      probes?: Array<{ protocol?: unknown; ok?: unknown; error?: unknown }>
    }>('provider.detectProtocol', {
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model
    })
    return {
      protocol: result.protocol ?? null,
      probes: (result.probes || []).map(probe => ({
        protocol: typeof probe.protocol === 'string' ? probe.protocol : '',
        ok: probe.ok === true,
        error: typeof probe.error === 'string' ? probe.error : undefined
      }))
    }
  }

  private async syncProviderSettings (): Promise<void> {
    const getProviders = this.options.getProviders
    if (!getProviders) return

    const config = getProviders()
    const fingerprint = JSON.stringify({ config, pricing: this.modelPricing })
    if (fingerprint === this.providerSyncFingerprint) return
    const configuredIds = new Set((config.providers || []).map(provider => provider.id))
    const existing = await this.request<{
      providers?: { providers?: Array<{ id?: string }> }
    }>('provider.list')
    const existingProviders = existing.providers?.providers || []
    for (const provider of existingProviders) {
      if (provider.id && !configuredIds.has(provider.id)) {
        await this.request('provider.delete', { id: provider.id })
      }
    }
    // Rust's provider registry is persisted in the shared harness database.
    // Keep its shape deliberately explicit so new Electron-only fields do not
    // make provider.save fail deserialization.
    for (const provider of config.providers || []) {
      const models = (provider.models || []).map(model => {
        const pricing = resolveModelPricing(model, this.modelPricing)
        return {
          id: model,
          contextWindowK: Math.ceil((provider.modelContextWindows?.[model] || 0) / 1000),
          inputPrice: pricing?.inputPerMillion ?? 0,
          outputPrice: pricing?.outputPerMillion ?? 0,
          cacheReadPrice: pricing?.cacheReadPerMillion ?? 0,
          imageGeneration: provider.modelCapabilities?.[model]?.imageGeneration === true,
          imageEditing: provider.modelCapabilities?.[model]?.imageEditing === true
        }
      })
      await this.request('provider.save', {
        provider: {
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          // Always send the concrete wire protocol: auto entries carry their
          // last probe result so the harness never guesses at runtime.
          apiProtocol: provider.apiProtocol || provider.detectedApiProtocol || 'openai-chat',
          models,
          activeModel: provider.activeModel,
          temperature: normalizeTemperature(provider.temperature),
          enableThinking: provider.enableThinking === true,
          imageGeneration: provider.modelCapabilities?.[provider.activeModel]?.imageGeneration === true
        }
      })
    }

    if (config.activeProviderId) {
      await this.request('provider.setActive', { id: config.activeProviderId })
    }
    this.providerSyncFingerprint = fingerprint
  }

  private async syncAgentSettings (): Promise<void> {
    const getAgents = this.options.getAgents
    if (!getAgents) return
    const agents = getAgents()
    const fingerprint = JSON.stringify(agents)
    if (fingerprint === this.agentSyncFingerprint) return
    const existing = await this.request<{ agents?: Array<{ id?: string }> }>('agent.list')
    const configuredIds = new Set(agents.map(agent => agent.id))
    for (const agent of existing.agents || []) {
      if (agent.id && !configuredIds.has(agent.id)) {
        await this.request('agent.delete', { id: agent.id })
      }
    }
    for (const agent of agents) {
      await this.request('agent.save', {
        agent: {
          id: agent.id,
          name: agent.name,
          icon: agent.icon || '',
          description: agent.description,
          systemPrompt: agent.systemPrompt,
          providerId: agent.providerId || null,
          modelId: agent.modelId || null,
          skillIds: agent.skillIds || [],
          reasoningStrength: agent.reasoningStrength || 'medium',
          allowedTools: agent.allowedTools || [],
          deniedTools: agent.deniedTools || [],
          memoryScopes: agent.memoryScopes || ['user', 'agent', 'project'],
          memoryWritePolicy: agent.memoryWritePolicy,
          autoReplyPolicy: agent.autoReplyPolicy,
          createdAt: agent.createdAt,
          updatedAt: agent.updatedAt
        }
      })
    }
    this.agentSyncFingerprint = fingerprint
  }

  /**
   * Seed Rust's durable Agent Workspace catalog from Electron's migration
   * mirror.  Once the Rust backend is selected, the public group IPC uses the
   * dedicated agentGroup.* RPCs; this sync only bridges pre-existing TS files
   * (and keeps a later TS handoff lossless).
   */
  private async syncAgentGroupSettings (): Promise<void> {
    const getAgentGroups = this.options.getAgentGroups
    if (!getAgentGroups) return
    const groups = getAgentGroups()
    const fingerprint = JSON.stringify(groups)
    if (fingerprint === this.agentGroupSyncFingerprint) return
    await this.request('settings.set', { key: 'agent_groups', value: groups })
    this.agentGroupSyncFingerprint = fingerprint
  }

  private async syncMcpSettings (): Promise<void> {
    const getMcpServers = this.options.getMcpServers
    if (!getMcpServers) return

    const servers = getMcpServers()
    const fingerprint = JSON.stringify(servers)
    if (fingerprint === this.mcpSyncFingerprint) return

    await this.request('mcp.reload', {
      servers: servers.map(server => ({
        // Use Electron's durable ID in Rust tool calls and permission checks.
        name: server.id,
        displayName: server.name,
        enabled: server.enabled !== false,
        transport: server.transport,
        target: server.transport === 'stdio' ? server.command : server.url,
        args: server.args,
        cwd: server.cwd || null,
        env: server.env,
        headers: server.headers,
        timeoutMs: server.timeoutMs
      }))
    })
    this.mcpSyncFingerprint = fingerprint
  }

  private handleLine (line: string): void {
    let message: RustResponse & { method?: string; params?: RustEventFrame }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      console.warn('[rust-harness] Ignoring invalid JSON from app-server')
      return
    }
    if (message.method === 'event' && message.params) {
      this.handleEvent(message.params)
      return
    }
    if (message.id === undefined || message.id === null) {
      if (message.error && this.pending.size > 0) {
        const code = typeof message.error.code === 'number' ? ` (${message.error.code})` : ''
        const error = new Error(`Rust harness rejected an uncorrelated JSON-RPC request${code}: ${message.error.message || 'unknown protocol error'}`)
        // The server cannot identify which NDJSON line failed to parse. Fail
        // every in-flight request immediately; otherwise chat.send can hang
        // for five minutes and the remaining responses are ambiguous anyway.
        for (const [pendingId, request] of this.pending) {
          clearTimeout(request.timer)
          request.reject(error)
          this.pending.delete(pendingId)
        }
      }
      return
    }
    const id = String(message.id)
    const request = this.pending.get(id)
    if (!request) return
    this.pending.delete(id)
    clearTimeout(request.timer)
    if (message.error) {
      request.reject(new Error(message.error.message || 'Rust harness request failed'))
    } else {
      request.resolve(message.result ?? null)
    }
  }

  private handleEvent (frame: RustEventFrame): void {
    const directSessionId = this.streamToSession.get(frame.streamId)
    const nativeGroupSession = directSessionId ? null : this.nativeGroupSessionForMemberStream(frame.streamId)
    const sessionId = directSessionId || nativeGroupSession
    if (!sessionId) {
      // Direct document/workbench RPCs can ask the host to perform a shell
      // operation without first creating a chat session. They still arrive as
      // regular `host_request` events, so dispatch them before the session
      // backlog gate; otherwise the request would never be answered.
      if (frame.kind === 'host_request') {
        void this.handleHostRequest(frame, frame.streamId)
        return
      }
      const queue = this.backlog.get(frame.streamId) || []
      queue.push(frame)
      this.backlog.set(frame.streamId, queue)
      return
    }
    const groupId = this.nativeGroups.get(sessionId)
    const isNativeGroupMemberFrame = Boolean(nativeGroupSession && groupId)
    const routedFrame = isNativeGroupMemberFrame
      ? {
          ...frame,
          streamId: groupId!,
          groupMemberStreamId: frame.streamId
        }
      : frame
    const handler = this.handlers.get(sessionId)
    if (handler) {
      try {
        handler(routedFrame)
      } catch (error) {
        // Renderer/progress listeners are host-side observers. They must not
        // prevent terminal cleanup or leave a Rust tool request unanswered.
        console.error('[rust-harness] Event handler failed:', error)
      }
    }
    if (frame.kind === 'host_request') {
      void this.handleHostRequest(routedFrame, sessionId)
    }
    if (frame.kind === 'permission_request') {
      void this.handlePermissionRequest(routedFrame, sessionId)
    }
    if (groupId) {
      if (isNativeGroupMemberFrame && (frame.kind === 'done' || frame.kind === 'error')) {
        this.releaseNativeGroupMemberTools(sessionId, frame.streamId)
      }
      // Child agents publish their own Done/Error events. They are not the
      // native group terminal: the dispatcher publishes group_complete or
      // group_error only after aggregation/board updates have finished.
      const terminalGroupDone = !isNativeGroupMemberFrame && frame.kind === 'done' &&
        (frame.stopReason === 'group_complete' || frame.stopReason === 'group_error')
      if (terminalGroupDone || (!isNativeGroupMemberFrame && frame.kind === 'error')) {
        this.completeSession(sessionId, groupId)
      }
      return
    }
    if (frame.kind === 'done' || frame.kind === 'error') {
      this.completeSession(sessionId, frame.streamId)
    }
  }

  private nativeGroupSessionForMemberStream (streamId: string): string | null {
    for (const [sessionId, groupId] of this.nativeGroups) {
      if (streamId.startsWith(`${groupId}:member:`)) return sessionId
    }
    return null
  }

  private async handlePermissionRequest (frame: RustEventFrame, sessionId: string): Promise<void> {
    const requestId = String(frame.requestId || '')
    if (!requestId) return
    try {
      const allow = this.sessionAuthModes.get(sessionId) === 'auto'
        ? true
        : await this.options.onPermissionRequest?.({
            requestId,
            toolName: String(frame.toolName || ''),
            argsSummary: String(frame.argsSummary || ''),
            sessionId
          })
      // A permission dialog may resolve after the run has been cancelled or
      // the process has exited. Replies belong only to the current process.
      await this.callRunning('chat.respond', { requestId, allow: Boolean(allow) })
    } catch (error) {
      // The associated stream will receive the transport failure through
      // handleExit. Avoid an unhandled rejection from this event callback.
      console.warn('[rust-harness] Failed to answer permission request:', error)
    }
  }

  private async handleHostRequest (frame: RustEventFrame, sessionId: string): Promise<void> {
    const requestId = String(frame.requestId || '')
    if (!requestId) return
    try {
      const requestKind = String(frame.requestKind || '')
      const memberStreamId = typeof frame.groupMemberStreamId === 'string'
        ? frame.groupMemberStreamId
        : ''
      const request: RustHostRequest = {
        requestId,
        requestKind,
        payload: (frame.payload && typeof frame.payload === 'object') ? frame.payload as Record<string, unknown> : {},
        // UI host requests remain attached to the parent Electron stream. A
        // stateful tool handler, however, must be selected by the original
        // Rust member stream rather than the rewritten group stream.
        streamId: requestKind === 'tool.execute' && memberStreamId
          ? memberStreamId
          : frame.streamId || sessionId
      }
      const result = request.requestKind === 'tool.execute'
        ? await this.executeSessionCustomTool(sessionId, request)
        : await this.executeHostRequest(request)
      await this.respondHost(requestId, result)
    } catch (error) {
      try {
        await this.respondHost(requestId, { error: error instanceof Error ? error.message : String(error) })
      } catch (respondError) {
        // The process can exit while an Electron host tool is running. The
        // session exit path emits the terminal error; do not leak a rejected
        // promise from the detached event handler.
        console.warn('[rust-harness] Failed to answer host request:', respondError)
      }
    }
  }

  private async executeHostRequest (request: RustHostRequest): Promise<JsonRpcResult> {
    if (!this.options.onHostRequest) {
      throw new Error(`No Electron host handler for Rust request: ${request.requestKind}`)
    }
    return await this.options.onHostRequest(request)
  }

  private async executeSessionCustomTool (sessionId: string, request: RustHostRequest): Promise<JsonRpcResult> {
    const name = typeof request.payload.name === 'string' ? request.payload.name.trim() : ''
    const rawArgs = request.payload.args
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? rawArgs as Record<string, unknown>
      : {}
    const memberStream = this.nativeGroupSessionForMemberStream(request.streamId) === sessionId
      ? request.streamId
      : ''
    const tools = memberStream
      ? this.nativeGroupToolsForStream(sessionId, memberStream)
      : this.sessionCustomTools.get(sessionId)
    const tool = tools?.get(name)
    if (!tool) throw new Error(`Rust requested unavailable Electron custom tool: ${name || '(missing name)'}`)
    const result = await tool.handler(args, (stage, detail) => {
      const groupId = memberStream ? this.nativeGroups.get(sessionId) : null
      this.handlers.get(sessionId)?.({
        streamId: groupId || request.streamId,
        seq: -1,
        ts: new Date().toISOString(),
        kind: 'progress',
        stage,
        detail,
        ...(groupId ? { groupMemberStreamId: memberStream } : {})
      })
    })
    return (result ?? null) as JsonRpcResult
  }

  private nativeGroupToolsForStream (
    sessionId: string,
    streamId: string
  ): Map<string, RustCustomToolRegistration> | undefined {
    const existing = this.nativeGroupMemberTools.get(streamId)
    if (existing) return existing
    const factory = this.nativeGroupToolFactories.get(sessionId)
    if (!factory) return undefined
    const registrations = factory(streamId)
    const tools = new Map(registrations
      .filter(tool => Boolean(tool.definition?.name?.trim()))
      .map(tool => [tool.definition.name, tool]))
    this.nativeGroupMemberTools.set(streamId, tools)
    const streams = this.nativeGroupMemberStreams.get(sessionId) || new Set<string>()
    streams.add(streamId)
    this.nativeGroupMemberStreams.set(sessionId, streams)
    return tools
  }

  private releaseNativeGroupMemberTools (sessionId: string, streamId: string): void {
    this.nativeGroupMemberTools.delete(streamId)
    const streams = this.nativeGroupMemberStreams.get(sessionId)
    if (!streams) return
    streams.delete(streamId)
    if (streams.size === 0) this.nativeGroupMemberStreams.delete(sessionId)
  }

  private releaseNativeGroupTools (sessionId: string): void {
    this.nativeGroupToolFactories.delete(sessionId)
    const streams = this.nativeGroupMemberStreams.get(sessionId)
    if (!streams) return
    for (const streamId of streams) this.nativeGroupMemberTools.delete(streamId)
    this.nativeGroupMemberStreams.delete(sessionId)
  }

  private handleExit (error: Error): void {
    if (this.child) this.child = null
    this.reader?.close()
    this.reader = null
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer)
      request.reject(error)
      this.pending.delete(id)
    }
    for (const [sessionId, handler] of this.handlers) {
      try {
        handler({ streamId: this.sessionToStream.get(sessionId) || '', seq: 0, ts: new Date().toISOString(), kind: 'error', message: error.message })
      } catch (handlerError) {
        console.error('[rust-harness] Exit event handler failed:', handlerError)
      }
      this.completeSession(sessionId)
    }
    this.handlers.clear()
    this.sessionAuthModes.clear()
    this.streamToSession.clear()
    this.sessionToStream.clear()
    this.startingSessions.clear()
    this.stopRequested.clear()
    this.backlog.clear()
    this.sessionCustomTools.clear()
    this.nativeGroups.clear()
    this.nativeGroupToolFactories.clear()
    this.nativeGroupMemberTools.clear()
    this.nativeGroupMemberStreams.clear()
    for (const waiters of this.terminalWaiters.values()) {
      for (const finish of waiters) finish()
    }
    this.terminalWaiters.clear()
    this.providerSyncFingerprint = null
    this.agentSyncFingerprint = null
    this.agentGroupSyncFingerprint = null
    this.mcpSyncFingerprint = null
    this.settingsSync = null
  }

  private completeSession (sessionId: string, streamId = this.sessionToStream.get(sessionId)): void {
    this.sessionToStream.delete(sessionId)
    if (streamId) this.streamToSession.delete(streamId)
    this.handlers.delete(sessionId)
    this.sessionCustomTools.delete(sessionId)
    this.releaseNativeGroupTools(sessionId)
    this.nativeGroups.delete(sessionId)
    this.sessionAuthModes.delete(sessionId)
    this.stopRequested.delete(sessionId)
    const waiters = this.terminalWaiters.get(sessionId)
    if (!waiters) return
    for (const finish of waiters) finish()
    this.terminalWaiters.delete(sessionId)
  }
}

function normalizeNativeGroupParallelWorkers (value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 2
  return Math.max(1, Math.min(5, parsed))
}

function resolveBundledPnpmCli (): string | null {
  try {
    let packageRoot = path.dirname(moduleRequire.resolve('pnpm'))
    // The Rust app-server cannot load a CLI from inside app.asar. Electron
    // unpacks pnpm during packaging; mirror the path rewrite used by the TS
    // runtime helper so both engines execute the identical bundled CLI.
    const asarMatch = packageRoot.match(/^(.*)\.asar(.*)$/)
    if (asarMatch) packageRoot = path.join(`${asarMatch[1]}.asar.unpacked`, asarMatch[2])
    const candidates = [
      path.join(packageRoot, 'bin', 'pnpm.cjs'),
      path.join(packageRoot, 'dist', 'pnpm.cjs')
    ]
    return candidates.find(candidate => fs.existsSync(candidate)) || null
  } catch {
    return null
  }
}

function resolveHarnessBinary (): string | null {
  const override = process.env.WORLDBASE_RUST_HARNESS
  const executable = process.platform === 'win32' ? 'worldbase-app-server.exe' : 'worldbase-app-server'
  // 热更新包生效时 harness 必须与 JS 同源（WORLDBASE_HOT_RESOURCES 指向热包目录），
  // 协议版本才能原子切换；未启用时 resolveResourcesPath 回退 process.resourcesPath。
  // `app.getAppPath()` remains the Electron package root after the main
  // process is compiled into dist-electron, so development lookup does not
  // depend on the bundled module's location or process cwd.
  const electronDir = app.getAppPath()
  const repoRoot = path.resolve(electronDir, '../..')
  const candidates = [
    override,
    app.isPackaged ? path.join(resolveResourcesPath(), 'harness', executable) : undefined,
    path.join(electronDir, 'resources', 'harness', executable),
    path.join(repoRoot, 'harness-rs', 'target', 'release', executable),
    path.join(repoRoot, 'harness-rs', 'target', 'debug', executable),
    path.resolve(process.cwd(), '../../harness-rs', 'target', 'release', executable),
    path.resolve(process.cwd(), '../../harness-rs', 'target', 'debug', executable),
    path.resolve(process.cwd(), 'harness-rs', 'target', 'release', executable),
    path.resolve(process.cwd(), 'harness-rs', 'target', 'debug', executable)
  ].filter((value): value is string => Boolean(value))
  return candidates.find(candidate => fs.existsSync(candidate)) || null
}

function textFromMessageContent (content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part && typeof part === 'object'))
    .filter(part => part.type === 'text' || typeof part.text === 'string')
    .map(part => typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n')
}

function normalizeContentParts (content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const parts: Array<Record<string, unknown>> = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const item = part as {
      type?: unknown
      text?: unknown
      thinking?: unknown
      signature?: unknown
      data?: unknown
      image_url?: { url?: unknown }
    }
    if (item.type === 'text' && typeof item.text === 'string' && item.text.length > 0) {
      parts.push({ type: 'text', text: item.text })
      continue
    }
    if (item.type === 'image_url' && typeof item.image_url?.url === 'string' && item.image_url.url.trim()) {
      parts.push({ type: 'image_url', image_url: { url: item.image_url.url } })
      continue
    }
    if (item.type === 'thinking' && typeof item.thinking === 'string' && typeof item.signature === 'string') {
      parts.push({ type: 'thinking', thinking: item.thinking, signature: item.signature })
      continue
    }
    if (item.type === 'redacted_thinking' && typeof item.data === 'string') {
      parts.push({ type: 'redacted_thinking', data: item.data })
    }
  }
  return parts
}

function normalizeStringArray (value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)))
}

function normalizeMcpServerSelection (value: unknown): string[] | undefined {
  const serverIds = normalizeStringArray(value)
  return serverIds.length > 0 ? serverIds : undefined
}

function normalizeOptionalString (value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeTemperature (value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(2, Math.max(0, value))
    : null
}

function normalizeBudgetLimit (value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Serialize the portable portion of a chat run for Rust group members. */
function nativeGroupContext (options?: RustChatOptions): Record<string, unknown> {
  const enableThinking = options?.enableThinking
  const reasoningEffort = enableThinking === false ? undefined : options?.reasoningEffort
  return {
    systemPromptSections: normalizeStringArray(options?.systemPromptSections),
    activeSkillContents: normalizeStringArray(options?.activeSkillContents),
    allowedToolNames: normalizeStringArray(options?.allowedToolNames),
    deniedToolNames: normalizeStringArray(options?.deniedToolNames),
    customTools: (options?.customTools || []).map(toRustToolDescriptor),
    workspaceRoot: normalizeOptionalString(options?.workspaceRoot),
    targetProjectId: normalizeOptionalString(options?.targetProjectId),
    allowedMcpServerIds: normalizeMcpServerSelection(options?.allowedMcpServerIds),
    ...(enableThinking !== undefined ? { enableThinking } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    temperature: normalizeTemperature(options?.temperature),
    planModeActive: options?.planModeActive === true,
    budgetLimit: normalizeBudgetLimit(options?.budgetLimit),
    memoryScopes: Array.isArray(options?.memoryScopes) ? options.memoryScopes : [],
    memoryQuery: normalizeOptionalString(options?.memoryQuery),
    ...(options?.memoryEmbedding ? { memoryEmbedding: options.memoryEmbedding } : {}),
    computerUseEnabled: options?.computerUseEnabled === true
  }
}

function isValidModelPricing (value: ModelPricing): boolean {
  return Number.isFinite(value?.inputPerMillion) && value.inputPerMillion >= 0 &&
    Number.isFinite(value?.outputPerMillion) && value.outputPerMillion >= 0 &&
    (value.cacheReadPerMillion === undefined ||
      (Number.isFinite(value.cacheReadPerMillion) && value.cacheReadPerMillion >= 0))
}

function toRustToolDescriptor (tool: RustCustomToolRegistration): RustToolDescriptor {
  return {
    name: tool.definition.name,
    description: tool.definition.description,
    inputSchema: tool.definition.parameters,
    domain: tool.domain || 'host',
    permission: tool.permission || 'allow'
  }
}

function normalizeToolCalls (value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.flatMap((call) => {
    if (!call || typeof call !== 'object') return []
    const record = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const name = typeof record.function?.name === 'string' ? record.function.name.trim() : ''
    if (!id || !name) return []

    let args: Record<string, unknown> = {}
    const rawArguments = record.function?.arguments
    if (typeof rawArguments === 'string' && rawArguments.trim()) {
      try {
        const parsed = JSON.parse(rawArguments) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
        args = parsed as Record<string, unknown>
      } catch {
        return []
      }
    } else if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
      args = rawArguments as Record<string, unknown>
    } else if (rawArguments !== undefined && rawArguments !== null && rawArguments !== '') {
      return []
    }
    return [{ id, name, args }]
  })
}

function normalizeToolResults (message: RustSyncMessage): Array<Record<string, unknown>> {
  if (message.role !== 'tool') return []
  const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
  if (!id) return []
  return [{
    toolCallId: id,
    name: '',
    content: textFromMessageContent(message.content),
    isError: false
  }]
}

/** Keep only complete assistant tool-call batches and their exact responses. */
function sanitizeSyncMessageSequence (messages: RustSyncMessage[]): RustSyncMessage[] {
  const sanitized: RustSyncMessage[] = []

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role === 'tool') continue

    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    if (message.role !== 'assistant' || rawCalls.length === 0) {
      sanitized.push(message)
      continue
    }

    const calls = normalizeToolCalls(rawCalls)
    const expectedIds = new Set(calls.map(call => String(call.id || '').trim()).filter(Boolean))
    const toolMessages: RustSyncMessage[] = []
    let nextIndex = index + 1
    while (nextIndex < messages.length && messages[nextIndex].role === 'tool') {
      toolMessages.push(messages[nextIndex])
      nextIndex++
    }

    const malformedCalls = calls.length !== rawCalls.length || expectedIds.size !== calls.length
    if (malformedCalls) {
      // A damaged persisted call cannot be replayed safely, but prose from the
      // assistant turn is still useful context. Its adjacent tool responses
      // are consumed here and omitted as orphans.
      sanitized.push({ ...message, tool_calls: undefined })
      index = nextIndex - 1
      continue
    }

    const matchedIds = new Set<string>()
    let invalid = toolMessages.length === 0
    for (const toolMessage of toolMessages) {
      const id = typeof toolMessage.tool_call_id === 'string' ? toolMessage.tool_call_id.trim() : ''
      if (!id || !expectedIds.has(id) || matchedIds.has(id)) {
        invalid = true
        break
      }
      matchedIds.add(id)
    }

    if (!invalid && matchedIds.size === expectedIds.size) {
      sanitized.push(message, ...toolMessages)
    }
    index = nextIndex - 1
  }

  return sanitized
}

const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

function sanitizeJsonRpcText (value: string): string {
  return value ? value.replace(LONE_SURROGATE_PATTERN, '\uFFFD') : value
}

/** Recursively sanitize both JSON values and property names before encoding. */
function sanitizeJsonRpcValue (value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return sanitizeJsonRpcText(value)
  if (value === null || typeof value !== 'object') return value
  if (ancestors.has(value)) throw new TypeError('Converting circular structure to JSON')

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map(item => sanitizeJsonRpcValue(item, ancestors))
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      // Preserve JSON.stringify/toJSON behavior for non-record values while
      // still sanitizing their eventual string representation via a replacer.
      return value
    }

    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      result[sanitizeJsonRpcText(key)] = sanitizeJsonRpcValue(item, ancestors)
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}
