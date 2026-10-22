#!/usr/bin/env bash
# Consolidated coding gate. Fails fast on the first failing section.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

section() {
  printf '\n==> %s\n' "$1"
}

section "Rust tests: worldbase-coding"
cargo test --manifest-path harness-rs/Cargo.toml -p worldbase-coding

section "Rust tests: worldbase-core"
cargo test --manifest-path harness-rs/Cargo.toml -p worldbase-core

section "Rust tests: worldbase-tools"
cargo test --manifest-path harness-rs/Cargo.toml -p worldbase-tools

section "Rust clippy: worldbase-coding"
cargo clippy --manifest-path harness-rs/Cargo.toml -p worldbase-coding --all-targets --no-deps -- -D warnings

section "Electron typecheck"
pnpm --dir apps/electron typecheck

section "Electron tests: rust-harness-host-callbacks"
pnpm --dir apps/electron test:rust-harness-host-callbacks

section "Electron tests: message-render-blocks"
pnpm --dir apps/electron test:message-render-blocks

section "Electron tests: message-segments"
pnpm --dir apps/electron test:message-segments

section "Electron tests: renderer-navigation"
pnpm --dir apps/electron test:renderer-navigation

printf '\nAll coding checks passed.\n'
