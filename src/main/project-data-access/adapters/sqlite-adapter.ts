import { existsSync } from 'node:fs'

interface SqliteDatabase {
  prepare(sql: string): { all(): Record<string, unknown>[] }
  close(): void
}

interface TableColumn {
  name: string
  type: string
  notNull: boolean
  primaryKey: boolean
  defaultValue: unknown
}

interface TableSchema {
  name: string
  columns: TableColumn[]
}

/**
 * SqliteAdapter — SQLite 数据库适配器
 * 使用 better-sqlite3 进行同步只读查询
 *
 * Note: better-sqlite3 is a native module that must be installed.
 * In development, it will be available. In production, it's bundled with Electron.
 */
export class SqliteAdapter {
  private _connections = new Map<string, SqliteDatabase>()

  /**
   * Get or create a read-only database connection.
   */
  _getDb (dbPath: string): SqliteDatabase {
    if (!existsSync(dbPath)) {
      throw new Error(`Database file not found: ${dbPath}`)
    }

    if (this._connections.has(dbPath)) {
      return this._connections.get(dbPath)!
    }

    // Dynamic import to avoid bundling issues in renderer
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(dbPath, { readonly: true }) as SqliteDatabase
    this._connections.set(dbPath, db)
    return db
  }

  /**
   * Execute a read-only query and return all rows.
   */
  query (dbPath: string, sql: string): Record<string, unknown>[] {
    const db = this._getDb(dbPath)
    const stmt = db.prepare(sql)
    return stmt.all() as Record<string, unknown>[]
  }

  /**
   * List all tables in the database.
   */
  listTables (dbPath: string): string[] {
    const rows = this.query(
      dbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    return rows.map(r => r.name as string)
  }

  /**
   * Get schema information for all tables.
   */
  getSchema (dbPath: string): TableSchema[] {
    const tables = this.listTables(dbPath)
    const schema: TableSchema[] = []

    for (const tableName of tables) {
      const columns = this.query(dbPath, `PRAGMA table_info("${tableName}")`)
      schema.push({
        name: tableName,
        columns: columns.map(col => ({
          name: col.name as string,
          type: col.type as string,
          notNull: col.notnull === 1,
          primaryKey: col.pk === 1,
          defaultValue: col.dflt_value
        }))
      })
    }

    return schema
  }

  /**
   * Close a specific database connection.
   */
  close (dbPath: string): void {
    const db = this._connections.get(dbPath)
    if (db) {
      db.close()
      this._connections.delete(dbPath)
    }
  }

  /**
   * Close all database connections.
   */
  closeAll (): void {
    for (const [, db] of this._connections) {
      db.close()
    }
    this._connections.clear()
  }
}
