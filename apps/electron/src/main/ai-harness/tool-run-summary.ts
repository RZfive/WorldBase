/**
 * Compact one-line summaries for tool-run rows in the chat transcript.
 *
 * Rust's ToolCall event carries the full tool arguments, but most of them are
 * noise for a title row (full file contents, patch bodies, timeouts), so each
 * tool family picks only its identifying fields. Returns '' when nothing
 * meaningful can be shown — the renderer then falls back to the bare tool
 * name, which also keeps every conversation produced before this field
 * existed unchanged.
 */

const MAX_SUMMARY_CHARS = 72

function argString (args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

function clamp (text: string, max: number = MAX_SUMMARY_CHARS): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length === 0) return ''
  if (compact.length <= max) return compact
  return `${compact.slice(0, max - 1).trimEnd()}…`
}

function joinParts (parts: string[]): string {
  return clamp(parts.map(part => part.trim()).filter(Boolean).join(' · '))
}

function filePathSummary (args: Record<string, unknown>): string {
  const path = argString(args, 'file_path')
  const startLine = typeof args.start_line === 'number' ? Math.trunc(args.start_line) : 0
  return path && startLine > 0 ? `${path}:${startLine}` : path
}

function commandSummary (args: Record<string, unknown>): string {
  return clamp(argString(args, 'command'))
}

/**
 * File-operation tools whose row can open the target file in a workspace tab.
 * Kept to workspace-scoped and local file tools: project tools resolve their
 * paths against a project root the renderer's tab opener does not know.
 */
const FILE_PATH_TOOLS = new Set([
  'read_workspace_file',
  'write_workspace_file',
  'edit_workspace_file',
  'patch_workspace_file',
  'delete_workspace_file',
  'local_read_file',
  'local_write_file'
])

/**
 * Full target path for a file-operation tool run. The summary is
 * display-clamped, so the clickable affordance must carry the raw argument
 * instead of a possibly truncated title.
 */
export function filePathForToolRun (name: string, args: unknown): string {
  if (!FILE_PATH_TOOLS.has(name)) return ''
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
  const record = args as Record<string, unknown>
  return argString(record, 'file_path') || argString(record, 'path')
}

function patternSummary (args: Record<string, unknown>, withInclude: boolean): string {
  const parts = [argString(args, 'pattern'), argString(args, 'dir_path')]
  if (withInclude) parts.push(argString(args, 'include_pattern'))
  return joinParts(parts)
}

function interactTarget (args: Record<string, unknown>): string {
  const selector = argString(args, 'selector')
  if (selector) return selector
  const label = argString(args, 'label')
  if (label) return clamp(label, 40)
  const value = argString(args, 'value')
  if (value) return clamp(value, 40)
  return ''
}

export function buildToolRunSummary (name: string, args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
  const a = args as Record<string, unknown>

  switch (name) {
    case 'grep_search':
    case 'grep_workspace':
      return patternSummary(a, true)
    case 'glob_workspace':
      return patternSummary(a, false)
    case 'read_workspace_file':
    case 'read_project_file':
      return clamp(filePathSummary(a))
    case 'edit_workspace_file':
    case 'edit_project_file':
      return joinParts([argString(a, 'file_path'), a.replace_all === true ? 'replace_all' : ''])
    case 'patch_project_file': {
      const patchCount = Array.isArray(a.patches) ? a.patches.length : 0
      return joinParts([argString(a, 'file_path'), patchCount > 0 ? `${patchCount} patches` : ''])
    }
    case 'write_project_file':
    case 'write_workspace_file':
      return clamp(argString(a, 'file_path'))
    case 'list_project_files':
    case 'list_workspace_files':
      return clamp(argString(a, 'dir_path'))
    case 'run_workspace_command':
    case 'run_shell_command':
    case 'run_project_command':
    case 'local_run_command':
      return commandSummary(a)
    case 'write_active_terminal':
      return clamp(argString(a, 'text'))
    case 'fetch_webpage': {
      const urls = Array.isArray(a.urls) ? a.urls.filter((url): url is string => typeof url === 'string') : []
      if (urls.length === 0) return ''
      const first = clamp(urls[0])
      return urls.length > 1 ? `${first} +${urls.length - 1}` : first
    }
    case 'interact_current_page': {
      const action = argString(a, 'action')
      return joinParts([action, interactTarget(a)])
    }
    case 'call_project_api':
      return joinParts([argString(a, 'method'), argString(a, 'path')])
    default:
      // mcp__* rows clean up their display name in the renderer; the tools
      // deliberately left bare (rebuild_project, open_workspace_tab, todo,
      // memory, page/terminal reads) have no meaningful arguments.
      return ''
  }
}
