/// GUI 级端到端测试：启动真实 App（macOS 窗口），harness 经 FFI 进程内运行，
/// 驱动控件验证移动端全功能界面。
///
/// 运行：`flutter test integration_test/app_e2e.dart -d macos`
/// harness 经 FFI 进程内启动，无外部依赖。
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:worldbase_mobile/core/harness_ffi.dart';
import 'package:worldbase_mobile/features/chat/group_page.dart';
import 'package:worldbase_mobile/main.dart' as app;

/// 查询最近会话的最后一条消息（经 harness HTTP 通道，与 provider 无关）。
Future<Map<String, dynamic>?> _latestConversationLastMessage() async {
  final listBody = await _rpc('conversation.list', {'limit': 1});
  final convs = ((listBody['result'] as Map)['conversations'] as List?) ?? [];
  if (convs.isEmpty) return null;
  final convId = (convs.first as Map)['id'] as String;
  final msgsBody = await _rpc('conversation.messages', {'id': convId});
  final msgs = (msgsBody['result'] as Map)['messages'] as List?;
  if (msgs == null || msgs.isEmpty) return null;
  return (msgs.last as Map).cast<String, dynamic>();
}

Future<Map<String, dynamic>> _rpc(String method, Map<String, dynamic> params) async {
  final client = HttpClient();
  final req = await client.postUrl(Uri.parse('http://127.0.0.1:${HarnessFfi.port}/rpc'));
  req.headers.contentType = ContentType.json;
  req.add(utf8.encode(jsonEncode({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params})));
  final resp = await req.close();
  final body = await resp.transform(utf8.decoder).join();
  client.close();
  return jsonDecode(body) as Map<String, dynamic>;
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('真实 App 全功能界面：连接 → 对话(流式) → 群组 → Studio → 应用 → 我的', (tester) async {
    app.main();
    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(seconds: 1));

    // 1) 对话 Tab（harness 经 FFI 进程内运行，连接状态不再展示）
    await tester.pump(const Duration(seconds: 2));
    expect(find.text('已连接'), findsNothing,
        reason: 'FFI 模式下不再展示 harness 连接状态');

    // 2) 发送消息 → 用户气泡 + 流式回复（与供应商无关：mock 或真实模型均可）
    final input = find.byType(CupertinoTextField).first;
    final testText = '在吗 harness ${DateTime.now().millisecondsSinceEpoch}';
    await tester.enterText(input, testText);
    await tester.pump();
    await tester.tap(find.byIcon(CupertinoIcons.arrow_up));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text(testText), findsOneWidget, reason: '用户消息应渲染为气泡');

    // 轮询 harness 持久化消息：最近会话最后一条应为非空 assistant 回复
    var replied = false;
    for (var i = 0; i < 90; i++) {
      await tester.pump(const Duration(milliseconds: 500));
      try {
        final latest = await _latestConversationLastMessage();
        if (latest != null && latest['role'] == 'assistant' && (latest['content'] as String).isNotEmpty) {
          replied = true;
          break;
        }
      } catch (_) {}
    }
    expect(replied, isTrue, reason: '应收到 harness 的流式回复（真实模型或 mock）');

    // 3) 群组页：新建入口存在（渲染模式选择）
    print('[gui] person_2 count: ' + find.byIcon(CupertinoIcons.person_2).evaluate().length.toString());
    print('[gui] person_2_flutter: ' + find.byIcon(Icons.group_outlined).evaluate().length.toString());
    await tester.tap(find.byIcon(CupertinoIcons.person_2));
    await tester.pump(const Duration(seconds: 1));
    print('[gui] group page open: ' + find.text('创建群组，让多个 Agent 协作讨论').evaluate().length.toString());
    print('[gui] add_circled count: ' + find.byIcon(CupertinoIcons.add_circled).evaluate().length.toString());
    expect(find.text('创建群组，让多个 Agent 协作讨论'), findsOneWidget);
    await tester.tap(find.byIcon(CupertinoIcons.add_circled).first);
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('讨论主题'), findsOneWidget);
    expect(find.text('全员讨论'), findsOneWidget, reason: '桌面 5 模式选择器');
    // 关闭弹层（Navigator.pop），退出群组页
    Navigator.of(tester.element(find.text('讨论主题'))).pop();
    await tester.pump(const Duration(milliseconds: 600));
    Navigator.of(tester.element(find.byType(GroupPage))).pop();
    await tester.pump(const Duration(milliseconds: 600));

    // 4) 应用 Tab：轻应用（生成应用）+ 网页快捷方式
    await tester.tap(find.text('应用'));
    await tester.pump(const Duration(seconds: 2));
    expect(find.text('轻应用'), findsOneWidget);
    expect(find.text('网页快捷方式'), findsOneWidget);
    // 空态或已生成的应用网格二选一
    final emptyOrApps = find.textContaining('还没有生成的应用').evaluate().isNotEmpty ||
        find.byIcon(CupertinoIcons.hammer_fill).evaluate().isNotEmpty;
    expect(emptyOrApps, isTrue, reason: 'Agent 生成的单页应用展示区');

    // 5) 绘图 Studio：生成/编辑/图库 三个并列 Tab
    await tester.tap(find.text('绘图'));
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('生成'), findsWidgets, reason: '顶部分段切换');
    expect(find.text('编辑'), findsOneWidget);
    expect(find.text('图库'), findsOneWidget);
    // 5a) 生成参数
    expect(find.text('比例'), findsOneWidget);
    expect(find.text('分辨率'), findsOneWidget);
    expect(find.text('质量'), findsOneWidget);
    expect(find.text('格式'), findsOneWidget);
    // 5b) 编辑视图（参考图选择）
    await tester.tap(find.text('编辑'));
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('点按从图库选择参考图'), findsOneWidget);
    // 5c) 图库视图（搜索 + 空态/网格）
    await tester.tap(find.text('图库'));
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('搜索提示词'), findsOneWidget);

    // 6) 我的 Tab：设置层级与桌面端一致（供应商/Agent工作区/用量/MCP/技能/定时/通用与关于）
    await tester.tap(find.text('我的'));
    await tester.pump(const Duration(seconds: 2));
    expect(find.text('模型供应商'), findsOneWidget);
    expect(find.text('Agent 工作区'), findsOneWidget);
    expect(find.text('用量统计'), findsOneWidget);
    expect(find.text('MCP 服务'), findsOneWidget);
    expect(find.text('技能'), findsOneWidget, reason: '技能在「我的」设置层级');
    expect(find.text('定时任务'), findsOneWidget, reason: '定时任务在「我的」设置层级');
    expect(find.text('通用与关于'), findsOneWidget);

    // 6a) 供应商子页（已配置 → 供应商行；未配置 → 添加行）
    await tester.tap(find.text('模型供应商'));
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('Agent 工作区'), findsNothing, reason: '应进入供应商子页');
    final providerPageOk = find.text('添加供应商').evaluate().isNotEmpty ||
        find.textContaining('（默认）').evaluate().isNotEmpty ||
        find.byIcon(CupertinoIcons.chevron_forward).evaluate().isNotEmpty;
    expect(providerPageOk, isTrue, reason: '供应商管理子页内容');
    await tester.tap(find.byIcon(CupertinoIcons.chevron_left));
    await tester.pump(const Duration(milliseconds: 500));

    // 6b) Agent 工作区子页（Agent/记忆 分层）
    await tester.tap(find.text('Agent 工作区'));
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('记忆'), findsWidgets, reason: 'Agent 工作区分层');
    await tester.tap(find.text('记忆').last);
    await tester.pump(const Duration(seconds: 1));
    await tester.tap(find.byIcon(CupertinoIcons.chevron_left));
    await tester.pump(const Duration(milliseconds: 500));

    // 6c) 技能子页
    await tester.tap(find.text('技能'));
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('新建技能'), findsOneWidget);
    await tester.tap(find.byIcon(CupertinoIcons.chevron_left));
    await tester.pump(const Duration(milliseconds: 500));

    // 6d) 定时任务子页
    await tester.tap(find.text('定时任务'));
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('新建任务'), findsOneWidget);
    await tester.tap(find.byIcon(CupertinoIcons.chevron_left));
    await tester.pump(const Duration(milliseconds: 500));

    // 6e) 用量子页
    await tester.tap(find.text('用量统计'));
    await tester.pump(const Duration(seconds: 1));
    expect(find.textContaining('tokens'), findsWidgets, reason: '用量统计详情');
    await tester.tap(find.byIcon(CupertinoIcons.chevron_left));
    await tester.pump(const Duration(milliseconds: 500));
  }, timeout: const Timeout(Duration(minutes: 3)));
}
