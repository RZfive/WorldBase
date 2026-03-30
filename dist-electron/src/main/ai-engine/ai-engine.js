import { AgentCore } from './agent/agent-core.js';
import { OpenAIProvider } from './providers/openai-provider.js';
import { registerAllTools } from './agent/tools/index.js';
/**
 * AIEngine — AI 引擎入口
 * 管理 AI 对话、Agent 执行和 function calling
 */
export class AIEngine {
    services;
    provider;
    agent;
    constructor(services) {
        this.services = services;
        this.provider = new OpenAIProvider();
        this.agent = new AgentCore(this.provider, services);
        // Register all tools
        registerAllTools(this.agent, services);
    }
    /**
     * Handle a chat message from the user.
     * Runs the Agent loop: think → act → observe → respond.
     */
    async chat(messages) {
        return this.agent.run(messages);
    }
    /**
     * Get the list of available tools (for UI display).
     */
    getAvailableTools() {
        return this.agent.getToolDefinitions();
    }
    /**
     * Update AI provider configuration.
     */
    configure(config) {
        if (config.apiKey) {
            this.provider.setApiKey(config.apiKey);
        }
        if (config.baseUrl) {
            this.provider.setBaseUrl(config.baseUrl);
        }
        if (config.model) {
            this.provider.setModel(config.model);
        }
    }
}
