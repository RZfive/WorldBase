import type { BrowserWindow } from 'electron'
import type { ToolDefinition } from '../../../ai-harness/contracts.js'
import { validateAiBrowserTarget } from '../../../../shared/web-target-validation.js'

interface ToolServices {
  getMainWindow?: () => BrowserWindow | null
  /** Chat conversation this run belongs to (see ToolServices in tools/index.ts). */
  conversationId?: string
}

interface OpenWorkspaceTabArgs {
  kind: string
  root_path?: string
  file_path?: string
  title?: string
  markdown?: string
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
      description: 'Open a tab in the user\'s right-side workspace panel next to the chat. Use kind "folder" with root_path to bind a code directory; kind "document" with file_path to open one document (PDF/Excel/Word/...), or with title and markdown to open an in-memory Markdown document (use this for long PRDs and plans; it is never written to disk); kind "browser" with url to open a web page the user can watch and you can operate with the page tools (read_current_page / interact_current_page, including screenshots, diagnostics, navigation and viewport resize); kind "terminal" to open a shell terminal you can operate with read_active_terminal / write_active_terminal; kind "project" with project_id to open one of the user\'s developed apps (you can operate its UI with the page tools). The panel stays visible after the reply finishes.',
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
          title: {
            type: 'string',
            description: 'document only: title for an in-memory AI-authored Markdown document.'
          },
          markdown: {
            type: 'string',
            description: 'document only: full Markdown body for an in-memory document tab. Use this for PRDs, plans, and long proposals; it is never written to disk.'
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
        title,
        markdown,
        url,
        active_file_path: activeFilePath,
        project_id: projectId
      } = args as unknown as OpenWorkspaceTabArgs
      if (kind !== 'folder' && kind !== 'document' && kind !== 'browser' && kind !== 'terminal' && kind !== 'project') {
        throw new Error('open_workspace_tab: kind must be "folder", "document", "browser", "terminal" or "project"')
      }

      const browserTarget = kind === 'browser'
        ? validateAiBrowserTarget(typeof url === 'string' ? url : '')
        : null
      if (browserTarget && !browserTarget.ok) {
        throw new Error(`open_workspace_tab: browser URL rejected: ${browserTarget.reason} For a loopback/local project preview, use kind="project" with project_id or open_project_app; do not fall back to an external browser MCP.`)
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
      if (typeof title === 'string' && title.trim()) payload.title = title.trim()
      if (typeof markdown === 'string' && markdown.trim()) payload.markdown = markdown
      if (browserTarget?.ok) payload.url = browserTarget.url
      else if (typeof url === 'string' && url.trim()) payload.url = url.trim()
      if (typeof activeFilePath === 'string' && activeFilePath.trim()) payload.activeFilePath = activeFilePath.trim()
      if (typeof projectId === 'string' && projectId.trim()) payload.projectId = projectId.trim()

      onProgress?.('Opening workspace panel...', `${kind}`)
      mainWindow.webContents.send('workspace:openTab', {
        kind,
        ...(Object.keys(payload).length > 0 ? { payload } : {}),
        ...(services.conversationId ? { conversationId: services.conversationId } : {})
      })

      const requested = { ...payload }
      delete requested.markdown
      return {
        success: true,
        kind,
        ...(Object.keys(requested).length > 0 ? { requested } : {})
      }
    }
  }
}
