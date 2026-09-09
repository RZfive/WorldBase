import { DatabaseSync } from 'node:sqlite'

/**
 * Small synchronous SQLite surface shared by Electron's main-process stores.
 *
 * Node 22+ ships SQLite in the runtime, so application code does not need a
 * native npm driver (which otherwise has to be rebuilt for Electron's ABI).
 * The wrapper deliberately mirrors only the synchronous methods used by the
 * existing stores, keeping their query and transaction code unchanged.
 */
export interface SqliteStatement {
  run (...params: unknown[]): { changes: number, lastInsertRowid?: number | bigint }
  all (...params: unknown[]): Array<Record<string, unknown>>
  get (...params: unknown[]): Record<string, unknown> | undefined
}

export interface SqliteDatabase {
  prepare (sql: string): SqliteStatement
  exec (sql: string): void
  transaction<T> (fn: (...args: any[]) => T): (...args: any[]) => T
  close (): void
}

function invokeStatement<T> (method: (...args: any[]) => T, params: unknown[]): T {
  return method(...params)
}

/** Open a database using the SQLite library bundled with Node/Electron. */
export function openSqliteDatabase (dbPath: string): SqliteDatabase {
  const database = new DatabaseSync(dbPath, {
    timeout: 5000,
    allowBareNamedParameters: true,
    // Preserve the permissive defaults used by the previous SQLite driver.
    // MemoryStore enables foreign keys explicitly in its initialization SQL.
    enableForeignKeyConstraints: false,
    enableDoubleQuotedStringLiterals: true
  })
  let transactionDepth = 0
  let savepointCounter = 0

  return {
    prepare (sql: string): SqliteStatement {
      const statement = database.prepare(sql)
      return {
        run: (...params) => invokeStatement(statement.run.bind(statement), params) as { changes: number, lastInsertRowid?: number | bigint },
        all: (...params) => invokeStatement(statement.all.bind(statement), params) as Array<Record<string, unknown>>,
        get: (...params) => invokeStatement(statement.get.bind(statement), params) as Record<string, unknown> | undefined
      }
    },
    exec (sql: string): void {
      database.exec(sql)
    },
    transaction<T> (fn: (...args: any[]) => T): (...args: any[]) => T {
      return (...args: any[]) => {
        const savepoint = `worldbase_tx_${++savepointCounter}`
        const nested = transactionDepth > 0
        if (nested) database.exec(`SAVEPOINT ${savepoint}`)
        else database.exec('BEGIN')
        transactionDepth += 1

        try {
          const result = fn(...args)
          transactionDepth -= 1
          if (nested) database.exec(`RELEASE SAVEPOINT ${savepoint}`)
          else database.exec('COMMIT')
          return result
        } catch (error) {
          transactionDepth -= 1
          try {
            if (nested) {
              database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
              database.exec(`RELEASE SAVEPOINT ${savepoint}`)
            } else {
              database.exec('ROLLBACK')
            }
          } catch {
            // Preserve the original query error if rollback itself fails.
          }
          throw error
        }
      }
    },
    close (): void {
      database.close()
    }
  }
}
