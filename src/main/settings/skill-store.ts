import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'

export interface Skill {
  id: string
  name: string
  description: string
  content: string
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

/**
 * SkillStore — 管理用户导入的 AI Skill
 * 存储为 JSON 文件到 userData/skills/ 目录
 */
export class SkillStore {
  private dir: string

  constructor (userDataPath: string) {
    this.dir = path.join(userDataPath, 'skills')
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true })
    }
  }

  /** List all imported skills. */
  list (): Skill[] {
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'))
    const skills: Skill[] = []
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.dir, file), 'utf-8')
        skills.push(JSON.parse(raw) as Skill)
      } catch { /* skip corrupted files */ }
    }
    return skills.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** Get a single skill by ID. */
  get (id: string): Skill | null {
    const filePath = path.join(this.dir, `${id}.json`)
    if (!fs.existsSync(filePath)) return null
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(raw) as Skill
    } catch {
      return null
    }
  }

  /** Import a skill from a markdown/text file or zip package path. */
  async importFromFile (filePath: string): Promise<Skill> {
    const ext = path.extname(filePath).toLowerCase()
    const baseName = path.basename(filePath, path.extname(filePath))
    const fileContent = ext === SKILL_ARCHIVE_EXTENSION ? null : fs.readFileSync(filePath, 'utf-8')
    const source = ext === SKILL_ARCHIVE_EXTENSION
      ? await this.readSkillArchive(filePath)
      : {
          metaContent: fileContent || '',
          content: fileContent || ''
        }

    const { name, description } = this.parseSkillMeta(source.metaContent, baseName)
    return this.saveSkill(baseName, name, description, source.content)
  }

  /** Import a skill from raw content. */
  importFromContent (name: string, content: string, description?: string): Skill {
    const meta = this.parseSkillMeta(content, name)
    return this.saveSkill(
      name,
      meta.name,
      description || meta.description,
      content
    )
  }

  /** Delete a skill by ID. */
  delete (id: string): boolean {
    const filePath = path.join(this.dir, `${id}.json`)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      return true
    }
    return false
  }

  /** Extract name and description from markdown skill content. */
  private parseSkillMeta (content: string, fallbackName: string): { name: string; description: string } {
    let name = fallbackName
    let description = ''

    const lines = content.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      // First heading is the name
      if (!name || name === fallbackName) {
        const headingMatch = trimmed.match(/^#+\s+(.+)$/)
        if (headingMatch) {
          name = headingMatch[1].trim()
          continue
        }
      }
      // First non-empty, non-heading line is the description
      if (trimmed && !trimmed.startsWith('#') && !description) {
        description = trimmed.substring(0, 200)
        break
      }
    }

    return { name: name || fallbackName, description }
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

  private saveSkill (baseName: string, name: string, description: string, content: string): Skill {
    const id = this.createSkillId(baseName)
    const timestamp = new Date().toISOString()
    const skill: Skill = {
      id,
      name,
      description,
      content,
      createdAt: timestamp,
      updatedAt: timestamp
    }

    fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(skill, null, 2), 'utf-8')
    return skill
  }

  private async readSkillArchive (filePath: string): Promise<{ metaContent: string; content: string }> {
    const JSZip = (await import('jszip')).default
    const archive = await JSZip.loadAsync(await fsPromises.readFile(filePath))
    const entries = Object.values(archive.files)
      .filter(entry => !entry.dir)
      .filter(entry => !entry.name.startsWith('__MACOSX/'))
      .filter(entry => this.isSupportedTextFile(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

    if (entries.length === 0) {
      throw new Error('压缩包中未找到可导入的 Skill 文本文件')
    }

    const primaryEntry = this.pickPrimaryArchiveEntry(entries)
    const primaryContent = await primaryEntry.async('text')
    const sections = [this.formatArchiveEntry(primaryEntry.name, primaryContent, true)]

    for (const entry of entries) {
      if (entry.name === primaryEntry.name) continue
      const text = await entry.async('text')
      sections.push(this.formatArchiveEntry(entry.name, text, false))
    }

    return {
      metaContent: primaryContent,
      content: sections.filter(Boolean).join('\n\n')
    }
  }

  private isSupportedTextFile (fileName: string): boolean {
    return TEXT_FILE_EXTENSIONS.has(path.extname(fileName).toLowerCase())
  }

  private pickPrimaryArchiveEntry<T extends { name: string }> (entries: T[]): T {
    return entries.slice().sort((a, b) => {
      const aRank = this.getArchiveEntryRank(a.name)
      const bRank = this.getArchiveEntryRank(b.name)
      return aRank - bRank || a.name.localeCompare(b.name, 'zh-CN')
    })[0]
  }

  private getArchiveEntryRank (entryName: string): number {
    const normalized = entryName.replace(/\\/g, '/').toLowerCase()
    const baseName = path.posix.basename(normalized)
    const ext = path.posix.extname(baseName)

    if (PRIMARY_SKILL_FILE_NAMES.includes(baseName)) return 0
    if (ext === '.md' || ext === '.markdown' || ext === '.mdx') return 1
    if (ext === '.txt') return 2
    return 3
  }

  private formatArchiveEntry (entryName: string, content: string, isPrimary: boolean): string {
    const normalizedContent = content.replace(/\r\n/g, '\n').trim()
    if (!normalizedContent) return ''

    if (isPrimary) {
      return normalizedContent
    }

    const ext = path.extname(entryName).toLowerCase()
    if (ext === '.md' || ext === '.markdown' || ext === '.mdx' || ext === '.txt') {
      return `---\n\n## File: ${entryName}\n\n${normalizedContent}`
    }

    const language = ext.replace(/^\./, '') || 'text'
    return `---\n\n## File: ${entryName}\n\n\`\`\`${language}\n${normalizedContent}\n\`\`\``
  }
}
