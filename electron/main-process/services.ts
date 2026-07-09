import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { AIEngine } from '../../src/main/ai-engine/ai-engine.js'
import { ProjectFS } from '../../src/main/project-fs/project-fs.js'
import { ProjectPackageService } from '../../src/main/project-fs/project-package-service.js'
import { RuntimeManager } from '../../src/main/project-runtime/runtime-manager.js'
import { BuilderService } from '../../src/main/project-runtime/builder-service.js'
import { AppGateway } from '../../src/main/project-runtime/app-gateway.js'
import { UpdateService } from '../../src/main/app-update/update-service.js'
import { ProcessManagerService } from '../../src/main/project-runtime/process-manager-service.js'
import { ProjectApiClient } from '../../src/main/project-api-bridge/api-client.js'
import { ProjectDataAccess } from '../../src/main/project-data-access/data-access.js'
import { SqliteAdapter } from '../../src/main/project-data-access/adapters/sqlite-adapter.js'
import { LanServer } from '../../src/main/lan-server/server.js'
import { LAN_SERVER_PORT } from '../../src/main/constants.js'
import { SystemService } from '../../src/main/system-capabilities/system-service.js'
import { SettingsStore } from '../../src/main/settings/settings-store.js'
import { ChatHistoryStore } from '../../src/main/settings/chat-history.js'
import { AILogStore } from '../../src/main/settings/ai-log-store.js'
import { ImageLibraryStore } from '../../src/main/settings/image-library-store.js'
import { StudioTaskStore } from '../../src/main/settings/studio-task-store.js'
import { UsageStore } from '../../src/main/settings/usage-store.js'
import { SkillStore } from '../../src/main/settings/skill-store.js'
import { AgentStore } from '../../src/main/settings/agent-store.js'
import { AgentGroupStore } from '../../src/main/settings/agent-group-store.js'
import { ScheduledTaskStore, type ScheduledTaskDefinition, type ScheduledTaskRunReport } from '../../src/main/settings/scheduled-task-store.js'
import { LongTermGoalStore } from '../../src/main/settings/long-term-goal-store.js'
import { ChannelBindingStore } from '../../src/main/im/channel-binding-store.js'
import { ImGatewayService } from '../../src/main/im/im-gateway-service.js'
import { MemoryStore } from '../../src/main/ai-engine/memory/memory-store.js'
import { MemoryEngine } from '../../src/main/ai-engine/memory/memory-engine.js'
import { AsyncTaskManager } from '../../src/main/ai-engine/agent/tools/async-task-manager.js'
import { DocumentStore } from '../../src/main/ai-engine/agent/tools/document-store.js'
import { MCPService, type MCPStateSnapshot } from '../../src/main/mcp/mcp-service.js'
import { ScheduledTaskService } from '../../src/main/scheduler/scheduled-task-service.js'
import { LongTermGoalService } from '../../src/main/long-term-goals/long-term-goal-service.js'
import type { AppUpdateState } from '../../src/shared/app-update-types.js'
import type { BrowserAutomationAction, BrowserAutomationActionResult, BrowserAutomationSnapshot } from '../../src/shared/page-automation-types.js'
import type { MCPServerConfig } from '../../src/main/settings/settings-store.js'
import { CRITICAL_USER_DATA_DIR_NAMES, CRITICAL_USER_DATA_FILE_NAMES, LEGACY_USER_DATA_DIR_NAMES } from './constants.js'
import { mainState } from './state.js'
import { applyActiveProviderToAiEngine, notifyAgentWorkspaceChanged, resolveProviderConfig } from './ai/agent-context.js'
import { enqueueStudioImageTasks } from './media/image-studio-queue.js'
import { generateImGatewayReply } from './ai/im-replies.js'
import { broadcastToAppWindows, getActiveAiRequestWindow, getProjectsDir, getSnapshotsDir, requestPageAutomationFromRenderer } from './windows.js'

export function applyMcpServersToService (): MCPServerConfig[] {
  const servers = mainState.settingsStore!.getMcpServers()
  void mainState.mcpService!.updateServers(servers).catch((error) => {
    console.error('[main:mcp] Failed to apply MCP settings:', error)
  })
  return servers
}

export async function pathExists (targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

export async function getDirectoryEntryCount (targetPath: string): Promise<number> {
  try {
    return (await fs.readdir(targetPath)).length
  } catch {
    return 0
  }
}

export async function getFileByteSize (targetPath: string): Promise<number> {
  try {
    const stats = await fs.stat(targetPath)
    return stats.isFile() ? stats.size : 0
  } catch {
    return 0
  }
}

export async function getCriticalUserDataPresence (basePath: string): Promise<boolean> {
  const criticalDirectoryCounts = await Promise.all(
    CRITICAL_USER_DATA_DIR_NAMES.map(name => getDirectoryEntryCount(path.join(basePath, name)))
  )
  if (criticalDirectoryCounts.some(count => count > 0)) {
    return true
  }

  const criticalFileSizes = await Promise.all(
    CRITICAL_USER_DATA_FILE_NAMES.map(name => getFileByteSize(path.join(basePath, name)))
  )
  return criticalFileSizes.some(size => size > 0)
}

export async function getCriticalUserDataDirectoryPresence (basePath: string): Promise<boolean> {
  const criticalDirectoryCounts = await Promise.all(
    CRITICAL_USER_DATA_DIR_NAMES.map(name => getDirectoryEntryCount(path.join(basePath, name)))
  )
  return criticalDirectoryCounts.some(count => count > 0)
}

type CopyMissingUserDataResult = {
  copied: number
  merged: number
  skipped: number
}

type CopyMissingUserDataOptions = {
  settingsConflict?: 'source-wins' | 'target-wins'
}

function isJsonRecord (value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasConfiguredAiProviderSettings (settings: Record<string, unknown>): boolean {
  const providersConfig = settings.aiProviders
  if (providersConfig && typeof providersConfig === 'object') {
    const providers = (providersConfig as Record<string, unknown>).providers
    if (Array.isArray(providers) && providers.some(provider => {
      if (!provider || typeof provider !== 'object') return false
      const record = provider as Record<string, unknown>
      const hasModels = Array.isArray(record.models) && record.models.length > 0
      return [record.name, record.baseUrl, record.apiKey, record.activeModel].some(value => typeof value === 'string' && value.trim().length > 0) || hasModels
    })) {
      return true
    }
  }

  return ['aiApiKey', 'aiBaseUrl', 'aiModel'].some(key => {
    const value = settings[key]
    return typeof value === 'string' && value.trim().length > 0
  })
}

function copyAiProviderSettings (from: Record<string, unknown>, to: Record<string, unknown>): void {
  for (const key of ['aiProviders', 'aiApiKey', 'aiBaseUrl', 'aiModel']) {
    if (Object.prototype.hasOwnProperty.call(from, key)) {
      to[key] = from[key]
    }
  }
}

function mergeSettingsRecords (
  sourceSettings: Record<string, unknown>,
  targetSettings: Record<string, unknown>,
  conflictMode: 'source-wins' | 'target-wins'
): Record<string, unknown> {
  const mergedSettings = conflictMode === 'source-wins'
    ? { ...targetSettings, ...sourceSettings }
    : { ...sourceSettings, ...targetSettings }

  const sourceHasAiProviderSettings = hasConfiguredAiProviderSettings(sourceSettings)
  const targetHasAiProviderSettings = hasConfiguredAiProviderSettings(targetSettings)

  if (sourceHasAiProviderSettings && (!targetHasAiProviderSettings || conflictMode === 'source-wins')) {
    copyAiProviderSettings(sourceSettings, mergedSettings)
  } else if (!sourceHasAiProviderSettings && targetHasAiProviderSettings) {
    copyAiProviderSettings(targetSettings, mergedSettings)
  }

  return mergedSettings
}

export async function getUniqueBackupPath (targetPath: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (let index = 0; index < 100; index++) {
    const suffix = index === 0 ? stamp : `${stamp}-${index}`
    const backupPath = `${targetPath}.migration-backup-${suffix}`
    if (!(await pathExists(backupPath))) {
      return backupPath
    }
  }
  return `${targetPath}.migration-backup-${stamp}-${Date.now()}`
}

export async function readJsonRecordFile (filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown
    return isJsonRecord(parsed) ? parsed : null
  } catch (error) {
    console.warn(`[main] Failed to read JSON record from ${filePath}`, error)
    return null
  }
}

export async function mergeSettingsFile (
  sourcePath: string,
  targetPath: string,
  conflictMode: 'source-wins' | 'target-wins' = 'source-wins'
): Promise<CopyMissingUserDataResult> {
  if (!(await pathExists(targetPath))) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.copyFile(sourcePath, targetPath)
    return { copied: 1, merged: 0, skipped: 0 }
  }

  const sourceSettings = await readJsonRecordFile(sourcePath)
  if (!sourceSettings) {
    return { copied: 0, merged: 0, skipped: 1 }
  }

  const targetSettings = await readJsonRecordFile(targetPath)
  if (!targetSettings) {
    const backupPath = await getUniqueBackupPath(targetPath)
    await fs.rename(targetPath, backupPath)
    await fs.copyFile(sourcePath, targetPath)
    console.log(`[main] Replaced unreadable settings at ${targetPath}; backup saved to ${backupPath}`)
    return { copied: 1, merged: 0, skipped: 0 }
  }

  const mergedSettings = mergeSettingsRecords(sourceSettings, targetSettings, conflictMode)

  const before = JSON.stringify(targetSettings)
  const after = JSON.stringify(mergedSettings)
  if (before === after) {
    return { copied: 0, merged: 0, skipped: 1 }
  }

  const backupPath = await getUniqueBackupPath(targetPath)
  await fs.copyFile(targetPath, backupPath)
  await fs.writeFile(targetPath, JSON.stringify(mergedSettings, null, 2), 'utf8')
  console.log(`[main] Merged settings from ${sourcePath} into ${targetPath}; backup saved to ${backupPath}`)
  return { copied: 0, merged: 1, skipped: 0 }
}

export async function copyMissingUserDataEntries (
  sourcePath: string,
  targetPath: string,
  options: CopyMissingUserDataOptions = {}
): Promise<CopyMissingUserDataResult> {
  const stats = await fs.lstat(sourcePath)

  if (stats.isSymbolicLink()) {
    if (await pathExists(targetPath)) {
      return { copied: 0, merged: 0, skipped: 1 }
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.symlink(await fs.readlink(sourcePath), targetPath)
    return { copied: 1, merged: 0, skipped: 0 }
  }

  if (!stats.isDirectory()) {
    if (path.basename(sourcePath) === 'settings.json') {
      return mergeSettingsFile(sourcePath, targetPath, options.settingsConflict)
    }

    if (await pathExists(targetPath)) {
      return { copied: 0, merged: 0, skipped: 1 }
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.copyFile(sourcePath, targetPath)
    return { copied: 1, merged: 0, skipped: 0 }
  }

  const targetExists = await pathExists(targetPath)
  if (targetExists) {
    const targetStats = await fs.lstat(targetPath)
    if (!targetStats.isDirectory()) {
      return { copied: 0, merged: 0, skipped: 1 }
    }
  } else {
    await fs.mkdir(targetPath, { recursive: true })
  }

  let copied = 0
  let merged = 0
  let skipped = 0
  const entries = await fs.readdir(sourcePath)
  for (const entry of entries) {
    const result = await copyMissingUserDataEntries(path.join(sourcePath, entry), path.join(targetPath, entry), options)
    copied += result.copied
    merged += result.merged
    skipped += result.skipped
  }

  return { copied, merged, skipped }
}

export async function promoteLegacyUserDataPath (legacyPath: string, userDataPath: string, shouldBackupCurrent: boolean): Promise<string | null> {
  let backupPath: string | null = null

  if (shouldBackupCurrent && await pathExists(userDataPath)) {
    backupPath = await getUniqueBackupPath(userDataPath)
    await fs.rename(userDataPath, backupPath)
    console.log(`[main] Backed up existing userData from ${userDataPath} to ${backupPath}`)
  }

  try {
    await fs.mkdir(path.dirname(userDataPath), { recursive: true })
    await fs.rename(legacyPath, userDataPath)
    console.log(`[main] Migrated userData from ${legacyPath} to ${userDataPath}`)
    return backupPath
  } catch (renameError) {
    console.warn(`[main] Failed to rename userData from ${legacyPath} to ${userDataPath}; trying copy-based migration`, renameError)

    try {
      const result = await copyMissingUserDataEntries(legacyPath, userDataPath)
      console.log(`[main] Copied missing userData entries from ${legacyPath} to ${userDataPath} (${result.copied} copied, ${result.merged} merged, ${result.skipped} skipped)`)
      return backupPath
    } catch (copyError) {
      console.warn(`[main] Failed to copy userData from ${legacyPath} to ${userDataPath}`, copyError)

      if (backupPath && !(await pathExists(userDataPath)) && await pathExists(backupPath)) {
        try {
          await fs.rename(backupPath, userDataPath)
          console.log(`[main] Restored userData backup from ${backupPath} to ${userDataPath}`)
        } catch (restoreError) {
          console.warn(`[main] Failed to restore userData backup from ${backupPath} to ${userDataPath}`, restoreError)
        }
      }

      throw copyError
    }
  }
}

export async function removeLegacyUserDataPath (legacyPath: string, userDataPath: string): Promise<void> {
  const resolvedLegacyPath = path.resolve(legacyPath)
  const resolvedUserDataPath = path.resolve(userDataPath)
  if (resolvedLegacyPath === resolvedUserDataPath) return
  if (!(await pathExists(legacyPath))) return

  await fs.rm(legacyPath, { recursive: true, force: true })
  console.log(`[main] Removed legacy userData path ${legacyPath}`)
}

export async function mergeLegacySettingsIfPresent (
  legacyPath: string,
  userDataPath: string,
  conflictMode: 'source-wins' | 'target-wins'
): Promise<CopyMissingUserDataResult> {
  const legacySettingsPath = path.join(legacyPath, 'settings.json')
  if (!(await pathExists(legacySettingsPath))) {
    return { copied: 0, merged: 0, skipped: 0 }
  }

  return mergeSettingsFile(legacySettingsPath, path.join(userDataPath, 'settings.json'), conflictMode)
}

export async function ensureStableUserDataPath (): Promise<void> {
  const userDataPath = app.getPath('userData')
  const appDataPath = app.getPath('appData')
  const legacyPaths = Array.from(new Set(
    LEGACY_USER_DATA_DIR_NAMES
      .map(legacyName => path.join(appDataPath, legacyName))
      .filter(legacyPath => path.resolve(legacyPath) !== path.resolve(userDataPath))
  ))

  const existingLegacyPaths: string[] = []
  for (const legacyPath of legacyPaths) {
    if (await pathExists(legacyPath)) existingLegacyPaths.push(legacyPath)
  }

  if (existingLegacyPaths.length === 0) return

  const promotedLegacyPaths = new Set<string>()
  let hasAppliedPrimarySettings = false

  if (!(await pathExists(userDataPath))) {
    const legacyPresence = await Promise.all(existingLegacyPaths.map(async legacyPath => ({
      path: legacyPath,
      hasCriticalData: await getCriticalUserDataPresence(legacyPath)
    })))
    const preferredLegacyPath = legacyPresence.find(item => item.hasCriticalData)?.path || existingLegacyPaths[0]

    try {
      await promoteLegacyUserDataPath(preferredLegacyPath, userDataPath, false)
      promotedLegacyPaths.add(preferredLegacyPath)
      hasAppliedPrimarySettings = await pathExists(path.join(userDataPath, 'settings.json'))
      await removeLegacyUserDataPath(preferredLegacyPath, userDataPath)
    } catch (error) {
      console.warn(`[main] Failed to migrate userData from ${preferredLegacyPath} to ${userDataPath}; continuing with legacy path`, error)
      app.setPath('userData', preferredLegacyPath)
      return
    }
  }

  for (const legacyPath of existingLegacyPaths) {
    if (promotedLegacyPaths.has(legacyPath)) continue
    if (!(await pathExists(legacyPath))) continue

    try {
      const settingsResult = await mergeLegacySettingsIfPresent(
        legacyPath,
        userDataPath,
        hasAppliedPrimarySettings ? 'target-wins' : 'source-wins'
      )
      if (settingsResult.copied > 0 || settingsResult.merged > 0) {
        console.log(`[main] Migrated legacy settings from ${legacyPath} into ${userDataPath} (${settingsResult.copied} copied, ${settingsResult.merged} merged)`)
      }
      if (settingsResult.copied > 0 || settingsResult.merged > 0 || settingsResult.skipped > 0) {
        hasAppliedPrimarySettings = true
      }
    } catch (error) {
      console.warn(`[main] Failed to migrate legacy settings from ${legacyPath} into ${userDataPath}; keeping legacy path for retry`, error)
      continue
    }

    const [currentHasCriticalData, currentHasDirectoryData, legacyHasCriticalData, legacyHasDirectoryData] = await Promise.all([
      getCriticalUserDataPresence(userDataPath),
      getCriticalUserDataDirectoryPresence(userDataPath),
      getCriticalUserDataPresence(legacyPath),
      getCriticalUserDataDirectoryPresence(legacyPath)
    ])

    if (!legacyHasCriticalData) {
      await removeLegacyUserDataPath(legacyPath, userDataPath)
      continue
    }

    if (!currentHasCriticalData || (!currentHasDirectoryData && legacyHasDirectoryData)) {
      try {
        await promoteLegacyUserDataPath(legacyPath, userDataPath, await pathExists(userDataPath))
        promotedLegacyPaths.add(legacyPath)
        hasAppliedPrimarySettings = await pathExists(path.join(userDataPath, 'settings.json'))
        await removeLegacyUserDataPath(legacyPath, userDataPath)
      } catch (error) {
        console.warn(`[main] Failed to migrate userData from ${legacyPath} to ${userDataPath}; continuing with legacy path`, error)
        app.setPath('userData', legacyPath)
        return
      }
      continue
    }

    try {
      const result = await copyMissingUserDataEntries(legacyPath, userDataPath, {
        settingsConflict: 'target-wins'
      })
      if (result.copied > 0 || result.merged > 0 || result.skipped > 0) {
        console.log(`[main] Merged legacy userData from ${legacyPath} into ${userDataPath} (${result.copied} copied, ${result.merged} merged, ${result.skipped} skipped)`)
      }
      await removeLegacyUserDataPath(legacyPath, userDataPath)
    } catch (error) {
      console.warn(`[main] Failed to merge legacy userData from ${legacyPath} into ${userDataPath}; keeping current userData path`, error)
    }
  }
}

export async function initializeServices (): Promise<void> {
  await ensureStableUserDataPath()

  const projectsDir = getProjectsDir()
  const snapshotsDir = getSnapshotsDir()
  const userDataPath = app.getPath('userData')

  mainState.settingsStore = new SettingsStore(userDataPath)
  mainState.updateService = new UpdateService(mainState.settingsStore)
  mainState.updateService.on('stateChanged', (state: AppUpdateState) => {
    broadcastToAppWindows('appUpdate:stateChanged', state)
  })
  mainState.chatHistory = new ChatHistoryStore(userDataPath)
  mainState.aiLogStore = new AILogStore(userDataPath)
  mainState.skillStore = new SkillStore(userDataPath)
  mainState.agentStore = new AgentStore(userDataPath)
  mainState.agentGroupStore = new AgentGroupStore(userDataPath)
  mainState.channelBindingStore = new ChannelBindingStore(userDataPath)
  mainState.imGatewayService = new ImGatewayService({
    bindingStore: mainState.channelBindingStore!,
    generateReply: generateImGatewayReply
  })
  mainState.memoryStore = new MemoryStore(userDataPath)
  mainState.memoryEngine = new MemoryEngine(mainState.memoryStore)
  mainState.scheduledTaskStore = new ScheduledTaskStore(userDataPath)
  mainState.longTermGoalStore = new LongTermGoalStore(userDataPath)
  mainState.imageLibraryStore = new ImageLibraryStore(userDataPath)
  mainState.studioTaskStore = new StudioTaskStore(userDataPath)
  mainState.usageStore = new UsageStore(userDataPath)
  mainState.mcpService = new MCPService()
  mainState.mcpService.on('stateChanged', (state: MCPStateSnapshot) => {
    broadcastToAppWindows('settings:mcpStateChanged', state)
  })

  mainState.projectFS = new ProjectFS(projectsDir, snapshotsDir)
  mainState.runtimeManager = new RuntimeManager(projectsDir)
  mainState.builderService = new BuilderService(projectsDir)
  mainState.runtimeManager.setBuilderService(mainState.builderService)
  mainState.builderService.setRuntimeManager(mainState.runtimeManager)
  mainState.apiClient = new ProjectApiClient(mainState.runtimeManager)
  mainState.dataAccess = new ProjectDataAccess(projectsDir)
  mainState.projectPackageService = new ProjectPackageService(mainState.projectFS, mainState.dataAccess)
  mainState.asyncTaskManager = new AsyncTaskManager(mainState.builderService)

  // Wire up the external database delegate.
  // The SqliteAdapter is loaded here (in the shell) so that the data layer
  // itself doesn't depend on native modules directly.
  const sqliteDelegate = new SqliteAdapter()
  mainState.dataAccess.setDatabaseDelegate({
    query: (dbPath: string, sql: string, params?: unknown[]) => sqliteDelegate.query(dbPath, sql, params),
    execute: (dbPath: string, sql: string, params?: unknown[]) => sqliteDelegate.execute(dbPath, sql, params),
    listTables: (dbPath: string) => sqliteDelegate.listTables(dbPath),
    getSchema: (dbPath: string) => sqliteDelegate.getSchema(dbPath),
    close: (dbPath: string) => sqliteDelegate.close(dbPath),
    closeAll: () => sqliteDelegate.closeAll()
  })

  mainState.documentStore = new DocumentStore()

  mainState.aiEngine = new AIEngine({
    projectFS: mainState.projectFS!,
    runtimeManager: mainState.runtimeManager!,
    builderService: mainState.builderService!,
    apiClient: mainState.apiClient!,
    dataAccess: mainState.dataAccess!,
    asyncTaskManager: mainState.asyncTaskManager!,
    documentStore: mainState.documentStore!,
    skillStore: mainState.skillStore!,
    agentStore: mainState.agentStore!,
    agentGroupStore: mainState.agentGroupStore!,
    settingsStore: mainState.settingsStore!,
    imageLibraryStore: mainState.imageLibraryStore ?? undefined,
    usageStore: mainState.usageStore ?? undefined,
    enqueueStudioImageTasks,
    getMainWindow: () => getActiveAiRequestWindow(),
    readActivePage: async () => {
      return await requestPageAutomationFromRenderer<BrowserAutomationSnapshot>({ type: 'snapshot' })
    },
    interactWithActivePage: async (action: BrowserAutomationAction) => {
      return await requestPageAutomationFromRenderer<BrowserAutomationActionResult>({ type: 'action', action })
    },
    notifySkillsChanged: (event) => {
      broadcastToAppWindows('skills:changed', event)
    },
    notifyAgentWorkspaceChanged,
    notifyFolderWorkspaceChanged: (event) => {
      broadcastToAppWindows('folderWorkspace:changed', event)
    },
    mcpService: mainState.mcpService!,
    scheduledTaskService: undefined
  })

  mainState.scheduledTaskService = new ScheduledTaskService({
    store: mainState.scheduledTaskStore,
    aiEngine: mainState.aiEngine!,
    skillStore: mainState.skillStore!,
    getMainWindow: () => mainState.mainWindow,
    resolveProviderConfig: (task) => resolveProviderConfig(task?.providerId || undefined, task?.modelId || undefined),
    getNotificationPreference: () => mainState.settingsStore?.getAIExecutionPreferences().notifyOnTaskComplete ?? true,
    resolveTaskPrompt: (task) => mainState.longTermGoalService?.resolveScheduledTaskPrompt(task),
    resolveTaskOptions: (task) => mainState.longTermGoalService?.resolveScheduledTaskOptions(task),
    shouldNotifyReport: (report) => mainState.longTermGoalService?.shouldNotifyScheduledReport(report),
    onTasksChanged: (tasks: ScheduledTaskDefinition[]) => {
      broadcastToAppWindows('scheduler:tasksChanged', tasks)
    },
    onReportsChanged: (reports: ScheduledTaskRunReport[]) => {
      broadcastToAppWindows('scheduler:reportsChanged', reports)
      setTimeout(() => {
        mainState.longTermGoalService?.reconcileScheduledReports(mainState.scheduledTaskService?.listAllReports() || [])
      }, 0)
    },
    onReportNotificationClick: (report: ScheduledTaskRunReport) => {
      broadcastToAppWindows('scheduler:reportRequested', report)
    }
  })
  mainState.aiEngine.setScheduledTaskService(mainState.scheduledTaskService)
  mainState.scheduledTaskService.start()

  mainState.longTermGoalService = new LongTermGoalService({
    store: mainState.longTermGoalStore,
    scheduledTaskService: mainState.scheduledTaskService,
    aiEngine: mainState.aiEngine!,
    skillStore: mainState.skillStore!,
    projectFS: mainState.projectFS!,
    resolveProviderConfig: (providerId, modelId, reasoningEffort, temperature) => resolveProviderConfig(providerId || undefined, modelId || undefined, reasoningEffort, temperature),
    onGoalsChanged: (goals) => {
      broadcastToAppWindows('longTermGoals:goalsChanged', goals)
    },
    onSnapshotChanged: (snapshot) => {
      broadcastToAppWindows('longTermGoals:snapshotChanged', snapshot)
    },
    onInterventionRequested: (_goal, intervention) => {
      broadcastToAppWindows('longTermGoals:interventionRequested', intervention)
    },
    onRunProgress: (goalId, run) => {
      broadcastToAppWindows('longTermGoals:runProgress', { goalId, run })
    }
  })
  mainState.longTermGoalService.start()

  // Apply saved AI settings on startup
  const providersConfig = applyActiveProviderToAiEngine()
  const activeProvider = providersConfig.providers.find(p => p.id === providersConfig.activeProviderId)
  if (activeProvider) {
    console.log('[main] Applied active AI provider settings')
  }

  // Apply saved cost settings on startup
  const savedCostSettings = mainState.settingsStore!.getCostSettings()
  if (savedCostSettings.modelPricing.length > 0) {
    const pricingMap: Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number }> = {}
    for (const entry of savedCostSettings.modelPricing) {
      pricingMap[entry.model] = {
        inputPerMillion: entry.inputPerMillion,
        outputPerMillion: entry.outputPerMillion,
        cacheReadPerMillion: entry.cacheReadPerMillion || undefined
      }
    }
    mainState.aiEngine.setCustomModelPricing(pricingMap)
  }
  if (savedCostSettings.budgetLimit != null) {
    mainState.aiEngine.setBudgetLimit(savedCostSettings.budgetLimit)
  }

  applyMcpServersToService()

  mainState.appGateway = new AppGateway(mainState.runtimeManager, mainState.projectFS, mainState.builderService)
  mainState.processManagerService = new ProcessManagerService(mainState.runtimeManager, mainState.projectFS)
  // System snapshots read the current runtime/app-gateway state directly.
  // Periodic health checks are started here before the service is exposed via IPC/LAN.
  mainState.appGateway.startHealthChecks()
  console.log('[main] AppGateway health checks started')

  mainState.systemService = new SystemService(mainState.runtimeManager, mainState.appGateway)

  mainState.lanServer = new LanServer({
    port: LAN_SERVER_PORT,
    projectFS: mainState.projectFS!,
    runtimeManager: mainState.runtimeManager!,
    apiClient: mainState.apiClient!,
    dataAccess: mainState.dataAccess!,
    aiEngine: mainState.aiEngine!,
    systemService: mainState.systemService!,
    settingsStore: mainState.settingsStore!,
    imGatewayService: mainState.imGatewayService!
  })

  await mainState.lanServer.start()
  console.log('[main] LAN server started on port 19527')
}
