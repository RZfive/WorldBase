import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldbase_mobile/core/providers.dart';

void main() {
  test(
    'studio queue remains alive when its page listener is removed',
    () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final subscription = container.listen(studioQueueProvider, (_, _) {});
      final controller = container.read(studioQueueProvider.notifier);
      final task = StudioTask(
        id: 'running-image',
        status: 'running',
        createdAt: 1,
        request: const {'prompt': '保留生成任务'},
        label: '保留生成任务',
      );

      controller.restoreTasksForTesting([task]);
      subscription.close();
      await Future<void>.delayed(Duration.zero);

      final restored = container.read(studioQueueProvider).tasks.single;
      expect(restored.id, 'running-image');
      expect(restored.status, 'running');
    },
  );

  test('queue IDs disambiguate concurrent tasks with identical prompts', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(studioQueueProvider.notifier);

    controller.registerChatTasksForTesting(
      conversationId: 'conversation-a',
      messageId: 'message-a',
      prompts: const ['相同提示词'],
      queueIds: const ['queue-a'],
    );
    controller.registerChatTasksForTesting(
      conversationId: 'conversation-b',
      messageId: 'message-b',
      prompts: const ['相同提示词'],
      queueIds: const ['queue-b'],
    );

    final taskB = controller.attachPendingChatTargetForTesting({
      '_queueId': 'queue-b',
      'prompt': '相同提示词',
    });
    final taskA = controller.attachPendingChatTargetForTesting({
      '_queueId': 'queue-a',
      'prompt': '相同提示词',
    });

    expect(taskB['_conversationId'], 'conversation-b');
    expect(taskB['_messageId'], 'message-b');
    expect(taskA['_conversationId'], 'conversation-a');
    expect(taskA['_messageId'], 'message-a');
  });

  test('identified handoffs never fall back to legacy prompt matching', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(studioQueueProvider.notifier);

    controller.registerChatTasksForTesting(
      conversationId: 'identified-conversation',
      messageId: 'identified-message',
      prompts: const ['共享提示词'],
      queueIds: const ['known-queue'],
    );
    controller.registerChatTasksForTesting(
      conversationId: 'legacy-conversation',
      messageId: 'legacy-message',
      prompts: const ['共享提示词'],
      queueIds: const [''],
    );

    final unknown = controller.attachPendingChatTargetForTesting({
      '_queueId': 'unknown-queue',
      'prompt': '共享提示词',
    });
    final legacy = controller.attachPendingChatTargetForTesting({
      'prompt': '共享提示词',
    });
    final identified = controller.attachPendingChatTargetForTesting({
      '_queueId': 'known-queue',
      'prompt': '共享提示词',
    });

    expect(unknown, isNot(contains('_conversationId')));
    expect(legacy['_conversationId'], 'legacy-conversation');
    expect(legacy['_messageId'], 'legacy-message');
    expect(identified['_conversationId'], 'identified-conversation');
    expect(identified['_messageId'], 'identified-message');
  });
}
