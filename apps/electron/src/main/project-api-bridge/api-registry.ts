import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'

export interface ApiDefinition {
  method: string
  path: string
  description?: string
  [key: string]: unknown
}

/**
 * ApiRegistry — 管理子项目 API 注册信息
 */
export class ApiRegistry {
  private registry = new Map<string, ApiDefinition[]>()

  /**
   * Register APIs for a project from its .world-meta.json.
   */
  async loadFromMeta (projectId: string, projectsDir: string): Promise<ApiDefinition[]> {
    const metaPath = path.join(projectsDir, projectId, '.world-meta.json')

    if (!existsSync(metaPath)) {
      return []
    }

    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>
    const runtime = meta.runtime as Record<string, unknown> | undefined
    const backend = runtime?.backend as Record<string, unknown> | undefined
    const apis = (backend?.apis as ApiDefinition[]) || []

    this.registry.set(projectId, apis)
    return apis
  }

  /**
   * Get registered APIs for a project.
   */
  getApis (projectId: string): ApiDefinition[] {
    return this.registry.get(projectId) || []
  }

  /**
   * Update the API registry for a project.
   */
  setApis (projectId: string, apis: ApiDefinition[]): void {
    this.registry.set(projectId, apis)
  }

  /**
   * Get all registered APIs across all projects.
   */
  getAllApis (): Record<string, ApiDefinition[]> {
    const result: Record<string, ApiDefinition[]> = {}
    for (const [projectId, apis] of this.registry) {
      result[projectId] = apis
    }
    return result
  }

  /**
   * Find an API endpoint by path pattern.
   */
  findApi (projectId: string, method: string, apiPath: string): ApiDefinition | undefined {
    const apis = this.getApis(projectId)
    return apis.find(api =>
      api.method.toUpperCase() === method.toUpperCase() &&
      api.path === apiPath
    )
  }
}
