import { toolReadFile } from './tool-read-file.js'
import { toolDeleteFile } from './tool-delete-file.js'
import { toolWriteFile } from './tool-write-file.js'
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
import { toolGetProjectLogs } from './tool-get-project-logs.js'
import { toolGetProjectStatus } from './tool-get-project-status.js'
import { toolGetTaskStatus, toolStartAsyncTask } from './tool-async-task.js'
import { toolStartProjectServer } from './tool-start-server.js'
import { toolRestartProjectServer } from './tool-restart-server.js'
import { toolOpenProjectApp } from './tool-open-project-app.js'
import { toolReadDocument, toolListDocuments } from './tool-read-document.js'
import type { AsyncTaskManager } from './async-task-manager.js'
import type { DocumentStore } from './document-store.js'
import type { AgentCore, SessionState } from '../agent-core.js'
import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { RuntimeManager } from '../../../project-runtime/runtime-manager.js'
import type { BuilderService } from '../../../project-runtime/builder-service.js'
import type { ProjectApiClient } from '../../../project-api-bridge/api-client.js'
import type { ProjectDataAccess } from '../../../project-data-access/data-access.js'
import type { BrowserWindow } from 'electron'

export interface ToolServices {
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
  builderService: BuilderService
  apiClient: ProjectApiClient
  dataAccess: ProjectDataAccess
  asyncTaskManager: AsyncTaskManager
  documentStore?: DocumentStore
  getMainWindow?: () => BrowserWindow | null
}

/**
 * Register all tools to the agent.
 */
export function registerAllTools (agent: AgentCore, services: ToolServices): void {
  const getSessionState = (): SessionState => agent.sessionState
  const tools = [
    toolReadFile(services),
    toolDeleteFile(services),
    toolWriteFile(services),
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
    toolAnalyzeData(services),
    toolCreateProject(services, getSessionState),
    toolRebuildProject(services),
    toolStartAsyncTask(services),
    toolGetTaskStatus(services),
    toolLocalFileRead(services, getSessionState),
    toolLocalCommand(services, getSessionState),
    toolLocalWriteFile(services, getSessionState)
  ]

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
