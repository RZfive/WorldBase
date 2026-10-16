import type { WorkspaceTabControlRequest, WorkspaceTabControlResult } from '../../../../shared/workspace-control-types.js'
import type { ToolDefinition } from '../../../ai-harness/contracts.js'

interface ToolServices {
  requestWorkspaceTabControl?: (request: WorkspaceTabControlRequest) => Promise<WorkspaceTabControlResult>
  /** Chat conversation this run belongs to (see ToolServices in tools/index.ts). */
  conversationId?: string
}

interface ManageWorkspaceTabsArgs {
  action: string
  tab_id?: string
  kind?: string
  url?: string
  cwd?: string
  file_path?: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: (stage: string, detail?: string) => void) => Promise<unknown>
}

const TAB_KINDS = ['folder', 'document', 'browser', 'terminal', 'project'] as const

export function toolManageWorkspaceTabs (services: ToolServices): Tool {
  return {
    definition: {
      name: 'manage_workspace_tabs',
      description: 'List, switch to, or close tabs in the user\'s right-side workspace panel. Switching tabs retargets your UI tools: after activating a terminal tab, read_active_terminal / write_active_terminal operate on that terminal; after activating a browser tab, read_current_page / interact_current_page operate on that page. Actions: "list" returns every open tab with id, kind, title and its url/cwd/file_path/project_id; "activate" focuses an existing tab (by tab_id from a previous list, or by kind plus url/cwd/file_path) and reveals the panel — use it to show a terminal or web page to the user, or to retarget your terminal/page tools; it never creates tabs (use open_workspace_tab for that); "close" closes one tab (closing the last tab hides the panel, and closing a terminal tab kills its session).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'activate', 'close'],
            description: 'What to do with the workspace tabs.'
          },
          tab_id: {
            type: 'string',
            description: 'Exact tab id from a previous "list" result. Wins over kind/matchers.'
          },
          kind: {
            type: 'string',
            enum: [...TAB_KINDS],
            description: 'Tab kind filter; with url/cwd/file_path it locates one specific tab, without them it targets the first tab of that kind.'
          },
          url: {
            type: 'string',
            description: 'browser only: match an existing tab by URL (same rule as open dedupe).'
          },
          cwd: {
            type: 'string',
            description: 'terminal only: match an existing terminal tab by working directory.'
          },
          file_path: {
            type: 'string',
            description: 'document only: match an existing document tab by file path.'
          }
        },
        required: ['action']
      }
    },
    handler: async (args, onProgress) => {
      const {
        action,
        tab_id: tabId,
        kind,
        url,
        cwd,
        file_path: filePath
      } = args as unknown as ManageWorkspaceTabsArgs
      if (action !== 'list' && action !== 'activate' && action !== 'close') {
        throw new Error('manage_workspace_tabs: action must be "list", "activate" or "close"')
      }
      if (kind && !(TAB_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`manage_workspace_tabs: kind must be one of ${TAB_KINDS.join(', ')}`)
      }
      if (action !== 'list' && !tabId?.trim() && !kind) {
        throw new Error(`manage_workspace_tabs: ${action} requires tab_id (from a previous list) or kind`)
      }

      const roundTrip = services.requestWorkspaceTabControl
      if (!roundTrip) {
        throw new Error('Electron host service unavailable for manage_workspace_tabs')
      }

      const request: WorkspaceTabControlRequest = { action }
      if (services.conversationId) request.conversationId = services.conversationId
      if (typeof tabId === 'string' && tabId.trim()) request.tabId = tabId.trim()
      if (typeof kind === 'string' && kind.trim()) request.kind = kind.trim()
      if (typeof url === 'string' && url.trim()) request.url = url.trim()
      if (typeof cwd === 'string' && cwd.trim()) request.cwd = cwd.trim()
      if (typeof filePath === 'string' && filePath.trim()) request.filePath = filePath.trim()

      onProgress?.(
        action === 'list' ? 'Listing workspace tabs...' : `${action === 'activate' ? 'Switching to' : 'Closing'} workspace tab...`,
        request.tabId || request.kind || ''
      )
      return await roundTrip(request)
    }
  }
}
