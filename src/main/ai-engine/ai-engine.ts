import { AgentCore } from './agent/agent-core.js'
import { OpenAIProvider } from './providers/openai-provider.js'
import { registerAllTools } from './agent/tools/index.js'
import type { ChatMessage, ToolDefinition } from './providers/openai-provider.js'
import type { ProjectFS } from '../project-fs/project-fs.js'
import type { RuntimeManager } from '../project-runtime/runtime-manager.js'
import type { ProjectApiClient } from '../project-api-bridge/api-client.js'
import type { ProjectDataAccess } from '../project-data-access/data-access.js'

export interface AIEngineServices {
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
  apiClient: ProjectApiClient
  dataAccess: ProjectDataAccess
}

export interface AIConfigInput {
  apiKey?: string
  baseUrl?: string
  model?: string
}

/**
 * AIEngine — AI 引擎入口
 * 管理 AI 对话、Agent 执行和 function calling
 */
export class AIEngine {
  private services: AIEngineServices
  private provider: OpenAIProvider
  private agent: AgentCore

  constructor (services: AIEngineServices) {
    this.services = services
    this.provider = new OpenAIProvider()
    this.agent = new AgentCore(this.provider, services as unknown as Record<string, unknown>)

    // Register all tools
    registerAllTools(this.agent, services)
  }

  /**
   * Handle a chat message from the user.
   * Runs the Agent loop: think → act → observe → respond.
   */
  async chat (messages: ChatMessage[]): Promise<ChatMessage> {
    return this.agent.run(messages)
  }

  /**
   * Get the list of available tools (for UI display).
   */
  getAvailableTools (): ToolDefinition[] {
    return this.agent.getToolDefinitions()
  }

  /**
   * Update AI provider configuration.
   */
  configure (config: AIConfigInput): void {
    if (config.apiKey) {
      this.provider.setApiKey(config.apiKey)
    }
    if (config.baseUrl) {
      this.provider.setBaseUrl(config.baseUrl)
    }
    if (config.model) {
      this.provider.setModel(config.model)
    }
  }
}
