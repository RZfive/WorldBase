import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectFS } from '../../../project-fs/project-fs.js'
import type { RuntimeManager } from '../../../project-runtime/runtime-manager.js'
import type { BuilderService } from '../../../project-runtime/builder-service.js'
import type { ToolDefinition } from '../../providers/openai-provider.js'

interface ToolServices {
  projectFS: ProjectFS
  runtimeManager: RuntimeManager
  builderService: BuilderService
}

interface GetProjectStatusArgs {
  project_id: string
}

export interface Tool {
  definition: ToolDefinition
  handler: (args: Record<string, unknown>, onProgress?: (stage: string, detail?: string) => void) => Promise<unknown>
}

export function toolGetProjectStatus (services: ToolServices): Tool {
  return {
    definition: {
      name: 'get_project_status',
      description: '获取项目当前运行状态、端口、进程 ID、启动时间、依赖是否已安装、构建产物是否存在，以及最近的错误日志摘要。',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: '项目 ID'
          }
        },
        required: ['project_id']
      }
    },
    handler: async (args) => {
      const { project_id } = args as unknown as GetProjectStatusArgs
      const status = services.runtimeManager.getStatus(project_id)
      const projectDir = path.join(services.projectFS.projectsDir, project_id)
      const packageJsonPath = path.join(projectDir, 'package.json')
      const nodeModulesPath = path.join(projectDir, 'node_modules')
      const [packageJsonExists, nodeModulesPresent] = await Promise.all([
        pathExists(packageJsonPath),
        pathExists(nodeModulesPath)
      ])
      const standaloneBuildPresent = services.builderService.hasStandaloneBuild(project_id)
      const recentLogs = services.runtimeManager
        .getLogs(project_id, 20)
        .filter(entry => entry.type === 'stderr')
        .slice(-10)

      let framework: string | undefined
      let buildStatus: string | undefined
      try {
        const meta = await services.projectFS.getProjectMeta(project_id)
        framework = typeof meta.framework === 'string' ? meta.framework : undefined
        buildStatus = typeof meta.buildStatus === 'string' ? meta.buildStatus : undefined
      } catch {
        // Ignore missing meta and fall back to on-disk detection below.
      }

      const isNextProject = framework === 'nextjs' || await detectNextProject(packageJsonPath, packageJsonExists)
      const needsRebuild = isNextProject
        ? await services.builderService.needsRebuild(project_id)
        : undefined

      const dependencyStatus = packageJsonExists
        ? (nodeModulesPresent ? 'installed' : 'missing')
        : 'not_applicable'

      const recommendedPrepareAction = getRecommendedPrepareAction({
        packageJsonExists,
        isNextProject,
        nodeModulesPresent,
        standaloneBuildPresent,
        needsRebuild
      })

      return {
        ...status,
        framework,
        build_status: buildStatus,
        package_json_exists: packageJsonExists,
        node_modules_present: nodeModulesPresent,
        standalone_build_present: standaloneBuildPresent,
        dependency_status: dependencyStatus,
        needs_rebuild: needsRebuild,
        recommended_prepare_action: recommendedPrepareAction,
        recent_error_logs: recentLogs
      }
    }
  }
}

async function detectNextProject (packageJsonPath: string, packageJsonExists: boolean): Promise<boolean> {
  if (!packageJsonExists) {
    return false
  }

  try {
    const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8')) as Record<string, unknown>
    const deps = {
      ...((pkg.dependencies || {}) as Record<string, string>),
      ...((pkg.devDependencies || {}) as Record<string, string>)
    }
    return typeof deps.next === 'string'
  } catch {
    return false
  }
}

async function pathExists (targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function getRecommendedPrepareAction ({
  packageJsonExists,
  isNextProject,
  nodeModulesPresent,
  standaloneBuildPresent,
  needsRebuild
}: {
  packageJsonExists: boolean
  isNextProject: boolean
  nodeModulesPresent: boolean
  standaloneBuildPresent: boolean
  needsRebuild?: boolean
}): 'none' | 'install_dependencies' | 'rebuild_project' {
  if (!packageJsonExists) {
    return 'none'
  }

  if (!isNextProject) {
    return nodeModulesPresent ? 'none' : 'install_dependencies'
  }

  if (needsRebuild) {
    return 'rebuild_project'
  }

  if (standaloneBuildPresent) {
    return 'none'
  }

  if (nodeModulesPresent) {
    return 'rebuild_project'
  }

  return 'install_dependencies'
}
