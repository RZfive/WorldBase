#!/bin/bash
# 启动 Android 端（模拟器或真机）：
#   1. 交叉编译 Rust cdylib (aarch64-v8a) → jniLibs
#   2. 无在线设备时自动启动 AVD（ANDROID_AVD，默认 Medium_Phone_API_36.1）
#   3. flutter run
# 依赖: Android Studio(JBR/Java)、ANDROID_SDK(默认 ~/Library/Android/sdk)、rustup
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_SDK="${ANDROID_SDK:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export PATH="$ANDROID_SDK/platform-tools:$ANDROID_SDK/emulator:$ANDROID_SDK/cmdline-tools/latest/bin:$JAVA_HOME/bin:$PATH"
ABI="${ANDROID_ABI:-arm64-v8a}"
TARGET="aarch64-linux-android"

RUSTC_BIN="$(ls "$HOME"/.rustup/toolchains/*/bin/rustc 2>/dev/null | head -1 || true)"
CARGO_BIN="$(ls "$HOME"/.rustup/toolchains/*/bin/cargo 2>/dev/null | head -1 || true)"
[ -z "$CARGO_BIN" ] && { echo "未找到 cargo（安装 rustup）" >&2; exit 1; }
[ -n "$RUSTC_BIN" ] && export RUSTC="$RUSTC_BIN"

echo "==> [1/3] 交叉编译 Rust cdylib ($TARGET)"
( cd "$ROOT/harness-rs" && "$CARGO_BIN" build -p worldbase-mobile-ffi --target "$TARGET" --release )

JNI_DIR="$ROOT/apps/mobile/android/app/src/main/jniLibs/$ABI"
mkdir -p "$JNI_DIR"
cp "$ROOT/harness-rs/target/$TARGET/release/libworldbase_mobile_ffi.so" "$JNI_DIR/"
echo "==> [2/3] .so 已就位 $JNI_DIR"

echo "==> [3/3] 启动设备 + flutter run"
DEVICE="$(adb devices | awk '/\tdevice$/{print $1; exit}')"
if [ -z "$DEVICE" ]; then
  AVD="${ANDROID_AVD:-Medium_Phone_API_36.1}"
  echo "    无在线设备，启动模拟器 $AVD"
  "$ANDROID_SDK/emulator/emulator" -avd "$AVD" -no-snapshot-save > /tmp/wb-android-emulator.log 2>&1 &
  adb wait-for-device
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    sleep 2
  done
  DEVICE="$(adb devices | awk '/\tdevice$/{print $1; exit}')"
fi
echo "    设备: $DEVICE"

cd "$ROOT/apps/mobile"
exec flutter run -d "$DEVICE"
