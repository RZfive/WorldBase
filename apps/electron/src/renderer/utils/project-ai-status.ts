import type { Project } from '../components/launchpad/types'

export interface AiApplicationRecord {
  appId: string
  aiReady?: boolean
  tags?: string[]
}

export interface ProjectAiStatus {
  aiReady: boolean
  aiUpgradeAvailable: boolean
}

const LOCAL_MANAGED_APP_PREFIX = 'worldbase.local.'

function projectIdOf (project: Project): string {
  return typeof project.id === 'string' ? project.id.trim() : ''
}

export function managedApplicationIdForProject (projectId: string): string {
  return `${LOCAL_MANAGED_APP_PREFIX}${projectId.trim()}`
}

export function findManagedApplication (
  project: Project,
  applications: AiApplicationRecord[]
): AiApplicationRecord | null {
  const projectId = projectIdOf(project)
  if (!projectId) return null

  const expectedAppId = managedApplicationIdForProject(projectId)
  return applications.find(application => application.appId === expectedAppId)
    || applications.find(application => Array.isArray(application.tags) && application.tags.includes(projectId))
    || null
}

/**
 * Legacy projects without a managed application manifest can be upgraded with
 * the deterministic application scaffold. A registered application that is not
 * AI-ready explicitly opted out with `aiIntegration: "none"`, so it must not be
 * presented as an upgrade candidate.
 */
export function resolveProjectAiStatus (
  project: Project,
  applications: AiApplicationRecord[]
): ProjectAiStatus {
  if (project.kind === 'web') {
    return { aiReady: false, aiUpgradeAvailable: false }
  }

  const application = findManagedApplication(project, applications)
  if (!application) {
    return { aiReady: false, aiUpgradeAvailable: true }
  }

  return {
    aiReady: application.aiReady === true,
    aiUpgradeAvailable: false
  }
}
