/// harness 进程内 FFI 绑定：加载 Rust 动态库，进程内启动完整 harness
/// （tokio runtime + loopback HTTP/WS），返回实际端口供 WS 客户端连接。
///
/// 对齐架构文档 §8：core 编译进 App、FFI 进程内、能力协商在握手层完成。
/// iOS 为静态库（DynamicLibrary.process()），macOS/Android 为动态库。
library;

import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

typedef _StartNative = Int32 Function(Pointer<Uint8> dataDir, Uint32 portHint);
typedef _StartDart = int Function(Pointer<Uint8> dataDir, int portHint);
typedef _StopNative = Void Function();
typedef _StopDart = void Function();

class HarnessFfi {
  HarnessFfi._();

  static DynamicLibrary? _lib;
  static _StopDart? _stopFn;
  static int? _port;

  /// 进程内 harness 监听端口（未启动为 null）。
  static int? get port => _port;

  /// FFI 库是否已加载。
  static bool get loaded => _lib != null;

  static const _defineLib = String.fromEnvironment('WORLDBASE_FFI_LIB');

  static DynamicLibrary? _resolve() {
    // 1) 显式指定（dart-define / 环境变量）
    final explicit = [
      if (_defineLib.isNotEmpty) _defineLib,
      if (Platform.environment['WORLDBASE_FFI_LIB'] != null)
        Platform.environment['WORLDBASE_FFI_LIB']!,
    ];
    for (final path in explicit) {
      if (File(path).existsSync()) return DynamicLibrary.open(path);
    }

    // 2) 开发模式：从 cwd / 可执行文件位置向上找 monorepo 内的构建产物
    final roots = <Directory>[
      Directory.current.absolute,
      File(Platform.resolvedExecutable).parent.absolute,
    ];
    final names = [
      'libworldbase_mobile_ffi.dylib',
      'libworldbase_mobile_ffi.so',
    ];
    for (final root in roots) {
      Directory dir = root;
      for (var i = 0; i < 14; i++) {
        for (final profile in ['debug', 'release']) {
          for (final name in names) {
            final candidate =
                '${dir.path}${Platform.pathSeparator}harness-rs${Platform.pathSeparator}target${Platform.pathSeparator}$profile${Platform.pathSeparator}$name';
            if (File(candidate).existsSync()) return DynamicLibrary.open(candidate);
          }
        }
        if (dir.path == dir.parent.path) break;
        dir = dir.parent;
      }
    }

    // 3) 应用捆绑（打包产物同目录 / Frameworks）
    final exeDir = File(Platform.resolvedExecutable).parent;
    for (final dir in [
      exeDir.path,
      '${exeDir.parent.path}${Platform.pathSeparator}Frameworks',
    ]) {
      for (final name in names) {
        final candidate = '$dir${Platform.pathSeparator}$name';
        if (File(candidate).existsSync()) return DynamicLibrary.open(candidate);
      }
    }

    // 4) 系统库名 / iOS 静态链接
    try {
      return DynamicLibrary.open('libworldbase_mobile_ffi.dylib');
    } catch (_) {}
    try {
      return DynamicLibrary.open('libworldbase_mobile_ffi.so');
    } catch (_) {}
    try {
      return DynamicLibrary.process();
    } catch (_) {}
    return null;
  }

  /// 进程内启动 harness。返回端口；>0 成功；-1 失败；-2 已在运行。
  /// 已在运行时可用 [lastPort] 取回端口。
  static int? start({String? dataDir, int portHint = 0}) {
    final lib = _lib ??= _resolve();
    if (lib == null) return null;
    final startFn = lib.lookupFunction<_StartNative, _StartDart>('worldbase_start');
    _stopFn ??= lib.lookupFunction<_StopNative, _StopDart>('worldbase_stop');

    final Pointer<Uint8> dirPtr =
        (dataDir == null || dataDir.isEmpty) ? nullptr : dataDir.toNativeUtf8().cast<Uint8>();
    try {
      final port = startFn(dirPtr, portHint);
      _port = port > 0 ? port : _port;
      return port;
    } catch (_) {
      return null;
    } finally {
      if (dirPtr != nullptr) malloc.free(dirPtr);
    }
  }

  /// 停止进程内 harness。
  static void stop() {
    _stopFn?.call();
    _port = null;
  }
}
