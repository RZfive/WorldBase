#!/bin/bash
# iOS 构建期编译 Rust harness 静态库（由 WorldBaseRust.podspec 的 script_phase 调用）。
# 输入：Xcode 环境变量 PLATFORM_NAME / ARCHS / CONFIGURATION / BUILT_PRODUCTS_DIR
# 输出：$BUILT_PRODUCTS_DIR/libworldbase_mobile_ffi.a

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$SCRIPT_DIR/../harness-rs/Cargo.toml"

# rustc 优先取 rustup 工具链（homebrew rust 不含跨目标 std）
if [ -z "${RUSTC:-}" ]; then
  RUSTUP_RUSTC="$(ls "$HOME"/.rustup/toolchains/*/bin/rustc 2>/dev/null | head -1 || true)"
  if [ -n "$RUSTUP_RUSTC" ]; then
    export RUSTC="$RUSTUP_RUSTC"
  fi
fi

PROFILE="debug"
case "${CONFIGURATION:-Debug}" in
  Release* | Profile*) PROFILE="release" ;;
esac

TARGET=""
for ARCH in ${ARCHS:-arm64}; do
  case "$ARCH" in
    arm64)
      if [ "${PLATFORM_NAME:-}" = "iphoneos" ]; then
        TARGET="aarch64-apple-ios"
      else
        TARGET="aarch64-apple-ios-sim"
      fi
      ;;
    x86_64) TARGET="x86_64-apple-ios" ;;
  esac
  [ -n "$TARGET" ] && break
done

if [ -z "$TARGET" ]; then
  echo "warning: unsupported iOS arch, skip rust build" >&2
  exit 0
fi

echo "==> cargo build -p worldbase-mobile-ffi --target $TARGET ($PROFILE)"
BUILD_ARGS=(--manifest-path "$MANIFEST" -p worldbase-mobile-ffi --target "$TARGET")
if [ "$PROFILE" = "release" ]; then
  BUILD_ARGS+=(--release)
fi
cargo build "${BUILD_ARGS[@]}"

SRC="$SCRIPT_DIR/../harness-rs/target/$TARGET/$PROFILE/libworldbase_mobile_ffi.a"
OUT_DIR="${RUST_OUT_DIR:-${BUILT_PRODUCTS_DIR:-.}}"
cp "$SRC" "$OUT_DIR/libworldbase_mobile_ffi.a"
echo "==> Rust 静态库已复制到 $OUT_DIR/libworldbase_mobile_ffi.a"
