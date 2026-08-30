import type { ProjectFS } from '../project-fs/project-fs.js'

export interface DiscoveredApi {
  method: string
  path: string
  file?: string
  line?: number
  description: string
  params?: Record<string, unknown>
}

/**
 * ApiDiscovery — 自动发现子项目 API 端点
 * 通过分析源代码或运行时检测来发现 API
 */
export class ApiDiscovery {
  private projectFS: ProjectFS

  constructor (projectFS: ProjectFS) {
    this.projectFS = projectFS
  }

  /**
   * Discover APIs by analyzing route files in a project.
   */
  async discoverFromSource (projectId: string): Promise<DiscoveredApi[]> {
    const apis: DiscoveredApi[] = []

    try {
      // Search for common route patterns in source code
      const routePatterns = [
        /router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        /app\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi
      ]

      const searchResults = await this.projectFS.searchInProject(projectId, 'router.')
      const searchResults2 = await this.projectFS.searchInProject(projectId, 'app.get')
      const allResults = [...searchResults, ...searchResults2]

      for (const result of allResults) {
        for (const pattern of routePatterns) {
          pattern.lastIndex = 0
          const match = pattern.exec(result.content)
          if (match) {
            apis.push({
              method: match[1].toUpperCase(),
              path: match[2],
              file: result.file,
              line: result.line,
              description: `Found in ${result.file}:${result.line}`
            })
          }
        }
      }
    } catch (err) {
      console.warn(`[ApiDiscovery] Failed to discover APIs for ${projectId}:`, (err as Error).message)
    }

    return apis
  }

  /**
   * Try to discover APIs by making a request to common documentation endpoints.
   */
  async discoverFromRuntime (projectId: string, port: number): Promise<DiscoveredApi[]> {
    const docEndpoints = [
      '/api-docs',
      '/swagger.json',
      '/openapi.json',
      '/api'
    ]

    for (const endpoint of docEndpoints) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${endpoint}`)
        if (response.ok) {
          const data = await response.json() as Record<string, unknown>
          // Basic OpenAPI/Swagger parsing
          if (data.paths) {
            return this._parseOpenApiPaths(data.paths as Record<string, Record<string, unknown>>)
          }
        }
      } catch {
        // endpoint not available, continue
      }
    }

    return []
  }

  /**
   * Parse OpenAPI paths object into our API format.
   */
  _parseOpenApiPaths (paths: Record<string, Record<string, unknown>>): DiscoveredApi[] {
    const apis: DiscoveredApi[] = []
    for (const [pathStr, methods] of Object.entries(paths)) {
      for (const [method, details] of Object.entries(methods)) {
        if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
          const info = details as Record<string, unknown>
          apis.push({
            method: method.toUpperCase(),
            path: pathStr,
            description: (info.summary as string) || (info.description as string) || '',
            params: (info.parameters as Record<string, unknown>) || {}
          })
        }
      }
    }
    return apis
  }
}
