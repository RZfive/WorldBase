import type { ComposerTranslation } from 'vue-i18n'
import type { ToolProgressEntry } from './types'
import { translateAuthTitle } from './auth-i18n'

interface TranslatedProgressEntry {
  stage: string
  detail?: string
}

const STAGE_KEY_BY_TEXT: Record<string, string> = {
  '🔌 调用 MCP 工具': 'chatUi.progressStageCallMcpTool',
  '[主Agent] 启动': 'chatUi.progressStageMainAgentStart',
  '[主Agent] ✅ 完成': 'chatUi.progressStageMainAgentDone',
  '🗑️ 正在删除文件...': 'chatUi.progressStageDeletingFile',
  'ℹ️ 文件不存在，跳过删除': 'chatUi.progressStageFileMissingSkipDelete',
  '✅ 文件已删除': 'chatUi.progressStageFileDeleted',
  '🔄 正在同步构建状态...': 'chatUi.progressStageSyncBuildStatus',
  '✅ 构建状态已同步': 'chatUi.progressStageBuildStatusSynced',
  '⚠️ 状态同步未完成': 'chatUi.progressStageBuildStatusIncomplete',
  '🧹 正在执行原子重建流程...': 'chatUi.progressStageRebuildingProject',
  '✅ 重建完成': 'chatUi.progressStageRebuildDone',
  '❌ 重建失败': 'chatUi.progressStageRebuildFailed',
  '📋 加入任务队列': 'chatUi.progressStageQueueTask',
  '🚀 正在启动项目服务...': 'chatUi.progressStageStartingProjectService',
  '✅ 项目服务已就绪': 'chatUi.progressStageProjectServiceReady',
  '📝 正在读取文件...': 'chatUi.progressStageReadingFile',
  '📝 正在写入文件...': 'chatUi.progressStageWritingFile',
  '✅ 文件已保存': 'chatUi.progressStageFileSaved',
  '🕒 正在启动异步任务...': 'chatUi.progressStageStartingAsyncTask',
  '✅ 异步任务已启动': 'chatUi.progressStageAsyncTaskStarted',
  '任务已创建，等待执行': 'chatUi.progressStageTaskQueued',
  '正在重建项目': 'chatUi.progressStageRebuildingProjectTask',
  '任务完成': 'chatUi.progressStageTaskCompleted',
  '任务失败': 'chatUi.progressStageTaskFailed',
  '🔧 正在初始化项目...': 'chatUi.progressStageInitializingProject',
  '📁 正在创建项目文件...': 'chatUi.progressStageCreatingProjectFiles',
  '🗄️ 正在初始化 SQLite 数据接口...': 'chatUi.progressStageInitializingSqlite',
  '📄 已创建': 'chatUi.progressStageCreated',
  '📦 正在安装依赖...': 'chatUi.progressStageInstallingDependencies',
  '✅ 依赖安装完成': 'chatUi.progressStageDependenciesInstalled',
  '⚠️ 依赖安装失败': 'chatUi.progressStageDependenciesFailed',
  '🔨 正在编译项目...': 'chatUi.progressStageBuildingProject',
  '✅ 编译完成': 'chatUi.progressStageBuildDone',
  '🧹 正在清理构建产物...': 'chatUi.progressStageCleaningArtifacts',
  '✅ 清理完成': 'chatUi.progressStageCleanDone',
  '❌ 编译失败，项目未启动': 'chatUi.progressStageBuildFailedNoStart',
  '❌ 编译出错，项目未启动': 'chatUi.progressStageBuildErrorNoStart',
  '🚀 正在启动项目...': 'chatUi.progressStageStartingProject',
  '✅ 项目已启动': 'chatUi.progressStageProjectStarted',
  '⚠️ 启动失败': 'chatUi.progressStageStartFailed',
  '🗓️ 创建定时任务': 'chatUi.progressStageCreateScheduledTask',
  '✅ 定时任务已创建': 'chatUi.progressStageScheduledTaskCreated',
  '🧠 保存 Agent': 'chatUi.progressStageSavingAgent',
  '✅ Agent 已保存': 'chatUi.progressStageAgentSaved',
  '👥 保存 Agent 群组': 'chatUi.progressStageSavingAgentGroup',
  '✅ Agent 群组已保存': 'chatUi.progressStageAgentGroupSaved',
  '更新 Todo': 'chatUi.progressStageUpdateTodo',
  '🔍 正在搜索文件...': 'chatUi.progressStageSearchingFiles',
  '🔍 正在搜索代码...': 'chatUi.progressStageSearchingCode',
  '🔍 搜索中...': 'chatUi.progressStageSearching',
  '✅ 搜索完成': 'chatUi.progressStageSearchDone',
  '🏁 正在执行项目收尾流程...': 'chatUi.progressStageFinalizingProject',
  '✅ 项目收尾完成': 'chatUi.progressStageFinalizeDone',
  '❌ 项目收尾失败': 'chatUi.progressStageFinalizeFailed',
  '⚡ 正在执行命令...': 'chatUi.progressStageRunningCommand',
  '⚠️ 命令输出过长，正在终止...': 'chatUi.progressStageCommandOutputTooLong',
  '⏱️ 前台等待超时，命令转入后台继续执行': 'chatUi.progressStageCommandMovedBackground',
  '⏳ 命令仍在执行...': 'chatUi.progressStageCommandStillRunning',
  '⚠️ 命令已终止': 'chatUi.progressStageCommandTerminated',
  '✅ 命令执行完成': 'chatUi.progressStageCommandCompleted',
  '❌ 命令执行失败': 'chatUi.progressStageCommandFailed',
  '🔄 正在重启项目服务...': 'chatUi.progressStageRestartingProjectService',
  '✅ 项目服务已重启': 'chatUi.progressStageProjectServiceRestarted',
  '询问用户': 'chatUi.progressStageAskUser',
  '收到用户回复': 'chatUi.progressStageUserReplied',
  '📂 正在列出项目目录...': 'chatUi.progressStageListingProjectDirectory',
  '✅ 目录读取完成': 'chatUi.progressStageDirectoryReadDone',
  '🔄 AI 连接中断，正在重试...': 'chatUi.progressStageAiRetrying',
  '✅ 所有子 Agent 执行完毕': 'chatUi.progressStageAllSubAgentsDone',
  '等待开始': 'mainDialog.groupProgressWaitingStart',
  '已完成': 'mainDialog.groupProgressCompleted',
  '等待下一轮': 'mainDialog.groupProgressWaitingNextRound',
  '主协调判断无需继续修改': 'mainDialog.groupProgressNoMoreChanges',
  '本轮未被选中': 'mainDialog.groupProgressNotSelectedThisRound',
  '协调结束讨论': 'mainDialog.groupProgressDiscussionEndedByCoordinator',
  '完成': 'mainDialog.groupProgressDone',
  '等待': 'mainDialog.groupProgressWaiting',
  '配置无效': 'mainDialog.groupProgressInvalidConfig',
  '准备上下文': 'mainDialog.groupProgressPrepareContext',
  '群内协作': 'mainDialog.groupProgressGroupCollaboration',
  '定向单聊': 'mainDialog.groupProgressTargetedSidechat',
  '思考中': 'mainDialog.groupProgressThinking',
  '调用工具': 'mainDialog.groupProgressToolStart',
  '工具完成': 'mainDialog.groupProgressToolEnd',
  '单聊完成': 'mainDialog.groupProgressSidechatDone',
  '失败': 'mainDialog.groupProgressFailed',
  '全部轮次完成': 'mainDialog.groupProgressAllRoundsDone',
  '本轮完成': 'mainDialog.groupProgressRoundDone',
  '未产出笔记': 'mainDialog.groupProgressNoNote',
  '讨论已结束': 'mainDialog.groupProgressDiscussionEnded',
  '未被安排参与本次讨论': 'mainDialog.groupProgressNotScheduled',
  'Waiting to start': 'mainDialog.groupProgressWaitingStart',
  'Completed': 'mainDialog.groupProgressCompleted',
  'Waiting for next round': 'mainDialog.groupProgressWaitingNextRound',
  'Coordinator decided no further changes are needed': 'mainDialog.groupProgressNoMoreChanges',
  'Not selected this round': 'mainDialog.groupProgressNotSelectedThisRound',
  'Coordinator ended the discussion': 'mainDialog.groupProgressDiscussionEndedByCoordinator',
  'Done': 'mainDialog.groupProgressDone',
  'Waiting': 'mainDialog.groupProgressWaiting',
  'Invalid config': 'mainDialog.groupProgressInvalidConfig',
  'Preparing context': 'mainDialog.groupProgressPrepareContext',
  'Group collaboration': 'mainDialog.groupProgressGroupCollaboration',
  'Targeted sidechat': 'mainDialog.groupProgressTargetedSidechat',
  'Thinking': 'mainDialog.groupProgressThinking',
  'Calling tool': 'mainDialog.groupProgressToolStart',
  'Tool completed': 'mainDialog.groupProgressToolEnd',
  'Sidechat completed': 'mainDialog.groupProgressSidechatDone',
  'Failed': 'mainDialog.groupProgressFailed',
  'All rounds completed': 'mainDialog.groupProgressAllRoundsDone',
  'Round completed': 'mainDialog.groupProgressRoundDone',
  'No note produced': 'mainDialog.groupProgressNoNote',
  'Discussion ended': 'mainDialog.groupProgressDiscussionEnded',
  'Not assigned to this discussion': 'mainDialog.groupProgressNotScheduled'
}

export function translateProgressEntry (
  step: ToolProgressEntry,
  t: ComposerTranslation
): TranslatedProgressEntry {
  return {
    stage: translateProgressText(step.stage, t),
    detail: step.detail ? translateProgressText(step.detail, t) : undefined
  }
}

export function formatProgressEntry (step: ToolProgressEntry, t: ComposerTranslation, separator = ': '): string {
  const translated = translateProgressEntry(step, t)
  return translated.detail ? `${translated.stage}${separator}${translated.detail}` : translated.stage
}

export function translateProgressText (text: string, t: ComposerTranslation): string {
  const key = STAGE_KEY_BY_TEXT[text]
  if (key) return t(key)

  const authTitle = translateAuthTitle(text, t)
  if (authTitle !== text) return authTitle

  return translateProgressDetail(text, t)
}

function translateProgressDetail (text: string, t: ComposerTranslation): string {
  const generateMatch = text.match(/^生成 ×(\d+)$/)
  if (generateMatch) return t('chatUi.progressDetailGenerateCount', { count: generateMatch[1] })

  const editMatch = text.match(/^编辑 ×(\d+)$/)
  if (editMatch) return t('chatUi.progressDetailEditCount', { count: editMatch[1] })

  const filesMatch = text.match(/^共 (\d+) 个文件$/)
  if (filesMatch) return t('chatUi.progressDetailFileCount', { count: filesMatch[1] })

  const plainFilesMatch = text.match(/^(\d+) 个文件$/)
  if (plainFilesMatch) return t('chatUi.progressDetailPlainFileCount', { count: plainFilesMatch[1] })

  const matchesMatch = text.match(/^(\d+) 个匹配$/)
  if (matchesMatch) return t('chatUi.progressDetailMatchCount', { count: matchesMatch[1] })

  const filesHitMatch = text.match(/^(\d+) 个文件命中$/)
  if (filesHitMatch) return t('chatUi.progressDetailMatchedFileCount', { count: filesHitMatch[1] })

  const directoryMatch = text.match(/^(\d+)\/(\d+) 项$/)
  if (directoryMatch) return t('chatUi.progressDetailDirectoryItems', { shown: directoryMatch[1], total: directoryMatch[2] })

  const replacementsMatch = text.match(/^(\d+) 处替换$/)
  if (replacementsMatch) return t('chatUi.progressDetailReplacementCount', { count: replacementsMatch[1] })

  const patchesMatch = text.match(/^(\d+) 个补丁, (\d+) 行修改$/)
  if (patchesMatch) return t('chatUi.progressDetailPatchCount', { patches: patchesMatch[1], lines: patchesMatch[2] })

  const durationMatch = text.match(/^耗时 (\d+)s$/)
  if (durationMatch) return t('chatUi.progressDetailDurationSeconds', { seconds: durationMatch[1] })

  const freedMatch = text.match(/^释放 ([\d.]+)MB 磁盘空间$/)
  if (freedMatch) return t('chatUi.progressDetailFreedDiskSpace', { size: freedMatch[1] })

  const portMatch = text.match(/^端口: (\d+)$/)
  if (portMatch) return t('chatUi.progressDetailPort', { port: portMatch[1] })

  const exitCodeMatch = text.match(/^退出码: (-?\d+)$/)
  if (exitCodeMatch) return t('chatUi.progressDetailExitCode', { code: exitCodeMatch[1] })

  const foregroundWaitMatch = text.match(/^(.*)（前台等待 (\d+)s）$/)
  if (foregroundWaitMatch) return t('chatUi.progressDetailForegroundWait', { command: foregroundWaitMatch[1], seconds: foregroundWaitMatch[2] })

  const attemptMatch = text.match(/^第 (\d+) 次尝试$/)
  if (attemptMatch) return t('chatUi.progressDetailAttempt', { count: attemptMatch[1] })

  const waitingAnswersMatch = text.match(/^等待用户回答 (\d+) 个问题$/)
  if (waitingAnswersMatch) return t('chatUi.progressDetailWaitingUserAnswers', { count: waitingAnswersMatch[1] })

  const replyCountMatch = text.match(/^共 (\d+) 项$/)
  if (replyCountMatch) return t('chatUi.progressDetailReplyCount', { count: replyCountMatch[1] })

  const todoSummaryMatch = text.match(/^共 (\d+) 项，已完成 (\d+) 项，进行中 (\d+) 项$/)
  if (todoSummaryMatch) return t('chatUi.progressDetailTodoSummary', { total: todoSummaryMatch[1], completed: todoSummaryMatch[2], inProgress: todoSummaryMatch[3] })

  const subAgentSummaryMatch = text.match(/^(\d+) 成功 \/ (\d+) 失败 · 耗时 ([\d.]+)s$/)
  if (subAgentSummaryMatch) return t('chatUi.progressDetailSubAgentSummary', { completed: subAgentSummaryMatch[1], failed: subAgentSummaryMatch[2], seconds: subAgentSummaryMatch[3] })

  if (text === '删除 node_modules') return t('chatUi.progressDetailRemoveNodeModules')
  if (text === '删除构建缓存') return t('chatUi.progressDetailRemoveBuildCache')
  if (text === '执行依赖安装与构建流程') return t('chatUi.progressDetailDependencyBuildFlow')
  if (text === '任务执行失败') return t('chatUi.progressDetailTaskExecutionFailed')
  if (text === '输出过长') return t('chatUi.progressDetailOutputTooLong')

  const cleanupDetail = translateCleanupDetail(text, t)
  if (cleanupDetail !== text) return cleanupDetail

  const groupProgressDetail = translateGroupProgressDetail(text, t)
  if (groupProgressDetail !== text) return groupProgressDetail

  const parallelAgentsMatch = text.match(/^🚀 启动 (\d+) 个并行子 Agent$/)
  if (parallelAgentsMatch) return t('chatUi.progressStageStartParallelAgents', { count: parallelAgentsMatch[1] })

  const subAgentStartMatch = text.match(/^\[(.+)] 启动$/)
  if (subAgentStartMatch) return t('chatUi.progressStageSubAgentStart', { label: subAgentStartMatch[1] })

  const subAgentDoneMatch = text.match(/^\[(.+)] ✅ 完成$/)
  if (subAgentDoneMatch) return t('chatUi.progressStageSubAgentDone', { label: subAgentDoneMatch[1] })

  const subAgentFailedMatch = text.match(/^\[(.+)] ❌ 失败: (.+)$/)
  if (subAgentFailedMatch) return t('chatUi.progressStageSubAgentFailed', { label: subAgentFailedMatch[1], message: subAgentFailedMatch[2] })

  return text
}

function translateCleanupDetail (text: string, t: ComposerTranslation): string {
  const keyByPart: Record<string, string> = {
    '依赖清理已请求': 'chatUi.progressDetailDependencyCleanupRequested',
    '保留依赖': 'chatUi.progressDetailKeepDependencies',
    '构建缓存清理已请求': 'chatUi.progressDetailBuildCacheCleanupRequested',
    '保留构建缓存': 'chatUi.progressDetailKeepBuildCache'
  }
  const parts = text.split('，')
  if (parts.length === 0 || parts.some(part => !keyByPart[part])) return text
  return parts.map(part => t(keyByPart[part])).join(t('chatUi.progressListSeparator'))
}

function translateGroupProgressDetail (text: string, t: ComposerTranslation): string {
  const agentNotFoundMatch = text.match(/^(?:找不到 Agent|Agent not found):\s*(.+)$/)
  if (agentNotFoundMatch) return t('mainDialog.groupProgressAgentNotFound', { id: agentNotFoundMatch[1] })

  const roundMatch = text.match(/^第 (\d+) 轮$/)
  if (roundMatch) return t('mainDialog.groupProgressRoundDetail', { round: roundMatch[1] })

  const englishRoundMatch = text.match(/^Round (\d+)$/)
  if (englishRoundMatch) return t('mainDialog.groupProgressRoundDetail', { round: englishRoundMatch[1] })

  const failureMatch = text.match(/^失败：(.+)$/)
  if (failureMatch) return t('mainDialog.groupProgressFailureNote', { message: failureMatch[1] })

  const englishFailureMatch = text.match(/^Failed:\s*(.+)$/)
  if (englishFailureMatch) return t('mainDialog.groupProgressFailureNote', { message: englishFailureMatch[1] })

  const roundCompletedMatch = text.match(/^第 (\d+) 轮已完成$/)
  if (roundCompletedMatch) return t('mainDialog.groupProgressRoundCompleted', { round: roundCompletedMatch[1] })

  const englishRoundCompletedMatch = text.match(/^Round (\d+) completed$/)
  if (englishRoundCompletedMatch) return t('mainDialog.groupProgressRoundCompleted', { round: englishRoundCompletedMatch[1] })

  const roundNoNoteMatch = text.match(/^第 (\d+) 轮未产出工作笔记$/)
  if (roundNoNoteMatch) return t('mainDialog.groupProgressRoundNoNote', { round: roundNoNoteMatch[1] })

  const englishRoundNoNoteMatch = text.match(/^Round (\d+) produced no working note$/)
  if (englishRoundNoNoteMatch) return t('mainDialog.groupProgressRoundNoNote', { round: englishRoundNoNoteMatch[1] })

  return text
}
