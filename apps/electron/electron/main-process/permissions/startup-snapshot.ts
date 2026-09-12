/** No timers, TTLs or implicit retries: a native probe belongs to app startup. */
export function createStartupPermissionSnapshot<T> (read: () => T, unavailable: T) {
  let value = unavailable
  let initialized = false
  return {
    initialize (): T {
      if (!initialized) {
        initialized = true
        try { value = read() } catch { /* Keep the unavailable startup state. */ }
      }
      return value
    },
    get (): T { return value }
  }
}
