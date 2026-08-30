import type { AIExecutionEngine } from '../../../src/main/ai-harness/types.js'
import type { RustHarnessEngine } from '../../../src/main/ai-harness/rust-harness-engine.js'
import { mainState } from '../state.js'

/**
 * Rust mode is an execution boundary, not a best-effort preference.  This
 * error deliberately reaches renderer/LAN callers so they never continue on
 * the TypeScript harness while Settings still says Rust.
 */
export class RustHarnessUnavailableError extends Error {
  constructor (message: string, cause?: unknown) {
    super(message)
    this.name = 'RustHarnessUnavailableError'
    if (cause !== undefined) this.cause = cause
  }
}

export function isRustHarnessSelected (): boolean {
  return mainState.settingsStore?.getAIExecutionPreferences().harnessBackend === 'rust'
}

/**
 * Resolve the configured chat backend before a model/tool loop begins.
 * Context never affects this choice: once Rust is selected, every requested
 * capability is Rust-owned. A missing binary or failed handshake is surfaced
 * to the caller; silently returning the TS engine would invalidate parity
 * testing and can duplicate side effects such as project starts or images.
 */
export async function startSelectedRustHarness (): Promise<RustHarnessEngine | null> {
  if (!isRustHarnessSelected()) return null
  const engine = mainState.rustHarnessEngine
  const client = mainState.rustHarness
  if (!engine || !client?.isAvailable()) {
    throw new RustHarnessUnavailableError(
      'Rust harness is selected but unavailable. Build worldbase-app-server or choose the TypeScript harness.'
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
  const rust = await startSelectedRustHarness()
  if (rust) return rust
  const engine = mainState.aiEngine
  if (!engine) throw new Error('AI engine is not initialized')
  return engine
}
