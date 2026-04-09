import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { RuntimeManager } from '../../../project-runtime/runtime-manager.js'
import type { BuilderService } from '../../../project-runtime/builder-service.js'
import type { ProjectDataAccess } from '../../../project-data-access/data-access.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'
import type { ProgressCallback, SessionState } from '../agent-core.js'
import type { BrowserWindow } from 'electron'
import { streamFilePreview } from './file-preview-progress.js'
import { normalizeProjectMeta } from '../../../project-fs/project-meta.js'
import { normalizeNextPackageJsonText } from '../../../project-runtime/next-runtime-compat.js'

interface ToolServices {
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
  builderService: BuilderService
  dataAccess: ProjectDataAccess
  getMainWindow?: () => BrowserWindow | null
}

interface CreateProjectArgs {
  name: string
  type: string
  files: unknown
  meta?: unknown
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>
}

/**
 * Tool: create_project — 创建新项目
 */
export function toolCreateProject (services: ToolServices, getSessionState?: () => SessionState): Tool {
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
      const { name, type, meta } = args as unknown as CreateProjectArgs
      const files = normalizeCreateProjectFiles((args as Record<string, unknown>).files)
      const normalizedMeta = normalizeProjectMeta(parsePossiblyStringifiedObject(meta, 'meta') ?? meta)
      const session = getSessionState?.()

      if (files['package.json'] && (!!files['next.config.js'] || normalizedMeta.framework === 'nextjs')) {
        try {
          const normalizedPackage = normalizeNextPackageJsonText(files['package.json'])
          if (normalizedPackage.changed) {
            files['package.json'] = normalizedPackage.packageJsonText
          }
        } catch {
          // Leave invalid package.json to the later validation step.
        }
      }

      // Prevent creating a second project in the same conversation
      if (session?.createdProjectId) {
        return {
          success: false,
          error: `本次对话已创建项目 ${session.createdProjectId}，不允许再创建新项目。请使用 write_project_file 工具修改已创建的项目文件，project_id 为 "${session.createdProjectId}"。`
        }
      }

      // If the conversation is targeting an existing project for optimization,
      // block new project creation and redirect to write_project_file
      if (session?.targetProjectId) {
        return {
          success: false,
          error: `本次对话正在优化现有项目 ${session.targetProjectId}，不允许创建新项目。请使用 write_project_file 工具将代码写入已有项目，project_id 为 "${session.targetProjectId}"。`
        }
      }

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
      const runtime = (normalizedMeta.runtime as Record<string, unknown>) || {}
      if (!runtime.backend) {
        // Determine the start command based on project type and files
        let command = 'node server.js'
        let cwd: string | undefined

        // Detect Next.js projects — use standalone mode command
        const isNextProject = !!files['next.config.js'] || (normalizedMeta.framework === 'nextjs')
        if (isNextProject) {
          command = 'node .next/standalone/server.js'
        } else if (files['package.json']) {
          try {
            const pkg = JSON.parse(files['package.json']) as Record<string, unknown>
            const scripts = pkg.scripts as Record<string, string> | undefined
            const deps: Record<string, string> = {
              ...((pkg.dependencies || {}) as Record<string, string>),
              ...((pkg.devDependencies || {}) as Record<string, string>)
            }

            // Auto-detect Next.js from dependencies
            if (deps.next) {
              command = 'node .next/standalone/server.js'
            } else if (scripts) {
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

        if (!isNextProject && (type === 'fullstack' || type === 'backend')) {
          // Check for common entry points (legacy non-Next.js projects)
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

      // Auto-detect framework from files
      const detectedFramework = files['next.config.js'] ? 'nextjs' : (normalizedMeta.framework as string | undefined)

      const fullMeta = normalizeProjectMeta({
        name,
        type,
        createdAt: new Date().toISOString(),
        ...(detectedFramework ? { framework: detectedFramework } : {}),
        ...normalizedMeta,
        runtime
      })

      for (const [filePath, content] of Object.entries(files)) {
        await streamFilePreview(filePath, content, onProgress)
      }

      onProgress?.('📁 正在创建项目文件...', `共 ${Object.keys(files).length} 个文件`)

      const project = await services.projectFS.createProject(projectId, fullMeta, files)

      // Record the created project ID in session state to prevent duplicates
      if (session) {
        session.createdProjectId = projectId
      }

      if ((fullMeta as { dataSchema?: { database?: string } }).dataSchema?.database === 'sqlite') {
        onProgress?.('🗄️ 正在初始化 SQLite 数据接口...', projectId)
        await services.dataAccess.ensureProjectDatabase(projectId)
      }

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
            ready: false,
            recoverable: true,
            stage: 'install',
            project,
            projectId,
            message: `Project "${name}" created with ID: ${projectId}. Warning: npm install failed — ${(err as Error).message}`
          }
        }
      }

      // Build step for Next.js projects — compile to standalone mode
      const isNextJS = (fullMeta.framework === 'nextjs') || !!files['next.config.js']
      if (isNextJS && files['package.json']) {
        try {
          onProgress?.('🔨 正在编译项目...', 'npm run build (standalone)')
          console.log(`[tool:create_project] Building standalone for ${projectId}...`)
          const buildResult = await services.builderService.build(projectId)
          if (buildResult.success) {
            onProgress?.('✅ 编译完成', `耗时 ${Math.round(buildResult.duration / 1000)}s`)
            console.log(`[tool:create_project] Build succeeded for ${projectId} in ${buildResult.duration}ms`)

            // Cleanup node_modules to save disk space
            onProgress?.('🧹 正在清理依赖缓存...', '删除 node_modules')
            const cleanResult = await services.builderService.cleanup(projectId)
            if (cleanResult.success && cleanResult.freedBytes) {
              const freedMB = Math.round(cleanResult.freedBytes / 1024 / 1024)
              onProgress?.('✅ 清理完成', `释放 ${freedMB}MB 磁盘空间`)
              console.log(`[tool:create_project] Cleanup freed ${freedMB}MB for ${projectId}`)
            }
          } else {
            onProgress?.('❌ 编译失败，项目未启动', buildResult.error || '')
            console.warn(`[tool:create_project] Build failed: ${buildResult.error}`)
            return {
              success: true,
              ready: false,
              recoverable: true,
              stage: 'build',
              project,
              projectId,
              output: buildResult.output,
              message: `Project "${name}" created with ID: ${projectId}, but build failed — ${buildResult.error || 'unknown build error'}`
            }
          }
        } catch (err) {
          onProgress?.('❌ 编译出错，项目未启动', (err as Error).message)
          console.warn(`[tool:create_project] Build error: ${(err as Error).message}`)
          return {
            success: true,
            ready: false,
            recoverable: true,
            stage: 'build',
            project,
            projectId,
            message: `Project "${name}" created with ID: ${projectId}, but build failed — ${(err as Error).message}`
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
        return {
          success: true,
          ready: false,
          recoverable: true,
          stage: 'start',
          project,
          projectId,
          logs: services.runtimeManager.getLogs(projectId, 40),
          message: `Project "${name}" created with ID: ${projectId}, but failed to start automatically — ${(err as Error).message}`
        }
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

function normalizeCreateProjectFiles (rawFiles: unknown): Record<string, string> {
  const parsedFiles = parsePossiblyStringifiedObject(rawFiles, 'files')

  if (!parsedFiles) {
    throw new Error('create_project 的 files 参数必须是 { "路径": "完整文件内容" } 对象，不能是普通字符串。')
  }

  const entries = Object.entries(parsedFiles)
  if (entries.length === 0) {
    throw new Error('create_project 的 files 参数至少要包含一个文件。')
  }

  const normalizedFiles: Record<string, string> = {}

  for (const [filePath, content] of entries) {
    if (typeof content !== 'string') {
      throw new Error(`create_project 的 files["${filePath}"] 必须是完整文件内容字符串。`)
    }
    normalizedFiles[filePath] = content
  }

  return normalizedFiles
}

function parsePossiblyStringifiedObject (value: unknown, fieldName: string): Record<string, unknown> | null {
  let current = value

  for (let depth = 0; depth < 3; depth++) {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      return current as Record<string, unknown>
    }

    if (typeof current !== 'string') {
      return null
    }

    const trimmed = current.trim()
    if (!trimmed.startsWith('{')) {
      return null
    }

    try {
      current = JSON.parse(trimmed) as unknown
      if (depth === 0) {
        console.warn(`[tool:create_project] Repaired stringified ${fieldName} argument`)
      }
    } catch {
      return null
    }
  }

  return null
}
