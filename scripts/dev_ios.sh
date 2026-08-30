#!/bin/bash
# 启动 iOS 模拟器端：
#   1. 编译 Rust 静态库 (aarch64-apple-ios-sim) → apps/mobile/ios/rust-build
#   2. 无可用模拟器时提示先下载平台 (xcodebuild -downloadPlatform iOS)
#   3. 启动模拟器 + flutter run
# 已知遗留: FFI 符号需 force_load + export_dynamic 生效后首次验证
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:$PATH"

RUSTC_BIN="$(ls "$HOME"/.rustup/toolchains/*/bin/rustc 2>/dev/null | head -1 || true)"
[ -n "$RUSTC_BIN" ] && export RUSTC="$RUSTC_BIN"

echo "==> [1/3] 编译 Rust 静态库 (aarch64-apple-ios-sim)"
RUST_OUT_DIR="$ROOT/apps/mobile/ios/rust-build" ARCHS=arm64 PLATFORM_NAME=iphonesimulator \
  bash "$ROOT/scripts/build_rust_ios.sh"

echo "==> [2/3] 准备模拟器"
SIM_UDID="$(xcrun simctl list devices available | awk '/iPhone/{u=$NF; gsub(/[()]/,"",u); print u; exit}')"
if [ -z "$SIM_UDID" ]; then
  echo "未找到 iOS 模拟器。请先下载运行时: xcodebuild -downloadPlatform iOS" >&2
  exit 1
fi
xcrun simctl boot "$SIM_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$SIM_UDID" -b > /dev/null
open -a Simulator
echo "    模拟器: $SIM_UDID"

echo "==> [3/3] flutter run iOS"
cd "$ROOT/apps/mobile"
exec flutter run -d "$SIM_UDID"
