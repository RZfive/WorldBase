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

const _pageActionTypes = {
  'click',
  'input',
  'fill',
  'select',
  'batch_input',
  'extract',
  'evaluate',
  'hover',
  'focus',
  'press_key',
  'scroll',
  'wait',
};

/// Normalizes both the native mobile action envelope and Electron's canonical
/// single-action fields. Kept public so the host contract can be unit-tested.
List<Map<String, dynamic>> normalizePageAutomationActions(
  Map<String, dynamic> payload,
) {
  final envelopeAction = payload['action'] as String? ?? 'read';
  final rawActions = envelopeAction == 'interact'
      ? (payload['actions'] as List? ?? const [])
      : _pageActionTypes.contains(envelopeAction)
      ? [
          <String, dynamic>{...payload, 'type': envelopeAction},
        ]
      : const <dynamic>[];
  return rawActions.whereType<Map>().map((raw) {
    final action = raw.cast<String, dynamic>();
    final type = (action['type'] ?? action['action']) as String? ?? '';
    return switch (type) {
      'fill' || 'input' => <String, dynamic>{
        ...action,
        'type': 'input',
        'text': action['text'] ?? action['value'] ?? '',
        'append': action['append'] == true,
      },
      'scroll' => <String, dynamic>{
        ...action,
        'type': type,
        'top': action['top'] ?? action['dy'] ?? 0,
        'left': action['left'] ?? action['dx'] ?? 0,
      },
      'evaluate' => <String, dynamic>{
        ...action,
        'type': type,
        'script': action['script'] ?? action['js'] ?? '',
      },
      'extract' => <String, dynamic>{
        ...action,
        'type': type,
        'maxChars': action['maxChars'] ?? action['max_chars'] ?? 60000,
      },
      'wait' => <String, dynamic>{
        ...action,
        'type': type,
        'timeoutMs': action['timeoutMs'] ?? action['timeout_ms'] ?? 0,
      },
      'batch_input' => <String, dynamic>{
        ...action,
        'type': type,
        'fields': (action['fields'] as List? ?? const [])
            .whereType<Map>()
            .map(
              (field) => <String, dynamic>{
                ...field.cast<String, dynamic>(),
                'text': field['text'] ?? field['value'] ?? '',
                'append': field['append'] == true,
              },
            )
            .toList(),
      },
      _ => <String, dynamic>{...action, 'type': type},
    };
  }).toList();
}

/// Executes the same page automation contract used by Electron.
Future<dynamic> runPageAutomation(Map<String, dynamic> payload) async {
  final controller = WebviewControllerHolder.instance.controller;
  if (controller == null) {
    return {'ok': false, 'error': '没有活跃的 WebView 页面，请先在「应用」中打开一个轻应用'};
  }
  final envelopeAction = payload['action'] as String? ?? 'read';
  if (envelopeAction == 'read') {
    final requested =
        (payload['maxChars'] ?? payload['max_chars']) as num? ?? 12000;
    final page = await _capturePageSnapshot(
      controller,
      maxChars: requested.toInt().clamp(400, 60000),
    );
    return {'ok': true, 'page': page};
  }

  final actions = normalizePageAutomationActions(payload);
  if (actions.isEmpty) {
    return {'ok': false, 'error': 'unknown action: $envelopeAction'};
  }
  final results = <Map<String, dynamic>>[];
  for (final action in actions) {
    results.add(await _runPageAction(controller, action));
  }
  final ok = results.every((result) => result['ok'] == true);
  final response = <String, dynamic>{'ok': ok};
  if (results.length == 1) response.addAll(results.single);
  response['results'] = results;
  if (!ok) {
    response['error'] = results
        .where((result) => result['ok'] != true)
        .map((result) => result['error'])
        .whereType<String>()
        .join('; ');
  }
  try {
    response['page'] = await _capturePageSnapshot(controller);
  } catch (_) {}
  return response;
}

Future<Map<String, dynamic>> _capturePageSnapshot(
  WebViewController controller, {
  int maxChars = 12000,
}) async {
  final result = await controller.runJavaScriptReturningResult('''
    (() => {
      const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const escapeCss = (value) => (globalThis.CSS && typeof CSS.escape === 'function')
        ? CSS.escape(String(value))
        : String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => '\\\\' + character);
      const buildSelector = (element) => {
        if (!(element instanceof Element)) return null;
        if (element.id) return '#' + escapeCss(element.id);
        const tokens = [
          ['data-testid', element.getAttribute('data-testid')],
          ['data-test', element.getAttribute('data-test')],
          ['data-id', element.getAttribute('data-id')],
          ['name', element.getAttribute('name')],
          ['aria-label', element.getAttribute('aria-label')],
          ['aria-labelledby', element.getAttribute('aria-labelledby')],
          ['placeholder', element.getAttribute('placeholder')],
          ['title', element.getAttribute('title')],
        ].filter((entry) => entry[1]);
        if (tokens.length > 0) {
          const token = tokens[0];
          return element.tagName.toLowerCase() + '[' + token[0] + '="' + escapeCss(token[1]) + '"]';
        }
        const path = [];
        let node = element;
        while (node instanceof Element && path.length < 6) {
          let segment = node.tagName.toLowerCase();
          if (segment === 'html' || segment === 'body') {
            path.unshift(segment);
            break;
          }
          const parent = node.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
            if (siblings.length > 1) segment += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
          }
          path.unshift(segment);
          node = parent;
        }
        return path.join(' > ');
      };
      const findLabel = (element) => {
        if (element.id) {
          const label = document.querySelector('label[for="' + escapeCss(element.id) + '"]');
          if (label) return normalizeText(label.textContent);
        }
        let parent = element.parentElement;
        for (let index = 0; index < 3 && parent; index++) {
          if (parent.tagName.toLowerCase() === 'label') return normalizeText(parent.textContent);
          parent = parent.parentElement;
        }
        const labelledBy = element.getAttribute('aria-labelledby');
        const labelledElement = labelledBy ? document.getElementById(labelledBy) : null;
        return labelledElement ? normalizeText(labelledElement.textContent) : null;
      };
      const interactiveElements = Array.from(document.querySelectorAll(
        'a,button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[onclick]'
      )).slice(0, 64).map((element) => ({
        selector: buildSelector(element),
        tag: element.tagName.toLowerCase(),
        text: normalizeText(element.textContent || element.getAttribute('value') || element.getAttribute('placeholder') || element.getAttribute('aria-label')).slice(0, 240),
        role: element.getAttribute('role'),
      })).filter((entry) => Boolean(entry.selector));
      const formFields = Array.from(document.querySelectorAll('input,textarea,select'))
        .slice(0, 64).map((element) => {
          const field = {
            selector: buildSelector(element),
            tag: element.tagName.toLowerCase(),
            type: element.getAttribute('type') || null,
            name: element.getAttribute('name') || null,
            label: findLabel(element),
            placeholder: element.getAttribute('placeholder') || null,
            value: element.value || '',
          };
          if (element instanceof HTMLSelectElement) {
            field.options = Array.from(element.options).map((option) => ({
              value: option.value,
              label: normalizeText(option.textContent || option.value || ''),
            }));
          }
          return field;
        }).filter((entry) => Boolean(entry.selector));
      const rawText = normalizeText(document.body?.innerText || '');
      return JSON.stringify({
        url: location.href,
        title: document.title,
        origin: location.origin || null,
        textPreview: rawText.slice(0, $maxChars),
        fullTextAvailable: rawText.length <= $maxChars,
        interactiveElements,
        formFields,
        capturedAt: Date.now(),
      });
    })()
  ''');
  return _decodeJavaScriptMap(result);
}

Future<Map<String, dynamic>> _runPageAction(
  WebViewController controller,
  Map<String, dynamic> action,
) async {
  final type = action['type'] as String? ?? '';
  if (type == 'wait') {
    final timeout = ((action['timeoutMs'] as num?)?.toInt() ?? 0).clamp(
      0,
      30000,
    );
    await Future<void>.delayed(Duration(milliseconds: timeout));
    return {'ok': true, 'type': type, 'timeoutMs': timeout};
  }
  final encoded = jsonEncode(sanitizeJsonForTransport(action));
  try {
    final result = await controller.runJavaScriptReturningResult('''
      (() => {
        const payload = $encoded;
        const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const ensureElement = (selector) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error('Element not found for selector: ' + selector);
          return element;
        };
        const setInputValue = (element, text, append) => {
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
            throw new Error('Selected element does not accept text input: ' + payload.selector);
          }
          element.focus();
          const nextValue = append ? element.value + String(text || '') : String(text || '');
          element.value = nextValue;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return nextValue.length;
        };
        try {
          let output;
          switch (payload.type) {
            case 'click': {
              const element = ensureElement(payload.selector);
              element.scrollIntoView({ block: 'center', inline: 'center' });
              element.click();
              output = { ok: true, type: payload.type, selector: payload.selector };
              break;
            }
            case 'input': {
              const element = ensureElement(payload.selector);
              output = { ok: true, type: payload.type, selector: payload.selector,
                textLength: setInputValue(element, payload.text, Boolean(payload.append)) };
              break;
            }
            case 'select': {
              const element = ensureElement(payload.selector);
              if (!(element instanceof HTMLSelectElement)) throw new Error('Selected element is not a <select>');
              if (typeof payload.value === 'string') {
                element.value = payload.value;
              } else if (typeof payload.label === 'string') {
                const match = Array.from(element.options).find((option) =>
                  normalizeText(option.textContent) === payload.label || option.value === payload.label);
                if (!match) throw new Error('No option matched label: ' + payload.label);
                element.value = match.value;
              } else if (typeof payload.index === 'number') {
                if (payload.index < 0 || payload.index >= element.options.length) throw new Error('Option index out of range');
                element.value = element.options[payload.index].value;
              } else {
                throw new Error('select requires value, label, or index');
              }
              element.dispatchEvent(new Event('change', { bubbles: true }));
              output = { ok: true, type: payload.type, selector: payload.selector };
              break;
            }
            case 'batch_input': {
              if (!Array.isArray(payload.fields)) throw new Error('batch_input requires a fields array');
              let filled = 0;
              let skipped = 0;
              for (const field of payload.fields) {
                const element = document.querySelector(field?.selector || '');
                if (!element) { skipped++; continue; }
                try {
                  if (element instanceof HTMLSelectElement) {
                    element.value = String(field.text || '');
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                  } else {
                    setInputValue(element, field.text, Boolean(field.append));
                  }
                  filled++;
                } catch (_) { skipped++; }
              }
              output = { ok: true, type: payload.type, filled, skipped };
              break;
            }
            case 'extract': {
              const element = typeof payload.selector === 'string' && payload.selector.trim()
                ? ensureElement(payload.selector) : document.body;
              const text = normalizeText(element?.innerText || '');
              const offset = Math.max(0, Number(payload.offset) || 0);
              const limit = Number(payload.maxChars) > 0 ? Number(payload.maxChars) : 60000;
              const slice = text.slice(offset, offset + limit);
              output = { ok: true, type: payload.type, selector: payload.selector,
                text: slice, offset, truncated: offset + slice.length < text.length, totalLength: text.length };
              break;
            }
            case 'evaluate': {
              if (typeof payload.script !== 'string' || !payload.script.trim()) throw new Error('evaluate requires a non-empty script string');
              output = { ok: true, type: payload.type, result: eval(payload.script) };
              break;
            }
            case 'hover': {
              const element = ensureElement(payload.selector);
              element.scrollIntoView({ block: 'center', inline: 'center' });
              element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
              element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
              output = { ok: true, type: payload.type, selector: payload.selector };
              break;
            }
            case 'focus': {
              ensureElement(payload.selector).focus();
              output = { ok: true, type: payload.type, selector: payload.selector };
              break;
            }
            case 'press_key': {
              const element = payload.selector ? ensureElement(payload.selector) : (document.activeElement || document.body);
              element.focus();
              element.dispatchEvent(new KeyboardEvent('keydown', { key: payload.key, bubbles: true }));
              element.dispatchEvent(new KeyboardEvent('keypress', { key: payload.key, bubbles: true }));
              if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
                if (String(payload.key || '').length === 1) element.value += payload.key;
                else if (payload.key === 'Backspace') element.value = element.value.slice(0, -1);
                element.dispatchEvent(new Event('input', { bubbles: true }));
              }
              element.dispatchEvent(new KeyboardEvent('keyup', { key: payload.key, bubbles: true }));
              output = { ok: true, type: payload.type, selector: payload.selector, key: payload.key };
              break;
            }
            case 'scroll': {
              window.scrollTo({ top: Number(payload.top) || 0, left: Number(payload.left) || 0, behavior: 'auto' });
              output = { ok: true, type: payload.type, top: window.scrollY, left: window.scrollX };
              break;
            }
            default:
              throw new Error('Unsupported browser automation action: ' + payload.type);
          }
          return JSON.stringify(output);
        } catch (error) {
          return JSON.stringify({ ok: false, type: payload.type, error: String(error?.message || error) });
        }
      })()
    ''');
    return _decodeJavaScriptMap(result);
  } catch (error) {
    return {'ok': false, 'type': type, 'error': error.toString()};
  }
}

Map<String, dynamic> _decodeJavaScriptMap(Object result) {
  Object? decoded = result;
  for (var attempt = 0; attempt < 2 && decoded is String; attempt++) {
    decoded = jsonDecode(decoded);
  }
  if (decoded is Map) return decoded.cast<String, dynamic>();
  throw const FormatException('page automation returned a non-object result');
}

class AskUserQuestion {
  const AskUserQuestion({
    required this.id,
    required this.question,
    required this.options,
  });

  final String id;
  final String question;
  final List<String> options;
}

List<String> _askUserOptions(Object? value) {
  if (value is! List) return const [];
  final seen = <String>{};
  return value
      .whereType<String>()
      .map((option) => option.trim())
      .where((option) => option.isNotEmpty && seen.add(option))
      .take(4)
      .toList();
}

/// Accepts the bundled Rust payload and the previous single-question shape.
List<AskUserQuestion> normalizeAskUserQuestions(Map<String, dynamic> payload) {
  final rawQuestions = payload['questions'] is List
      ? payload['questions'] as List
      : [
          {'question': payload['question'], 'options': payload['choices']},
        ];
  final questions = <AskUserQuestion>[];
  for (final raw in rawQuestions.take(4)) {
    if (raw is! Map) continue;
    final item = raw.cast<Object?, Object?>();
    final question = item['question'] is String
        ? (item['question'] as String).trim()
        : '';
    final options = _askUserOptions(item['options'] ?? item['choices']);
    if (question.isEmpty || options.isEmpty) continue;
    final rawId = item['id'];
    questions.add(
      AskUserQuestion(
        id: rawId is String && rawId.trim().isNotEmpty
            ? rawId.trim()
            : 'q_${questions.length + 1}',
        question: question,
        options: options,
      ),
    );
  }
  return questions;
}

Map<String, dynamic> buildAskUserResponse(
  List<AskUserQuestion> questions,
  List<String> answers,
) => {
  'answers': [
    for (var index = 0; index < questions.length; index++)
      {
        'question': questions[index].question,
        'answer': index < answers.length ? answers[index].trim() : '',
      },
  ],
};

class AskUserDialog extends StatefulWidget {
  const AskUserDialog({required this.questions, super.key});

  final List<AskUserQuestion> questions;

  @override
  State<AskUserDialog> createState() => _AskUserDialogState();
}

class _AskUserDialogState extends State<AskUserDialog> {
  late final List<TextEditingController> _customControllers;
  late final List<String?> _selectedOptions;

  @override
  void initState() {
    super.initState();
    _customControllers = [
      for (var index = 0; index < widget.questions.length; index++)
        TextEditingController(),
    ];
    _selectedOptions = List<String?>.filled(widget.questions.length, null);
  }

  @override
  void dispose() {
    for (final controller in _customControllers) {
      controller.dispose();
    }
    super.dispose();
  }

  String _answerAt(int index) {
    final custom = _customControllers[index].text.trim();
    return custom.isNotEmpty ? custom : (_selectedOptions[index] ?? '');
  }

  bool get _complete => List.generate(
    widget.questions.length,
    _answerAt,
  ).every((answer) => answer.isNotEmpty);

  void _select(int questionIndex, String option) {
    setState(() {
      _selectedOptions[questionIndex] = option;
      _customControllers[questionIndex].clear();
    });
  }

  void _submit() {
    Navigator.of(context).pop(<String>[
      for (var index = 0; index < widget.questions.length; index++)
        _answerAt(index),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final maxHeight = MediaQuery.sizeOf(context).height * 0.58;
    return CupertinoAlertDialog(
      title: const Text('Agent 想问你'),
      content: Padding(
        padding: const EdgeInsets.only(top: 10),
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: maxHeight),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (
                  var questionIndex = 0;
                  questionIndex < widget.questions.length;
                  questionIndex++
                ) ...[
                  if (questionIndex > 0) const SizedBox(height: 16),
                  Text(
                    '${questionIndex + 1}. ${widget.questions[questionIndex].question}',
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 6),
                  for (
                    var optionIndex = 0;
                    optionIndex <
                        widget.questions[questionIndex].options.length;
                    optionIndex++
                  )
                    SizedBox(
                      width: double.infinity,
                      child: CupertinoButton(
                        key: ValueKey(
                          'ask-user-option-$questionIndex-$optionIndex',
                        ),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 7,
                        ),
                        onPressed: () => _select(
                          questionIndex,
                          widget.questions[questionIndex].options[optionIndex],
                        ),
                        child: Row(
                          children: [
                            Icon(
                              _selectedOptions[questionIndex] ==
                                      widget
                                          .questions[questionIndex]
                                          .options[optionIndex]
                                  ? CupertinoIcons.check_mark_circled_solid
                                  : CupertinoIcons.circle,
                              size: 18,
                            ),
                            const SizedBox(width: 7),
                            Expanded(
                              child: Text(
                                widget
                                    .questions[questionIndex]
                                    .options[optionIndex],
                                textAlign: TextAlign.left,
                                style: const TextStyle(fontSize: 14),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  const SizedBox(height: 4),
                  CupertinoTextField(
                    key: ValueKey('ask-user-custom-$questionIndex'),
                    controller: _customControllers[questionIndex],
                    placeholder: '其他（自定义回答）',
                    minLines: 1,
                    maxLines: 2,
                    onChanged: (value) {
                      setState(() {
                        if (value.trim().isNotEmpty) {
                          _selectedOptions[questionIndex] = null;
                        }
                      });
                    },
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
      actions: [
        CupertinoDialogAction(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('忽略'),
        ),
        CupertinoDialogAction(
          key: const ValueKey('ask-user-submit'),
          isDefaultAction: true,
          onPressed: _complete ? _submit : null,
          child: const Text('提交'),
        ),
      ],
    );
  }
}

/// 全局弹层：权限确认 + ask_user 反向请求 + 页面自动化反向请求。
class GlobalDialogHost extends ConsumerStatefulWidget {
  const GlobalDialogHost({required this.child, super.key});

  final Widget child;

  @override
  ConsumerState<GlobalDialogHost> createState() => _GlobalDialogHostState();
}

class _QueuedHostDialog {
  _QueuedHostDialog.permission(PendingPermission request)
    : streamId = request.streamId,
      requestId = request.requestId,
      permission = request,
      hostRequest = null;

  _QueuedHostDialog.askUser(HostRequest request)
    : streamId = request.streamId,
      requestId = request.requestId,
      permission = null,
      hostRequest = request;

  final String streamId;
  final String requestId;
  final PendingPermission? permission;
  final HostRequest? hostRequest;

  bool cancelled = false;
  NavigatorState? navigator;
  Route<dynamic>? route;
}

class _GlobalDialogHostState extends ConsumerState<GlobalDialogHost> {
  StreamSubscription<PendingPermission>? _permSub;
  StreamSubscription<HostRequest>? _hostSub;
  StreamSubscription<EventFrame>? _eventSub;
  final List<_QueuedHostDialog> _dialogQueue = [];
  final Set<String> _terminalStreams = {};
  _QueuedHostDialog? _activeDialog;
  bool _disposing = false;

  @override
  void initState() {
    super.initState();
    _permSub = HarnessClient.instance.permissionRequests.listen(
      (request) => _enqueueDialog(_QueuedHostDialog.permission(request)),
    );
    _hostSub = HarnessClient.instance.hostRequests.listen(_handleHostRequest);
    _eventSub = HarnessClient.instance.events.listen(_handleEvent);
  }

  @override
  void dispose() {
    _disposing = true;
    _permSub?.cancel();
    _hostSub?.cancel();
    _eventSub?.cancel();
    for (final request in _dialogQueue) {
      request.cancelled = true;
    }
    _dialogQueue.clear();
    final active = _activeDialog;
    if (active != null) _cancelDialog(active);
    super.dispose();
  }

  void _enqueueDialog(_QueuedHostDialog request) {
    if (_disposing ||
        request.requestId.isEmpty ||
        _terminalStreams.contains(request.streamId)) {
      return;
    }
    _dialogQueue.add(request);
    _drainDialogQueue();
  }

  void _drainDialogQueue() {
    if (_disposing || !mounted || _activeDialog != null) return;
    while (_dialogQueue.isNotEmpty) {
      final request = _dialogQueue.removeAt(0);
      if (request.cancelled || _terminalStreams.contains(request.streamId)) {
        continue;
      }
      _activeDialog = request;
      unawaited(_runDialog(request));
      return;
    }
  }

  void _handleEvent(EventFrame frame) {
    if (frame.kind != 'done' && frame.kind != 'error') return;
    final streamId = frame.streamId;
    if (streamId.isEmpty) return;
    _terminalStreams.add(streamId);
    if (_terminalStreams.length > 512) {
      _terminalStreams.remove(_terminalStreams.first);
    }

    for (final request in _dialogQueue) {
      if (request.streamId == streamId) request.cancelled = true;
    }
    _dialogQueue.removeWhere((request) => request.streamId == streamId);

    final active = _activeDialog;
    if (active != null && active.streamId == streamId) {
      _cancelDialog(active);
    }
  }

  void _cancelDialog(_QueuedHostDialog request) {
    request.cancelled = true;
    final route = request.route;
    final navigator = request.navigator;
    if (route != null && navigator != null && route.isActive) {
      navigator.removeRoute(route);
    }
  }

  bool _canRespond(_QueuedHostDialog request) =>
      !_disposing &&
      mounted &&
      !request.cancelled &&
      !_terminalStreams.contains(request.streamId);

  Future<T?> _pushDialog<T>(_QueuedHostDialog request, WidgetBuilder builder) {
    final navigator = Navigator.of(context, rootNavigator: true);
    final route = CupertinoDialogRoute<T>(
      context: context,
      barrierDismissible: false,
      builder: builder,
    );
    request.navigator = navigator;
    request.route = route;
    return navigator.push<T>(route).whenComplete(() {
      if (identical(request.route, route)) {
        request.route = null;
        request.navigator = null;
      }
    });
  }

  Future<void> _runDialog(_QueuedHostDialog request) async {
    try {
      final permission = request.permission;
      if (permission != null) {
        final p = DawnPalette.of(context);
        final allow = await _pushDialog<bool>(
          request,
          (ctx) => CupertinoAlertDialog(
            title: Text('「${permission.toolName}」请求执行'),
            content: Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                permission.argsSummary,
                style: TextStyle(fontSize: 13, color: p.ink2),
              ),
            ),
            actions: [
              CupertinoDialogAction(
                onPressed: () => Navigator.of(ctx).pop(false),
                child: const Text('拒绝', style: TextStyle(color: iosRed)),
              ),
              CupertinoDialogAction(
                isDefaultAction: true,
                onPressed: () => Navigator.of(ctx).pop(true),
                child: const Text(
                  '允许',
                  style: TextStyle(color: iosBlue, fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ),
        );
        if (allow != null && _canRespond(request)) {
          await HarnessClient.instance.respondPermission(
            permission.requestId,
            allow,
          );
        }
        return;
      }

      final hostRequest = request.hostRequest!;
      final questions = normalizeAskUserQuestions(hostRequest.payload);
      if (questions.isEmpty) {
        if (_canRespond(request)) {
          await HarnessClient.instance.respondHost(hostRequest.requestId, {
            'answers': const [],
            'error': 'ask_user payload has no valid questions',
          });
        }
        return;
      }
      final answers = await _pushDialog<List<String>>(
        request,
        (_) => AskUserDialog(questions: questions),
      );
      if (_canRespond(request)) {
        await HarnessClient.instance.respondHost(
          hostRequest.requestId,
          answers != null
              ? buildAskUserResponse(questions, answers)
              : {'answers': const [], 'ignored': true},
        );
      }
    } catch (_) {
      // A disconnect or teardown can invalidate a response after the dialog
      // closes. The stream lifecycle remains authoritative in that case.
    } finally {
      if (identical(_activeDialog, request)) _activeDialog = null;
      _drainDialogQueue();
    }
  }

  void _handleHostRequest(HostRequest req) {
    if (req.kind == 'ask_user') {
      _enqueueDialog(_QueuedHostDialog.askUser(req));
    } else {
      unawaited(_handleNonDialogHostRequest(req));
    }
  }

  Future<void> _handleNonDialogHostRequest(HostRequest req) async {
    if (_disposing || _terminalStreams.contains(req.streamId)) return;
    final result = req.kind == 'page_automation'
        ? await runPageAutomation(req.payload)
        : {'ok': false, 'error': 'unknown host request: ${req.kind}'};
    if (_disposing || !mounted || _terminalStreams.contains(req.streamId)) {
      return;
    }
    await HarnessClient.instance.respondHost(req.requestId, result);
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
