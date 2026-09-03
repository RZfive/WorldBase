import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:worldbase_mobile/core/glass.dart';
import 'package:worldbase_mobile/core/ios_ui.dart';
import 'package:worldbase_mobile/core/providers.dart';
import 'package:worldbase_mobile/features/chat/chat_tab.dart';

class _TestAgentsNotifier extends AgentsNotifier {
  _TestAgentsNotifier(this.agents);

  final List<AgentDefinition> agents;

  @override
  Future<List<AgentDefinition>> build() async => agents;
}

class _TestConversationsNotifier extends ConversationsNotifier {
  @override
  Future<List<ConversationMeta>> build() async => const [];
}

void main() {
  testWidgets('chat home stays clean and drawer fits a narrow screen', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(360, 740));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(theme: buildIosTheme(), home: const ChatTab()),
      ),
    );
    await tester.pump();

    expect(find.text('帮我写一封得体的请假邮件'), findsNothing);
    expect(find.text('看看今天的日程,留个喘息的空档'), findsNothing);
    expect(find.text('用大白话解释「量子纠缠」'), findsNothing);
    expect(find.byIcon(CupertinoIcons.paperclip), findsOneWidget);
    final modelSelector = tester.widget<GlassContainer>(
      find.byKey(const ValueKey('chat-model-selector')),
    );
    expect(modelSelector.showSheen, isFalse);
    expect(modelSelector.fill, isNull);
    final topIconSurfaces = tester
        .widgetList<GlassContainer>(find.byType(GlassContainer))
        .where((surface) => surface.radius == 99);
    expect(topIconSurfaces, hasLength(2));
    expect(topIconSurfaces.every((surface) => !surface.showSheen), isTrue);
    expect(topIconSurfaces.every((surface) => surface.fill == null), isTrue);

    await tester.tap(find.byIcon(CupertinoIcons.sidebar_left));
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.text('搜索对话'), findsOneWidget);
    expect(find.text('应用广场'), findsOneWidget);
    expect(find.text('绘图工作室'), findsOneWidget);
    expect(find.text('群组协作'), findsOneWidget);
    expect(find.text('我的'), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('new conversation Agent picker scrolls on a narrow screen', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(360, 640));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final agents = List.generate(
      30,
      (index) => AgentDefinition(
        id: 'agent-$index',
        name: 'Agent $index',
        description: '第 $index 个测试 Agent',
      ),
    );

    final container = ProviderContainer(
      retry: (_, _) => null,
      overrides: [
        agentsProvider.overrideWith(() => _TestAgentsNotifier(agents)),
        conversationsProvider.overrideWith(_TestConversationsNotifier.new),
      ],
    );
    addTearDown(container.dispose);
    await container.read(agentsProvider.future);
    await container.read(conversationsProvider.future);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(theme: buildIosTheme(), home: const ChatTab()),
      ),
    );
    await tester.pump();
    await tester.tap(find.byIcon(CupertinoIcons.square_pencil));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    final list = find.byKey(const ValueKey('agent-picker-list'));
    expect(find.text('选择 Agent(新会话)'), findsOneWidget);
    expect(list, findsOneWidget);
    expect(tester.getBottomLeft(list).dy, lessThanOrEqualTo(640));

    final scrollable = find.descendant(
      of: list,
      matching: find.byType(Scrollable),
    );
    await tester.scrollUntilVisible(
      find.text('🤖 Agent 29'),
      240,
      scrollable: scrollable,
    );
    expect(find.text('🤖 Agent 29'), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox.shrink());
  });
}
