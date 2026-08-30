/**
 * Serializes the ownership handoff for project processes and MCP transports.
 *
 * The Electron shell keeps both implementations available during migration,
 * but only one may own project recovery at a time. Keeping this logic outside
 * IPC makes the ordering explicit and independently testable.
 */
export type HarnessBackend = 'ts' | 'rust'

export interface HarnessOwnershipDependencies {
  stopTypeScriptHealthChecks: () => Promise<void>
  startTypeScriptHealthChecks: () => void
  startRustHarness: () => Promise<void>
  stopTypeScriptProjects: () => Promise<void>
  handoffRustToTypeScript: () => Promise<void>
  rebuildTypeScriptImageLibrary: () => void
  notifyImageLibraryChanged: () => void
  onRustHandoffError?: (error: unknown) => void
}

/**
 * Move the runtime owner after an execution-preference save. Startup failure
 * is propagated to the settings transaction; it restores the old backend
 * instead of keeping a misleading Rust preference backed by TypeScript.
 */
export async function transitionHarnessOwnership (
  previous: HarnessBackend,
  next: HarnessBackend,
  rustHarnessIsRunning: boolean,
  dependencies: HarnessOwnershipDependencies
): Promise<void> {
  const takeRustOwnership = async (restoreTypeScriptOnFailure: boolean): Promise<void> => {
    // Wait for an in-flight TS health pass before the Rust process can bind a
    // project port or inspect the same project directory.
    await dependencies.stopTypeScriptHealthChecks()
    try {
      await dependencies.startRustHarness()
      await dependencies.stopTypeScriptProjects()
    } catch (error) {
      // A TS -> Rust switch is transactional. Restore recovery only when the
      // previous owner was TS; a broken Rust -> Rust retry must not revive a
      // hidden TS project runtime while Rust remains selected.
      if (restoreTypeScriptOnFailure) dependencies.startTypeScriptHealthChecks()
      throw error
    }
  }

  if (previous === 'ts' && next === 'rust') {
    await takeRustOwnership(true)
    return
  }

  if (previous === 'rust' && next === 'ts') {
    try {
      // This stops Rust project children and disposes Rust MCP transports.
      await dependencies.handoffRustToTypeScript()
    } catch (error) {
      dependencies.onRustHandoffError?.(error)
    }
    dependencies.startTypeScriptHealthChecks()
    dependencies.rebuildTypeScriptImageLibrary()
    dependencies.notifyImageLibraryChanged()
    return
  }

  // Retry a stopped Rust process with the same exclusivity guarantee.
  if (previous === 'rust' && next === 'rust' && !rustHarnessIsRunning) {
    await takeRustOwnership(false)
  }
}
