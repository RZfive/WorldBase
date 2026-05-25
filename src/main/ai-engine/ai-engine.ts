import { AgentCore, type StreamEvent, type ProgressCallback, type ProgressEvent } from './agent/agent-core.js'
import { OpenAIProvider } from './providers/openai-provider.js'
import { registerAllTools } from './agent/tools/index.js'
import { SubagentService } from './agent/subagent-service.js'
import type { ChatMessage, ToolDefinition } from './providers/openai-provider.js'
import type { ProjectFS } from '../project-fs/project-fs.js'
import type { RuntimeManager } from '../project-runtime/runtime-manager.js'
import type { BuilderService } from '../project-runtime/builder-service.js'
import type { ProjectApiClient } from '../project-api-bridge/api-client.js'
import type { ProjectDataAccess } from '../project-data-access/data-access.js'
import type { AsyncTaskManager } from './agent/tools/async-task-manager.js'
import type { DocumentStore } from './agent/tools/document-store.js'
import type { BrowserWindow } from 'electron'
import type { AIExecutionAuthMode, SettingsStore } from '../settings/settings-store.js'
import type { AILogSessionLogger } from '../settings/ai-log-store.js'
import type { MCPService } from '../mcp/mcp-service.js'
import type { SkillStore } from '../settings/skill-store.js'
import type { ScheduledTaskService } from '../scheduler/scheduled-task-service.js'
import type { AgentStore } from '../settings/agent-store.js'
import type { AgentGroupStore } from '../settings/agent-group-store.js'
import type { BrowserAutomationAction, BrowserAutomationActionResult, BrowserAutomationSnapshot } from '../../shared/page-automation-types.js'

export type { StreamEvent, ProgressCallback, ProgressEvent }

export interface AIEngineServices {
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
  builderService: BuilderService
  apiClient: ProjectApiClient
  dataAccess: ProjectDataAccess
  asyncTaskManager: AsyncTaskManager
  documentStore?: DocumentStore
  skillStore?: SkillStore
  agentStore?: AgentStore
  agentGroupStore?: AgentGroupStore
  settingsStore?: SettingsStore
  getMainWindow?: () => BrowserWindow | null
  readActivePage?: () => Promise<BrowserAutomationSnapshot>
  interactWithActivePage?: (action: BrowserAutomationAction) => Promise<BrowserAutomationActionResult>
  notifySkillsChanged?: (event: { action: string; count?: number; id?: string }) => void
  notifyAgentWorkspaceChanged?: (event: { entity: 'agent' | 'group' | 'binding'; action: string; id?: string }) => void
  mcpService?: MCPService
  scheduledTaskService?: ScheduledTaskService
}

export interface AIConfigInput {
  apiKey?: string
  baseUrl?: string
  model?: string
  imageGeneration?: boolean
  imageEditing?: boolean
  enableThinking?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  contextWindow?: number
}

export interface AIRequestOptions {
  targetProjectId?: string | null
  providerConfig?: AIConfigInput
  abortSignal?: AbortSignal
  conversationId?: string
  sessionId?: string
  authMode?: AIExecutionAuthMode
  getAuthMode?: () => AIExecutionAuthMode
  aiLogger?: AILogSessionLogger
  activeSkillContents?: string[]
  allowedMcpServerIds?: string[]
  systemPromptSections?: string[]
  allowedToolNames?: string[]
  deniedToolNames?: string[]
  /** Internal nesting depth used when this agent was spawned by another agent. */
  subagentNestingDepth?: number
}

const MAX_SUBAGENT_NESTING_DEPTH = 2
const BLOCK_ALL_TOOLS_SENTINEL = '__blocked_subagent_tools__'
const SUBAGENT_TOOL_ALIASES = ['spawn_subagents', 'spawn_subagentstasks'] as const

function mergeUniqueStrings (...collections: Array<string[] | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const collection of collections) {
    if (!collection) continue
    for (const item of collection) {
      const normalized = item.trim()
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      result.push(normalized)
    }
  }

  return result
}

function expandToolAliases (names?: string[]): string[] | undefined {
  const normalized = mergeUniqueStrings(names)
  if (normalized.length === 0) return undefined

  const expanded = new Set(normalized)
  if (SUBAGENT_TOOL_ALIASES.some(name => expanded.has(name))) {
    for (const alias of SUBAGENT_TOOL_ALIASES) {
      expanded.add(alias)
    }
  }

  return Array.from(expanded)
}

function mergeDeniedToolNames (...collections: Array<string[] | undefined>): string[] | undefined {
  const merged = mergeUniqueStrings(...collections.map(collection => expandToolAliases(collection)))
  return merged.length > 0 ? merged : undefined
}

function intersectAllowedToolNames (parentAllowed?: string[], childAllowed?: string[]): string[] | undefined {
  const normalizedParent = expandToolAliases(parentAllowed) ?? []
  const normalizedChild = expandToolAliases(childAllowed) ?? []

  if (normalizedParent.length === 0) {
    return normalizedChild.length > 0 ? normalizedChild : undefined
  }

  if (normalizedChild.length === 0) {
    return normalizedParent
  }

  const childSet = new Set(normalizedChild)
  const intersection = normalizedParent.filter(name => childSet.has(name))
  return intersection.length > 0 ? intersection : [BLOCK_ALL_TOOLS_SENTINEL]
}

function buildNestedSubagentPromptSection (nestingDepth: number, canSpawnMoreSubagents: boolean): string {
  const lines = [
    '## Nested subagent execution',
    `- You are a spawned subagent at nesting depth ${nestingDepth}.`,
    '- If you call `spawn_subagents` or the compatibility alias `spawn_subagentstasks`, those tools return only after every spawned task has finished or failed.',
    '- After the tool returns, read the returned task statuses and results before deciding whether to continue, retry, or answer. Do not skip directly to a final conclusion before the tool result arrives.'
  ]

  if (canSpawnMoreSubagents) {
    lines.push(
      '- You may decompose work one more time only when the remaining work is clearly independent and parallelizable.',
      '- Keep nested spawning shallow. If the task is already narrow enough, finish it directly instead of spawning more agents.'
    )
  } else {
    lines.push('- Your nesting limit is reached in this run. Do not try to spawn more subagents; finish with the tools already available.')
  }

  return lines.join('\n')
}

/**
 * AIEngine — AI 引擎入口
 * 管理 AI 对话、Agent 执行和 function calling
 */
export class AIEngine {
  private services: AIEngineServices
  private baseConfig: AIConfigInput = {}
  private activeSkillContents: string[] = []
  private defaultTargetProjectId: string | null = null
  private planModeDefault: boolean = false
  private customModelPricing: Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number }> = {}
  private budgetLimit: number | null = null

  constructor (services: AIEngineServices) {
    this.services = services
  }

  setScheduledTaskService (scheduledTaskService?: ScheduledTaskService): void {
    this.services.scheduledTaskService = scheduledTaskService
  }

  private applyConfigToProvider (provider: OpenAIProvider, config: AIConfigInput): void {
    if (config.apiKey !== undefined) {
      provider.setApiKey(config.apiKey)
    }
    if (config.baseUrl !== undefined) {
      provider.setBaseUrl(config.baseUrl)
    }
    if (config.model !== undefined) {
      provider.setModel(config.model)
    }
    if (config.imageGeneration !== undefined) {
      provider.setImageGeneration(config.imageGeneration)
    }
    if (config.imageEditing !== undefined) {
      provider.setImageEditing(config.imageEditing)
    }
    if (config.enableThinking !== undefined) {
      provider.setEnableThinking(config.enableThinking)
    }
    if (config.reasoningEffort !== undefined) {
      provider.setReasoningEffort(config.reasoningEffort)
    }
    if (config.contextWindow !== undefined) {
      provider.setContextWindow(config.contextWindow)
    }
  }

  private createAgent (options?: AIRequestOptions): AgentCore {
    const provider = new OpenAIProvider()
    this.applyConfigToProvider(provider, this.baseConfig)
    if (options?.providerConfig) {
      this.applyConfigToProvider(provider, options.providerConfig)
    }
    provider.setLogger(options?.aiLogger)

    const agent = new AgentCore(provider, this.services as unknown as Record<string, unknown>)
    agent.setAuthModeResolver(options?.getAuthMode)

    const subagentNestingDepth = Math.max(0, options?.subagentNestingDepth ?? 0)
    const canSpawnMoreSubagents = subagentNestingDepth < MAX_SUBAGENT_NESTING_DEPTH
    const systemPromptSections = mergeUniqueStrings(
      options?.systemPromptSections,
      subagentNestingDepth > 0
        ? [buildNestedSubagentPromptSection(subagentNestingDepth, canSpawnMoreSubagents)]
        : undefined
    )

    // Build a SubagentService that creates isolated subagent cores while
    // keeping nesting shallow enough to avoid recursive fan-out loops.
    const subagentService = canSpawnMoreSubagents
      ? new SubagentService((subOpts) => {
          const subagent = this.createAgent(
            {
              ...options,
              allowedToolNames: intersectAllowedToolNames(options?.allowedToolNames, subOpts?.allowedTools),
              deniedToolNames: mergeDeniedToolNames(options?.deniedToolNames, subOpts?.deniedTools),
              systemPromptSections: mergeUniqueStrings(options?.systemPromptSections, subOpts?.systemPromptSections),
              subagentNestingDepth: subagentNestingDepth + 1
            }
          )
          return subagent
        })
      : undefined

    const toolServices = subagentService
      ? { ...this.services, subagentService }
      : this.services

    registerAllTools(agent, toolServices)
    this.registerMcpTools(agent, options?.allowedMcpServerIds)
    agent.setActiveSkills(mergeUniqueStrings(this.activeSkillContents, options?.activeSkillContents))
    agent.setSystemPromptSections(systemPromptSections)
    agent.setToolVisibilityFilters(options?.allowedToolNames, options?.deniedToolNames)
    agent.setTargetProjectId(options?.targetProjectId ?? this.defaultTargetProjectId ?? null)
    agent.setAuthMode(options?.authMode ?? 'strict')
    agent.setLogger(options?.aiLogger)
    // Store conversation/session context in sessionState so the getSessionState closure
    // inside registerAllTools (used by tool-level requestUserAuth) can route auth requests
    // back to the correct conversation in the renderer.
    agent.sessionState.conversationId = options?.conversationId
    agent.sessionState.sessionId = options?.sessionId
    // Wire up permission engine with window context for user-auth dialogs
    agent.setPermissionContext({
      getMainWindow: this.services.getMainWindow,
      getSessionState: () => ({
        ...agent.sessionState,
        conversationId: options?.conversationId,
        sessionId: options?.sessionId,
        authMode: agent.getEffectiveAuthMode()
      }),
      getAbortSignal: () => agent.getAbortSignal()
    })
    // Apply plan mode default
    if (this.planModeDefault) {
      agent.getPlanEngine().enter('UI activated plan mode')
    }
    // Apply custom pricing overrides
    const costTracker = agent.getCostTracker()
    for (const [model, pricing] of Object.entries(this.customModelPricing)) {
      costTracker.setModelPricing(model, pricing)
    }
    if (this.budgetLimit != null) {
      costTracker.setBudgetLimit(this.budgetLimit)
    }
    return agent
  }

  private registerMcpTools (agent: AgentCore, allowedMcpServerIds?: string[]): void {
    const mcpService = this.services.mcpService
    if (!mcpService) return

    for (const tool of mcpService.getBuiltinToolRegistrations(allowedMcpServerIds)) {
      agent.registerTool(tool.definition.name, tool.definition, tool.handler)
    }

    for (const definition of mcpService.getCachedDynamicToolDefinitions(allowedMcpServerIds)) {
      agent.registerTool(definition.name, definition, async (args, onProgress) => {
        return mcpService.executeDynamicTool(definition.name, args, onProgress, allowedMcpServerIds)
      })
    }
  }

  private async primeMcpTools (allowedMcpServerIds?: string[]): Promise<void> {
    if (!this.services.mcpService) return
    await this.services.mcpService.refreshEnabledServers(allowedMcpServerIds)
  }

  /**
   * Handle a chat message from the user (non-streaming).
   */
  async chat (messages: ChatMessage[], options?: AIRequestOptions): Promise<ChatMessage> {
    await this.primeMcpTools(options?.allowedMcpServerIds)
    return this.createAgent(options).run(messages)
  }

  /**
   * Handle a chat message with streaming response.
   */
  async *chatStream (messages: ChatMessage[], onProgress?: ProgressCallback, options?: AIRequestOptions): AsyncGenerator<StreamEvent> {
    await this.primeMcpTools(options?.allowedMcpServerIds)
    yield * this.createAgent(options).runStream(messages, onProgress, options?.abortSignal)
  }

  /**
   * Set the target project ID for the current session (edit/optimize mode).
   * Prevents create_project from making a new project and forces
   * write_project_file to target the existing one.
   */
  setTargetProjectId (projectId: string | null): void {
    this.defaultTargetProjectId = projectId
  }

  /**
   * Get the list of available tools (for UI display).
   */
  getAvailableTools (): ToolDefinition[] {
    return this.createAgent().getToolDefinitions()
  }

  /**
   * Set active skill contents for the agent.
   */
  setActiveSkills (contents: string[]): void {
    this.activeSkillContents = [...contents]
  }

  /**
   * Update AI provider configuration.
   */
  configure (config: AIConfigInput): void {
    this.baseConfig = {
      ...this.baseConfig,
      ...config
    }
  }

  /**
   * Set whether new agents start in plan mode by default.
   */
  setPlanMode (active: boolean): void {
    this.planModeDefault = active
  }

  getPlanMode (): boolean {
    return this.planModeDefault
  }

  /**
   * Set custom model pricing overrides.
   */
  setCustomModelPricing (pricing: Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number }>): void {
    this.customModelPricing = { ...pricing }
  }

  /**
   * Set session budget limit.
   */
  setBudgetLimit (limit: number | null): void {
    this.budgetLimit = limit
  }
}
