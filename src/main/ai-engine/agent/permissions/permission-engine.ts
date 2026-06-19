import type { BrowserWindow } from 'electron'
import type { SessionState } from '../agent-core.js'
import { requestUserAuth } from '../tools/user-auth.js'

/**
 * Permission decision for a tool invocation.
 */
export interface PermissionCheckResult {
  allowed: boolean
  reason: string
  askedUser: boolean
  rule?: PermissionRule
}

/**
 * A permission rule that can be configured by the user.
 */
export interface PermissionRule {
  /** Tool name, or '*' for all tools. */
  tool: string
  /** Optional argument-level pattern (e.g. a regex string for command matching). */
  argPattern?: string
  /** Which argument field the pattern applies to. */
  argField?: string
  /** Decision to apply when this rule matches. */
  decision: 'allow' | 'deny' | 'ask'
  /** Human-readable reason shown to the user. */
  reason?: string
}

/**
 * Context provided during permission checking.
 */
export interface PermissionContext {
  getMainWindow?: () => BrowserWindow | null
  getSessionState?: () => SessionState
  getAbortSignal?: () => AbortSignal | undefined
}

/**
 * Safety classification of a tool invocation.
 */
type SafetyLevel = 'safe' | 'risky' | 'deny'

/**
 * Built-in safety rules for command-based tools.
 */
interface CommandSafetyRule {
  pattern: RegExp
  level: SafetyLevel
  reason?: string
}

const COMMAND_SAFETY_RULES: CommandSafetyRule[] = [
  // Safe: read-only commands
  { pattern: /^(cat|head|tail|wc|ls|find|grep|echo|pwd|which|type|file)\b/, level: 'safe' },
  // Safe: package manager reads
  { pattern: /^npm (list|ls|outdated|audit|info|view|pack|explain|why)\b/, level: 'safe' },
  { pattern: /^node -[ce]\b/, level: 'safe' },
  { pattern: /^node --check\b/, level: 'safe' },
  { pattern: /^git (status|log|diff|show|branch|tag|remote|stash list)\b/, level: 'safe' },
  // Risky: package installation
  { pattern: /^npm (install|i|ci|add|remove|uninstall)\b/, level: 'risky', reason: '包管理器写操作' },
  // Risky: git write operations
  { pattern: /^git (push|reset|rebase|merge|checkout|clean)\b/, level: 'risky', reason: 'Git 写操作' },
  // Risky: build commands
  { pattern: /^npm run (build|dev|start|test)\b/, level: 'risky', reason: '可能修改文件系统' },
  // Deny: destructive commands
  { pattern: /\brm\s+(-[rRf]+\s+|--recursive)/, level: 'deny', reason: '递归删除操作' },
  { pattern: /\bchmod\s+777\b/, level: 'deny', reason: '不安全的权限修改' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh\b/, level: 'deny', reason: '远程代码执行' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh\b/, level: 'deny', reason: '远程代码执行' },
  { pattern: /\b(mkfs|fdisk|dd\s)\b/, level: 'deny', reason: '磁盘操作' }
]

/**
 * Tools that are always safe (read-only, project-scoped).
 */
const ALWAYS_SAFE_TOOLS = new Set([
  'read_project_file',
  'list_project_files',
  'read_workspace_file',
  'list_workspace_files',
  'glob_workspace',
  'grep_workspace',
  'get_workspace_command_status',
  'list_projects',
  'list_scheduled_tasks',
  'manage_todo_list',
  'ask_user',
  'get_project_status',
  'get_project_logs',
  'get_project_command_status',
  'query_project_database',
  'glob_search',
  'grep_search',
  'web_search',
  'fetch_webpage',
  'read_current_page',
  'list_documents',
  'mcp_list_servers',
  'mcp_list_resources',
  'mcp_read_resource',
  'mcp_list_prompts',
  'mcp_get_prompt'
])

/**
 * Tools that require user confirmation by default.
 */
const HIGH_RISK_TOOLS = new Set([
  'local_file_read',
  'local_file_write',
  'local_run_command',
  'interact_current_page'
])

/**
 * PermissionEngine — 多层权限决策链
 *
 * Decision flow:
 * 1. Schema validation (done by tool argument parsing before this point)
 * 2. Always-safe tool check
 * 3. User-configured rules (allow/deny/ask)
 * 4. Auto-classification (command safety analysis)
 * 5. High-risk tool check → ask user
 * 6. Default: allow (project-scoped tools are safe by design)
 */
export class PermissionEngine {
  private rules: PermissionRule[] = []
  private context: PermissionContext

  constructor (context: PermissionContext) {
    this.context = context
  }

  /**
   * Load user-configured permission rules.
   */
  loadRules (rules: PermissionRule[]): void {
    this.rules = [...rules]
  }

  /**
   * Add a single permission rule.
   */
  addRule (rule: PermissionRule): void {
    this.rules.push(rule)
  }

  /**
   * Execute the full permission decision chain for a tool invocation.
   */
  async check (
    toolName: string,
    args: Record<string, unknown>
  ): Promise<PermissionCheckResult> {
    // Layer 1: Always-safe tools
    if (ALWAYS_SAFE_TOOLS.has(toolName)) {
      return { allowed: true, reason: 'Read-only tool', askedUser: false }
    }

    // Layer 2: User-configured rules (first match wins)
    const ruleResult = this._matchRules(toolName, args)
    if (ruleResult) {
      if (ruleResult.decision === 'allow') {
        return { allowed: true, reason: ruleResult.reason || 'Allowed by rule', askedUser: false, rule: ruleResult.rule }
      }
      if (ruleResult.decision === 'deny') {
        return { allowed: false, reason: ruleResult.reason || 'Denied by rule', askedUser: false, rule: ruleResult.rule }
      }
      // decision === 'ask' → fall through to user confirmation
      const approved = await this._askUser(toolName, args, ruleResult.reason || '规则要求用户确认')
      return { allowed: approved, reason: ruleResult.reason || 'User decision', askedUser: true, rule: ruleResult.rule }
    }

    // Layer 3: Auto-classification for command tools
    if (toolName === 'run_project_command' || toolName === 'run_workspace_command' || toolName === 'local_run_command') {
      const command = String(args.command || '')
      const classification = this._classifyCommand(command)

      if (classification.level === 'deny') {
        return {
          allowed: false,
          reason: classification.reason || '命令被安全策略禁止',
          askedUser: false
        }
      }

      if (classification.level === 'risky') {
        const approved = await this._askUser(toolName, args, classification.reason || '该命令需要确认')
        return { allowed: approved, reason: classification.reason || 'Risky command', askedUser: true }
      }

      // 'safe' → allow
      if (classification.level === 'safe') {
        return { allowed: true, reason: 'Safe command', askedUser: false }
      }
    }

    if (toolName.startsWith('mcp__')) {
      const approved = await this._askUser(toolName, args, '该操作会调用外部 MCP 服务')
      return { allowed: approved, reason: 'External MCP tool invocation', askedUser: true }
    }

    if (toolName === 'install_skill') {
      const approved = await this._askUser(toolName, args, '该操作会把 Skill 安装到本地应用，并可在当前会话中立即启用')
      return { allowed: approved, reason: 'Skill installation requires confirmation', askedUser: true }
    }

    if (toolName === 'install_mcp_server') {
      const approved = await this._askUser(toolName, args, '该操作会写入 MCP 服务配置，并可能立即连接外部服务')
      return { allowed: approved, reason: 'MCP installation requires confirmation', askedUser: true }
    }

    if (toolName === 'create_scheduled_task') {
      const approved = await this._askUser(toolName, args, '该操作会创建一个会自动运行的 AI 定时任务')
      return { allowed: approved, reason: 'Scheduled task creation requires confirmation', askedUser: true }
    }

    // Layer 4: High-risk tools → always ask
    if (HIGH_RISK_TOOLS.has(toolName)) {
      const approved = await this._askUser(
        toolName,
        args,
        '该操作需要访问本地系统资源'
      )
      return { allowed: approved, reason: 'High-risk tool requires confirmation', askedUser: true }
    }

    // Layer 5: Default allow (project-scoped tools)
    return { allowed: true, reason: 'Default allow (project-scoped)', askedUser: false }
  }

  /**
   * Match user-configured rules against a tool invocation.
   */
  private _matchRules (
    toolName: string,
    args: Record<string, unknown>
  ): { decision: 'allow' | 'deny' | 'ask'; reason?: string; rule: PermissionRule } | null {
    for (const rule of this.rules) {
      // Match tool name
      if (rule.tool !== '*' && rule.tool !== toolName) continue

      // Match argument pattern if specified
      if (rule.argPattern && rule.argField) {
        const argValue = String(args[rule.argField] || '')
        try {
          const regex = new RegExp(rule.argPattern, 'i')
          if (!regex.test(argValue)) continue
        } catch {
          continue
        }
      }

      return { decision: rule.decision, reason: rule.reason, rule }
    }

    return null
  }

  /**
   * Classify a command string by safety level using built-in rules.
   */
  private _classifyCommand (command: string): { level: SafetyLevel; reason?: string } {
    const trimmedCommand = command.trim()

    for (const rule of COMMAND_SAFETY_RULES) {
      if (rule.pattern.test(trimmedCommand)) {
        return { level: rule.level, reason: rule.reason }
      }
    }

    // Unknown command → risky by default (require user confirmation)
    return { level: 'risky', reason: '未识别的命令类型' }
  }

  /**
   * Ask the user for permission via renderer-side dialog.
   */
  private async _askUser (
    toolName: string,
    args: Record<string, unknown>,
    reason: string
  ): Promise<boolean> {
    const title = `工具 ${toolName} 需要授权`
    const detail = this._buildAuthDetail(toolName, args, reason)

    return requestUserAuth(
      this.context.getMainWindow,
      this.context.getSessionState,
      this.context.getAbortSignal,
      title,
      detail
    )
  }

  /**
   * Build a human-readable detail string for the auth dialog.
   */
  private _buildAuthDetail (
    toolName: string,
    args: Record<string, unknown>,
    reason: string
  ): string {
    const parts = [reason]

    if (toolName === 'run_project_command' || toolName === 'run_workspace_command' || toolName === 'local_run_command') {
      parts.push(`命令: ${String(args.command || '').slice(0, 200)}`)
    } else if (toolName === 'local_file_read' || toolName === 'local_file_write') {
      parts.push(`文件: ${String(args.file_path || '').slice(0, 200)}`)
    } else {
      const argSummary = Object.entries(args)
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
        .join(', ')
      if (argSummary) parts.push(`参数: ${argSummary}`)
    }

    return parts.join('\n')
  }
}
