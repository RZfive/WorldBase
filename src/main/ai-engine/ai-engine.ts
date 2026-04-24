import { AgentCore, type StreamEvent, type ProgressCallback, type ProgressEvent } from './agent/agent-core.js'
import { OpenAIProvider } from './providers/openai-provider.js'
import { registerAllTools } from './agent/tools/index.js'
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
  settingsStore?: SettingsStore
  getMainWindow?: () => BrowserWindow | null
  notifySkillsChanged?: (event: { action: string; count?: number; id?: string }) => void
  mcpService?: MCPService
  scheduledTaskService?: ScheduledTaskService
}

export interface AIConfigInput {
  apiKey?: string
  baseUrl?: string
  model?: string
  enableThinking?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  contextWindow?: number
}

export interface AIRequestOptions {
  targetProjectId?: string | null
  providerConfig?: AIConfigInput
  abortSignal?: AbortSignal
  authMode?: AIExecutionAuthMode
  getAuthMode?: () => AIExecutionAuthMode
  aiLogger?: AILogSessionLogger
  activeSkillContents?: string[]
  allowedMcpServerIds?: string[]
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
    registerAllTools(agent, this.services)
    this.registerMcpTools(agent, options?.allowedMcpServerIds)
    agent.setActiveSkills(options?.activeSkillContents ?? this.activeSkillContents)
    agent.setTargetProjectId(options?.targetProjectId ?? this.defaultTargetProjectId ?? null)
    agent.setAuthMode(options?.authMode ?? 'strict')
    agent.setLogger(options?.aiLogger)
    // Wire up permission engine with window context for user-auth dialogs
    agent.setPermissionContext({
      getMainWindow: this.services.getMainWindow,
      getSessionState: () => ({
        ...agent.sessionState,
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
