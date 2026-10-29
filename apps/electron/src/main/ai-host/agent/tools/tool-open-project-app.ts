import type { BrowserWindow } from 'electron'
import type { ToolDefinition } from '../../../ai-harness/contracts.js'

interface ToolServices {
  getMainWindow?: () => BrowserWindow | null
  /** Chat conversation this run belongs to (see ToolServices in tools/index.ts). */
  conversationId?: string
}

interface OpenProjectAppArgs {
  project_id: string
  mode?: 'embed' | 'window'
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: (stage: string, detail?: string) => void) => Promise<unknown>
}

export function toolOpenProjectApp (services: ToolServices): Tool {
  return {
    definition: {
      name: 'open_project_app',
      description: 'Ask WorldBase shell to open an existing project in the managed app UI. Prefer this over launching an unmanaged preview server yourself.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          },
          mode: {
            type: 'string',
            enum: ['embed', 'window'],
            description: 'How the shell should open the project. Use embed by default; use window only when the user explicitly wants a standalone window.'
          }
        },
        required: ['project_id']
      }
    },
    handler: async (args, onProgress) => {
      const { project_id, mode = 'embed' } = args as unknown as OpenProjectAppArgs
      const mainWindow = services.getMainWindow?.()

      if (!mainWindow || mainWindow.isDestroyed()) {
        throw new Error('The main shell window is not available, so the project cannot be opened in the managed UI right now.')
      }

      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }

      mainWindow.focus()
      onProgress?.('Opening project in shell UI...', `${project_id} (${mode})`)
      mainWindow.webContents.send('project:openInShell', {
        projectId: project_id,
        mode,
        ...(services.conversationId ? { conversationId: services.conversationId } : {})
      })

      return {
        success: true,
        project_id,
        mode,
        opened_via: 'shell_ui'
      }
    }
  }
}
