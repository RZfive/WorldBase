# Desktop chat switching and permission snapshots

## macOS permission checks

- Electron reads Screen Recording and Accessibility status once in `setupIPC`, after `app.whenReady` and before creating renderer windows.
- `permissions:getComputerUse` only returns that in-memory startup snapshot. There is no TTL, polling, focus/visibility refresh or retry after a failed probe.
- Each renderer loads the snapshot once from `App.vue`. Settings and the chat toggle share it; conversation/provider selection does not invoke permission APIs.
- The explicit Grant button can open the system authorization UI. Changes in System Settings take effect in the app UI after a restart; the grant flow does not trigger another status probe.
- This is a UI-status policy, not a bypass of actual tool permissions. The native screenshot/input backend still enforces OS permissions when those tools are used.

## Conversation persistence

`ChatHistoryStore` is an asynchronous client for one serialized Node worker. The worker owns JSON parsing, file access, serialization and indexing; these operations must not be moved back into Electron's main thread.

- Existing `conversations/<id>.json` histories remain readable without migration.
- The sidebar summary index is built once per process and kept in memory. Save, metadata update, rename and delete update only the affected entry.
- Provider/model/auth/reasoning/temperature/agent selection uses `conversations:updateMetadata`, a validated, metadata-only IPC payload. It never includes messages, screenshots or document contents.
- Pending metadata lives in `conversations/metadata/<id>.json`. Warm metadata updates do not read or rewrite the large history file. Reads overlay this small file on the history; the next content save folds it into the main JSON atomically and removes the sidecar. Keep the whole `conversations` directory when backing up data.
- Writes use temporary files plus rename. The worker serializes changes, and shutdown drains accepted writes before terminating it. Worker failure/timeout is reported instead of silently falling back to synchronous main-thread IO.
- Save responses include the affected summary so the renderer need not reload the entire sidebar.

Conversation navigation selects from the already-loaded provider catalog. Startup/settings events refresh that catalog. Navigation versions discard stale responses, including loads completing after a new chat was created. Leaving a streaming chat keeps references and its metadata context rather than immediately serializing its messages.

## Build and tests

`apps/electron/scripts/build-main.mjs` produces `dist-electron/electron/chat-history-worker.cjs` alongside both ESM and bytecode main entries. The existing Electron Builder file glob includes this worker. Rebuild **main, preload and renderer** and restart the application to load this change.

```sh
pnpm --dir apps/electron test:renderer-navigation
pnpm electron:typecheck
pnpm electron:test
pnpm --dir apps/electron build
pnpm --dir apps/electron build:electron
```

Tests cover startup-only native checks, metadata-only payloads and disk writes, summary-cache read counts, legacy histories, sidecar recovery/folding, worker shutdown/failure/timeout, event-loop liveness during indexing, cached provider selection, navigation races and hidden message-list layout. These tests verify the work removed from switching paths; they are not a substitute for frame-time measurements in a running UI.
