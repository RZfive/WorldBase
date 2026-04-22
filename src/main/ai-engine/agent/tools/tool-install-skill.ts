import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import type { SkillEngine } from '../skill-engine.js'
import type { SkillStore } from '../../../settings/skill-store.js'

interface ToolServices {
  skillStore?: SkillStore
  notifySkillsChanged?: (event: { action: string; count?: number; id?: string }) => void
}

interface InstallSkillArgs {
  name?: string
  content: string
  description?: string
  activate_now?: boolean
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

function normalizeSkillName (value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function toolInstallSkill (services: ToolServices, getSkillEngine: () => SkillEngine): Tool {
  return {
    definition: {
      name: 'install_skill',
      description: 'Install a Skill into the app from raw markdown or text content. After user approval, the skill is saved locally and can be activated immediately for the current conversation.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Optional display name for the Skill. If omitted, the skill title/frontmatter is used when available.'
          },
          content: {
            type: 'string',
            description: 'Full skill markdown/text content to install.'
          },
          description: {
            type: 'string',
            description: 'Optional short description override.'
          },
          activate_now: {
            type: 'boolean',
            description: 'Whether to register the installed skill into the current conversation immediately. Defaults to true.'
          }
        },
        required: ['content']
      }
    },
    handler: async (args, onProgress) => {
      if (!services.skillStore) {
        return { error: 'Skill storage is not available in this runtime.' }
      }

      const content = typeof args.content === 'string' ? args.content.trim() : ''
      if (!content) {
        return { error: 'content is required to install a skill.' }
      }

      const fallbackName = normalizeSkillName(args.name) || 'Imported Skill'
      const description = typeof args.description === 'string' ? args.description.trim() : undefined
      const activateNow = args.activate_now !== false

      onProgress?.('🧩 Installing skill...', fallbackName)
      const skill = services.skillStore.importFromContent(fallbackName, content, description)
      services.notifySkillsChanged?.({ action: 'imported', count: 1 })

      let activation: {
        activated: boolean
        skill_name?: string
      } = { activated: false }

      if (activateNow) {
        const registered = getSkillEngine().registerFromContent(skill.content, skill.name)
        activation = {
          activated: true,
          skill_name: registered.name
        }
      }

      onProgress?.('✅ Skill installed', skill.name)

      return {
        success: true,
        installed: {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          created_at: skill.createdAt,
          updated_at: skill.updatedAt
        },
        activation,
        message: activation.activated
          ? `Skill ${skill.name} 已安装，并已在当前会话中可用。`
          : `Skill ${skill.name} 已安装。`
      }
    }
  }
}