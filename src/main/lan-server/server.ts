import express, { type Request, type Response, type NextFunction } from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { projectsRouter } from './routes/projects.js'
import { aiRouter } from './routes/ai.js'
import type { ProjectFS } from '../project-fs/project-fs.js'
import type { RuntimeManager } from '../project-runtime/runtime-manager.js'
import type { ProjectApiClient } from '../project-api-bridge/api-client.js'
import type { ProjectDataAccess } from '../project-data-access/data-access.js'
import type { AIEngine } from '../ai-engine/ai-engine.js'
import type { SettingsStore } from '../settings/settings-store.js'
import type { Server } from 'node:http'

export interface LanServerConfig {
  port?: number
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
  apiClient: ProjectApiClient
  dataAccess: ProjectDataAccess
  aiEngine: AIEngine
  settingsStore?: SettingsStore
}

/**
 * LanServer — 局域网服务器
 * 提供 REST API 和反向代理到子项目
 */
export class LanServer {
  private port: number
  private services: LanServerConfig
  private app: express.Application
  private server: Server | null = null

  constructor (config: LanServerConfig) {
    this.port = config.port || 19527
    this.services = config
    this.app = express()

    this._setupMiddleware()
    this._setupRoutes()
    this._setupProxy()
  }

  private _setupMiddleware (): void {
    this.app.use(express.json({ limit: '10mb' }))
    this.app.use(express.urlencoded({ extended: true }))

    // CORS for local network access
    this.app.use((_req: Request, res: Response, next: NextFunction) => {
      res.header('Access-Control-Allow-Origin', '*')
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      if (_req.method === 'OPTIONS') {
        res.sendStatus(200)
        return
      }
      next()
    })
  }

  private _setupRoutes (): void {
    // Health check
    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() })
    })

    // Project management routes
    this.app.use('/api/projects', projectsRouter(this.services))

    // AI chat routes
    this.app.use('/api/ai', aiRouter(this.services))
  }

  private _setupProxy (): void {
    // Dynamic reverse proxy: /tool/:projectId/* → project's backend port
    this.app.use('/tool/:projectId', (req: Request<{ projectId: string }>, res: Response, next: NextFunction) => {
      const { projectId } = req.params
      const port = this.services.runtimeManager.getPort(projectId)

      if (!port) {
        res.status(404).json({
          error: `Project ${projectId} is not running`
        })
        return
      }

      const proxy = createProxyMiddleware({
        target: `http://127.0.0.1:${port}`,
        changeOrigin: true,
        pathRewrite: {
          [`^/tool/${projectId}`]: ''
        }
      })

      proxy(req, res, next)
    })
  }

  /**
   * Start the LAN server.
   */
  start (): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, '0.0.0.0', () => {
        console.log(`[LanServer] Running on http://0.0.0.0:${this.port}`)
        resolve()
      })
      this.server.on('error', reject)
    })
  }

  /**
   * Stop the LAN server.
   */
  stop (): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve())
      } else {
        resolve()
      }
    })
  }
}
