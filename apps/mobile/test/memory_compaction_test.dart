import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:worldbase_mobile/core/harness_client.dart';
import 'package:worldbase_mobile/core/memory_compaction.dart';

WorkspaceMemoryEntry _entry(
  String id, {
  String scopeType = 'agent',
  String scopeId = 'agent_default',
  String memoryType = 'knowledge',
  String title = 't',
  String summary = 's',
  bool pinned = false,
}) => WorkspaceMemoryEntry(
  id: id,
  scopeType: scopeType,
  scopeId: scopeId,
  memoryType: memoryType,
  title: title,
  summary: summary,
  pinned: pinned,
);

void main() {
  group('extractJsonObjectCandidate', () {
    test('accepts plain, fenced and embedded JSON objects', () {
      expect(extractJsonObjectCandidate('{"a":1}'), '{"a":1}');
      expect(
        extractJsonObjectCandidate('```json\n{"a":1}\n```'),
        '{"a":1}',
      );
      expect(
        extractJsonObjectCandidate('结果如下：{"a":1} 请查收'),
        '{"a":1}',
      );
    });

    test('returns null when no object is present', () {
      expect(extractJsonObjectCandidate(''), isNull);
      expect(extractJsonObjectCandidate('没有对象'), isNull);
      expect(extractJsonObjectCandidate('[1,2,3]'), isNull);
    });
  });

  group('parseMemoryCompactionPlan', () {
    test('strips reasoning blocks and fenced markdown before parsing', () {
      final raw = '<think>先想想…{"deleteIds":["x"]}</think>\n'
          '```json\n{"deleteIds":["m1"]}\n```';
      final plan = parseMemoryCompactionPlan(raw, [_entry('m1')]);
      expect(plan['deleteIds'], ['m1']);
    });

    test('only allows ids from the current chunk and dedupes', () {
      final raw = jsonEncode({
        'deleteIds': ['m1', 'm1', 'other', ''],
        'mergeGroups': [
          {
            'ids': ['m1', 'm2', 'ghost'],
            'targetId': 'm1',
            'title': '合并标题',
          },
          {'ids': ['m1']},
        ],
        'updates': [
          {
            'id': 'm1',
            'title': '更短标题',
            'summary': '更准确的摘要',
            'importance': 4,
            'confidence': -1,
          },
          {'id': 'ghost', 'title': '越界更新'},
        ],
      });
      final plan = parseMemoryCompactionPlan(raw, [
        _entry('m1'),
        _entry('m2'),
      ]);
      expect(plan['deleteIds'], ['m1']);
      final groups = plan['mergeGroups'] as List;
      expect(groups.length, 1);
      expect(groups.first['ids'], ['m1', 'm2']);
      expect(groups.first['targetId'], 'm1');
      expect(groups.first['title'], '合并标题');
      final updates = plan['updates'] as List;
      expect(updates.length, 1);
      // 数字被夹取到 [0, 1]。
      expect(updates.first['importance'], 1.0);
      expect(updates.first['confidence'], 0.0);
      expect(plan['updates'].length, 1);
    });

    test('throws a readable error for non-JSON output', () {
      expect(
        () => parseMemoryCompactionPlan('我不会输出 JSON', [_entry('m1')]),
        throwsFormatException,
      );
    });
  });

  test('mergeMemoryCompactionPlans unions and concatenates', () {
    final merged = mergeMemoryCompactionPlans([
      {
        'deleteIds': ['a'],
        'mergeGroups': [
          {'ids': ['a', 'b']},
        ],
        'updates': [
          {'id': 'a'},
        ],
      },
      {
        'deleteIds': ['a', 'c'],
        'mergeGroups': <Map<String, dynamic>>[],
        'updates': [
          {'id': 'c'},
        ],
      },
    ]);
    expect(merged['deleteIds'], ['a', 'c']);
    expect((merged['mergeGroups'] as List).length, 1);
    expect((merged['updates'] as List).length, 2);
  });

  group('chunkMemoryEntriesForAiCompaction', () {
    test('groups by scope/type and never mixes groups', () {
      final chunks = chunkMemoryEntriesForAiCompaction([
        _entry('1', scopeId: 'a'),
        _entry('2', scopeId: 'b'),
        _entry('3', scopeId: 'a', memoryType: 'step'),
      ]);
      expect(chunks.length, 3);
    });

    test('splits a large same-group run at the chunk size', () {
      final entries = List.generate(
        memoryCompactionChunkSize + 10,
        (index) => _entry('m$index'),
      );
      final chunks = chunkMemoryEntriesForAiCompaction(entries);
      expect(chunks.length, 2);
      expect(chunks.first.length, memoryCompactionChunkSize);
      expect(chunks.last.length, 10);
    });
  });

  test('serializeMemoryEntryForAi keeps the desktop contract shape', () {
    final json = serializeMemoryEntryForAi(
      _entry(
        'm1',
        title: '标题',
        summary: '摘要',
        pinned: true,
      ),
    );
    expect(json['id'], 'm1');
    expect(json['scope'], 'agent/agent_default');
    expect(json['type'], 'knowledge');
    expect(json['pinned'], isTrue);
    expect(json.containsKey('details'), isFalse);
    expect(json['importance'], 0.5);
    expect(json['confidence'], 0.5);
  });
}
