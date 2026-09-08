import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:worldbase_mobile/core/harness_client.dart';

void main() {
  test('document artifact accepts Electron DTO and Rust aliases', () {
    final artifact = DocumentArtifact.fromJson({
      'id': 'artifact-1',
      'file_path': '/tmp/report.md',
      'file_name': 'report.md',
      'file_size': 42,
      'file_type': 'markdown',
      'plain_text': '正文',
      'parsed': {
        'kind': 'markdown',
        'text': '正文',
        'nodes': [
          {
            'id': 'node-1',
            'type': 'paragraph',
            'text': '正文',
            'level': 0,
            'page_index': 1,
            'meta': {'source': 'rust'},
          },
        ],
      },
      'render': {
        'kind': 'structured',
        'source': 'fallback',
        'status': 'ready',
        'mime_type': 'text/plain',
        'generated_at': '2026-09-05T00:00:00Z',
      },
      'imported_at': '2026-09-05T00:00:00Z',
    });

    expect(artifact.id, 'artifact-1');
    expect(artifact.filePath, '/tmp/report.md');
    expect(artifact.fileName, 'report.md');
    expect(artifact.fileSize, 42);
    expect(artifact.fileType, 'markdown');
    expect(artifact.plainText, '正文');
    expect(artifact.nodes, hasLength(1));
    expect(artifact.nodes.single.id, 'node-1');
    expect(artifact.parsed, isA<Map>());
    expect(artifact.render?.isReady, isTrue);
    expect(artifact.render?.mimeType, 'text/plain');
    expect(artifact.importedAt, '2026-09-05T00:00:00Z');

    final node = DocumentNode.fromJson(
      ((artifact.parsed as Map)['nodes'] as List).single
          as Map<String, dynamic>,
    );
    expect(node.id, 'node-1');
    expect(node.pageIndex, 1);
    expect(node.meta['source'], 'rust');
  });

  test('document summary accepts direct and wrapped list shapes', () {
    final direct = DocumentSummary.fromJson({
      'id': 'artifact-1',
      'filePath': '/tmp/report.md',
      'fileName': 'report.md',
      'fileType': 'markdown',
      'fileSize': 42,
      'nodeCount': 3,
      'selectionCount': 1,
      'importedAt': '2026-09-05T00:00:00Z',
    });
    final snake = DocumentSummary.fromJson({
      'artifact_id': 'artifact-2',
      'path': '/tmp/notes.txt',
      'file_name': 'notes.txt',
      'kind': 'text',
      'file_size': 8,
      'node_count': 2,
      'selection_count': 0,
      'imported_at': '2026-09-05T00:00:01Z',
    });

    expect(direct.nodeCount, 3);
    expect(direct.selectionCount, 1);
    expect(snake.id, 'artifact-2');
    expect(snake.fileType, 'text');
    expect(snake.filePath, '/tmp/notes.txt');
  });

  test('render asset decodes JSON byte arrays and base64 payloads', () {
    final arrayAsset = DocumentRenderAsset.fromJson({
      'mimeType': 'application/pdf',
      'bytes': [0, 1, 2, 255],
    });
    final base64Asset = DocumentRenderAsset.fromJson({
      'mime_type': 'text/plain',
      'data': base64Encode([72, 105]),
    });

    expect(arrayAsset.bytes.toList(), [0, 1, 2, 255]);
    expect(arrayAsset.mimeType, 'application/pdf');
    expect(base64Asset.bytes.toList(), [72, 105]);
    expect(base64Asset.mimeType, 'text/plain');
  });

  test('open original preserves structured mobile unsupported result', () {
    final result = DocumentOpenResult.fromJson({
      'success': false,
      'supported': false,
      'error': 'opening original files is unavailable on mobile',
    });

    expect(result.success, isFalse);
    expect(result.supported, isFalse);
    expect(result.error, contains('unavailable'));
    expect(result.toJson()['supported'], isFalse);
  });
}
