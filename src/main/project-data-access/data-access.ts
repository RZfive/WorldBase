import path from 'node:path'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { BridgeAdapter, type DatabaseDelegate } from './adapters/bridge-adapter.js'
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

export interface DatabaseInfo {
  projectId: string
  projectName: string
  database: string
  dbPath: string
  fullPath: string
  tables: Array<{ name: string; rowCount: number; columns: Array<{ name: string; type: string; primaryKey: boolean }> }>
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
 * 通过外部桥接适配器 (BridgeAdapter) 访问子项目数据，
 * 不再内置 SQLite 驱动。
 */
export class ProjectDataAccess {
  private projectsDir: string
  private bridgeAdapter: BridgeAdapter
  private jsonAdapter: JsonAdapter
  readonly schemaRegistry: SchemaRegistry
  private analyzer: DataAnalyzer

  constructor (projectsDir: string) {
    this.projectsDir = projectsDir
    this.bridgeAdapter = new BridgeAdapter()
    this.jsonAdapter = new JsonAdapter()
    this.schemaRegistry = new SchemaRegistry()
    this.analyzer = new DataAnalyzer()
  }

  /**
   * Set the external database delegate.
   * Called by the shell/host to inject database access capabilities.
   */
  setDatabaseDelegate (delegate: DatabaseDelegate): void {
    this.bridgeAdapter.setDelegate(delegate)
  }

  get hasDatabaseDelegate (): boolean {
    return this.bridgeAdapter.hasDelegate
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
    return this.bridgeAdapter.query(dbPath, sql)
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
    if (config.database === 'sqlite' && this.bridgeAdapter.hasDelegate) {
      const dbPath = this._getDbPath(projectId, config.dbPath)
      return this.bridgeAdapter.getSchema(dbPath)
    }

    return null
  }

  /**
   * List all tables in a project's database.
   */
  async listTables (projectId: string): Promise<string[]> {
    const config = await this._getDataConfig(projectId)
    if (!config || config.database !== 'sqlite' || !this.bridgeAdapter.hasDelegate) {
      return []
    }

    const dbPath = this._getDbPath(projectId, config.dbPath)
    return this.bridgeAdapter.listTables(dbPath)
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
    return this.bridgeAdapter.query(
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

      if (!this.bridgeAdapter.hasDelegate) {
        return { projectId, hasData: false, reason: 'No database delegate configured' }
      }

      const tables = this.bridgeAdapter.listTables(dbPath)
      for (const table of tables) {
        validateIdentifier(table)
        const countResult = this.bridgeAdapter.query(
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

  /**
   * List all databases across all projects.
   * Used by the settings "数据库管理" tab to display an overview.
   */
  async listAllDatabases (): Promise<DatabaseInfo[]> {
    const result: DatabaseInfo[] = []

    // Scan every project directory for .world-meta.json
    if (!existsSync(this.projectsDir)) return result

    const entries = await fs.readdir(this.projectsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const projectId = entry.name
      try {
        const config = await this._getDataConfig(projectId)
        if (!config) continue

        const metaPath = path.join(this.projectsDir, projectId, '.world-meta.json')
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>
        const projectName = (meta.name as string) || projectId

        const fullPath = this._getDbPath(projectId, config.dbPath)
        const info: DatabaseInfo = {
          projectId,
          projectName,
          database: config.database,
          dbPath: config.dbPath,
          fullPath,
          tables: []
        }

        // If we have a delegate and the db file exists, introspect
        if (config.database === 'sqlite' && this.bridgeAdapter.hasDelegate && existsSync(fullPath)) {
          try {
            const schema = this.bridgeAdapter.getSchema(fullPath)
            for (const table of schema) {
              const countResult = this.bridgeAdapter.query(fullPath, `SELECT COUNT(*) as count FROM "${validateIdentifier(table.name)}"`)
              info.tables.push({
                name: table.name,
                rowCount: (countResult[0]?.count as number) || 0,
                columns: table.columns.map(c => ({ name: c.name, type: c.type, primaryKey: c.primaryKey }))
              })
            }
          } catch { /* db might be locked or corrupted — skip */ }
        } else if (config.database === 'json') {
          // For JSON-based data, show the config tables from meta
          if (config.tables && Array.isArray(config.tables)) {
            for (const t of config.tables) {
              const tObj = t as Record<string, unknown>
              info.tables.push({
                name: (tObj.name as string) || 'unknown',
                rowCount: -1, // unknown for JSON
                columns: ((tObj.columns as Array<Record<string, unknown>>) || []).map(c => ({
                  name: (c.name as string) || '',
                  type: (c.type as string) || '',
                  primaryKey: !!(c.primaryKey)
                }))
              })
            }
          }
        }

        result.push(info)
      } catch { /* skip projects without valid config */ }
    }

    return result
  }

  /**
   * Query a specific table's data for the database viewer.
   */
  async queryTableForViewer (
    projectId: string,
    tableName: string,
    { page = 1, pageSize = 50 } = {}
  ): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    validateIdentifier(tableName)
    const config = await this._getDataConfig(projectId)
    if (!config) {
      throw new Error(`No data config for project: ${projectId}`)
    }

    if (config.database === 'sqlite' && this.bridgeAdapter.hasDelegate) {
      const dbPath = this._getDbPath(projectId, config.dbPath)
      const countResult = this.bridgeAdapter.query(dbPath, `SELECT COUNT(*) as count FROM "${tableName}"`)
      const total = (countResult[0]?.count as number) || 0
      const offset = (page - 1) * pageSize
      const rows = this.bridgeAdapter.query(dbPath, `SELECT * FROM "${tableName}" LIMIT ${Number(pageSize)} OFFSET ${Number(offset)}`)
      return { rows, total }
    }

    return { rows: [], total: 0 }
  }
}
