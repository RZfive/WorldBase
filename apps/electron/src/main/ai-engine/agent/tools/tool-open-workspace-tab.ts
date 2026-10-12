import type { BrowserWindow } from 'electron'
import type { ToolDefinition } from '../../providers/openai-provider.js'

interface ToolServices {
  getMainWindow?: () => BrowserWindow | null
}

interface OpenWorkspaceTabArgs {
  kind: string
  root_path?: string
  file_path?: string
  url?: string
  active_file_path?: string
  project_id?: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: (stage: string, detail?: string) => void) => Promise<unknown>
}

export function toolOpenWorkspaceTab (services: ToolServices): Tool {
  return {
    definition: {
      name: 'open_workspace_tab',
      description: 'Open a tab in the user\'s right-side workspace panel next to the chat. Use kind "folder" with root_path to bind a code directory; kind "document" with file_path to open one document (PDF/Excel/Word/...); kind "browser" with url to open a web page the user can watch and you can operate with the page tools (read_current_page / interact_current_page); kind "terminal" to open a shell terminal you can operate with read_active_terminal / write_active_terminal; kind "project" with project_id to open one of the user\'s developed apps (you can operate its UI with the page tools). The panel stays visible after the reply finishes.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['folder', 'document', 'browser', 'terminal', 'project'],
            description: 'Which workspace tab to open.'
          },
          root_path: {
            type: 'string',
            description: 'folder only: absolute directory path to bind as the code workspace root. Omit to let the user pick a folder interactively.'
          },
          file_path: {
            type: 'string',
            description: 'document only: absolute path of the document file to open as its own tab. Reopening a bound path just focuses its tab.'
          },
          url: {
            type: 'string',
            description: 'browser only: URL to load in the embedded browser tab.'
          },
          project_id: {
            type: 'string',
            description: 'project only: id of one of the user\'s developed apps (from list_projects). Its UI opens in the workspace panel.'
          },
          active_file_path: {
            type: 'string',
            description: 'Optional: file path (relative to root_path for folder tabs) to select after opening.'
          }
        },
        required: ['kind']
      }
    },
    handler: async (args, onProgress) => {
      const {
        kind,
        root_path: rootPath,
        file_path: filePath,
        url,
        active_file_path: activeFilePath,
        project_id: projectId
      } = args as unknown as OpenWorkspaceTabArgs
      if (kind !== 'folder' && kind !== 'document' && kind !== 'browser' && kind !== 'terminal' && kind !== 'project') {
        throw new Error('open_workspace_tab: kind must be "folder", "document", "browser", "terminal" or "project"')
      }

      const mainWindow = services.getMainWindow?.()
      if (!mainWindow || mainWindow.isDestroyed()) {
        throw new Error('The main shell window is not available, so the workspace panel cannot be opened right now.')
      }

      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }

      mainWindow.focus()

      const payload: Record<string, unknown> = {}
      if (typeof rootPath === 'string' && rootPath.trim()) payload.rootPath = rootPath.trim()
      if (typeof filePath === 'string' && filePath.trim()) payload.filePath = filePath.trim()
      if (typeof url === 'string' && url.trim()) payload.url = url.trim()
      if (typeof activeFilePath === 'string' && activeFilePath.trim()) payload.activeFilePath = activeFilePath.trim()
      if (typeof projectId === 'string' && projectId.trim()) payload.projectId = projectId.trim()

      onProgress?.('Opening workspace panel...', `${kind}`)
      mainWindow.webContents.send('workspace:openTab', {
        kind,
        ...(Object.keys(payload).length > 0 ? { payload } : {})
      })

      return {
        success: true,
        kind,
        ...(Object.keys(payload).length > 0 ? { requested: payload } : {})
      }
    }
  }
}
