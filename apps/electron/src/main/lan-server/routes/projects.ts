import { Router, type Request, type Response } from 'express'
import type { ProjectFS } from '../../project-fs/project-fs.js'
import type { RuntimeManager } from '../../project-runtime/runtime-manager.js'
import type { ProjectDataAccess } from '../../project-data-access/data-access.js'

/**
 * Narrow RPC surface consumed by the LAN routes when Rust is selected.
 * Keeping this independent from Electron's concrete client lets the LAN
 * server remain a transport shell instead of becoming a second TS project
 * runtime.
 */
export type LanJsonRpcResult = Record<string, unknown> | unknown[] | string | number | boolean | null

export interface LanProjectControl {
  call<T extends LanJsonRpcResult = LanJsonRpcResult> (method: string, params?: Record<string, unknown>): Promise<T>
}

interface ProjectServices {
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
  dataAccess: ProjectDataAccess
  resolveRustProjectControl?: () => Promise<LanProjectControl | null>
}

interface ProjectIdParams {
  projectId: string
  [key: string]: string
}

function recordFromUnknown (value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function recordsFromUnknown (value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : []
}

async function startRustProject (control: LanProjectControl, projectId: string): Promise<Record<string, unknown>> {
  const start = async (install: boolean): Promise<Record<string, unknown>> => {
    return await control.call<Record<string, unknown>>('project.dev.start', { project: projectId, install })
  }

  try {
    return await start(false)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/next not installed|node_modules/i.test(message)) throw error
    await start(true)
    return await start(false)
  }
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
      const rust = await services.resolveRustProjectControl?.()
      if (rust) {
        const native = await rust.call<Record<string, unknown>>('project.list')
        const projects = recordsFromUnknown(native.projects)
        const enriched = await Promise.all(projects.map(async project => {
          const projectId = typeof project.id === 'string' ? project.id : ''
          return projectId
            ? { ...project, runtime: await rust.call<Record<string, unknown>>('project.status', { projectId }) }
            : project
        }))
        res.json({ projects: enriched })
        return
      }
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
      const rust = await services.resolveRustProjectControl?.()
      if (rust) {
        const projectId = req.params.projectId
        const [meta, runtime] = await Promise.all([
          rust.call<Record<string, unknown>>('project.get', { projectId }),
          rust.call<Record<string, unknown>>('project.status', { projectId })
        ])
        res.json({ ...meta, runtime })
        return
      }
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
      const rust = await services.resolveRustProjectControl?.()
      if (rust) {
        const files = await rust.call<unknown[]>('project.tree', { projectId: req.params.projectId })
        res.json({ files })
        return
      }
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
      const rust = await services.resolveRustProjectControl?.()
      if (rust) {
        const native = await rust.call<Record<string, unknown>>('project.file.read', {
          projectId: req.params.projectId,
          filePath
        })
        const content = native.content
        if (typeof content !== 'string') throw new Error('Rust project read returned no content')
        res.json({ path: filePath, content })
        return
      }
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
      const rust = await services.resolveRustProjectControl?.()
      if (rust) {
        await rust.call<Record<string, unknown>>('project.file.write', {
          projectId: req.params.projectId,
          filePath,
          content
        })
        res.json({ success: true, path: filePath })
        return
      }
      await projectFS.writeFile(req.params.projectId, filePath, content)
      res.json({ success: true, path: filePath })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Start project
  router.post('/:projectId/start', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const rust = await services.resolveRustProjectControl?.()
      if (rust) {
        const native = await startRustProject(rust, req.params.projectId)
        const port = typeof native.port === 'number' ? native.port : undefined
        const status = typeof native.status === 'string' && native.status.trim() ? native.status : 'starting'
        res.json({ ...native, projectId: req.params.projectId, port, status })
        return
      }
      const result = await runtimeManager.start(req.params.projectId)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Stop project
  router.post('/:projectId/stop', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const rust = await services.resolveRustProjectControl?.()
      if (rust) {
        const native = await rust.call<Record<string, unknown>>('project.dev.stop', { project: req.params.projectId })
        res.json({
          ...native,
          projectId: req.params.projectId,
          status: native.stopped === true ? 'stopped' : 'not_running'
        })
        return
      }
      const result = await runtimeManager.stop(req.params.projectId)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Get project status
  router.get('/:projectId/status', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const rust = await services.resolveRustProjectControl?.()
      if (rust) {
        res.json(await rust.call<Record<string, unknown>>('project.status', { projectId: req.params.projectId }))
        return
      }
      res.json(runtimeManager.getStatus(req.params.projectId))
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Get project logs
  router.get('/:projectId/logs', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const lines = parseInt(req.query.lines as string) || 50
      const rust = await services.resolveRustProjectControl?.()
      if (rust) {
        const native = await rust.call<Record<string, unknown>>('project.logs', {
          projectId: req.params.projectId,
          lines
        })
        res.json({ logs: Array.isArray(native.logs) ? native.logs : [] })
        return
      }
      res.json({ logs: runtimeManager.getLogs(req.params.projectId, lines) })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Query project database
  router.post('/:projectId/data/query', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const { sql } = req.body as { sql: string }
      const rust = await services.resolveRustProjectControl?.()
      if (rust) {
        const rows = await rust.call<unknown[]>('project.data.query', { projectId: req.params.projectId, sql })
        res.json({ rows: recordsFromUnknown(rows) })
        return
      }
      const rows = await dataAccess.queryDatabase(req.params.projectId, sql)
      res.json({ rows })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // Get data summary
  router.get('/:projectId/data/summary', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const rust = await services.resolveRustProjectControl?.()
      if (rust) {
        res.json(await rust.call<Record<string, unknown>>('project.data.summary', { projectId: req.params.projectId }))
        return
      }
      const summary = await dataAccess.getDataSummary(req.params.projectId)
      res.json(summary)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Get declared/introspected table schema
  router.get('/:projectId/data/schema', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const rust = await services.resolveRustProjectControl?.()
      if (rust) {
        const schema = await rust.call<LanJsonRpcResult>('project.data.schema', { projectId: req.params.projectId })
        res.json({ schema })
        return
      }
      const schema = await dataAccess.getTableSchema(req.params.projectId)
      res.json({ schema })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // List data tables for generated project use
  router.get('/:projectId/data/tables', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const rust = await services.resolveRustProjectControl?.()
      if (rust) {
        const native = await rust.call<Record<string, unknown>>('project.data.tables', { projectId: req.params.projectId })
        const tables = Array.isArray(native.tables)
          ? native.tables.filter((table): table is string => typeof table === 'string')
          : []
        res.json({ tables })
        return
      }
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

      const rust = await services.resolveRustProjectControl?.()
      if (rust) {
        const rows = await rust.call<unknown[]>('project.data.records.query', {
          projectId: req.params.projectId,
          table,
          filters,
          limit,
          offset,
          orderBy,
          orderDirection,
          columns
        })
        res.json({ rows: recordsFromUnknown(rows) })
        return
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
      const rust = await services.resolveRustProjectControl?.()
      if (rust) {
        const result = await rust.call<Record<string, unknown>>('project.data.records.save', {
          projectId: req.params.projectId,
          table,
          records: payload,
          mode
        })
        res.json({ success: true, ...result })
        return
      }
      const result = await dataAccess.saveRecords(req.params.projectId, table, payload, { mode })
      res.json({ success: true, ...result })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // Analyze project structure
  router.get('/:projectId/analyze', async (req: Request<ProjectIdParams>, res: Response) => {
    try {
      const rust = await services.resolveRustProjectControl?.()
      if (rust) {
        res.json(await rust.call<Record<string, unknown>>('project.analyze', { projectId: req.params.projectId }))
        return
      }
      const analysis = await projectFS.analyzeProject(req.params.projectId)
      res.json(analysis)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
