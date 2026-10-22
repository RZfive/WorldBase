#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${WORLDBASE_REAL_PM_E2E:-}" != "1" ]]; then
  printf 'error: WORLDBASE_REAL_PM_E2E=1 is required to run the real package-manager E2E test.\n' >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1 && ! command -v npm >/dev/null 2>&1; then
  printf 'error: neither pnpm nor npm is available on PATH; install one to run the real package-manager E2E test.\n' >&2
  exit 1
fi

printf '\n==> Package managers\n'
if command -v pnpm >/dev/null 2>&1; then
  printf 'pnpm %s (%s)\n' "$(pnpm --version)" "$(command -v pnpm)"
else
  printf 'pnpm not found\n'
fi
if command -v npm >/dev/null 2>&1; then
  printf 'npm %s (%s)\n' "$(npm --version)" "$(command -v npm)"
else
  printf 'npm not found\n'
fi

export WORLDBASE_REAL_PM_E2E=1
printf '\n==> Real package-manager write E2E\n'
cargo test --manifest-path harness-rs/Cargo.toml -p worldbase-tools --test real_package_manager_e2e -- --nocapture
