import path from 'node:path'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { SqliteAdapter } from './adapters/sqlite-adapter.js'
import { JsonAdapter } from './adapters/json-adapter.js'
import { SchemaRegistry } from './schema-registry.js'
import { DataAnalyzer } from './data-analyzer.js'

/**
 * ProjectDataAccess — 统一数据访问层
 * 支持通过不同适配器访问子项目数据
 */
export class ProjectDataAccess {
  constructor (projectsDir) {
    this.projectsDir = projectsDir
    this.sqliteAdapter = new SqliteAdapter()
    this.jsonAdapter = new JsonAdapter()
    this.schemaRegistry = new SchemaRegistry()
    this.analyzer = new DataAnalyzer()
  }

  /**
   * Get the data configuration for a project from its meta file.
   */
  async _getDataConfig (projectId) {
    const metaPath = path.join(this.projectsDir, projectId, '.world-meta.json')
    if (!existsSync(metaPath)) {
      throw new Error(`Project meta not found: ${projectId}`)
    }
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
    return meta.dataSchema || null
  }

  /**
   * Get the full database path for a project.
   */
  _getDbPath (projectId, dbRelativePath) {
    return path.join(this.projectsDir, projectId, dbRelativePath)
  }

  /**
   * Execute a read-only SQL query on a project's database.
   * Only SELECT statements are allowed.
   */
  async queryDatabase (projectId, sql) {
    // Security: only allow SELECT statements
    const normalizedSql = sql.trim().toLowerCase()
    if (!normalizedSql.startsWith('select')) {
      throw new Error('Only SELECT queries are allowed for direct database access')
    }

    const config = await this._getDataConfig(projectId)
    if (!config || config.database !== 'sqlite') {
      throw new Error(`No SQLite database configured for project: ${projectId}`)
    }

    const dbPath = this._getDbPath(projectId, config.dbPath)
    return this.sqliteAdapter.query(dbPath, sql)
  }

  /**
   * Get the schema of all tables in a project's database.
   */
  async getTableSchema (projectId) {
    const config = await this._getDataConfig(projectId)
    if (!config) {
      return null
    }

    // Return from meta if available
    if (config.tables) {
      return config.tables
    }

    // Otherwise introspect the database
    if (config.database === 'sqlite') {
      const dbPath = this._getDbPath(projectId, config.dbPath)
      return this.sqliteAdapter.getSchema(dbPath)
    }

    return null
  }

  /**
   * List all tables in a project's database.
   */
  async listTables (projectId) {
    const config = await this._getDataConfig(projectId)
    if (!config || config.database !== 'sqlite') {
      return []
    }

    const dbPath = this._getDbPath(projectId, config.dbPath)
    return this.sqliteAdapter.listTables(dbPath)
  }

  /**
   * Get paginated data from a specific table.
   */
  async getTableData (projectId, tableName, { page = 1, pageSize = 50 } = {}) {
    const config = await this._getDataConfig(projectId)
    if (!config || config.database !== 'sqlite') {
      throw new Error(`No SQLite database configured for project: ${projectId}`)
    }

    const dbPath = this._getDbPath(projectId, config.dbPath)
    const offset = (page - 1) * pageSize
    return this.sqliteAdapter.query(
      dbPath,
      `SELECT * FROM "${tableName}" LIMIT ${Number(pageSize)} OFFSET ${Number(offset)}`
    )
  }

  /**
   * Get a summary of a project's data (tables, row counts, etc.).
   */
  async getDataSummary (projectId) {
    const config = await this._getDataConfig(projectId)
    if (!config) {
      return { projectId, hasData: false }
    }

    const summary = {
      projectId,
      hasData: true,
      database: config.database,
      tables: []
    }

    if (config.database === 'sqlite') {
      const dbPath = this._getDbPath(projectId, config.dbPath)
      if (!existsSync(dbPath)) {
        return { projectId, hasData: false, reason: 'Database file not found' }
      }

      const tables = await this.sqliteAdapter.listTables(dbPath)
      for (const table of tables) {
        const countResult = await this.sqliteAdapter.query(
          dbPath,
          `SELECT COUNT(*) as count FROM "${table}"`
        )
        summary.tables.push({
          name: table,
          rowCount: countResult[0]?.count || 0
        })
      }
    }

    return summary
  }

  /**
   * Read JSON data files from a project.
   */
  async readJsonData (projectId, relativePath) {
    const fullPath = path.join(this.projectsDir, projectId, relativePath)
    return this.jsonAdapter.read(fullPath)
  }

  /**
   * Run an analysis on a project's data.
   */
  async analyzeData (projectId, analysisType, options = {}) {
    return this.analyzer.analyze(this, projectId, analysisType, options)
  }

  /**
   * Cross-project data query — aggregate data from multiple projects.
   */
  async crossProjectQuery (projectIds, queryFn) {
    const results = {}
    for (const projectId of projectIds) {
      try {
        results[projectId] = await queryFn(this, projectId)
      } catch (err) {
        results[projectId] = { error: err.message }
      }
    }
    return results
  }
}
