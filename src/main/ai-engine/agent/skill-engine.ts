/**
 * Skill Engine — Skills 系统增强
 *
 * 支持 YAML frontmatter 解析、参数替换、fork/inline 执行上下文。
 * 与 SkillStore 协同工作，为 Agent 提供 run_skill 工具。
 */

export interface SkillArgument {
  name: string
  description: string
  required?: boolean
}

export interface SkillDefinition {
  name: string
  description: string
  whenToUse?: string
  arguments?: SkillArgument[]
  allowedTools?: string[]
  context: 'fork' | 'inline'
  content: string
}

export interface SkillExecutionResult {
  success: boolean
  output: string
  skillName: string
  context: 'fork' | 'inline'
}

/**
 * 解析 Markdown 文件的 YAML frontmatter 部分。
 * 格式: 文件以 `---` 开头，再以 `---` 结束 frontmatter 部分。
 */
export function parseYamlFrontmatter (raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const trimmed = raw.replace(/^\uFEFF/, '')
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: trimmed }
  }

  const endIndex = trimmed.indexOf('\n---', 3)
  if (endIndex < 0) {
    return { frontmatter: {}, body: trimmed }
  }

  const yamlBlock = trimmed.slice(4, endIndex).trim()
  const body = trimmed.slice(endIndex + 4).trim()
  const frontmatter = parseSimpleYaml(yamlBlock)

  return { frontmatter, body }
}

/**
 * 轻量级 YAML 解析器 — 仅支持 skill frontmatter 用到的子集:
 * - 字符串键值对
 * - 字符串数组 (以 `- value` 形式)
 * - 对象数组 (以 `- key: value` 形式)
 */
function parseSimpleYaml (yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = yaml.split('\n')
  let currentKey = ''
  let currentArray: unknown[] | null = null

  for (const line of lines) {
    // 跳过空行和注释
    if (!line.trim() || line.trim().startsWith('#')) continue

    const topLevelMatch = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (topLevelMatch) {
      // 保存上一个数组
      if (currentKey && currentArray) {
        result[currentKey] = currentArray
      }
      currentKey = topLevelMatch[1]
      const value = topLevelMatch[2].trim()
      if (value) {
        result[currentKey] = value
        currentArray = null
      } else {
        currentArray = []
      }
      continue
    }

    // 数组项
    const arrayItemMatch = line.match(/^\s+-\s+(.+)$/)
    if (arrayItemMatch && currentArray !== null) {
      const itemValue = arrayItemMatch[1].trim()
      // 检查是否是对象项 (key: value)
      const kvMatch = itemValue.match(/^(\w[\w-]*):\s*(.+)$/)
      if (kvMatch) {
        // 可能是对象数组项的开始
        const obj: Record<string, string> = { [kvMatch[1]]: kvMatch[2].trim() }
        // 读取后续缩进更深的行作为同一对象的属性 — 这里简单处理
        currentArray.push(obj)
      } else {
        currentArray.push(itemValue)
      }
      continue
    }

    // 对象数组中的续行属性
    const nestedKvMatch = line.match(/^\s{4,}(\w[\w-]*):\s*(.+)$/)
    if (nestedKvMatch && currentArray !== null && currentArray.length > 0) {
      const lastItem = currentArray[currentArray.length - 1]
      if (lastItem && typeof lastItem === 'object' && !Array.isArray(lastItem)) {
        (lastItem as Record<string, string>)[nestedKvMatch[1]] = nestedKvMatch[2].trim()
      }
      continue
    }
  }

  // 保存最后一个数组
  if (currentKey && currentArray) {
    result[currentKey] = currentArray
  }

  return result
}

export class SkillEngine {
  private registry = new Map<string, SkillDefinition>()

  /** 从原始 skill 内容解析为 SkillDefinition */
  parseSkill (rawContent: string, fallbackName?: string): SkillDefinition {
    const { frontmatter, body } = parseYamlFrontmatter(rawContent)

    const name = String(frontmatter.name || fallbackName || 'unnamed-skill')
    const description = String(frontmatter.description || '')
    const whenToUse = frontmatter.whenToUse ? String(frontmatter.whenToUse) : undefined
    const context = frontmatter.context === 'fork' ? 'fork' : 'inline'

    let args: SkillArgument[] | undefined
    if (Array.isArray(frontmatter.arguments)) {
      args = (frontmatter.arguments as Array<Record<string, unknown>>).map(a => ({
        name: String(a.name || ''),
        description: String(a.description || ''),
        required: a.required === true || String(a.required || '').toLowerCase() === 'true'
      })).filter(a => a.name)
    }

    let allowedTools: string[] | undefined
    if (Array.isArray(frontmatter.allowedTools)) {
      allowedTools = (frontmatter.allowedTools as string[]).map(String)
    }

    return { name, description, whenToUse, arguments: args, allowedTools, context, content: body }
  }

  /** 注册一个 Skill */
  register (skill: SkillDefinition): void {
    this.registry.set(skill.name, skill)
  }

  /** 从原始内容注册 */
  registerFromContent (rawContent: string, fallbackName?: string): SkillDefinition {
    const skill = this.parseSkill(rawContent, fallbackName)
    this.register(skill)
    return skill
  }

  /** 获取已注册的 Skill */
  get (name: string): SkillDefinition | undefined {
    return this.registry.get(name)
  }

  /** 列表所有已注册的 Skills */
  listRegistered (): SkillDefinition[] {
    return Array.from(this.registry.values())
  }

  /** 参数替换: ${arg_name} → 实际值 */
  substituteArguments (template: string, args: Record<string, string>): string {
    return template.replace(/\$\{(\w[\w-]*)\}/g, (_match, argName: string) => {
      return args[argName] ?? `\${${argName}}`
    })
  }

  /**
   * 执行 Skill (inline 模式):
   * 将 skill 内容注入当前对话的 system prompt，参数替换后返回
   */
  executeInline (skillName: string, args: Record<string, string>): SkillExecutionResult {
    const skill = this.registry.get(skillName)
    if (!skill) {
      return { success: false, output: `Skill '${skillName}' not found.`, skillName, context: 'inline' }
    }

    // 校验必须参数
    if (skill.arguments) {
      for (const arg of skill.arguments) {
        if (arg.required && !args[arg.name]) {
          return {
            success: false,
            output: `Missing required argument '${arg.name}': ${arg.description}`,
            skillName,
            context: 'inline'
          }
        }
      }
    }

    const content = this.substituteArguments(skill.content, args)
    return {
      success: true,
      output: content,
      skillName,
      context: 'inline'
    }
  }

  /** 清除所有注册 */
  clear (): void {
    this.registry.clear()
  }
}
