import { randomUUID } from 'node:crypto'
import { USER_ABORT_MESSAGE } from '../ai-engine/abort-utils.js'
import type { UsageStore } from '../settings/usage-store.js'
import type { ChatMessage, MessageContent, ToolDefinition } from './contracts.js'
import {
  RustHarnessClient,
  type RustChatOptions,
  type RustCustomToolRegistration,
  type RustEventFrame,
  type RustProgressCallback,
  type RustSyncMessage
} from '../../../electron/main-process/rust-harness-client.js'
import {
  ElectronToolRegistry,
  type ElectronSubagentResult,
  type ElectronSubagentTask,
  type ElectronToolRegistryServices,
  type ElectronToolRunContext
} from './electron-tool-registry.js'
import type {
  AIConfigInput,
  AIHarness,
  AIRequestOptions,
  CustomToolRegistration,
  ProgressCallback,
  ProgressEvent,
  StreamEvent
} from './types.js'

const PLAN_MODE_WRITE_TOOLS = new Set([
  'create_project',
  'write_project_file',
  'patch_project_file',
  'delete_project_file',
  'run_project_command',
  'write_workspace_file',
  'edit_workspace_file',
  'patch_workspace_file',
  'delete_workspace_file',
  'run_workspace_command',
  'install_dependencies',
  'install_skill',
  'install_mcp_server',
  'rebuild_project',
  'start_project_server',
  'restart_project_server',
  'clear_project_build_flag'
])

// Rust owns the model/tool loop, but parallel child-run orchestration needs
// the Electron facade so it can create isolated Rust sessions and preserve
// host conversation/session routing. This override also keeps Rust's legacy
// compatibility stub from becoming visible at the nesting limit.
// These tools depend on Electron-owned ephemeral state or a live renderer
// window. Keep Rust in charge of the model/tool loop, but execute the exact
// Electron implementation through the host `tool.execute` callback so Rust
// mode does not expose a native stub or a narrower schema.
const ELECTRON_EXECUTION_OVERRIDE_TOOL_NAMES = new Set([
  'spawn_subagents',
  'ask_user',
  'read_current_page',
  'interact_current_page',
  'fill_current_page_form',
  'save_current_page_as_document',
  'list_documents',
  'read_document',
  'open_project_app'
])

export interface RustHarnessEngineOptions {
  client: RustHarnessClient
  services: ElectronToolRegistryServices
  usageStore?: UsageStore
  /** Notify Electron views after a Rust-native domain mutation completes. */
  onNativeToolResult?: (name: string, result: unknown, context: AIRequestOptions) => void | Promise<void>
}

/**
 * Electron-facing facade for the Rust harness. Rust owns the provider, agent
 * loop, and every Rust-native domain tool. Electron host callbacks are kept
 * only for capabilities that have no Rust implementation or require a live
 * window (for example the shared group board and page automation).
 */
export class RustHarnessEngine implements AIHarness {
  private readonly client: RustHarnessClient
  private readonly services: ElectronToolRegistryServices
  private readonly electronTools: ElectronToolRegistry
  private readonly usageStore?: UsageStore
  private readonly onNativeToolResult?: RustHarnessEngineOptions['onNativeToolResult']
  private baseConfig: AIConfigInput = {}
  private activeSkillContents: string[] = []
  private defaultTargetProjectId: string | null = null
  private planModeDefault = false
  private customModelPricing: Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number }> = {}
  private budgetLimit: number | null = null

  constructor (options: RustHarnessEngineOptions) {
    this.client = options.client
    this.services = options.services
    this.usageStore = options.usageStore
    this.onNativeToolResult = options.onNativeToolResult
    this.electronTools = new ElectronToolRegistry({
      services: options.services,
      getNativeToolDefinitions: () => this.client.getAvailableTools()
        .map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema
        })),
      runSubagents: async (tasks, parent, onProgress, abortSignal) => {
        return await this.runSubagents(tasks, parent, onProgress, abortSignal)
      }
    })
  }

  async start (): Promise<void> {
    await this.client.start()
  }

  async chat (messages: ChatMessage[], options?: AIRequestOptions): Promise<ChatMessage> {
    let result: ChatMessage = { role: 'assistant', content: '' }
    for await (const event of this.chatStream(messages, undefined, options)) {
      if (event.type === 'done') result = event.message
      if (event.type === 'error') throw new Error(event.error)
    }
    return result
  }

  async *chatStream (messages: ChatMessage[], onProgress?: ProgressCallback, options?: AIRequestOptions): AsyncGenerator<StreamEvent> {
    await this.start()
    if (options?.abortSignal?.aborted) {
      throw abortError(options.abortSignal)
    }

    const sessionId = options?.sessionId || `rust_${randomUUID()}`
    const conversationId = options?.conversationId || `rust_${randomUUID()}`
    // Electron-hosted tool handlers use the host IDs for permission-card
    // routing. Nested Rust runs retain their own storage IDs, avoiding shared
    // conversation/session state between parallel group members.
    const runOptions: AIRequestOptions = {
      ...options,
      sessionId,
      conversationId,
      hostSessionId: options?.hostSessionId ?? options?.sessionId,
      hostConversationId: options?.hostConversationId ?? options?.conversationId
    }
    const pendingIndex = findPendingUserMessage(messages)
    const pending = pendingIndex >= 0 ? messages[pendingIndex] : messages[messages.length - 1]
    if (!pending) throw new Error('A user message is required for Rust harness chat.')

    const effectiveConfig: AIConfigInput = {
      ...this.baseConfig,
      ...(options?.providerConfig || {})
    }
    const customTools = await this.collectCustomTools(runOptions)
    const requestedAllowedToolNames = mergeStrings(options?.allowedToolNames)
    const rustNativeToolNames = this.nativeToolNames()
    const visibleToolNames = mergeStrings(
      Array.from(rustNativeToolNames),
      customTools.map(tool => tool.definition.name),
    )
    // Rust owns its builtins in a Rust-selected run. Keep an omitted policy as
    // an empty Rust allow-list (which means unrestricted) so MCP tools
    // discovered inside Rust after the Electron handshake can participate.
    const allowedToolNames = requestedAllowedToolNames.length > 0
      ? requestedAllowedToolNames.filter(name => visibleToolNames.includes(name) || name.startsWith('mcp__'))
      : []
    // Rust treats an empty allow-list as unrestricted. Preserve an explicit
    // Electron policy that happens not to match this run's negotiated catalog.
    if (requestedAllowedToolNames.length > 0 && allowedToolNames.length === 0) {
      allowedToolNames.push('__electron_policy_denied_all_tools__')
    }
    const deniedToolNames = mergeStrings(
      options?.deniedToolNames,
      this.planModeDefault ? Array.from(PLAN_MODE_WRITE_TOOLS) : undefined
    )
    const systemPromptSections = mergeStrings(
      options?.systemPromptSections,
      this.planModeDefault
        ? ['Plan mode is active. Do not perform mutations, installs, builds, process control, or MCP calls until exit_plan_mode has completed.']
        : undefined
    )
    const history = (pendingIndex >= 0 ? messages.slice(0, pendingIndex) : messages.slice(0, -1)) as RustSyncMessage[]
    const queue: StreamEvent[] = []
    let terminal = false
    let wake: (() => void) | null = null
    let assistantText = ''
    let streamError: Error | null = null
    let streamWasAborted = false
    let nativeSideEffects = Promise.resolve()
    const providerCallId = options?.aiLogger?.logProviderCallStart({
      stream: true,
      model: effectiveConfig.model || 'default',
      baseUrl: effectiveConfig.baseUrl || '',
      messages,
      tools: this.getAvailableTools()
    })

    const emit = (event: StreamEvent): void => {
      queue.push(event)
      if (event.type === 'progress') onProgress?.(event.stage, event.detail)
      else if (isProgressEvent(event)) onProgress?.(event)
      wake?.()
      wake = null
    }
    const onFrame = (frame: RustEventFrame): void => {
      if (frame.kind === 'delta' && typeof frame.text === 'string') assistantText += frame.text
      if (frame.kind === 'assistant_message' && typeof frame.content === 'string') assistantText = frame.content
      if (frame.kind === 'usage') this.recordUsage(frame, effectiveConfig)
      if (frame.kind === 'tool_result' && this.isNativeToolResult(frame, customTools)) {
        nativeSideEffects = nativeSideEffects
          .then(async () => await this.handleNativeToolResult(frame, runOptions))
          .catch(error => console.warn('[rust-harness] Native tool result bridge failed:', error))
      }
      if (frame.kind === 'error') {
        streamError = new Error(String(frame.message || 'Rust harness error'))
        terminal = true
        wake?.()
        wake = null
        return
      }
      if (frame.kind === 'done') {
        streamWasAborted = frame.stopReason === 'aborted'
        terminal = true
        // The IPC boundary already owns terminal rendering. Do not yield a
        // completed event and then throw an abort, or a failure event twice.
        if (streamWasAborted) {
          wake?.()
          wake = null
          return
        }
      }
      const event = frameToStreamEvent(frame, assistantText)
      if (event) emit(event)
    }
    const onAbort = () => {
      void this.client.stopSession(sessionId).catch(() => {})
    }
    options?.abortSignal?.addEventListener('abort', onAbort, { once: true })

    try {
      const chatOptions: RustChatOptions = {
        providerId: effectiveConfig.providerId,
        model: effectiveConfig.model,
        agentId: options?.agentId || undefined,
        authMode: options?.getAuthMode?.() || options?.authMode,
        history,
        contentParts: pending.content,
        systemPromptSections,
        activeSkillContents: mergeStrings(this.activeSkillContents, options?.activeSkillContents),
        allowedToolNames,
        deniedToolNames,
        customTools,
        workspaceRoot: options?.workspaceRoot,
        targetProjectId: options?.targetProjectId ?? this.defaultTargetProjectId,
        memoryScopes: options?.memoryScopes,
        memoryQuery: textFromContent(pending.content),
        allowedMcpServerIds: options?.allowedMcpServerIds,
        reasoningEffort: effectiveConfig.reasoningEffort,
        temperature: effectiveConfig.temperature,
        planModeActive: this.planModeDefault,
        budgetLimit: this.budgetLimit
      }
      // MCP/tool discovery above can await for a while. Re-check immediately
      // before handing the prompt to Rust so a stop during preparation never
      // becomes a late, billable chat.send request.
      if (options?.abortSignal?.aborted) {
        throw abortError(options.abortSignal)
      }
      await this.client.chatStream(sessionId, conversationId, textFromContent(pending.content), chatOptions, onFrame)

      while (!terminal || queue.length > 0) {
        while (queue.length > 0) {
          yield queue.shift()!
        }
        if (terminal) break
        await new Promise<void>((resolve) => {
          if (terminal || queue.length > 0) {
            resolve()
            return
          }
          wake = resolve
        })
      }
      if (streamWasAborted) throw new Error(USER_ABORT_MESSAGE)
      if (options?.abortSignal?.aborted) throw abortError(options.abortSignal)
      if (streamError) throw streamError
      await nativeSideEffects
      if (providerCallId) {
        options?.aiLogger?.logProviderCallSuccess(providerCallId, {
          message: { role: 'assistant', content: assistantText }
        })
      }
    } catch (error) {
      if (providerCallId) {
        options?.aiLogger?.logProviderCallFailure(providerCallId, error instanceof Error ? error : new Error(String(error)))
      }
      throw error
    } finally {
      options?.abortSignal?.removeEventListener('abort', onAbort)
    }
  }

  getAvailableTools (): ToolDefinition[] {
    // Rust remains the execution authority for the loop. Host-only tools are
    // intentionally replaced with Electron's exact public definitions so the
    // catalog shown to the renderer matches the handler that will run.
    const tools = this.client.getAvailableTools()
      .map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
      }))
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    for (const tool of this.electronTools.getToolDefinitions()) {
      if (ELECTRON_EXECUTION_OVERRIDE_TOOL_NAMES.has(tool.name) || !byName.has(tool.name)) {
        byName.set(tool.name, tool)
      }
    }
    return Array.from(byName.values())
  }

  setTargetProjectId (projectId: string | null): void {
    this.defaultTargetProjectId = projectId
  }

  setActiveSkills (contents: string[]): void {
    this.activeSkillContents = mergeStrings(contents)
  }

  configure (config: AIConfigInput): void {
    this.baseConfig = { ...this.baseConfig, ...config }
  }

  setPlanMode (active: boolean): void {
    this.planModeDefault = active
  }

  getPlanMode (): boolean {
    return this.planModeDefault
  }

  setCustomModelPricing (pricing: Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number }>): void {
    this.customModelPricing = { ...pricing }
    this.client.setModelPricing(this.customModelPricing)
  }

  setBudgetLimit (limit: number | null): void {
    this.budgetLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : null
  }

  private recordUsage (frame: RustEventFrame, fallback: AIConfigInput): void {
    const inputTokens = positiveInteger(frame.inputTokens)
    const outputTokens = positiveInteger(frame.outputTokens)
    const cacheReadTokens = positiveInteger(frame.cacheReadTokens)
    const cacheCreationTokens = positiveInteger(frame.cacheCreationTokens)
    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0) return

    const providerId = stringValue(frame.providerId) || fallback.providerId || 'unknown'
    const providerName = stringValue(frame.providerName) || fallback.providerName || providerId
    const model = stringValue(frame.model) || fallback.model || 'unknown'
    this.usageStore?.record({
      providerId,
      providerName,
      model,
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        prompt_tokens_details: { cached_tokens: cacheReadTokens },
        cache_creation_input_tokens: cacheCreationTokens
      }
    })
  }

  private async collectCustomTools (options?: AIRequestOptions): Promise<RustCustomToolRegistration[]> {
    const nativeNames = this.nativeToolNames()
    // A host handler may fill a capability Rust does not implement, but it
    // must not silently replace project/workspace/image/MCP native execution.
    const hostFallbacks = this.electronTools.createRegistrations(options || {})
      .filter(tool => (!nativeNames.has(tool.definition.name) || ELECTRON_EXECUTION_OVERRIDE_TOOL_NAMES.has(tool.definition.name)) &&
        // Dynamic MCP tools are discovered and executed natively after Rust
        // receives the run's MCP allow-list. They are absent from the static
        // initialize catalog, so name-based exclusion alone is insufficient.
        !tool.definition.name.startsWith('mcp__'))
    const registered: RustCustomToolRegistration[] = [
      ...hostFallbacks,
      ...(options?.customTools || []).map(toRustCustomTool)
    ]
    const unique = new Map<string, RustCustomToolRegistration>()
    for (const tool of registered) {
      const name = tool.definition?.name?.trim()
      const isHostOverride = tool.domain === 'electron_host_override'
      if (!name || (!isHostOverride && nativeNames.has(name)) || unique.has(name)) continue
      unique.set(name, tool)
    }
    return Array.from(unique.values())
  }

  private nativeToolNames (): Set<string> {
    return new Set(this.client.getAvailableTools()
      .map(tool => tool.name.trim())
      .filter(Boolean))
  }

  private isNativeToolResult (frame: RustEventFrame, customTools: RustCustomToolRegistration[]): boolean {
    const name = stringValue(frame.name)
    if (!name || !this.nativeToolNames().has(name)) return false
    return !customTools.some(tool => tool.definition.name === name && tool.domain === 'electron_host_override')
  }

  private async handleNativeToolResult (frame: RustEventFrame, context: AIRequestOptions = {}): Promise<void> {
    const name = stringValue(frame.name)
    if (!name || frame.isError === true) return
    const result = parseToolResult(frame.content)
    // Rust image tools persist to the Rust-owned gallery. The Electron shell
    // only broadcasts the resulting UI invalidation through onNativeToolResult.
    await this.onNativeToolResult?.(name, result, context)
  }

  private async runSubagents (
    tasks: ElectronSubagentTask[],
    parent: ElectronToolRunContext,
    onProgress?: ProgressCallback,
    abortSignal?: AbortSignal
  ): Promise<ElectronSubagentResult[]> {
    const nestingDepth = parent.subagentNestingDepth ?? 0
    if (nestingDepth >= 2) {
      return tasks.map(task => ({
        description: task.description || 'subagent',
        result: '',
        status: 'failed' as const,
        error: 'Subagent nesting limit reached.'
      }))
    }
    return await Promise.all(tasks.map(async (task) => {
      const label = task.description || 'subagent'
      let result = ''
      try {
        const progress: ProgressCallback = ((stageOrEvent: string | ProgressEvent, detail?: string) => {
          if (typeof stageOrEvent === 'string') onProgress?.(`[${label}] ${stageOrEvent}`, detail)
          else onProgress?.(stageOrEvent)
        }) as ProgressCallback
        for await (const event of this.chatStream([{ role: 'user', content: task.prompt }], progress, {
          ...parent,
          conversationId: `rust_subagent_${randomUUID()}`,
          sessionId: `rust_subagent_${randomUUID()}`,
          abortSignal: abortSignal || parent.abortSignal,
          allowedToolNames: intersectAllowedTools(parent.allowedToolNames, task.allowedTools),
          deniedToolNames: mergeStrings(parent.deniedToolNames, task.deniedTools),
          systemPromptSections: mergeStrings(parent.systemPromptSections, task.systemPromptSections, [buildNestedSubagentPrompt(nestingDepth + 1)]),
          subagentNestingDepth: nestingDepth + 1
        })) {
          if (event.type === 'done') result = textFromContent(event.message.content)
          if (event.type === 'error') throw new Error(event.error)
        }
        return { description: label, result, status: 'completed' as const }
      } catch (error) {
        return {
          description: label,
          result,
          status: 'failed' as const,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }))
  }
}

function toRustCustomTool (tool: CustomToolRegistration): RustCustomToolRegistration {
  return {
    definition: tool.definition,
    domain: tool.domain,
    handler: async (args, onProgress?: RustProgressCallback) => {
      const progress = onProgress
        ? ((stage: string, detail?: string) => onProgress(stage, detail)) as ProgressCallback
        : undefined
      return await tool.handler(args, progress)
    }
  }
}

function findPendingUserMessage (messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') return index
  }
  return -1
}

function textFromContent (content: MessageContent): string {
  if (typeof content === 'string') return content
  return content
    .filter(part => part.type === 'text')
    .map(part => part.type === 'text' ? part.text : '')
    .filter(Boolean)
    .join('\n')
}

function mergeStrings (...collections: Array<string[] | undefined>): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const collection of collections) {
    for (const value of collection || []) {
      const normalized = value.trim()
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      result.push(normalized)
    }
  }
  return result
}

function intersectAllowedTools (parent?: string[], child?: string[]): string[] | undefined {
  const parentNames = mergeStrings(parent)
  const childNames = mergeStrings(child)
  if (parentNames.length === 0) return childNames.length > 0 ? childNames : undefined
  if (childNames.length === 0) return parentNames
  const childSet = new Set(childNames)
  const intersection = parentNames.filter(name => childSet.has(name))
  return intersection.length > 0 ? intersection : ['__blocked_subagent_tools__']
}

function buildNestedSubagentPrompt (depth: number): string {
  return [
    '## Nested subagent execution',
    `- You are a spawned subagent at nesting depth ${depth}.`,
    '- Finish the assigned task directly. Only spawn independent subtasks when there is clear remaining parallel work.',
    depth >= 2 ? '- Your nesting limit is reached. Do not spawn more subagents.' : ''
  ].filter(Boolean).join('\n')
}

function abortError (signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('AI request aborted.')
}

function stringValue (value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseToolResult (content: unknown): unknown {
  if (typeof content !== 'string') return content
  try {
    return JSON.parse(content)
  } catch {
    return content
  }
}

function positiveInteger (value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

function frameToStreamEvent (frame: RustEventFrame, assistantText: string): StreamEvent | null {
  switch (frame.kind) {
    case 'delta':
      return typeof frame.text === 'string' ? { type: 'token', content: frame.text } : null
    case 'tool_call':
      return { type: 'tool_start', name: typeof frame.name === 'string' ? frame.name : 'tool' }
    case 'tool_result':
      return { type: 'tool_end', name: typeof frame.name === 'string' ? frame.name : 'tool' }
    case 'usage':
      return {
        type: 'cost_update',
        totalCost: nonNegativeNumber(frame.totalCost),
        inputTokens: positiveInteger(frame.totalInputTokens),
        outputTokens: positiveInteger(frame.totalOutputTokens)
      }
    case 'permission_request':
      return {
        type: 'progress',
        stage: 'permission',
        detail: `${String(frame.toolName || '')}: ${String(frame.argsSummary || '')}`
      }
    case 'notice':
      return { type: 'progress', stage: 'notice', detail: typeof frame.text === 'string' ? frame.text : undefined }
    case 'progress':
      if (frame.stage === '__electron_progress__' && typeof frame.detail === 'string') {
        try {
          const event = JSON.parse(frame.detail) as StreamEvent
          if (event && typeof event === 'object' && 'type' in event) return event
        } catch {
          // Fall back to a normal progress row below.
        }
      }
      return { type: 'progress', stage: typeof frame.stage === 'string' ? frame.stage : 'tool', detail: typeof frame.detail === 'string' ? frame.detail : undefined }
    case 'done':
      return { type: 'done', message: { role: 'assistant', content: assistantText } }
    case 'error':
      return { type: 'error', error: String(frame.message || 'Rust harness error') }
    default:
      return null
  }
}

function nonNegativeNumber (value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function isProgressEvent (event: StreamEvent): event is ProgressEvent {
  return event.type === 'todo_update' ||
    event.type === 'file_preview_start' ||
    event.type === 'file_preview_end' ||
    event.type === 'web_search_result' ||
    event.type === 'web_fetch_result'
}
