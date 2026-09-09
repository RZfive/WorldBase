import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:worldbase_mobile/core/harness_ffi.dart';

Uri _loopbackUri(int port, String token, String scheme, String path) => Uri(
  scheme: scheme,
  host: '127.0.0.1',
  port: port,
  path: path,
  queryParameters: {'token': token},
);

void main() {
  late Directory dataDir;
  late Directory workspaceDir;
  late File sourceFile;
  late String sourceText;
  late int port;
  late String authToken;

  setUpAll(() async {
    final temporaryDir = await Directory.systemTemp.createTemp(
      'worldbase-document-ffi-e2e-',
    );
    dataDir = Directory(await temporaryDir.resolveSymbolicLinks());
    workspaceDir = await Directory(
      '${dataDir.path}${Platform.pathSeparator}workspace',
    ).create();
    final fixtureDir = await Directory(
      '${workspaceDir.path}${Platform.pathSeparator}输入文档',
    ).create();
    sourceFile = File('${fixtureDir.path}${Platform.pathSeparator}跨端报告-🚀.md');
    sourceText = [
      '# 跨端文档验证',
      for (var index = 0; index < 720; index++)
        '第 $index 行：Flutter → Rust 🚀 文档内容与组合字 e\u0301。',
      '文档终点：完整读取。',
    ].join('\n');
    await sourceFile.writeAsString(sourceText, encoding: utf8, flush: true);

    final started = HarnessFfi.start(dataDir: dataDir.path);
    expect(
      started,
      isNotNull,
      reason: 'FFI library must load for the cross-end test',
    );
    port = started!;
    authToken = HarnessFfi.authToken!;

    final probe = HttpClient();
    var ready = false;
    for (var attempt = 0; attempt < 60; attempt++) {
      try {
        final request = await probe.getUrl(
          _loopbackUri(port, authToken, 'http', '/health'),
        );
        final response = await request.close();
        await response.drain<void>();
        if (response.statusCode == HttpStatus.ok) {
          ready = true;
          break;
        }
      } catch (_) {}
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    probe.close(force: true);
    expect(ready, isTrue, reason: 'embedded Rust harness must become ready');
  });

  tearDownAll(() async {
    HarnessFfi.stop();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    if (await dataDir.exists()) {
      await dataDir.delete(recursive: true);
    }
  });

  test(
    'Flutter FFI chains doc_parse into durable Unicode document reads',
    () async {
      final ws = WebSocketChannel.connect(
        _loopbackUri(port, authToken, 'ws', '/ws'),
      );
      await ws.ready;

      final pending = <String, Completer<dynamic>>{};
      var nextId = 1;
      final subscription = ws.stream.listen(
        (raw) {
          final message = jsonDecode(raw as String) as Map<String, dynamic>;
          if (!message.containsKey('id')) return;
          final completer = pending.remove(message['id'].toString());
          if (completer == null) return;
          if (message.containsKey('error')) {
            final error = message['error'] as Map?;
            completer.completeError(
              StateError(error?['message']?.toString() ?? 'RPC failed'),
            );
          } else {
            completer.complete(message['result']);
          }
        },
        onError: (Object error, StackTrace stackTrace) {
          for (final completer in pending.values) {
            if (!completer.isCompleted) {
              completer.completeError(error, stackTrace);
            }
          }
          pending.clear();
        },
      );

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
        return completer.future.timeout(const Duration(seconds: 30));
      }

      final initialized =
          await call('initialize', {
                'protocolVersion': '1.0',
                'capabilities': {
                  'platform': 'mobile-ffi-document-e2e',
                  'features': ['lightweight_runtime', 'interactive'],
                  'excludes': [
                    'subprocess',
                    'port_binding',
                    'webhook_receiver',
                  ],
                },
              })
              as Map;
      final availableToolNames = (initialized['availableTools'] as List)
          .map((tool) => (tool as Map)['name'])
          .toSet();
      expect(
        availableToolNames,
        containsAll(['doc_parse', 'list_documents', 'read_document']),
      );

      final relativePath = ['输入文档', '跨端报告-🚀.md'].join(Platform.pathSeparator);
      final parsed =
          await call('tool.call', {
                'name': 'doc_parse',
                'args': {'path': relativePath},
              })
              as Map;
      final artifactId = parsed['artifact_id'] as String;
      expect(artifactId, isNotEmpty);
      expect(parsed['artifactId'], artifactId);
      expect(parsed['kind'], 'markdown');
      expect(parsed['text'], sourceText);
      expect(jsonEncode(parsed), isNot(contains(dataDir.path)));

      final listed =
          await call('tool.call', {
                'name': 'list_documents',
                'args': <String, dynamic>{},
              })
              as Map;
      final documents = (listed['documents'] as List).cast<Map>();
      final document = documents.singleWhere(
        (item) => item['id'] == artifactId,
      );
      expect(document['fileName'], sourceFile.uri.pathSegments.last);
      expect(document['fileType'], 'markdown');
      expect(jsonEncode(listed), isNot(contains(dataDir.path)));

      final createdSelection =
          await call('doc.selection.create', {
                'artifactId': artifactId,
                'nodeIds': <String>[],
                'label': '跨端重点',
                'color': '#ef4444',
                'excerpt': '文档终点：完整读取。',
              })
              as Map;
      final regionId = createdSelection['id'] as String;
      expect(createdSelection['artifactId'], artifactId);

      final prompt =
          await call('doc.selection.prompt', {
                'region_ids': [regionId],
              })
              as String;
      expect(
        prompt,
        '【文档选区：跨端报告-🚀.md — 跨端重点】\n'
        '文档终点：完整读取。\n'
        '【选区结束】',
      );
      expect(
        await call('doc.selection.prompt', {'regionIds': []}),
        '',
      );

      final updatedSelection =
          await call('doc.selection.update', {
                'region_id': regionId,
                'label': '已确认',
              })
              as Map;
      expect(updatedSelection['label'], '已确认');
      expect(await call('doc.selection.remove', {'id': regionId}), isTrue);

      final chunks = <String>[];
      var chunkIndex = 0;
      var hasMore = true;
      while (hasMore) {
        final read =
            await call('tool.call', {
                  'name': 'read_document',
                  'args': {
                    'artifact_id': artifactId,
                    'chunk_index': chunkIndex,
                    'max_chars': 2000,
                  },
                })
                as Map;
        expect(read['chunkIndex'], chunkIndex);
        expect(read['maxChars'], 2000);
        expect(read['totalLength'], sourceText.runes.length);
        expect(read['content'], isNot(contains('\uFFFD')));
        expect(jsonEncode(read), isNot(contains(dataDir.path)));
        chunks.add(read['content'] as String);
        hasMore = read['hasMore'] as bool;
        expect(read['nextChunkIndex'], hasMore ? chunkIndex + 1 : isNull);
        chunkIndex++;
      }
      expect(chunks.join(), sourceText);
      expect(
        chunkIndex,
        greaterThan(1),
        reason: 'fixture must exercise chunking',
      );

      final artifactDir = Directory(
        '${workspaceDir.path}${Platform.pathSeparator}.worldbase'
        '${Platform.pathSeparator}document-artifacts',
      );
      final artifactFiles = artifactDir
          .listSync()
          .whereType<File>()
          .where((file) => file.path.endsWith('.json'))
          .toList();
      expect(artifactFiles, hasLength(1));
      expect(
        artifactFiles.single.path,
        startsWith('${workspaceDir.path}${Platform.pathSeparator}'),
      );
      expect(artifactFiles.single.uri.pathSegments.last, '$artifactId.json');

      await ws.sink.close();
      await subscription.cancel();
    },
    timeout: const Timeout(Duration(seconds: 60)),
  );
}
