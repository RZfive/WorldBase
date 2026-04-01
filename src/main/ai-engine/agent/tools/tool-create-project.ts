import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { RuntimeManager } from '../../../project-runtime/runtime-manager.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback } from '../agent-core.js'
import type { BrowserWindow } from 'electron'

interface ToolServices {
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
  getMainWindow?: () => BrowserWindow | null
}

interface CreateProjectArgs {
  name: string
  type: string
  files: Record<string, string>
  meta?: Record<string, unknown>
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

/**
 * Tool: create_project — 创建新项目
 */
export function toolCreateProject (services: ToolServices): Tool {
  return {
    definition: {
      name: 'create_project',
      description: '根据 AI 生成的代码创建新项目。提供项目名称、类型、文件内容和元数据。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '项目名称 (如: 记账应用)'
          },
          type: {
            type: 'string',
            enum: ['frontend', 'backend', 'fullstack'],
            description: '项目类型'
          },
          files: {
            type: 'object',
            description: '文件内容映射 {相对路径: 文件内容}'
          },
          meta: {
            type: 'object',
            description: '.world-meta.json 的内容 (运行时配置、API 定义、数据模式等)'
          }
        },
        required: ['name', 'type', 'files']
      }
    },
    handler: async (args, onProgress) => {
      const { name, type, files, meta = {} } = args as unknown as CreateProjectArgs

      onProgress?.('🔧 正在初始化项目...', name)

      // Generate a project ID from the name
      const projectId = 'proj_' + name
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 30) +
        '_' + Date.now().toString(36)

      // Auto-generate runtime configuration if not provided
      const runtime = (meta.runtime as Record<string, unknown>) || {}
      if (!runtime.backend) {
        // Determine the start command based on project type and files
        let command = 'node server.js'
        let cwd: string | undefined

        if (files['package.json']) {
          try {
            const pkg = JSON.parse(files['package.json']) as Record<string, unknown>
            const scripts = pkg.scripts as Record<string, string> | undefined
            if (scripts) {
              if (scripts.start) {
                command = 'npm start'
              } else if (scripts.dev) {
                command = 'npm run dev'
              }
            }
          } catch (err) {
            // package.json may have invalid JSON; continue with defaults
            console.warn('[tool:create_project] Failed to parse package.json:', (err as Error).message)
          }
        }

        if (type === 'fullstack' || type === 'backend') {
          // Check for common entry points
          if (files['server.js'] || files['src/server.js'] || files['index.js'] || files['app.js']) {
            if (files['src/server.js'] && !files['server.js']) {
              command = 'node src/server.js'
            } else if (files['app.js'] && !files['server.js']) {
              command = 'node app.js'
            } else if (files['index.js'] && !files['server.js']) {
              command = 'node index.js'
            }
          }
        }

        runtime.backend = {
          command,
          ...(cwd ? { cwd } : {})
        }
      }

      const fullMeta = {
        name,
        type,
        createdAt: new Date().toISOString(),
        ...meta,
        runtime
      }

      onProgress?.('📁 正在创建项目文件...', `共 ${Object.keys(files).length} 个文件`)

      const project = await services.projectFS.createProject(projectId, fullMeta, files)

      // Emit each file name for real-time feedback
      for (const filePath of Object.keys(files)) {
        onProgress?.('📄 已创建', filePath)
      }

      // Notify renderer that a new project was created (refresh project list)
      const win = services.getMainWindow?.()
      if (win && !win.isDestroyed()) {
        win.webContents.send('projects:changed', { action: 'created', projectId })
      }

      // Auto-install dependencies if package.json exists
      if (files['package.json']) {
        try {
          onProgress?.('📦 正在安装依赖...', 'npm install')
          console.log(`[tool:create_project] Installing dependencies for ${projectId}...`)
          await services.runtimeManager.installDeps(projectId)
          onProgress?.('✅ 依赖安装完成')
          console.log(`[tool:create_project] Dependencies installed for ${projectId}`)
        } catch (err) {
          onProgress?.('⚠️ 依赖安装失败', (err as Error).message)
          console.warn(`[tool:create_project] Failed to install deps: ${(err as Error).message}`)
          return {
            success: true,
            project,
            message: `Project "${name}" created with ID: ${projectId}. Warning: npm install failed — ${(err as Error).message}`
          }
        }
      }

      // Auto-start the project after creation
      let startResult: { port?: number; status?: string } = {}
      try {
        onProgress?.('🚀 正在启动项目...', projectId)
        console.log(`[tool:create_project] Auto-starting project ${projectId}...`)
        startResult = await services.runtimeManager.start(projectId)
        onProgress?.('✅ 项目已启动', `端口: ${startResult.port}`)
        console.log(`[tool:create_project] Project ${projectId} started on port ${startResult.port}`)
      } catch (err) {
        onProgress?.('⚠️ 启动失败', (err as Error).message)
        console.warn(`[tool:create_project] Failed to auto-start: ${(err as Error).message}`)
      }

      // Notify renderer again with updated status
      if (win && !win.isDestroyed()) {
        win.webContents.send('projects:changed', { action: 'started', projectId, port: startResult.port })
      }

      return {
        success: true,
        project,
        port: startResult.port,
        status: startResult.status || 'created',
        message: `Project "${name}" created with ID: ${projectId}. Dependencies installed. Runtime configured with command: ${(runtime.backend as Record<string, unknown>).command}${startResult.port ? `. Running on port ${startResult.port}` : ''}`
      }
    }
  }
}
