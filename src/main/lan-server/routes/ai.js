import { Router } from 'express'

/**
 * AI chat API routes
 */
export function aiRouter (services) {
  const router = Router()
  const { aiEngine } = services

  // Chat with AI
  router.post('/chat', async (req, res) => {
    try {
      const { messages } = req.body

      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'messages array is required' })
      }

      const response = await aiEngine.chat(messages)
      res.json(response)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Get available tools
  router.get('/tools', (_req, res) => {
    const tools = aiEngine.getAvailableTools()
    res.json({ tools })
  })

  // Configure AI
  router.post('/configure', (req, res) => {
    try {
      const { apiKey, baseUrl, model } = req.body
      aiEngine.configure({ apiKey, baseUrl, model })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
