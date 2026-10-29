#!/usr/bin/env bash
# Install the Android NDK required by Flutter, retrying corrupted or
# incomplete downloads. GitHub-hosted runners occasionally receive a
# truncated NDK archive; sdkmanager caches it, so every later attempt fails
# with "Error on ZipFile unknown archive" until the partial download and the
# half-extracted NDK directory are removed.

set -euo pipefail

NDK_VERSION="${ANDROID_NDK_VERSION:-28.2.13676358}"
ATTEMPTS="${ANDROID_NDK_INSTALL_ATTEMPTS:-3}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

resolve_sdk_root() {
  local candidate=""
  local sdk_var=""
  local local_properties="$ROOT/apps/mobile/android/local.properties"

  for sdk_var in ANDROID_SDK_ROOT ANDROID_HOME ANDROID_SDK; do
    candidate="${!sdk_var:-}"
    if [ -n "$candidate" ] && [ -d "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if [ -f "$local_properties" ]; then
    candidate="$(sed -n 's/^sdk\.dir=//p' "$local_properties" | head -n 1)"
    if [ -n "$candidate" ] && [ -d "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk" /usr/local/lib/android/sdk; do
    if [ -d "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

SDK_ROOT="$(resolve_sdk_root || true)"
if [ -z "$SDK_ROOT" ]; then
  echo "Android SDK not found. Set ANDROID_SDK_ROOT or ANDROID_HOME." >&2
  exit 1
fi

SDKMANAGER="${ANDROID_SDKMANAGER:-$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager}"
NDK_DIR="$SDK_ROOT/ndk/$NDK_VERSION"

is_installed() {
  [ -f "$NDK_DIR/source.properties" ] &&
    [ -x "$NDK_DIR/ndk-build" ] &&
    [ -d "$NDK_DIR/toolchains/llvm/prebuilt" ]
}

clean_partial() {
  rm -rf "$SDK_ROOT/.temp" "$SDK_ROOT/.downloadIntermediates" "$NDK_DIR"
}

is_retryable() {
  printf '%s' "$1" | grep -Eq \
    'Error on ZipFile unknown archive|Not in GZIP format|This download could not be finalized|checksum|Connection timed out|Read timed out|Failed to download|SSL|TLS'
}

if is_installed; then
  echo "Android NDK $NDK_VERSION is already installed at $NDK_DIR"
  exit 0
fi

for attempt in $(seq 1 "$ATTEMPTS"); do
  echo "Installing Android NDK $NDK_VERSION (attempt $attempt/$ATTEMPTS)"
  set +e
  output="$("$SDKMANAGER" --install "ndk;$NDK_VERSION" 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$output"

  if [ "$status" -eq 0 ] && is_installed; then
    echo "Android NDK $NDK_VERSION installed at $NDK_DIR"
    exit 0
  fi

  if [ "$status" -ne 0 ] && ! is_retryable "$output"; then
    echo "Android NDK install failed with an unrelated error; not retrying." >&2
    exit "$status"
  fi

  echo "NDK download was incomplete or corrupted; clearing partial SDK files." >&2
  clean_partial
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep $((attempt * 5))
  fi
done

echo "Failed to install Android NDK $NDK_VERSION after $ATTEMPTS attempts." >&2
exit 1
