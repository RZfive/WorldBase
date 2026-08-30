import type { RuntimeManager } from '../project-runtime/runtime-manager.js'

export interface ApiResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  body: unknown
}

/**
 * ProjectApiClient — 主进程调用子项目 API 的 HTTP 客户端
 */
export class ProjectApiClient {
  private runtimeManager: RuntimeManager

  constructor (runtimeManager: RuntimeManager) {
    this.runtimeManager = runtimeManager
  }

  /**
   * Generic API call to a running project.
   */
  async call (projectId: string, method: string, apiPath: string, data: Record<string, unknown> | null = null): Promise<ApiResponse> {
    let port = this.runtimeManager.getPort(projectId)
    if (!port) {
      const startResult = await this.runtimeManager.start(projectId)
      port = startResult.port || this.runtimeManager.getPort(projectId)
    }

    if (!port) {
      throw new Error(`Project ${projectId} is not running`)
    }

    const url = `http://127.0.0.1:${port}${apiPath}`
    const options: RequestInit = {
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        'X-TheWorld-Internal': 'true'
      }
    }

    if (data && method.toUpperCase() !== 'GET') {
      options.body = JSON.stringify(data)
    }

    // For GET requests with params, append as query string
    let requestUrl = url
    if (data && method.toUpperCase() === 'GET') {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined && value !== null) {
          params.append(key, String(value))
        }
      }
      const qs = params.toString()
      if (qs) {
        requestUrl = `${url}?${qs}`
      }
    }

    const response = await fetch(requestUrl, options)

    const contentType = response.headers.get('content-type') || ''
    let body: unknown
    if (contentType.includes('application/json')) {
      body = await response.json()
    } else {
      body = await response.text()
    }

    return {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      body
    }
  }

  async get (projectId: string, apiPath: string, params?: Record<string, unknown>): Promise<ApiResponse> {
    return this.call(projectId, 'GET', apiPath, params ?? null)
  }

  async post (projectId: string, apiPath: string, body?: Record<string, unknown>): Promise<ApiResponse> {
    return this.call(projectId, 'POST', apiPath, body ?? null)
  }

  async put (projectId: string, apiPath: string, body?: Record<string, unknown>): Promise<ApiResponse> {
    return this.call(projectId, 'PUT', apiPath, body ?? null)
  }

  async delete (projectId: string, apiPath: string): Promise<ApiResponse> {
    return this.call(projectId, 'DELETE', apiPath)
  }
}
