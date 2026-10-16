import fs from 'node:fs'
import path from 'node:path'

/**
 * Sidebar-registered project folders: arbitrary directories the user pinned
 * into the conversation sidebar's project grouping (R3 extension). Unlike
 * Launchpad apps these are not developed inside WorldBase — attaching one to a
 * conversation simply points the folder workspace (and therefore the AI's
 * folder read/write tools) at the directory.
 */
export interface CustomProjectEntry {
  id: string
  name: string
  rootPath: string
  createdAt: string
}

interface CustomProjectFile {
  version: 1
  projects: CustomProjectEntry[]
}

const EMPTY: CustomProjectFile = { version: 1, projects: [] }

function normalizeRoot (rootPath: string): string {
  // macOS/Windows are case-insensitive enough for dedupe purposes.
  return rootPath.replace(/[\\/]+$/, '').toLowerCase()
}

export class CustomProjectStore {
  private readonly filePath: string
  private data: CustomProjectFile = { ...EMPTY, projects: [] }

  constructor (userDataPath: string) {
    this.filePath = path.join(userDataPath, 'custom-projects.json')
    this.load()
  }

  private load (): void {
    try {
      if (!fs.existsSync(this.filePath)) return
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<CustomProjectFile>
      const projects = Array.isArray(parsed.projects)
        ? parsed.projects.filter((entry): entry is CustomProjectEntry => Boolean(
          entry &&
          typeof entry.id === 'string' && entry.id &&
          typeof entry.name === 'string' && entry.name &&
          typeof entry.rootPath === 'string' && entry.rootPath &&
          typeof entry.createdAt === 'string'
        ))
        : []
      this.data = { version: 1, projects }
    } catch {
      this.data = { ...EMPTY, projects: [] }
    }
  }

  private save (): void {
    const temporary = `${this.filePath}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), 'utf-8')
      fs.renameSync(temporary, this.filePath)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }

  list (): CustomProjectEntry[] {
    return [...this.data.projects]
  }

  get (id: string): CustomProjectEntry | null {
    return this.data.projects.find(entry => entry.id === id) || null
  }

  findByRootPath (rootPath: string): CustomProjectEntry | null {
    const key = normalizeRoot(rootPath)
    return this.data.projects.find(entry => normalizeRoot(entry.rootPath) === key) || null
  }

  add (rootPath: string, name?: string): CustomProjectEntry {
    const trimmedPath = rootPath.trim()
    if (!trimmedPath) throw new Error('Project folder path is required')
    const existing = this.findByRootPath(trimmedPath)
    if (existing) return existing
    const entry: CustomProjectEntry = {
      id: `cproj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: (name?.trim() || trimmedPath.split(/[\\/]/).filter(Boolean).pop() || trimmedPath),
      rootPath: trimmedPath,
      createdAt: new Date().toISOString()
    }
    this.data.projects.push(entry)
    this.save()
    return entry
  }

  remove (id: string): boolean {
    const next = this.data.projects.filter(entry => entry.id !== id)
    if (next.length === this.data.projects.length) return false
    this.data.projects = next
    this.save()
    return true
  }
}
