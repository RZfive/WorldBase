import { Router } from 'express'

/**
 * Projects API routes
 */
export function projectsRouter (services) {
  const router = Router()
  const { projectFS, runtimeManager, dataAccess } = services

  // List all projects
  router.get('/', async (_req, res) => {
    try {
      const projects = await projectFS.listProjects()

      // Enrich with runtime status
      const enriched = projects.map(project => ({
        ...project,
        runtime: runtimeManager.getStatus(project.id)
      }))

      res.json({ projects: enriched })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Get project details
  router.get('/:projectId', async (req, res) => {
    try {
      const meta = await projectFS.getProjectMeta(req.params.projectId)
      const status = runtimeManager.getStatus(req.params.projectId)
      res.json({ ...meta, runtime: status })
    } catch (err) {
      res.status(404).json({ error: err.message })
    }
  })

  // Get project file tree
  router.get('/:projectId/files', async (req, res) => {
    try {
      const tree = await projectFS.getFileTree(req.params.projectId)
      res.json({ files: tree })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Read a specific file
  router.get('/:projectId/files/*', async (req, res) => {
    try {
      const filePath = req.params[0]
      const content = await projectFS.readFile(req.params.projectId, filePath)
      res.json({ path: filePath, content })
    } catch (err) {
      res.status(404).json({ error: err.message })
    }
  })

  // Write a file
  router.put('/:projectId/files/*', async (req, res) => {
    try {
      const filePath = req.params[0]
      const { content } = req.body
      await projectFS.writeFile(req.params.projectId, filePath, content)
      res.json({ success: true, path: filePath })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Start project
  router.post('/:projectId/start', async (req, res) => {
    try {
      const result = await runtimeManager.start(req.params.projectId)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Stop project
  router.post('/:projectId/stop', async (req, res) => {
    try {
      const result = await runtimeManager.stop(req.params.projectId)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Get project status
  router.get('/:projectId/status', (req, res) => {
    const status = runtimeManager.getStatus(req.params.projectId)
    res.json(status)
  })

  // Get project logs
  router.get('/:projectId/logs', (req, res) => {
    const lines = parseInt(req.query.lines) || 50
    const logs = runtimeManager.getLogs(req.params.projectId, lines)
    res.json({ logs })
  })

  // Query project database
  router.post('/:projectId/data/query', async (req, res) => {
    try {
      const { sql } = req.body
      const rows = await dataAccess.queryDatabase(req.params.projectId, sql)
      res.json({ rows })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  // Get data summary
  router.get('/:projectId/data/summary', async (req, res) => {
    try {
      const summary = await dataAccess.getDataSummary(req.params.projectId)
      res.json(summary)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Analyze project structure
  router.get('/:projectId/analyze', async (req, res) => {
    try {
      const analysis = await projectFS.analyzeProject(req.params.projectId)
      res.json(analysis)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
