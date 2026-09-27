import { computed, shallowRef } from 'vue'

type UpdateAPI = Pick<NonNullable<Window['electronAPI']>, 'getAppUpdateState' | 'onAppUpdateStateChanged'>

/** Statuses that mean a newer version exists: found remotely or already downloaded. */
const UPDATE_PENDING_STATUSES: ReadonlySet<AppUpdateState['status']> = new Set(['update_available', 'downloaded'])

/**
 * Process-wide mirror of the main process update state. UpdateService checks on
 * every launch, persists each transition, and broadcasts `appUpdate:stateChanged`
 * to every window, so subscribing once here is enough for passive badges (dock
 * gear, settings nav) without each component holding its own listener.
 */
export function createAppUpdateState (
  getAPI: () => UpdateAPI | undefined = () => window.electronAPI
) {
  const state = shallowRef<AppUpdateState | null>(null)
  const updateAvailable = computed(() =>
    state.value != null && UPDATE_PENDING_STATUSES.has(state.value.status)
  )

  function start (): void {
    const api = getAPI()
    if (!api) return

    // Subscribe before the initial fetch; if a broadcast lands in between it
    // wins and the stale fetch response is dropped.
    let broadcastSeen = false
    api.onAppUpdateStateChanged((next) => {
      broadcastSeen = true
      state.value = next
    })
    void api.getAppUpdateState()
      .then(initial => {
        if (!broadcastSeen) state.value = initial
      })
      .catch(() => {
        // No badge is safer than a wrong one; the About panel surfaces errors.
      })
  }

  start()

  return { state, updateAvailable }
}

export const appUpdateState = createAppUpdateState()
