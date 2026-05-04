import express, { type Request, type Response, type NextFunction } from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { projectsRouter } from './routes/projects.js'
import { aiRouter } from './routes/ai.js'
import { systemRouter } from './routes/system.js'
import type { ProjectFS } from '../project-fs/project-fs.js'
import type { RuntimeManager } from '../project-runtime/runtime-manager.js'
import type { ProjectApiClient } from '../project-api-bridge/api-client.js'
import type { ProjectDataAccess } from '../project-data-access/data-access.js'
import type { AIEngine } from '../ai-engine/ai-engine.js'
import type { SettingsStore } from '../settings/settings-store.js'
import type { SystemService } from '../system-capabilities/system-service.js'
import type { Server } from 'node:http'

const LOCAL_RESOURCE_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1'])
const LAN_AUTH_COOKIE_NAME = 'the_world_lan_auth'
const LAN_AUTH_HEADER_NAME = 'x-the-world-lan-token'
const LAN_AUTH_QUERY_PARAM = 'the_world_lan_token'

function isLoopbackAddress (address?: string | null): boolean {
  if (!address) return false
  const normalized = address.replace(/^::ffff:/, '')
  return normalized === '127.0.0.1' || normalized === '::1'
}

function parseRequestCookies (req: Request): Record<string, string> {
  const cookieHeader = req.header('cookie')
  if (!cookieHeader) return {}

  const cookies: Record<string, string> = {}
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValueParts] = part.split('=')
    const name = rawName?.trim()
    if (!name) continue
    const rawValue = rawValueParts.join('=').trim()
    cookies[name] = decodeURIComponent(rawValue)
  }
  return cookies
}

function parseBrowserRequestUrlHost (value?: string | null): string | null {
  if (!value) return null
  try {
    return new URL(value).hostname
  } catch {
    return null
  }
}

function isPrivateIpAddress (hostname: string): boolean {
  if (isIP(hostname) !== 4) return false
  const [a, b] = hostname.split('.').map(Number)
  if (a === 10) return true
  if (a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  return false
}

function isBlockedProxyTarget (hostname: string): boolean {
  return LOCAL_RESOURCE_HOSTS.has(hostname) || isPrivateIpAddress(hostname)
}

function copyProxyResponseHeaders (upstream: globalThis.Response, res: Response): void {
  const headerNames = [
    'content-type',
    'cache-control',
    'etag',
    'last-modified',
    'expires',
    'accept-ranges',
    'content-range'
  ]

  for (const name of headerNames) {
    const value = upstream.headers.get(name)
    if (value) {
      res.setHeader(name, value)
    }
  }
}

function parseProxyQueryTarget (rawTarget: string): URL | null {
  try {
    const target = new URL(rawTarget)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null
    if (isBlockedProxyTarget(target.hostname)) return null
    return target
  } catch {
    return null
  }
}

function parseProxyPathTarget (protocol: string, host: string, resourcePath: string, search: string): URL | null {
  const normalizedProtocol = protocol.toLowerCase()
  if (normalizedProtocol !== 'http' && normalizedProtocol !== 'https') return null

  try {
    const decodedHost = decodeURIComponent(host)
    const hostUrl = new URL(`${normalizedProtocol}://${decodedHost}`)
    if (isBlockedProxyTarget(hostUrl.hostname)) return null
    const pathname = resourcePath ? `/${resourcePath}` : '/'
    return new URL(`${normalizedProtocol}://${decodedHost}${pathname}${search}`)
  } catch {
    return null
  }
}

async function forwardProxyRequest (target: URL, req: Request, res: Response, method: 'GET' | 'HEAD'): Promise<void> {
  const upstreamHeaders = new Headers()
  const accept = req.header('accept')
  const acceptLanguage = req.header('accept-language')
  const range = req.header('range')
  const userAgent = req.header('user-agent')

  if (accept) upstreamHeaders.set('accept', accept)
  if (acceptLanguage) upstreamHeaders.set('accept-language', acceptLanguage)
  if (range) upstreamHeaders.set('range', range)
  if (userAgent) upstreamHeaders.set('user-agent', userAgent)

  const upstream = await fetch(target, {
    method,
    headers: upstreamHeaders,
    redirect: 'follow'
  })

  res.status(upstream.status)
  copyProxyResponseHeaders(upstream, res)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.setHeader('Vary', 'Origin')

  if (method === 'HEAD') {
    res.end()
    return
  }

  const buffer = Buffer.from(await upstream.arrayBuffer())
  res.send(buffer)
}

export interface LanServerConfig {
  port?: number
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
  apiClient: ProjectApiClient
  dataAccess: ProjectDataAccess
  aiEngine: AIEngine
  systemService: SystemService
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
  private readonly authToken: string

  constructor (config: LanServerConfig) {
    this.port = config.port || 19527
    this.services = config
    this.app = express()
    this.authToken = randomBytes(24).toString('hex')

    this._setupMiddleware()
    this._setupRoutes()
    this._setupProxy()
  }

  private _setLanAuthCookie (res: Response): void {
    res.append('Set-Cookie', `${LAN_AUTH_COOKIE_NAME}=${encodeURIComponent(this.authToken)}; Path=/; HttpOnly; SameSite=Lax`)
  }

  private _hasValidLanAuthToken (req: Request): boolean {
    const headerToken = req.header(LAN_AUTH_HEADER_NAME)?.trim()
    const authorization = req.header('authorization')?.trim()
    const bearerToken = authorization?.toLowerCase().startsWith('bearer ')
      ? authorization.slice('bearer '.length).trim()
      : ''
    const queryToken = typeof req.query[LAN_AUTH_QUERY_PARAM] === 'string'
      ? req.query[LAN_AUTH_QUERY_PARAM].trim()
      : ''
    const cookieToken = parseRequestCookies(req)[LAN_AUTH_COOKIE_NAME]?.trim() || ''

    return [headerToken, bearerToken, queryToken, cookieToken].some(token => token === this.authToken)
  }

  private _isTrustedLocalApiRequest (req: Request): boolean {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      return false
    }

    const browserHosts = [
      parseBrowserRequestUrlHost(req.header('origin')),
      parseBrowserRequestUrlHost(req.header('referer'))
    ].filter(Boolean) as string[]

    if (browserHosts.length === 0) {
      return true
    }

    return browserHosts.every(hostname => LOCAL_RESOURCE_HOSTS.has(hostname))
  }

  private _requireTrustedApiAccess = (req: Request, res: Response, next: NextFunction): void => {
    if (this._isTrustedLocalApiRequest(req) || this._hasValidLanAuthToken(req)) {
      next()
      return
    }

    res.status(403).json({ error: 'LAN API access denied. Use a trusted local origin or a valid LAN auth token.' })
  }

  private _setupMiddleware (): void {
    this.app.use(express.json({ limit: '10mb' }))
    this.app.use(express.urlencoded({ extended: true }))

    // CORS for local network access
    this.app.use((_req: Request, res: Response, next: NextFunction) => {
      res.header('Access-Control-Allow-Origin', '*')
      res.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS')
      res.header('Access-Control-Allow-Headers', `Content-Type, Authorization, ${LAN_AUTH_HEADER_NAME}`)
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

    this.app.use(['/api/projects', '/api/ai', '/api/system'], this._requireTrustedApiAccess)

    // Project management routes
    this.app.use('/api/projects', projectsRouter(this.services))

    // AI chat routes
    this.app.use('/api/ai', aiRouter(this.services))

    // Host system capability routes
    this.app.use('/api/system', systemRouter(this.services))

    // Remote asset proxy for embedded apps.
    // This allows browser-based projects running in an iframe to load external
    // images, fonts, models and other static resources without depending on
    // third-party CORS headers.
    this.app.get('/api/resource-proxy', async (req: Request, res: Response) => {
      const rawTarget = typeof req.query.url === 'string' ? req.query.url : ''
      if (!rawTarget) {
        res.status(400).json({ error: 'Missing url query parameter' })
        return
      }

      const target = parseProxyQueryTarget(rawTarget)
      if (!target) {
        res.status(400).json({ error: 'Invalid or blocked target URL' })
        return
      }

      try {
        await forwardProxyRequest(target, req, res, 'GET')
      } catch (error) {
        res.status(502).json({ error: (error as Error).message || 'Proxy fetch failed' })
      }
    })

    this.app.head('/api/resource-proxy', async (req: Request, res: Response) => {
      const rawTarget = typeof req.query.url === 'string' ? req.query.url : ''
      if (!rawTarget) {
        res.sendStatus(400)
        return
      }

      const target = parseProxyQueryTarget(rawTarget)
      if (!target) {
        res.sendStatus(400)
        return
      }

      try {
        await forwardProxyRequest(target, req, res, 'HEAD')
      } catch {
        res.sendStatus(502)
      }
    })

    const proxyPathHandler = async (req: Request, res: Response, method: 'GET' | 'HEAD') => {
      const requestUrl = new URL(`http://localhost${req.originalUrl}`)
      const protocol = Array.isArray(req.params.protocol) ? req.params.protocol[0] : req.params.protocol
      const host = Array.isArray(req.params.host) ? req.params.host[0] : req.params.host
      const resourcePath = Array.isArray(req.params[0]) ? req.params[0][0] : (req.params[0] || '')
      const target = parseProxyPathTarget(protocol || '', host || '', resourcePath, requestUrl.search)

      if (!target) {
        res.sendStatus(400)
        return
      }

      try {
        await forwardProxyRequest(target, req, res, method)
      } catch {
        res.sendStatus(502)
      }
    }

    this.app.get(['/api/resource-proxy/:protocol/:host', '/api/resource-proxy/:protocol/:host/*'], async (req: Request, res: Response) => {
      await proxyPathHandler(req, res, 'GET')
    })

    this.app.head(['/api/resource-proxy/:protocol/:host', '/api/resource-proxy/:protocol/:host/*'], async (req: Request, res: Response) => {
      await proxyPathHandler(req, res, 'HEAD')
    })
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

      this._setLanAuthCookie(res)

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
