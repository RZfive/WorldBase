#!/usr/bin/env bash
# Final context-compression verification gate. Stops at the first failure and
# reports the exact stage, command, and exit status.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HARNESS_DIR="$REPO_ROOT/harness-rs"

print_command() {
  printf 'command:'
  printf ' %q' "$@"
  printf '\n'
}

run_stage() {
  local stage="$1"
  shift
  local status=0

  printf '\n==> %s\n' "$stage"
  print_command "$@"
  "$@" || status=$?

  if [ "$status" -ne 0 ]; then
    printf 'FAILED stage: %s\n' "$stage" >&2
    printf 'failed command:' >&2
    printf ' %q' "$@" >&2
    printf '\n' >&2
    printf 'exit status: %d\n' "$status" >&2
    exit "$status"
  fi

  printf 'PASS: %s\n' "$stage"
}

cd "$HARNESS_DIR"

run_stage \
  "rustfmt (all packages)" \
  cargo fmt --all -- --check

run_stage \
  "worldbase-memory library tests" \
  cargo test -p worldbase-memory --lib

run_stage \
  "worldbase-providers library tests" \
  cargo test -p worldbase-providers --lib

run_stage \
  "worldbase-tools tests" \
  cargo test -p worldbase-tools

run_stage \
  "worldbase-core tests" \
  cargo test -p worldbase-core

run_stage \
  "workspace check" \
  cargo check --workspace

printf '\nAll context-compression verification stages passed.\n'
