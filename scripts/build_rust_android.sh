#!/usr/bin/env bash
# Build the mobile FFI library for an Android Rust target.
#
# The NDK is resolved from ANDROID_NDK_HOME/ANDROID_NDK_ROOT first, then from
# ANDROID_SDK_ROOT/ANDROID_HOME/ANDROID_SDK (or the conventional SDK location).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_DIR="$ROOT/harness-rs"
MANIFEST="$HARNESS_DIR/Cargo.toml"
TARGET="${ANDROID_TARGET:-aarch64-linux-android}"
API="${ANDROID_API:-21}"

case "$TARGET" in
  aarch64-linux-android) CLANG_TARGET="aarch64-linux-android" ;;
  armv7-linux-androideabi) CLANG_TARGET="armv7a-linux-androideabi" ;;
  x86_64-linux-android) CLANG_TARGET="x86_64-linux-android" ;;
  i686-linux-android) CLANG_TARGET="i686-linux-android" ;;
  *)
    echo "Unsupported Android Rust target: $TARGET" >&2
    exit 1
    ;;
esac

resolve_ndk() {
  local candidate=""
  local sdk_base=""
  local sdk_root=""
  local sdk_var=""
  local local_properties="$ROOT/apps/mobile/android/local.properties"

  for candidate in "${ANDROID_NDK_HOME:-}" "${ANDROID_NDK_ROOT:-}"; do
    if [ -n "$candidate" ] && [ -d "$candidate/toolchains/llvm/prebuilt" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  for sdk_var in ANDROID_SDK_ROOT ANDROID_HOME ANDROID_SDK; do
    candidate="${!sdk_var:-}"
    if [ -n "$candidate" ] && [ -d "$candidate" ]; then
      sdk_root="$candidate"
      break
    fi
  done

  if [ -z "$sdk_root" ] && [ -f "$local_properties" ]; then
    candidate="$(sed -n 's/^sdk\.dir=//p' "$local_properties" | head -n 1)"
    if [ -n "$candidate" ] && [ -d "$candidate" ]; then
      sdk_root="$candidate"
    fi
  fi

  if [ -z "$sdk_root" ]; then
    for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
      if [ -d "$candidate" ]; then
        sdk_root="$candidate"
        break
      fi
    done
  fi

  if [ -z "$sdk_root" ]; then
    return 1
  fi
  sdk_base="$sdk_root"

  if [ -n "${ANDROID_NDK_VERSION:-}" ]; then
    candidate="$sdk_root/ndk/$ANDROID_NDK_VERSION"
    if [ -d "$candidate/toolchains/llvm/prebuilt" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
    echo "ANDROID_NDK_VERSION=$ANDROID_NDK_VERSION is not installed under $sdk_root/ndk" >&2
    return 1
  fi

  # Bash expands versioned NDK directories in lexical order; use the newest
  # installed modern NDK unless the caller selected one explicitly.
  local installed_ndks=()
  shopt -s nullglob
  installed_ndks=("$sdk_root"/ndk/*)
  shopt -u nullglob
  for candidate in "${installed_ndks[@]}"; do
    if [ -d "$candidate/toolchains/llvm/prebuilt" ]; then
      sdk_root="$candidate"
    fi
  done
  if [ -d "$sdk_root/toolchains/llvm/prebuilt" ]; then
    printf '%s\n' "$sdk_root"
    return 0
  fi

  candidate="$sdk_base/ndk-bundle"
  if [ -d "$candidate/toolchains/llvm/prebuilt" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  return 1
}

NDK_ROOT="$(resolve_ndk || true)"
if [ -z "$NDK_ROOT" ]; then
  echo "Android NDK not found. Set ANDROID_NDK_HOME or ANDROID_SDK_ROOT." >&2
  exit 1
fi

CLANG_NAME="${CLANG_TARGET}${API}-clang"
TOOLCHAIN_BIN=""
shopt -s nullglob
for candidate in "$NDK_ROOT"/toolchains/llvm/prebuilt/*/bin; do
  if [ -x "$candidate/$CLANG_NAME" ]; then
    TOOLCHAIN_BIN="$candidate"
    break
  fi
done
shopt -u nullglob

if [ -z "$TOOLCHAIN_BIN" ]; then
  echo "NDK linker $CLANG_NAME not found under $NDK_ROOT/toolchains/llvm/prebuilt" >&2
  exit 1
fi

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
  echo "cargo not found. Install a Rust toolchain with rustup." >&2
  exit 1
fi

RUSTC_BIN="${RUSTC:-}"
if [ -z "$RUSTC_BIN" ] && [ -n "$RUSTUP_BIN" ]; then
  RUSTC_BIN="$("$RUSTUP_BIN" which rustc 2>/dev/null || true)"
fi

TARGET_KEY="$(printf '%s' "$TARGET" | tr '[:lower:]-' '[:upper:]_')"
TARGET_VAR="${TARGET//-/_}"
BUILD_ENV=(
  "CARGO_TARGET_${TARGET_KEY}_LINKER=$TOOLCHAIN_BIN/$CLANG_NAME"
  "CC_${TARGET}=$TOOLCHAIN_BIN/$CLANG_NAME"
  "CC_${TARGET_VAR}=$TOOLCHAIN_BIN/$CLANG_NAME"
  "AR_${TARGET}=$TOOLCHAIN_BIN/llvm-ar"
  "AR_${TARGET_VAR}=$TOOLCHAIN_BIN/llvm-ar"
)
if [ -n "$RUSTC_BIN" ]; then
  BUILD_ENV+=("RUSTC=$RUSTC_BIN")
fi

echo "==> Building worldbase-mobile-ffi for $TARGET with $(basename "$NDK_ROOT") (API $API)"
(
  cd "$HARNESS_DIR"
  env "${BUILD_ENV[@]}" "$CARGO_BIN" build \
    --manifest-path "$MANIFEST" \
    -p worldbase-mobile-ffi \
    --target "$TARGET" \
    --release \
    --no-default-features \
    "$@"
)
