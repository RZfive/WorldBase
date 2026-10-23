/**
 * The Rust harness engine emits coding events as `{ status }` / `{ diff }`,
 * while the renderer and preload contract consume `{ codingStatus }` /
 * `{ codingDiff }`. Normalize once at the main-process boundary so every
 * renderer path (IPC, persistence, auto-open watchers) sees one shape.
 */
export function toRendererStreamEvent (event: Record<string, unknown>): Record<string, unknown> {
  if (event.type === 'coding_status' && 'status' in event) {
    return { type: 'coding_status', codingStatus: event.status }
  }
  if (event.type === 'coding_diff' && 'diff' in event) {
    return { type: 'coding_diff', codingDiff: event.diff }
  }
  return event
}
