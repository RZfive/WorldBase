import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'

interface SemverParts {
  major: number
  minor: number
  patch: number
}

export interface NextRuntimeCompatibilityProfile {
  nextVersionRange: string
  reactVersionRange: string
  reactDomVersionRange: string
  minimumNodeVersion: string
}

function parseSemverParts (version: string): SemverParts {
  const [major = '0', minor = '0', patch = '0'] = version
    .replace(/^[^0-9]+/, '')
    .split('.')
    .map(part => part.replace(/[^0-9].*$/, ''))

  return {
    major: Number.parseInt(major, 10) || 0,
    minor: Number.parseInt(minor, 10) || 0,
    patch: Number.parseInt(patch, 10) || 0
  }
}

function compareSemver (left: string, right: string): number {
  const leftParts = parseSemverParts(left)
  const rightParts = parseSemverParts(right)

  if (leftParts.major !== rightParts.major) {
    return leftParts.major - rightParts.major
  }
  if (leftParts.minor !== rightParts.minor) {
    return leftParts.minor - rightParts.minor
  }

  return leftParts.patch - rightParts.patch
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortObjectKeys (input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => {
    if (left < right) return -1
    if (left > right) return 1
    return 0
  }))
}

export function getNextRuntimeCompatibilityProfile (
  nodeVersion = process.versions.node
): NextRuntimeCompatibilityProfile {
  if (compareSemver(nodeVersion, '20.9.0') >= 0) {
    return {
      nextVersionRange: '^16.0.0',
      reactVersionRange: '^19.0.0',
      reactDomVersionRange: '^19.0.0',
      minimumNodeVersion: '20.9.0'
    }
  }

  if (compareSemver(nodeVersion, '18.18.0') >= 0) {
    return {
      nextVersionRange: '^15.0.0',
      reactVersionRange: '^19.0.0',
      reactDomVersionRange: '^19.0.0',
      minimumNodeVersion: '18.18.0'
    }
  }

  return {
    nextVersionRange: '^14.0.0',
    reactVersionRange: '^18.2.0',
    reactDomVersionRange: '^18.2.0',
    minimumNodeVersion: '18.17.0'
  }
}

export function normalizeNextPackageJsonObject (
  packageJson: Record<string, unknown>,
  nodeVersion = process.versions.node
): { packageJson: Record<string, unknown>; changed: boolean; profile: NextRuntimeCompatibilityProfile } {
  const profile = getNextRuntimeCompatibilityProfile(nodeVersion)
  const dependencies = isRecord(packageJson.dependencies) ? { ...packageJson.dependencies } : {}
  const devDependencies = isRecord(packageJson.devDependencies) ? { ...packageJson.devDependencies } : {}
  const hasNextDependency = typeof dependencies.next === 'string' || typeof devDependencies.next === 'string'

  if (!hasNextDependency) {
    return { packageJson, changed: false, profile }
  }

  const nextPackageJson = { ...packageJson }
  let changed = false

  if (dependencies.next !== profile.nextVersionRange) {
    dependencies.next = profile.nextVersionRange
    changed = true
  }
  if (dependencies.react !== profile.reactVersionRange) {
    dependencies.react = profile.reactVersionRange
    changed = true
  }
  if (dependencies['react-dom'] !== profile.reactDomVersionRange) {
    dependencies['react-dom'] = profile.reactDomVersionRange
    changed = true
  }

  for (const packageName of ['next', 'react', 'react-dom']) {
    if (packageName in devDependencies) {
      delete devDependencies[packageName]
      changed = true
    }
  }

  nextPackageJson.dependencies = sortObjectKeys(dependencies)

  if (Object.keys(devDependencies).length > 0) {
    nextPackageJson.devDependencies = sortObjectKeys(devDependencies)
  } else if ('devDependencies' in nextPackageJson) {
    delete nextPackageJson.devDependencies
    changed = true
  }

  return {
    packageJson: changed ? nextPackageJson : packageJson,
    changed,
    profile
  }
}

export function normalizeNextPackageJsonText (
  packageJsonText: string,
  nodeVersion = process.versions.node
): { packageJsonText: string; changed: boolean; profile: NextRuntimeCompatibilityProfile } {
  const parsed = JSON.parse(packageJsonText) as Record<string, unknown>
  const result = normalizeNextPackageJsonObject(parsed, nodeVersion)

  return {
    packageJsonText: result.changed
      ? `${JSON.stringify(result.packageJson, null, 2)}\n`
      : packageJsonText,
    changed: result.changed,
    profile: result.profile
  }
}

function resolveProjectPackageJsonPath (projectsDir: string, projectDir: string): string | null {
  const resolvedProjectsDir = path.resolve(projectsDir)
  const resolvedProjectDir = path.resolve(projectDir)
  const relativeProjectDir = path.relative(resolvedProjectsDir, resolvedProjectDir)

  if (relativeProjectDir.startsWith('..') || path.isAbsolute(relativeProjectDir)) {
    return null
  }

  return path.join(resolvedProjectsDir, relativeProjectDir, 'package.json')
}

export async function ensureNextRuntimeCompatiblePackageJson (
  projectsDir: string,
  projectDir: string
): Promise<void> {
  const packageJsonPath = resolveProjectPackageJsonPath(projectsDir, projectDir)
  if (!packageJsonPath || !existsSync(packageJsonPath)) {
    return
  }

  try {
    const raw = await fs.readFile(packageJsonPath, 'utf-8')
    const normalized = normalizeNextPackageJsonText(raw)
    if (normalized.changed) {
      await fs.writeFile(packageJsonPath, normalized.packageJsonText, 'utf-8')
    }
  } catch {
    // Leave user-provided package.json untouched if it isn't valid JSON.
  }
}
