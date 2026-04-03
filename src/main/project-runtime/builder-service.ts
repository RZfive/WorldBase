import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import crypto from 'node:crypto'

export type BuildStatus = 'none' | 'building' | 'built' | 'failed'

export interface BuildResult {
  success: boolean
  buildStatus: BuildStatus
  duration: number
  error?: string
  output?: string
}

export interface CleanupResult {
  success: boolean
  freedBytes?: number
  error?: string
}

/**
 * BuilderService — 编译服务
 * 负责在 npm install 之后、启动之前执行编译步骤
 * 主要用于 Next.js standalone 模式的项目构建
 */
export class BuilderService {
  private projectsDir: string

  constructor (projectsDir: string) {
    this.projectsDir = projectsDir
  }

  /**
   * Build a project (npm run build).
   * For Next.js projects this produces .next/standalone/.
   */
  async build (projectId: string): Promise<BuildResult> {
    const projectDir = path.join(this.projectsDir, projectId)
    const metaPath = path.join(projectDir, '.world-meta.json')
    const startTime = Date.now()

    // Update build status in meta
    await this._updateBuildStatus(metaPath, 'building')

    return new Promise((resolve) => {
      const child = spawn('npm', ['run', 'build'], {
        cwd: projectDir,
        stdio: 'pipe',
        shell: true,
        env: {
          ...process.env,
          NODE_ENV: 'production'
        }
      })

      let output = ''
      child.stdout?.on('data', (data: Buffer) => { output += data.toString() })
      child.stderr?.on('data', (data: Buffer) => { output += data.toString() })

      child.on('exit', async (code) => {
        const duration = Date.now() - startTime

        if (code === 0) {
          // Post-build: copy static assets for Next.js standalone mode
          await this._copyNextStaticAssets(projectDir)

          const buildHash = await this._computeSourceHash(projectDir)
          await this._updateBuildMeta(metaPath, 'built', buildHash)
          resolve({ success: true, buildStatus: 'built', duration, output })
        } else {
          await this._updateBuildStatus(metaPath, 'failed')
          resolve({
            success: false,
            buildStatus: 'failed',
            duration,
            error: `Build failed with exit code ${code}`,
            output
          })
        }
      })

      child.on('error', async (err) => {
        const duration = Date.now() - startTime
        await this._updateBuildStatus(metaPath, 'failed')
        resolve({
          success: false,
          buildStatus: 'failed',
          duration,
          error: err.message
        })
      })
    })
  }

  /**
   * Cleanup after build — remove node_modules and build cache
   * to reduce disk usage. Only keep .next/standalone/, source, and public/.
   */
  async cleanup (projectId: string): Promise<CleanupResult> {
    const projectDir = path.join(this.projectsDir, projectId)

    try {
      let freedBytes = 0

      // Remove node_modules
      const nodeModulesPath = path.join(projectDir, 'node_modules')
      if (existsSync(nodeModulesPath)) {
        const size = await this._getDirSize(nodeModulesPath)
        await fs.rm(nodeModulesPath, { recursive: true, force: true })
        freedBytes += size
      }

      // Remove .next/cache
      const nextCachePath = path.join(projectDir, '.next', 'cache')
      if (existsSync(nextCachePath)) {
        const size = await this._getDirSize(nextCachePath)
        await fs.rm(nextCachePath, { recursive: true, force: true })
        freedBytes += size
      }

      return { success: true, freedBytes }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  /**
   * Check if a project needs to be rebuilt by comparing source hash.
   */
  async needsRebuild (projectId: string): Promise<boolean> {
    const projectDir = path.join(this.projectsDir, projectId)
    const metaPath = path.join(projectDir, '.world-meta.json')

    if (!existsSync(metaPath)) return true

    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>
      const previousHash = meta.buildHash as string | undefined
      if (!previousHash) return true

      // Check if standalone build output exists
      const standalonePath = path.join(projectDir, '.next', 'standalone', 'server.js')
      if (!existsSync(standalonePath)) return true

      const currentHash = await this._computeSourceHash(projectDir)
      return currentHash !== previousHash
    } catch {
      return true
    }
  }

  /**
   * Full rebuild: install deps → build → cleanup.
   * Used when source files have been modified.
   */
  async rebuild (projectId: string): Promise<BuildResult> {
    const projectDir = path.join(this.projectsDir, projectId)
    const packageJsonPath = path.join(projectDir, 'package.json')

    // Re-install dependencies if needed
    if (existsSync(packageJsonPath) && !existsSync(path.join(projectDir, 'node_modules'))) {
      await this._installDeps(projectDir)
    }

    // Build
    const result = await this.build(projectId)

    // Cleanup if build succeeded
    if (result.success) {
      await this.cleanup(projectId)
    }

    return result
  }

  /**
   * Check if a project has a valid standalone build.
   */
  hasStandaloneBuild (projectId: string): boolean {
    const projectDir = path.join(this.projectsDir, projectId)
    const standalonePath = path.join(projectDir, '.next', 'standalone', 'server.js')
    return existsSync(standalonePath)
  }

  /**
   * Copy static assets into the standalone output directory.
   * Next.js standalone mode requires public/ and .next/static/ to be placed
   * alongside the standalone output.
   */
  private async _copyNextStaticAssets (projectDir: string): Promise<void> {
    const standalonePath = path.join(projectDir, '.next', 'standalone')
    if (!existsSync(standalonePath)) return

    // Copy public/ → .next/standalone/public/
    const publicSrc = path.join(projectDir, 'public')
    const publicDest = path.join(standalonePath, 'public')
    if (existsSync(publicSrc) && !existsSync(publicDest)) {
      await fs.cp(publicSrc, publicDest, { recursive: true })
    }

    // Copy .next/static/ → .next/standalone/.next/static/
    const staticSrc = path.join(projectDir, '.next', 'static')
    const staticDest = path.join(standalonePath, '.next', 'static')
    if (existsSync(staticSrc) && !existsSync(staticDest)) {
      await fs.mkdir(path.join(standalonePath, '.next'), { recursive: true })
      await fs.cp(staticSrc, staticDest, { recursive: true })
    }
  }

  /**
   * Compute a hash of source files to detect changes.
   * Hashes all non-generated files (excludes node_modules, .next, etc.)
   */
  private async _computeSourceHash (projectDir: string): Promise<string> {
    const hash = crypto.createHash('sha256')
    const files = await this._getSourceFiles(projectDir, '')

    for (const file of files.sort()) {
      try {
        const content = await fs.readFile(path.join(projectDir, file), 'utf-8')
        hash.update(file + ':' + content)
      } catch {
        // Skip unreadable files
      }
    }

    return hash.digest('hex').substring(0, 16)
  }

  /**
   * Get all source files for hashing (excludes build artifacts).
   */
  private async _getSourceFiles (baseDir: string, relativePath: string): Promise<string[]> {
    const fullPath = path.join(baseDir, relativePath)
    const entries = await fs.readdir(fullPath, { withFileTypes: true })
    let files: string[] = []

    const skipDirs = new Set(['node_modules', '.next', '.git', 'dist', 'build'])

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.world-meta.json') continue
      if (skipDirs.has(entry.name)) continue

      const entryPath = path.join(relativePath, entry.name)
      if (entry.isDirectory()) {
        const subFiles = await this._getSourceFiles(baseDir, entryPath)
        files = files.concat(subFiles)
      } else {
        files.push(entryPath)
      }
    }
    return files
  }

  /**
   * Get approximate directory size in bytes.
   */
  private async _getDirSize (dirPath: string): Promise<number> {
    let totalSize = 0
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          totalSize += await this._getDirSize(entryPath)
        } else {
          const stat = await fs.stat(entryPath)
          totalSize += stat.size
        }
      }
    } catch {
      // Skip unreadable directories
    }
    return totalSize
  }

  /**
   * Update the buildStatus field in meta.
   */
  private async _updateBuildStatus (metaPath: string, status: BuildStatus): Promise<void> {
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>
      meta.buildStatus = status
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
    } catch {
      // Best effort
    }
  }

  /**
   * Update build metadata (status, hash, timestamp).
   */
  private async _updateBuildMeta (metaPath: string, status: BuildStatus, buildHash: string): Promise<void> {
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>
      meta.buildStatus = status
      meta.buildHash = buildHash
      meta.lastBuildAt = new Date().toISOString()
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
    } catch {
      // Best effort
    }
  }

  /**
   * Install npm dependencies.
   */
  private _installDeps (cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('npm', ['install'], {
        cwd,
        stdio: 'pipe',
        shell: true
      })

      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`npm install failed with code ${code}`))
      })

      child.on('error', reject)
    })
  }
}
