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
typedef _GetAuthTokenNative =
    Int32 Function(Pointer<Uint8> buffer, Uint32 bufferLen);
typedef _GetAuthTokenDart = int Function(Pointer<Uint8> buffer, int bufferLen);

class HarnessFfiLibraryCandidate {
  const HarnessFfiLibraryCandidate({
    required this.path,
    required this.modifiedAt,
  });

  final String path;
  final DateTime modifiedAt;
}

/// Orders local development artifacts so a fresh release build is not masked
/// by an older debug library (or vice versa).
List<HarnessFfiLibraryCandidate> orderHarnessFfiCandidates(
  Iterable<HarnessFfiLibraryCandidate> candidates,
) {
  final ordered = candidates.toList();
  ordered.sort((left, right) {
    final modified = right.modifiedAt.compareTo(left.modifiedAt);
    return modified != 0 ? modified : left.path.compareTo(right.path);
  });
  return ordered;
}

class _HarnessBindings {
  const _HarnessBindings({
    required this.start,
    required this.stop,
    required this.getAuthToken,
  });

  final _StartDart start;
  final _StopDart stop;
  final _GetAuthTokenDart getAuthToken;
}

class HarnessFfi {
  HarnessFfi._();

  static _HarnessBindings? _bindings;
  static int? _port;
  static String? _authToken;

  /// 进程内 harness 监听端口（未启动为 null）。
  static int? get port => _port;

  /// 每次进程内启动生成的 loopback 鉴权 token（未启动为 null）。
  static String? get authToken => _authToken;

  /// FFI 库是否已加载。
  static bool get loaded => _bindings != null;

  static const _defineLib = String.fromEnvironment('WORLDBASE_FFI_LIB');

  static _HarnessBindings? _load(DynamicLibrary Function() open) {
    try {
      final library = open();
      return _HarnessBindings(
        start: library.lookupFunction<_StartNative, _StartDart>(
          'worldbase_start',
        ),
        stop: library.lookupFunction<_StopNative, _StopDart>('worldbase_stop'),
        getAuthToken: library
            .lookupFunction<_GetAuthTokenNative, _GetAuthTokenDart>(
              'worldbase_get_auth_token',
            ),
      );
    } catch (_) {
      return null;
    }
  }

  static _HarnessBindings? _loadPath(String path) =>
      _load(() => DynamicLibrary.open(path));

  static _HarnessBindings? _resolve() {
    // 1) 显式指定（dart-define / 环境变量）
    final explicit = [
      if (_defineLib.isNotEmpty) _defineLib,
      if (Platform.environment['WORLDBASE_FFI_LIB'] != null)
        Platform.environment['WORLDBASE_FFI_LIB']!,
    ];
    for (final path in explicit) {
      final bindings = _loadPath(path);
      if (bindings != null) return bindings;
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
    final devCandidates = <String, HarnessFfiLibraryCandidate>{};
    for (final root in roots) {
      Directory dir = root;
      for (var i = 0; i < 14; i++) {
        for (final profile in ['debug', 'release']) {
          for (final name in names) {
            final candidate =
                '${dir.path}${Platform.pathSeparator}harness-rs${Platform.pathSeparator}target${Platform.pathSeparator}$profile${Platform.pathSeparator}$name';
            final file = File(candidate).absolute;
            if (!file.existsSync() || devCandidates.containsKey(file.path)) {
              continue;
            }
            DateTime modifiedAt;
            try {
              modifiedAt = file.lastModifiedSync();
            } catch (_) {
              modifiedAt = DateTime.fromMillisecondsSinceEpoch(0);
            }
            devCandidates[file.path] = HarnessFfiLibraryCandidate(
              path: file.path,
              modifiedAt: modifiedAt,
            );
          }
        }
        if (dir.path == dir.parent.path) break;
        dir = dir.parent;
      }
    }
    for (final candidate in orderHarnessFfiCandidates(devCandidates.values)) {
      final bindings = _loadPath(candidate.path);
      if (bindings != null) return bindings;
    }

    // 3) 应用捆绑（打包产物同目录 / Frameworks）
    final exeDir = File(Platform.resolvedExecutable).parent;
    for (final dir in [
      exeDir.path,
      '${exeDir.parent.path}${Platform.pathSeparator}Frameworks',
    ]) {
      for (final name in names) {
        final candidate = '$dir${Platform.pathSeparator}$name';
        final bindings = _loadPath(candidate);
        if (bindings != null) return bindings;
      }
    }

    // 4) 系统库名 / iOS 静态链接
    return _loadPath('libworldbase_mobile_ffi.dylib') ??
        _loadPath('libworldbase_mobile_ffi.so') ??
        _load(DynamicLibrary.process);
  }

  static String? _readAuthToken(_HarnessBindings bindings) {
    final required = bindings.getAuthToken(nullptr, 0);
    if (required <= 1 || required > 4096) return null;
    final buffer = malloc<Uint8>(required);
    try {
      final written = bindings.getAuthToken(buffer, required);
      if (written != required) return null;
      final token = buffer.cast<Utf8>().toDartString();
      return token.isEmpty ? null : token;
    } catch (_) {
      return null;
    } finally {
      malloc.free(buffer);
    }
  }

  /// 进程内启动 harness。返回端口；>0 成功；-1 失败。
  /// 新版 native 库在已运行时返回同一正端口；仍兼容旧版的 -2 返回值。
  static int? start({String? dataDir, int portHint = 0}) {
    final bindings = _bindings ?? _resolve();
    if (bindings == null) return null;
    _bindings = bindings;

    final Pointer<Uint8> dirPtr = (dataDir == null || dataDir.isEmpty)
        ? nullptr
        : dataDir.toNativeUtf8().cast<Uint8>();
    try {
      final port = bindings.start(dirPtr, portHint);
      if (port > 0 || port == -2) {
        final token = _readAuthToken(bindings);
        if (token == null) {
          if (port > 0) bindings.stop();
          _port = null;
          _authToken = null;
          return null;
        }
        _authToken = token;
      }
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
    _bindings?.stop();
    _port = null;
    _authToken = null;
  }
}
