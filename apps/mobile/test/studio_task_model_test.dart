import 'package:flutter_test/flutter_test.dart';

import 'package:worldbase_mobile/core/harness_client.dart';

void main() {
  test('Studio task round-trip preserves terminal state and image entries', () {
    final entry = ImageEntry(
      id: 'image-1',
      prompt: 'draw a synchronized queue',
      file: 'image-1.png',
      createdAt: '2026-08-31T12:00:00Z',
      model: 'image-model',
      folder: 'tests',
      tags: const ['sync'],
      providerId: 'provider',
      mode: 'generate',
      aspect: '1:1',
      resolution: '1K',
      quality: 'high',
      format: 'png',
      width: 1024,
      height: 1024,
    );
    final task = StudioTask(
      id: 'task-1',
      status: 'success',
      createdAt: 1,
      request: const {
        'providerId': 'provider',
        'model': 'image-model',
        'prompt': 'draw a synchronized queue',
        'size': '1024x1024',
      },
      label: 'draw a synchronized queue',
      createdByAgent: true,
      entries: [entry],
    );

    final restored = StudioTask.fromJson(task.toJson());

    expect(restored.status, 'success');
    expect(restored.createdByAgent, isTrue);
    expect(restored.entries, hasLength(1));
    expect(restored.entries.single.id, 'image-1');
    expect(restored.entries.single.width, 1024);
    expect(restored.entries.single.tags, ['sync']);
  });
}
