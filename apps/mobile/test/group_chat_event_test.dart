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

  test('group_message hides blackboard directives and prompt snapshots', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(groupChatProvider.notifier);

    controller.handleFrameForTesting(
      _frame(2, 'group_message', {
        'member': '工程测试',
        'content': '建议先验证事件链路。\n[board] tasks|add|验证事件链路\n当前黑板：\n任务:[验证事件链路]',
      }),
    );

    final message = container.read(groupChatProvider).single;
    expect(message.text, '建议先验证事件链路。');
    expect(message.text, isNot(contains('[board]')));
    expect(message.text, isNot(contains('当前黑板')));
  });

  test('notice is retained for errors but is not rendered as a reply', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(groupChatProvider.notifier);

    controller.handleFrameForTesting(_frame(3, 'notice', {'text': '内部任务黑板进度'}));

    expect(container.read(groupChatProvider), isEmpty);
  });

  test('reset does not turn a group stream into a terminal state', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(groupChatProvider.notifier);

    controller.handleFrameForTesting(_frame(1, 'reset', {}));
    expect(controller.busy, isFalse);
    expect(container.read(groupChatProvider), isEmpty);
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

  test('persisted member replies restore into one group message list', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(groupChatProvider.notifier);

    controller.restoreHistoryForTesting([
      ChatMessage(id: 1, role: 'user', content: '一起评审这个方案'),
      ChatMessage(
        id: 2,
        role: 'assistant',
        content: '[[worldbase-group-member]]{"name":"产品"}\n先明确用户目标。',
      ),
      ChatMessage(
        id: 3,
        role: 'assistant',
        content: '[[worldbase-group-member]]{"name":"工程"}\n再检查实现风险。',
      ),
    ]);

    final messages = container.read(groupChatProvider);
    expect(messages, hasLength(3));
    expect(messages.map((message) => message.role), ['user', 'group', 'group']);
    expect(messages[1].member, '产品');
    expect(messages[2].member, '工程');
  });

  test('persisted member replies hide legacy board directives', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(groupChatProvider.notifier);

    controller.restoreHistoryForTesting([
      ChatMessage(
        id: 1,
        role: 'assistant',
        content:
            '[[worldbase-group-member]]{"name":"产品"}\n结论保留。\n[board] decisions|add|采用方案 A',
      ),
    ]);

    final message = container.read(groupChatProvider).single;
    expect(message.text, '结论保留。');
  });

  test(
    'persisted user text is never treated as an internal board directive',
    () {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final controller = container.read(groupChatProvider.notifier);

      controller.restoreHistoryForTesting([
        ChatMessage(id: 1, role: 'user', content: '[board] 是什么？'),
      ]);

      final message = container.read(groupChatProvider).single;
      expect(message.role, 'user');
      expect(message.text, '[board] 是什么？');
    },
  );
}
