import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { projectsRouter } from './routes/projects.js'
import { aiRouter } from './routes/ai.js'

/**
 * LanServer — 局域网服务器
 * 提供 REST API 和反向代理到子项目
 */
export class LanServer {
  /**
   * @param {object} config
   * @param {number} config.port
   * @param {import('../project-fs/project-fs.js').ProjectFS} config.projectFS
   * @param {import('../project-runtime/runtime-manager.js').RuntimeManager} config.runtimeManager
   * @param {import('../project-api-bridge/api-client.js').ProjectApiClient} config.apiClient
   * @param {import('../project-data-access/data-access.js').ProjectDataAccess} config.dataAccess
   * @param {import('../ai-engine/ai-engine.js').AIEngine} config.aiEngine
   */
  constructor (config) {
    this.port = config.port || 19527
    this.services = config
    this.app = express()
    this.server = null

    this._setupMiddleware()
    this._setupRoutes()
    this._setupProxy()
  }

  _setupMiddleware () {
    this.app.use(express.json({ limit: '10mb' }))
    this.app.use(express.urlencoded({ extended: true }))

    // CORS for local network access
    this.app.use((_req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*')
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      if (_req.method === 'OPTIONS') {
        return res.sendStatus(200)
      }
      next()
    })
  }

  _setupRoutes () {
    // Health check
    this.app.get('/api/health', (_req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() })
    })

    // Project management routes
    this.app.use('/api/projects', projectsRouter(this.services))

    // AI chat routes
    this.app.use('/api/ai', aiRouter(this.services))
  }

  _setupProxy () {
    // Dynamic reverse proxy: /tool/:projectId/* → project's backend port
    this.app.use('/tool/:projectId', (req, res, next) => {
      const { projectId } = req.params
      const port = this.services.runtimeManager.getPort(projectId)

      if (!port) {
        return res.status(404).json({
          error: `Project ${projectId} is not running`
        })
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
  start () {
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
  stop () {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve())
      } else {
        resolve()
      }
    })
  }
}
