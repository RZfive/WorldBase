import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { CRITICAL_USER_DATA_DIR_NAMES, CRITICAL_USER_DATA_FILE_NAMES, LEGACY_USER_DATA_DIR_NAMES } from './constants.js'

type CopyMissingUserDataResult = {
  copied: number
  merged: number
  skipped: number
}

type CopyMissingUserDataOptions = {
  settingsConflict?: 'source-wins' | 'target-wins'
}

const SETTINGS_FILE_NAME = 'settings.json'
const SETTINGS_ARRAY_KEYS_WITH_ID = ['webApps', 'pinnedDockApps', 'mcpServers']
const SETTINGS_RECORD_KEYS = ['projectLaunchModes']
const IGNORED_DIRECTORY_ENTRY_NAMES = new Set(['.DS_Store'])

async function pathExists (targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function getDirectoryEntryCount (targetPath: string): Promise<number> {
  try {
    return (await fs.readdir(targetPath)).length
  } catch {
    return 0
  }
}

async function getFileByteSize (targetPath: string): Promise<number> {
  try {
    const stats = await fs.stat(targetPath)
    return stats.isFile() ? stats.size : 0
  } catch {
    return 0
  }
}

async function getCriticalUserDataPresence (basePath: string): Promise<boolean> {
  const criticalDirectoryCounts = await Promise.all(
    CRITICAL_USER_DATA_DIR_NAMES.map(name => getDirectoryEntryCount(path.join(basePath, name)))
  )
  if (criticalDirectoryCounts.some(count => count > 0)) {
    return true
  }

  const criticalFileSizes = await Promise.all(
    CRITICAL_USER_DATA_FILE_NAMES.map(name => getFileByteSize(path.join(basePath, name)))
  )
  return criticalFileSizes.some(size => size > 0)
}

async function getCriticalUserDataDirectoryPresence (basePath: string): Promise<boolean> {
  const criticalDirectoryCounts = await Promise.all(
    CRITICAL_USER_DATA_DIR_NAMES.map(name => getDirectoryEntryCount(path.join(basePath, name)))
  )
  return criticalDirectoryCounts.some(count => count > 0)
}

function isJsonRecord (value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function jsonValueHasContent (value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (isJsonRecord(value)) {
    return Object.values(value).some(item => jsonValueHasContent(item))
  }
  if (typeof value === 'string') return value.trim().length > 0
  return value !== null && value !== undefined
}

function hasOwn (record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function getStringArray (value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const normalized = item.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function mergeStringArrays (
  sourceValue: unknown,
  targetValue: unknown,
  conflictMode: 'source-wins' | 'target-wins'
): string[] {
  const sourceItems = getStringArray(sourceValue)
  const targetItems = getStringArray(targetValue)
  const orderedItems = conflictMode === 'source-wins'
    ? [...sourceItems, ...targetItems]
    : [...targetItems, ...sourceItems]

  const seen = new Set<string>()
  const merged: string[] = []
  for (const item of orderedItems) {
    if (seen.has(item)) continue
    seen.add(item)
    merged.push(item)
  }
  return merged
}

function getRecordId (value: Record<string, unknown>): string {
  return typeof value.id === 'string' ? value.id.trim() : ''
}

function mergeRecordArraysById (
  sourceValue: unknown,
  targetValue: unknown,
  conflictMode: 'source-wins' | 'target-wins'
): unknown[] {
  const sourceItems = Array.isArray(sourceValue) ? sourceValue.filter(isJsonRecord) : []
  const targetItems = Array.isArray(targetValue) ? targetValue.filter(isJsonRecord) : []
  const orderedItems = conflictMode === 'source-wins'
    ? [...sourceItems, ...targetItems]
    : [...targetItems, ...sourceItems]

  const seenIds = new Set<string>()
  const merged: unknown[] = []
  for (const item of orderedItems) {
    const id = getRecordId(item)
    if (!id || seenIds.has(id)) continue
    seenIds.add(id)
    merged.push(item)
  }
  return merged
}

function mergeRecordValues (
  sourceValue: unknown,
  targetValue: unknown,
  conflictMode: 'source-wins' | 'target-wins'
): Record<string, unknown> {
  const sourceRecord = isJsonRecord(sourceValue) ? sourceValue : {}
  const targetRecord = isJsonRecord(targetValue) ? targetValue : {}
  return conflictMode === 'source-wins'
    ? { ...targetRecord, ...sourceRecord }
    : { ...sourceRecord, ...targetRecord }
}

function normalizeLaunchpadFolder (value: unknown): Record<string, unknown> | null {
  if (!isJsonRecord(value)) return null
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!id || !name) return null
  return {
    ...value,
    id,
    name,
    projectIds: getStringArray(value.projectIds)
  }
}

function mergeLaunchpadFolders (
  sourceValue: unknown,
  targetValue: unknown,
  conflictMode: 'source-wins' | 'target-wins'
): unknown[] {
  const sourceFolders = Array.isArray(sourceValue)
    ? sourceValue.map(normalizeLaunchpadFolder).filter((folder): folder is Record<string, unknown> => Boolean(folder))
    : []
  const targetFolders = Array.isArray(targetValue)
    ? targetValue.map(normalizeLaunchpadFolder).filter((folder): folder is Record<string, unknown> => Boolean(folder))
    : []

  const sourceById = new Map(sourceFolders.map(folder => [getRecordId(folder), folder]))
  const targetById = new Map(targetFolders.map(folder => [getRecordId(folder), folder]))
  const orderedIds = mergeStringArrays(
    sourceFolders.map(folder => getRecordId(folder)),
    targetFolders.map(folder => getRecordId(folder)),
    conflictMode
  )

  const mergedFolders: unknown[] = []
  for (const id of orderedIds) {
    const sourceFolder = sourceById.get(id)
    const targetFolder = targetById.get(id)

    if (sourceFolder && targetFolder) {
      const mergedFolder = mergeRecordValues(sourceFolder, targetFolder, conflictMode)
      mergedFolder.projectIds = mergeStringArrays(sourceFolder.projectIds, targetFolder.projectIds, conflictMode)
      mergedFolders.push(mergedFolder)
    } else if (sourceFolder) {
      mergedFolders.push(sourceFolder)
    } else if (targetFolder) {
      mergedFolders.push(targetFolder)
    }
  }

  return mergedFolders
}

function mergeLaunchpadLayout (
  sourceValue: unknown,
  targetValue: unknown,
  conflictMode: 'source-wins' | 'target-wins'
): Record<string, unknown> {
  const sourceLayout = isJsonRecord(sourceValue) ? sourceValue : {}
  const targetLayout = isJsonRecord(targetValue) ? targetValue : {}
  const mergedLayout = mergeRecordValues(sourceLayout, targetLayout, conflictMode)

  mergedLayout.folders = mergeLaunchpadFolders(sourceLayout.folders, targetLayout.folders, conflictMode)
  mergedLayout.topLevelOrder = mergeStringArrays(sourceLayout.topLevelOrder, targetLayout.topLevelOrder, conflictMode)
  return mergedLayout
}

function hasConfiguredAiProviderSettings (settings: Record<string, unknown>): boolean {
  const providersConfig = settings.aiProviders
  if (providersConfig && typeof providersConfig === 'object') {
    const providers = (providersConfig as Record<string, unknown>).providers
    if (Array.isArray(providers) && providers.some(provider => {
      if (!provider || typeof provider !== 'object') return false
      const record = provider as Record<string, unknown>
      const hasModels = Array.isArray(record.models) && record.models.length > 0
      return [record.name, record.baseUrl, record.apiKey, record.activeModel].some(value => typeof value === 'string' && value.trim().length > 0) || hasModels
    })) {
      return true
    }
  }

  return ['aiApiKey', 'aiBaseUrl', 'aiModel'].some(key => {
    const value = settings[key]
    return typeof value === 'string' && value.trim().length > 0
  })
}

function copyAiProviderSettings (from: Record<string, unknown>, to: Record<string, unknown>): void {
  for (const key of ['aiProviders', 'aiApiKey', 'aiBaseUrl', 'aiModel']) {
    if (Object.prototype.hasOwnProperty.call(from, key)) {
      to[key] = from[key]
    }
  }
}

function mergeSettingsRecords (
  sourceSettings: Record<string, unknown>,
  targetSettings: Record<string, unknown>,
  conflictMode: 'source-wins' | 'target-wins'
): Record<string, unknown> {
  const mergedSettings = conflictMode === 'source-wins'
    ? { ...targetSettings, ...sourceSettings }
    : { ...sourceSettings, ...targetSettings }

  for (const key of SETTINGS_ARRAY_KEYS_WITH_ID) {
    if (hasOwn(sourceSettings, key) || hasOwn(targetSettings, key)) {
      mergedSettings[key] = mergeRecordArraysById(sourceSettings[key], targetSettings[key], conflictMode)
    }
  }

  for (const key of SETTINGS_RECORD_KEYS) {
    if (hasOwn(sourceSettings, key) || hasOwn(targetSettings, key)) {
      mergedSettings[key] = mergeRecordValues(sourceSettings[key], targetSettings[key], conflictMode)
    }
  }

  if (hasOwn(sourceSettings, 'launchpadLayout') || hasOwn(targetSettings, 'launchpadLayout')) {
    mergedSettings.launchpadLayout = mergeLaunchpadLayout(sourceSettings.launchpadLayout, targetSettings.launchpadLayout, conflictMode)
  }

  const sourceHasAiProviderSettings = hasConfiguredAiProviderSettings(sourceSettings)
  const targetHasAiProviderSettings = hasConfiguredAiProviderSettings(targetSettings)

  if (sourceHasAiProviderSettings && (!targetHasAiProviderSettings || conflictMode === 'source-wins')) {
    copyAiProviderSettings(sourceSettings, mergedSettings)
  } else if (!sourceHasAiProviderSettings && targetHasAiProviderSettings) {
    copyAiProviderSettings(targetSettings, mergedSettings)
  }

  return mergedSettings
}

async function getUniqueBackupPath (targetPath: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (let index = 0; index < 100; index++) {
    const suffix = index === 0 ? stamp : `${stamp}-${index}`
    const backupPath = `${targetPath}.migration-backup-${suffix}`
    if (!(await pathExists(backupPath))) {
      return backupPath
    }
  }
  return `${targetPath}.migration-backup-${stamp}-${Date.now()}`
}

async function readJsonRecordFile (filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown
    return isJsonRecord(parsed) ? parsed : null
  } catch (error) {
    console.warn(`[main:migration] Failed to read JSON record from ${filePath}`, error)
    return null
  }
}

async function mergeSettingsFile (
  sourcePath: string,
  targetPath: string,
  conflictMode: 'source-wins' | 'target-wins' = 'source-wins'
): Promise<CopyMissingUserDataResult> {
  if (!(await pathExists(targetPath))) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.copyFile(sourcePath, targetPath)
    return { copied: 1, merged: 0, skipped: 0 }
  }

  const sourceSettings = await readJsonRecordFile(sourcePath)
  if (!sourceSettings) {
    return { copied: 0, merged: 0, skipped: 1 }
  }

  const targetSettings = await readJsonRecordFile(targetPath)
  if (!targetSettings) {
    const backupPath = await getUniqueBackupPath(targetPath)
    await fs.rename(targetPath, backupPath)
    await fs.copyFile(sourcePath, targetPath)
    console.log(`[main:migration] Replaced unreadable settings at ${targetPath}; backup saved to ${backupPath}`)
    return { copied: 1, merged: 0, skipped: 0 }
  }

  const mergedSettings = mergeSettingsRecords(sourceSettings, targetSettings, conflictMode)

  const before = JSON.stringify(targetSettings)
  const after = JSON.stringify(mergedSettings)
  if (before === after) {
    return { copied: 0, merged: 0, skipped: 1 }
  }

  const backupPath = await getUniqueBackupPath(targetPath)
  await fs.copyFile(targetPath, backupPath)
  await fs.writeFile(targetPath, JSON.stringify(mergedSettings, null, 2), 'utf8')
  console.log(`[main:migration] Merged settings from ${sourcePath} into ${targetPath}; backup saved to ${backupPath}`)
  return { copied: 0, merged: 1, skipped: 0 }
}

async function copyMissingUserDataEntries (
  sourcePath: string,
  targetPath: string,
  options: CopyMissingUserDataOptions = {}
): Promise<CopyMissingUserDataResult> {
  const stats = await fs.lstat(sourcePath)

  if (stats.isSymbolicLink()) {
    if (await pathExists(targetPath)) {
      return { copied: 0, merged: 0, skipped: 1 }
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.symlink(await fs.readlink(sourcePath), targetPath)
    return { copied: 1, merged: 0, skipped: 0 }
  }

  if (!stats.isDirectory()) {
    if (path.basename(sourcePath) === SETTINGS_FILE_NAME) {
      return mergeSettingsFile(sourcePath, targetPath, options.settingsConflict)
    }

    if (await pathExists(targetPath)) {
      return { copied: 0, merged: 0, skipped: 1 }
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.copyFile(sourcePath, targetPath)
    return { copied: 1, merged: 0, skipped: 0 }
  }

  const targetExists = await pathExists(targetPath)
  if (targetExists) {
    const targetStats = await fs.lstat(targetPath)
    if (!targetStats.isDirectory()) {
      return { copied: 0, merged: 0, skipped: 1 }
    }
  }

  const missingDirectEntries = targetExists
    ? await getMissingDirectoryDirectEntryCount(sourcePath, targetPath)
    : Math.max(1, await getDirectoryEntryCount(sourcePath))

  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.cp(sourcePath, targetPath, {
    recursive: true,
    force: false,
    errorOnExist: false,
    verbatimSymlinks: true
  })

  return {
    copied: missingDirectEntries,
    merged: targetExists && missingDirectEntries > 0 ? 1 : 0,
    skipped: missingDirectEntries > 0 ? 0 : 1
  }
}

async function getMissingDirectoryDirectEntryCount (sourcePath: string, targetPath: string): Promise<number> {
  let missingCount = 0
  const entries = await fs.readdir(sourcePath)
  for (const entry of entries) {
    if (IGNORED_DIRECTORY_ENTRY_NAMES.has(entry)) continue
    if (!(await pathExists(path.join(targetPath, entry)))) {
      missingCount += 1
    }
  }
  return missingCount
}

async function getRelevantDirectoryEntryCount (targetPath: string): Promise<number> {
  try {
    const entries = await fs.readdir(targetPath)
    return entries.filter(entry => !IGNORED_DIRECTORY_ENTRY_NAMES.has(entry)).length
  } catch {
    return 0
  }
}

async function copyOrReplaceCriticalFile (sourcePath: string, targetPath: string): Promise<CopyMissingUserDataResult> {
  if (!(await pathExists(targetPath))) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.copyFile(sourcePath, targetPath)
    return { copied: 1, merged: 0, skipped: 0 }
  }

  const sourceJson = await readJsonRecordOrArrayFile(sourcePath)
  const targetJson = await readJsonRecordOrArrayFile(targetPath)
  const sourceHasContent = jsonValueHasContent(sourceJson)
  const targetHasContent = jsonValueHasContent(targetJson)

  if (sourceHasContent && !targetHasContent) {
    const backupPath = await getUniqueBackupPath(targetPath)
    await fs.copyFile(targetPath, backupPath)
    await fs.copyFile(sourcePath, targetPath)
    console.log(`[main:migration] Replaced empty generated file at ${targetPath}; backup saved to ${backupPath}`)
    return { copied: 1, merged: 0, skipped: 0 }
  }

  return { copied: 0, merged: 0, skipped: 1 }
}

async function readJsonRecordOrArrayFile (filePath: string): Promise<Record<string, unknown> | unknown[] | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown
    return (isJsonRecord(parsed) || Array.isArray(parsed)) ? parsed : null
  } catch {
    return null
  }
}

async function copyCriticalUserDataEntries (
  legacyPath: string,
  userDataPath: string,
  options: CopyMissingUserDataOptions = {}
): Promise<CopyMissingUserDataResult> {
  let copied = 0
  let merged = 0
  let skipped = 0

  for (const dirName of CRITICAL_USER_DATA_DIR_NAMES) {
    const sourcePath = path.join(legacyPath, dirName)
    if (!(await pathExists(sourcePath))) continue

    const result = await copyMissingUserDataEntries(sourcePath, path.join(userDataPath, dirName), options)
    copied += result.copied
    merged += result.merged
    skipped += result.skipped
  }

  for (const fileName of CRITICAL_USER_DATA_FILE_NAMES) {
    const sourcePath = path.join(legacyPath, fileName)
    if (!(await pathExists(sourcePath))) continue

    const targetPath = path.join(userDataPath, fileName)
    const result = fileName === SETTINGS_FILE_NAME
      ? await mergeSettingsFile(sourcePath, targetPath, options.settingsConflict)
      : await copyOrReplaceCriticalFile(sourcePath, targetPath)
    copied += result.copied
    merged += result.merged
    skipped += result.skipped
  }

  return { copied, merged, skipped }
}

async function promoteLegacyUserDataPath (legacyPath: string, userDataPath: string): Promise<void> {
  try {
    await fs.mkdir(userDataPath, { recursive: true })
    const result = await copyCriticalUserDataEntries(legacyPath, userDataPath, {
      settingsConflict: 'source-wins'
    })
    console.log(`[main:migration] Migrated critical userData from ${legacyPath} to ${userDataPath} (${result.copied} copied, ${result.merged} merged, ${result.skipped} skipped)`)
  } catch (copyError) {
    console.warn(`[main:migration] Failed to copy userData from ${legacyPath} to ${userDataPath}`, copyError)
    throw copyError
  }
}

async function removeLegacyUserDataPath (legacyPath: string, userDataPath: string): Promise<void> {
  const resolvedLegacyPath = path.resolve(legacyPath)
  const resolvedUserDataPath = path.resolve(userDataPath)
  if (resolvedLegacyPath === resolvedUserDataPath) return
  if (!(await pathExists(legacyPath))) return

  await fs.rm(legacyPath, { recursive: true, force: true })
  console.log(`[main:migration] Removed legacy userData path ${legacyPath}`)
}

function collectMissingSettingsKeys (
  sourceSettings: Record<string, unknown>,
  targetSettings: Record<string, unknown>
): string[] {
  const missing: string[] = []

  for (const key of SETTINGS_ARRAY_KEYS_WITH_ID) {
    const sourceItems = Array.isArray(sourceSettings[key]) ? sourceSettings[key].filter(isJsonRecord) : []
    const targetIds = new Set(
      (Array.isArray(targetSettings[key]) ? targetSettings[key].filter(isJsonRecord) : [])
        .map(item => getRecordId(item))
        .filter(Boolean)
    )
    for (const sourceItem of sourceItems) {
      const id = getRecordId(sourceItem)
      if (id && !targetIds.has(id)) {
        missing.push(`${key}:${id}`)
      }
    }
  }

  for (const key of SETTINGS_RECORD_KEYS) {
    const sourceRecord = isJsonRecord(sourceSettings[key]) ? sourceSettings[key] : {}
    const targetRecord = isJsonRecord(targetSettings[key]) ? targetSettings[key] : {}
    for (const sourceKey of Object.keys(sourceRecord)) {
      if (!hasOwn(targetRecord, sourceKey)) {
        missing.push(`${key}:${sourceKey}`)
      }
    }
  }

  const sourceLayout = isJsonRecord(sourceSettings.launchpadLayout) ? sourceSettings.launchpadLayout : {}
  const targetLayout = isJsonRecord(targetSettings.launchpadLayout) ? targetSettings.launchpadLayout : {}
  const targetTopLevelOrder = new Set(getStringArray(targetLayout.topLevelOrder))
  for (const key of getStringArray(sourceLayout.topLevelOrder)) {
    if (!targetTopLevelOrder.has(key)) {
      missing.push(`launchpadLayout.topLevelOrder:${key}`)
    }
  }

  const targetFolders = new Map(
    (Array.isArray(targetLayout.folders) ? targetLayout.folders : [])
      .map(normalizeLaunchpadFolder)
      .filter((folder): folder is Record<string, unknown> => Boolean(folder))
      .map(folder => [getRecordId(folder), folder])
  )
  const sourceFolders = (Array.isArray(sourceLayout.folders) ? sourceLayout.folders : [])
    .map(normalizeLaunchpadFolder)
    .filter((folder): folder is Record<string, unknown> => Boolean(folder))
  for (const sourceFolder of sourceFolders) {
    const folderId = getRecordId(sourceFolder)
    const targetFolder = targetFolders.get(folderId)
    if (!targetFolder) {
      missing.push(`launchpadLayout.folders:${folderId}`)
      continue
    }
    const targetProjectIds = new Set(getStringArray(targetFolder.projectIds))
    for (const projectId of getStringArray(sourceFolder.projectIds)) {
      if (!targetProjectIds.has(projectId)) {
        missing.push(`launchpadLayout.folders:${folderId}/${projectId}`)
      }
    }
  }

  return missing
}

async function collectUnmigratedCriticalEntries (
  legacyPath: string,
  userDataPath: string,
  limit = 20
): Promise<string[]> {
  const missing: string[] = []
  const addMissing = (entry: string) => {
    if (missing.length < limit) missing.push(entry)
  }

  for (const dirName of CRITICAL_USER_DATA_DIR_NAMES) {
    const sourceDir = path.join(legacyPath, dirName)
    if (!(await pathExists(sourceDir))) continue
    const sourceStats = await fs.lstat(sourceDir)
    if (!sourceStats.isDirectory()) continue

    const targetDir = path.join(userDataPath, dirName)
    if (!(await pathExists(targetDir))) {
      if (await getRelevantDirectoryEntryCount(sourceDir) > 0) addMissing(dirName)
      continue
    }

    const entries = await fs.readdir(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      if (missing.length >= limit) break
      if (IGNORED_DIRECTORY_ENTRY_NAMES.has(entry.name)) continue

      const sourceEntryPath = path.join(sourceDir, entry.name)
      const targetEntryPath = path.join(targetDir, entry.name)
      if (!(await pathExists(targetEntryPath))) {
        addMissing(`${dirName}/${entry.name}`)
        continue
      }

      if (dirName === 'projects' && entry.isDirectory()) {
        const sourceMetaPath = path.join(sourceEntryPath, '.world-meta.json')
        const targetMetaPath = path.join(targetEntryPath, '.world-meta.json')
        if (await pathExists(sourceMetaPath) && !(await pathExists(targetMetaPath))) {
          addMissing(`${dirName}/${entry.name}/.world-meta.json`)
        }
      }
    }
  }

  for (const fileName of CRITICAL_USER_DATA_FILE_NAMES) {
    if (missing.length >= limit) break
    const sourcePath = path.join(legacyPath, fileName)
    if (!(await pathExists(sourcePath))) continue

    const targetPath = path.join(userDataPath, fileName)
    if (!(await pathExists(targetPath))) {
      addMissing(fileName)
      continue
    }

    const sourceJson = await readJsonRecordOrArrayFile(sourcePath)
    const targetJson = await readJsonRecordOrArrayFile(targetPath)
    if (jsonValueHasContent(sourceJson) && !jsonValueHasContent(targetJson)) {
      addMissing(`${fileName}:target-empty`)
      continue
    }

    if (fileName === SETTINGS_FILE_NAME && isJsonRecord(sourceJson) && isJsonRecord(targetJson)) {
      for (const key of collectMissingSettingsKeys(sourceJson, targetJson)) {
        if (missing.length >= limit) break
        addMissing(`settings.json:${key}`)
      }
    }
  }

  return missing
}

async function removeLegacyUserDataPathIfMigrated (legacyPath: string, userDataPath: string): Promise<void> {
  const missingEntries = await collectUnmigratedCriticalEntries(legacyPath, userDataPath)
  if (missingEntries.length > 0) {
    console.warn(`[main:migration] Keeping legacy userData path ${legacyPath}; still missing critical entries in ${userDataPath}: ${missingEntries.join(', ')}`)
    return
  }

  await removeLegacyUserDataPath(legacyPath, userDataPath)
}

async function mergeLegacySettingsIfPresent (
  legacyPath: string,
  userDataPath: string,
  conflictMode: 'source-wins' | 'target-wins'
): Promise<CopyMissingUserDataResult> {
  const legacySettingsPath = path.join(legacyPath, 'settings.json')
  if (!(await pathExists(legacySettingsPath))) {
    return { copied: 0, merged: 0, skipped: 0 }
  }

  return mergeSettingsFile(legacySettingsPath, path.join(userDataPath, SETTINGS_FILE_NAME), conflictMode)
}

function resolveLegacyUserDataPaths (appDataPath: string, userDataPath: string): string[] {
  return Array.from(new Set(
    LEGACY_USER_DATA_DIR_NAMES
      .map(legacyName => path.join(appDataPath, legacyName))
      .filter(legacyPath => path.resolve(legacyPath) !== path.resolve(userDataPath))
  ))
}

export async function migrateUserDataForRename (): Promise<void> {
  const userDataPath = app.getPath('userData')
  const appDataPath = app.getPath('appData')
  const legacyPaths = resolveLegacyUserDataPaths(appDataPath, userDataPath)

  const existingLegacyPaths: string[] = []
  for (const legacyPath of legacyPaths) {
    if (await pathExists(legacyPath)) existingLegacyPaths.push(legacyPath)
  }

  if (existingLegacyPaths.length === 0) return

  const promotedLegacyPaths = new Set<string>()
  let hasAppliedPrimarySettings = false

  if (!(await pathExists(userDataPath))) {
    const legacyPresence = await Promise.all(existingLegacyPaths.map(async legacyPath => ({
      path: legacyPath,
      hasCriticalData: await getCriticalUserDataPresence(legacyPath)
    })))
    const preferredLegacyPath = legacyPresence.find(item => item.hasCriticalData)?.path || existingLegacyPaths[0]

    try {
      await promoteLegacyUserDataPath(preferredLegacyPath, userDataPath)
      promotedLegacyPaths.add(preferredLegacyPath)
      hasAppliedPrimarySettings = await pathExists(path.join(userDataPath, SETTINGS_FILE_NAME))
      await removeLegacyUserDataPathIfMigrated(preferredLegacyPath, userDataPath)
    } catch (error) {
      console.warn(`[main:migration] Failed to migrate userData from ${preferredLegacyPath} to ${userDataPath}; continuing with legacy path`, error)
      app.setPath('userData', preferredLegacyPath)
      return
    }
  }

  for (const legacyPath of existingLegacyPaths) {
    if (promotedLegacyPaths.has(legacyPath)) continue
    if (!(await pathExists(legacyPath))) continue

    try {
      const settingsResult = await mergeLegacySettingsIfPresent(
        legacyPath,
        userDataPath,
        hasAppliedPrimarySettings ? 'target-wins' : 'source-wins'
      )
      if (settingsResult.copied > 0 || settingsResult.merged > 0) {
        console.log(`[main:migration] Migrated legacy settings from ${legacyPath} into ${userDataPath} (${settingsResult.copied} copied, ${settingsResult.merged} merged)`)
      }
      if (settingsResult.copied > 0 || settingsResult.merged > 0 || settingsResult.skipped > 0) {
        hasAppliedPrimarySettings = true
      }
    } catch (error) {
      console.warn(`[main:migration] Failed to migrate legacy settings from ${legacyPath} into ${userDataPath}; keeping legacy path for retry`, error)
      continue
    }

    const [currentHasCriticalData, currentHasDirectoryData, legacyHasCriticalData, legacyHasDirectoryData] = await Promise.all([
      getCriticalUserDataPresence(userDataPath),
      getCriticalUserDataDirectoryPresence(userDataPath),
      getCriticalUserDataPresence(legacyPath),
      getCriticalUserDataDirectoryPresence(legacyPath)
    ])

    if (!legacyHasCriticalData) {
      await removeLegacyUserDataPathIfMigrated(legacyPath, userDataPath)
      continue
    }

    if (!currentHasCriticalData || (!currentHasDirectoryData && legacyHasDirectoryData)) {
      try {
        await promoteLegacyUserDataPath(legacyPath, userDataPath)
        promotedLegacyPaths.add(legacyPath)
        hasAppliedPrimarySettings = await pathExists(path.join(userDataPath, SETTINGS_FILE_NAME))
        await removeLegacyUserDataPathIfMigrated(legacyPath, userDataPath)
      } catch (error) {
        console.warn(`[main:migration] Failed to migrate userData from ${legacyPath} to ${userDataPath}; continuing with legacy path`, error)
        app.setPath('userData', legacyPath)
        return
      }
      continue
    }

    try {
      const result = await copyCriticalUserDataEntries(legacyPath, userDataPath, {
        settingsConflict: 'target-wins'
      })
      if (result.copied > 0 || result.merged > 0 || result.skipped > 0) {
        console.log(`[main:migration] Merged legacy userData from ${legacyPath} into ${userDataPath} (${result.copied} copied, ${result.merged} merged, ${result.skipped} skipped)`)
      }
      await removeLegacyUserDataPathIfMigrated(legacyPath, userDataPath)
    } catch (error) {
      console.warn(`[main:migration] Failed to merge legacy userData from ${legacyPath} into ${userDataPath}; keeping current userData path`, error)
    }
  }
}
