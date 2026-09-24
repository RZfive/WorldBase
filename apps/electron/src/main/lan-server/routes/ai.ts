import { Router, type Request, type Response } from 'express'
import type { AIConfigInput } from '../../ai-engine/engine-contracts.js'
import type { AIExecutionEngine } from '../../ai-harness/types.js'
import type { SettingsStore } from '../../settings/settings-store.js'

interface AIServices {
  aiEngine: AIExecutionEngine
  resolveAiEngine?: () => Promise<AIExecutionEngine>
  configureAiEngines?: (config: AIConfigInput) => void
  settingsStore?: SettingsStore
}

interface ChatMessage {
  role: string
  content: string
}

/**
 * AI chat API routes
 */
export function aiRouter (services: AIServices): Router {
  const router = Router()
  const getAiEngine = async (): Promise<AIExecutionEngine> => {
    return await services.resolveAiEngine?.() || services.aiEngine
  }
  const configureAiEngines = (config: AIConfigInput) => {
    if (services.configureAiEngines) {
      services.configureAiEngines(config)
      return
    }
    // Legacy callers that do not supply the selector keep their existing
    // single-engine behavior.
    ;(services.aiEngine as unknown as { configure?: (input: AIConfigInput) => void }).configure?.(config)
  }

  // Chat with AI
  router.post('/chat', async (req: Request, res: Response) => {
    try {
      const { messages } = req.body as { messages?: ChatMessage[] }

      if (!messages || !Array.isArray(messages)) {
        res.status(400).json({ error: 'messages array is required' })
        return
      }

      const response = await (await getAiEngine()).chat(messages)
      res.json(response)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Get available tools
  router.get('/tools', async (_req: Request, res: Response) => {
    try {
      const tools = (await getAiEngine()).getAvailableTools()
      res.json({ tools })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Configure AI
  router.post('/configure', (req: Request, res: Response) => {
    try {
      const { apiKey, baseUrl, model } = req.body as { apiKey?: string; baseUrl?: string; model?: string }
      configureAiEngines({ apiKey, baseUrl, model })
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Get AI settings
  router.get('/settings', (_req: Request, res: Response) => {
    try {
      const { settingsStore } = services
      if (settingsStore) {
        res.json(settingsStore.getAISettings())
      } else {
        res.json({ apiKey: '', baseUrl: '', model: '' })
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Save AI settings
  router.post('/settings', (req: Request, res: Response) => {
    try {
      const { apiKey, baseUrl, model } = (req.body || {}) as { apiKey?: unknown; baseUrl?: unknown; model?: unknown }
      const config = {
        apiKey: typeof apiKey === 'string' ? apiKey : undefined,
        baseUrl: typeof baseUrl === 'string' ? baseUrl : undefined,
        model: typeof model === 'string' ? model : undefined
      }
      const { settingsStore } = services
      if (settingsStore) {
        settingsStore.saveAISettings(config)
      }
      configureAiEngines(config)
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
