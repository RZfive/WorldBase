import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/ios_ui.dart';
import '../core/providers.dart';
import '../features/chat/chat_tab.dart';
import 'host_bridge_ui.dart';

/// WorldBase 移动端(晨昏 2.0):对话即主页,无底部 Tab。
/// 历史会话、应用、绘图和设置从左侧抽屉进入；输入栏回形针导入附件。
class WorldBaseApp extends ConsumerStatefulWidget {
  const WorldBaseApp({super.key});

  @override
  ConsumerState<WorldBaseApp> createState() => _WorldBaseAppState();
}

class _WorldBaseAppState extends ConsumerState<WorldBaseApp>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    Future.microtask(() async {
      await ref.read(connectionProvider.notifier).connect();
      // These application-level controllers own long-running chat and image
      // streams, so navigation never controls their lifetime.
      ref.read(chatProvider);
      ref.read(groupChatProvider);
      ref.read(studioQueueProvider);
      ref.read(conversationsProvider.notifier).refresh();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.detached) {
      ref.read(connectionProvider.notifier).stopEmbedded();
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'WorldBase',
      theme: buildIosTheme(),
      darkTheme: buildDawnDarkTheme(),
      themeMode: ThemeMode.system,
      // 全局默认文字样式:覆盖所有弹层/对话框(Cupertino 弹层无 Material 祖先时
      // 文字会退化为红色+黄色下划线的调试样式),统一为普通正文样式。
      builder: (context, child) {
        final dark = Theme.of(context).brightness == Brightness.dark;
        return DefaultTextStyle(
          style: TextStyle(
              fontSize: 15,
              color: dark ? const Color(0xFFECEDF2) : iosLabel,
              letterSpacing: -0.3,
              fontFamilyFallback: const ['SF Pro Text', 'PingFang SC', 'Helvetica Neue']),
          child: MediaQuery.withNoTextScaling(child: child ?? const SizedBox.shrink()),
        );
      },
      home: const GlobalDialogHost(child: ChatTab()),
    );
  }
}
