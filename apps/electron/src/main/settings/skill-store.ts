import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { t } from '../i18n/main-i18n.js'

export interface SkillFile {
  /** Relative path within the skill package */
  relativePath: string
  /** File type category */
  type: 'markdown' | 'script' | 'config' | 'code' | 'other'
  /** File size in bytes */
  size: number
}

export interface SkillScript {
  /** Relative path to the script */
  relativePath: string
  /** Script language/runtime (sh, py, js, etc.) */
  language: string
}

export interface Skill {
  id: string
  name: string
  description: string
  /** Primary markdown content used for prompt injection */
  content: string
  /** All files in this skill package */
  files: SkillFile[]
  /** Executable scripts detected in the skill */
  scripts: SkillScript[]
  /** Tools/capabilities provided by this skill (parsed from frontmatter) */
  tools: string[]
  createdAt: string
  updatedAt: string
}

const SKILL_ARCHIVE_EXTENSION = '.zip'
const PRIMARY_SKILL_FILE_NAMES = ['readme.md', 'skill.md', 'index.md', 'main.md']
const TEXT_FILE_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdx', '.txt',
  '.json', '.yaml', '.yml', '.toml', '.ini',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.java', '.kt', '.rs', '.php',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.xml', '.svg', '.csv'
])
const SCRIPT_EXTENSIONS: Record<string, string> = {
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.py': 'python',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.rb': 'ruby',
  '.go': 'go',
  '.php': 'php'
}

/** Strip surrounding quotes (single/double) from a simple YAML scalar value. */
function stripYamlQuotes (value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/**
 * SkillStore — 管理用户导入的 AI Skill
 * 支持单文件（md/txt）、zip 压缩包和文件夹导入。
 * Skill 数据保存到 userData/skills/<id>/ 目录，
 * 其中 meta.json 为元信息，files/ 为技能包文件副本。
 */
export class SkillStore {
  private dir: string

  constructor (userDataPath: string) {
    this.dir = path.join(userDataPath, 'skills')
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true })
    }
  }

  /** List all imported skills (returns metadata only, no full content). */
  list (): Skill[] {
    const entries = fs.readdirSync(this.dir, { withFileTypes: true })
    const skills: Skill[] = []
    for (const entry of entries) {
      // Support legacy .json files
      if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const raw = fs.readFileSync(path.join(this.dir, entry.name), 'utf-8')
          const legacy = JSON.parse(raw) as Record<string, unknown>
          skills.push(this.migrateLegacySkill(legacy))
        } catch { /* skip corrupted files */ }
        continue
      }
      // New directory-based skills
      if (entry.isDirectory()) {
        const metaPath = path.join(this.dir, entry.name, 'meta.json')
        if (!fs.existsSync(metaPath)) continue
        try {
          const raw = fs.readFileSync(metaPath, 'utf-8')
          skills.push(JSON.parse(raw) as Skill)
        } catch { /* skip corrupted */ }
      }
    }
    return skills.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** Get a single skill by ID. */
  get (id: string): Skill | null {
    // Try new format first
    const metaPath = path.join(this.dir, id, 'meta.json')
    if (fs.existsSync(metaPath)) {
      try {
        const raw = fs.readFileSync(metaPath, 'utf-8')
        return JSON.parse(raw) as Skill
      } catch { return null }
    }
    // Fallback to legacy .json
    const legacyPath = path.join(this.dir, `${id}.json`)
    if (fs.existsSync(legacyPath)) {
      try {
        const raw = fs.readFileSync(legacyPath, 'utf-8')
        return this.migrateLegacySkill(JSON.parse(raw))
      } catch { return null }
    }
    return null
  }

  /** Get the directory where a skill's files are stored. */
  getSkillFilesDir (id: string): string | null {
    const filesDir = path.join(this.dir, id, 'files')
    return fs.existsSync(filesDir) ? filesDir : null
  }

  /** Import a skill from a file path (md/txt/zip) or directory path. */
  async importFromFile (filePath: string): Promise<Skill> {
    const stat = await fsPromises.stat(filePath)
    if (stat.isDirectory()) {
      return this.importFromDirectory(filePath)
    }

    const ext = path.extname(filePath).toLowerCase()
    const baseName = path.basename(filePath, path.extname(filePath))

    if (ext === SKILL_ARCHIVE_EXTENSION) {
      return this.importFromArchive(filePath, baseName)
    }

    // Single file import
    const fileContent = await fsPromises.readFile(filePath, 'utf-8')
    const { name, description, tools } = this.parseSkillMeta(fileContent, baseName)
    const id = this.createSkillId(baseName)
    const skillDir = this.ensureSkillDir(id)
    const filesDir = path.join(skillDir, 'files')
    fs.mkdirSync(filesDir, { recursive: true })

    // Copy the file
    const destFileName = path.basename(filePath)
    await fsPromises.copyFile(filePath, path.join(filesDir, destFileName))

    const fileInfo: SkillFile = {
      relativePath: destFileName,
      type: this.classifyFile(destFileName),
      size: stat.size
    }

    return this.saveSkillMeta(id, {
      name,
      description,
      content: fileContent,
      files: [fileInfo],
      scripts: this.detectScripts([fileInfo]),
      tools
    })
  }

  /** Import a skill from raw content.
   *
   * `name` is an optional explicit display name (e.g. the install_skill `name`
   * argument). When empty, the skill's frontmatter `name` / heading is used.
   */
  importFromContent (name: string, content: string, description?: string): Skill {
    const explicitName = typeof name === 'string' ? name.trim() : ''
    const fallbackName = explicitName || 'Imported Skill'
    const meta = this.parseSkillMeta(content, fallbackName, explicitName)
    const id = this.createSkillId(meta.name || fallbackName)
    const skillDir = this.ensureSkillDir(id)
    const filesDir = path.join(skillDir, 'files')
    fs.mkdirSync(filesDir, { recursive: true })

    // Save content as a markdown file
    const fileName = `${this.sanitizeFileName(meta.name || fallbackName)}.md`
    fs.writeFileSync(path.join(filesDir, fileName), content, 'utf-8')

    const fileInfo: SkillFile = {
      relativePath: fileName,
      type: 'markdown',
      size: Buffer.byteLength(content, 'utf-8')
    }

    return this.saveSkillMeta(id, {
      name: meta.name,
      description: description || meta.description,
      content,
      files: [fileInfo],
      scripts: [],
      tools: meta.tools
    })
  }

  /** Delete a skill by ID. */
  delete (id: string): boolean {
    // Try new directory format
    const skillDir = path.join(this.dir, id)
    if (fs.existsSync(skillDir) && fs.statSync(skillDir).isDirectory()) {
      fs.rmSync(skillDir, { recursive: true, force: true })
      return true
    }
    // Fallback: legacy .json
    const legacyPath = path.join(this.dir, `${id}.json`)
    if (fs.existsSync(legacyPath)) {
      fs.unlinkSync(legacyPath)
      return true
    }
    return false
  }

  /** Import a skill from a directory. */
  private async importFromDirectory (dirPath: string): Promise<Skill> {
    const baseName = path.basename(dirPath)
    const id = this.createSkillId(baseName)
    const skillDir = this.ensureSkillDir(id)
    const filesDir = path.join(skillDir, 'files')

    // Recursively copy all files
    const allFiles = await this.copyDirectoryContents(dirPath, filesDir)

    // Find primary markdown for content
    const primaryFile = this.pickPrimaryFile(allFiles)
    let primaryContent = ''
    if (primaryFile) {
      primaryContent = await fsPromises.readFile(path.join(filesDir, primaryFile.relativePath), 'utf-8')
    }

    const { name, description, tools } = this.parseSkillMeta(primaryContent, baseName)
    const scripts = this.detectScripts(allFiles)

    return this.saveSkillMeta(id, {
      name,
      description,
      content: primaryContent,
      files: allFiles,
      scripts,
      tools
    })
  }

  /** Import a skill from a zip archive, preserving all files. */
  private async importFromArchive (filePath: string, baseName: string): Promise<Skill> {
    const JSZip = (await import('jszip')).default
    const archive = await JSZip.loadAsync(await fsPromises.readFile(filePath))
    const id = this.createSkillId(baseName)
    const skillDir = this.ensureSkillDir(id)
    const filesDir = path.join(skillDir, 'files')
    fs.mkdirSync(filesDir, { recursive: true })

    const allFiles: SkillFile[] = []

    const entries = Object.values(archive.files)
      .filter(entry => !entry.dir)
      .filter(entry => {
        const normalized = entry.name.replace(/\\/g, '/')
        const entryBaseName = path.posix.basename(normalized)
        return !/^__macosx\//i.test(normalized) && entryBaseName !== '.DS_Store' && !entryBaseName.startsWith('._')
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

    if (entries.length === 0) {
      throw new Error(t('mainDialog.skillArchiveEmpty'))
    }

    // Strip common root folder prefix
    const stripped = this.stripCommonPrefix(entries.map(e => e.name))

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const relativePath = stripped[i]
      const destPath = path.join(filesDir, relativePath)

      // Ensure parent directory exists
      const parentDir = path.dirname(destPath)
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true })
      }

      // Write file content (binary safe)
      const content = await entry.async('nodebuffer')
      await fsPromises.writeFile(destPath, content)

      allFiles.push({
        relativePath,
        type: this.classifyFile(relativePath),
        size: content.length
      })
    }

    // Find primary markdown for content
    const primaryFile = this.pickPrimaryFile(allFiles)
    let primaryContent = ''
    if (primaryFile) {
      const primaryPath = path.join(filesDir, primaryFile.relativePath)
      primaryContent = await fsPromises.readFile(primaryPath, 'utf-8')
    }

    const { name, description, tools } = this.parseSkillMeta(primaryContent, baseName)
    const scripts = this.detectScripts(allFiles)

    return this.saveSkillMeta(id, {
      name,
      description,
      content: primaryContent,
      files: allFiles,
      scripts,
      tools
    })
  }

  /** Extract name, description, and tools from markdown skill content.
   *
   * Name resolution priority:
   *   1. `explicitName` (caller-provided display name, e.g. install_skill `name` arg)
   *   2. `name` field in the YAML frontmatter (the canonical skill name)
   *   3. first markdown heading
   *   4. `fallbackName` (file base name / default placeholder)
   *
   * Reading the frontmatter `name` keeps the stored/displayed name consistent
   * with the SkillEngine's parser (which uses frontmatter `name`); otherwise
   * agent-installed skills that declare their real name in frontmatter but use
   * a generic `# Skill` heading would display "Skill" instead of the real name.
   */
  private parseSkillMeta (content: string, fallbackName: string, explicitName?: string): { name: string; description: string; tools: string[] } {
    const providedName = typeof explicitName === 'string' ? explicitName.trim() : ''
    let name = providedName || fallbackName
    let description = ''
    const tools: string[] = []

    if (!content) return { name, description, tools }

    // Fields parsed from YAML frontmatter (if present)
    let frontmatterName = ''
    let frontmatterDescription = ''
    let bodyText = content

    // Parse YAML frontmatter for name/description/tools
    const trimmed = content.replace(/^\uFEFF/, '')
    if (trimmed.startsWith('---')) {
      const endIndex = trimmed.indexOf('\n---', 3)
      if (endIndex >= 0) {
        const yamlBlock = trimmed.slice(4, endIndex)
        bodyText = trimmed.slice(endIndex + 4)
        // Extract the canonical name declared in frontmatter
        const nameMatch = yamlBlock.match(/^name:\s*(.+?)\s*$/m)
        if (nameMatch) frontmatterName = stripYamlQuotes(nameMatch[1].trim())
        // Extract description declared in frontmatter
        const descMatch = yamlBlock.match(/^description:\s*(.+?)\s*$/m)
        if (descMatch) frontmatterDescription = stripYamlQuotes(descMatch[1].trim())
        // Extract tool names from allowedTools or tools field
        const toolsMatch = yamlBlock.match(/(?:allowedTools|tools):\s*\n((?:\s+-\s+.+\n?)+)/m)
        if (toolsMatch) {
          const toolLines = toolsMatch[1].match(/^\s+-\s+(.+)$/gm)
          if (toolLines) {
            for (const line of toolLines) {
              const m = line.match(/^\s+-\s+(.+)$/)
              if (m) tools.push(m[1].trim())
            }
          }
        }
        // Also try inline form: tools: [a, b, c]
        const inlineMatch = yamlBlock.match(/(?:allowedTools|tools):\s*\[([^\]]+)\]/)
        if (inlineMatch) {
          const items = inlineMatch[1].split(',').map(s => s.trim()).filter(Boolean)
          tools.push(...items)
        }
      }
    }

    // Frontmatter name is canonical \u2014 use it unless the caller explicitly named the skill.
    if (!providedName && frontmatterName) {
      name = frontmatterName
    }
    if (frontmatterDescription) {
      description = frontmatterDescription
    }

    // A heading may still supply the name when neither an explicit name nor a
    // frontmatter name is available (e.g. plain markdown files without frontmatter).
    const allowHeadingName = !providedName && !frontmatterName

    // Iterate only the body (frontmatter already stripped) so frontmatter lines
    // are never mistaken for a heading or description.
    for (const line of bodyText.split('\n')) {
      const lineTrimmed = line.trim()
      if (!lineTrimmed) continue
      // First heading is the name (only when no explicit/frontmatter name)
      if (allowHeadingName && (!name || name === fallbackName)) {
        const headingMatch = lineTrimmed.match(/^#+\s+(.+)$/)
        if (headingMatch) {
          name = headingMatch[1].trim()
          continue
        }
      }
      // First non-empty, non-heading line is the description (only if not already set from frontmatter)
      if (!lineTrimmed.startsWith('#') && !description) {
        description = lineTrimmed.substring(0, 200)
        break
      }
    }

    return { name: name || fallbackName, description, tools }
  }

  private createSkillId (value: string): string {
    return 'skill_' + value
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 40) +
      '_' + Date.now().toString(36)
  }

  private ensureSkillDir (id: string): string {
    const skillDir = path.join(this.dir, id)
    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true })
    }
    return skillDir
  }

  private saveSkillMeta (id: string, data: {
    name: string
    description: string
    content: string
    files: SkillFile[]
    scripts: SkillScript[]
    tools: string[]
  }): Skill {
    const timestamp = new Date().toISOString()
    const skill: Skill = {
      id,
      name: data.name,
      description: data.description,
      content: data.content,
      files: data.files,
      scripts: data.scripts,
      tools: data.tools,
      createdAt: timestamp,
      updatedAt: timestamp
    }

    const metaPath = path.join(this.dir, id, 'meta.json')
    fs.writeFileSync(metaPath, JSON.stringify(skill, null, 2), 'utf-8')
    return skill
  }

  private classifyFile (relativePath: string): SkillFile['type'] {
    const ext = path.extname(relativePath).toLowerCase()
    if (ext === '.md' || ext === '.markdown' || ext === '.mdx' || ext === '.txt') return 'markdown'
    if (SCRIPT_EXTENSIONS[ext]) return 'script'
    if (['.json', '.yaml', '.yml', '.toml', '.ini'].includes(ext)) return 'config'
    if (TEXT_FILE_EXTENSIONS.has(ext)) return 'code'
    return 'other'
  }

  private detectScripts (files: SkillFile[]): SkillScript[] {
    return files
      .filter(f => f.type === 'script')
      .map(f => ({
        relativePath: f.relativePath,
        language: SCRIPT_EXTENSIONS[path.extname(f.relativePath).toLowerCase()] || 'unknown'
      }))
  }

  private pickPrimaryFile (files: SkillFile[]): SkillFile | null {
    if (files.length === 0) return null
    // Prefer primary named markdown files
    const mdFiles = files.filter(f => f.type === 'markdown')
    for (const primaryName of PRIMARY_SKILL_FILE_NAMES) {
      const found = mdFiles.find(f => path.basename(f.relativePath).toLowerCase() === primaryName)
      if (found) return found
    }
    // Any markdown file
    if (mdFiles.length > 0) return mdFiles[0]
    // Any text file
    return files[0]
  }

  private async copyDirectoryContents (srcDir: string, destDir: string, relativeTo?: string): Promise<SkillFile[]> {
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true })
    }
    const root = relativeTo || srcDir
    const allFiles: SkillFile[] = []
    const entries = await fsPromises.readdir(srcDir, { withFileTypes: true })

    for (const entry of entries) {
      // Skip hidden files and macOS metadata
      if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue

      const srcPath = path.join(srcDir, entry.name)
      const destPath = path.join(destDir, entry.name)
      const relativePath = path.relative(root, srcPath).replace(/\\/g, '/')

      if (entry.isDirectory()) {
        const subFiles = await this.copyDirectoryContents(srcPath, destPath, root)
        allFiles.push(...subFiles)
      } else {
        await fsPromises.copyFile(srcPath, destPath)
        const stat = await fsPromises.stat(destPath)
        allFiles.push({
          relativePath,
          type: this.classifyFile(entry.name),
          size: stat.size
        })
      }
    }

    return allFiles
  }

  private stripCommonPrefix (paths: string[]): string[] {
    if (paths.length <= 1) return paths.map(p => p.replace(/\\/g, '/'))
    const normalized = paths.map(p => p.replace(/\\/g, '/'))
    const parts = normalized[0].split('/')
    let prefixLen = 0
    for (let i = 0; i < parts.length - 1; i++) {
      const prefix = parts.slice(0, i + 1).join('/') + '/'
      if (normalized.every(p => p.startsWith(prefix))) {
        prefixLen = prefix.length
      } else {
        break
      }
    }
    return normalized.map(p => p.slice(prefixLen) || path.posix.basename(p))
  }

  private sanitizeFileName (name: string): string {
    return name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 50)
  }

  /** Convert a legacy flat JSON skill to the new format. */
  private migrateLegacySkill (raw: Record<string, unknown>): Skill {
    return {
      id: String(raw.id || ''),
      name: String(raw.name || ''),
      description: String(raw.description || ''),
      content: String(raw.content || ''),
      files: [],
      scripts: [],
      tools: [],
      createdAt: String(raw.createdAt || ''),
      updatedAt: String(raw.updatedAt || '')
    }
  }
}
