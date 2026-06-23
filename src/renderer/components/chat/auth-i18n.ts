import type { ComposerTranslation } from 'vue-i18n'

const REASON_KEY_BY_TEXT: Record<string, string> = {
  '包管理器写操作': 'mainDialog.permissionReasonPackageManagerWrite',
  'Package manager write operation': 'mainDialog.permissionReasonPackageManagerWrite',
  'Git 写操作': 'mainDialog.permissionReasonGitWrite',
  'Git write operation': 'mainDialog.permissionReasonGitWrite',
  '可能修改文件系统': 'mainDialog.permissionReasonMayModifyFileSystem',
  'May modify the file system': 'mainDialog.permissionReasonMayModifyFileSystem',
  '递归删除操作': 'mainDialog.permissionReasonRecursiveDelete',
  'Recursive delete operation': 'mainDialog.permissionReasonRecursiveDelete',
  '不安全的权限修改': 'mainDialog.permissionReasonUnsafePermissionChange',
  'Unsafe permission change': 'mainDialog.permissionReasonUnsafePermissionChange',
  '远程代码执行': 'mainDialog.permissionReasonRemoteCodeExecution',
  'Remote code execution': 'mainDialog.permissionReasonRemoteCodeExecution',
  '磁盘操作': 'mainDialog.permissionReasonDiskOperation',
  'Disk operation': 'mainDialog.permissionReasonDiskOperation',
  '规则要求用户确认': 'mainDialog.permissionReasonRuleRequiresConfirmation',
  'Rule requires user confirmation': 'mainDialog.permissionReasonRuleRequiresConfirmation',
  '命令被安全策略禁止': 'mainDialog.permissionReasonCommandDeniedByPolicy',
  'Command blocked by the security policy': 'mainDialog.permissionReasonCommandDeniedByPolicy',
  '该命令需要确认': 'mainDialog.permissionReasonCommandNeedsConfirmation',
  'This command requires confirmation': 'mainDialog.permissionReasonCommandNeedsConfirmation',
  '未识别的命令类型': 'mainDialog.permissionReasonUnrecognizedCommandType',
  'Unrecognized command type': 'mainDialog.permissionReasonUnrecognizedCommandType',
  '该操作会调用外部 MCP 服务': 'mainDialog.permissionReasonExternalMcp',
  'This operation will call an external MCP service': 'mainDialog.permissionReasonExternalMcp',
  '该操作会把 Skill 安装到本地应用，并可在当前会话中立即启用': 'mainDialog.permissionReasonInstallSkill',
  'This operation will install a Skill into the local app and make it available in the current session': 'mainDialog.permissionReasonInstallSkill',
  '该操作会写入 MCP 服务配置，并可能立即连接外部服务': 'mainDialog.permissionReasonInstallMcp',
  'This operation will write MCP service configuration and may connect to an external service immediately': 'mainDialog.permissionReasonInstallMcp',
  '该操作会创建一个会自动运行的 AI 定时任务': 'mainDialog.permissionReasonCreateScheduledTask',
  'This operation will create an AI scheduled task that runs automatically': 'mainDialog.permissionReasonCreateScheduledTask',
  '该操作需要访问本地系统资源': 'mainDialog.permissionReasonLocalResourceAccess',
  'This operation needs access to local system resources': 'mainDialog.permissionReasonLocalResourceAccess'
}

export function translateAuthTitle (title: string, t: ComposerTranslation): string {
  const zhMatch = title.match(/^工具 (.+) 需要授权$/)
  if (zhMatch) return t('mainDialog.permissionToolAuthTitle', { toolName: zhMatch[1] })

  const enMatch = title.match(/^Tool (.+) requires authorization$/)
  if (enMatch) return t('mainDialog.permissionToolAuthTitle', { toolName: enMatch[1] })

  return title
}

export function translateAuthDetail (detail: string, t: ComposerTranslation): string {
  return detail.split('\n').map(line => translateAuthDetailLine(line, t)).join('\n')
}

function translateAuthDetailLine (line: string, t: ComposerTranslation): string {
  const reasonKey = REASON_KEY_BY_TEXT[line]
  if (reasonKey) return t(reasonKey)

  const commandMatch = line.match(/^(?:命令|Command):\s*(.*)$/)
  if (commandMatch) return t('mainDialog.permissionDetailCommand', { command: commandMatch[1] })

  const fileMatch = line.match(/^(?:文件|File):\s*(.*)$/)
  if (fileMatch) return t('mainDialog.permissionDetailFile', { filePath: fileMatch[1] })

  const argsMatch = line.match(/^(?:参数|Arguments):\s*(.*)$/)
  if (argsMatch) return t('mainDialog.permissionDetailArgs', { args: argsMatch[1] })

  return line
}
