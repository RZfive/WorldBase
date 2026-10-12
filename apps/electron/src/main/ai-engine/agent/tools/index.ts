import { toolReadFile } from './tool-read-file.js'
import { toolDeleteFile } from './tool-delete-file.js'
import { toolWriteFile } from './tool-write-file.js'
import { toolPatchFile } from './tool-patch-file.js'
import { toolEditFile } from './tool-edit-file.js'
import { ReadFileTracker } from './read-tracker.js'
import { toolCallApi } from './tool-call-api.js'
import { toolQueryDb } from './tool-query-db.js'
import { toolGetProjectCommandStatus, toolRunCommand } from './tool-run-command.js'
import { toolListProjects } from './tool-list-projects.js'
import { toolListProjectFiles } from './tool-list-project-files.js'
import { toolAnalyzeData } from './tool-analyze-data.js'
import { toolCreateProject } from './tool-create-project.js'
import { toolLocalFileRead } from './tool-local-file-read.js'
import { toolLocalCommand } from './tool-local-command.js'
import { toolLocalWriteFile } from './tool-local-file-write.js'
import { toolRebuildProject } from './tool-rebuild-project.js'
import { toolFinalizeProject } from './tool-finalize-project.js'
import { toolClearProjectBuildFlag } from './tool-clear-build-flag.js'
import { toolGetProjectLogs } from './tool-get-project-logs.js'
import { toolGetProjectStatus } from './tool-get-project-status.js'
import { toolStartProjectServer } from './tool-start-server.js'
import { toolRestartProjectServer } from './tool-restart-server.js'
import { toolOpenProjectApp } from './tool-open-project-app.js'
import { toolOpenWorkspaceTab } from './tool-open-workspace-tab.js'
import { toolReadDocument, toolListDocuments } from './tool-read-document.js'
import { toolRunWorkspaceCommand, toolGetWorkspaceCommandStatus } from './tool-workspace-command.js'
import { toolGlobSearch } from './tool-glob-search.js'
import { toolGrepSearch } from './tool-grep-search.js'
import { toolWebSearch } from './tool-web-search.js'
import { toolFetchWebpage } from './tool-fetch-webpage.js'
import { toolInteractCurrentPage, toolReadCurrentPage, toolFillCurrentPageForm, toolSaveCurrentPageAsDocument } from './tool-active-page.js'
import { toolRunSkill, toolListSkills } from './tool-run-skill.js'
import { toolInstallSkill } from './tool-install-skill.js'
import { toolInstallMcpServer } from './tool-install-mcp-server.js'
import { toolCreateScheduledTask, toolListScheduledTasks } from './tool-scheduled-task.js'
import { toolCreateAgent, toolCreateAgentGroup, toolListAgentWorkspaceCatalog } from './tool-agent-workspace.js'
import { toolManageTodoList, type TodoItem } from './tool-manage-todo-list.js'
import { toolAskUser } from './tool-ask-user.js'
import type { AsyncTaskManager } from './async-task-manager.js'
import type { DocumentStore } from './document-store.js'
import type { AgentCore, SessionState, SubagentService } from '../agent-core.js'
import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { RuntimeManager } from '../../../project-runtime/runtime-manager.js'
import type { BuilderService } from '../../../project-runtime/builder-service.js'
import type { ProjectApiClient } from '../../../project-api-bridge/api-client.js'
import type { ProjectDataAccess } from '../../../project-data-access/data-access.js'
import type { AgentStore } from '../../../settings/agent-store.js'
import type { AgentGroupStore } from '../../../settings/agent-group-store.js'
import type { SkillStore } from '../../../settings/skill-store.js'
import type { SettingsStore } from '../../../settings/settings-store.js'
import type { MCPService } from '../../../mcp/mcp-service.js'
import type { ScheduledTaskService } from '../../../scheduler/scheduled-task-service.js'
import type { BrowserWindow } from 'electron'

import { toolSpawnSubagents } from './tool-spawn-subagent.js'
import type { BrowserAutomationAction, BrowserAutomationActionResult, BrowserAutomationSnapshot } from '../../../../shared/page-automation-types.js'

export interface ToolServices {
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
  builderService: BuilderService
  apiClient: ProjectApiClient
  dataAccess: ProjectDataAccess
  asyncTaskManager: AsyncTaskManager
  documentStore?: DocumentStore
  skillStore?: SkillStore
  agentStore?: AgentStore
  agentGroupStore?: AgentGroupStore
  settingsStore?: SettingsStore
  getMainWindow?: () => BrowserWindow | null
  readActivePage?: () => Promise<BrowserAutomationSnapshot>
  interactWithActivePage?: (action: BrowserAutomationAction) => Promise<BrowserAutomationActionResult>
  notifySkillsChanged?: (event: { action: string; count?: number; id?: string }) => void
  notifyAgentWorkspaceChanged?: (event: { entity: 'agent' | 'group' | 'binding'; action: string; id?: string }) => void
  mcpService?: MCPService
  scheduledTaskService?: ScheduledTaskService
  /** Optional subagent service — injects the spawn_subagents tool when provided. */
  subagentService?: SubagentService
  /** Conversation-scoped local folder selected by the user for code work. */
  workspaceRoot?: string | null
}

/**
 * Register all tools to the agent.
 */
export function registerAllTools (agent: AgentCore, services: ToolServices): void {
  const getSessionState = (): SessionState => ({
    ...agent.sessionState,
    authMode: agent.getEffectiveAuthMode()
  })
  const getAbortSignal = (): AbortSignal | undefined => agent.getAbortSignal() ?? undefined
  const todoState: { items: TodoItem[] } = { items: [] }
  // Shared across read/write/edit so exact-string edits can require the file to
  // have been read (or written) earlier in this agent's lifetime.
  const readTracker = new ReadFileTracker()
  const tools = [
    toolReadFile(services, readTracker),
    toolDeleteFile(services),
    toolWriteFile(services, readTracker),
    toolPatchFile(services),
    toolEditFile(services, readTracker),
    toolCallApi(services),
    toolQueryDb(services),
    toolRunCommand(services),
    toolGetProjectCommandStatus(),
    toolListProjects(services),
    toolListProjectFiles(services),
    toolGetProjectStatus(services),
    toolGetProjectLogs(services),
    toolStartProjectServer(services),
    toolRestartProjectServer(services),
    toolOpenProjectApp(services),
    toolOpenWorkspaceTab(services),
    toolAnalyzeData(services),
    toolCreateProject(services, getSessionState),
    toolRebuildProject(services),
    toolFinalizeProject(services),
    toolClearProjectBuildFlag(services),
    toolLocalFileRead(services, getSessionState, getAbortSignal),
    toolLocalCommand(services, getSessionState, getAbortSignal),
    toolLocalWriteFile(services, getSessionState, getAbortSignal),
    toolGlobSearch(services),
    toolGrepSearch(services),
    toolWebSearch(),
    toolFetchWebpage(),
    toolRunSkill(() => agent.getSkillEngine()),
    toolListSkills(() => agent.getSkillEngine()),
    toolInstallSkill(services, () => agent.getSkillEngine()),
    toolInstallMcpServer(services),
    toolManageTodoList(todoState),
    toolAskUser({
      getMainWindow: services.getMainWindow,
      getSessionState,
      getAbortSignal
    }),
    toolListScheduledTasks(services),
    toolCreateScheduledTask(services),
    toolListAgentWorkspaceCatalog(services, () => agent.getToolDefinitions()),
    toolCreateAgent(services, () => agent.getToolDefinitions()),
    toolCreateAgentGroup(services)
  ]

  // The folder-workspace file tools are Rust-native (`electron_native`); only
  // the command runner stays in the host because its bundled-runtime PATH
  // shims and foreground/background task registry are Electron-owned.
  if (services.workspaceRoot) {
    tools.push(
      toolRunWorkspaceCommand(services),
      toolGetWorkspaceCommandStatus()
    )
  }

  if (services.readActivePage) {
    tools.push(toolReadCurrentPage(services))
  }

  if (services.readActivePage && services.interactWithActivePage) {
    tools.push(toolInteractCurrentPage(services), toolFillCurrentPageForm(services), toolSaveCurrentPageAsDocument(services))
  }

  // Register the canonical spawn_subagents tool only when a subagent service is
  // available. Legacy tool-name aliases are resolved inside AgentCore so they
  // remain compatible without being exposed to the model as real tools.
  if (services.subagentService) {
    const subagentService = services.subagentService
    tools.push(toolSpawnSubagents(
      () => subagentService,
      getAbortSignal
    ))
  }

  // Register document tools if store is available
  if (services.documentStore) {
    tools.push(
      toolReadDocument(services.documentStore),
      toolListDocuments(services.documentStore)
    )
  }

  for (const tool of tools) {
    agent.registerTool(tool.definition.name, tool.definition, tool.handler)
  }
}
