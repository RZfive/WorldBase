import 'dart:async';
import 'dart:convert';

import 'package:flutter/cupertino.dart';
import '../../core/ios_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../core/glass.dart';
import '../core/harness_client.dart';

/// 活跃 WebView 控制器持有者：供页面自动化反向请求使用。
class WebviewControllerHolder {
  WebviewControllerHolder._();

  static final WebviewControllerHolder instance = WebviewControllerHolder._();

  WebViewController? controller;
  String title = '';
  String url = '';
}

/// 执行页面自动化动作（对齐桌面 page-automation 语义的移动端子集）。
Future<dynamic> runPageAutomation(Map<String, dynamic> payload) async {
  final controller = WebviewControllerHolder.instance.controller;
  if (controller == null) {
    return {'ok': false, 'error': '没有活跃的 WebView 页面，请先在「应用」中打开一个轻应用'};
  }
  final action = payload['action'] as String? ?? 'read';
  if (action == 'read') {
    final extractJs = '''
      JSON.stringify({
        url: location.href,
        title: document.title,
        textPreview: (document.body.innerText || '').slice(0, 2000),
        interactiveElements: Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"]')).slice(0, 30).map((el, i) => ({
          index: i,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          text: (el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 60),
          selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : el.tagName.toLowerCase() + ':nth-of-type(' + (i+1) + ')'),
        })),
      })
    ''';
    final result = await controller.runJavaScriptReturningResult(extractJs);
    final raw = result.toString();
    final decoded = raw.startsWith('"') ? jsonDecode(raw) : raw;
    return {'ok': true, 'page': jsonDecode(decoded as String)};
  } else if (action == 'interact') {
    final actions = (payload['actions'] as List?)?.cast<Map>() ?? [];
    final results = <String>[];
    for (final a in actions) {
      final type = a['type'] as String? ?? '';
      final selector = a['selector'] as String? ?? '';
      switch (type) {
        case 'click':
          await controller.runJavaScriptReturningResult(
              'document.querySelector(${_jsStr(selector)})?.click(); "ok"');
          results.add('click:$selector');
        case 'input' || 'fill':
          final value = a['value'] as String? ?? '';
          await controller.runJavaScriptReturningResult('''
            (() => { const el = document.querySelector(${_jsStr(selector)});
              if (!el) return 'not-found';
              el.focus(); el.value = ${_jsStr(value)};
              el.dispatchEvent(new Event('input', {bubbles: true}));
              el.dispatchEvent(new Event('change', {bubbles: true}));
              return 'ok'; })()
          ''');
          results.add('input:$selector');
        case 'scroll':
          final dy = (a['dy'] as num?)?.toInt() ?? 400;
          await controller.runJavaScriptReturningResult('window.scrollBy(0, $dy); "ok"');
          results.add('scroll:$dy');
        case 'evaluate':
          final js = a['js'] as String? ?? '';
          final r = await controller.runJavaScriptReturningResult(js);
          results.add('evaluate:${r.toString()}');
        default:
          results.add('unknown:$type');
      }
    }
    return {'ok': true, 'results': results};
  }
  return {'ok': false, 'error': 'unknown action: $action'};
}

String _jsStr(String s) => "'" + s.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";

/// 全局弹层：权限确认 + ask_user 反向请求 + 页面自动化反向请求。
class GlobalDialogHost extends ConsumerStatefulWidget {
  const GlobalDialogHost({required this.child, super.key});

  final Widget child;

  @override
  ConsumerState<GlobalDialogHost> createState() => _GlobalDialogHostState();
}

class _GlobalDialogHostState extends ConsumerState<GlobalDialogHost> {
  StreamSubscription<PendingPermission>? _permSub;
  StreamSubscription<HostRequest>? _hostSub;

  @override
  void initState() {
    super.initState();
    _permSub = HarnessClient.instance.permissionRequests.listen(_showPermissionDialog);
    _hostSub = HarnessClient.instance.hostRequests.listen(_handleHostRequest);
  }

  @override
  void dispose() {
    _permSub?.cancel();
    _hostSub?.cancel();
    super.dispose();
  }

  void _showPermissionDialog(PendingPermission req) {
    if (!mounted) return;
    final p = DawnPalette.of(context);
    showCupertinoDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => CupertinoAlertDialog(
        title: Text('「${req.toolName}」请求执行'),
        content: Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Text(req.argsSummary, style: TextStyle(fontSize: 13, color: p.ink2)),
        ),
        actions: [
          CupertinoDialogAction(
            onPressed: () {
              Navigator.of(ctx).pop();
              HarnessClient.instance.respondPermission(req.requestId, false);
            },
            child: const Text('拒绝', style: TextStyle(color: iosRed)),
          ),
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () {
              Navigator.of(ctx).pop();
              HarnessClient.instance.respondPermission(req.requestId, true);
            },
            child: const Text('允许', style: TextStyle(color: iosBlue, fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
  }

  Future<void> _handleHostRequest(HostRequest req) async {
    if (req.kind == 'ask_user') {
      final question = req.payload['question'] as String? ?? '';
      final choices = (req.payload['choices'] as List?)?.cast<String>() ?? const [];
      if (!mounted) return;
      final answer = await showCupertinoDialog<String>(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => CupertinoAlertDialog(
          title: const Text('Agent 想问你'),
          content: Padding(
            padding: EdgeInsets.only(top: 8),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(question, style: const TextStyle(fontSize: 14)),
                const SizedBox(height: 10),
                ...choices.map((c) => GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: () => Navigator.of(ctx).pop(c),
                      child: Container(
                        width: double.infinity,
                        padding: const EdgeInsets.symmetric(vertical: 9),
                        child: Text(c,
                            textAlign: TextAlign.center,
                            style: const TextStyle(fontSize: 15, color: iosBlue)),
                      ),
                    )),
              ],
            ),
          ),
          actions: [
            CupertinoDialogAction(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('忽略'),
            ),
          ],
        ),
      );
      await HarnessClient.instance.respondHost(req.requestId,
          answer != null ? {'answer': answer} : {'answer': '', 'ignored': true});
    } else if (req.kind == 'page_automation') {
      final result = await runPageAutomation(req.payload);
      await HarnessClient.instance.respondHost(req.requestId, result);
    } else {
      await HarnessClient.instance
          .respondHost(req.requestId, {'ok': false, 'error': 'unknown host request: ${req.kind}'});
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
