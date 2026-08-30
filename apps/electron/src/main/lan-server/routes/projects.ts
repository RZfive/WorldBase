import { Router, type Request, type Response } from 'express'
import type { ProjectFS } from '../../project-fs/project-fs.js'
import type { RuntimeManager } from '../../project-runtime/runtime-manager.js'
import type { ProjectDataAccess } from '../../project-data-access/data-access.js'

interface ProjectServices {
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
  dataAccess: ProjectDataAccess
}

interface ProjectIdParams {
  projectId: string
  [key: string]: string
}

/**
 * Projects API routes
 */
export function projectsRouter (services: ProjectServices): Router {
  const router = Router()
  const { projectFS, runtimeManager, dataAccess } = services

  // List all projects
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const projects = await projectFS.listProjects()

      // Enrich with runtime status
      const enriched = projects.map(project => ({
        ...project,
        runtime: runtimeManager.getStatus(project.id)
      }))

      res.json({ projects: enriched })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Get project details
  router.get('/:projectId', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const meta = await projectFS.getProjectMeta(req.params.projectId)
      const status = runtimeManager.getStatus(req.params.projectId)
      res.json({ ...meta, runtime: status })
    } catch (err) {
      res.status(404).json({ error: (err as Error).message })
    }
  })

  // Get project file tree
  router.get('/:projectId/files', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const tree = await projectFS.getFileTree(req.params.projectId)
      res.json({ files: tree })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Read a specific file
  router.get('/:projectId/files/*', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const filePath = req.params[0]
      const content = await projectFS.readFile(req.params.projectId, filePath)
      res.json({ path: filePath, content })
    } catch (err) {
      res.status(404).json({ error: (err as Error).message })
    }
  })

  // Write a file
  router.put('/:projectId/files/*', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const filePath = req.params[0]
      const { content } = req.body as { content: string }
      await projectFS.writeFile(req.params.projectId, filePath, content)
      res.json({ success: true, path: filePath })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Start project
  router.post('/:projectId/start', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const result = await runtimeManager.start(req.params.projectId)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Stop project
  router.post('/:projectId/stop', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const result = await runtimeManager.stop(req.params.projectId)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Get project status
  router.get('/:projectId/status', (req: Request<ProjectIdParams>, res: Response) => {
    const status = runtimeManager.getStatus(req.params.projectId)
    res.json(status)
  })

  // Get project logs
  router.get('/:projectId/logs', (req: Request<ProjectIdParams>, res: Response) => {
    const lines = parseInt(req.query.lines as string) || 50
    const logs = runtimeManager.getLogs(req.params.projectId, lines)
    res.json({ logs })
  })

  // Query project database
  router.post('/:projectId/data/query', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const { sql } = req.body as { sql: string }
      const rows = await dataAccess.queryDatabase(req.params.projectId, sql)
      res.json({ rows })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // Get data summary
  router.get('/:projectId/data/summary', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const summary = await dataAccess.getDataSummary(req.params.projectId)
      res.json(summary)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Get declared/introspected table schema
  router.get('/:projectId/data/schema', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const schema = await dataAccess.getTableSchema(req.params.projectId)
      res.json({ schema })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // List data tables for generated project use
  router.get('/:projectId/data/tables', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const tables = await dataAccess.listTables(req.params.projectId)
      res.json({ tables })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // Standard record query interface for generated projects
  router.post('/:projectId/data/records/query', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const {
        table,
        filters,
        limit,
        offset,
        orderBy,
        orderDirection,
        columns
      } = req.body as {
        table: string
        filters?: Record<string, unknown>
        limit?: number
        offset?: number
        orderBy?: string
        orderDirection?: 'asc' | 'desc'
        columns?: string[]
      }

      const rows = await dataAccess.readRecords(req.params.projectId, table, {
        filters,
        limit,
        offset,
        orderBy,
        orderDirection,
        columns
      })
      res.json({ rows })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // Standard record save interface for generated projects
  router.post('/:projectId/data/records/save', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const {
        table,
        record,
        records,
        mode
      } = req.body as {
        table: string
        record?: Record<string, unknown>
        records?: Array<Record<string, unknown>>
        mode?: 'insert' | 'upsert'
      }

      const payload = records || (record ? [record] : [])
      const result = await dataAccess.saveRecords(req.params.projectId, table, payload, { mode })
      res.json({ success: true, ...result })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // Analyze project structure
  router.get('/:projectId/analyze', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const analysis = await projectFS.analyzeProject(req.params.projectId)
      res.json(analysis)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
