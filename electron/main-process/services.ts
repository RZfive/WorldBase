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

export async function ensureStableUserDataPath (): Promise<void> {
  const userDataPath = app.getPath('userData')
  const userDataExists = await pathExists(userDataPath)
  const appDataPath = app.getPath('appData')

  for (const legacyName of LEGACY_USER_DATA_DIR_NAMES) {
    const legacyPath = path.join(appDataPath, legacyName)
    if (!(await pathExists(legacyPath))) {
      continue
    }

    if (!userDataExists) {
      try {
        await fs.mkdir(path.dirname(userDataPath), { recursive: true })
        await fs.rename(legacyPath, userDataPath)
        console.log(`[main] Migrated userData from ${legacyPath} to ${userDataPath}`)
      } catch (error) {
        console.warn(`[main] Failed to migrate userData from ${legacyPath} to ${userDataPath}; continuing with legacy path`, error)
        app.setPath('userData', legacyPath)
      }
      return
    }

    const [currentHasCriticalData, legacyHasCriticalData] = await Promise.all([
      getCriticalUserDataPresence(userDataPath),
      getCriticalUserDataPresence(legacyPath)
    ])

    if (!currentHasCriticalData && legacyHasCriticalData) {
      console.log(`[main] Using legacy userData path ${legacyPath} because ${userDataPath} has no settings/projects history yet`)
      app.setPath('userData', legacyPath)
    }
    return
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
