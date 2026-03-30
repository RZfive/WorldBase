import path from 'node:path'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { SqliteAdapter } from './adapters/sqlite-adapter.js'
import { JsonAdapter } from './adapters/json-adapter.js'
import { SchemaRegistry } from './schema-registry.js'
import { DataAnalyzer } from './data-analyzer.js'

interface DataConfig {
  database: string
  dbPath: string
  tables?: unknown[]
  [key: string]: unknown
}

interface TableSummary {
  name: string
  rowCount: number
}

interface DataSummary {
  projectId: string
  hasData: boolean
  database?: string
  tables?: TableSummary[]
  reason?: string
}

/**
 * Validate that a SQL identifier (table/column name) is safe.
 * Only allows alphanumeric characters and underscores.
 */
function validateIdentifier (name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`)
  }
  return name
}

/**
 * ProjectDataAccess — 统一数据访问层
 * 支持通过不同适配器访问子项目数据
 */
export class ProjectDataAccess {
  private projectsDir: string
  private sqliteAdapter: SqliteAdapter
  private jsonAdapter: JsonAdapter
  readonly schemaRegistry: SchemaRegistry
  private analyzer: DataAnalyzer

  constructor (projectsDir: string) {
    this.projectsDir = projectsDir
    this.sqliteAdapter = new SqliteAdapter()
    this.jsonAdapter = new JsonAdapter()
    this.schemaRegistry = new SchemaRegistry()
    this.analyzer = new DataAnalyzer()
  }

  /**
   * Get the data configuration for a project from its meta file.
   */
  async _getDataConfig (projectId: string): Promise<DataConfig | null> {
    const metaPath = path.join(this.projectsDir, projectId, '.world-meta.json')
    if (!existsSync(metaPath)) {
      throw new Error(`Project meta not found: ${projectId}`)
    }
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>
    return (meta.dataSchema as DataConfig) || null
  }

  /**
   * Get the full database path for a project.
   */
  _getDbPath (projectId: string, dbRelativePath: string): string {
    return path.join(this.projectsDir, projectId, dbRelativePath)
  }

  /**
   * Execute a read-only SQL query on a project's database.
   * Only SELECT statements are allowed.
   */
  async queryDatabase (projectId: string, sql: string): Promise<Record<string, unknown>[]> {
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
  async getTableSchema (projectId: string): Promise<unknown[] | null> {
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
  async listTables (projectId: string): Promise<string[]> {
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
  async getTableData (projectId: string, tableName: string, { page = 1, pageSize = 50 } = {}): Promise<Record<string, unknown>[]> {
    validateIdentifier(tableName)
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
  async getDataSummary (projectId: string): Promise<DataSummary> {
    const config = await this._getDataConfig(projectId)
    if (!config) {
      return { projectId, hasData: false }
    }

    const summary: DataSummary = {
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

      const tables = this.sqliteAdapter.listTables(dbPath)
      for (const table of tables) {
        validateIdentifier(table)
        const countResult = this.sqliteAdapter.query(
          dbPath,
          `SELECT COUNT(*) as count FROM "${table}"`
        )
        summary.tables!.push({
          name: table,
          rowCount: (countResult[0]?.count as number) || 0
        })
      }
    }

    return summary
  }

  /**
   * Read JSON data files from a project.
   */
  async readJsonData (projectId: string, relativePath: string): Promise<unknown> {
    const fullPath = path.join(this.projectsDir, projectId, relativePath)
    return this.jsonAdapter.read(fullPath)
  }

  /**
   * Run an analysis on a project's data.
   */
  async analyzeData (projectId: string, analysisType: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.analyzer.analyze(this, projectId, analysisType, options)
  }

  /**
   * Cross-project data query — aggregate data from multiple projects.
   */
  async crossProjectQuery (
    projectIds: string[],
    queryFn: (dataAccess: ProjectDataAccess, projectId: string) => Promise<unknown>
  ): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {}
    for (const projectId of projectIds) {
      try {
        results[projectId] = await queryFn(this, projectId)
      } catch (err) {
        results[projectId] = { error: (err as Error).message }
      }
    }
    return results
  }
}
