/**
 * ProjectApiClient — 主进程调用子项目 API 的 HTTP 客户端
 */
export class ProjectApiClient {
  /**
   * @param {import('../project-runtime/runtime-manager.js').RuntimeManager} runtimeManager
   */
  constructor (runtimeManager) {
    this.runtimeManager = runtimeManager
  }

  /**
   * Generic API call to a running project.
   */
  async call (projectId, method, apiPath, data = null) {
    const port = this.runtimeManager.getPort(projectId)
    if (!port) {
      throw new Error(`Project ${projectId} is not running`)
    }

    const url = `http://127.0.0.1:${port}${apiPath}`
    const options = {
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
    let body
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

  async get (projectId, apiPath, params) {
    return this.call(projectId, 'GET', apiPath, params)
  }

  async post (projectId, apiPath, body) {
    return this.call(projectId, 'POST', apiPath, body)
  }

  async put (projectId, apiPath, body) {
    return this.call(projectId, 'PUT', apiPath, body)
  }

  async delete (projectId, apiPath) {
    return this.call(projectId, 'DELETE', apiPath)
  }
}
