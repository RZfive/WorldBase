import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../app/host_bridge_ui.dart';
import '../../core/ios_ui.dart';
import '../../core/providers.dart';

/// 应用 Tab：Agent 生成的轻应用（单页应用）+ 网页快捷方式（iOS 风格）。
class LaunchpadTab extends ConsumerStatefulWidget {
  const LaunchpadTab({super.key});

  @override
  ConsumerState<LaunchpadTab> createState() => _LaunchpadTabState();
}

class _LaunchpadTabState extends ConsumerState<LaunchpadTab> {
  List<LightApp>? _generatedApps;
  StreamSubscription? _connSub;

  @override
  void initState() {
    super.initState();
    _loadGenerated();
    // 连接建立/恢复后重载（首帧时 WS 可能尚未就绪）
    _connSub =
        HarnessClient.instance.stateStream.listen((state) {
      if (state == HarnessState.connected) _loadGenerated();
    });
  }

  @override
  void dispose() {
    _connSub?.cancel();
    super.dispose();
  }

  Future<void> _loadGenerated() async {
    try {
      final apps = await HarnessClient.instance.listLightApps();
      if (mounted) setState(() => _generatedApps = apps);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    // 版本号变化（工具生成新应用 / 切到本 Tab）→ 刷新轻应用列表
    ref.listen(lightAppsVersionProvider, (_, _) => _loadGenerated());
    final webApps = ref.watch(webAppsProvider);
    return IosScreen(
      navBar: IosNavBar(
        actions: [
          IosIconButton(
            icon: CupertinoIcons.add_circled,
            onPressed: () => _addApp(context, ref),
          ),
        ],
      ),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(0, 4, 0, 20),
        children: [
          const Padding(
            padding: EdgeInsets.only(left: 20, right: 20, top: 8, bottom: 2),
            child: Text('轻应用',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, letterSpacing: -0.3)),
          ),
          const Padding(
            padding: EdgeInsets.only(left: 20, right: 20, bottom: 8),
            child: Text('Agent 用 create_lightweight_app 生成的单页应用，点按在 WebView 打开',
                style: TextStyle(fontSize: 11, color: iosSecondaryLabel)),
          ),
          if (_generatedApps == null)
            const Padding(padding: EdgeInsets.all(24), child: CupertinoActivityIndicator())
          else if (_generatedApps!.isEmpty)
            Container(
              margin: const EdgeInsets.symmetric(horizontal: 16),
              padding: const EdgeInsets.all(24),
              decoration: BoxDecoration(
                color: iosCardBg,
                borderRadius: BorderRadius.circular(12),
              ),
              child: const Column(
                children: [
                  Icon(CupertinoIcons.hammer, size: 36, color: Color(0xFFC7C7CC)),
                  SizedBox(height: 8),
                  Text('还没有生成的应用', style: TextStyle(fontSize: 13, color: iosSecondaryLabel)),
                  SizedBox(height: 4),
                  Text('在对话里让 Agent「做一个记事本应用」试试',
                      style: TextStyle(fontSize: 12, color: iosSecondaryLabel)),
                ],
              ),
            )
          else
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 4,
                  crossAxisSpacing: 12,
                  mainAxisSpacing: 12,
                  childAspectRatio: 0.8,
                ),
                itemCount: _generatedApps!.length,
                itemBuilder: (ctx, i) => _GeneratedAppIcon(
                  app: _generatedApps![i],
                  onOpen: () => Navigator.of(context).push(
                    cupertinoRoute(_LightAppPage(app: _generatedApps![i])),
                  ),
                  onLongPress: () async {
                    await HarnessClient.instance.deleteLightApp(_generatedApps![i].id);
                    _loadGenerated();
                  },
                ),
              ),
            ),
          const Padding(
            padding: EdgeInsets.only(left: 20, right: 20, top: 20, bottom: 8),
            child: Text('网页快捷方式',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, letterSpacing: -0.3)),
          ),
          webApps.when(
            data: (list) => Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 4,
                  crossAxisSpacing: 12,
                  mainAxisSpacing: 12,
                  childAspectRatio: 0.8,
                ),
                itemCount: list.length,
                itemBuilder: (ctx, i) => _AppIcon(
                  app: list[i],
                  onOpen: () => Navigator.of(context).push(
                    cupertinoRoute(_WebviewPage(app: list[i])),
                  ),
                  onLongPress: () => _confirmRemove(context, ref, i),
                ),
              ),
            ),
            loading: () => const SizedBox(height: 60),
            error: (e, _) => Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text('$e', style: const TextStyle(fontSize: 12, color: iosSecondaryLabel)),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _confirmRemove(BuildContext context, WidgetRef ref, int index) async {
    final apps = ref.read(webAppsProvider).value ?? [];
    if (index >= apps.length) return;
    showCupertinoDialog<void>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: Text('移除「${apps[index].name}」？'),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          CupertinoDialogAction(
            isDestructiveAction: true,
            onPressed: () {
              ref.read(webAppsProvider.notifier).removeAt(index);
              Navigator.pop(ctx);
            },
            child: const Text('移除'),
          ),
        ],
      ),
    );
  }

  Future<void> _addApp(BuildContext context, WidgetRef ref) async {
    final nameCtrl = TextEditingController();
    final urlCtrl = TextEditingController();
    await showCupertinoDialog<void>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: const Text('添加网页快捷方式'),
        content: Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Column(children: [
            CupertinoTextField(
              controller: nameCtrl,
              placeholder: '名称',
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            ),
            const SizedBox(height: 8),
            CupertinoTextField(
              controller: urlCtrl,
              placeholder: 'https://example.com',
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            ),
          ]),
        ),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () {
              final url = urlCtrl.text.trim();
              if (url.isEmpty) return;
              ref.read(webAppsProvider.notifier).add(WebApp(
                    name: nameCtrl.text.trim().isEmpty ? url : nameCtrl.text.trim(),
                    url: url.startsWith('http') ? url : 'https://$url',
                  ));
              Navigator.pop(ctx);
            },
            child: const Text('添加'),
          ),
        ],
      ),
    );
  }
}

/// Agent 生成的单页应用图标。
class _GeneratedAppIcon extends StatelessWidget {
  const _GeneratedAppIcon({required this.app, required this.onOpen, required this.onLongPress});

  final LightApp app;
  final VoidCallback onOpen;
  final VoidCallback onLongPress;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onOpen,
      onLongPress: onLongPress,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            width: 58,
            height: 58,
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [iosGreen, iosTeal],
              ),
              borderRadius: BorderRadius.circular(14),
              boxShadow: const [BoxShadow(color: Color(0x2934C759), blurRadius: 8, offset: Offset(0, 3))],
            ),
            child: const Icon(CupertinoIcons.hammer_fill, size: 26, color: Color(0xFFFFFFFF)),
          ),
          const SizedBox(height: 5),
          Text(app.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 11, color: iosLabel)),
        ],
      ),
    );
  }
}

/// 网页快捷方式图标。
class _AppIcon extends StatelessWidget {
  const _AppIcon({required this.app, required this.onOpen, required this.onLongPress});

  final WebApp app;
  final VoidCallback onOpen;
  final VoidCallback onLongPress;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onOpen,
      onLongPress: onLongPress,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            width: 58,
            height: 58,
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [iosBlue, iosIndigo],
              ),
              borderRadius: BorderRadius.circular(14),
              boxShadow: const [BoxShadow(color: Color(0x293D5AFE), blurRadius: 8, offset: Offset(0, 3))],
            ),
            child: const Icon(CupertinoIcons.globe, size: 28, color: Color(0xFFFFFFFF)),
          ),
          const SizedBox(height: 5),
          Text(app.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 11, color: iosLabel)),
        ],
      ),
    );
  }
}

/// 轻应用 WebView 页。
class _LightAppPage extends StatelessWidget {
  const _LightAppPage({required this.app});

  final LightApp app;

  @override
  Widget build(BuildContext context) {
    return CupertinoPageScaffold(
      navigationBar: CupertinoNavigationBar(
        middle: Text(app.name, style: const TextStyle(fontSize: 16)),
        leading: CupertinoButton(
          padding: EdgeInsets.zero,
          onPressed: () => Navigator.pop(context),
          child: const Icon(CupertinoIcons.chevron_left, size: 24, color: iosBlue),
        ),
      ),
      child: SafeArea(
        child: WebViewWidget(
          controller: WebViewController()
            ..setJavaScriptMode(JavaScriptMode.unrestricted)
            ..loadRequest(Uri.parse('${HarnessClient.instance.httpBase}/lightapp/${app.id}')),
        ),
      ),
    );
  }
}

/// 网页快捷方式 WebView 页。
class _WebviewPage extends StatefulWidget {
  const _WebviewPage({required this.app});

  final WebApp app;

  @override
  State<_WebviewPage> createState() => _WebviewPageState();
}

class _WebviewPageState extends State<_WebviewPage> {
  late final WebViewController _controller;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(NavigationDelegate(
        onPageFinished: (url) {
          WebviewControllerHolder.instance.url = url;
          _controller.runJavaScriptReturningResult('document.title').then((t) {
            WebviewControllerHolder.instance.title = t.toString();
          }).catchError((_) {});
        },
      ))
      ..loadRequest(Uri.parse(widget.app.url));
    WebviewControllerHolder.instance.controller = _controller;
    WebviewControllerHolder.instance.url = widget.app.url;
  }

  @override
  void dispose() {
    WebviewControllerHolder.instance.controller = null;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return CupertinoPageScaffold(
      navigationBar: CupertinoNavigationBar(
        middle: Text(widget.app.name, style: const TextStyle(fontSize: 16)),
        leading: CupertinoButton(
          padding: EdgeInsets.zero,
          onPressed: () => Navigator.pop(context),
          child: const Icon(CupertinoIcons.chevron_left, size: 24, color: iosBlue),
        ),
        trailing: CupertinoButton(
          padding: const EdgeInsets.all(4),
          onPressed: () => _controller.reload(),
          child: const Icon(CupertinoIcons.refresh, size: 22, color: iosBlue),
        ),
      ),
      child: SafeArea(child: WebViewWidget(controller: _controller)),
    );
  }
}
