import { toolOpenProjectApp } from './tool-open-project-app.js'
import { toolOpenWorkspaceTab } from './tool-open-workspace-tab.js'
import { toolManageWorkspaceTabs } from './tool-manage-workspace-tabs.js'
import { toolInteractCurrentPage, toolReadCurrentPage, toolFillCurrentPageForm, toolSaveCurrentPageAsDocument } from './tool-active-page.js'
import { toolAskUser } from './tool-ask-user.js'
import type { AgentCore, SessionState } from '../agent-core.js'
import type { ProjectDataAccess } from '../../../project-data-access/data-access.js'
import type { SettingsStore } from '../../../settings/settings-store.js'
import type { ScheduledTaskService } from '../../../scheduler/scheduled-task-service.js'
import type { BrowserWindow } from 'electron'
import type { PageAutomationServices } from '../../engine-contracts.js'

import type { WorkspaceTabControlRequest, WorkspaceTabControlResult } from '../../../../shared/workspace-control-types.js'

export interface ToolServices extends PageAutomationServices {
  dataAccess: ProjectDataAccess
  /** Mirror a UI-created document artifact into the Rust artifact store. */
  persistDocumentArtifact?: (artifact: Record<string, unknown> & { id: string }) => void
  settingsStore?: SettingsStore
  getMainWindow?: () => BrowserWindow | null
  /**
   * Chat conversation this run belongs to; UI-targeting tools forward it so
   * the renderer routes workspace tabs to the right conversation's workspace
   * instead of whichever conversation is currently displayed.
   */
  conversationId?: string
  /** Round-trip to the renderer workspace store for AI tab list/activate/close. */
  requestWorkspaceTabControl?: (request: WorkspaceTabControlRequest) => Promise<WorkspaceTabControlResult>
  notifySkillsChanged?: (event: { action: string; count?: number; id?: string }) => void
  notifyAgentWorkspaceChanged?: (event: { entity: 'agent' | 'group' | 'binding'; action: string; id?: string }) => void
  scheduledTaskService?: ScheduledTaskService
  /** Conversation-scoped local folder selected by the user for code work. */
  workspaceRoot?: string | null
}

/**
 * Register all tools to the agent.
 */
export function registerAllTools (agent: AgentCore, services: ToolServices): void {
  const getAbortSignal = (): AbortSignal | undefined => agent.getAbortSignal() ?? undefined
  const getSessionState = (): SessionState => ({
    ...agent.sessionState,
    authMode: agent.getEffectiveAuthMode()
  })
  // Project file CRUD and project glob/grep search are Rust-native
  // (`electron_native`), including the Office direct-write guard and the
  // SafeWriter-style backup that Electron's handlers used to own.
  const tools = [
    toolOpenProjectApp(services),
    toolOpenWorkspaceTab(services),
    toolManageWorkspaceTabs(services),
    toolAskUser({
      getMainWindow: services.getMainWindow,
      getSessionState,
      getAbortSignal
    }),
  ]

  if (services.readActivePage || services.runPageAutomation) {
    tools.push(toolReadCurrentPage(services))
  }

  if ((services.readActivePage || services.runPageAutomation) && (services.interactWithActivePage || services.runPageAutomation)) {
    tools.push(toolInteractCurrentPage(services), toolFillCurrentPageForm(services), toolSaveCurrentPageAsDocument(services))
  }

  for (const tool of tools) {
    agent.registerTool(tool.definition.name, tool.definition, tool.handler)
  }
}
