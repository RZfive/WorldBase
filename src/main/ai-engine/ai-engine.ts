import { AgentCore, type StreamEvent, type ProgressCallback, type ProgressEvent } from './agent/agent-core.js'
import { OpenAIProvider } from './providers/openai-provider.js'
import { registerAllTools } from './agent/tools/index.js'
import type { ChatMessage, ToolDefinition } from './providers/openai-provider.js'
import type { ProjectFS } from '../project-fs/project-fs.js'
import type { RuntimeManager } from '../project-runtime/runtime-manager.js'
import type { BuilderService } from '../project-runtime/builder-service.js'
import type { ProjectApiClient } from '../project-api-bridge/api-client.js'
import type { ProjectDataAccess } from '../project-data-access/data-access.js'
import type { BrowserWindow } from 'electron'
import type { AIExecutionAuthMode } from '../settings/settings-store.js'

export type { StreamEvent, ProgressCallback, ProgressEvent }

export interface AIEngineServices {
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
  builderService: BuilderService
  apiClient: ProjectApiClient
  dataAccess: ProjectDataAccess
  getMainWindow?: () => BrowserWindow | null
}

export interface AIConfigInput {
  apiKey?: string
  baseUrl?: string
  model?: string
  enableThinking?: boolean
  contextWindow?: number
}

export interface AIRequestOptions {
  targetProjectId?: string | null
  providerConfig?: AIConfigInput
  abortSignal?: AbortSignal
  authMode?: AIExecutionAuthMode
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

  constructor (services: AIEngineServices) {
    this.services = services
  }

  private applyConfigToProvider (provider: OpenAIProvider, config: AIConfigInput): void {
    if (config.apiKey) {
      provider.setApiKey(config.apiKey)
    }
    if (config.baseUrl) {
      provider.setBaseUrl(config.baseUrl)
    }
    if (config.model) {
      provider.setModel(config.model)
    }
    if (config.enableThinking !== undefined) {
      provider.setEnableThinking(config.enableThinking)
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

    const agent = new AgentCore(provider, this.services as unknown as Record<string, unknown>)
    registerAllTools(agent, this.services)
    agent.setActiveSkills(this.activeSkillContents)
    agent.setTargetProjectId(options?.targetProjectId ?? this.defaultTargetProjectId ?? null)
    agent.setAuthMode(options?.authMode ?? 'strict')
    return agent
  }

  /**
   * Handle a chat message from the user (non-streaming).
   */
  async chat (messages: ChatMessage[], options?: AIRequestOptions): Promise<ChatMessage> {
    return this.createAgent(options).run(messages)
  }

  /**
   * Handle a chat message with streaming response.
   */
  chatStream (messages: ChatMessage[], onProgress?: ProgressCallback, options?: AIRequestOptions): AsyncGenerator<StreamEvent> {
    return this.createAgent(options).runStream(messages, onProgress, options?.abortSignal)
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
}
