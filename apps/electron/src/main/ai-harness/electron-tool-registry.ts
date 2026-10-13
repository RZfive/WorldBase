import type { BrowserWindow } from 'electron'
import { PermissionEngine } from '../ai-engine/agent/permissions/permission-engine.js'
import { registerAllTools, type ToolServices } from '../ai-engine/agent/tools/index.js'
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

export interface ElectronToolRegistryServices extends Omit<ToolServices, 'workspaceRoot'> {
  getMainWindow?: () => BrowserWindow | null
}

export interface ElectronToolRunContext extends AIRequestOptions {
  activeSkillContents?: string[]
}

export interface ElectronToolRegistryOptions {
  services: ElectronToolRegistryServices
  /** Native Rust descriptors, used to validate Agent Workspace tool policies. */
  getNativeToolDefinitions: () => ToolDefinition[]
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

  constructor (options: ElectronToolRegistryOptions) {
    this.services = options.services
    this.getNativeToolDefinitions = options.getNativeToolDefinitions
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
      getEffectiveAuthMode: () => this.resolveAuthMode(context),
      getAbortSignal: () => context.abortSignal
    }

    // spawn_subagents is Rust-native: the harness's own subagent runtime owns
    // child runs, nesting limits, and parent cancellation. No host shim.
    const toolServices: ToolServices = {
      ...this.services,
      workspaceRoot: context.workspaceRoot ?? null
    }

    // `registerAllTools` is only a domain-tool registration function here.
    // The structural shim intentionally has no chat/provider execution path.
    registerAllTools(agent as never, toolServices)
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
