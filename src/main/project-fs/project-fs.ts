import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { SafeWriter } from './safe-write.js'
import { ProjectAnalyzer } from './project-analyzer.js'
import type { FileTreeItem, ProjectAnalysis } from './project-analyzer.js'

export interface ProjectMeta {
  id: string
  name: string
  type: string
  [key: string]: unknown
}

export interface DirEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: DirEntry[]
}

export interface SearchResult {
  file: string
  line: number
  content: string
}

/**
 * ProjectFS — 项目文件系统访问层
 * 主 AI 通过此层读写子项目的任何文件
 */
export class ProjectFS {
  readonly projectsDir: string
  private snapshotsDir: string
  private safeWriter: SafeWriter
  private analyzer: ProjectAnalyzer

  constructor (projectsDir: string, snapshotsDir: string) {
    this.projectsDir = projectsDir
    this.snapshotsDir = snapshotsDir
    this.safeWriter = new SafeWriter(snapshotsDir)
    this.analyzer = new ProjectAnalyzer()

    // Ensure directories exist
    if (!existsSync(projectsDir)) {
      mkdirSync(projectsDir, { recursive: true })
    }
    if (!existsSync(snapshotsDir)) {
      mkdirSync(snapshotsDir, { recursive: true })
    }
  }

  /**
   * Resolve and validate a path within a project directory.
   * Prevents directory traversal attacks.
   */
  _resolveProjectPath (projectId: string, relativePath = ''): string {
    const projectRoot = path.join(this.projectsDir, projectId)
    const resolved = path.resolve(projectRoot, relativePath)

    if (!resolved.startsWith(projectRoot)) {
      throw new Error(`Path traversal detected: ${relativePath}`)
    }
    return resolved
  }

  /**
   * List all projects by scanning the projects directory.
   */
  async listProjects (): Promise<ProjectMeta[]> {
    if (!existsSync(this.projectsDir)) {
      return []
    }

    const entries = await fs.readdir(this.projectsDir, { withFileTypes: true })
    const projects: ProjectMeta[] = []

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const metaPath = path.join(this.projectsDir, entry.name, '.world-meta.json')
        try {
          const metaContent = await fs.readFile(metaPath, 'utf-8')
          const meta = JSON.parse(metaContent) as ProjectMeta
          // Ensure id is always set; fall back to the directory name
          if (!meta.id) meta.id = entry.name
          projects.push(meta)
        } catch {
          // Directory exists but no meta file — skip
          projects.push({ id: entry.name, name: entry.name, type: 'unknown' })
        }
      }
    }
    return projects
  }

  /**
   * Get project metadata from .world-meta.json
   */
  async getProjectMeta (projectId: string): Promise<ProjectMeta> {
    const metaPath = this._resolveProjectPath(projectId, '.world-meta.json')
    const content = await fs.readFile(metaPath, 'utf-8')
    return JSON.parse(content) as ProjectMeta
  }

  /**
   * Save project metadata to .world-meta.json
   */
  async saveProjectMeta (projectId: string, meta: ProjectMeta): Promise<void> {
    const metaPath = this._resolveProjectPath(projectId, '.world-meta.json')
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
  }

  /**
   * Read a file from a project.
   */
  async readFile (projectId: string, relativePath: string): Promise<string> {
    const fullPath = this._resolveProjectPath(projectId, relativePath)
    return fs.readFile(fullPath, 'utf-8')
  }

  /**
   * Write a file to a project (creates parent directories if needed).
   */
  async writeFile (projectId: string, relativePath: string, content: string): Promise<void> {
    const fullPath = this._resolveProjectPath(projectId, relativePath)
    const dir = path.dirname(fullPath)

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    await this.safeWriter.safeWrite(fullPath, content)
  }

  /**
   * Delete a file from a project.
   */
  async deleteFile (projectId: string, relativePath: string): Promise<void> {
    const fullPath = this._resolveProjectPath(projectId, relativePath)
    await fs.unlink(fullPath)
  }

  /**
   * Delete an entire project directory.
   */
  async deleteProject (projectId: string): Promise<void> {
    const projectDir = this._resolveProjectPath(projectId)
    if (existsSync(projectDir)) {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  }

  /**
   * Check if a file exists in a project.
   */
  async fileExists (projectId: string, relativePath: string): Promise<boolean> {
    const fullPath = this._resolveProjectPath(projectId, relativePath)
    return existsSync(fullPath)
  }

  /**
   * List directory contents.
   */
  async listDir (projectId: string, relativePath = '', recursive = false): Promise<DirEntry[]> {
    const fullPath = this._resolveProjectPath(projectId, relativePath)
    const entries = await fs.readdir(fullPath, { withFileTypes: true })

    const result: DirEntry[] = []
    for (const entry of entries) {
      // Skip node_modules and hidden directories
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue
      }

      const item: DirEntry = {
        name: entry.name,
        path: path.join(relativePath, entry.name),
        type: entry.isDirectory() ? 'directory' : 'file'
      }

      if (entry.isDirectory() && recursive) {
        item.children = await this.listDir(projectId, item.path, true)
      }

      result.push(item)
    }
    return result
  }

  /**
   * Get the full file tree of a project (recursive listing).
   */
  async getFileTree (projectId: string): Promise<DirEntry[]> {
    return this.listDir(projectId, '', true)
  }

  /**
   * Search for a pattern in project files using simple string matching.
   */
  async searchInProject (projectId: string, pattern: string): Promise<SearchResult[]> {
    const results: SearchResult[] = []
    const files = await this._getAllFiles(projectId, '')

    for (const filePath of files) {
      try {
        const content = await this.readFile(projectId, filePath)
        const lines = content.split('\n')

        lines.forEach((line, index) => {
          if (line.includes(pattern)) {
            results.push({
              file: filePath,
              line: index + 1,
              content: line.trim()
            })
          }
        })
      } catch {
        // Skip unreadable files (binary, etc.)
      }
    }
    return results
  }

  /**
   * Create a snapshot of a project for rollback support.
   */
  async createSnapshot (projectId: string): Promise<string> {
    const timestamp = Date.now()
    const snapshotId = `${projectId}_${timestamp}`
    const snapshotDir = path.join(this.snapshotsDir, snapshotId)
    const projectDir = this._resolveProjectPath(projectId)

    await fs.cp(projectDir, snapshotDir, {
      recursive: true,
      filter: (src) => !src.includes('node_modules')
    })

    return snapshotId
  }

  /**
   * Rollback a project to a previous snapshot.
   */
  async rollback (projectId: string, snapshotId: string): Promise<void> {
    const snapshotDir = path.join(this.snapshotsDir, snapshotId)

    if (!existsSync(snapshotDir)) {
      throw new Error(`Snapshot not found: ${snapshotId}`)
    }

    const projectDir = this._resolveProjectPath(projectId)

    // Remove current project files (except node_modules)
    const entries = await fs.readdir(projectDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name !== 'node_modules') {
        await fs.rm(path.join(projectDir, entry.name), { recursive: true, force: true })
      }
    }

    // Copy snapshot back
    await fs.cp(snapshotDir, projectDir, { recursive: true })
  }

  /**
   * Create a new project with the given files.
   */
  async createProject (projectId: string, meta: Record<string, unknown>, files: Record<string, string>): Promise<ProjectMeta> {
    const projectDir = this._resolveProjectPath(projectId)

    if (existsSync(projectDir)) {
      throw new Error(`Project already exists: ${projectId}`)
    }

    mkdirSync(projectDir, { recursive: true })

    const fullMeta = { id: projectId, name: '', type: 'unknown', ...meta } as ProjectMeta

    // Write .world-meta.json
    await this.saveProjectMeta(projectId, fullMeta)

    // Write all files
    for (const [filePath, content] of Object.entries(files)) {
      await this.writeFile(projectId, filePath, content)
    }

    return fullMeta
  }

  /**
   * Analyze a project's structure and technology stack.
   */
  async analyzeProject (projectId: string): Promise<ProjectAnalysis> {
    const fileTree = await this.getFileTree(projectId) as FileTreeItem[]
    return this.analyzer.analyze(projectId, fileTree, this)
  }

  /**
   * Get all file paths in a project (recursively, excluding node_modules).
   */
  async _getAllFiles (projectId: string, relativePath: string): Promise<string[]> {
    const fullPath = this._resolveProjectPath(projectId, relativePath)
    const entries = await fs.readdir(fullPath, { withFileTypes: true })
    let files: string[] = []

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue
      }

      const entryPath = path.join(relativePath, entry.name)

      if (entry.isDirectory()) {
        const subFiles = await this._getAllFiles(projectId, entryPath)
        files = files.concat(subFiles)
      } else {
        files.push(entryPath)
      }
    }
    return files
  }
}
