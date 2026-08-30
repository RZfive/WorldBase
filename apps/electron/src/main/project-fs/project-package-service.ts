import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { normalizeProjectMeta } from './project-meta.js'
import { t } from '../i18n/main-i18n.js'
import type { ProjectFS, ProjectMeta } from './project-fs.js'
import type { ProjectDataAccess } from '../project-data-access/data-access.js'

export const PROJECT_PACKAGE_EXTENSION = 'twapp'

const PROJECT_PACKAGE_KIND = 'the-world-app-package'
const PROJECT_PACKAGE_FORMAT_VERSION = 1
const PROJECT_PACKAGE_MANIFEST_PATH = 'manifest.json'
const PROJECT_PACKAGE_SOURCE_PREFIX = 'source/'
const PROJECT_PACKAGE_BUILD_PREFIX = 'build/'
const PROJECT_PACKAGE_DECLARED_SCHEMA_PATH = 'database/declared-schema.json'
const PROJECT_PACKAGE_INTROSPECTED_SCHEMA_PATH = 'database/introspected-schema.json'
const PROJECT_ID_HASH_LENGTH = 8
const MAX_PROJECT_SLUG_LENGTH = 20
const BUILD_ARTIFACT_ROOTS = ['.next', 'dist', 'build', 'out', '.output', 'release'] as const
const SOURCE_EXCLUDED_ROOTS = new Set<string>(['node_modules', '.git', ...BUILD_ARTIFACT_ROOTS])

interface ProjectPackageManifest {
  packageType: string
  formatVersion: number
  exportedAt: string
  sourceProjectId: string
  project: {
    name: string
    meta: Record<string, unknown>
  }
  source: {
    root: string
    fileCount: number
  }
  build: {
    root: string
    includedPaths: string[]
  }
  database: {
    declaredSchemaPath?: string
    introspectedSchemaPath?: string
    dbPath?: string | null
  }
}

export interface ExportedProjectPackageResult {
  filePath: string
  projectId: string
  projectName: string
  includedBuildArtifacts: string[]
}

export interface ImportedProjectPackageResult {
  filePath: string
  projectId: string
  meta: ProjectMeta
}

function normalizeArchivePath (value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '')
  const safe = path.posix.normalize(normalized)
  if (!safe || safe === '.' || safe.startsWith('../') || path.posix.isAbsolute(safe) || /^[A-Za-z]:/.test(safe)) {
    throw new Error(`Invalid archive path: ${value}`)
  }
  return safe
}

function isMacOsMetadataPath (relativePath: string): boolean {
  const normalized = normalizeArchivePath(relativePath)
  const baseName = path.posix.basename(normalized)
  return /^__macosx\//i.test(normalized) || baseName === '.DS_Store' || baseName.startsWith('._')
}

function isDatabaseArtifactPath (relativePath: string, dbPath: string | null): boolean {
  if (!dbPath) return false
  const normalized = normalizeArchivePath(relativePath)
  const normalizedDbPath = normalizeArchivePath(dbPath)
  return normalized === normalizedDbPath || normalized === `${normalizedDbPath}-wal` || normalized === `${normalizedDbPath}-shm`
}

function shouldIncludeBuildArtifactPath (relativePath: string): boolean {
  const normalized = normalizeArchivePath(relativePath)
  if (isMacOsMetadataPath(normalized)) return false
  return !(normalized === '.next/cache' || normalized.startsWith('.next/cache/'))
}

function generateProjectId (name: string): string {
  const asciiSlug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_PROJECT_SLUG_LENGTH)

  const suffix = crypto
    .createHash('sha1')
    .update(`${name}:${Date.now()}:${crypto.randomUUID()}`)
    .digest('hex')
    .slice(0, PROJECT_ID_HASH_LENGTH)

  if (!asciiSlug) {
    const longHash = crypto
      .createHash('sha1')
      .update(`${name}:${Date.now()}:${crypto.randomUUID()}`)
      .digest('hex')
      .slice(0, MAX_PROJECT_SLUG_LENGTH)
    return `proj_${longHash}`
  }

  return `proj_${asciiSlug}_${suffix}`
}

export class ProjectPackageService {
  constructor (
    private readonly projectFS: ProjectFS,
    private readonly dataAccess: ProjectDataAccess
  ) {}

  async exportPackage (projectId: string, outputPath: string): Promise<ExportedProjectPackageResult> {
    const JSZip = (await import('jszip')).default
    const archive = new JSZip()
    const projectRoot = path.join(this.projectFS.projectsDir, projectId)
    const normalizedMeta = normalizeProjectMeta(await this.projectFS.getProjectMeta(projectId))
    const projectName = typeof normalizedMeta.name === 'string' && normalizedMeta.name.trim()
      ? normalizedMeta.name.trim()
      : projectId
    const declaredSchema = normalizedMeta.dataSchema ?? null
    const dbPath = declaredSchema && typeof (declaredSchema as Record<string, unknown>).dbPath === 'string'
      ? String((declaredSchema as Record<string, unknown>).dbPath)
      : null
    const sourceFiles = await this.collectSourceFiles(projectRoot, dbPath)
    const buildRoots = await this.collectExistingBuildRoots(projectRoot)
    const buildFiles = await this.collectBuildFiles(projectRoot, buildRoots)
    const introspectedSchema = await this.dataAccess.getTableSchema(projectId).catch(() => null)
    const manifest: ProjectPackageManifest = {
      packageType: PROJECT_PACKAGE_KIND,
      formatVersion: PROJECT_PACKAGE_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      sourceProjectId: projectId,
      project: {
        name: projectName,
        meta: normalizedMeta
      },
      source: {
        root: PROJECT_PACKAGE_SOURCE_PREFIX.replace(/\/$/, ''),
        fileCount: sourceFiles.length
      },
      build: {
        root: PROJECT_PACKAGE_BUILD_PREFIX.replace(/\/$/, ''),
        includedPaths: buildRoots
      },
      database: {
        ...(declaredSchema ? { declaredSchemaPath: PROJECT_PACKAGE_DECLARED_SCHEMA_PATH } : {}),
        ...(introspectedSchema ? { introspectedSchemaPath: PROJECT_PACKAGE_INTROSPECTED_SCHEMA_PATH } : {}),
        ...(dbPath ? { dbPath } : {})
      }
    }

    archive.file(PROJECT_PACKAGE_MANIFEST_PATH, JSON.stringify(manifest, null, 2))

    if (declaredSchema) {
      archive.file(PROJECT_PACKAGE_DECLARED_SCHEMA_PATH, JSON.stringify(declaredSchema, null, 2))
    }

    if (introspectedSchema) {
      archive.file(PROJECT_PACKAGE_INTROSPECTED_SCHEMA_PATH, JSON.stringify(introspectedSchema, null, 2))
    }

    for (const relativePath of sourceFiles) {
      const fullPath = path.join(projectRoot, ...relativePath.split('/'))
      archive.file(`${PROJECT_PACKAGE_SOURCE_PREFIX}${relativePath}`, await fs.readFile(fullPath))
    }

    for (const relativePath of buildFiles) {
      const fullPath = path.join(projectRoot, ...relativePath.split('/'))
      archive.file(`${PROJECT_PACKAGE_BUILD_PREFIX}${relativePath}`, await fs.readFile(fullPath))
    }

    const buffer = await archive.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 }
    })

    await fs.writeFile(outputPath, buffer)

    return {
      filePath: outputPath,
      projectId,
      projectName,
      includedBuildArtifacts: buildRoots
    }
  }

  async importPackage (filePath: string): Promise<ImportedProjectPackageResult> {
    const JSZip = (await import('jszip')).default
    const archive = await JSZip.loadAsync(await fs.readFile(filePath))
    const manifestEntry = archive.file(PROJECT_PACKAGE_MANIFEST_PATH)
    if (!manifestEntry) {
      throw new Error(t('mainDialog.appPackageMissingManifest'))
    }

    const manifest = JSON.parse(await manifestEntry.async('text')) as Partial<ProjectPackageManifest>
    if (manifest.packageType !== PROJECT_PACKAGE_KIND || manifest.formatVersion !== PROJECT_PACKAGE_FORMAT_VERSION) {
      throw new Error(t('mainDialog.appPackageUnsupportedFormat'))
    }

    const packageProjectName = typeof manifest.project?.name === 'string' && manifest.project.name.trim()
      ? manifest.project.name.trim()
      : typeof manifest.sourceProjectId === 'string' && manifest.sourceProjectId.trim()
        ? manifest.sourceProjectId.trim()
        : t('mainDialog.appPackageDefaultImportName')
    const projectId = generateProjectId(packageProjectName)
    const projectRoot = path.join(this.projectFS.projectsDir, projectId)

    if (existsSync(projectRoot)) {
      throw new Error(t('mainDialog.appPackageTargetExists', { projectId }))
    }

    await fs.mkdir(projectRoot, { recursive: true })

    try {
      const archiveEntries = Object.values(archive.files)
        .filter(entry => !entry.dir)
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))

      for (const entry of archiveEntries) {
        const normalizedName = entry.name.replace(/\\/g, '/')
        if (
          normalizedName === PROJECT_PACKAGE_MANIFEST_PATH ||
          normalizedName === PROJECT_PACKAGE_DECLARED_SCHEMA_PATH ||
          normalizedName === PROJECT_PACKAGE_INTROSPECTED_SCHEMA_PATH ||
          isMacOsMetadataPath(normalizedName)
        ) {
          continue
        }

        let relativePath: string | null = null
        if (normalizedName.startsWith(PROJECT_PACKAGE_SOURCE_PREFIX)) {
          relativePath = normalizedName.slice(PROJECT_PACKAGE_SOURCE_PREFIX.length)
        } else if (normalizedName.startsWith(PROJECT_PACKAGE_BUILD_PREFIX)) {
          relativePath = normalizedName.slice(PROJECT_PACKAGE_BUILD_PREFIX.length)
        }

        if (!relativePath) continue

        const safeRelativePath = normalizeArchivePath(relativePath)
        const destinationPath = path.join(projectRoot, ...safeRelativePath.split('/'))
        const resolvedDestination = path.resolve(destinationPath)
        if (!resolvedDestination.startsWith(projectRoot)) {
          throw new Error(t('mainDialog.appPackageUnsafePath', { path: safeRelativePath }))
        }

        await fs.mkdir(path.dirname(resolvedDestination), { recursive: true })
        const content = await entry.async('nodebuffer')
        await fs.writeFile(resolvedDestination, content)
      }

      let importedMeta: ProjectMeta
      try {
        importedMeta = await this.projectFS.getProjectMeta(projectId)
      } catch {
        importedMeta = normalizeProjectMeta(manifest.project?.meta || {}) as ProjectMeta
      }

      const normalizedImportedMeta = normalizeProjectMeta({
        ...(manifest.project?.meta || {}),
        ...importedMeta,
        id: projectId,
        name: (typeof importedMeta.name === 'string' && importedMeta.name.trim()) || packageProjectName,
        importedFrom: {
          packageType: manifest.packageType,
          sourceProjectId: manifest.sourceProjectId || null,
          exportedAt: manifest.exportedAt || null,
          importedAt: new Date().toISOString(),
          packageFileName: path.basename(filePath),
          formatVersion: manifest.formatVersion
        }
      }) as ProjectMeta

      await this.projectFS.saveProjectMeta(projectId, normalizedImportedMeta)

      return {
        filePath,
        projectId,
        meta: normalizedImportedMeta
      }
    } catch (error) {
      await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  private async collectSourceFiles (projectRoot: string, dbPath: string | null): Promise<string[]> {
    const entries = await fs.readdir(projectRoot, { withFileTypes: true })
    const sourceFiles: string[] = []

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))) {
      if (SOURCE_EXCLUDED_ROOTS.has(entry.name)) continue

      const relativePath = normalizeArchivePath(entry.name)
      if (isMacOsMetadataPath(relativePath) || isDatabaseArtifactPath(relativePath, dbPath)) continue
      const nestedFiles = await this.collectFilesFromRelativePath(projectRoot, relativePath, (candidatePath) => {
        return !isMacOsMetadataPath(candidatePath) && !isDatabaseArtifactPath(candidatePath, dbPath)
      })
      sourceFiles.push(...nestedFiles)
    }

    return sourceFiles
  }

  private async collectExistingBuildRoots (projectRoot: string): Promise<string[]> {
    const roots: string[] = []

    for (const rootName of BUILD_ARTIFACT_ROOTS) {
      const fullPath = path.join(projectRoot, rootName)
      if (!existsSync(fullPath)) continue
      roots.push(rootName)
    }

    return roots
  }

  private async collectBuildFiles (projectRoot: string, buildRoots: string[]): Promise<string[]> {
    const buildFiles: string[] = []

    for (const rootName of buildRoots) {
      const nestedFiles = await this.collectFilesFromRelativePath(projectRoot, rootName, shouldIncludeBuildArtifactPath)
      buildFiles.push(...nestedFiles)
    }

    return buildFiles
  }

  private async collectFilesFromRelativePath (
    projectRoot: string,
    relativePath: string,
    includeFile: (relativePath: string) => boolean
  ): Promise<string[]> {
    const safeRelativePath = normalizeArchivePath(relativePath)
    const fullPath = path.join(projectRoot, ...safeRelativePath.split('/'))
    const stat = await fs.stat(fullPath)

    if (stat.isFile()) {
      return includeFile(safeRelativePath) ? [safeRelativePath] : []
    }

    if (!stat.isDirectory()) {
      return []
    }

    const entries = await fs.readdir(fullPath, { withFileTypes: true })
    const collected: string[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))) {
      const childRelativePath = normalizeArchivePath(`${safeRelativePath}/${entry.name}`)
      if (entry.isDirectory()) {
        collected.push(...await this.collectFilesFromRelativePath(projectRoot, childRelativePath, includeFile))
      } else if (entry.isFile() && includeFile(childRelativePath)) {
        collected.push(childRelativePath)
      }
    }

    return collected
  }
}
