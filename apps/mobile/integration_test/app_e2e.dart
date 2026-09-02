/// GUI 级端到端测试：启动真实 App（macOS 窗口），harness 经 FFI 进程内运行，
/// 驱动控件验证移动端全功能界面。
///
/// 运行：`flutter test integration_test/app_e2e.dart -d macos`
/// harness 经 FFI 进程内启动，无外部依赖。
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:worldbase_mobile/core/harness_ffi.dart';
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

Future<Map<String, dynamic>> _rpc(
  String method,
  Map<String, dynamic> params,
) async {
  final client = HttpClient();
  client.connectionTimeout = const Duration(seconds: 5);
  final req = await client
      .postUrl(Uri.parse('http://127.0.0.1:${HarnessFfi.port}/rpc'))
      .timeout(const Duration(seconds: 10));
  req.headers.contentType = ContentType.json;
  req.add(
    utf8.encode(
      jsonEncode({
        'jsonrpc': '2.0',
        'id': 1,
        'method': method,
        'params': params,
      }),
    ),
  );
  final resp = await req.close().timeout(const Duration(seconds: 10));
  final body = await resp
      .transform(utf8.decoder)
      .join()
      .timeout(const Duration(seconds: 10));
  client.close();
  return jsonDecode(body) as Map<String, dynamic>;
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets(
    '真实 App 全功能界面：连接 → 对话(流式) → 群组 → Studio → 应用 → 我的',
    (tester) async {
      app.main();
      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 1));

      // 1) 对话 Tab（harness 经 FFI 进程内运行，连接状态不再展示）
      await tester.pump(const Duration(seconds: 2));
      expect(
        find.text('已连接'),
        findsNothing,
        reason: 'FFI 模式下不再展示 harness 连接状态',
      );
      final providersBefore = await _rpc('provider.list', {});
      final providerConfig =
          ((providersBefore['result'] as Map)['providers'] as Map);
      final previousProviderId = providerConfig['activeProviderId'] as String?;
      await _rpc('provider.save', {
        'provider': {
          'id': 'e2e-mock-provider',
          'name': 'E2E Mock',
          'models': [
            {'id': 'mock-1'},
          ],
          'activeModel': 'mock-1',
        },
      });
      await _rpc('provider.setActive', {'id': 'e2e-mock-provider'});
      expect(find.text('深度思考'), findsNothing);
      expect(find.text('联网搜索'), findsNothing);
      await tester.tap(find.byIcon(CupertinoIcons.gear_alt));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('思考强度 (最高)'), findsOneWidget);
      expect(find.text('模型温度 (0.3)'), findsOneWidget);
      await tester.tap(find.byIcon(CupertinoIcons.gear_alt));
      await tester.pump(const Duration(milliseconds: 300));

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
          if (latest != null &&
              latest['role'] == 'assistant' &&
              (latest['content'] as String).isNotEmpty) {
            replied = true;
            break;
          }
        } catch (_) {}
      }
      expect(replied, isTrue, reason: '应收到 harness 的流式回复（真实模型或 mock）');
      debugPrint('[gui] main chat complete');

      // 3) 群组页：进入已保存群聊、@ 成员并展示群成员回复
      await _rpc('agent.save', {
        'agent': {
          'id': 'e2e-product-agent',
          'name': '产品测试',
          'systemPrompt': '负责产品范围',
        },
      });
      await _rpc('agent.save', {
        'agent': {
          'id': 'e2e-engineer-agent',
          'name': '工程测试',
          'systemPrompt': '负责工程实现',
        },
      });
      await _rpc('agentGroup.save', {
        'group': {
          'id': 'e2e-group-chat',
          'name': '集成测试群聊',
          'coordinatorAgentId': 'e2e-product-agent',
          'memberAgentIds': ['e2e-product-agent', 'e2e-engineer-agent'],
        },
      });
      await tester.tap(find.byIcon(CupertinoIcons.add).first);
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.text('群组协作'));
      await tester.pump(const Duration(seconds: 1));
      expect(find.textContaining('集成测试群聊'), findsOneWidget);
      await tester.tap(find.textContaining('集成测试群聊'));
      await tester.pump(const Duration(seconds: 1));
      final groupInput = find.byWidgetPredicate(
        (widget) =>
            widget is CupertinoTextField && widget.placeholder == '议题或 @成员…',
      );
      expect(groupInput, findsOneWidget);
      await tester.tap(groupInput);
      await tester.enterText(groupInput, '请 @');
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('@产品测试'), findsOneWidget);
      expect(find.text('@工程测试'), findsOneWidget);
      await tester.tap(find.text('@工程测试'));
      await tester.pump(const Duration(milliseconds: 300));
      final editable = tester.widget<EditableText>(
        find.descendant(of: groupInput, matching: find.byType(EditableText)),
      );
      expect(editable.controller.text, '请 @工程测试 ');
      await tester.enterText(groupInput, '请 @工程测试 评估群聊回复展示');
      await tester.pump();
      await tester.tap(find.byIcon(CupertinoIcons.arrow_up));
      var groupReplied = false;
      for (var i = 0; i < 40; i++) {
        await tester.pump(const Duration(milliseconds: 500));
        if (find.textContaining('（mock）已收到').evaluate().isNotEmpty) {
          groupReplied = true;
          break;
        }
      }
      expect(groupReplied, isTrue, reason: '群成员 AI 回复应展示在群聊页面');
      expect(find.text('@工程测试'), findsWidgets, reason: '群成员回复应显示成员名称');
      debugPrint('[gui] group reply rendered');
      await tester.tap(find.byIcon(CupertinoIcons.chevron_left).first);
      await tester.pump(const Duration(milliseconds: 600));
      if (previousProviderId != null && previousProviderId.isNotEmpty) {
        await _rpc('provider.setActive', {'id': previousProviderId});
      }

      // 4) 应用广场：从主对话「+」能力菜单进入
      await tester.tap(find.byIcon(CupertinoIcons.add).first);
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.text('应用广场'));
      await tester.pump(const Duration(seconds: 2));
      expect(find.byIcon(CupertinoIcons.add_circled), findsOneWidget);
      final emptyOrApps =
          find.text('还没有应用').evaluate().isNotEmpty ||
          find.byType(GridView).evaluate().isNotEmpty;
      expect(emptyOrApps, isTrue, reason: 'Agent 生成的单页应用展示区');
      debugPrint('[gui] launchpad complete');
      await tester.tap(find.byIcon(CupertinoIcons.chevron_left).first);
      await tester.pump(const Duration(milliseconds: 600));

      // 5) 绘图 Studio：从主对话「+」能力菜单进入
      await tester.tap(find.byIcon(CupertinoIcons.add).first);
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.text('绘图工作室'));
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
      debugPrint('[gui] studio complete');
      await tester.tap(find.byIcon(CupertinoIcons.chevron_left).first);
      await tester.pump(const Duration(milliseconds: 600));

      // 6) 我的：从会话抽屉进入设置
      await tester.tap(find.byIcon(CupertinoIcons.sidebar_left));
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('我的'), findsOneWidget);
      await tester.tap(find.byIcon(CupertinoIcons.gear).last);
      await tester.pump(const Duration(seconds: 2));
      expect(find.text('模型供应商'), findsOneWidget);
      expect(find.text('Agent 工作区'), findsOneWidget);
      expect(find.text('用量统计'), findsOneWidget);
      expect(find.text('MCP 服务'), findsOneWidget);
      expect(find.text('技能'), findsOneWidget, reason: '技能在「我的」设置层级');
      expect(find.text('定时任务'), findsOneWidget, reason: '定时任务在「我的」设置层级');
      expect(find.text('通用与关于'), findsOneWidget);
      debugPrint('[gui] settings root complete');

      // 6a) 供应商子页（已配置 → 供应商行；未配置 → 添加行）
      await tester.tap(find.text('模型供应商'));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Agent 工作区'), findsNothing, reason: '应进入供应商子页');
      final providerPageOk =
          find.text('添加供应商').evaluate().isNotEmpty ||
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
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
