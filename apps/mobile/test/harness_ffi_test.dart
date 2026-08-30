/// FFI 端到端测试：加载 Rust 动态库，进程内启动完整 harness，
/// 经 loopback WS 完成 握手 → 对话（流式） → 中止 → 停止 全流程。
/// 这就是移动端「内部 harness 通过 FFI 连接」的直接验证。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'package:worldbase_mobile/core/harness_ffi.dart';

void main() {
  late Directory homeDir;

  setUpAll(() async {
    homeDir = await Directory.systemTemp.createTemp('worldbase-ffi-test');
  });

  tearDownAll(() async {
    HarnessFfi.stop();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    if (await homeDir.exists()) {
      await homeDir.delete(recursive: true).catchError((_) => homeDir);
    }
  });

  test('FFI 进程内启动 → WS 全链路 → 停止', () async {
    // 1) 进程内启动
    final started = HarnessFfi.start(dataDir: homeDir.path);
    expect(started, isNotNull, reason: 'FFI 库应能解析并加载');
    final port = started!;
    expect(port, greaterThan(0), reason: 'worldbase_start 应返回实际监听端口');

    // 2) 重复启动返回 -2（单实例）
    final again = HarnessFfi.start(dataDir: homeDir.path);
    expect(again, -2);
    expect(HarnessFfi.port, port, reason: '重复启动应复用已记录端口');

    // 3) 等 loopback 端口就绪
    final probe = HttpClient();
    var ready = false;
    for (var i = 0; i < 50; i++) {
      try {
        final req = await probe.getUrl(Uri.parse('http://127.0.0.1:$port/health'));
        final resp = await req.close();
        if (resp.statusCode == 200) {
          ready = true;
          break;
        }
      } catch (_) {}
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    probe.close();
    expect(ready, isTrue, reason: '进程内 harness 应在 loopback 提供服务');

    // 4) WS 握手（移动端 capabilities）
    final ws = WebSocketChannel.connect(Uri.parse('ws://127.0.0.1:$port/ws'));
    await ws.ready;
    final pending = <String, Completer<dynamic>>{};
    var nextId = 1;
    final doneWaiters = <String, Completer<void>>{};
    final doneStreams = <String>{};
    final deltaText = <String, StringBuffer>{};

    ws.stream.listen((raw) {
      final msg = jsonDecode(raw as String) as Map<String, dynamic>;
      if (msg.containsKey('id') && msg.containsKey('result')) {
        pending.remove(msg['id'].toString())?.complete(msg['result']);
      } else if (msg['method'] == 'event') {
        final frame = (msg['params'] as Map).cast<String, dynamic>();
        if (frame['kind'] == 'delta') {
          (deltaText[frame['streamId']] ??= StringBuffer()).write(frame['text'] ?? '');
        }
        if (frame['kind'] == 'done' || frame['kind'] == 'error') {
          doneStreams.add(frame['streamId'] as String);
          doneWaiters.remove(frame['streamId'])?.complete();
        }
      }
    });

    Future<dynamic> call(String method, Map<String, dynamic> params) {
      final id = nextId++;
      final completer = Completer<dynamic>();
      pending['$id'] = completer;
      ws.sink.add(jsonEncode({'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params}));
      return completer.future.timeout(const Duration(seconds: 20));
    }

    final init = await call('initialize', {
      'protocolVersion': '1.0',
      'capabilities': {
        'platform': 'mobile-ffi',
        'features': ['lightweight_runtime', 'webview_automation'],
        'excludes': ['subprocess', 'port_binding', 'webhook_receiver'],
      },
    });
    expect(init['protocolVersion'], '1.0');
    final tools = (init['availableTools'] as List).map((t) => (t as Map)['name']).toSet();
    expect(tools, contains('read_file'));
    expect(tools, isNot(contains('execute_command')), reason: 'FFI 移动端能力协商过滤');

    // 5) 对话（mock provider 回显 → 流式事件）
    final conv = await call('conversation.create', {'title': 'FFI E2E'});
    final send = await call('chat.send', {
      'conversationId': conv['id'],
      'text': 'FFI 进程内对话',
    });
    final streamId = send['streamId'] as String;
    if (!doneStreams.contains(streamId)) {
      await doneWaiters
          .putIfAbsent(streamId, () => Completer<void>())
          .future
          .timeout(const Duration(seconds: 15));
    }
    expect(deltaText[streamId].toString(), contains('FFI 进程内对话'),
        reason: '流式增量应通过进程内 loopback 到达');

    // 6) 持久化落在 FFI 指定的数据目录
    final messages = await call('conversation.messages', {'id': conv['id']});
    expect((messages['messages'] as List).length, greaterThanOrEqualTo(2));
    final dbFile = File('${homeDir.path}/app.sqlite');
    expect(dbFile.existsSync(), isTrue, reason: '数据应写入 FFI 指定目录');

    await ws.sink.close();

    // 7) 停止进程内 harness → 端口不可达
    HarnessFfi.stop();
    await Future<void>.delayed(const Duration(milliseconds: 300));
    var stopped = true;
    try {
      final req = await HttpClient().getUrl(Uri.parse('http://127.0.0.1:$port/health'));
      final resp = await req.close();
      stopped = resp.statusCode != 200;
    } catch (_) {
      stopped = true;
    }
    expect(stopped, isTrue, reason: 'worldbase_stop 后进程内服务应停止');
  }, timeout: const Timeout(Duration(seconds: 60)));
}
