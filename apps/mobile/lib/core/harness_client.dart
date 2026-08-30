/// WorldBase Harness 客户端（WebSocket JSON-RPC）——完整协议面。
///
/// 对接 `worldbase serve`（WS/HTTP transport）：
/// - initialize 握手 + 移动端 capabilities（排除 subprocess/port_binding/webhook）
/// - 会话/消息/分叉编辑、供应商、Agent、群组（5 模式/黑板/HITL 注入）、
///   Studio 生图、技能、定时任务、记忆、MCP、设置
/// - 流式事件（seq 排序）+ 断线重连 chat.resume 续传
/// - 权限询问（permission_request → chat.respond）
/// - 宿主反向请求（host_request：ask_user / page_automation → host.respond）
library;

import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

/// 事件帧（对齐 protocol::event::EventFrame，camelCase）。
class EventFrame {
  EventFrame({
    required this.streamId,
    required this.seq,
    required this.ts,
    required this.kind,
    required this.data,
  });

  final String streamId;
  final int seq;
  final String ts;
  final String kind;
  final Map<String, dynamic> data;

  static EventFrame fromJson(Map<String, dynamic> json) => EventFrame(
        streamId: json['streamId'] as String? ?? '',
        seq: (json['seq'] as num?)?.toInt() ?? 0,
        ts: json['ts'] as String? ?? '',
        kind: json['kind'] as String? ?? 'notice',
        data: json,
      );
}

class ToolDescriptor {
  ToolDescriptor({required this.name, required this.description, required this.domain});
  final String name;
  final String description;
  final String domain;
  static ToolDescriptor fromJson(Map<String, dynamic> j) => ToolDescriptor(
        name: j['name'] as String,
        description: j['description'] as String? ?? '',
        domain: j['domain'] as String? ?? 'core',
      );
}

class ConversationMeta {
  ConversationMeta({
    required this.id,
    required this.title,
    required this.updatedAt,
    this.messageCount = 0,
    this.agentId,
    this.forkedFrom,
    this.forkDepth = 0,
  });
  final String id;
  final String title;
  final String updatedAt;
  final int messageCount;
  final String? agentId;
  final String? forkedFrom;
  final int forkDepth;

  static ConversationMeta fromJson(Map<String, dynamic> j) => ConversationMeta(
        id: j['id'] as String,
        title: j['title'] as String? ?? '',
        updatedAt: j['updatedAt'] as String? ?? '',
        messageCount: (j['messageCount'] as num?)?.toInt() ?? 0,
        agentId: j['agentId'] as String?,
        forkedFrom: j['forkedFromConversationId'] as String?,
        forkDepth: (j['forkDepth'] as num?)?.toInt() ?? 0,
      );
}

/// 会话消息（harness 落库行，含分叉锚点 id）。
class ChatMessage {
  ChatMessage({
    required this.id,
    required this.role,
    required this.content,
    this.toolCalls = const [],
    this.toolResults = const [],
  });
  final int id;
  final String role;
  final String content;
  final List<dynamic> toolCalls;
  final List<dynamic> toolResults;
  bool get isTool => toolCalls.isNotEmpty || toolResults.isNotEmpty;

  static ChatMessage fromJson(Map<String, dynamic> j) => ChatMessage(
        id: (j['id'] as num?)?.toInt() ?? 0,
        role: j['role'] as String? ?? 'user',
        content: j['content'] as String? ?? '',
        toolCalls: j['toolCalls'] as List? ?? const [],
        toolResults: j['toolResults'] as List? ?? const [],
      );
}

/// 模型信息：上下文窗口(K) + 单价（/1M tokens）+ 生图/编辑能力。
class ModelInfo {
  ModelInfo({
    required this.id,
    this.contextWindowK = 0,
    this.inputPrice = 0,
    this.outputPrice = 0,
    this.imageGeneration = false,
    this.imageEditing = false,
  });
  String id;
  int contextWindowK;
  double inputPrice;
  double outputPrice;
  bool imageGeneration;
  bool imageEditing;

  Map<String, dynamic> toJson() => {
        'id': id,
        'contextWindowK': contextWindowK,
        'inputPrice': inputPrice,
        'outputPrice': outputPrice,
        'imageGeneration': imageGeneration,
        'imageEditing': imageEditing,
      };

  static ModelInfo fromJson(Map<String, dynamic> j) => ModelInfo(
        id: j['id'] as String,
        contextWindowK: (j['contextWindowK'] as num?)?.toInt() ?? 0,
        inputPrice: (j['inputPrice'] as num?)?.toDouble() ?? 0,
        outputPrice: (j['outputPrice'] as num?)?.toDouble() ?? 0,
        imageGeneration: j['imageGeneration'] as bool? ?? false,
        imageEditing: j['imageEditing'] as bool? ?? false,
      );
}

class ProviderEntry {
  ProviderEntry({
    required this.id,
    required this.name,
    this.baseUrl = '',
    this.apiKey = '',
    this.apiProtocol = '',
    this.models = const [],
    this.activeModel = '',
    this.imageGeneration = false,
  });
  String id;
  String name;
  String baseUrl;
  String apiKey;
  String apiProtocol;
  List<ModelInfo> models;
  String activeModel;
  bool imageGeneration;

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'baseUrl': baseUrl,
        'apiKey': apiKey,
        'apiProtocol': apiProtocol,
        'models': models.map((m) => m.toJson()).toList(),
        'activeModel': activeModel,
        'imageGeneration': imageGeneration,
      };

  static ProviderEntry fromJson(Map<String, dynamic> j) => ProviderEntry(
        id: j['id'] as String,
        name: j['name'] as String? ?? '',
        baseUrl: j['baseUrl'] as String? ?? '',
        apiKey: j['apiKey'] as String? ?? '',
        apiProtocol: j['apiProtocol'] as String? ?? '',
        models: (j['models'] as List?)
                ?.map((e) => ModelInfo.fromJson((e as Map).cast<String, dynamic>()))
                .toList() ??
            [],
        activeModel: j['activeModel'] as String? ?? '',
        imageGeneration: j['imageGeneration'] as bool? ?? false,
      );
}

class AgentDefinition {
  AgentDefinition({
    required this.id,
    required this.name,
    this.icon = '',
    this.description = '',
    this.systemPrompt = '',
    this.providerId,
    this.modelId,
  });
  String id;
  String name;
  String icon;
  String description;
  String systemPrompt;
  String? providerId;
  String? modelId;

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'icon': icon,
        'description': description,
        'systemPrompt': systemPrompt,
        'providerId': providerId,
        'modelId': modelId,
        'skillIds': <String>[],
      };

  static AgentDefinition fromJson(Map<String, dynamic> j) => AgentDefinition(
        id: j['id'] as String,
        name: j['name'] as String? ?? '',
        icon: j['icon'] as String? ?? '',
        description: j['description'] as String? ?? '',
        systemPrompt: j['systemPrompt'] as String? ?? '',
        providerId: j['providerId'] as String?,
        modelId: j['modelId'] as String?,
      );
}

class ImageEntry {
  ImageEntry({
    required this.id,
    required this.prompt,
    required this.file,
    required this.createdAt,
    this.model = '',
    this.folder = '',
    this.tags = const [],
  });
  final String id;
  final String prompt;
  final String file;
  final String createdAt;
  final String model;
  final String folder;
  final List<String> tags;
  static ImageEntry fromJson(Map<String, dynamic> j) => ImageEntry(
        id: j['id'] as String,
        prompt: j['prompt'] as String? ?? '',
        file: j['file'] as String? ?? '',
        createdAt: j['createdAt'] as String? ?? '',
        model: j['model'] as String? ?? '',
        folder: j['folder'] as String? ?? '',
        tags: (j['tags'] as List?)?.map((e) => e as String).toList() ?? [],
      );
}

/// 轻应用（Agent 生成的单页应用）。
class LightApp {
  LightApp({required this.id, required this.name, required this.createdAt});
  final String id;
  final String name;
  final String createdAt;
  static LightApp fromJson(Map<String, dynamic> j) => LightApp(
        id: j['id'] as String,
        name: j['name'] as String? ?? '',
        createdAt: j['createdAt'] as String? ?? '',
      );
}

/// 用量汇总。
class UsageSummary {
  UsageSummary({
    required this.daily,
    required this.byModel,
    required this.totalCost,
    required this.totalInputTokens,
    required this.totalOutputTokens,
  });
  final List<Map<String, dynamic>> daily;
  final List<Map<String, dynamic>> byModel;
  final double totalCost;
  final int totalInputTokens;
  final int totalOutputTokens;

  static UsageSummary fromJson(Map<String, dynamic> j) => UsageSummary(
        daily: (j['daily'] as List?)?.map((e) => (e as Map).cast<String, dynamic>()).toList() ?? [],
        byModel: (j['byModel'] as List?)?.map((e) => (e as Map).cast<String, dynamic>()).toList() ?? [],
        totalCost: (j['totalCost'] as num?)?.toDouble() ?? 0,
        totalInputTokens: (j['totalInputTokens'] as num?)?.toInt() ?? 0,
        totalOutputTokens: (j['totalOutputTokens'] as num?)?.toInt() ?? 0,
      );
}

class GroupSession {
  GroupSession({
    required this.id,
    required this.topic,
    required this.mode,
    required this.members,
    required this.status,
    this.coordinator,
    this.board = const {},
    this.rounds = const [],
  });
  final String id;
  final String topic;
  final String mode;
  final List<dynamic> members;
  final String status;
  final String? coordinator;
  final Map<String, dynamic> board;
  final List<dynamic> rounds;

  static GroupSession fromJson(Map<String, dynamic> j) => GroupSession(
        id: j['id'] as String,
        topic: j['topic'] as String? ?? '',
        mode: j['mode'] as String? ?? 'discussion',
        members: j['members'] as List? ?? [],
        status: j['status'] as String? ?? 'open',
        coordinator: j['coordinator'] as String?,
        board: (j['board'] as Map?)?.cast<String, dynamic>() ?? {},
        rounds: j['rounds'] as List? ?? [],
      );
}

class SkillDescriptor {
  SkillDescriptor({required this.name, required this.description, required this.instructions});
  final String name;
  final String description;
  final String instructions;
  static SkillDescriptor fromJson(Map<String, dynamic> j) => SkillDescriptor(
        name: j['name'] as String,
        description: j['description'] as String? ?? '',
        instructions: j['instructions'] as String? ?? '',
      );
}

class ScheduleEntry {
  ScheduleEntry({
    required this.id,
    required this.name,
    required this.cron,
    required this.task,
    required this.enabled,
    this.nextRunAt,
  });
  final String id;
  final String name;
  final String cron;
  final String task;
  final bool enabled;
  final String? nextRunAt;
  static ScheduleEntry fromJson(Map<String, dynamic> j) => ScheduleEntry(
        id: j['id'] as String,
        name: j['name'] as String? ?? '',
        cron: j['cron'] as String? ?? '',
        task: j['task'] as String? ?? '',
        enabled: j['enabled'] as bool? ?? true,
        nextRunAt: j['nextRunAt'] as String?,
      );
}

enum HarnessState { disconnected, connecting, connected }

class PendingPermission {
  PendingPermission({required this.requestId, required this.toolName, required this.argsSummary});
  final String requestId;
  final String toolName;
  final String argsSummary;
}

/// 宿主反向请求（ask_user / page_automation）。
class HostRequest {
  HostRequest({required this.requestId, required this.kind, required this.payload});
  final String requestId;
  final String kind; // ask_user / page_automation
  final Map<String, dynamic> payload;
}

/// Web 快捷方式（轻应用）。
class WebApp {
  WebApp({required this.name, required this.url});
  final String name;
  final String url;
  Map<String, dynamic> toJson() => {'name': name, 'url': url};
  static WebApp fromJson(Map<String, dynamic> j) =>
      WebApp(name: j['name'] as String, url: j['url'] as String);
}

/// Harness WS 客户端（单例）。
class HarnessClient {
  HarnessClient._();

  static final HarnessClient instance = HarnessClient._();

  WebSocketChannel? _channel;
  int _nextId = 1;
  final Map<String, Completer<dynamic>> _pending = {};
  final Map<String, StreamController<EventFrame>> _streams = {};
  final Map<String, int> _lastSeq = {};
  final _stateCtrl = StreamController<HarnessState>.broadcast();
  final _permissionsCtrl = StreamController<PendingPermission>.broadcast();
  final _hostRequestsCtrl = StreamController<HostRequest>.broadcast();
  final _allFramesCtrl = StreamController<EventFrame>.broadcast();

  String _host = '127.0.0.1';
  int _port = 19527;
  bool _handshaked = false;
  Timer? _reconnectTimer;

  Stream<HarnessState> get stateStream => _stateCtrl.stream;
  HarnessState get state =>
      _channel != null && _handshaked ? HarnessState.connected : HarnessState.disconnected;
  Stream<EventFrame> get events => _allFramesCtrl.stream;
  Stream<PendingPermission> get permissionRequests => _permissionsCtrl.stream;
  Stream<HostRequest> get hostRequests => _hostRequestsCtrl.stream;
  String get host => _host;
  int get port => _port;
  String get httpBase => 'http://$_host:$_port';

  void configure({required String host, required int port}) {
    _host = host;
    _port = port;
  }

  Future<void> connect() async {
    if (_channel != null) return;
    _stateCtrl.add(HarnessState.connecting);
    final url = Uri.parse('ws://$_host:$_port/ws');
    try {
      final channel = WebSocketChannel.connect(url);
      await channel.ready.timeout(const Duration(seconds: 5));
      _channel = channel;
      channel.stream.listen(_onMessage, onDone: _onDisconnected, onError: (_) => _onDisconnected());
      await _handshake();
      _stateCtrl.add(HarnessState.connected);
    } catch (e) {
      _channel = null;
      _stateCtrl.add(HarnessState.disconnected);
      rethrow;
    }
  }

  Future<void> _handshake() async {
    await call('initialize', {
      'protocolVersion': '1.0',
      'capabilities': {
        'platform': 'mobile',
        'features': ['lightweight_runtime', 'webview_automation'],
        'excludes': ['subprocess', 'port_binding', 'webhook_receiver'],
      },
    });
    _handshaked = true;
  }

  void _onDisconnected() {
    _channel = null;
    _handshaked = false;
    _stateCtrl.add(HarnessState.disconnected);
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(const Duration(seconds: 2), () async {
      try {
        await connect();
        await _resumeAll();
      } catch (_) {}
    });
  }

  Future<void> _resumeAll() async {
    for (final entry in _lastSeq.entries) {
      try {
        final result = await call('chat.resume', {'streamId': entry.key, 'afterSeq': entry.value});
        final events = result?['events'] as List?;
        if (events != null) {
          for (final e in events) {
            _dispatchFrame(EventFrame.fromJson((e as Map).cast<String, dynamic>()));
          }
        }
      } catch (_) {}
    }
  }

  void _onMessage(dynamic raw) {
    final msg = jsonDecode(raw as String) as Map<String, dynamic>;
    if (msg.containsKey('id') && (msg.containsKey('result') || msg.containsKey('error'))) {
      final completer = _pending.remove(msg['id'].toString());
      if (completer != null) {
        if (msg.containsKey('error')) {
          completer.completeError(Exception(msg['error']?['message'] ?? 'rpc error'));
        } else {
          completer.complete(msg['result']);
        }
      }
      return;
    }
    if (msg['method'] == 'event') {
      final frame = EventFrame.fromJson((msg['params'] as Map).cast<String, dynamic>());
      _dispatchFrame(frame);
    }
  }

  void _dispatchFrame(EventFrame frame) {
    final last = _lastSeq[frame.streamId] ?? -1;
    if (frame.seq > last) _lastSeq[frame.streamId] = frame.seq;
    _streams[frame.streamId]?.add(frame);
    _allFramesCtrl.add(frame);

    if (frame.kind == 'permission_request') {
      _permissionsCtrl.add(PendingPermission(
        requestId: frame.data['requestId'] as String? ?? '',
        toolName: frame.data['toolName'] as String? ?? '',
        argsSummary: frame.data['argsSummary'] as String? ?? '',
      ));
    } else if (frame.kind == 'host_request') {
      _hostRequestsCtrl.add(HostRequest(
        requestId: frame.data['requestId'] as String? ?? '',
        kind: frame.data['requestKind'] as String? ?? '',
        payload: (frame.data['payload'] as Map?)?.cast<String, dynamic>() ?? {},
      ));
    }
  }

  Future<void> respondPermission(String requestId, bool allow) =>
      call('chat.respond', {'requestId': requestId, 'allow': allow});

  /// 应答宿主反向请求（ask_user 答案 / 页面自动化结果）。
  Future<void> respondHost(String requestId, dynamic result) =>
      call('host.respond', {'requestId': requestId, 'result': result});

  Future<dynamic> call(String method, Map<String, dynamic> params) async {
    final channel = _channel;
    if (channel == null) throw Exception('not connected');
    final id = _nextId++;
    final completer = Completer<dynamic>();
    _pending['$id'] = completer;
    channel.sink.add(jsonEncode({'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params}));
    return completer.future.timeout(const Duration(seconds: 60));
  }

  Stream<EventFrame> subscribeStream(String streamId) {
    _streams[streamId]?.close();
    final ctrl = StreamController<EventFrame>.broadcast();
    _streams[streamId] = ctrl;
    return ctrl.stream;
  }

  // ---------- 会话 ----------

  Future<List<ConversationMeta>> listConversations() async {
    final result = await call('conversation.list', {'limit': 100});
    final list = result?['conversations'] as List? ?? [];
    return list.map((e) => ConversationMeta.fromJson((e as Map).cast<String, dynamic>())).toList();
  }

  Future<ConversationMeta> createConversation(String title, {String? agentId}) async {
    final result = await call('conversation.create', {'title': title, if (agentId != null) 'agentId': agentId});
    return ConversationMeta.fromJson((result as Map).cast<String, dynamic>());
  }

  Future<List<ChatMessage>> listMessages(String conversationId) async {
    final result = await call('conversation.messages', {'id': conversationId});
    final list = result?['messages'] as List? ?? [];
    return list.map((e) => ChatMessage.fromJson((e as Map).cast<String, dynamic>())).toList();
  }

  Future<void> deleteConversation(String id) => call('conversation.delete', {'id': id});
  Future<void> renameConversation(String id, String title) =>
      call('conversation.rename', {'id': id, 'title': title});

  Future<String> sendChat(String conversationId, String text,
      {String? providerId, String? model}) async {
    final result = await call('chat.send', {
      'conversationId': conversationId,
      'text': text,
      if (providerId != null) 'providerId': providerId,
      if (model != null && model.isNotEmpty) 'model': model,
    });
    final streamId = result?['streamId'] as String;
    _lastSeq[streamId] = -1;
    return streamId;
  }

  Future<void> abortChat({String? streamId, String? conversationId}) =>
      call('chat.abort', {
        if (streamId != null) 'streamId': streamId,
        if (conversationId != null) 'conversationId': conversationId,
      });

  /// 分叉/编辑重发。mode: fork（安全分叉）| inplace（截断原会话）。
  Future<Map<String, dynamic>> forkConversation(String conversationId, int messageId,
      {String? newText, String mode = 'fork'}) async {
    final result = await call('conversation.fork', {
      'conversationId': conversationId,
      'messageId': messageId,
      'mode': mode,
      if (newText != null) 'newText': newText,
    });
    return (result as Map).cast<String, dynamic>();
  }

  // ---------- 供应商 ----------

  Future<Map<String, dynamic>> listProviders() async {
    final result = await call('provider.list', {});
    return (result?['providers'] as Map?)?.cast<String, dynamic>() ?? {};
  }

  Future<Map<String, dynamic>> saveProvider(ProviderEntry entry) async {
    final r = await call('provider.save', {'provider': entry.toJson()});
    return (r as Map).cast<String, dynamic>();
  }

  Future<Map<String, dynamic>> deleteProvider(String id) async {
    final r = await call('provider.delete', {'id': id});
    return (r as Map).cast<String, dynamic>();
  }

  Future<Map<String, dynamic>> setActiveProvider(String id) async {
    final r = await call('provider.setActive', {'id': id});
    return (r as Map).cast<String, dynamic>();
  }

  // ---------- Agent ----------

  Future<List<AgentDefinition>> listAgents() async {
    final result = await call('agent.list', {});
    final list = result?['agents'] as List? ?? [];
    return list.map((e) => AgentDefinition.fromJson((e as Map).cast<String, dynamic>())).toList();
  }

  Future<AgentDefinition> saveAgent(AgentDefinition agent) async {
    final result = await call('agent.save', {'agent': agent.toJson()});
    return AgentDefinition.fromJson((result?['agent'] as Map).cast<String, dynamic>());
  }

  Future<void> deleteAgent(String id) => call('agent.delete', {'id': id});

  // ---------- Studio ----------

  /// 生图/改图全参数（对齐桌面 ImageStudio），支持供应商/模型选择。
  Future<String> studioGenerate({
    required String prompt,
    String mode = 'generate',
    String? negativePrompt,
    String? aspect,
    String? resolution,
    String? quality,
    String? format,
    int n = 1,
    String? inputImageB64,
    String? providerId,
    String? model,
  }) async {
    final result = await call('studio.generate', {
      'prompt': prompt,
      'mode': mode,
      if (negativePrompt != null && negativePrompt.isNotEmpty)
        'negativePrompt': negativePrompt,
      if (aspect != null) 'aspect': aspect,
      if (resolution != null) 'resolution': resolution,
      if (quality != null) 'quality': quality,
      if (format != null) 'format': format,
      'n': n,
      if (providerId != null) 'providerId': providerId,
      if (model != null && model.isNotEmpty) 'model': model,
      if (inputImageB64 != null) 'inputImageB64': inputImageB64,
    });
    return result?['streamId'] as String;
  }

  Future<List<ImageEntry>> studioList({String? folder, String? tag, String? search}) async {
    final result = await call('studio.list', {
      'limit': 120,
      if (folder != null && folder.isNotEmpty) 'folder': folder,
      if (tag != null && tag.isNotEmpty) 'tag': tag,
      if (search != null && search.isNotEmpty) 'search': search,
    });
    final list = result?['images'] as List? ?? [];
    return list.map((e) => ImageEntry.fromJson((e as Map).cast<String, dynamic>())).toList();
  }

  Future<void> studioTag(String id, String folder, List<String> tags) =>
      call('studio.tag', {'id': id, 'folder': folder, 'tags': tags});

  Future<void> studioDelete(String id) => call('studio.delete', {'id': id});

  // ---------- 轻应用（Agent 生成的单页应用）----------

  Future<List<LightApp>> listLightApps() async {
    final result = await call('lightapp.list', {});
    final list = result?['apps'] as List? ?? [];
    return list.map((e) => LightApp.fromJson((e as Map).cast<String, dynamic>())).toList();
  }

  Future<void> deleteLightApp(String id) => call('lightapp.delete', {'id': id});

  // ---------- 用量 ----------

  Future<UsageSummary> usageSummary({int days = 30}) async {
    final result = await call('usage.summary', {'days': days});
    return UsageSummary.fromJson((result as Map).cast<String, dynamic>());
  }

  // ---------- 群组 ----------

  Future<GroupSession> groupCreate({
    required String topic,
    required String mode,
    required List<Map<String, String>> members,
    String? coordinator,
  }) async {
    final result = await call('group.create', {
      'topic': topic,
      'mode': mode,
      'members': members,
      if (coordinator != null) 'coordinator': coordinator,
    });
    return GroupSession.fromJson((result as Map).cast<String, dynamic>());
  }

  Future<GroupSession> groupGet(String id) async {
    final result = await call('group.get', {'id': id});
    return GroupSession.fromJson((result as Map).cast<String, dynamic>());
  }

  Future<String> groupMessage(String id, String text) async {
    final result = await call('group.message', {'id': id, 'text': text});
    _lastSeq[result?['streamId'] as String? ?? id] = -1;
    return result?['streamId'] as String? ?? id;
  }

  Future<void> groupInject(String id, String content) =>
      call('group.inject', {'id': id, 'content': content});

  Future<dynamic> groupBoardUpdate(String id, String field, String op, String value) =>
      call('group.board.update', {'id': id, 'field': field, 'op': op, 'value': value});

  // ---------- 技能 ----------

  Future<List<SkillDescriptor>> listSkills() async {
    final result = await call('skill.list', {});
    final list = result?['skills'] as List? ?? [];
    return list.map((e) => SkillDescriptor.fromJson((e as Map).cast<String, dynamic>())).toList();
  }

  Future<void> saveSkill(String name, String description, String instructions) =>
      call('skill.save', {'name': name, 'description': description, 'instructions': instructions});

  Future<void> deleteSkill(String name) => call('skill.delete', {'name': name});

  Future<dynamic> runSkill(String name) => call('skill.run', {'name': name});

  // ---------- 定时任务 ----------

  Future<List<ScheduleEntry>> listSchedules() async {
    final result = await call('schedule.list', {});
    final list = result?['schedules'] as List? ?? [];
    return list.map((e) => ScheduleEntry.fromJson((e as Map).cast<String, dynamic>())).toList();
  }

  Future<void> createSchedule(String name, String cron, String task) =>
      call('schedule.create', {'name': name, 'cron': cron, 'task': task});

  Future<void> deleteSchedule(String id) => call('schedule.delete', {'id': id});

  // ---------- 记忆 ----------

  Future<dynamic> searchMemory(String query, {int limit = 10}) =>
      call('memory.search', {'query': query, 'limit': limit});

  Future<void> addMemory(String content, {List<String> tags = const []}) =>
      call('memory.add', {'content': content, 'tags': tags});

  Future<void> deleteMemory(int id) => call('memory.delete', {'id': id});

  // ---------- MCP ----------

  Future<dynamic> mcpList() => call('mcp.list', {});
  Future<dynamic> mcpReload(List<dynamic> servers) => call('mcp.reload', {'servers': servers});

  // ---------- 设置 ----------

  Future<dynamic> getSetting(String key) => call('settings.get', {'key': key});
  Future<void> setSetting(String key, dynamic value) => call('settings.set', {'key': key, 'value': value});

  Future<List<ToolDescriptor>> listTools() async {
    final result = await call('tool.list', {});
    final list = result?['tools'] as List? ?? [];
    return list.map((e) => ToolDescriptor.fromJson((e as Map).cast<String, dynamic>())).toList();
  }

  void dispose() {
    _reconnectTimer?.cancel();
    _channel?.sink.close();
    _channel = null;
  }
}
