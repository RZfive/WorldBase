import type { AIExecutionEngine } from '../../../src/main/ai-harness/types.js'
import type { RustHarnessEngine } from '../../../src/main/ai-harness/rust-harness-engine.js'
import { mainState } from '../state.js'

/**
 * Rust mode is an execution boundary, not a best-effort preference.  This
 * error deliberately reaches renderer/LAN callers so they never continue on
 * a TypeScript harness while the Rust deployment is broken.
 */
export class RustHarnessUnavailableError extends Error {
  constructor (message: string, cause?: unknown) {
    super(message)
    this.name = 'RustHarnessUnavailableError'
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * The Rust harness is the only execution backend. There is no TypeScript
 * fallback anymore: a missing binary or a failed handshake is surfaced to
 * the caller instead of silently degrading to a second implementation.
 */
export async function startSelectedRustHarness (): Promise<RustHarnessEngine> {
  const engine = mainState.rustHarnessEngine
  const client = mainState.rustHarness
  if (!engine || !client?.isAvailable()) {
    throw new RustHarnessUnavailableError(
      'Rust harness is unavailable. Build worldbase-app-server and ensure it is installed.'
    )
  }
  try {
    await engine.start()
    return engine
  } catch (error) {
    throw new RustHarnessUnavailableError(
      `Rust harness failed to start: ${error instanceof Error ? error.message : String(error)}`,
      error
    )
  }
}

export async function getSelectedExecutionEngine (): Promise<AIExecutionEngine> {
  return await startSelectedRustHarness()
}
