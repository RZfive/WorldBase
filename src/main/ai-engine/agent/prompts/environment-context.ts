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
    '## 当前系统环境（启动前注入）',
    '',
    `- 操作系统: ${formatOperatingSystem()}`,
    `- Node.js: ${process.version}`,
    `- Electron: ${process.versions.electron || '未知'}`,
    `- 默认 Shell: ${process.env.SHELL || process.env.ComSpec || '未知'}`,
    `- AI 进程工作目录: ${process.cwd()}`,
    `- 用户主目录: ${os.homedir()}`,
    `- 临时目录: ${os.tmpdir()}`,
    '',
    '### 已知可用的本地命令',
    `- ${formatCommandList(discoverAvailableCommands(LOCAL_COMMAND_DISCOVERY_CANDIDATES))}`,
    '',
    '### 项目内命令工具限制',
    `- run_project_command 仅允许: ${PROJECT_COMMAND_WHITELIST.join(', ')}`,
    '- local_run_command 会在用户本机通过 shell 执行命令，默认超时 60 秒，最大 300 秒',
    '- local_run_command 未指定 cwd 时默认使用用户主目录；local_read_file / local_write_file 传参时应优先使用绝对路径',
    '- 对于已知存在的命令，直接使用；不要先用“试探命令是否存在”的方式反复探测环境'
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
    return '未检测到候选命令，请仅使用工具说明中明确支持的命令'
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
