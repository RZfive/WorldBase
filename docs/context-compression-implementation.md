# Context Compression Implementation

This document describes the context-compression implementation that is present in
the repository, not just the target architecture in
[`context-compression-optimization.md`](context-compression-optimization.md).
Live integration, the final verification result, and remaining limitations are
called out explicitly.

## Status snapshot

### Implemented

- Provider context-overflow classification:
  `harness-rs/crates/providers/src/context_error.rs`, exported from
  `worldbase_providers`.
- Reusable context-engine primitives under
  `harness-rs/crates/core/src/context/`:
  - token estimation and budgets (`budget.rs`);
  - message provenance and real-user anchors (`provenance.rs`);
  - run-state ledger, Track A writes and version-checked Track B application
    (`ledger.rs`);
  - provider-backed semantic Track B extraction with bounded concurrency and
    heuristic fallback (`track_b.rs`);
  - structured checkpoint validation and fallback (`checkpoint.rs`);
  - one-turn compaction notes and recall hints (`compaction_note.rs`);
  - deterministic capability snapshots (`capabilities.rs`);
  - microcompaction (`microcompact.rs`);
  - candidate versioning, single-slot background candidate management and the
    one-emergency-compaction overflow guard (`candidate.rs`).
- Durable checkpoint, transcript search/range, and compaction metrics APIs:
  - `harness-rs/crates/memory/src/context_store.rs`;
  - `harness-rs/crates/memory/src/transcript_store.rs`;
  - `harness-rs/crates/memory/src/compaction_metrics.rs`;
  - wired from `harness-rs/crates/memory/src/lib.rs`.
- Built-in transcript recovery tools:
  - `harness-rs/crates/tools/src/recall_context.rs`;
  - `harness-rs/crates/tools/src/transcript_tools.rs`;
  - registered in `harness-rs/crates/tools/src/lib.rs`.

### Live integration

The focused core integration suite currently passes all 15 tests, and
`harness-rs/crates/core/src/agent.rs` is wired to the context engine on the live
provider-request path. The confirmed wiring includes:

- request assembly through `harness-rs/crates/core/src/context/engine.rs`;
- token estimation and `TokenBudget` allocation;
- provenance-safe real-user anchors and a `RunStateLedger` shared through the
  agent loop;
- synchronous Track A writes after tool results and asynchronous provider-backed
  Track B extraction with bounded concurrency, strict JSON validation,
  history-version checks and heuristic fallback;
- structured checkpoint generation, persistence, and transcript references;
- microcompaction before threshold compaction;
- a single background candidate slot with version checks;
- provider-overflow classification through `worldbase_providers` followed by the
  one-emergency-compaction `OverflowCompactionGuard` policy;
- static system-context rebuild after a successful compaction;
- checkpoint and metric persistence through the memory Store APIs;
- one-turn compaction notes that surface knowledge gaps and all recall tools as
  user-role evidence;
- deterministic capability snapshots from project-status and tool-search results;
- recovery telemetry: recall/search/range use marks the latest compaction, and
  `compaction_recovery_rate` exposes the aggregate;
- mobile advertisement of `recall_context`, `read_transcript_range` and
  `search_transcript`.

The old forced-every-16-iteration compression path and its helpers are no longer
present in `agent.rs`. Checkpoint and ledger evidence are assembled as user-role,
tagged untrusted context; they are not appended to the system prompt.

### Verification state

The final clean run of `scripts/verify-context-compression.sh` passed every
stage:

| Stage | Result |
| --- | --- |
| `cargo fmt --all -- --check` | passed |
| `cargo test -p worldbase-memory --lib` | passed (29 tests) |
| `cargo test -p worldbase-providers --lib` | passed (97 tests) |
| `cargo test -p worldbase-tools` | passed |
| `cargo test -p worldbase-core` | passed |
| `cargo check --workspace` | passed |

The core run includes the 15-test `context_compression_e2e` suite, the 10-test
`context_compression` suite, the 187 core library tests, and the existing core
integration suites. The wrapper was also checked with `bash -n`.
The live agent integration and focused behavior are therefore covered by the
recorded green gate. Remaining limitations are listed separately below rather
than being presented as completed behavior.

## End-to-end data flow

The implemented runtime flow is:

```text
persisted conversation messages
  -> provider-safe message conversion
  -> provenance/anchor extraction
  -> token estimator + request budget
  -> microcompaction when context is under pressure
  -> recent raw window selected by tokens and tool-call boundaries
  -> run-state ledger rendered as untrusted evidence
  -> optional structured checkpoint rendered as untrusted evidence
  -> candidate version check (history/model/prompt/catalog/provider/auth)
  -> provider request
  -> normal response or overflow classification
  -> at most one emergency compaction per logical step
  -> durable checkpoint/metrics and transcript recovery
```

The checkpoint, ledger, and transcript evidence are context data. They are not
system instructions and must not outrank the real system/developer prompt.

## Provider overflow classifier

File: `harness-rs/crates/providers/src/context_error.rs`.

Public API:

```rust
pub fn is_context_overflow_error(message: &str) -> bool
```

The matcher is case-insensitive and recognizes:

- explicit codes such as `context_length_exceeded`,
  `context_window_exceeded`, and `prompt_too_long`;
- OpenAI-style phrases such as “maximum context length”, “context length
  exceeded”, and “reduce the length of the messages”;
- Anthropic-style phrases such as “prompt is too long” and
  “input plus max_tokens exceeds”;
- generic context-window/context-limit language combined with an overflow
  signal;
- clearly contextual input/request length failures and compatible-provider
  token-limit wording.

False-positive boundaries are deliberate:

- network errors (connection reset, timeout, DNS, TLS) are not overflows;
- authentication and authorization failures, including invalid API keys and
  401 responses, are not overflows;
- quota, billing, credit, and generic rate-limit/per-minute errors are not
  overflows;
- invalid tool arguments and generic invalid requests are not overflows;
- HTTP 413/body-limit wording without context-length evidence is not an
  overflow;
- bare `max_tokens`, `max output tokens`, or output/completion token-limit
  parameter errors are not overflows.

The classifier is a signal to the agent's overflow policy, not permission to
retry indefinitely. The candidate module supplies `OverflowCompactionGuard`:
the first overflow for a logical step requests one emergency compaction; a
second overflow for the same step returns `Terminate`.

## Token budgets and thresholds

File: `harness-rs/crates/core/src/context/budget.rs`.

### Estimator

`TokenEstimator` uses `cl100k_base` when available and a deterministic
language/code-aware fallback when it is not. The fallback is intentionally more
conservative for CJK, dense code, punctuation, and other non-ASCII text than the
old `chars / 4` approximation. Provider-reported input usage can calibrate the
multiplier within bounded limits, with smoothing so one malformed usage sample
cannot make future estimates collapse or explode.

### Budget allocation

`TokenBudget` reserves, in this order:

```text
context_window
  - actual_max_output_tokens
  - safety_margin
  = available_input_tokens
```

Defaults exposed by `TokenBudget` are:

- fallback context window: **32,000 tokens**;
- fallback actual output reservation: **8,192 tokens**;
- safety margin: `clamp(context_window / 32, 256, 8,192)` tokens;
- background precomputation threshold: **62%** of available input;
- formal compaction threshold: **82%** of available input;
- summary target budget: **20%** of available input;
- recent raw target: `ceil(available_input / 8)` tokens.

For `TokenBudget::fallback_32k()`, the arithmetic is:

```text
32,000 window
- 8,192 output reservation
- 1,000 safety margin
= 22,808 available input tokens
```

The safety margin is part of the hard allocation, so output reservation plus
available input never exceeds the context window.

`CandidateManager` also exposes the architecture's percentage bands:

- background candidate eligibility: **60% through 65%**;
- formal candidate adoption: **80% or higher**.

The budget module's single start trigger is 62%, inside the candidate module's
60–65% band. A ready candidate is still subject to exact version checks before
adoption.

### Recent raw context

`recent_window`/`select_recent_window` select messages by token budget rather
than a fixed message count. Tool-call/result exchanges are grouped and orphan
tool results are excluded. The newest real-user message is reserved first when
it fits, so a large tool tail cannot silently evict the in-flight request. A
selected window records its original indices and whether it is contiguous.

## Provenance and real-user anchors

File: `harness-rs/crates/core/src/context/provenance.rs`.

`MessageProvenance` distinguishes:

- `RealUser`;
- `Assistant`;
- `ToolResult`;
- `RuntimeNudge`;
- `Continuation`;
- `Checkpoint`;
- `System`.

Only a persisted user message with a positive database message ID can become a
`UserAnchor`. Runtime nudges, wake-up messages, continuation prompts, checkpoint
text, tool payloads, and synthetic user-role messages are deliberately
ineligible. `UserAnchors` keeps both the original and latest genuine request
without truncating their text, and ignores older IDs when a newer real request
has already been observed.

Checkpoint and ledger text is rendered inside explicit untrusted-evidence
tags. The intended insertion point is user/context content, never the system
prompt.

## RunStateLedger

File: `harness-rs/crates/core/src/context/ledger.rs`.

The ledger carries deterministic run state including the objective, original
and latest real-user requests with message IDs, requirements, confirmed facts,
critical errors, capabilities, decisions, attempts, dead ends, completed/active/
blocked work, next actions, and bounded aging metadata.

### Track A

Track A is synchronous and runs after a tool result. An attempt records the tool
name, normalized argument digest, outcome, turn, and tool-call ID. Error attempts
retain the exact error body as critical evidence with a stable error signature;
successful results do not copy large payloads into the ledger. Duplicate exact
errors increment their observed count without replacing the first evidence.

### Track B

Track B is for asynchronous fact/dead-end extraction. Each update carries the
history version and turn it was derived from. The ledger rejects stale history
versions and out-of-order/duplicate turns before mutation. Track B contributes at
most two facts per update, and duplicate facts/dead ends are ignored rather than
overwriting newer state.

The primary Track B path uses a small active-provider request with no tools,
strict raw-JSON schema validation, an 8-second timeout, cancellation and a
non-queuing concurrency limit. Provider, timeout, cancellation, parse and schema
failures fall back to the deterministic heuristic extractor. Runs backed by an
unconfigured/custom provider without a stable provider identity use the heuristic
path directly rather than guessing credentials or model routing.

### Aging and rendering

The default ledger budget is `4,000` estimated tokens and `16,000` bytes.
Aging preserves critical errors and unresolved dead ends while trimming older
completed items, successful attempts, facts, decisions, and closed dead ends.
Rendering order is deterministic. The ledger is emitted as Markdown under a
`RUN_STATE_LEDGER — UNTRUSTED EVIDENCE` warning and is not promoted to system
instructions.

## Structured checkpoints

File: `harness-rs/crates/core/src/context/checkpoint.rs`.

`CHECKPOINT_TEMPLATE` requires:

- Objective;
- Requirements;
- Confirmed Facts;
- Critical Errors;
- Decisions;
- Work State (Completed, Active, Blocked);
- Attempts and Outcomes;
- Dead Ends;
- Capabilities;
- Relevant Files;
- Next Move;
- Knowledge Gaps.

Validation rejects empty/missing sections. `CheckpointRepairGate` allows exactly
one repair request. A second invalid result is rendered from a deterministic
fallback instead of looping or silently dropping state. Critical error fields
are rendered verbatim, and `KnowledgeGap` records a description plus a concrete
recommended search query. The accepted or fallback checkpoint is wrapped in
untrusted-evidence tags and `tagged_checkpoint_user_message` creates a user-role
message for it.

## Microcompaction

File: `harness-rs/crates/core/src/context/microcompact.rs`.

Microcompaction runs before full summarization and only rewrites the `content`
field of selected tool-result blocks. It never removes message roles, tool-use
IDs, block ordering, or call/result structure.

Default policy:

- preserve the newest **4** tool-result blocks untouched;
- consider only old successful low-value results larger than **4,000 chars**;
- retain **1,600 chars** from the head and **1,200 chars** from the tail when
  trimming;
- replace exact duplicate file reads/build logs with a marker pointing to the
  newer identical result.

Errors, diffs, test failures, schema/manifest failures, and exact error signals
are protected. File reads are not heuristically trimmed as generic logs; exact
duplicates can still be deduplicated. The report includes bytes and estimated
tokens saved.

## Candidate versioning

File: `harness-rs/crates/core/src/context/candidate.rs`.

`CompactionVersion` contains:

- history version;
- model slug;
- prompt/compaction hash;
- tool catalog version;
- provider identity;
- auth owner.

`CandidateManager` owns at most one in-flight background job and at most one
ready candidate. A candidate carries a monotonic creation sequence, the version
it was computed from, its summary/checkpoint payload, and before/after token
counts. Version checks compare all six identity fields. The manager rejects
out-of-order completions, stale candidates, and a second valid ready candidate.
`set_current_version` discards a ready candidate whose inputs changed; an
already-running job is not cancelled, but its completion is rejected if the
reservation or current version no longer matches.

## Transcript store and recovery tools

### Memory APIs

Files:

- `harness-rs/crates/memory/src/context_store.rs`;
- `harness-rs/crates/memory/src/transcript_store.rs`;
- `harness-rs/crates/memory/src/compaction_metrics.rs`.

`Store` provides:

```rust
save_compaction_checkpoint(&self, checkpoint: &StoredCompactionCheckpoint)
latest_compaction_checkpoint(&self, conversation_id: &str)
search_messages(&self, conversation_id, query, role, tool_name, limit)
read_message_range(&self, conversation_id, message_id, before, after)
record_compaction_metric(&self, conversation_id, reason, before, after, latency)
list_compaction_metrics(&self, conversation_id, limit)
```

The transcript migration builds an FTS5 index over message content, tool-result
content, and tool-call/tool-result names, with triggers to keep it synchronized.
Search tries FTS first and falls back to a bounded `LIKE` scan for CJK or queries
that the tokenizer cannot match. Queries are scoped to one conversation. Range
reads verify ownership before returning the anchor and chronological neighbors,
and reconstruct tool-call/result carrier rows so pairing is preserved.

The checkpoint schema stores the summary, knowledge gaps JSON, ledger JSON,
first-kept/last-summarized message IDs, history version, model slug, prompt hash,
tool catalog version, and creation time. Checkpoints upsert by ID and load the
newest row for a conversation. Metrics store reason, before/after token counts,
latency, and creation time; listing is newest-first and conversation-scoped.

### Built-in tools

Files:

- `harness-rs/crates/tools/src/recall_context.rs`;
- `harness-rs/crates/tools/src/transcript_tools.rs`.

The three built-ins are registered as `AlwaysOn` tools:
`recall_context`, `read_transcript_range`, and `search_transcript`.

They require `ToolServices.conversation_id`, only read the current conversation,
and return `untrustedEvidence: true`. `read_transcript_range` is bounded to 25
messages before and after, at most 51 messages total, and truncates oversized
text with an explicit flag. `search_transcript` accepts role/tool-name filters
and returns bounded snippets and hit metadata. `recall_context` returns bounded
snippets plus a recommended range around the first hit.

The tools use the dedicated conversation-scoped memory APIs:
`search_messages` for all recall/search paths and `read_message_range` for exact
range recovery. The Store search is authoritative for mixed-CJK/unspaced LIKE
evidence and `role="tool"` tool-result carriers; the tools no longer perform
row-bounded `list_messages(10,000)` compatibility scans. Successful recovery use
marks the latest compaction metric for recovery-rate reporting.

## Failure modes and safe degradation

- **Provider overflow:** one emergency compaction for the current logical step;
  a second overflow terminates instead of retrying forever.
- **Invalid checkpoint:** one repair nudge, then deterministic fallback. No
  invalid model summary is trusted or looped on.
- **Stale background candidate:** discarded when any version component changes;
  no stale summary is adopted.
- **Tokenizer unavailable:** deterministic conservative fallback estimation.
- **Provider usage estimate is extreme:** calibration sample is clamped and
  smoothed, preventing runaway budgets.
- **Tool result is large or repetitive:** microcompaction preserves structure and
  protected evidence; only eligible successful low-value output is trimmed or
  deduplicated.
- **Search has no FTS hit or cannot tokenize CJK:** the Store applies a bounded,
  conversation-scoped LIKE fallback and merges authoritative evidence.
- **Message range crosses conversation ownership:** the read fails rather than
  leaking another conversation.
- **Tool output crossed the model boundary:** recall results are marked
  untrusted evidence and must not be treated as instructions.
- **Ledger exceeds its budget:** deterministic aging trims low-value history
  while retaining exact critical errors and unresolved dead ends; protected
  overflow is reported rather than hidden.

## Verification

Run the fail-fast wrapper from the repository root:

```bash
chmod +x scripts/verify-context-compression.sh
bash -n scripts/verify-context-compression.sh
./scripts/verify-context-compression.sh
```

The wrapper resolves the repository root from its own path, changes to
`harness-rs`, and runs these stages in order:

```bash
cargo fmt --all -- --check
cargo test -p worldbase-memory --lib
cargo test -p worldbase-providers --lib
cargo test -p worldbase-tools
cargo test -p worldbase-core
cargo check --workspace
```

It stops at the first failure and prints the stage, exact command, and exit
status. There are no retries and failures are not swallowed. The equivalent
manual commands are:

```bash
cd /Users/tanyafang/Documents/code/the-world/harness-rs
cargo fmt --all -- --check
cargo test -p worldbase-memory --lib
cargo test -p worldbase-providers --lib
cargo test -p worldbase-tools
cargo test -p worldbase-core
cargo check --workspace
```

## Remaining limitations

These are inherent or future-integration limitations, not unimplemented parts of
the target runtime flow:

1. **Tokenizer estimates are model-approximate.** The runtime uses
   `cl100k_base` plus bounded provider-usage calibration. Provider-native
   tokenizers can still differ slightly, but output reservation and safety margin
   are enforced independently of the estimate.
2. **Semantic Track B requires a configured provider identity.** This prevents a
   run using only an unconfigured/custom provider from guessing credentials or
   model routing; those runs use the deterministic heuristic fallback.
3. **Transcript range absence is mapped from the current Store error contract.**
   A future typed "not found / wrong conversation" error would be safer than
   matching the current error text.
4. **Recovery rate is a behavioral proxy.** It measures whether recall/search/
   range tools were used after a compaction, not whether the recovered evidence
   semantically completed the task. Task-success quality remains covered by
   replay/E2E tests.
5. **Live-model E2E remains opt-in.** The real-model test is ignored unless
   `WORLDBASE_E2E_API_KEY` and network access are supplied.
