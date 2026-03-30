/**
 * OpenAIProvider — OpenAI 兼容 API 提供者
 * 支持 OpenAI, Azure OpenAI, 以及任何兼容 API
 */
export class OpenAIProvider {
  constructor () {
    this.apiKey = process.env.OPENAI_API_KEY || ''
    this.baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    this.model = process.env.OPENAI_MODEL || 'gpt-4o'
  }

  setApiKey (key) {
    this.apiKey = key
  }

  setBaseUrl (url) {
    this.baseUrl = url
  }

  setModel (model) {
    this.model = model
  }

  /**
   * Make a chat completion request with function calling support.
   * @param {Array} messages - Chat messages
   * @param {Array} tools - Tool definitions for function calling
   * @returns {Promise<object>} Response with message and optional tool_calls
   */
  async chatCompletion (messages, tools = []) {
    const body = {
      model: this.model,
      messages,
      temperature: 0.7
    }

    if (tools.length > 0) {
      body.tools = tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }))
      body.tool_choice = 'auto'
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`)
    }

    const data = await response.json()
    return data.choices[0].message
  }
}
