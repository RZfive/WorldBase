import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'

/**
 * ApiRegistry — 管理子项目 API 注册信息
 */
export class ApiRegistry {
  constructor () {
    /** @type {Map<string, Array>} projectId -> api definitions */
    this.registry = new Map()
  }

  /**
   * Register APIs for a project from its .world-meta.json.
   */
  async loadFromMeta (projectId, projectsDir) {
    const metaPath = path.join(projectsDir, projectId, '.world-meta.json')

    if (!existsSync(metaPath)) {
      return []
    }

    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
    const apis = meta.runtime?.backend?.apis || []

    this.registry.set(projectId, apis)
    return apis
  }

  /**
   * Get registered APIs for a project.
   */
  getApis (projectId) {
    return this.registry.get(projectId) || []
  }

  /**
   * Update the API registry for a project.
   */
  setApis (projectId, apis) {
    this.registry.set(projectId, apis)
  }

  /**
   * Get all registered APIs across all projects.
   */
  getAllApis () {
    const result = {}
    for (const [projectId, apis] of this.registry) {
      result[projectId] = apis
    }
    return result
  }

  /**
   * Find an API endpoint by path pattern.
   */
  findApi (projectId, method, apiPath) {
    const apis = this.getApis(projectId)
    return apis.find(api =>
      api.method.toUpperCase() === method.toUpperCase() &&
      api.path === apiPath
    )
  }
}
