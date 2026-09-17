import { computed, ref, shallowRef } from 'vue'
import type { ComputerUsePermissionTarget } from '../../shared/computer-use-permissions'

export type ComputerUsePermissionStatus = Awaited<ReturnType<NonNullable<Window['electronAPI']>['getComputerUsePermissions']>>
type PermissionAPI = Pick<NonNullable<Window['electronAPI']>, 'getComputerUsePermissions' | 'requestComputerUsePermissions'>

/** Load the main process's startup snapshot once. Never recheck on navigation. */
export function createComputerUsePermissionState (
  getAPI: () => PermissionAPI | undefined = () => window.electronAPI
) {
  const status = shallowRef<ComputerUsePermissionStatus | null>(null)
  const requesting = ref(false)
  const granted = computed(() => status.value?.granted ?? null)
  let initialization: Promise<ComputerUsePermissionStatus | null> | null = null
  let requestingPromise: Promise<void> | null = null

  function initialize (): Promise<ComputerUsePermissionStatus | null> {
    if (!initialization) {
      initialization = Promise.resolve().then(async () => {
        const value = await getAPI()?.getComputerUsePermissions()
        status.value = value ?? null
        return status.value
      }).catch(() => null)
    }
    return initialization
  }

  function request (target?: ComputerUsePermissionTarget): Promise<void> {
    if (requestingPromise) return requestingPromise
    requesting.value = true
    requestingPromise = Promise.resolve().then(async () => {
      // Explicitly open the authorization UI, but keep the startup snapshot.
      // New grants/revocations are reflected after restarting the application.
      await getAPI()?.requestComputerUsePermissions(target)
    }).catch(() => {}).finally(() => {
      requesting.value = false
      requestingPromise = null
    })
    return requestingPromise
  }

  return { status, granted, requesting, initialize, request }
}

export const computerUsePermissions = createComputerUsePermissionState()
