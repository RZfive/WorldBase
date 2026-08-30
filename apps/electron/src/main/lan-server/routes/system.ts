import { Router, type Request, type Response } from 'express'
import type { SystemService } from '../../system-capabilities/system-service.js'

interface SystemServices {
  systemService: SystemService
}

export function systemRouter (services: SystemServices): Router {
  const router = Router()

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const status = await services.systemService.getStatus()
      res.json(status)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
