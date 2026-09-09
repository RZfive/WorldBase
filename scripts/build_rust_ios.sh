#!/bin/bash
# iOS 构建期编译 Rust harness 静态库（由 WorldBaseRust.podspec 的 script_phase 调用）。
# 输入：Xcode 环境变量 PLATFORM_NAME / ARCHS / CONFIGURATION / BUILT_PRODUCTS_DIR
# 输出：$BUILT_PRODUCTS_DIR/libworldbase_mobile_ffi.a

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$SCRIPT_DIR/../harness-rs/Cargo.toml"
HARNESS_DIR="$SCRIPT_DIR/../harness-rs"

# Xcode 的 PATH 通常不包含 ~/.cargo/bin；直接解析当前 rustup 工具链。
RUSTUP_BIN="$(command -v rustup 2>/dev/null || true)"
if [ -z "$RUSTUP_BIN" ]; then
  for candidate in "${CARGO_HOME:-$HOME/.cargo}/bin/rustup" /opt/homebrew/bin/rustup /usr/local/bin/rustup; do
    if [ -x "$candidate" ]; then
      RUSTUP_BIN="$candidate"
      break
    fi
  done
fi

if [ -n "${CARGO:-}" ]; then
  CARGO_BIN="$CARGO"
elif [ -n "$RUSTUP_BIN" ] && CARGO_BIN="$("$RUSTUP_BIN" which cargo 2>/dev/null)"; then
  :
elif CARGO_BIN="$(command -v cargo 2>/dev/null)"; then
  :
else
  echo "error: cargo not found; install the iOS Rust target with rustup" >&2
  exit 1
fi

RUSTC_BIN="${RUSTC:-}"
if [ -z "$RUSTC_BIN" ] && [ -n "$RUSTUP_BIN" ]; then
  RUSTC_BIN="$("$RUSTUP_BIN" which rustc 2>/dev/null || true)"
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
BUILD_ARGS=(--manifest-path "$MANIFEST" -p worldbase-mobile-ffi --target "$TARGET" --no-default-features)
if [ "$PROFILE" = "release" ]; then
  BUILD_ARGS+=(--release)
fi
if [ -n "$RUSTC_BIN" ]; then
  (cd "$HARNESS_DIR" && RUSTC="$RUSTC_BIN" "$CARGO_BIN" build "${BUILD_ARGS[@]}")
else
  (cd "$HARNESS_DIR" && "$CARGO_BIN" build "${BUILD_ARGS[@]}")
fi

TARGET_DIR="${CARGO_TARGET_DIR:-target}"
case "$TARGET_DIR" in
  /*) ;;
  *) TARGET_DIR="$HARNESS_DIR/$TARGET_DIR" ;;
esac
SRC="$TARGET_DIR/$TARGET/$PROFILE/libworldbase_mobile_ffi.a"
OUT_DIR="${RUST_OUT_DIR:-${BUILT_PRODUCTS_DIR:-.}}"
mkdir -p "$OUT_DIR"
cp "$SRC" "$OUT_DIR/libworldbase_mobile_ffi.a"
echo "==> Rust 静态库已复制到 $OUT_DIR/libworldbase_mobile_ffi.a"
