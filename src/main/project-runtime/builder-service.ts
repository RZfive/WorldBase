import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import crypto from 'node:crypto'
import { LAN_SERVER_PORT } from '../constants.js'
import { createBundledRuntimeEnv } from './bundled-runtime.js'
import { normalizeNextPackageJsonText } from './next-runtime-compat.js'

const NEXT_CONFIG_TEMPLATE = `/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone'
}

module.exports = nextConfig
`

const NEXT_ENV_TEMPLATE = `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited.
// See https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`

const NEXT_TS_CONFIG_TEMPLATE = {
  compilerOptions: {
    target: 'ES2017',
    lib: ['dom', 'dom.iterable', 'esnext'],
    allowJs: true,
    skipLibCheck: true,
    strict: false,
    noEmit: true,
    esModuleInterop: true,
    module: 'esnext',
    moduleResolution: 'bundler',
    resolveJsonModule: true,
    isolatedModules: true,
    jsx: 'preserve',
    incremental: true,
    plugins: [{ name: 'next' }]
  },
  include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '**/*.d.ts', '.next/types/**/*.ts'],
  exclude: ['node_modules']
}

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
    const isNextProject = await this._isNextProject(projectDir)

    if (isNextProject) {
      await this._normalizeNextProjectFiles(projectDir)
    }

    // Update build status in meta
    await this._updateBuildStatus(metaPath, 'building')

    const env = await createBundledRuntimeEnv(projectDir, {
      NODE_ENV: 'production',
      THE_WORLD_PROJECT_ID: projectId,
      THE_WORLD_PROJECT_ROOT: projectDir,
      THE_WORLD_LAN_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}`,
      THE_WORLD_RESOURCE_PROXY_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}/api/resource-proxy`,
      THE_WORLD_PROJECT_DATA_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}/api/projects/${projectId}/data`,
      NEXT_PUBLIC_THE_WORLD_LAN_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}`,
      NEXT_PUBLIC_THE_WORLD_RESOURCE_PROXY_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}/api/resource-proxy`,
      NEXT_PUBLIC_THE_WORLD_PROJECT_DATA_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}/api/projects/${projectId}/data`
    })

    return new Promise((resolve) => {
      const child = spawn('npm', ['run', 'build'], {
        cwd: projectDir,
        stdio: 'pipe',
        shell: true,
        env
      })

      let output = ''
      child.stdout?.on('data', (data: Buffer) => { output += data.toString() })
      child.stderr?.on('data', (data: Buffer) => { output += data.toString() })

      child.on('exit', async (code) => {
        const duration = Date.now() - startTime

        if (code === 0) {
          // Post-build: copy static assets for Next.js standalone mode
          await this._copyNextStaticAssets(projectDir)

          if (isNextProject && !this._hasStandaloneOutput(projectDir)) {
            await this._updateBuildStatus(metaPath, 'failed')
            resolve({
              success: false,
              buildStatus: 'failed',
              duration,
              error: 'Next.js build completed but did not generate .next/standalone/server.js. Ensure next.config.js sets output: \'standalone\'.',
              output
            })
            return
          }

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

    const cleanupResult = await this.cleanup(projectId)
    if (!cleanupResult.success) {
      return {
        success: false,
        buildStatus: 'failed',
        duration: 0,
        error: cleanupResult.error
      }
    }

    if (existsSync(packageJsonPath)) {
      await this._ensureNextRuntimeCompatiblePackageJson(projectDir)
      await this._installDeps(projectDir)
    }

    const result = await this.build(projectId)

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
    return this._hasStandaloneOutput(projectDir)
  }

  private _hasStandaloneOutput (projectDir: string): boolean {
    return existsSync(path.join(projectDir, '.next', 'standalone', 'server.js'))
  }

  private async _isNextProject (projectDir: string): Promise<boolean> {
    const packageJsonPath = path.join(projectDir, 'package.json')
    if (!existsSync(packageJsonPath)) {
      return false
    }

    try {
      const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8')) as Record<string, unknown>
      const deps: Record<string, string> = {
        ...((pkg.dependencies || {}) as Record<string, string>),
        ...((pkg.devDependencies || {}) as Record<string, string>)
      }
      return typeof deps.next === 'string'
    } catch {
      return false
    }
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

  private async _normalizeNextProjectFiles (projectDir: string): Promise<void> {
    await this._removeDuplicateScriptVariants(projectDir)
    await this._ensureNextRuntimeCompatiblePackageJson(projectDir)
    await this._ensureNextStandaloneConfig(projectDir)

    const hasTypeScriptSources = await this._hasTypeScriptSources(projectDir)
    if (!hasTypeScriptSources) {
      return
    }

    await this._ensureNextTypeScriptSupport(projectDir)
  }

  private async _removeDuplicateScriptVariants (projectDir: string): Promise<void> {
    const files = await this._getSourceFiles(projectDir, '')
    const groups = new Map<string, Set<string>>()

    for (const relativeFile of files) {
      if (relativeFile.endsWith('.d.ts')) {
        continue
      }

      const parsed = path.parse(relativeFile)
      if (!['.js', '.jsx', '.ts', '.tsx'].includes(parsed.ext)) {
        continue
      }

      const baseKey = parsed.dir ? path.join(parsed.dir, parsed.name) : parsed.name
      const variants = groups.get(baseKey) ?? new Set<string>()
      variants.add(parsed.ext)
      groups.set(baseKey, variants)
    }

    for (const [baseKey, variants] of groups) {
      const hasJsVariant = variants.has('.js') || variants.has('.jsx')
      if (!hasJsVariant) {
        continue
      }

      for (const staleExtension of ['.ts', '.tsx']) {
        if (!variants.has(staleExtension)) {
          continue
        }

        const staleFile = path.join(projectDir, `${baseKey}${staleExtension}`)
        if (existsSync(staleFile)) {
          await fs.rm(staleFile, { force: true })
        }
      }
    }
  }

  private async _ensureNextStandaloneConfig (projectDir: string): Promise<void> {
    const nextConfigCandidates = [
      'next.config.js',
      'next.config.mjs',
      'next.config.cjs',
      'next.config.ts'
    ]

    const hasExistingConfig = nextConfigCandidates.some(file => existsSync(path.join(projectDir, file)))
    if (!hasExistingConfig) {
      await fs.writeFile(path.join(projectDir, 'next.config.js'), NEXT_CONFIG_TEMPLATE, 'utf-8')
    }
  }

  private async _ensureNextRuntimeCompatiblePackageJson (projectDir: string): Promise<void> {
    const packageJsonPath = path.join(projectDir, 'package.json')
    if (!existsSync(packageJsonPath)) {
      return
    }

    try {
      const raw = await fs.readFile(packageJsonPath, 'utf-8')
      const normalized = normalizeNextPackageJsonText(raw)
      if (normalized.changed) {
        await fs.writeFile(packageJsonPath, normalized.packageJsonText, 'utf-8')
      }
    } catch {
      // Leave user-provided package.json untouched if it isn't valid JSON.
    }
  }

  private async _hasTypeScriptSources (projectDir: string): Promise<boolean> {
    const files = await this._getSourceFiles(projectDir, '')
    return files.some(file => file.endsWith('.ts') || file.endsWith('.tsx'))
  }

  private async _ensureNextTypeScriptSupport (projectDir: string): Promise<void> {
    const nextEnvPath = path.join(projectDir, 'next-env.d.ts')
    if (!existsSync(nextEnvPath)) {
      await fs.writeFile(nextEnvPath, NEXT_ENV_TEMPLATE, 'utf-8')
    }

    const tsconfigPath = path.join(projectDir, 'tsconfig.json')
    if (!existsSync(tsconfigPath)) {
      await fs.writeFile(tsconfigPath, JSON.stringify(NEXT_TS_CONFIG_TEMPLATE, null, 2), 'utf-8')
      return
    }

    try {
      const raw = await fs.readFile(tsconfigPath, 'utf-8')
      const tsconfig = JSON.parse(raw) as {
        include?: string[]
        compilerOptions?: Record<string, unknown>
      }

      const include = Array.isArray(tsconfig.include) ? [...tsconfig.include] : []
      if (!include.includes('next-env.d.ts')) {
        include.unshift('next-env.d.ts')
      }
      if (!include.includes('**/*.d.ts')) {
        include.push('**/*.d.ts')
      }

      tsconfig.include = include
      tsconfig.compilerOptions = {
        allowJs: true,
        jsx: 'preserve',
        ...(tsconfig.compilerOptions || {})
      }

      await fs.writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2), 'utf-8')
    } catch {
      // Leave user-provided tsconfig untouched if it isn't valid JSON.
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
    return createBundledRuntimeEnv(cwd).then(env => new Promise((resolve, reject) => {
      const child = spawn('npm', ['install'], {
        cwd,
        stdio: 'pipe',
        shell: true,
        env
      })

      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`npm install failed with code ${code}`))
      })

      child.on('error', reject)
    }))
  }
}
