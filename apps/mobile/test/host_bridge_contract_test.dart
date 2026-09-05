import 'dart:convert';
import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldbase_mobile/app/host_bridge_ui.dart';
import 'package:worldbase_mobile/core/harness_client.dart';

class _RealHttpOverrides extends HttpOverrides {
  HttpClient createRealClient(SecurityContext? context) =>
      super.createHttpClient(context);
}

class _FakeHarnessServer {
  _FakeHarnessServer._(this.server);

  final HttpServer server;
  final List<Map<String, dynamic>> requests = [];
  WebSocket? _socket;

  static Future<_FakeHarnessServer> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final fake = _FakeHarnessServer._(server);
    server.listen(fake._accept);
    return fake;
  }

  Future<void> _accept(HttpRequest request) async {
    final socket = await WebSocketTransformer.upgrade(request);
    _socket = socket;
    socket.listen((raw) {
      final message = jsonDecode(raw as String) as Map<String, dynamic>;
      requests.add(message);
      final id = message['id'];
      if (id == null) return;
      final initialize = message['method'] == 'initialize';
      socket.add(
        jsonEncode({
          'jsonrpc': '2.0',
          'id': id,
          'result': initialize
              ? {
                  'protocolVersion': '1.0',
                  'serverVersion': 'widget-test',
                  'availableTools': <dynamic>[],
                  'availableDomains': <dynamic>[],
                }
              : <String, dynamic>{'ok': true},
        }),
      );
    });
  }

  void emitEvent({
    required String streamId,
    required int seq,
    required String kind,
    Map<String, dynamic> data = const {},
  }) {
    final socket = _socket;
    if (socket == null) throw StateError('WebSocket client is not connected');
    socket.add(
      jsonEncode({
        'jsonrpc': '2.0',
        'method': 'event',
        'params': {
          'streamId': streamId,
          'seq': seq,
          'ts': '2026-09-04T00:00:00Z',
          'kind': kind,
          ...data,
        },
      }),
    );
  }

  Future<void> close() async {
    _socket = null;
    await server.close(force: true);
  }
}

void main() {
  group('page automation action normalization', () {
    test('normalizes canonical input and legacy value aliases', () {
      final canonical = normalizePageAutomationActions({
        'action': 'input',
        'selector': '#name',
        'text': 'Ada',
        'append': true,
      });
      final legacy = normalizePageAutomationActions({
        'action': 'fill',
        'selector': '#name',
        'value': 'Grace',
      });

      expect(canonical, hasLength(1));
      expect(canonical.single, containsPair('text', 'Ada'));
      expect(canonical.single['type'], 'input');
      expect(canonical.single['append'], isTrue);
      expect(legacy.single['type'], 'input');
      expect(legacy.single['text'], 'Grace');
      expect(legacy.single['append'], isFalse);
    });

    test('normalizes canonical scroll offsets and legacy deltas', () {
      final canonical = normalizePageAutomationActions({
        'action': 'scroll',
        'top': 320,
        'left': 24,
      }).single;
      final legacy = normalizePageAutomationActions({
        'action': 'scroll',
        'dy': 640,
        'dx': 12,
      }).single;

      expect(canonical['top'], 320);
      expect(canonical['left'], 24);
      expect(legacy['top'], 640);
      expect(legacy['left'], 12);
    });

    test('normalizes evaluate, extract, and wait field names', () {
      final actions = normalizePageAutomationActions({
        'action': 'interact',
        'actions': [
          {'type': 'evaluate', 'js': 'document.title'},
          {'type': 'extract', 'max_chars': 4096},
          {'type': 'wait', 'timeout_ms': 250},
        ],
      });

      expect(actions[0]['script'], 'document.title');
      expect(actions[1]['maxChars'], 4096);
      expect(actions[2]['timeoutMs'], 250);
    });

    test('normalizes every batch input field', () {
      final action = normalizePageAutomationActions({
        'action': 'batch_input',
        'fields': [
          {'selector': '#first', 'text': 'Ada', 'append': true},
          {'selector': '#last', 'value': 'Lovelace'},
          'not-an-object',
        ],
      }).single;
      final fields = action['fields'] as List<Map<String, dynamic>>;

      expect(fields, hasLength(2));
      expect(fields[0]['text'], 'Ada');
      expect(fields[0]['append'], isTrue);
      expect(fields[1]['text'], 'Lovelace');
      expect(fields[1]['append'], isFalse);
    });

    test('accepts both a direct action and the native actions envelope', () {
      final direct = normalizePageAutomationActions({
        'action': 'click',
        'selector': '#submit',
      });
      final envelope = normalizePageAutomationActions({
        'action': 'interact',
        'actions': [
          {'type': 'focus', 'selector': '#search'},
          {'type': 'press_key', 'key': 'Enter'},
        ],
      });

      expect(direct.single['type'], 'click');
      expect(envelope.map((action) => action['type']), ['focus', 'press_key']);
    });

    test('rejects an unknown top-level action', () {
      expect(
        normalizePageAutomationActions({'action': 'launch_missiles'}),
        isEmpty,
      );
    });
  });

  group('ask_user host contract', () {
    test(
      'normalizes one batch, caps it at four, and keeps legacy payloads',
      () {
        final bundled = normalizeAskUserQuestions({
          'questions': [
            for (var index = 0; index < 5; index++)
              {
                'id': 'question-$index',
                'question': 'Question $index?',
                'options': ['A', 'B'],
              },
          ],
        });
        final legacy = normalizeAskUserQuestions({
          'question': 'Legacy?',
          'choices': ['Yes', 'No'],
        });

        expect(bundled, hasLength(4));
        expect(bundled.last.question, 'Question 3?');
        expect(legacy.single.question, 'Legacy?');
        expect(legacy.single.options, ['Yes', 'No']);
      },
    );

    test('builds one ordered answer result including custom text', () {
      final questions = normalizeAskUserQuestions({
        'questions': [
          {
            'question': 'Mode?',
            'options': ['Fast', 'Careful'],
          },
          {
            'question': 'Format?',
            'options': ['JSON', 'Text'],
          },
        ],
      });

      expect(buildAskUserResponse(questions, ['Fast', 'Custom markdown']), {
        'answers': [
          {'question': 'Mode?', 'answer': 'Fast'},
          {'question': 'Format?', 'answer': 'Custom markdown'},
        ],
      });
    });

    testWidgets(
      'dialog answers multiple questions with option and custom text',
      (tester) async {
        final questions = normalizeAskUserQuestions({
          'questions': [
            {
              'question': 'Mode?',
              'options': ['Fast', 'Careful'],
            },
            {
              'question': 'Format?',
              'options': ['JSON', 'Text'],
            },
          ],
        });
        List<String>? result;

        await tester.pumpWidget(
          CupertinoApp(
            home: Builder(
              builder: (context) => CupertinoButton(
                child: const Text('Open'),
                onPressed: () async {
                  result = await showCupertinoDialog<List<String>>(
                    context: context,
                    builder: (_) => AskUserDialog(questions: questions),
                  );
                },
              ),
            ),
          ),
        );
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();

        expect(find.text('1. Mode?'), findsOneWidget);
        expect(find.text('2. Format?'), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('ask-user-option-0-0')));
        await tester.enterText(
          find.byKey(const ValueKey('ask-user-custom-1')),
          'Markdown with notes',
        );
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('ask-user-submit')));
        await tester.pumpAndSettle();

        expect(result, ['Fast', 'Markdown with notes']);
      },
    );

    testWidgets(
      'terminal streams close only their dialogs and suppress late responses',
      (tester) async {
        late _FakeHarnessServer fake;
        final client = HarnessClient.instance;
        await tester.pumpWidget(
          const ProviderScope(
            child: CupertinoApp(
              home: GlobalDialogHost(child: SizedBox.expand()),
            ),
          ),
        );
        final httpOverrides = _RealHttpOverrides();
        await tester.runAsync(() async {
          fake = await _FakeHarnessServer.start();
          client.configure(
            host: '127.0.0.1',
            port: fake.server.port,
            authToken: 'dialog-widget-test-token',
          );
          await HttpOverrides.runZoned(
            client.connect,
            createHttpClient: httpOverrides.createRealClient,
          );
        });
        addTearDown(() async {
          client.dispose();
          await fake.close();
        });

        Future<void> settleSocketEvents() async {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 20)),
          );
          await tester.pumpAndSettle();
        }

        fake.emitEvent(
          streamId: 'ask-active',
          seq: 0,
          kind: 'host_request',
          data: {
            'requestId': 'ask-active-request',
            'requestKind': 'ask_user',
            'payload': {
              'questions': [
                {
                  'question': 'Continue?',
                  'options': ['Yes', 'No'],
                },
              ],
            },
          },
        );
        await settleSocketEvents();
        expect(find.text('Agent 想问你'), findsOneWidget);

        fake.emitEvent(
          streamId: 'ask-active',
          seq: 1,
          kind: 'done',
          data: {'stopReason': 'aborted'},
        );
        await settleSocketEvents();
        expect(find.text('Agent 想问你'), findsNothing);
        expect(
          fake.requests.where((request) => request['method'] == 'host.respond'),
          isEmpty,
        );

        fake.emitEvent(
          streamId: 'permission-active',
          seq: 0,
          kind: 'permission_request',
          data: {
            'requestId': 'permission-active-request',
            'toolName': 'run_command',
            'argsSummary': 'pnpm test',
          },
        );
        fake.emitEvent(
          streamId: 'ask-queued',
          seq: 0,
          kind: 'host_request',
          data: {
            'requestId': 'ask-queued-request',
            'requestKind': 'ask_user',
            'payload': {
              'question': 'Queued question?',
              'choices': ['A', 'B'],
            },
          },
        );
        await settleSocketEvents();
        expect(find.text('「run_command」请求执行'), findsOneWidget);
        expect(find.text('Agent 想问你'), findsNothing);

        fake.emitEvent(
          streamId: 'ask-queued',
          seq: 1,
          kind: 'done',
          data: {'stopReason': 'aborted'},
        );
        await settleSocketEvents();
        expect(find.text('「run_command」请求执行'), findsOneWidget);

        fake.emitEvent(
          streamId: 'permission-active',
          seq: 1,
          kind: 'error',
          data: {'message': 'aborted'},
        );
        await settleSocketEvents();
        expect(find.text('「run_command」请求执行'), findsNothing);
        expect(
          fake.requests.where((request) => request['method'] == 'chat.respond'),
          isEmpty,
        );

        fake.emitEvent(
          streamId: 'permission-next',
          seq: 0,
          kind: 'permission_request',
          data: {
            'requestId': 'permission-next-request',
            'toolName': 'write_file',
            'argsSummary': 'output.txt',
          },
        );
        fake.emitEvent(
          streamId: 'ask-next',
          seq: 0,
          kind: 'host_request',
          data: {
            'requestId': 'ask-next-request',
            'requestKind': 'ask_user',
            'payload': {
              'question': 'Pick one?',
              'choices': ['First', 'Second'],
            },
          },
        );
        await settleSocketEvents();
        expect(find.text('「write_file」请求执行'), findsOneWidget);
        expect(find.text('Agent 想问你'), findsNothing);

        await tester.tap(find.text('允许'));
        await settleSocketEvents();
        expect(find.text('「write_file」请求执行'), findsNothing);
        expect(find.text('Agent 想问你'), findsOneWidget);
        expect(
          fake.requests.where((request) => request['method'] == 'chat.respond'),
          hasLength(1),
        );

        fake.emitEvent(
          streamId: 'ask-next',
          seq: 1,
          kind: 'done',
          data: {'stopReason': 'aborted'},
        );
        await settleSocketEvents();
        expect(find.text('Agent 想问你'), findsNothing);
        expect(
          fake.requests.where((request) => request['method'] == 'host.respond'),
          isEmpty,
        );
      },
    );
  });
}
