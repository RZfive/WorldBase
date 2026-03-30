import { getSystemPrompt } from './prompts/system-prompt.js';
/**
 * AgentCore — AI Agent 核心循环
 * 实现 思考 → 行动 → 观察 的循环
 */
export class AgentCore {
    provider;
    services;
    tools = new Map();
    maxIterations = 10;
    constructor(provider, services) {
        this.provider = provider;
        this.services = services;
    }
    /**
     * Register a tool for the agent to use.
     */
    registerTool(name, definition, handler) {
        this.tools.set(name, { definition, handler });
    }
    /**
     * Get all tool definitions (for LLM function calling).
     */
    getToolDefinitions() {
        return Array.from(this.tools.values()).map(t => t.definition);
    }
    /**
     * Run the agent loop with the given messages.
     */
    async run(userMessages) {
        const systemMessage = {
            role: 'system',
            content: getSystemPrompt()
        };
        const messages = [systemMessage, ...userMessages];
        const toolDefs = this.getToolDefinitions();
        let iterations = 0;
        while (iterations < this.maxIterations) {
            iterations++;
            // Call the LLM
            const response = await this.provider.chatCompletion(messages, toolDefs);
            // If no tool calls, we have the final response
            if (!response.tool_calls || response.tool_calls.length === 0) {
                return {
                    role: 'assistant',
                    content: response.content || ''
                };
            }
            // Add assistant message with tool calls to conversation
            messages.push(response);
            // Execute each tool call
            for (const toolCall of response.tool_calls) {
                const toolName = toolCall.function.name;
                const toolArgs = JSON.parse(toolCall.function.arguments);
                let result;
                try {
                    result = await this._executeTool(toolName, toolArgs);
                }
                catch (err) {
                    result = { error: err.message };
                }
                // Add tool result to conversation
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(result)
                });
            }
        }
        // Max iterations reached
        return {
            role: 'assistant',
            content: '我已经尝试了多个步骤但还没有得到最终结果。请告诉我还需要什么帮助。'
        };
    }
    /**
     * Execute a tool by name with given arguments.
     */
    async _executeTool(name, args) {
        const tool = this.tools.get(name);
        if (!tool) {
            throw new Error(`Unknown tool: ${name}`);
        }
        console.log(`[Agent] Executing tool: ${name}`, args);
        const result = await tool.handler(args);
        console.log(`[Agent] Tool result:`, typeof result === 'string' ? result.substring(0, 200) : result);
        return result;
    }
}
