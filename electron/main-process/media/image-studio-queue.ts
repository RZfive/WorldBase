import type { ImageStudioGenerateRequest } from '../../../src/shared/image-studio-types.js'
import { mainState } from '../state.js'
import { broadcastToAppWindows } from '../windows.js'

export function enqueueStudioImageTasks (requests: ImageStudioGenerateRequest[]): void {
  if (!requests.length) return
  mainState.pendingStudioImageTasks.push(...requests)
  // Poke any live window so an already-open studio drains immediately; a studio that
  // hasn't mounted yet drains on activation instead.
  broadcastToAppWindows('image:studio:tasksAdded', { count: requests.length })
}

export function drainPendingStudioImageTasks (): ImageStudioGenerateRequest[] {
  const drained = mainState.pendingStudioImageTasks
  mainState.pendingStudioImageTasks = []
  return drained
}
