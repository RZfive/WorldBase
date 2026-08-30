#!/bin/bash
# 启动 macOS 端（Flutter 移动端 UI + FFI 进程内 harness）
# 用法: npm run dev:macos   (或 bash scripts/dev_macos.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---- 1) 编译宿主 FFI 动态库（Dart 侧解析器会从 harness-rs/target 读取）----
RUSTC_BIN="$(ls "$HOME"/.rustup/toolchains/*/bin/rustc 2>/dev/null | head -1 || true)"
CARGO_BIN="$(ls "$HOME"/.rustup/toolchains/*/bin/cargo 2>/dev/null | head -1 || true)"
CARGO_BIN="${CARGO_BIN:-cargo}"
[ -n "$RUSTC_BIN" ] && export RUSTC="$RUSTC_BIN"

echo "==> [1/2] 编译 macOS FFI 动态库 (worldbase-mobile-ffi)"
( cd "$ROOT/harness-rs" && "$CARGO_BIN" build -p worldbase-mobile-ffi )

# ---- 2) flutter run macOS ----
echo "==> [2/2] flutter run -d macos"
cd "$ROOT/apps/mobile"
exec flutter run -d macos
