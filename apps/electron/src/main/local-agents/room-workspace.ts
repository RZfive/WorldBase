import { createHash } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { RoomLocalWorkspace } from '../../shared/local-agent-types.js'

async function existingDirectory (directory?: string | null): Promise<string | null> {
  if (!directory || !path.isAbsolute(directory)) return null
  try {
    const resolved = await realpath(directory)
    return (await stat(resolved)).isDirectory() ? resolved : null
  } catch {
    return null
  }
}

export async function resolveRoomLocalWorkspace (
  dataDir: string,
  groupId: string,
  taskDirectory?: string | null,
  projectDirectory?: string | null,
  roomDirectory?: string | null
): Promise<RoomLocalWorkspace> {
  const groupRoot = await existingDirectory(roomDirectory)
  if (groupRoot) return { path: groupRoot, source: 'group' }
  const taskRoot = await existingDirectory(taskDirectory)
  if (taskRoot) return { path: taskRoot, source: 'task' }
  const projectRoot = await existingDirectory(projectDirectory)
  if (projectRoot) return { path: projectRoot, source: 'project' }
  const key = createHash('sha256').update(groupId).digest('hex').slice(0, 20)
  return { path: path.join(dataDir, 'room-workspaces', `room-${key}`), source: 'room' }
}

export async function prepareRoomLocalWorkspace (workspace: RoomLocalWorkspace): Promise<string> {
  if (workspace.source !== 'room') {
    if (await existingDirectory(workspace.path) !== workspace.path) {
      throw new Error(`The approved working directory is no longer available: ${workspace.path}`)
    }
    return workspace.path
  }
  const base = path.dirname(workspace.path)
  const dataDir = await realpath(path.dirname(base))
  const managedBase = path.join(dataDir, path.basename(base))
  await mkdir(managedBase, { recursive: true, mode: 0o700 })
  if (await realpath(managedBase) !== managedBase) {
    throw new Error(`The default room workspace parent is redirected: ${base}`)
  }
  const directory = path.join(managedBase, path.basename(workspace.path))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (await realpath(directory) !== directory) {
    throw new Error(`The default room workspace resolves outside its managed path: ${workspace.path}`)
  }
  return directory
}
