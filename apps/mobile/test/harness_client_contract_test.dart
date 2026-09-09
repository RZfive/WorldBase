import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:worldbase_mobile/core/harness_client.dart';

void main() {
  test('chat reasoning fields are opt-in', () {
    final disabled = buildChatSendParams(
      conversationId: 'conversation',
      text: 'hello',
      reasoningEffort: 'max',
    );
    expect(disabled['enableThinking'], isFalse);
    expect(disabled, isNot(contains('reasoningEffort')));

    final enabled = buildChatSendParams(
      conversationId: 'conversation',
      text: 'hello',
      enableThinking: true,
      reasoningEffort: 'max',
    );
    expect(enabled['enableThinking'], isTrue);
    expect(enabled['reasoningEffort'], 'max');
  });

  test('disabled web search denies Node and Rust web tools', () {
    final params = buildChatSendParams(
      conversationId: 'conversation',
      text: 'hello',
      webSearch: false,
    );

    expect(params['deniedToolNames'], [
      'web_search',
      'fetch_webpage',
      'web_fetch',
    ]);
  });

  test('RPC sanitization replaces only orphan UTF-16 surrogates', () {
    final orphanHigh = String.fromCharCode(0xD800);
    final orphanLow = String.fromCharCode(0xDFFF);
    final emoji = String.fromCharCodes([0xD83D, 0xDE00]);
    final sanitized =
        sanitizeJsonForTransport({
              'key$orphanHigh': [
                'before$orphanLow-after',
                emoji,
                {'nested': orphanHigh},
              ],
            })
            as Map;

    expect(sanitized.containsKey('key\uFFFD'), isTrue);
    final values = sanitized['key\uFFFD'] as List;
    expect(values[0], 'before\uFFFD-after');
    expect(values[1], emoji);
    expect((values[2] as Map)['nested'], '\uFFFD');
    expect(() => jsonEncode(sanitized), returnsNormally);
  });

  test('thinking delta frames preserve their stream payload', () {
    final frame = EventFrame.fromJson({
      'streamId': 'stream-thinking',
      'seq': 7,
      'ts': '2026-09-04T00:00:00Z',
      'kind': 'thinking_delta',
      'text': '分析中',
    });

    expect(frame.kind, 'thinking_delta');
    expect(frame.data['text'], '分析中');
  });

  test('tool descriptors retain the Rust input schema and permission', () {
    final descriptor = ToolDescriptor.fromJson({
      'name': 'read_file',
      'description': 'Read a file',
      'domain': 'core',
      'permission': 'allow',
      'inputSchema': {
        'type': 'object',
        'properties': {
          'path': {'type': 'string'},
        },
        'required': ['path'],
      },
    });

    expect(descriptor.inputSchema['properties'], isA<Map>());
    expect(
      (descriptor.inputSchema['properties'] as Map)['path']['type'],
      'string',
    );
    expect(descriptor.permission, 'allow');
    expect(descriptor.toJson()['inputSchema'], descriptor.inputSchema);
  });

  test('tool descriptors accept legacy snake_case schema keys', () {
    final descriptor = ToolDescriptor.fromJson({
      'name': 'read_file',
      'input_schema': {
        'type': 'object',
        'required': ['path'],
      },
    });

    expect(descriptor.inputSchema['required'], ['path']);
  });

  test('document selections accept both key styles and round-trip', () {
    final selection = DocumentSelection.fromJson({
      'id': 'region-1',
      'artifact_id': 'artifact-1',
      'node_ids': ['node-1', 'node-2'],
      'label': '重点',
      'color': '#ef4444',
      'excerpt': '选中的内容',
      'created_at': '2026-09-05T00:00:00Z',
    });

    expect(selection.id, 'region-1');
    expect(selection.artifactId, 'artifact-1');
    expect(selection.nodeIds, ['node-1', 'node-2']);
    expect(selection.label, '重点');
    expect(selection.excerpt, '选中的内容');
    expect(selection.createdAt, '2026-09-05T00:00:00Z');
    expect(selection.toJson(), {
      'id': 'region-1',
      'artifactId': 'artifact-1',
      'nodeIds': ['node-1', 'node-2'],
      'label': '重点',
      'color': '#ef4444',
      'excerpt': '选中的内容',
      'createdAt': '2026-09-05T00:00:00Z',
    });
  });

  test('uncorrelated protocol errors fail pending RPCs immediately', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final sockets = <WebSocket>[];
    final serverDone = Completer<void>();
    server.listen((request) async {
      expect(request.uri.queryParameters['token'], 'contract-test-token');
      final socket = await WebSocketTransformer.upgrade(request);
      sockets.add(socket);
      socket.listen(
        (raw) {
          final request = jsonDecode(raw as String) as Map<String, dynamic>;
          if (request['method'] == 'initialize') {
            socket.add(
              jsonEncode({
                'jsonrpc': '2.0',
                'id': request['id'],
                'result': {
                  'protocolVersion': '1.0',
                  'serverVersion': 'test',
                  'availableTools': <dynamic>[],
                  'availableDomains': <dynamic>[],
                },
              }),
            );
            return;
          }
          socket.add(
            jsonEncode({
              'jsonrpc': '2.0',
              'id': null,
              'error': {'code': -32600, 'message': 'invalid request envelope'},
            }),
          );
        },
        onDone: () {
          if (!serverDone.isCompleted) serverDone.complete();
        },
      );
    });

    final client = HarnessClient.instance;
    client.configure(
      host: '127.0.0.1',
      port: server.port,
      authToken: 'contract-test-token',
    );
    final resource = client.resourceUri('/studio/image id');
    expect(resource.toString(), contains('/studio/image%20id?'));
    expect(resource.queryParameters['token'], 'contract-test-token');
    await client.connect();
    final stopwatch = Stopwatch()..start();
    await expectLater(
      client.call('ping', {}),
      throwsA(
        isA<Exception>().having(
          (error) => error.toString(),
          'message',
          contains('invalid request envelope'),
        ),
      ),
    );
    expect(stopwatch.elapsed, lessThan(const Duration(seconds: 2)));

    client.dispose();
    for (final socket in sockets) {
      await socket.close();
    }
    await server.close(force: true);
    await serverDone.future.timeout(
      const Duration(seconds: 1),
      onTimeout: () {},
    );
  });
}
