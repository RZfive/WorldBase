import { AgentCore, type StreamEvent, type ProgressCallback } from './agent/agent-core.js'
import { OpenAIProvider } from './providers/openai-provider.js'
import { registerAllTools } from './agent/tools/index.js'
import type { ChatMessage, ToolDefinition } from './providers/openai-provider.js'
import type { ProjectFS } from '../project-fs/project-fs.js'
import type { RuntimeManager } from '../project-runtime/runtime-manager.js'
import type { ProjectApiClient } from '../project-api-bridge/api-client.js'
import type { ProjectDataAccess } from '../project-data-access/data-access.js'
import type { BrowserWindow } from 'electron'

export type { StreamEvent, ProgressCallback }

export interface AIEngineServices {
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
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

    registerAllTools(this.agent, services)
  }

  /**
   * Handle a chat message from the user (non-streaming).
   */
  async chat (messages: ChatMessage[]): Promise<ChatMessage> {
    return this.agent.run(messages)
  }

  /**
   * Handle a chat message with streaming response.
   */
  chatStream (messages: ChatMessage[], onProgress?: ProgressCallback): AsyncGenerator<StreamEvent> {
    return this.agent.runStream(messages, onProgress)
  }

  /**
   * Get the list of available tools (for UI display).
   */
  getAvailableTools (): ToolDefinition[] {
    return this.agent.getToolDefinitions()
  }

  /**
   * Set active skill contents for the agent.
   */
  setActiveSkills (contents: string[]): void {
    this.agent.setActiveSkills(contents)
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
    if (config.enableThinking !== undefined) {
      this.provider.setEnableThinking(config.enableThinking)
    }
    if (config.contextWindow !== undefined) {
      this.provider.setContextWindow(config.contextWindow)
    }
  }
}
