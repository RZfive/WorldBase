import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

/**
 * SafeWriter — 安全文件写入（先备份再写，支持回滚）
 */
export class SafeWriter {
  private snapshotsDir: string
  private backupDir: string

  constructor (snapshotsDir: string) {
    this.snapshotsDir = snapshotsDir
    this.backupDir = path.join(snapshotsDir, '_backups')

    if (!existsSync(this.backupDir)) {
      mkdirSync(this.backupDir, { recursive: true })
    }
  }

  private _createBackupPath (filePath: string): string {
    const resolvedPath = path.resolve(filePath)
    const digest = createHash('sha1').update(resolvedPath).digest('hex').slice(0, 12)
    const backupName = `${path.basename(filePath)}.${digest}.${Date.now()}.bak`
    return path.join(this.backupDir, backupName)
  }

  /**
   * Safely write content to a file.
   * If the file exists, creates a backup first.
   */
  async safeWrite (filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
    const hadExistingFile = existsSync(filePath)
    const backupPath = hadExistingFile ? this._createBackupPath(filePath) : null

    try {
      if (backupPath) {
        await fs.copyFile(filePath, backupPath)
      }

      await fs.writeFile(tempPath, content, 'utf-8')

      try {
        await fs.rename(tempPath, filePath)
      } catch (renameError) {
        if (!hadExistingFile) {
          throw renameError
        }

        await fs.rm(filePath, { force: true })
        await fs.rename(tempPath, filePath)
      }
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {})

      if (backupPath && !existsSync(filePath) && existsSync(backupPath)) {
        await fs.copyFile(backupPath, filePath).catch(() => {})
      }

      throw error
    }
  }
}
