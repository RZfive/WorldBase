import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import crypto from 'node:crypto'
import { LAN_SERVER_PORT } from '../constants.js'
import { createBundledRuntimeEnv } from './bundled-runtime.js'
import { ensureNextRuntimeCompatiblePackageJson } from './next-runtime-compat.js'
import type { ProjectFailurePhase, ProjectFailureSnapshot, RuntimeManager } from './runtime-manager.js'

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
  runtimeStatus?: string
  port?: number
  pid?: number
  startupLogs?: string[]
}

export interface CleanupResult {
  success: boolean
  freedBytes?: number
  error?: string
}

export interface CleanupOptions {
  removeNodeModules?: boolean
  removeBuildCache?: boolean
}

export interface RebuildOptions {
  cleanInstall?: boolean
  cleanupDependenciesAfterSuccess?: boolean
  cleanupBuildCacheAfterSuccess?: boolean
}

interface CommandExecutionResult {
  code: number | null
  output: string
}

const BUILD_FAILURE_EXCERPT_LINES = 12

/**
 * BuilderService — 编译服务
 * 负责在 npm install 之后、启动之前执行编译步骤
 * 主要用于 Next.js standalone 模式的项目构建
 */
export class BuilderService {
  private projectsDir: string
  private runtimeManager: Pick<RuntimeManager, 'getStatus' | 'getLogs' | 'start' | 'stop'> | null = null
  private lastBuildFailures = new Map<string, ProjectFailureSnapshot>()

  constructor (projectsDir: string) {
    this.projectsDir = projectsDir
  }

  setRuntimeManager (runtimeManager: Pick<RuntimeManager, 'getStatus' | 'getLogs' | 'start' | 'stop'>): void {
    this.runtimeManager = runtimeManager
  }

  /**
   * Build a project (npm run build).
   * For Next.js projects this produces .next/standalone/.
   */
  async build (projectId: string): Promise<BuildResult> {
    const projectDir = this._resolveProjectDir(projectId)
    const metaPath = path.join(projectDir, '.world-meta.json')
    const startTime = Date.now()
    const isNextProject = await this._isNextProject(projectDir)

    this.lastBuildFailures.delete(projectId)

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
      THE_WORLD_SYSTEM_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}/api/system`,
      NEXT_PUBLIC_THE_WORLD_LAN_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}`,
      NEXT_PUBLIC_THE_WORLD_RESOURCE_PROXY_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}/api/resource-proxy`,
      NEXT_PUBLIC_THE_WORLD_PROJECT_DATA_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}/api/projects/${projectId}/data`,
      NEXT_PUBLIC_THE_WORLD_SYSTEM_BASE_URL: `http://127.0.0.1:${LAN_SERVER_PORT}/api/system`
    })

    try {
      const { code, output } = await this._runBuildCommand(projectId, projectDir, env, isNextProject)
      const duration = Date.now() - startTime

      if (code === 0) {
        // Post-build: copy static assets for Next.js standalone mode
        await this._copyNextStaticAssets(projectDir)

        if (isNextProject && !this._hasStandaloneOutput(projectDir)) {
          await this._updateBuildStatus(metaPath, 'failed')
          this._recordBuildFailure(projectId, {
            phase: 'standalone_output_missing',
            summary: 'Next.js build completed but standalone output is missing',
            error: 'Next.js build completed but did not generate .next/standalone/server.js. Ensure next.config.js sets output: \'standalone\'.',
            output
          })
          return {
            success: false,
            buildStatus: 'failed',
            duration,
            error: 'Next.js build completed but did not generate .next/standalone/server.js. Ensure next.config.js sets output: \'standalone\'.',
            output
          }
        }

        const buildHash = await this._computeSourceHash(projectDir)
        await this._updateBuildMeta(metaPath, 'built', buildHash)
        return { success: true, buildStatus: 'built', duration, output }
      }

      await this._updateBuildStatus(metaPath, 'failed')
      this._recordBuildFailure(projectId, {
        phase: 'build_failed',
        summary: `Build failed with exit code ${code}`,
        error: `Build failed with exit code ${code}`,
        output
      })
      return {
        success: false,
        buildStatus: 'failed',
        duration,
        error: `Build failed with exit code ${code}`,
        output
      }
    } catch (err) {
      const duration = Date.now() - startTime
      await this._updateBuildStatus(metaPath, 'failed')
      this._recordBuildFailure(projectId, {
        phase: 'build_failed',
        summary: `Build failed: ${(err as Error).message}`,
        error: (err as Error).message
      })
      return {
        success: false,
        buildStatus: 'failed',
        duration,
        error: (err as Error).message
      }
    }
  }

  /**
   * Cleanup after build — remove node_modules and build cache
   * to reduce disk usage. Only keep .next/standalone/, source, and public/.
   */
  async cleanup (projectId: string, options: CleanupOptions = {}): Promise<CleanupResult> {
    const projectDir = path.join(this.projectsDir, projectId)
    const removeNodeModules = options.removeNodeModules !== false
    const removeBuildCache = options.removeBuildCache !== false

    try {
      let freedBytes = 0

      // Remove node_modules
      const nodeModulesPath = path.join(projectDir, 'node_modules')
      if (removeNodeModules && existsSync(nodeModulesPath)) {
        const size = await this._getDirSize(nodeModulesPath)
        await fs.rm(nodeModulesPath, { recursive: true, force: true })
        freedBytes += size
      }

      // Remove .next/cache
      const nextCachePath = path.join(projectDir, '.next', 'cache')
      if (removeBuildCache && existsSync(nextCachePath)) {
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
  async rebuild (projectId: string, options: RebuildOptions = {}): Promise<BuildResult> {
    const projectDir = path.join(this.projectsDir, projectId)
    const packageJsonPath = path.join(projectDir, 'package.json')
    const runtimeStatusBeforeRebuild = this.runtimeManager?.getStatus(projectId)
    const cleanInstall = options.cleanInstall === true
    const cleanupDependenciesAfterSuccess = options.cleanupDependenciesAfterSuccess === true
    const cleanupBuildCacheAfterSuccess = options.cleanupBuildCacheAfterSuccess === true

    if (this.runtimeManager && runtimeStatusBeforeRebuild?.status !== 'not_started') {
      await this.runtimeManager.stop(projectId)
    }

    const needsPreRebuildCleanup = cleanInstall && (
      existsSync(path.join(projectDir, 'node_modules')) ||
      existsSync(path.join(projectDir, '.next', 'cache'))
    )
    if (needsPreRebuildCleanup) {
      const cleanupResult = await this.cleanup(projectId, {
        removeNodeModules: true,
        removeBuildCache: true
      })
      if (!cleanupResult.success) {
        return {
          success: false,
          buildStatus: 'failed',
          duration: 0,
          error: cleanupResult.error
        }
      }
    }

    if (cleanInstall) {
      // Remove stale lockfiles only for explicit clean installs.
      for (const lockfile of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
        const lockfilePath = path.join(projectDir, lockfile)
        if (existsSync(lockfilePath)) {
          try { await fs.rm(lockfilePath, { force: true }) } catch { /* best-effort */ }
        }
      }
    }

    if (existsSync(packageJsonPath)) {
      await ensureNextRuntimeCompatiblePackageJson(this.projectsDir, projectDir)
      await this._installDeps(projectDir)
    }

    const result = await this.build(projectId)

    if (result.success) {
      const canCleanupDependenciesAfterSuccess = cleanupDependenciesAfterSuccess && this._hasStandaloneOutput(projectDir)
      if (cleanupDependenciesAfterSuccess || cleanupBuildCacheAfterSuccess) {
        const cleanupResult = await this.cleanup(projectId, {
          removeNodeModules: canCleanupDependenciesAfterSuccess,
          removeBuildCache: cleanupBuildCacheAfterSuccess
        })
        if (!cleanupResult.success) {
          result.output = [result.output, `Cleanup failed: ${cleanupResult.error}`].filter(Boolean).join('\n')
        } else if (cleanupDependenciesAfterSuccess && !canCleanupDependenciesAfterSuccess) {
          result.output = [result.output, 'Skipped node_modules cleanup because this runtime still requires installed dependencies after restart.'].filter(Boolean).join('\n')
        }
      }
      if (this.runtimeManager) {
        try {
          const startResult = await this.runtimeManager.start(projectId)
          const runtimeStatus = this.runtimeManager.getStatus(projectId)
          result.runtimeStatus = startResult.status
          result.port = runtimeStatus.port ?? startResult.port
          result.pid = runtimeStatus.pid
          result.startupLogs = this.runtimeManager.getLogs(projectId, 20).map(log => log.text)
        } catch (err) {
          result.success = false
          result.error = `Build succeeded but restart failed: ${(err as Error).message}`
        }
      }
    }

    return result
  }

  async syncManualBuildState (projectId: string): Promise<{ synced: boolean; reason?: string }> {
    const projectDir = this._resolveProjectDir(projectId)
    const metaPath = path.join(projectDir, '.world-meta.json')
    const isNextProject = await this._isNextProject(projectDir)

    if (isNextProject) {
      if (!this._hasStandaloneOutput(projectDir)) {
        await this._updateBuildStatus(metaPath, 'failed')
        return { synced: false, reason: 'standaloneOutputMissing' }
      }
      await this._copyNextStaticAssets(projectDir)
    }

    const buildHash = await this._computeSourceHash(projectDir)
    await this._updateBuildMeta(metaPath, 'built', buildHash)
    return { synced: true }
  }

  /**
   * Check if a project has a valid standalone build.
   */
  hasStandaloneBuild (projectId: string): boolean {
    const projectDir = path.join(this.projectsDir, projectId)
    return this._hasStandaloneOutput(projectDir)
  }

  getLastFailure (projectId: string): ProjectFailureSnapshot | null {
    return this.lastBuildFailures.get(projectId) ?? null
  }

  private _hasStandaloneOutput (projectDir: string): boolean {
    return existsSync(path.join(projectDir, '.next', 'standalone', 'server.js'))
  }

  private _recordBuildFailure (
    projectId: string,
    failure: {
      phase: Extract<ProjectFailurePhase, 'build_failed' | 'standalone_output_missing'>
      summary: string
      error?: string
      output?: string
    }
  ): void {
    this.lastBuildFailures.set(projectId, {
      source: 'build',
      phase: failure.phase,
      status: 'failed',
      summary: failure.summary,
      time: new Date().toISOString(),
      error: failure.error,
      stderrExcerpt: this._buildOutputExcerpt(failure.output)
    })
  }

  private _buildOutputExcerpt (output?: string): string[] {
    if (!output) {
      return []
    }

    return output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .slice(-BUILD_FAILURE_EXCERPT_LINES)
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

  /**
   * On Windows, pnpm-managed Next.js projects can fail when standalone tracing
   * recreates symlinks without elevated privileges.
   */
  private _shouldUseElevatedBuild (projectId: string, isNextProject: boolean): boolean {
    const projectDir = this._resolveProjectDir(projectId)
    return process.platform === 'win32' &&
      isNextProject &&
      existsSync(path.join(projectDir, 'node_modules', '.pnpm'))
  }

  private async _runBuildCommand (
    projectId: string,
    projectDir: string,
    env: NodeJS.ProcessEnv,
    isNextProject: boolean
  ): Promise<CommandExecutionResult> {
    if (this._shouldUseElevatedBuild(projectId, isNextProject)) {
      return await this._runElevatedWindowsBuild(projectDir, env)
    }

    return await new Promise((resolve, reject) => {
      const child = spawn(this._getNpmCommand(), ['run', 'build'], {
        cwd: projectDir,
        stdio: 'pipe',
        shell: process.platform === 'win32',
        windowsHide: process.platform === 'win32',
        env
      })

      let output = ''
      child.stdout?.on('data', (data: Buffer) => { output += data.toString() })
      child.stderr?.on('data', (data: Buffer) => { output += data.toString() })
      child.on('exit', (code) => {
        resolve({ code, output })
      })
      child.on('error', reject)
    })
  }

  private async _runElevatedWindowsBuild (
    projectDir: string,
    env: NodeJS.ProcessEnv
  ): Promise<CommandExecutionResult> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'the-world-build-'))
    const launcherPath = path.join(tempDir, 'launch-elevated-next-build.ps1')
    const runnerPath = path.join(tempDir, 'elevated-next-build.ps1')
    const configPath = path.join(tempDir, 'build-config.json')
    const stdoutPath = path.join(tempDir, 'stdout.log')
    const stderrPath = path.join(tempDir, 'stderr.log')
    const exitCodePath = path.join(tempDir, 'exit-code.txt')

    try {
      const config = {
        projectDir,
        stdoutPath,
        stderrPath,
        exitCodePath,
        env: Object.fromEntries(
          Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        )
      }

      // Write config JSON with UTF-8 BOM so that PowerShell 5.1 (which defaults
      // to the system ANSI code page) reads CJK project directory paths correctly.
      const UTF8_BOM = '\uFEFF'
      await Promise.all([
        fs.writeFile(configPath, UTF8_BOM + JSON.stringify(config), 'utf-8'),
        fs.writeFile(runnerPath, this._buildElevatedWindowsRunnerScript(), 'utf-8'),
        fs.writeFile(launcherPath, this._buildElevatedWindowsLauncherScript(), 'utf-8')
      ])

      const launcherResult = await new Promise<CommandExecutionResult>((resolve, reject) => {
        const child = spawn('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'RemoteSigned',
          '-File',
          launcherPath,
          '-RunnerPath',
          runnerPath,
          '-ConfigPath',
          configPath
        ], {
          cwd: projectDir,
          stdio: 'pipe',
          shell: false,
          env: process.env
        })

        let output = ''
        child.stdout?.on('data', (data: Buffer) => { output += data.toString() })
        child.stderr?.on('data', (data: Buffer) => { output += data.toString() })
        child.on('exit', (code) => {
          resolve({ code, output })
        })
        child.on('error', reject)
      })

      const [stdout, stderr, exitCodeRaw] = await Promise.all([
        this._readTextFileIfExists(stdoutPath),
        this._readTextFileIfExists(stderrPath),
        this._readTextFileIfExists(exitCodePath)
      ])

      const output = [launcherResult.output, stdout, stderr].filter(Boolean).join('\n').trim()
      const parsedExitCode = Number.parseInt(exitCodeRaw.trim(), 10)
      if (Number.isFinite(parsedExitCode)) {
        return { code: parsedExitCode, output }
      }

      return { code: launcherResult.code, output }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch((err) => {
        console.warn(`[BuilderService] Failed to clean up temporary elevated build files: ${(err as Error).message}`)
      })
    }
  }

  private _buildElevatedWindowsLauncherScript (): string {
    // param() MUST be the first statement in a PowerShell script;
    // only comments and [CmdletBinding()] may precede it.
    return [
      'param(',
      '  [Parameter(Mandatory = $true)][string]$RunnerPath,',
      '  [Parameter(Mandatory = $true)][string]$ConfigPath',
      ')',
      '$ErrorActionPreference = \'Stop\'',
      'Start-Process -FilePath \'powershell.exe\' -Verb RunAs -Wait -PassThru -ArgumentList @(',
      '  \'-NoProfile\',',
      '  \'-NonInteractive\',',
      '  \'-ExecutionPolicy\',',
      '  \'RemoteSigned\',',
      '  \'-File\',',
      '  $RunnerPath,',
      '  \'-ConfigPath\',',
      '  $ConfigPath',
      ') | Out-Null'
    ].join('\n')
  }

  private _buildElevatedWindowsRunnerScript (): string {
    // param() MUST be the first statement in a PowerShell script.
    return [
      'param([Parameter(Mandatory = $true)][string]$ConfigPath)',
      '$ErrorActionPreference = \'Stop\'',
      '$config = Get-Content -LiteralPath $ConfigPath -Encoding UTF8 -Raw | ConvertFrom-Json',
      '$psi = New-Object System.Diagnostics.ProcessStartInfo',
      '$psi.FileName = \'cmd.exe\'',
      '$psi.Arguments = \'/d /s /c "npm run build"\'',
      '$psi.WorkingDirectory = [string]$config.projectDir',
      '$psi.UseShellExecute = $false',
      '$psi.RedirectStandardOutput = $true',
      '$psi.RedirectStandardError = $true',
      'foreach ($property in $config.env.PSObject.Properties) {',
      '  $psi.Environment[[string]$property.Name] = [string]$property.Value',
      '}',
      '$process = New-Object System.Diagnostics.Process',
      '$process.StartInfo = $psi',
      '$null = $process.Start()',
      '$stdout = $process.StandardOutput.ReadToEnd()',
      '$stderr = $process.StandardError.ReadToEnd()',
      '$process.WaitForExit()',
      '[System.IO.File]::WriteAllText([string]$config.stdoutPath, $stdout, [System.Text.Encoding]::UTF8)',
      '[System.IO.File]::WriteAllText([string]$config.stderrPath, $stderr, [System.Text.Encoding]::UTF8)',
      '[System.IO.File]::WriteAllText([string]$config.exitCodePath, [string]$process.ExitCode, [System.Text.Encoding]::UTF8)',
      'exit $process.ExitCode'
    ].join('\n')
  }

  private async _readTextFileIfExists (filePath: string): Promise<string> {
    try {
      return await fs.readFile(filePath, 'utf-8')
    } catch {
      return ''
    }
  }

  private _resolveProjectDir (projectId: string): string {
    if (!/^[\w\u4e00-\u9fff-]+$/u.test(projectId)) {
      throw new Error('Project path must stay within the projects directory')
    }

    const baseDir = path.resolve(this.projectsDir)
    const projectDir = path.resolve(baseDir, projectId)
    if (projectDir !== baseDir && !projectDir.startsWith(`${baseDir}${path.sep}`)) {
      throw new Error('Project path must stay within the projects directory')
    }
    return projectDir
  }

  private _getNpmCommand (): string {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm'
  }

  private async _normalizeNextProjectFiles (projectDir: string): Promise<void> {
    await this._removeDuplicateScriptVariants(projectDir)
    await ensureNextRuntimeCompatiblePackageJson(this.projectsDir, projectDir)
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
      const child = spawn(this._getNpmCommand(), ['install'], {
        cwd,
        stdio: 'pipe',
        shell: process.platform === 'win32',
        windowsHide: process.platform === 'win32',
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
