import { existsSync } from 'node:fs'

/**
 * SqliteAdapter — SQLite 数据库适配器
 * 使用 better-sqlite3 进行同步只读查询
 *
 * Note: better-sqlite3 is a native module that must be installed.
 * In development, it will be available. In production, it's bundled with Electron.
 */
export class SqliteAdapter {
  constructor () {
    /** @type {Map<string, import('better-sqlite3').Database>} */
    this._connections = new Map()
  }

  /**
   * Get or create a read-only database connection.
   */
  _getDb (dbPath) {
    if (!existsSync(dbPath)) {
      throw new Error(`Database file not found: ${dbPath}`)
    }

    if (this._connections.has(dbPath)) {
      return this._connections.get(dbPath)
    }

    // Dynamic import to avoid bundling issues in renderer
    // eslint-disable-next-line
    const Database = require('better-sqlite3')
    const db = new Database(dbPath, { readonly: true })
    this._connections.set(dbPath, db)
    return db
  }

  /**
   * Execute a read-only query and return all rows.
   */
  query (dbPath, sql) {
    const db = this._getDb(dbPath)
    const stmt = db.prepare(sql)
    return stmt.all()
  }

  /**
   * List all tables in the database.
   */
  listTables (dbPath) {
    const rows = this.query(
      dbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    return rows.map(r => r.name)
  }

  /**
   * Get schema information for all tables.
   */
  getSchema (dbPath) {
    const tables = this.listTables(dbPath)
    const schema = []

    for (const tableName of tables) {
      const columns = this.query(dbPath, `PRAGMA table_info("${tableName}")`)
      schema.push({
        name: tableName,
        columns: columns.map(col => ({
          name: col.name,
          type: col.type,
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
  close (dbPath) {
    const db = this._connections.get(dbPath)
    if (db) {
      db.close()
      this._connections.delete(dbPath)
    }
  }

  /**
   * Close all database connections.
   */
  closeAll () {
    for (const [, db] of this._connections) {
      db.close()
    }
    this._connections.clear()
  }
}
