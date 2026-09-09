import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LOCAL_COMMAND_DISCOVERY_CANDIDATES, PROJECT_COMMAND_WHITELIST } from '../tools/command-capabilities.js'

let cachedEnvironmentContext: string | null = null
let cachedEnvironmentKey: string | null = null

export function getEnvironmentContext (): string {
  const cacheKey = [
    process.platform,
    process.arch,
    process.version,
    process.env.PATH || '',
    process.env.SHELL || '',
    process.env.ComSpec || ''
  ].join('|')

  if (cachedEnvironmentContext && cachedEnvironmentKey === cacheKey) {
    return cachedEnvironmentContext
  }

  const lines = [
    '## Authoritative runtime environment',
    'This section is generated from the current Electron main process. If custom agent instructions, memory, logs, or older summaries mention a conflicting OS, cwd, shell, or home directory, prefer this section.',
    '',
    `- Operating system: ${formatOperatingSystem()}`,
    `- Node.js: ${process.version}`,
    `- Electron: ${process.versions.electron || 'unknown'}`,
    `- Default shell: ${process.env.SHELL || process.env.ComSpec || 'unknown'}`,
    `- AI process working directory: ${process.cwd()}`,
    `- User home directory: ${os.homedir()}`,
    `- Temporary directory: ${os.tmpdir()}`,
    '',
    '### Known available local commands',
    `- ${formatCommandList(discoverAvailableCommands(LOCAL_COMMAND_DISCOVERY_CANDIDATES))}`,
    '',
    '### Project command-tool limits',
    '- The rules below apply when the corresponding project/local command tools are visible in the current tool list.',
    `- run_project_command allows only: ${PROJECT_COMMAND_WHITELIST.join(', ')}`,
    '- When you run npm / npx directly (diagnostics, or a fallback install/build), use npm / npx by default inside generated projects; do not assume pnpm / yarn is available at runtime. For project install / build / serve prefer the dedicated tools (create_project, rebuild_project, start_project_server) over manual npm commands.',
    '- Use list_project_files for project exploration and read_project_file for file contents; do not use run_project_command as a substitute for ls/find/dir',
    '- Use get_project_status first for runtime debugging and inspect last_error_summary / last_error_excerpt / recommended_next_debug_step before falling back to get_project_logs for raw stderr tails; after app edits, use rebuild_project directly and do not use start_async_task/get_task_status for builds',
    '- Use start_project_server or restart_project_server for long-lived servers instead of run_project_command; call_project_api can wake a stopped project automatically',
    '- Use open_project_app when the goal is to show a project in WorldBase shell; do not launch your own unmanaged preview server just to present the app',
    '- If run_project_command returns reason=timeout, treat it as still running in the background and query it with get_project_command_status before retrying',
    '- Ignore the warning "ExperimentalWarning: SQLite is an experimental feature" unless another error follows it',
    "- local_run_command executes through the user's shell, with a default timeout of 60 seconds and a maximum of 300 seconds",
    '- local_run_command defaults to the user home directory when cwd is omitted; prefer absolute paths for local_read_file / local_write_file',
    '- If a command is known to exist, use it directly; do not repeatedly probe the environment just to confirm availability'
  ]

  cachedEnvironmentContext = lines.join('\n')
  cachedEnvironmentKey = cacheKey
  return cachedEnvironmentContext
}

function formatOperatingSystem (): string {
  return `${os.platform()} ${os.release()} (${os.type()}, ${os.arch()})`
}

function formatCommandList (commands: string[]): string {
  if (commands.length === 0) {
    return 'No candidate commands were detected. Only use commands explicitly supported by the tools.'
  }

  return commands.join(', ')
}

function discoverAvailableCommands (candidates: string[]): string[] {
  const uniqueCandidates = Array.from(new Set(candidates))
  return uniqueCandidates.filter(command => resolveCommandPath(command) !== null)
}

function resolveCommandPath (command: string): string | null {
  const pathValue = process.env.PATH || ''
  if (!pathValue) {
    return null
  }

  const searchPaths = pathValue.split(path.delimiter).filter(Boolean)
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
        .split(';')
        .filter(Boolean)
    : ['']

  const commandHasExtension = path.extname(command) !== ''

  for (const searchPath of searchPaths) {
    for (const extension of extensions) {
      const suffix = process.platform === 'win32' && !commandHasExtension ? extension : ''
      const resolvedPath = path.join(searchPath, `${command}${suffix}`)
      if (isExecutableFile(resolvedPath)) {
        return resolvedPath
      }
    }
  }

  return null
}

function isExecutableFile (filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) {
      return false
    }

    if (process.platform === 'win32') {
      return true
    }

    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}
