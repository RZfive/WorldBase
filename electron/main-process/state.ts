import { AsyncLocalStorage } from 'node:async_hooks'
import type { BrowserWindow } from 'electron'
import type { AIEngine } from '../../src/main/ai-engine/ai-engine.js'
import type { ProjectFS } from '../../src/main/project-fs/project-fs.js'
import type { ProjectPackageService } from '../../src/main/project-fs/project-package-service.js'
import type { RuntimeManager } from '../../src/main/project-runtime/runtime-manager.js'
import type { BuilderService } from '../../src/main/project-runtime/builder-service.js'
import type { AppGateway } from '../../src/main/project-runtime/app-gateway.js'
import type { ProcessManagerService } from '../../src/main/project-runtime/process-manager-service.js'
import type { UpdateService } from '../../src/main/app-update/update-service.js'
import type { ProjectApiClient } from '../../src/main/project-api-bridge/api-client.js'
import type { ProjectDataAccess } from '../../src/main/project-data-access/data-access.js'
import type { LanServer } from '../../src/main/lan-server/server.js'
import type { SystemService } from '../../src/main/system-capabilities/system-service.js'
import type { SettingsStore, AIExecutionAuthMode } from '../../src/main/settings/settings-store.js'
import type { ChatHistoryStore } from '../../src/main/settings/chat-history.js'
import type { AILogStore } from '../../src/main/settings/ai-log-store.js'
import type { ImageLibraryStore } from '../../src/main/settings/image-library-store.js'
import type { StudioTaskStore } from '../../src/main/settings/studio-task-store.js'
import type { ImageStudioGenerateRequest } from '../../src/shared/image-studio-types.js'
import type { SkillStore } from '../../src/main/settings/skill-store.js'
import type { AgentStore } from '../../src/main/settings/agent-store.js'
import type { AgentGroupStore } from '../../src/main/settings/agent-group-store.js'
import type { ScheduledTaskStore } from '../../src/main/settings/scheduled-task-store.js'
import type { LongTermGoalStore } from '../../src/main/settings/long-term-goal-store.js'
import type { ChannelBindingStore } from '../../src/main/im/channel-binding-store.js'
import type { ImGatewayService } from '../../src/main/im/im-gateway-service.js'
import type { MemoryStore } from '../../src/main/ai-engine/memory/memory-store.js'
import type { MemoryEngine } from '../../src/main/ai-engine/memory/memory-engine.js'
import type { AsyncTaskManager } from '../../src/main/ai-engine/agent/tools/async-task-manager.js'
import type { DocumentStore } from '../../src/main/ai-engine/agent/tools/document-store.js'
import type { MCPService } from '../../src/main/mcp/mcp-service.js'
import type { ScheduledTaskService } from '../../src/main/scheduler/scheduled-task-service.js'
import type { LongTermGoalService } from '../../src/main/long-term-goals/long-term-goal-service.js'
import type { MemoryCompactionResult, MemoryCompactionStatus } from '../../src/shared/agent-workspace-types.js'
import type { PageAutomationRendererResult } from '../../src/shared/page-automation-types.js'
import { t } from '../../src/main/i18n/main-i18n.js'

export type WindowBounds = ReturnType<BrowserWindow['getBounds']>
export type EnsureWindowWidthOptions = {
  animate?: boolean
  durationMs?: number
  allowShrink?: boolean
}

export type PendingPageAutomationRequest = {
  resolve: (result: PageAutomationRendererResult) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export type ActiveWindowWidthAnimation = {
  timer: ReturnType<typeof setInterval>
  resolve: (result: { applied: boolean; width: number }) => void
}

export interface ActiveChatSession {
  abortController: AbortController
  authMode: { current: AIExecutionAuthMode }
}

export const projectWindows = new Map<string, BrowserWindow>()
export const activeChatSessions = new Map<string, ActiveChatSession>()
export const aiRequestWindowStorage = new AsyncLocalStorage<BrowserWindow | null>()
export const pendingPageAutomationRequests = new Map<string, PendingPageAutomationRequest>()
export const activeWindowWidthAnimations = new Map<number, ActiveWindowWidthAnimation>()

export const mainState = {
  mainWindow: null as BrowserWindow | null,
  aiEngine: null as AIEngine | null,
  projectFS: null as ProjectFS | null,
  runtimeManager: null as RuntimeManager | null,
  builderService: null as BuilderService | null,
  appGateway: null as AppGateway | null,
  processManagerService: null as ProcessManagerService | null,
  updateService: null as UpdateService | null,
  systemService: null as SystemService | null,
  apiClient: null as ProjectApiClient | null,
  dataAccess: null as ProjectDataAccess | null,
  projectPackageService: null as ProjectPackageService | null,
  asyncTaskManager: null as AsyncTaskManager | null,
  lanServer: null as LanServer | null,
  settingsStore: null as SettingsStore | null,
  chatHistory: null as ChatHistoryStore | null,
  aiLogStore: null as AILogStore | null,
  skillStore: null as SkillStore | null,
  agentStore: null as AgentStore | null,
  agentGroupStore: null as AgentGroupStore | null,
  channelBindingStore: null as ChannelBindingStore | null,
  imGatewayService: null as ImGatewayService | null,
  memoryStore: null as MemoryStore | null,
  memoryEngine: null as MemoryEngine | null,
  activeMemoryCompactionPromise: null as Promise<MemoryCompactionResult> | null,
  memoryCompactionStatus: {
    id: null,
    status: 'idle',
    stage: t('mainDialog.memoryCompactionIdle'),
    scanned: 0,
    totalChunks: 0,
    completedChunks: 0,
    updatedAt: new Date().toISOString()
  } as MemoryCompactionStatus,
  scheduledTaskStore: null as ScheduledTaskStore | null,
  scheduledTaskService: null as ScheduledTaskService | null,
  longTermGoalStore: null as LongTermGoalStore | null,
  longTermGoalService: null as LongTermGoalService | null,
  documentStore: null as DocumentStore | null,
  imageLibraryStore: null as ImageLibraryStore | null,
  studioTaskStore: null as StudioTaskStore | null,
  pendingStudioImageTasks: [] as ImageStudioGenerateRequest[],
  mcpService: null as MCPService | null,
  isClosingMainWindow: false,
  isQuitCleanupRunning: false,
  hasFinishedQuitCleanup: false
}
