import type { BrowserWindow } from 'electron'
import { PlanEngine } from '../ai-engine/agent/plan-mode.js'
import { SkillEngine } from '../ai-engine/agent/skill-engine.js'
import { PermissionEngine } from '../ai-engine/agent/permissions/permission-engine.js'
import { registerAllTools, type ToolServices } from '../ai-engine/agent/tools/index.js'
import { toolGetTaskStatus, toolStartAsyncTask } from '../ai-engine/agent/tools/tool-async-task.js'
import type { AIExecutionAuthMode } from '../settings/settings-store.js'
import type { RustCustomToolRegistration, RustProgressCallback } from '../../../electron/main-process/rust-harness-client.js'
import type {
  AIRequestOptions,
  CustomToolRegistration,
  ProgressCallback,
  ProgressEvent
} from './types.js'
import type { ToolDefinition } from './contracts.js'

const INTRINSIC_RUST_TOOL_NAMES = new Set(['enter_plan_mode', 'exit_plan_mode'])

export interface ElectronToolRegistryServices extends Omit<ToolServices, 'workspaceRoot' | 'subagentService'> {
  getMainWindow?: () => BrowserWindow | null
}

export interface ElectronSubagentTask {
  description: string
  prompt: string
  allowedTools?: string[]
  deniedTools?: string[]
  systemPromptSections?: string[]
}

export interface ElectronSubagentResult {
  description: string
  result: string
  status: 'completed' | 'failed'
  error?: string
  tokenUsage?: { inputTokens: number; outputTokens: number; totalCost: number }
}

export interface ElectronToolRunContext extends AIRequestOptions {
  activeSkillContents?: string[]
}

export interface ElectronToolRegistryOptions {
  services: ElectronToolRegistryServices
  /** Native Rust descriptors, used to validate Agent Workspace tool policies. */
  getNativeToolDefinitions: () => ToolDefinition[]
  runSubagents?: (
    tasks: ElectronSubagentTask[],
    parent: ElectronToolRunContext,
    onProgress?: ProgressCallback,
    abortSignal?: AbortSignal
  ) => Promise<ElectronSubagentResult[]>
}

interface RegisteredTool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

interface AgentShim {
  sessionState: {
    createdProjectId: string | null
    targetProjectId: string | null
    authMode: AIExecutionAuthMode
    conversationId?: string
    sessionId?: string
    workspaceRoot?: string | null
  }
  registerTool: (name: string, definition: ToolDefinition, handler: RegisteredTool['handler']) => void
  getToolDefinitions: () => ToolDefinition[]
  getPlanEngine: () => PlanEngine
  getSkillEngine: () => SkillEngine
  getEffectiveAuthMode: () => AIExecutionAuthMode
  getAbortSignal: () => AbortSignal | undefined
}

/**
 * Reuses Electron's domain handlers while keeping provider calls, tool-loop
 * control, cancellation, and plan-mode enforcement in Rust. Every descriptor
 * emitted here is explicitly marked as an Electron host override by the
 * facade, so a Rust builtin cannot be shadowed accidentally by an MCP tool.
 */
export class ElectronToolRegistry {
  private readonly services: ElectronToolRegistryServices
  private readonly getNativeToolDefinitions: () => ToolDefinition[]
  private readonly runSubagents?: ElectronToolRegistryOptions['runSubagents']

  constructor (options: ElectronToolRegistryOptions) {
    this.services = options.services
    this.getNativeToolDefinitions = options.getNativeToolDefinitions
    this.runSubagents = options.runSubagents
  }

  getToolDefinitions (): ToolDefinition[] {
    // Definition discovery is a canonical catalog, independent of whether the
    // current conversation has selected a folder workspace. Handler discovery
    // below still uses the real run context and therefore remains conditional.
    return this.collect({
      subagentNestingDepth: 0,
      workspaceRoot: '/__worldbase_tool_catalog__'
    }, false)
      .map(tool => tool.definition)
  }

  createRegistrations (context: ElectronToolRunContext): RustCustomToolRegistration[] {
    return this.collect(context, true).map(tool => ({
      definition: tool.definition,
      domain: 'electron_host_override',
      // Permission parity is handled inside Electron's PermissionEngine. This
      // preserves its argument-sensitive command policy and auto/strict mode.
      permission: 'allow',
      handler: async (args, onProgress) => {
        return await tool.handler(args, toElectronProgress(onProgress))
      }
    }))
  }

  /**
   * Register a service-specific Electron tool outside `registerAllTools`.
   * MCP discovery is asynchronous and therefore happens in the Rust facade,
   * but its handler must still pass through the same permission and logging
   * policy as the normal Electron tool catalog.
   */
  createExternalRegistration (
    context: ElectronToolRunContext,
    tool: CustomToolRegistration
  ): RustCustomToolRegistration {
    const sessionState: AgentShim['sessionState'] = {
      createdProjectId: null,
      targetProjectId: context.targetProjectId ?? null,
      authMode: this.resolveAuthMode(context),
      conversationId: context.hostConversationId ?? context.conversationId,
      sessionId: context.hostSessionId ?? context.sessionId,
      workspaceRoot: context.workspaceRoot ?? null
    }
    const handler = this.withElectronPermission(
      tool.definition.name,
      tool.handler,
      context,
      sessionState
    )
    return {
      definition: tool.definition,
      domain: tool.domain || 'host',
      permission: 'allow',
      handler: async (args, onProgress) => {
        return await handler(args, toElectronProgress(onProgress))
      }
    }
  }

  private collect (context: ElectronToolRunContext, includeHandlers: boolean): RegisteredTool[] {
    const registered = new Map<string, RegisteredTool>()
    const planEngine = new PlanEngine()
    const skillEngine = new SkillEngine()
    for (const content of context.activeSkillContents || []) {
      if (content.trim()) skillEngine.registerFromContent(content)
    }

    const sessionState: AgentShim['sessionState'] = {
      createdProjectId: null,
      targetProjectId: context.targetProjectId ?? null,
      authMode: this.resolveAuthMode(context),
      conversationId: context.hostConversationId ?? context.conversationId,
      sessionId: context.hostSessionId ?? context.sessionId,
      workspaceRoot: context.workspaceRoot ?? null
    }
    const getKnownToolDefinitions = () => this.mergeDefinitions(
      this.getNativeToolDefinitions(),
      Array.from(registered.values()).map(tool => tool.definition)
    )
    const agent: AgentShim = {
      sessionState,
      registerTool: (name, definition, handler) => {
        registered.set(name, { definition, handler })
      },
      getToolDefinitions: getKnownToolDefinitions,
      getPlanEngine: () => planEngine,
      getSkillEngine: () => skillEngine,
      getEffectiveAuthMode: () => this.resolveAuthMode(context),
      getAbortSignal: () => context.abortSignal
    }

    // Keep this registration available even at the nesting limit. The Rust
    // catalog includes a compatibility descriptor with the same name; if we
    // omitted the host override at depth two, Rust would select that legacy
    // unavailable implementation instead of this facade's bounded runner.
    // `RustHarnessEngine.runSubagents` remains the authority that returns a
    // structured nesting-limit result without starting another child run.
    const subagentService = this.runSubagents
      ? {
          runParallel: async (tasks: ElectronSubagentTask[], onProgress?: ProgressCallback, abortSignal?: AbortSignal) => {
            return await this.runSubagents!(tasks, context, onProgress, abortSignal)
          }
        }
      : undefined
    const toolServices: ToolServices = {
      ...this.services,
      workspaceRoot: context.workspaceRoot ?? null,
      ...(subagentService ? { subagentService: subagentService as ToolServices['subagentService'] } : {})
    }

    // `registerAllTools` is only a domain-tool registration function here.
    // The structural shim intentionally has no chat/provider execution path.
    registerAllTools(agent as never, toolServices)
    if (this.services.mcpService) {
      const getBuiltinToolRegistrations = this.services.mcpService.getBuiltinToolRegistrations
      if (typeof getBuiltinToolRegistrations === 'function') {
        for (const tool of getBuiltinToolRegistrations.call(
          this.services.mcpService,
          context.allowedMcpServerIds
        )) {
          agent.registerTool(tool.definition.name, tool.definition, tool.handler)
        }
      }
      agent.registerTool(
        'mcp_call',
        {
          name: 'mcp_call',
          description: 'Call a tool exposed by a configured MCP server. Prefer a discovered mcp__... tool when one is available because it has the exact server schema.',
          parameters: {
            type: 'object',
            properties: {
              server: { type: 'string', description: 'Electron MCP server ID.' },
              tool: { type: 'string', description: 'Remote MCP tool name.' },
              arguments: { type: 'object', description: 'Arguments accepted by the remote MCP tool.', additionalProperties: true }
            },
            required: ['server', 'tool'],
            additionalProperties: false
          }
        },
        async (args, onProgress) => {
          const server = typeof args.server === 'string' ? args.server : ''
          const tool = typeof args.tool === 'string' ? args.tool : ''
          const toolArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
            ? args.arguments as Record<string, unknown>
            : {}
          return await this.services.mcpService!.executeServerTool(
            server,
            tool,
            toolArgs,
            onProgress,
            context.allowedMcpServerIds
          )
        }
      )
    }
    for (const tool of [toolStartAsyncTask(toolServices), toolGetTaskStatus(toolServices)]) {
      registered.set(tool.definition.name, {
        definition: tool.definition,
        handler: tool.handler
      })
    }

    // Rust advertises the canonical Electron catalog even when an optional
    // Electron service is not present in the current process (for example a
    // headless test, a worker, or a partially initialized window).  Never let
    // that absence silently select Rust's compatibility implementation: the
    // desktop contract is still host-owned, so expose an explicit structured
    // error callback instead.  The Rust client supplies the negotiated
    // canonical descriptors; non-canonical Rust-only tools are not added here.
    if (includeHandlers) {
      for (const definition of this.getNativeToolDefinitions()) {
        const name = definition?.name?.trim()
        if (!name || INTRINSIC_RUST_TOOL_NAMES.has(name) || name.startsWith('mcp__') || definition.electronNative === true) continue
        if (registered.has(name)) continue
        registered.set(name, {
          definition,
          handler: async () => ({
            error: `Electron host service unavailable for ${name}`
          })
        })
      }
    }

    const result: RegisteredTool[] = []
    const rustNativeNames = new Set(
      this.getNativeToolDefinitions()
        .filter(definition => definition.electronNative === true)
        .map(definition => definition.name)
    )
    for (const [name, tool] of registered) {
      // These controls stay native so Rust's per-run plan state remains the
      // final authority before any Electron mutation is dispatched.
      if (includeHandlers && (INTRINSIC_RUST_TOOL_NAMES.has(name) || rustNativeNames.has(name))) continue
      result.push({
        definition: tool.definition,
        handler: includeHandlers
          ? this.withElectronPermission(name, tool.handler, context, sessionState)
          : tool.handler
      })
    }
    return result
  }

  private withElectronPermission (
    name: string,
    handler: RegisteredTool['handler'],
    context: ElectronToolRunContext,
    sessionState: AgentShim['sessionState']
  ): RegisteredTool['handler'] {
    const permissionEngine = new PermissionEngine({
      getMainWindow: this.services.getMainWindow,
      getSessionState: () => ({
        ...sessionState,
        authMode: this.resolveAuthMode(context)
      }),
      getAbortSignal: () => context.abortSignal
    })
    return async (args, onProgress) => {
      const permission = await permissionEngine.check(name, args)
      if (!permission.allowed) {
        return { error: `Permission denied: ${permission.reason}` }
      }
      const startedAt = new Date().toISOString()
      try {
        const result = await handler(args, onProgress)
        context.aiLogger?.logToolExecution({
          name,
          rawArguments: JSON.stringify(args),
          parsedArguments: args,
          result,
          status: 'completed'
        })
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        context.aiLogger?.logToolExecution({
          name,
          rawArguments: JSON.stringify(args),
          parsedArguments: args,
          result: null,
          status: 'failed',
          error: message
        })
        context.aiLogger?.logError('tool', message, { name, startedAt })
        throw error
      }
    }
  }

  private resolveAuthMode (context: ElectronToolRunContext): AIExecutionAuthMode {
    return context.getAuthMode?.() ?? context.authMode ?? 'strict'
  }

  private mergeDefinitions (...collections: ToolDefinition[][]): ToolDefinition[] {
    const byName = new Map<string, ToolDefinition>()
    for (const collection of collections) {
      for (const definition of collection) {
        if (definition?.name?.trim()) byName.set(definition.name, definition)
      }
    }
    return Array.from(byName.values())
  }
}

function toElectronProgress (progress?: RustProgressCallback): ProgressCallback | undefined {
  if (!progress) return undefined
  return ((stageOrEvent: string | ProgressEvent, detail?: string) => {
    if (typeof stageOrEvent === 'string') {
      progress(stageOrEvent, detail)
      return
    }
    // The stdio host callback only carries strings. Preserve rich Electron
    // progress rows through a namespaced JSON payload that the facade decodes.
    progress('__electron_progress__', JSON.stringify(stageOrEvent))
  }) as ProgressCallback
}
