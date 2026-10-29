#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -z "${WORLDBASE_E2E_API_KEY:-}" ]]; then
  printf 'error: WORLDBASE_E2E_API_KEY is required\n' >&2
  exit 1
fi

printf 'Real-model E2E environment contract:\n'
printf '  WORLDBASE_E2E_API_KEY=<set>\n'
printf '  WORLDBASE_E2E_BASE_URL=%s\n' "${WORLDBASE_E2E_BASE_URL:-<provider default>}"
printf '  WORLDBASE_E2E_MODEL=%s\n' "${WORLDBASE_E2E_MODEL:-<provider default>}"
printf '  WORLDBASE_E2E_PROTOCOL=%s\n' "${WORLDBASE_E2E_PROTOCOL:-openai-chat}"
printf '  WORLDBASE_E2E_TIMEOUT_SECS=%s\n' "${WORLDBASE_E2E_TIMEOUT_SECS:-300}"
printf '  WORLDBASE_E2E_MAX_TOKENS=%s\n' "${WORLDBASE_E2E_MAX_TOKENS:-<unset>}"

set +e
cargo test --manifest-path harness-rs/Cargo.toml -p worldbase-core --test real_model_e2e -- --ignored --nocapture
status=$?
set -e

printf 'real-model E2E exit code: %s\n' "$status"
exit "$status"
