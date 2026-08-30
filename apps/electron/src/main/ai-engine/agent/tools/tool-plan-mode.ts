import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import type { PlanEngine } from '../plan-mode.js'

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

export function toolEnterPlanMode (getPlanEngine: () => PlanEngine): Tool {
  return {
    definition: {
      name: 'enter_plan_mode',
      description: '进入规划模式。在此模式下你只能读取和搜索代码，制定修改计划。计划确认后才能开始执行修改。当任务涉及多个文件或复杂逻辑时应先进入规划模式。',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: '本次规划的目标描述' }
        },
        required: ['goal']
      }
    },
    handler: async (args) => {
      const goal = String(args.goal || '')
      if (!goal) {
        return { error: '必须提供规划目标 (goal)' }
      }
      return getPlanEngine().enter(goal)
    }
  }
}

export function toolExitPlanMode (getPlanEngine: () => PlanEngine): Tool {
  return {
    definition: {
      name: 'exit_plan_mode',
      description: '退出规划模式，开始按计划执行修改。',
      parameters: {
        type: 'object',
        properties: {
          plan_summary: { type: 'string', description: '计划摘要' },
          steps: {
            type: 'array',
            description: '计划步骤列表',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string', description: '步骤描述' },
                files: { type: 'array', items: { type: 'string' }, description: '涉及的文件列表' }
              },
              required: ['description']
            }
          }
        },
        required: ['plan_summary', 'steps']
      }
    },
    handler: async (args) => {
      const planSummary = String(args.plan_summary || '')
      if (!planSummary) {
        return { error: '必须提供计划摘要 (plan_summary)' }
      }
      const steps = Array.isArray(args.steps) ? args.steps.map((s: Record<string, unknown>) => ({
        description: String(s.description || ''),
        files: Array.isArray(s.files) ? s.files.map(String) : undefined
      })) : []

      if (steps.length === 0) {
        return { error: '必须提供至少一个步骤 (steps)' }
      }

      return getPlanEngine().exit(planSummary, steps)
    }
  }
}
