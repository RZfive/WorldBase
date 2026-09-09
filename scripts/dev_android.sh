#!/bin/bash
# 启动 Android 端（模拟器或真机）：
#   1. 交叉编译 Rust cdylib (aarch64-v8a) → jniLibs
#   2. 无在线设备时自动启动 AVD（ANDROID_AVD，默认 Medium_Phone_API_36.1）
#   3. flutter run
# 依赖: Android Studio(JBR/Java)、Android SDK/NDK、rustup
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_SDK_DIR="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-${ANDROID_SDK:-$HOME/Library/Android/sdk}}}"
export ANDROID_SDK_ROOT="$ANDROID_SDK_DIR"
if [ -z "${JAVA_HOME:-}" ] && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
JAVA_BIN_DIR=""
if [ -n "${JAVA_HOME:-}" ]; then
  JAVA_BIN_DIR="$JAVA_HOME/bin:"
fi
export PATH="$ANDROID_SDK_DIR/platform-tools:$ANDROID_SDK_DIR/emulator:$ANDROID_SDK_DIR/cmdline-tools/latest/bin:${JAVA_BIN_DIR}$PATH"
ABI="${ANDROID_ABI:-arm64-v8a}"
case "$ABI" in
  arm64-v8a) TARGET="aarch64-linux-android" ;;
  armeabi-v7a) TARGET="armv7-linux-androideabi" ;;
  x86_64) TARGET="x86_64-linux-android" ;;
  x86) TARGET="i686-linux-android" ;;
  *) echo "不支持的 ANDROID_ABI: $ABI" >&2; exit 1 ;;
esac

echo "==> [1/3] 交叉编译 Rust cdylib ($TARGET)"
ANDROID_TARGET="$TARGET" bash "$ROOT/scripts/build_rust_android.sh"

JNI_DIR="$ROOT/apps/mobile/android/app/src/main/jniLibs/$ABI"
TARGET_DIR="${CARGO_TARGET_DIR:-target}"
case "$TARGET_DIR" in
  /*) ;;
  *) TARGET_DIR="$ROOT/harness-rs/$TARGET_DIR" ;;
esac
RUST_LIB="$TARGET_DIR/$TARGET/release/libworldbase_mobile_ffi.so"
mkdir -p "$JNI_DIR"
cp "$RUST_LIB" "$JNI_DIR/"
echo "==> [2/3] .so 已就位 $JNI_DIR"

echo "==> [3/3] 启动设备 + flutter run"
DEVICE="$(adb devices | awk '/\tdevice$/{print $1; exit}')"
if [ -z "$DEVICE" ]; then
  AVD="${ANDROID_AVD:-Medium_Phone_API_36.1}"
  echo "    无在线设备，启动模拟器 $AVD"
  "$ANDROID_SDK_DIR/emulator/emulator" -avd "$AVD" -no-snapshot-save > /tmp/wb-android-emulator.log 2>&1 &
  adb wait-for-device
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    sleep 2
  done
  DEVICE="$(adb devices | awk '/\tdevice$/{print $1; exit}')"
fi
echo "    设备: $DEVICE"

cd "$ROOT/apps/mobile"
exec flutter run -d "$DEVICE"
