import { toolReadFile } from './tool-read-file.js'
import { toolDeleteFile } from './tool-delete-file.js'
import { toolWriteFile } from './tool-write-file.js'
import { toolCallApi } from './tool-call-api.js'
import { toolQueryDb } from './tool-query-db.js'
import { toolRunCommand } from './tool-run-command.js'
import { toolListProjects } from './tool-list-projects.js'
import { toolAnalyzeData } from './tool-analyze-data.js'
import { toolCreateProject } from './tool-create-project.js'
import { toolLocalFileRead } from './tool-local-file-read.js'
import { toolLocalCommand } from './tool-local-command.js'
import { toolLocalWriteFile } from './tool-local-file-write.js'
import { toolRebuildProject } from './tool-rebuild-project.js'
import type { AgentCore } from '../agent-core.js'
import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { RuntimeManager } from '../../../project-runtime/runtime-manager.js'
import type { BuilderService } from '../../../project-runtime/builder-service.js'
import type { ProjectApiClient } from '../../../project-api-bridge/api-client.js'
import type { ProjectDataAccess } from '../../../project-data-access/data-access.js'
import type { BrowserWindow } from 'electron'
import type { AIExecutionPreferences } from '../../../settings/settings-store.js'

export interface ToolServices {
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
  builderService: BuilderService
  apiClient: ProjectApiClient
  dataAccess: ProjectDataAccess
  getMainWindow?: () => BrowserWindow | null
  getAIExecutionPreferences?: () => AIExecutionPreferences
}

/**
 * Register all tools to the agent.
 */
export function registerAllTools (agent: AgentCore, services: ToolServices): void {
  const tools = [
    toolReadFile(services),
    toolDeleteFile(services),
    toolWriteFile(services),
    toolCallApi(services),
    toolQueryDb(services),
    toolRunCommand(services),
    toolListProjects(services),
    toolAnalyzeData(services),
    toolCreateProject(services, () => agent.sessionState),
    toolRebuildProject(services),
    toolLocalFileRead(services),
    toolLocalCommand(services),
    toolLocalWriteFile(services)
  ]

  for (const tool of tools) {
    agent.registerTool(tool.definition.name, tool.definition, tool.handler)
  }
}
