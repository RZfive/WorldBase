import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldbase_mobile/core/providers.dart';

EventFrame _frame(
  String streamId,
  int seq,
  String kind,
  Map<String, dynamic> data,
) {
  return EventFrame(
    streamId: streamId,
    seq: seq,
    ts: '2026-09-03T00:00:00Z',
    kind: kind,
    data: data,
  );
}

void main() {
  test('background conversation keeps streaming while another is visible', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(chatProvider.notifier);

    controller.restoreConversationForTesting('conversation-a', [
      UiMessage(id: 'user-a', role: 'user', text: 'A'),
      UiMessage(id: 'pending', role: 'assistant', streaming: true),
    ], select: true);
    controller.restoreConversationForTesting('conversation-b', [
      UiMessage(id: 'user-b', role: 'user', text: 'B'),
    ]);
    controller.startConversationRunForTesting('conversation-a', 'stream-a');

    controller.handleFrameForTesting(
      _frame('stream-a', 1, 'delta', {'text': '第一段'}),
    );
    controller.selectConversationForTesting('conversation-b');
    controller.handleFrameForTesting(
      _frame('stream-a', 2, 'delta', {'text': '第二段'}),
    );

    expect(container.read(chatProvider).single.text, 'B');
    expect(controller.isConversationRunning('conversation-a'), isTrue);
    expect(controller.isConversationRunning('conversation-b'), isFalse);

    controller.handleFrameForTesting(_frame('stream-a', 3, 'done', {}));
    expect(controller.isConversationRunning('conversation-a'), isFalse);
    expect(container.read(chatProvider).single.text, 'B');

    controller.selectConversationForTesting('conversation-a');
    final reply = container.read(chatProvider).last;
    expect(reply.text, '第一段第二段');
    expect(reply.streaming, isFalse);
  });

  test('assistant image parts survive the live event and terminal frame', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(chatProvider.notifier);

    controller.restoreConversationForTesting('conversation-a', [
      UiMessage(id: 'pending', role: 'assistant', streaming: true),
    ], select: true);
    controller.startConversationRunForTesting('conversation-a', 'stream-a');

    controller.handleFrameForTesting(
      _frame('stream-a', 1, 'assistant_message', {
        'content': '生成完成',
        'parts': [
          {'type': 'text', 'text': '生成完成'},
          {
            'type': 'image_url',
            'image_url': {'url': 'data:image/png;base64,aGVsbG8='},
          },
        ],
      }),
    );
    controller.handleFrameForTesting(_frame('stream-a', 2, 'done', {}));

    final reply = container.read(chatProvider).single;
    expect(reply.text, '生成完成');
    expect(reply.streaming, isFalse);
    expect(reply.attachments, hasLength(1));
    expect(reply.attachments.single.dataUrl, 'data:image/png;base64,aGVsbG8=');
  });

  test('reset clears failed partial text before the next retry delta', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(chatProvider.notifier);

    controller.restoreConversationForTesting('conversation-a', [
      UiMessage(id: 'pending', role: 'assistant', streaming: true),
    ], select: true);
    controller.startConversationRunForTesting('conversation-a', 'stream-a');

    controller.handleFrameForTesting(
      _frame('stream-a', 1, 'delta', {'text': 'partial'}),
    );
    controller.handleFrameForTesting(_frame('stream-a', 2, 'reset', {}));
    expect(controller.isConversationRunning('conversation-a'), isTrue);
    expect(container.read(chatProvider).single.text, isEmpty);

    controller.handleFrameForTesting(
      _frame('stream-a', 3, 'delta', {'text': ' retry'}),
    );
    expect(container.read(chatProvider).single.text, ' retry');

    controller.handleFrameForTesting(_frame('stream-a', 4, 'done', {}));
    expect(controller.isConversationRunning('conversation-a'), isFalse);
    expect(container.read(chatProvider).single.streaming, isFalse);
  });

  test('reset restores the latest assistant checkpoint after a tool turn', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(chatProvider.notifier);

    controller.restoreConversationForTesting('conversation-a', [
      UiMessage(id: 'pending', role: 'assistant', streaming: true),
    ], select: true);
    controller.startConversationRunForTesting('conversation-a', 'stream-a');
    controller.handleFrameForTesting(
      _frame('stream-a', 1, 'assistant_message', {'content': '先读取文件'}),
    );
    controller.handleFrameForTesting(
      _frame('stream-a', 2, 'tool_call', {
        'name': 'read_file',
        'args': {'path': 'notes.txt'},
      }),
    );
    controller.handleFrameForTesting(_frame('stream-a', 3, 'reset', {}));
    controller.handleFrameForTesting(
      _frame('stream-a', 4, 'delta', {'text': '，然后总结'}),
    );

    final messages = container.read(chatProvider);
    expect(
      messages.where((message) => message.streaming).single.text,
      '先读取文件，然后总结',
    );
  });

  test('new conversation does not clear cached conversations', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(chatProvider.notifier);

    controller.restoreConversationForTesting('conversation-a', [
      UiMessage(id: 'saved', role: 'assistant', text: '保留内容'),
    ], select: true);

    controller.startNewConversation();
    expect(container.read(chatProvider), isEmpty);

    controller.selectConversationForTesting('conversation-a');
    expect(container.read(chatProvider).single.text, '保留内容');
  });

  test('image event updates its owning conversation after switching away', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(chatProvider.notifier);

    controller.restoreConversationForTesting('conversation-a', [
      UiMessage(
        id: 'image-message',
        role: 'tool',
        toolName: 'generate_image',
        text: '正在生成图片',
        imageStatus: 'waiting',
        imageExpected: 1,
      ),
    ], select: true);
    controller.restoreConversationForTesting('conversation-b', [
      UiMessage(id: 'user-b', role: 'user', text: '当前会话'),
    ]);
    controller.bindImageStreamForTesting(
      'image-stream',
      'conversation-a',
      'image-message',
    );
    controller.selectConversationForTesting('conversation-b');

    controller.handleImageFrameForTesting(
      _frame('image-stream', 1, 'image_ready', {
        'entry': {
          'id': 'image-1',
          'prompt': '测试图片',
          'file': 'image-1.png',
          'createdAt': '2026-09-03T00:00:00Z',
        },
      }),
    );

    expect(container.read(chatProvider).single.text, '当前会话');
    controller.selectConversationForTesting('conversation-a');
    final imageMessage = container.read(chatProvider).single;
    expect(imageMessage.imageStatus, 'done');
    expect(imageMessage.imageEntries.single.id, 'image-1');
  });

  test('studio queue result is written back to its owning conversation', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(chatProvider.notifier);
    final entry = ImageEntry(
      id: 'queued-image',
      prompt: '后台生成',
      file: 'queued-image.png',
      createdAt: '2026-09-03T00:00:00Z',
    );

    controller.restoreConversationForTesting('conversation-a', [
      UiMessage(
        id: 'queue-message',
        role: 'tool',
        imageStatus: 'waiting',
        imageExpected: 1,
      ),
    ]);
    controller.restoreConversationForTesting('conversation-b', [
      UiMessage(id: 'visible', role: 'user', text: '仍显示 B'),
    ], select: true);

    controller.trackStudioQueueTask(
      'studio-task',
      'conversation-a',
      'queue-message',
    );
    controller.appendStudioQueueImage('conversation-a', 'queue-message', entry);
    controller.finishStudioQueueTask(
      'studio-task',
      'conversation-a',
      'queue-message',
    );

    expect(container.read(chatProvider).single.text, '仍显示 B');
    controller.selectConversationForTesting('conversation-a');
    final message = container.read(chatProvider).single;
    expect(message.imageStatus, 'done');
    expect(message.imageEntries.single.id, 'queued-image');
  });

  test(
    'deleting a running conversation aborts before remote deletion',
    () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final controller = container.read(chatProvider.notifier);
      final calls = <String>[];

      controller.restoreConversationForTesting('conversation-a', [
        UiMessage(id: 'pending', role: 'assistant', streaming: true),
      ], select: true);
      controller.startConversationRunForTesting('conversation-a', 'stream-a');

      await controller.deleteConversationForTesting(
        'conversation-a',
        abortRemote: (streamId, conversationId) async {
          calls.add('abort:$streamId:$conversationId');
        },
        deleteRemote: (conversationId) async {
          calls.add('delete:$conversationId');
        },
      );

      expect(calls, ['abort:stream-a:conversation-a', 'delete:conversation-a']);
      expect(controller.isConversationRunning('conversation-a'), isFalse);
      expect(controller.hasConversationForTesting('conversation-a'), isFalse);
      expect(container.read(chatProvider), isEmpty);
    },
  );

  test('late frames cannot recreate a deleted background conversation', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(chatProvider.notifier);

    controller.restoreConversationForTesting('conversation-a', [
      UiMessage(id: 'pending', role: 'assistant', streaming: true),
    ]);
    controller.restoreConversationForTesting('conversation-b', [
      UiMessage(id: 'visible', role: 'user', text: '仍显示 B'),
    ], select: true);
    controller.startConversationRunForTesting('conversation-a', 'stream-a');
    controller.forgetConversation('conversation-a');

    controller.handleFrameForTesting(
      _frame('stream-a', 1, 'delta', {'text': '不应写回'}),
    );
    controller.handleFrameForTesting(_frame('stream-a', 2, 'done', {}));

    expect(controller.hasConversationForTesting('conversation-a'), isFalse);
    expect(container.read(chatProvider).single.text, '仍显示 B');
  });

  test('unbound image frames never attach to the visible conversation', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final controller = container.read(chatProvider.notifier);

    controller.restoreConversationForTesting('conversation-a', [
      UiMessage(
        id: 'waiting-image',
        role: 'tool',
        text: '正在生成图片',
        imageStatus: 'waiting',
        imageExpected: 1,
        imagePrompts: const ['相同提示词'],
      ),
    ], select: true);

    controller.handleImageFrameForTesting(
      _frame('unknown-image-stream', 1, 'image_ready', {
        'entry': {
          'id': 'image-unbound',
          'prompt': '相同提示词',
          'file': 'image-unbound.png',
          'createdAt': '2026-09-03T00:00:00Z',
        },
      }),
    );

    final message = container.read(chatProvider).single;
    expect(message.imageStatus, 'waiting');
    expect(message.imageEntries, isEmpty);
  });
}
