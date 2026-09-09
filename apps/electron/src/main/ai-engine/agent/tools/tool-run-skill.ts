import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import type { SkillEngine } from '../skill-engine.js'

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

export function toolRunSkill (getSkillEngine: () => SkillEngine): Tool {
  return {
    definition: {
      name: 'run_skill',
      description: '执行一个预定义的 Skill。Skills 包含领域专家知识和工作流程，能帮助你更好地完成特定类型的任务。调用前先查看可用 Skills 列表。',
      parameters: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: 'Skill 名称' },
          arguments: {
            type: 'object',
            description: 'Skill 参数键值对',
            additionalProperties: { type: 'string' }
          }
        },
        required: ['skill_name']
      }
    },
    handler: async (args) => {
      const skillName = String(args.skill_name || '')
      if (!skillName) {
        return { error: '必须提供 skill_name' }
      }

      const skillEngine = getSkillEngine()
      const skillArgs = (args.arguments && typeof args.arguments === 'object')
        ? Object.fromEntries(
            Object.entries(args.arguments as Record<string, unknown>).map(([k, v]) => [k, String(v)])
          )
        : {}

      const result = skillEngine.executeInline(skillName, skillArgs)
      if (!result.success) {
        return { error: result.output }
      }

      return {
        skill: skillName,
        context: result.context,
        instructions: result.output
      }
    }
  }
}

export function toolListSkills (getSkillEngine: () => SkillEngine): Tool {
  return {
    definition: {
      name: 'list_skills',
      description: '列出所有可用的 Skills 及其描述和参数信息。',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    handler: async () => {
      const skills = getSkillEngine().listRegistered()
      if (skills.length === 0) {
        return { message: '当前没有可用的 Skills。', skills: [] }
      }

      return {
        skills: skills.map(s => ({
          name: s.name,
          description: s.description,
          whenToUse: s.whenToUse,
          arguments: s.arguments?.map(a => ({
            name: a.name,
            description: a.description,
            required: a.required ?? false
          })),
          context: s.context
        }))
      }
    }
  }
}
