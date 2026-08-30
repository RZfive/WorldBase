import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../app/host_bridge_ui.dart';
import '../../core/glass.dart';
import '../../core/ios_ui.dart';
import '../../core/providers.dart';

/// 应用页(晨昏 2.0):Agent 生成的轻应用与网页快捷方式合并为一个网格,
/// 不再分类、无默认条目。长按删除,右上角添加网页快捷方式。
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
    // 连接建立/恢复后重载(首帧时 WS 可能尚未就绪)
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
    // 版本号变化(工具生成新应用)→ 刷新轻应用列表
    ref.listen(lightAppsVersionProvider, (_, _) => _loadGenerated());
    final webApps = ref.watch(webAppsProvider).value ?? const <WebApp>[];

    final generated = _generatedApps;
    final loading = generated == null;
    final empty = !loading && generated.isEmpty && webApps.isEmpty;

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
          if (loading)
            const Padding(padding: EdgeInsets.all(24), child: CupertinoActivityIndicator())
          else if (empty)
            _EmptyApps()
          else
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 4,
                  crossAxisSpacing: 12,
                  mainAxisSpacing: 14,
                  childAspectRatio: 0.78,
                ),
                itemCount: generated.length + webApps.length,
                itemBuilder: (ctx, i) {
                  if (i < generated.length) {
                    final app = generated[i];
                    return _AppIcon(
                      name: app.name,
                      onOpen: () => Navigator.of(context).push(
                        cupertinoRoute(_LightAppPage(app: app)),
                      ),
                      onLongPress: () => _confirmRemoveGenerated(context, app),
                    );
                  }
                  final web = webApps[i - generated.length];
                  return _AppIcon(
                    name: web.name,
                    onOpen: () => Navigator.of(context).push(
                      cupertinoRoute(_WebviewPage(app: web)),
                    ),
                    onLongPress: () =>
                        _confirmRemoveWeb(context, ref, i - generated.length),
                  );
                },
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _confirmRemoveGenerated(BuildContext context, LightApp app) async {
    _confirmRemove(
      context,
      name: app.name,
      onRemove: () async {
        await HarnessClient.instance.deleteLightApp(app.id);
        _loadGenerated();
      },
    );
  }

  Future<void> _confirmRemoveWeb(BuildContext context, WidgetRef ref, int index) async {
    final apps = ref.read(webAppsProvider).value ?? [];
    if (index >= apps.length) return;
    _confirmRemove(
      context,
      name: apps[index].name,
      onRemove: () async => ref.read(webAppsProvider.notifier).removeAt(index),
    );
  }

  void _confirmRemove(BuildContext context,
      {required String name, required Future<void> Function() onRemove}) {
    showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        title: Text(name),
        actions: [
          CupertinoActionSheetAction(
            isDestructiveAction: true,
            onPressed: () async {
              Navigator.pop(ctx);
              await onRemove();
            },
            child: const Text('删除'),
          ),
        ],
        cancelButton: CupertinoActionSheetAction(
          onPressed: () => Navigator.pop(ctx),
          child: const Text('取消'),
        ),
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

/// 统一的应用图标:晨昏渐变首字块(不区分轻应用/网页)。
class _AppIcon extends StatelessWidget {
  const _AppIcon({required this.name, required this.onOpen, required this.onLongPress});

  final String name;
  final VoidCallback onOpen;
  final VoidCallback onLongPress;

  static const _gradients = [
    [Color(0xFF5B6BE0), Color(0xFF9A6BD6)],
    [Color(0xFF9A6BD6), Color(0xFFE8826B)],
    [Color(0xFFE8826B), Color(0xFFE8A26B)],
    [Color(0xFF5B6BE0), Color(0xFFE8826B)],
  ];

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    final gradient = _gradients[name.hashCode.abs() % _gradients.length];
    final monogram = name.isEmpty ? '?' : name.characters.first.toUpperCase();
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
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: gradient,
              ),
              borderRadius: BorderRadius.circular(16),
              boxShadow: [
                BoxShadow(
                  color: gradient.first.withValues(alpha: 0.3),
                  blurRadius: 10,
                  offset: const Offset(0, 4),
                ),
              ],
            ),
            alignment: Alignment.center,
            child: Text(
              monogram,
              style: const TextStyle(
                fontSize: 24,
                fontWeight: FontWeight.w600,
                color: Color(0xFFFFFFFF),
              ),
            ),
          ),
          const SizedBox(height: 5),
          Text(name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 11, color: p.ink)),
        ],
      ),
    );
  }
}

/// 空态:一个应用都没有时。
class _EmptyApps extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      padding: const EdgeInsets.all(28),
      decoration: BoxDecoration(
        color: p.cardBg,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        children: [
          Icon(CupertinoIcons.square_grid_2x2, size: 38, color: p.ink3),
          const SizedBox(height: 10),
          Text('还没有应用', style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: p.ink)),
          const SizedBox(height: 4),
          Text('在对话里让 Agent「做一个记事本应用」,\n或点右上角添加网页快捷方式',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12, color: p.ink2, height: 1.5)),
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
    final p = DawnPalette.of(context);
    return CupertinoPageScaffold(
      navigationBar: CupertinoNavigationBar(
        middle: Text(app.name, style: const TextStyle(fontSize: 16)),
        leading: CupertinoButton(
          padding: EdgeInsets.zero,
          onPressed: () => Navigator.pop(context),
          child: Icon(CupertinoIcons.chevron_left, size: 24, color: p.indigo),
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
    final p = DawnPalette.of(context);
    return CupertinoPageScaffold(
      navigationBar: CupertinoNavigationBar(
        middle: Text(widget.app.name, style: const TextStyle(fontSize: 16)),
        leading: CupertinoButton(
          padding: EdgeInsets.zero,
          onPressed: () => Navigator.pop(context),
          child: Icon(CupertinoIcons.chevron_left, size: 24, color: p.indigo),
        ),
        trailing: CupertinoButton(
          padding: const EdgeInsets.all(4),
          onPressed: () => _controller.reload(),
          child: Icon(CupertinoIcons.refresh, size: 22, color: p.indigo),
        ),
      ),
      child: SafeArea(child: WebViewWidget(controller: _controller)),
    );
  }
}
