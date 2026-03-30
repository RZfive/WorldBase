import fs from 'node:fs/promises'
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

  /**
   * Safely write content to a file.
   * If the file exists, creates a backup first.
   */
  async safeWrite (filePath: string, content: string): Promise<void> {
    // Backup existing file if it exists
    if (existsSync(filePath)) {
      const backupName = `${path.basename(filePath)}.${Date.now()}.bak`
      const backupPath = path.join(this.backupDir, backupName)
      await fs.copyFile(filePath, backupPath)
    }

    // Write the new content
    const dir = path.dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    await fs.writeFile(filePath, content, 'utf-8')
  }
}
