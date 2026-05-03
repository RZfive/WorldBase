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
      description: 'Get the current project runtime status, port, PID, start time, dependency/build state, and the most recent structured runtime failure summary.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID'
          }
        },
        required: ['project_id']
      }
    },
    handler: async (args) => {
      const { project_id } = args as unknown as GetProjectStatusArgs
      const status = services.runtimeManager.getStatus(project_id)
      const buildFailure = services.builderService.getLastFailure(project_id) || undefined
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
      const lastFailure = pickLatestFailure(status.lastFailure, buildFailure)
      const recommendedNextDebugStep = getRecommendedNextDebugStep(status.status, lastFailure, recentLogs.length > 0)

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
        last_failure: lastFailure,
        last_error_source: lastFailure?.source,
        last_error_phase: lastFailure?.phase,
        last_error_time: lastFailure?.time,
        last_error_summary: lastFailure?.summary || status.error,
        last_error_excerpt: lastFailure?.stderrExcerpt || recentLogs.map(entry => entry.text),
        recommended_next_debug_step: recommendedNextDebugStep,
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

function getRecommendedNextDebugStep (
  runtimeStatus: string,
  lastFailure: { source?: string; phase?: string; stderrExcerpt?: string[] } | undefined,
  hasRecentErrorLogs: boolean
): 'none' | 'check_build_output' | 'check_stderr_logs' | 'inspect_startup_failure' | 'restart_project_server' {
  if (lastFailure?.source === 'build') {
    return 'check_build_output'
  }

  if (lastFailure?.phase === 'terminated_before_ready' || lastFailure?.phase === 'ready_timeout' || lastFailure?.phase === 'spawn') {
    return 'inspect_startup_failure'
  }

  if (runtimeStatus === 'crashed' || runtimeStatus === 'error') {
    return hasRecentErrorLogs || (lastFailure?.stderrExcerpt?.length ?? 0) > 0
      ? 'check_stderr_logs'
      : 'restart_project_server'
  }

  return 'none'
}

function pickLatestFailure<T extends { time?: string }> (runtimeFailure: T | undefined, buildFailure: T | undefined): T | undefined {
  if (!runtimeFailure) {
    return buildFailure
  }

  if (!buildFailure) {
    return runtimeFailure
  }

  if (!runtimeFailure.time) {
    return buildFailure
  }

  if (!buildFailure.time) {
    return runtimeFailure
  }

  return runtimeFailure.time >= buildFailure.time
    ? runtimeFailure
    : buildFailure
}
