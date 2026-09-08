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

Uri _loopbackUri(int port, String scheme, String path, {String? token}) => Uri(
  scheme: scheme,
  host: '127.0.0.1',
  port: port,
  path: path,
  queryParameters: token == null ? null : {'token': token},
);

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
    final token = HarnessFfi.authToken;
    expect(token, isNotNull);
    expect(token, hasLength(64));

    // 2) 重复启动返回同一端口，让 hot restart 后的新 isolate 可恢复连接
    final again = HarnessFfi.start(dataDir: homeDir.path);
    expect(again, port);
    expect(HarnessFfi.port, port, reason: '重复启动应复用已记录端口');
    expect(HarnessFfi.authToken, token, reason: '重复启动应保留当前 token');

    // 3) 所有 loopback 路由都必须拒绝匿名/错误 token（含 WS upgrade）
    final probe = HttpClient();
    Future<int> protectedStatus(String path, {String? suppliedToken}) async {
      final uri = _loopbackUri(port, 'http', path, token: suppliedToken);
      final request = path == '/rpc'
          ? await probe.postUrl(uri)
          : await probe.getUrl(uri);
      if (path == '/ws') {
        request.headers
          ..set(HttpHeaders.connectionHeader, 'Upgrade')
          ..set(HttpHeaders.upgradeHeader, 'websocket')
          ..set('Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ==')
          ..set('Sec-WebSocket-Version', '13');
      }
      final response = await request.close();
      await response.drain<void>();
      return response.statusCode;
    }

    for (final path in [
      '/health',
      '/rpc',
      '/ws',
      '/studio/missing',
      '/lightapp/missing',
    ]) {
      expect(await protectedStatus(path), HttpStatus.unauthorized);
      expect(
        await protectedStatus(path, suppliedToken: 'wrong-token'),
        HttpStatus.unauthorized,
      );
    }

    // 4) 正确 token 可访问 health
    var ready = false;
    for (var i = 0; i < 50; i++) {
      try {
        final req = await probe.getUrl(
          _loopbackUri(port, 'http', '/health', token: token),
        );
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

    // 5) WS 握手（移动端 capabilities）
    final ws = WebSocketChannel.connect(
      _loopbackUri(port, 'ws', '/ws', token: token),
    );
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
          (deltaText[frame['streamId']] ??= StringBuffer()).write(
            frame['text'] ?? '',
          );
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
      ws.sink.add(
        jsonEncode({
          'jsonrpc': '2.0',
          'id': id,
          'method': method,
          'params': params,
        }),
      );
      return completer.future.timeout(const Duration(seconds: 20));
    }

    // Deliberately negotiate fewer capabilities than the transport bootstrap
    // so the follow-up request proves that context is connection-scoped.
    final init = await call('initialize', {
      'protocolVersion': '1.0',
      'capabilities': {
        'platform': 'mobile-ffi',
        'features': ['lightweight_runtime', 'interactive'],
        'excludes': ['subprocess', 'port_binding', 'webhook_receiver'],
      },
    });
    expect(init['protocolVersion'], '1.0');
    final availableTools = init['availableTools'] as List;
    final tools = availableTools.map((t) => (t as Map)['name']).toSet();
    expect(
      tools,
      hasLength(48),
      reason:
          'without webview automation only the mobile executable surface remains',
    );
    expect(tools, contains('read_file'));
    expect(
      tools,
      contains('ask_user'),
      reason:
          'interactive hosts can answer ask_user without webview automation',
    );
    expect(
      tools,
      contains('create_scheduled_task'),
      reason: 'FFI must advertise the canonical structured scheduler contract',
    );
    expect(tools, contains('schedule_create'));
    expect(tools, containsAll(['schedule_list', 'schedule_delete']));
    expect(tools, isNot(contains('execute_command')), reason: 'FFI 移动端能力协商过滤');
    expect(tools, isNot(contains('read_current_page')));
    for (final unavailable in [
      'local_read_file',
      'local_write_file',
      'local_run_command',
      'list_workspace_files',
      'read_workspace_file',
      'write_workspace_file',
      'get_workspace_command_status',
      'list_projects',
      'read_project_file',
      'write_project_file',
      'get_project_command_status',
      'get_project_status',
      'get_task_status',
      'query_project_database',
      'analyze_project_data',
    ]) {
      expect(tools, isNot(contains(unavailable)));
    }
    final mobileMcpInstaller = availableTools.cast<Map>().singleWhere(
      (tool) => tool['name'] == 'install_mcp_server',
    );
    final mcpProperties =
        (mobileMcpInstaller['inputSchema'] as Map)['properties'] as Map;
    expect((mcpProperties['transport'] as Map)['enum'], [
      'streamable-http',
      'sse',
    ]);
    expect(mcpProperties.containsKey('command'), isFalse);
    expect(mcpProperties.containsKey('overwrite_existing'), isFalse);
    final listed = await call('tool.list', {});
    final listedTools = (listed['tools'] as List)
        .map((tool) => (tool as Map)['name'])
        .toSet();
    expect(
      listedTools,
      tools,
      reason: 'tool.list must preserve the negotiated mobile surface',
    );
    expect(
      listedTools,
      isNot(contains('read_current_page')),
      reason: 'tool.list 必须继续使用该 WebSocket 的协商能力',
    );

    final escalation = await call('initialize', {
      'protocolVersion': '1.0',
      'capabilities': {
        'platform': 'desktop',
        'features': [
          'subprocess',
          'port_binding',
          'webhook_receiver',
          'lightweight_runtime',
          'interactive',
        ],
        'excludes': <String>[],
      },
    });
    expect(escalation['availableDomains'], isNot(contains('desktop')));
    final escalatedTools = (escalation['availableTools'] as List)
        .map((tool) => (tool as Map)['name'])
        .toSet();
    expect(escalatedTools, isNot(contains('execute_command')));
    expect(escalatedTools, isNot(contains('create_project')));

    // 6) 对话（mock provider 回显 → 流式事件）
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
    expect(
      deltaText[streamId].toString(),
      contains('FFI 进程内对话'),
      reason: '流式增量应通过进程内 loopback 到达',
    );

    // 7) 持久化落在 FFI 指定的数据目录
    final messages = await call('conversation.messages', {'id': conv['id']});
    expect((messages['messages'] as List).length, greaterThanOrEqualTo(2));
    final dbFile = File('${homeDir.path}/app.sqlite');
    expect(dbFile.existsSync(), isTrue, reason: '数据应写入 FFI 指定目录');

    await ws.sink.close();

    // 8) 停止进程内 harness → 端口不可达，token 同步清空
    HarnessFfi.stop();
    expect(HarnessFfi.authToken, isNull);
    await Future<void>.delayed(const Duration(milliseconds: 300));
    final stoppedProbe = HttpClient();
    var stopped = true;
    try {
      final req = await stoppedProbe.getUrl(
        _loopbackUri(port, 'http', '/health', token: token),
      );
      final resp = await req.close();
      stopped = resp.statusCode != 200;
    } catch (_) {
      stopped = true;
    }
    stoppedProbe.close(force: true);
    expect(stopped, isTrue, reason: 'worldbase_stop 后进程内服务应停止');

    // 9) 停止后可重启；新实例必须轮换 token，旧 token 不得恢复访问
    final restarted = HarnessFfi.start(dataDir: homeDir.path);
    expect(restarted, isNotNull);
    expect(restarted, greaterThan(0));
    final restartedToken = HarnessFfi.authToken;
    expect(restartedToken, isNotNull);
    expect(restartedToken, isNot(token));

    final restartProbe = HttpClient();
    final staleReq = await restartProbe.getUrl(
      _loopbackUri(restarted!, 'http', '/health', token: token),
    );
    final staleResp = await staleReq.close();
    await staleResp.drain<void>();
    expect(staleResp.statusCode, HttpStatus.unauthorized);

    final freshReq = await restartProbe.getUrl(
      _loopbackUri(restarted, 'http', '/health', token: restartedToken),
    );
    final freshResp = await freshReq.close();
    await freshResp.drain<void>();
    expect(freshResp.statusCode, HttpStatus.ok);
    restartProbe.close(force: true);
    HarnessFfi.stop();
  }, timeout: const Timeout(Duration(seconds: 60)));
}
