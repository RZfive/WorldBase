import { AgentCore } from './agent/agent-core.js'
import { OpenAIProvider } from './providers/openai-provider.js'
import { registerAllTools } from './agent/tools/index.js'

/**
 * AIEngine — AI 引擎入口
 * 管理 AI 对话、Agent 执行和 function calling
 */
export class AIEngine {
  /**
   * @param {object} services - Injected services
   * @param {import('../project-fs/project-fs.js').ProjectFS} services.projectFS
   * @param {import('../project-runtime/runtime-manager.js').RuntimeManager} services.runtimeManager
   * @param {import('../project-api-bridge/api-client.js').ProjectApiClient} services.apiClient
   * @param {import('../project-data-access/data-access.js').ProjectDataAccess} services.dataAccess
   */
  constructor (services) {
    this.services = services
    this.provider = new OpenAIProvider()
    this.agent = new AgentCore(this.provider, services)

    // Register all tools
    registerAllTools(this.agent, services)
  }

  /**
   * Handle a chat message from the user.
   * Runs the Agent loop: think → act → observe → respond.
   * @param {Array<{role: string, content: string}>} messages
   * @returns {Promise<{role: string, content: string}>}
   */
  async chat (messages) {
    return this.agent.run(messages)
  }

  /**
   * Get the list of available tools (for UI display).
   */
  getAvailableTools () {
    return this.agent.getToolDefinitions()
  }

  /**
   * Update AI provider configuration.
   */
  configure (config) {
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
