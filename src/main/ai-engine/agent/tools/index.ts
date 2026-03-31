import { toolReadFile } from './tool-read-file.js'
import { toolWriteFile } from './tool-write-file.js'
import { toolCallApi } from './tool-call-api.js'
import { toolQueryDb } from './tool-query-db.js'
import { toolRunCommand } from './tool-run-command.js'
import { toolListProjects } from './tool-list-projects.js'
import { toolAnalyzeData } from './tool-analyze-data.js'
import { toolCreateProject } from './tool-create-project.js'
import type { AgentCore } from '../agent-core.js'
import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { RuntimeManager } from '../../../project-runtime/runtime-manager.js'
import type { ProjectApiClient } from '../../../project-api-bridge/api-client.js'
import type { ProjectDataAccess } from '../../../project-data-access/data-access.js'
import type { BrowserWindow } from 'electron'

export interface ToolServices {
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
  apiClient: ProjectApiClient
  dataAccess: ProjectDataAccess
  getMainWindow?: () => BrowserWindow | null
}

/**
 * Register all tools to the agent.
 */
export function registerAllTools (agent: AgentCore, services: ToolServices): void {
  const tools = [
    toolReadFile(services),
    toolWriteFile(services),
    toolCallApi(services),
    toolQueryDb(services),
    toolRunCommand(services),
    toolListProjects(services),
    toolAnalyzeData(services),
    toolCreateProject(services)
  ]

  for (const tool of tools) {
    agent.registerTool(tool.definition.name, tool.definition, tool.handler)
  }
}
