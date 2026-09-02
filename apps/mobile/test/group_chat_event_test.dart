import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:worldbase_mobile/core/providers.dart';

EventFrame _frame(int seq, String kind, Map<String, dynamic> data) {
  return EventFrame(
    streamId: 'group-test',
    seq: seq,
    ts: '2026-09-01T00:00:00Z',
    kind: kind,
    data: {'kind': kind, ...data},
  );
}

void main() {
  test('group_message becomes a visible member message', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(groupChatProvider.notifier);

    controller.handleFrameForTesting(
      _frame(1, 'group_message', {'member': '工程测试', 'content': '建议先补齐事件渲染。'}),
    );

    final message = container.read(groupChatProvider).single;
    expect(message.role, 'group');
    expect(message.member, '工程测试');
    expect(message.text, '建议先补齐事件渲染。');
  });

  test('group_direct_reply unwraps the nested reply payload', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(groupChatProvider.notifier);

    controller.handleFrameForTesting(
      _frame(2, 'group_direct_reply', {
        'reply': {
          'id': 'reply-1',
          'agentName': '产品测试',
          'content': '这是直接回复用户的结论。',
        },
      }),
    );

    final message = container.read(groupChatProvider).single;
    expect(message.role, 'group');
    expect(message.member, '产品测试');
    expect(message.text, '这是直接回复用户的结论。');
  });

  test('group_error terminal event exposes the preceding notice', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(groupChatProvider.notifier);

    controller.handleFrameForTesting(
      _frame(3, 'notice', {
        'text': 'Native group failed: provider unavailable',
      }),
    );
    controller.handleFrameForTesting(
      _frame(4, 'done', {'stopReason': 'group_error'}),
    );

    final message = container.read(groupChatProvider).single;
    expect(message.isError, isTrue);
    expect(message.text, contains('provider unavailable'));
    expect(controller.busy, isFalse);
  });
}
