import fs from 'node:fs'
import path from 'node:path'

export interface Skill {
  id: string
  name: string
  description: string
  content: string
  createdAt: string
  updatedAt: string
}

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

  /** Import a skill from a markdown file path. */
  importFromFile (filePath: string): Skill {
    const content = fs.readFileSync(filePath, 'utf-8')
    const baseName = path.basename(filePath, path.extname(filePath))

    // Parse name and description from markdown content
    const { name, description } = this.parseSkillMeta(content, baseName)

    const id = 'skill_' + baseName
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 40) +
      '_' + Date.now().toString(36)

    const skill: Skill = {
      id,
      name,
      description,
      content,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(skill, null, 2), 'utf-8')
    return skill
  }

  /** Import a skill from raw content. */
  importFromContent (name: string, content: string, description?: string): Skill {
    const id = 'skill_' + name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 40) +
      '_' + Date.now().toString(36)

    const skill: Skill = {
      id,
      name,
      description: description || this.parseSkillMeta(content, name).description,
      content,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(skill, null, 2), 'utf-8')
    return skill
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
}
