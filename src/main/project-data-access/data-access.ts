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
  tables?: SchemaTable[]
  [key: string]: unknown
}

interface SchemaColumn {
  name: string
  type: string
  primaryKey?: boolean
  notNull?: boolean
  unique?: boolean
  autoIncrement?: boolean
  defaultValue?: unknown
  defaultSql?: string
}

interface SchemaTable {
  name: string
  columns?: SchemaColumn[]
  description?: string
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

interface ReadRecordsOptions {
  filters?: Record<string, unknown>
  limit?: number
  offset?: number
  orderBy?: string
  orderDirection?: 'asc' | 'desc'
  columns?: string[]
}

interface SaveRecordsOptions {
  mode?: 'insert' | 'upsert'
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

function toSqlLiteral (value: unknown): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  return `'${String(value).replace(/'/g, "''")}'`
}

function toSafeDefaultSql (value: string): string {
  const normalized = value.trim().toUpperCase()
  const allowedExpressions = new Set(['CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'NULL'])
  if (!allowedExpressions.has(normalized)) {
    throw new Error(`Unsupported defaultSql expression: ${value}`)
  }
  return normalized
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

  private _getProjectRoot (projectId: string): string {
    const projectsRoot = path.resolve(this.projectsDir)
    const projectRoot = path.resolve(projectsRoot, projectId)
    const relative = path.relative(projectsRoot, projectRoot)

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Invalid project path: ${projectId}`)
    }

    return projectRoot
  }

  private _resolveProjectPath (projectId: string, relativePath = ''): string {
    const projectRoot = this._getProjectRoot(projectId)
    const resolved = path.resolve(projectRoot, relativePath)
    const relative = path.relative(projectRoot, resolved)

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Invalid project-relative path: ${relativePath}`)
    }

    return resolved
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
    const metaPath = this._resolveProjectPath(projectId, '.world-meta.json')
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
    return this._resolveProjectPath(projectId, dbRelativePath)
  }

  private async _getSqliteConfig (projectId: string): Promise<DataConfig> {
    const config = await this._getDataConfig(projectId)
    if (!config) {
      throw new Error(`Project ${projectId} does not declare a dataSchema`)
    }
    if (config.database !== 'sqlite') {
      throw new Error(`Project ${projectId} does not have SQLite configured`)
    }
    return config
  }

  private _getTableConfig (config: DataConfig, tableName: string): SchemaTable {
    const table = config.tables?.find(item => item.name === tableName)
    if (!table) {
      throw new Error(`Table ${tableName} is not declared in the project's dataSchema`)
    }
    if (!table.columns || table.columns.length === 0) {
      throw new Error(`Table ${tableName} is declared without any columns`)
    }
    return table
  }

  private _getAllowedColumns (table: SchemaTable): Map<string, SchemaColumn> {
    return new Map((table.columns || []).map(column => [column.name, column]))
  }

  private _buildColumnDefinition (column: SchemaColumn, useInlinePrimaryKey: boolean): string {
    const parts = [`"${validateIdentifier(column.name)}"`, column.type || 'TEXT']
    const isInlinePrimaryKey = useInlinePrimaryKey && column.primaryKey
    if (isInlinePrimaryKey) {
      parts.push('PRIMARY KEY')
      if (column.autoIncrement) {
        parts.push('AUTOINCREMENT')
      }
    }
    if (column.notNull) {
      parts.push('NOT NULL')
    }
    if (column.unique) {
      parts.push('UNIQUE')
    }
    if (column.defaultSql) {
      parts.push(`DEFAULT ${toSafeDefaultSql(column.defaultSql)}`)
    } else if (column.defaultValue !== undefined) {
      parts.push(`DEFAULT ${toSqlLiteral(column.defaultValue)}`)
    }
    return parts.join(' ')
  }

  async ensureProjectDatabase (projectId: string): Promise<{ dbPath: string, createdTables: string[] }> {
    const config = await this._getSqliteConfig(projectId)
    const dbPath = this._getDbPath(projectId, config.dbPath)
    await fs.mkdir(path.dirname(dbPath), { recursive: true })

    const tables = config.tables || []
    try {
      for (const table of tables) {
        const tableName = validateIdentifier(table.name)
        const columns = table.columns || []
        if (columns.length === 0) {
          throw new Error(`Table schema has no columns: ${tableName}`)
        }

        const primaryKeys = columns
          .filter(column => column.primaryKey)
          .map(column => validateIdentifier(column.name))

        const useInlinePrimaryKey = primaryKeys.length <= 1
        const sqlParts = columns.map(column => this._buildColumnDefinition(column, useInlinePrimaryKey))

        if (!useInlinePrimaryKey && primaryKeys.length > 0) {
          sqlParts.push(`PRIMARY KEY (${primaryKeys.map(name => `"${name}"`).join(', ')})`)
        }

        this.bridgeAdapter.execute(
          dbPath,
          `CREATE TABLE IF NOT EXISTS "${tableName}" (${sqlParts.join(', ')})`
        )
      }
    } finally {
      this.bridgeAdapter.close(dbPath)
    }

    return {
      dbPath,
      createdTables: tables.map(table => table.name)
    }
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

    const config = await this._getSqliteConfig(projectId)
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
    const config = await this._getSqliteConfig(projectId)
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
    const fullPath = this._resolveProjectPath(projectId, relativePath)
    return this.jsonAdapter.read(fullPath)
  }

  /**
   * Run an analysis on a project's data.
   */
  async analyzeData (projectId: string, analysisType: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.analyzer.analyze(this, projectId, analysisType, options)
  }

  async readRecords (projectId: string, tableName: string, options: ReadRecordsOptions = {}): Promise<Record<string, unknown>[]> {
    const config = await this._getSqliteConfig(projectId)
    await this.ensureProjectDatabase(projectId)

    const validatedTableName = validateIdentifier(tableName)
    const table = this._getTableConfig(config, validatedTableName)
    const allowedColumns = this._getAllowedColumns(table)
    const selectedColumns = options.columns?.length
      ? options.columns.map(column => {
          const validated = validateIdentifier(column)
          if (!allowedColumns.has(validated)) {
            throw new Error(`Column ${validated} is not declared in schema for table ${validatedTableName}`)
          }
          return `"${validated}"`
        })
      : ['*']

    const filters = options.filters || {}
    const whereParts: string[] = []
    const params: unknown[] = []

    for (const [column, value] of Object.entries(filters)) {
      const validatedColumn = validateIdentifier(column)
      if (!allowedColumns.has(validatedColumn)) {
        throw new Error(`Column ${validatedColumn} is not declared in schema for table ${validatedTableName}`)
      }
      if (value === null) {
        whereParts.push(`"${validatedColumn}" IS NULL`)
      } else {
        whereParts.push(`"${validatedColumn}" = ?`)
        params.push(value)
      }
    }

    let sql = `SELECT ${selectedColumns.join(', ')} FROM "${validatedTableName}"`
    if (whereParts.length > 0) {
      sql += ` WHERE ${whereParts.join(' AND ')}`
    }

    if (options.orderBy) {
      const orderBy = validateIdentifier(options.orderBy)
      if (!allowedColumns.has(orderBy)) {
        throw new Error(`Column ${orderBy} is not declared in schema for table ${validatedTableName}`)
      }
      const direction = options.orderDirection?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
      sql += ` ORDER BY "${orderBy}" ${direction}`
    }

    if (options.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(Math.max(1, Math.min(1000, Number(options.limit) || 1)))
    }

    if (options.offset !== undefined) {
      sql += ' OFFSET ?'
      params.push(Math.max(0, Number(options.offset) || 0))
    }

    const dbPath = this._getDbPath(projectId, config.dbPath)
    return this.bridgeAdapter.query(dbPath, sql, params)
  }

  async saveRecords (
    projectId: string,
    tableName: string,
    recordsInput: Array<Record<string, unknown>> | Record<string, unknown>,
    options: SaveRecordsOptions = {}
  ): Promise<{ table: string, count: number, mode: 'insert' | 'upsert' }> {
    const config = await this._getSqliteConfig(projectId)
    await this.ensureProjectDatabase(projectId)

    const validatedTableName = validateIdentifier(tableName)
    const table = this._getTableConfig(config, validatedTableName)
    const allowedColumns = this._getAllowedColumns(table)
    const primaryKeys = (table.columns || [])
      .filter(column => column.primaryKey)
      .map(column => validateIdentifier(column.name))

    const records = Array.isArray(recordsInput) ? recordsInput : [recordsInput]
    if (records.length === 0) {
      return { table: validatedTableName, count: 0, mode: options.mode || 'upsert' }
    }

    const dbPath = this._getDbPath(projectId, config.dbPath)
    let savedCount = 0

    try {
      for (const record of records) {
        const entries = Object.entries(record)
          .filter(([, value]) => value !== undefined)
          .map(([column, value]) => {
            const validatedColumn = validateIdentifier(column)
            if (!allowedColumns.has(validatedColumn)) {
              throw new Error(`Column ${validatedColumn} is not declared in schema for table ${validatedTableName}`)
            }
            return [validatedColumn, value] as const
          })

        if (entries.length === 0) {
          throw new Error(`Record for table ${validatedTableName} has no writable fields`)
        }

        const columns = entries.map(([column]) => column)
        const placeholders = columns.map(() => '?').join(', ')
        const values = entries.map(([, value]) => value)
        const mode = options.mode || 'upsert'
        let sql = `INSERT INTO "${validatedTableName}" (${columns.map(column => `"${column}"`).join(', ')}) VALUES (${placeholders})`

        if (mode === 'upsert' && primaryKeys.length > 0 && primaryKeys.every(primaryKey => columns.includes(primaryKey))) {
          const updatableColumns = columns.filter(column => !primaryKeys.includes(column))
          if (updatableColumns.length > 0) {
            sql += ` ON CONFLICT (${primaryKeys.map(column => `"${column}"`).join(', ')}) DO UPDATE SET ${updatableColumns.map(column => `"${column}" = excluded."${column}"`).join(', ')}`
          } else {
            sql += ` ON CONFLICT (${primaryKeys.map(column => `"${column}"`).join(', ')}) DO NOTHING`
          }
        }

        this.bridgeAdapter.execute(dbPath, sql, values)
        savedCount += 1
      }
    } finally {
      this.bridgeAdapter.close(dbPath)
    }

    return {
      table: validatedTableName,
      count: savedCount,
      mode: options.mode || 'upsert'
    }
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
              info.tables.push({
                name: t.name || 'unknown',
                rowCount: -1, // unknown for JSON
                columns: (t.columns || []).map(c => ({
                  name: c.name || '',
                  type: c.type || '',
                  primaryKey: !!c.primaryKey
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
