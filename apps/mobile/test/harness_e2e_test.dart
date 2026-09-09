/// 端到端测试：FFI 进程内启动 harness，通过 loopback WebSocket
/// 验证移动端全功能面：握手 → 供应商 → Agent → 对话(工具调用) → 权限/宿主
/// 反向 RPC → 分叉/编辑 → 群组(黑板/注入) → Studio → 技能/定时/记忆 → 持久化。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'package:worldbase_mobile/core/harness_ffi.dart';

Uri _loopbackUri(int port, String token, String scheme, String path) => Uri(
  scheme: scheme,
  host: '127.0.0.1',
  port: port,
  path: path,
  queryParameters: {'token': token},
);

void main() {
  late Directory homeDir;
  late int port;
  late String authToken;

  setUpAll(() async {
    homeDir = await Directory.systemTemp.createTemp('worldbase-e2e');
    // 进程内启动 harness（FFI）——serve 部署层已删除
    final started = HarnessFfi.start(dataDir: homeDir.path);
    expect(started, isNotNull);
    port = started!;
    expect(port, greaterThan(0));
    authToken = HarnessFfi.authToken!;
    final client = HttpClient();
    for (var i = 0; i < 60; i++) {
      try {
        final req = await client.getUrl(
          _loopbackUri(port, authToken, 'http', '/health'),
        );
        final resp = await req.close();
        if (resp.statusCode == 200) break;
      } catch (_) {}
      await Future<void>.delayed(const Duration(milliseconds: 200));
    }
    client.close();
  });

  tearDownAll(() async {
    HarnessFfi.stop();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    await homeDir.delete(recursive: true).catchError((_) => homeDir);
  });

  test('移动端全功能面端到端', () async {
    final ws = WebSocketChannel.connect(
      _loopbackUri(port, authToken, 'ws', '/ws'),
    );
    await ws.ready;

    final pending = <String, Completer<dynamic>>{};
    var nextId = 1;
    final eventLog = <Map<String, dynamic>>[];
    final askUserPayloads = <Map<String, dynamic>>[];
    final doneWaiters = <String, Completer<void>>{};
    final doneStreams = <String>{};

    ws.stream.listen((raw) {
      final msg = jsonDecode(raw as String) as Map<String, dynamic>;
      if (msg.containsKey('id') &&
          (msg.containsKey('result') || msg.containsKey('error'))) {
        final completer = pending.remove(msg['id'].toString());
        if (completer != null) {
          if (msg.containsKey('error')) {
            completer.completeError(Exception(msg['error']?['message']));
          } else {
            completer.complete(msg['result']);
          }
        }
      } else if (msg['method'] == 'event') {
        final frame = (msg['params'] as Map).cast<String, dynamic>();
        // ignore: avoid_print
        print('event: ${frame['kind']}');
        eventLog.add(frame);
        // HITL：权限询问自动允许（验证完整反向流程）
        if (frame['kind'] == 'permission_request') {
          final reqId = frame['requestId'] as String;
          ws.sink.add(
            jsonEncode({
              'jsonrpc': '2.0',
              'id': 'perm-\$reqId',
              'method': 'chat.respond',
              'params': {'requestId': reqId, 'allow': true},
            }),
          );
        }
        if (frame['kind'] == 'host_request' &&
            frame['requestKind'] == 'ask_user') {
          final reqId = frame['requestId'] as String;
          final payload = (frame['payload'] as Map).cast<String, dynamic>();
          askUserPayloads.add(payload);
          final questions = (payload['questions'] as List).cast<Map>();
          ws.sink.add(
            jsonEncode({
              'jsonrpc': '2.0',
              'id': 'host-$reqId',
              'method': 'host.respond',
              'params': {
                'requestId': reqId,
                'result': {
                  'answers': [
                    for (var index = 0; index < questions.length; index++)
                      {
                        'question': questions[index]['question'],
                        'answer': index == 0
                            ? (questions[index]['options'] as List).first
                            : '自定义 Markdown',
                      },
                  ],
                },
              },
            }),
          );
        }
        if (frame['kind'] == 'done' || frame['kind'] == 'error') {
          doneStreams.add(frame['streamId'] as String);
          final waiter = doneWaiters.remove(frame['streamId']);
          waiter?.complete();
        }
      }
    });

    Future<dynamic> call(String method, Map<String, dynamic> params) {
      final id = nextId++;
      final completer = Completer<dynamic>();
      pending['$id'] = completer;
      ws.sink.add(
        jsonEncode({
          'jsonrpc': '2.0',
          'id': id,
          'method': method,
          'params': params,
        }),
      );
      return completer.future.timeout(const Duration(seconds: 30));
    }

    Future<void> waitStreamDone(String streamId) async {
      if (doneStreams.contains(streamId)) return;
      final c = doneWaiters.putIfAbsent(streamId, () => Completer<void>());
      await c.future.timeout(const Duration(seconds: 30));
    }

    // 1) 握手（移动端 capabilities → 工具过滤）
    final init = await call('initialize', {
      'protocolVersion': '1.0',
      'capabilities': {
        'platform': 'mobile-ios',
        'features': [
          'lightweight_runtime',
          'webview_automation',
          'interactive',
        ],
        'excludes': ['subprocess', 'port_binding', 'webhook_receiver'],
      },
    });
    expect(init['protocolVersion'], '1.0');
    final availableTools = init['availableTools'] as List;
    final toolNames = availableTools.map((t) => (t as Map)['name']).toSet();
    expect(toolNames, hasLength(52), reason: 'mobile 工具面必须是显式、稳定的可执行集合');
    expect(toolNames, contains('read_file'));
    expect(toolNames, contains('ask_user'), reason: 'webview/交互能力应开放 host 域工具');
    expect(toolNames, contains('read_current_page'));
    expect(
      toolNames,
      containsAll([
        'list_documents',
        'read_document',
        'save_current_page_as_document',
      ]),
    );
    expect(toolNames, contains('list_agent_workspace_catalog'));
    expect(toolNames, contains('create_agent'));
    expect(toolNames, contains('create_agent_group'));
    expect(
      toolNames,
      contains('create_scheduled_task'),
      reason:
          'mobile must advertise the canonical structured scheduler contract',
    );
    expect(toolNames, contains('schedule_create'));
    expect(toolNames, containsAll(['schedule_list', 'schedule_delete']));
    expect(toolNames, isNot(contains('execute_command')));
    expect(toolNames, isNot(contains('create_project')));
    for (final unavailable in [
      'local_read_file',
      'local_write_file',
      'local_run_command',
      'list_workspace_files',
      'read_workspace_file',
      'write_workspace_file',
      'get_workspace_command_status',
      'list_projects',
      'read_project_file',
      'write_project_file',
      'get_project_command_status',
      'get_project_status',
      'get_task_status',
      'query_project_database',
      'analyze_project_data',
    ]) {
      expect(
        toolNames,
        isNot(contains(unavailable)),
        reason: '$unavailable cannot be completed by the mobile runtime',
      );
    }
    final mobileMcpInstaller = availableTools.cast<Map>().singleWhere(
      (tool) => tool['name'] == 'install_mcp_server',
    );
    final mcpProperties =
        (mobileMcpInstaller['inputSchema'] as Map)['properties'] as Map;
    expect((mcpProperties['transport'] as Map)['enum'], [
      'streamable-http',
      'sse',
    ]);
    expect(mcpProperties.containsKey('command'), isFalse);
    expect(mcpProperties.containsKey('overwrite_existing'), isFalse);

    // 2) 供应商管理：保存/激活/列表
    await call('provider.save', {
      'provider': {
        'id': 'p-ds',
        'name': 'DeepSeek',
        'baseUrl': 'https://api.deepseek.com/v1',
        'apiKey': '',
        'apiProtocol': 'openai',
        'models': [
          {
            'id': 'deepseek-chat',
            'contextWindowK': 128,
            'inputPrice': 1.0,
            'outputPrice': 2.0,
          },
          {
            'id': 'deepseek-reasoner',
            'contextWindowK': 64,
            'inputPrice': 4.0,
            'outputPrice': 16.0,
          },
        ],
        'activeModel': 'deepseek-chat',
        'imageGeneration': false,
      },
    });
    final providers = await call('provider.list', {});
    final providerList = (providers['providers'] as Map)['providers'] as List;
    expect(providerList, isNotEmpty);
    final saved = providerList.first as Map;
    expect(saved['name'], 'DeepSeek');
    final savedModels = saved['models'] as List;
    expect(savedModels.length, 2);
    expect((savedModels.first as Map)['contextWindowK'], 128);
    expect((savedModels.first as Map)['outputPrice'], 2.0);
    await call('provider.setActive', {'id': 'p-ds'});
    final providers2 = await call('provider.list', {});
    expect((providers2['providers'] as Map)['activeProviderId'], 'p-ds');

    // 3) Agent 管理：save/list/对话绑定
    await call('agent.save', {
      'agent': {
        'id': '',
        'name': '移动助手',
        'icon': '📱',
        'description': '测试 Agent',
        'systemPrompt': '你是一个精炼的测试助手。',
        'providerId': 'p-ds',
        'skillIds': [],
      },
    });
    final agents = await call('agent.list', {});
    final agentList = agents['agents'] as List;
    expect(agentList, isNotEmpty);
    final agentId = (agentList.first as Map)['id'] as String;

    // AI 工具与 Electron 同名，并直接写入 Rust Agent Workspace。
    final createdByAi = await call('tool.call', {
      'name': 'create_agent',
      'args': {
        'name': 'AI 研究员',
        'description': '由 AI 工具创建',
        'system_prompt': '负责调研与事实核验。',
        'reasoning_strength': 'high',
        'memory_scopes': ['user', 'agent', 'group'],
        'allow_user_traits': false,
        'auto_reply_enabled': true,
        'auto_reply_require_mention': false,
      },
    });
    expect(createdByAi['success'], isTrue);
    expect((createdByAi['agent'] as Map)['reasoningStrength'], 'high');
    expect(
      ((createdByAi['agent'] as Map)['memoryWritePolicy']
          as Map)['allowUserTraits'],
      isFalse,
    );
    expect(
      ((createdByAi['agent'] as Map)['autoReplyPolicy'] as Map)['enabled'],
      isTrue,
    );
    final aiAgentId = (createdByAi['agent'] as Map)['id'] as String;
    final createdGroupByAi = await call('tool.call', {
      'name': 'create_agent_group',
      'args': {
        'name': 'AI 产品群聊',
        'description': '移动端可直接进入的持久群组',
        'coordinator_agent_id': agentId,
        'member_agent_ids': [agentId, aiAgentId],
        'max_parallel_workers': 2,
      },
    });
    expect(createdGroupByAi['success'], isTrue);
    final agentGroups = await call('agentGroup.list', {});
    final savedGroups = agentGroups['groups'] as List;
    expect(savedGroups, isNotEmpty);
    expect((savedGroups.last as Map)['name'], 'AI 产品群聊');
    expect(
      (savedGroups.last as Map)['memberAgentIds'],
      containsAll(<String>[agentId, aiAgentId]),
    );

    // 4) Agent 绑定的会话：系统提示词来自 agent（mock 回显即可验证对话通）
    final conv = await call('conversation.create', {
      'title': '全功能 E2E',
      'agentId': agentId,
    });
    final convId = conv['id'] as String;

    // 5) 对话 + 工具调用 + 宿主反向 RPC（ask_user）
    //    无 key 时 mock provider 回显；脚本化工具调用走默认行为——这里直接 tool.call 验证 host 工具面
    final send =
        await call('chat.send', {'conversationId': convId, 'text': '你好 移动端'})
            as Map;
    final streamId = send['streamId'] as String;
    await waitStreamDone(streamId);
    final messages = await call('conversation.messages', {'id': convId});
    final msgs = messages['messages'] as List;
    expect(msgs.length, greaterThanOrEqualTo(2));
    expect((msgs.first as Map)['role'], 'user');

    final askResult = await call('tool.call', {
      'name': 'ask_user',
      'args': {
        'questions': [
          {
            'question': '执行模式？',
            'options': ['快速', '完整'],
          },
          {
            'question': '输出格式？',
            'options': ['JSON', '纯文本'],
          },
        ],
      },
    });
    expect(askUserPayloads, hasLength(1), reason: '多个问题必须合并为一次 host_request');
    expect(askUserPayloads.single['questions'], hasLength(2));
    expect(askResult['success'], isTrue);
    expect(askResult['answers'], [
      {'question': '执行模式？', 'answer': '快速'},
      {'question': '输出格式？', 'answer': '自定义 Markdown'},
    ]);

    // 6) 分叉 + 编辑重发
    final userMsgId = (msgs.first as Map)['id'] as int;
    final fork =
        await call('conversation.fork', {
              'conversationId': convId,
              'messageId': userMsgId,
              'mode': 'fork',
            })
            as Map;
    final forkedId = fork['conversationId'] as String;
    expect(forkedId, isNot(convId));
    final forked = await call('conversation.messages', {'id': forkedId});
    expect((forked['messages'] as List).length, 1, reason: '分叉会话应复制锚点前缀');

    final inplace = await call('conversation.fork', {
      'conversationId': convId,
      'messageId': userMsgId,
      'mode': 'inplace',
      'newText': '编辑后的消息',
    });
    expect(inplace['conversationId'], convId);
    final edited = await call('conversation.messages', {'id': convId});
    expect(((edited['messages'] as List).first as Map)['content'], '编辑后的消息');

    // 7) 群组：创建（桌面 5 模式）→ 讨论轮（黑板事件）→ HITL 注入
    final group = await call('group.create', {
      'topic': '架构选型',
      'mode': 'discussion',
      'members': [
        {'name': '协调者', 'persona': '统筹'},
        {'name': '工程师', 'persona': '实现'},
      ],
    });
    final groupId = group['id'] as String;
    expect(group['coordinator'], '协调者');
    final gStream =
        await call('group.message', {'id': groupId, 'text': '开始讨论'}) as Map;
    await waitStreamDone(gStream['streamId'] as String);
    final groupAfter = await call('group.get', {'id': groupId});
    expect(
      ((groupAfter as Map)['rounds'] as List).length,
      2,
      reason: 'discussion 模式全员发言',
    );
    await call('group.inject', {'id': groupId, 'content': '补充：两周预算'});
    await call('group.board.update', {
      'id': groupId,
      'field': 'decisions',
      'op': 'add',
      'value': '选 Rust',
    });
    final boardAfter = await call('group.get', {'id': groupId});
    expect(
      (((boardAfter as Map)['board'] as Map)['decisions'] as List).contains(
        '选 Rust',
      ),
      isTrue,
    );

    // 8) Studio：mock 生图（SVG）→ 列表 → /studio/{id} 取图
    final studioStream =
        await call('studio.generate', {
              'prompt': '赛博朋克猫',
              'mode': 'generate',
              'aspect': '16:9',
              'resolution': '2K',
              'quality': 'high',
              'format': 'png',
              'n': 2,
            })
            as Map;
    final sId = studioStream['streamId'] as String;
    await waitStreamDone(sId);
    final images = await call('studio.list', {'limit': 10});
    final imageList = images['images'] as List;
    expect(imageList.length, 2);
    final firstImage = imageList.first as Map;
    expect(firstImage['file'] as String, endsWith('.svg'));
    final imgReq = await HttpClient().getUrl(
      _loopbackUri(port, authToken, 'http', '/studio/${firstImage['id']}'),
    );
    final imgResp = await imgReq.close();
    expect(imgResp.statusCode, 200);
    expect(imgResp.headers.contentType.toString(), contains('svg'));
    final imgBytes = await imgResp.fold<List<int>>([], (a, b) => a..addAll(b));
    expect(String.fromCharCodes(imgBytes.take(5)), '<svg ');

    // 对话工具生图：移动端握手声明 interactive 后，ask 权限可应答，
    // 工具应返回队列回执且待处理任务可被 Studio 消费。
    final queuedImage = await call('tool.call', {
      'name': 'generate_image',
      'args': {'prompt': '移动端队列测试'},
    });
    expect((queuedImage as Map)['queued'], 1);
    final queuedTasks = await call('studio.tasks.drain', {});
    expect(((queuedTasks as Map)['tasks'] as List).length, 1);

    // 图片管理：标签/文件夹 + 过滤查询
    await call('studio.tag', {
      'id': firstImage['id'],
      'folder': '设计',
      'tags': ['猫', '赛博朋克'],
    });
    final tagged = await call('studio.list', {'tag': '猫'});
    expect((tagged['images'] as List).length, 1);
    final searched = await call('studio.list', {'search': '赛博朋克'});
    expect((searched['images'] as List).length, 2);
    await call('studio.delete', {'id': firstImage['id']});
    final afterDelete = await call('studio.list', {'limit': 10});
    expect((afterDelete['images'] as List).length, 1);

    // 9) 技能 / 定时任务 / 记忆
    await call('skill.save', {
      'name': 'daily-report',
      'description': '每日汇总',
      'instructions': '汇总今日对话要点',
    });
    final skills = await call('skill.list', {});
    final skillNames = (skills['skills'] as List)
        .map((s) => (s as Map)['name'])
        .toList();
    expect(skillNames, contains('daily-report'));
    await call('skill.delete', {'name': 'daily-report'});

    await call('schedule.create', {
      'name': '早报',
      'cron': '0 9 * * 1-5',
      'task': '汇总昨日',
    });
    final schedules = await call('schedule.list', {});
    expect((schedules['schedules'] as List), isNotEmpty);

    // Electron canonical scheduler contract：移动端直接 tool.call 也必须
    // 支持结构化 cadence、技能/MCP 选择和 retry policy，并返回 camelCase
    // task 视图供 Flutter/Studio 继续消费。
    final canonicalSchedule =
        await call('tool.call', {
              'name': 'create_scheduled_task',
              'args': {
                'title': '移动端结构化早报',
                'prompt': '汇总昨日并发送摘要',
                'schedule_kind': 'interval',
                'every_minutes': 60,
                'start_at': '2030-01-01T09:00:00Z',
                'enabled': true,
                'selected_skill_ids': ['daily-report'],
                'selected_mcp_server_ids': ['mobile-mcp'],
                'max_retries': 2,
                'retry_delay_minutes': 10,
              },
            })
            as Map;
    expect(canonicalSchedule['success'], isTrue);
    final canonicalTask = canonicalSchedule['task'] as Map;
    expect(canonicalTask['title'], '移动端结构化早报');
    expect(canonicalTask['prompt'], '汇总昨日并发送摘要');
    expect(canonicalTask['enabled'], isTrue);
    expect((canonicalTask['schedule'] as Map)['kind'], 'interval');
    expect((canonicalTask['schedule'] as Map)['everyMinutes'], 60);
    expect(
      DateTime.parse(
        (canonicalTask['schedule'] as Map)['startAt'] as String,
      ).toUtc(),
      DateTime.parse('2030-01-01T09:00:00Z').toUtc(),
    );
    expect(canonicalTask['selectedSkillIds'], ['daily-report']);
    expect(canonicalTask['selectedMcpServerIds'], ['mobile-mcp']);
    expect((canonicalTask['retryPolicy'] as Map)['maxRetries'], 2);
    expect((canonicalTask['retryPolicy'] as Map)['retryDelayMinutes'], 10);

    final listedCanonical = await call('tool.call', {
      'name': 'list_scheduled_tasks',
      'args': {},
    });
    final listedTasks = (listedCanonical['tasks'] as List).cast<Map>();
    expect(
      listedTasks.any((task) => task['id'] == canonicalTask['id']),
      isTrue,
      reason: '创建后的 canonical task 必须可通过 list_scheduled_tasks 读取',
    );

    await call('memory.add', {
      'content': '用户偏好深色主题',
      'tags': ['ui'],
    });
    final hits = await call('memory.search', {'query': '深色'});
    expect((hits['hits'] as List), isNotEmpty);

    // 10) 会话列表含分叉会话 + 持久化校验（HTTP /rpc 通道）
    final rpcReq = await HttpClient().postUrl(
      _loopbackUri(port, authToken, 'http', '/rpc'),
    );
    rpcReq.headers.contentType = ContentType.json;
    rpcReq.add(
      utf8.encode(
        jsonEncode({
          'jsonrpc': '2.0',
          'id': 99,
          'method': 'conversation.list',
          'params': {'limit': 50},
        }),
      ),
    );
    final rpcResp = await rpcReq.close();
    final rpcBody =
        jsonDecode(await rpcResp.transform(utf8.decoder).join())
            as Map<String, dynamic>;
    final convIds = ((rpcBody['result'] as Map)['conversations'] as List)
        .map((c) => (c as Map)['id'])
        .toSet();
    expect(convIds, contains(convId));
    expect(convIds, contains(forkedId));

    // 10.5) 对话驱动生成轻应用：mock Agent 识别意图 → 权限应答 → 创建 → 列表可见
    final conv2 = await call('conversation.create', {'title': 'AI 做应用'});
    final send2 =
        await call('chat.send', {
              'conversationId': conv2['id'],
              'text': '帮我做一个「番茄钟」应用',
            })
            as Map;
    if (!doneStreams.contains(send2['streamId'])) {
      await doneWaiters
          .putIfAbsent(send2['streamId'] as String, () => Completer<void>())
          .future
          .timeout(const Duration(seconds: 20));
    }
    final lightApps2 = await call('lightapp.list', {}) as Map;
    final names = (lightApps2['apps'] as List)
        .map((a) => (a as Map)['name'])
        .where((n) => n.toString().contains('番茄钟'))
        .toList();
    expect(names, isNotEmpty, reason: '对话中的 Agent 应生成轻应用并入库');
    final permEvents = eventLog
        .where((e) => e['kind'] == 'permission_request')
        .map((e) => e['toolName'])
        .toSet();
    expect(permEvents, contains('create_lightweight_app'), reason: '创建前应弹权限询问');

    // 11) 轻应用：create_lightweight_app 工具（tool.call）→ 列表 → /lightapp/{id} 页面
    final toolCall =
        await call('tool.call', {
              'name': 'create_lightweight_app',
              'args': {
                'name': '番茄钟',
                'html': '<!DOCTYPE html><html><body><h1>番茄钟</h1></body></html>',
              },
            })
            as Map;
    final lightAppId = ((toolCall['app'] as Map)['id']) as String;
    final lightApps = await call('lightapp.list', {});
    expect(
      (lightApps['apps'] as List).length,
      2,
      reason: '对话生成 1 个 + tool.call 创建 1 个',
    );
    final pageReq = await HttpClient().getUrl(
      _loopbackUri(port, authToken, 'http', '/lightapp/$lightAppId'),
    );
    final pageResp = await pageReq.close();
    expect(pageResp.statusCode, 200);
    final pageHtml = await pageResp.transform(utf8.decoder).join();
    expect(pageHtml, contains('番茄钟'));
    await call('lightapp.delete', {'id': lightAppId});

    // 12) 用量统计：对话已记账（mock 估算 tokens）
    final usage = await call('usage.summary', {'days': 30}) as Map;
    expect(
      (usage['totalInputTokens'] as num).toInt(),
      greaterThan(0),
      reason: '对话与工具循环应产生用量记录',
    );
    expect((usage['daily'] as List), isNotEmpty);

    await ws.sink.close();
  }, timeout: const Timeout(Duration(seconds: 90)));
}
