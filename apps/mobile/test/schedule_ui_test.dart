import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldbase_mobile/features/settings/settings_tab.dart';

void main() {
  testWidgets('schedule editor exposes structured cadence and task policies', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(
      const ProviderScope(child: MaterialApp(home: SchedulesPage())),
    );
    await tester.pump();
    expect(find.text('新建任务'), findsOneWidget);

    await tester.tap(find.text('新建任务'));
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.text('新建定时任务'), findsOneWidget);
    expect(find.text('调度模式'), findsOneWidget);
    expect(find.text('cron'), findsOneWidget);
    expect(find.text('一次'), findsOneWidget);
    expect(find.text('间隔'), findsOneWidget);
    expect(find.text('每日'), findsOneWidget);
    expect(find.text('每周'), findsOneWidget);
    expect(find.text('日期'), findsOneWidget);
    expect(find.text('启用任务'), findsOneWidget);
    expect(find.text('选择技能 ID（逗号分隔，可选）'), findsOneWidget);
    expect(find.text('选择 MCP server ID（逗号分隔，可选）'), findsOneWidget);
    expect(find.text('最大重试次数'), findsOneWidget);
    expect(find.text('重试间隔（分钟）'), findsOneWidget);
  });
}
