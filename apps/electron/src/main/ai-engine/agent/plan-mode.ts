/**
 * Plan Mode — 规划模式
 *
 * 让 Agent 在复杂任务中先规划、再执行，减少错误和返工。
 * 进入 Plan 模式后，写入类工具被禁用，Agent 只能读取/搜索/拟定计划。
 * 退出 Plan 模式后按计划执行。
 */

export interface PlanStep {
  description: string
  files?: string[]
}

export interface Plan {
  goal: string
  summary: string
  steps: PlanStep[]
  createdAt: number
}

export class PlanEngine {
  private _active = false
  private _currentPlan: Plan | null = null

  /** 写入类工具 — Plan 模式下禁止调用 */
  private static readonly WRITE_TOOLS = new Set([
    'create_project',
    'write_project_file',
    'patch_project_file',
    'delete_project_file',
    'run_project_command',
    'write_workspace_file',
    'edit_workspace_file',
    'patch_workspace_file',
    'delete_workspace_file',
    'run_workspace_command',
    'install_dependencies',
    'install_skill',
    'install_mcp_server',
    'rebuild_project',
    'start_project_server',
    'restart_project_server',
    'clear_project_build_flag',
    'computer_observe',
    'computer_action'
  ])

  get active (): boolean {
    return this._active
  }

  get currentPlan (): Plan | null {
    return this._currentPlan
  }

  enter (goal: string): { success: boolean; message: string } {
    if (this._active) {
      return { success: false, message: '已经处于规划模式中。请先退出当前规划模式再重新进入。' }
    }
    this._active = true
    this._currentPlan = null
    return {
      success: true,
      message: `已进入规划模式。目标: ${goal}\n\n在此模式下你只能使用读取和搜索工具来分析代码，制定修改计划。准备好后调用 exit_plan_mode 提交计划并开始执行。`
    }
  }

  exit (planSummary: string, steps: PlanStep[]): { success: boolean; message: string; plan?: Plan } {
    if (!this._active) {
      return { success: false, message: '当前不在规划模式中。' }
    }
    const plan: Plan = {
      goal: planSummary,
      summary: planSummary,
      steps,
      createdAt: Date.now()
    }
    this._currentPlan = plan
    this._active = false
    const stepList = steps.map((s, i) => `${i + 1}. ${s.description}${s.files?.length ? ` (${s.files.join(', ')})` : ''}`).join('\n')
    return {
      success: true,
      message: `已退出规划模式，计划已确认。共 ${steps.length} 个步骤:\n${stepList}\n\n现在按计划逐步执行。`,
      plan
    }
  }

  /** 检查某个工具是否在 Plan 模式下允许执行 */
  isToolAllowed (toolName: string): boolean {
    if (!this._active) return true
    if (toolName === 'mcp_call' || toolName.startsWith('mcp__')) return false
    // Plan 模式下只禁止写入类工具
    return !PlanEngine.WRITE_TOOLS.has(toolName)
  }

  /** 重置状态 */
  reset (): void {
    this._active = false
    this._currentPlan = null
  }
}
