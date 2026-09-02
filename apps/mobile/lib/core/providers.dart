import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'harness_client.dart';
import 'harness_ffi.dart';

export 'harness_client.dart';

export 'harness_client.dart'
    show
        AgentDefinition,
        AgentGroupDefinition,
        ChatMessage,
        ConversationMeta,
        EventFrame,
        HarnessState,
        HostRequest,
        ImageEntry,
        PendingPermission,
        ProviderEntry,
        ScheduleEntry,
        SkillDescriptor,
        ToolDescriptor,
        WebApp;

/// 连接状态（FFI 进程内优先，外部 serve 为静默降级，UI 不展示）。
class ConnectionNotifier extends Notifier<HarnessState> {
  @override
  HarnessState build() {
    HarnessClient.instance.stateStream.listen((s) {
      if (state != s) state = s;
    });
    return HarnessState.disconnected;
  }

  Future<void> connect() async {
    // FFI 进程内 harness（唯一路径；serve 部署层已删除）
    final port = await _startFfi();
    if (port != null && port > 0) {
      HarnessClient.instance.configure(host: '127.0.0.1', port: port);
      try {
        await HarnessClient.instance.connect();
        return;
      } catch (_) {}
    }
    state = HarnessState.disconnected;
  }

  /// 启动进程内 harness（数据目录用应用沙盒）。返回端口。
  Future<int?> _startFfi() async {
    String? dataDir;
    try {
      final support = await getApplicationSupportDirectory();
      dataDir = support.path;
    } catch (_) {}
    final started = HarnessFfi.start(dataDir: dataDir);
    if (started != null && started > 0) return started;
    // -2 = 已在运行：复用上次端口
    if (started != null && started == -2) return HarnessFfi.port;
    return null;
  }

  Future<void> reconnect() async {
    state = HarnessState.connecting;
    await connect();
  }

  void stopEmbedded() => HarnessFfi.stop();
}

final connectionProvider = NotifierProvider<ConnectionNotifier, HarnessState>(
  ConnectionNotifier.new,
);

/// 当前会话。
class CurrentConversationNotifier extends Notifier<ConversationMeta?> {
  @override
  ConversationMeta? build() => null;

  void set(ConversationMeta? conversation) => state = conversation;
}

final currentConversationProvider =
    NotifierProvider<CurrentConversationNotifier, ConversationMeta?>(
      CurrentConversationNotifier.new,
    );

/// 会话列表。
class ConversationsNotifier extends AsyncNotifier<List<ConversationMeta>> {
  @override
  Future<List<ConversationMeta>> build() =>
      HarnessClient.instance.listConversations();

  Future<void> refresh() async {
    state = await AsyncValue.guard(
      () => HarnessClient.instance.listConversations(),
    );
  }
}

final conversationsProvider =
    AsyncNotifierProvider<ConversationsNotifier, List<ConversationMeta>>(
      ConversationsNotifier.new,
    );

/// 供应商配置。
class ProvidersNotifier extends AsyncNotifier<Map<String, dynamic>> {
  @override
  Future<Map<String, dynamic>> build() =>
      HarnessClient.instance.listProviders();

  Future<void> refresh() async {
    state = await AsyncValue.guard(
      () => HarnessClient.instance.listProviders(),
    );
  }
}

final providersProvider =
    AsyncNotifierProvider<ProvidersNotifier, Map<String, dynamic>>(
      ProvidersNotifier.new,
    );

/// Agent 列表。
class AgentsNotifier extends AsyncNotifier<List<AgentDefinition>> {
  @override
  Future<List<AgentDefinition>> build() => HarnessClient.instance.listAgents();

  Future<void> refresh() async {
    state = await AsyncValue.guard(() => HarnessClient.instance.listAgents());
  }
}

final agentsProvider =
    AsyncNotifierProvider<AgentsNotifier, List<AgentDefinition>>(
      AgentsNotifier.new,
    );

/// 持久化 Agent 群组目录。AI 的 create_agent_group 工具也写入这里。
class AgentGroupsNotifier extends AsyncNotifier<List<AgentGroupDefinition>> {
  @override
  Future<List<AgentGroupDefinition>> build() =>
      HarnessClient.instance.listAgentGroups();

  Future<void> refresh() async {
    state = await AsyncValue.guard(
      () => HarnessClient.instance.listAgentGroups(),
    );
  }
}

final agentGroupsProvider =
    AsyncNotifierProvider<AgentGroupsNotifier, List<AgentGroupDefinition>>(
      AgentGroupsNotifier.new,
    );

/// 当前会话选择的 Agent（新会话时用）。
class SelectedAgentNotifier extends Notifier<AgentDefinition?> {
  @override
  AgentDefinition? build() => null;

  void set(AgentDefinition? agent) => state = agent;
}

final selectedAgentProvider =
    NotifierProvider<SelectedAgentNotifier, AgentDefinition?>(
      SelectedAgentNotifier.new,
    );

/// 轻应用（Web 快捷方式，本地持久化）。无默认条目——用户自行添加。
class WebAppsNotifier extends AsyncNotifier<List<WebApp>> {
  static List<WebApp> get _defaultApps => <WebApp>[];

  @override
  Future<List<WebApp>> build() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString('webapps');
    if (raw == null) return _defaultApps;
    final list = (jsonDecode(raw) as List)
        .map((e) => WebApp.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
    return list.isEmpty ? _defaultApps : list;
  }

  Future<void> _persist(List<WebApp> apps) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      'webapps',
      jsonEncode(apps.map((a) => a.toJson()).toList()),
    );
  }

  Future<void> add(WebApp app) async {
    final apps = [...(state.value ?? <WebApp>[]), app];
    state = AsyncData(apps);
    await _persist(apps);
  }

  Future<void> removeAt(int index) async {
    final apps = [...(state.value ?? <WebApp>[])]..removeAt(index);
    state = AsyncData(apps);
    await _persist(apps);
  }
}

final webAppsProvider = AsyncNotifierProvider<WebAppsNotifier, List<WebApp>>(
  WebAppsNotifier.new,
);

/// 对话的供应商/模型快速切换（null = 默认）。
class ChatTarget {
  const ChatTarget({this.providerId, this.model, this.providerName});
  final String? providerId;
  final String? model;
  final String? providerName;

  String get label {
    final p = providerName ?? (providerId == null ? '默认' : providerId!);
    return '$p · ${model == null || model!.isEmpty ? "默认模型" : model}';
  }
}

class ChatTargetNotifier extends Notifier<ChatTarget> {
  @override
  ChatTarget build() => const ChatTarget();

  void set(ChatTarget target) => state = target;
}

final chatTargetProvider = NotifierProvider<ChatTargetNotifier, ChatTarget>(
  ChatTargetNotifier.new,
);

/// 对话运行参数，对齐 Electron 输入框折叠面板。
/// 状态按发送消息读取，并映射到 Rust chat.send 的临时运行上下文。
class ChatSwitches {
  const ChatSwitches({this.reasoningStrength = 'max', this.temperature});

  final String reasoningStrength;
  final double? temperature;

  ChatSwitches copyWith({String? reasoningStrength, double? temperature}) =>
      ChatSwitches(
        reasoningStrength: reasoningStrength ?? this.reasoningStrength,
        temperature: temperature ?? this.temperature,
      );

  ChatSwitches withTemperature(double value) => ChatSwitches(
    reasoningStrength: reasoningStrength,
    temperature: value.clamp(0, 2).toDouble(),
  );
}

class ChatSwitchesNotifier extends Notifier<ChatSwitches> {
  @override
  ChatSwitches build() => const ChatSwitches();

  void setReasoningStrength(String value) {
    if (!const {'low', 'medium', 'high', 'max'}.contains(value)) return;
    state = state.copyWith(reasoningStrength: value);
  }

  void setTemperature(double value) => state = state.withTemperature(value);
}

final chatSwitchesProvider =
    NotifierProvider<ChatSwitchesNotifier, ChatSwitches>(
      ChatSwitchesNotifier.new,
    );

/// 轻应用列表版本号：工具生成新应用 / 切到应用 Tab 时自增，触发列表刷新。
class LightAppsVersionNotifier extends Notifier<int> {
  @override
  int build() => 0;

  void bump() => state++;
}

final lightAppsVersionProvider =
    NotifierProvider<LightAppsVersionNotifier, int>(
      LightAppsVersionNotifier.new,
    );

/// 聊天消息 UI 模型。
class UiMessage {
  UiMessage({
    required this.id,
    required this.role,
    this.text = '',
    this.toolName,
    this.isError = false,
    this.streaming = false,
    this.member,
    this.dbId = 0,
    this.imageStatus,
    this.imageEntries = const [],
    this.imageExpected = 0,
    this.imageReceived = 0,
    this.imagePrompts = const [],
  });

  final String id;
  final String role; // user / assistant / tool / group
  String text;
  String? toolName;
  bool isError;
  bool streaming;
  String? member; // 群组成员名
  int dbId; // harness 落库 id（分叉/编辑锚点）
  String? imageStatus; // queued / waiting / done
  List<ImageEntry> imageEntries;
  int imageExpected;
  int imageReceived;
  List<String> imagePrompts;
  bool get isTool => role == 'tool';
  bool get isGroup => role == 'group';
}

/// 聊天控制器：流式接收、工具渲染、分叉/编辑。
class ChatController extends Notifier<List<UiMessage>> {
  @override
  List<UiMessage> build() {
    _imageSub = HarnessClient.instance.events.listen(_onImageEvent);
    ref.onDispose(() => _imageSub?.cancel());
    return [];
  }

  StreamSubscription<EventFrame>? _sub;
  StreamSubscription<EventFrame>? _imageSub;
  final Map<String, String> _imageStreamMessages = {};
  final Map<String, StreamSubscription<EventFrame>> _imageStreams = {};
  final Map<String, Set<String>> _messageImageStreams = {};
  Future<void> _studioTaskWrites = Future<void>.value();
  String? _activeStreamId;
  bool _busy = false;
  int _seq = 0;

  bool get busy => _busy;

  String _newId() =>
      '${DateTime.now().microsecondsSinceEpoch}-${_seq++ % 1000}';

  Future<void> loadHistory(ConversationMeta conversation) async {
    clear();
    final messages = await HarnessClient.instance.listMessages(conversation.id);
    final list = <UiMessage>[];
    for (final m in messages) {
      for (final call in m.toolCalls) {
        final map = call is Map
            ? call.cast<String, dynamic>()
            : <String, dynamic>{};
        list.add(
          UiMessage(
            id: _newId(),
            role: 'tool',
            toolName: map['name'] as String?,
            text: '调用 ${map['name'] ?? '工具'}',
            dbId: m.id,
          ),
        );
      }
      for (final rawResult in m.toolResults) {
        final result = rawResult is Map
            ? rawResult.cast<String, dynamic>()
            : <String, dynamic>{};
        var name = result['name'] as String? ?? '';
        final content = result['content'] as String? ?? '';
        if (name.isEmpty) {
          try {
            final decoded = jsonDecode(content);
            if (decoded is Map && decoded['mode'] == 'edit') {
              name = 'edit_image';
            } else if (decoded is Map &&
                (decoded['images'] is List || decoded['queued'] != null)) {
              name = 'generate_image';
            }
          } catch (_) {}
        }
        _appendHistoricalToolResult(
          list,
          name,
          content,
          result['isError'] == true || result['is_error'] == true,
        );
      }
      if (m.content.isNotEmpty) {
        list.add(
          UiMessage(id: _newId(), role: m.role, text: m.content, dbId: m.id),
        );
      }
    }
    state = list;
  }

  void _appendHistoricalToolResult(
    List<UiMessage> list,
    String name,
    String content,
    bool isError,
  ) {
    if (!isError && (name == 'generate_image' || name == 'edit_image')) {
      try {
        final result = jsonDecode(content);
        if (result is Map &&
            ((result['images'] as List?)?.isNotEmpty ?? false)) {
          final entries = (result['images'] as List)
              .whereType<Map>()
              .map((item) => ImageEntry.fromJson(item.cast<String, dynamic>()))
              .toList();
          list.add(
            UiMessage(
              id: _newId(),
              role: 'tool',
              toolName: name,
              text: '图片生成完成 · ${entries.length} 张',
              imageStatus: 'done',
              imageEntries: entries,
              imageExpected: entries.length,
              imageReceived: entries.length,
            ),
          );
          return;
        }
        if (result is Map && ((result['queued'] as num?)?.toInt() ?? 0) > 0) {
          final prompts = (result['tasks'] as List? ?? const [])
              .whereType<Map>()
              .map((task) => task['prompt'])
              .whereType<String>()
              .where((prompt) => prompt.trim().isNotEmpty)
              .toList();
          list.add(
            UiMessage(
              id: _newId(),
              role: 'tool',
              toolName: name,
              text: '已加入图片队列 · ${result['queued']} 个任务',
              imageStatus: 'queued',
              imageExpected: (result['queued'] as num?)?.toInt() ?? 1,
              imagePrompts: prompts,
            ),
          );
          return;
        }
      } catch (_) {
        // Keep a compact text receipt for malformed or legacy tool results.
      }
    }
    final short = content.length > 160
        ? '${content.substring(0, 160)}…'
        : content;
    list.add(
      UiMessage(
        id: _newId(),
        role: 'tool',
        toolName: name,
        text: isError ? '❌ $short' : '✅ $short',
        isError: isError,
      ),
    );
  }

  void _onImageEvent(EventFrame frame) {
    if (frame.kind != 'image_ready') return;
    final raw = frame.data['entry'];
    if (raw is! Map) return;
    final entry = ImageEntry.fromJson(raw.cast<String, dynamic>());
    final messageId = _imageStreamMessages[frame.streamId];
    final messages = [...state];
    UiMessage? target;
    if (messageId != null) {
      for (final message in messages) {
        if (message.id == messageId) {
          target = message;
          break;
        }
      }
    }
    if (target == null) {
      for (final message in messages.reversed) {
        if (message.isTool &&
            (message.imageStatus == 'queued' ||
                message.imageStatus == 'waiting') &&
            (message.imagePrompts.isEmpty ||
                message.imagePrompts.contains(entry.prompt))) {
          target = message;
          break;
        }
      }
    }
    if (target == null) return;
    if (!target.imageEntries.any((item) => item.id == entry.id)) {
      target.imageEntries = [...target.imageEntries, entry];
      target.imageReceived += 1;
    }
    target.imageStatus =
        target.imageExpected > 0 && target.imageReceived >= target.imageExpected
        ? 'done'
        : 'waiting';
    target.text = target.imageStatus == 'done'
        ? '图片生成完成 · ${target.imageEntries.length} 张'
        : '正在生成图片 · ${target.imageEntries.length}${target.imageExpected > 0 ? '/${target.imageExpected}' : ''}';
    state = messages;
  }

  /// 发送用户消息并跟踪流式回复。
  Future<void> send(String text) async {
    if (_busy || text.trim().isEmpty) return;
    _busy = true;

    final client = HarnessClient.instance;
    // Snapshot per-turn controls before any async conversation creation. A
    // toggle changed while the RPC is in flight must affect only the next
    // message, not this one.
    final target = ref.read(chatTargetProvider);
    final switches = ref.read(chatSwitchesProvider);
    try {
      var conversation = ref.read(currentConversationProvider);
      conversation ??= await client.createConversation(
        text.length > 16 ? '${text.substring(0, 16)}…' : text,
        agentId: ref.read(selectedAgentProvider)?.id,
      );
      ref.read(currentConversationProvider.notifier).state = conversation;

      state = [
        ...state,
        UiMessage(id: _newId(), role: 'user', text: text),
        UiMessage(id: 'pending', role: 'assistant', text: '', streaming: true),
      ];

      final streamId = await client.sendChat(
        conversation.id,
        text,
        providerId: target.providerId,
        model: target.model,
        reasoningEffort: switches.reasoningStrength,
        temperature: switches.temperature,
      );

      _activeStreamId = streamId;
      _sub?.cancel();
      _sub = client
          .subscribeStream(streamId)
          .listen(
            _onEvent,
            onDone: () {
              if (_activeStreamId == streamId) _busy = false;
            },
          );
    } catch (e) {
      _busy = false;
      // Conversation creation can fail before a pending bubble exists.
      // `_replacePending` is a no-op in that case; keep the error visible.
      final hadPending = state.any((message) => message.id == 'pending');
      if (hadPending) {
        _replacePending('⚠️ 发送失败：$e');
      } else {
        state = [
          ...state,
          UiMessage(id: _newId(), role: 'assistant', text: '⚠️ 发送失败：$e'),
        ];
      }
    }
  }

  void _onEvent(EventFrame frame) {
    // A cancelled previous subscription can still deliver a queued callback;
    // never let it mutate the current turn's assistant bubble/state.
    if (_activeStreamId == null || frame.streamId != _activeStreamId) return;
    // ignore: avoid_print
    print(
      '[chat] evt ${frame.kind} ${frame.kind == 'delta' ? frame.data['text'] : ''}',
    );
    switch (frame.kind) {
      case 'delta':
        _appendToLastAssistant(frame.data['text'] as String? ?? '');
      case 'tool_call':
        _insertToolCall(
          frame.data['name'] as String? ?? '',
          (frame.data['args'] as Map?)?.toString() ?? '',
        );
      case 'tool_result':
        final toolName = frame.data['name'] as String? ?? '';
        _insertToolResult(
          toolName,
          frame.data['content'] as String? ?? '',
          frame.data['isError'] as bool? ?? false,
        );
        // Agent 生成了新轻应用 → 应用 Tab 自动刷新
        if (frame.data['name'] == 'create_lightweight_app' &&
            frame.data['isError'] != true) {
          ref.read(lightAppsVersionProvider.notifier).bump();
        }
        if (frame.data['isError'] != true) {
          if (toolName == 'create_agent') {
            ref.read(agentsProvider.notifier).refresh();
          } else if (toolName == 'create_agent_group') {
            ref.read(agentGroupsProvider.notifier).refresh();
          }
        }
      case 'done' || 'error':
        _replacePending(
          frame.kind == 'error' ? '⚠️ ${frame.data['message'] ?? '出错了'}' : null,
        );
        _busy = false;
        _activeStreamId = null;
      default:
        break;
    }
  }

  void _appendToLastAssistant(String delta) {
    if (delta.isEmpty) return;
    final messages = [...state];
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role == 'assistant') {
        messages[i].text += delta;
        state = messages;
        return;
      }
    }
  }

  void _replacePending([String? finalText]) {
    final messages = [...state];
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].id == 'pending') {
        final m = messages[i];
        messages[i] = UiMessage(
          id: _newId(),
          role: 'assistant',
          text: finalText ?? m.text,
          streaming: false,
        );
        state = messages;
        return;
      }
    }
    if (finalText != null && finalText.isNotEmpty) {
      state = [
        ...messages,
        UiMessage(id: _newId(), role: 'assistant', text: finalText),
      ];
    }
  }

  void _insertToolCall(String name, String argsSummary) {
    final messages = [...state];
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].id == 'pending') {
        messages[i] = UiMessage(
          id: _newId(),
          role: 'tool',
          toolName: name,
          text: argsSummary.isEmpty ? '执行中…' : argsSummary,
        );
        state = [
          ...messages,
          UiMessage(
            id: 'pending',
            role: 'assistant',
            text: '',
            streaming: true,
          ),
        ];
        return;
      }
    }
  }

  void _insertToolResult(String name, String content, bool isError) {
    final short = content.length > 160
        ? '${content.substring(0, 160)}…'
        : content;
    if (!isError && (name == 'generate_image' || name == 'edit_image')) {
      try {
        final result = jsonDecode(content);
        if (result is Map && ((result['queued'] as num?)?.toInt() ?? 0) > 0) {
          final tasks = result['tasks'] as List? ?? const [];
          final expected = tasks.fold<int>(0, (sum, task) {
            final map = task is Map ? task : const <String, dynamic>{};
            return sum + ((map['n'] as num?)?.toInt() ?? 1).clamp(1, 4);
          });
          final prompts = tasks
              .whereType<Map>()
              .map((task) => task['prompt'])
              .whereType<String>()
              .where((prompt) => prompt.trim().isNotEmpty)
              .toList();
          final expectedCount = expected > 0
              ? expected
              : ((result['queued'] as num?)?.toInt() ?? 1);
          state = [
            ...state,
            UiMessage(
              id: _newId(),
              role: 'tool',
              toolName: name,
              text: '已加入图片队列 · ${result['queued']} 个任务',
              imageStatus: 'queued',
              imageExpected: expectedCount,
              imagePrompts: prompts,
            ),
          ];
          return;
        }
        final images = result is Map ? result['images'] as List? : null;
        if (images != null && images.isNotEmpty) {
          final entries = images
              .whereType<Map>()
              .map((item) => ImageEntry.fromJson(item.cast<String, dynamic>()))
              .toList();
          state = [
            ...state,
            UiMessage(
              id: _newId(),
              role: 'tool',
              toolName: name,
              text: '图片生成完成 · ${entries.length} 张',
              imageStatus: 'done',
              imageEntries: entries,
              imageExpected: entries.length,
              imageReceived: entries.length,
            ),
          ];
          return;
        }
      } catch (_) {
        // Fall through to the compact text receipt for older hosts.
      }
    }
    state = [
      ...state,
      UiMessage(
        id: _newId(),
        role: 'tool',
        toolName: name,
        text: isError ? '❌ $short' : '✅ $short',
        isError: isError,
      ),
    ];
  }

  Future<void> waitForImages(String messageId) async {
    UiMessage? message;
    for (final item in state) {
      if (item.id == messageId) {
        message = item;
        break;
      }
    }
    if (message == null || message.imageStatus != 'queued') return;
    message.imageStatus = 'waiting';
    message.text = '正在准备图片生成…';
    state = [...state];
    final requests = await HarnessClient.instance.drainStudioTasks();
    if (requests.isEmpty) {
      message.text = '已由绘图工作室接管，生成后会自动显示';
      state = [...state];
      return;
    }
    final assignments = <String, List<Map<String, dynamic>>>{};
    for (final request in requests) {
      final prompt = request['prompt'] as String? ?? '';
      var targetId = messageId;
      for (final candidate in state.reversed) {
        if (candidate.isTool &&
            (candidate.imageStatus == 'queued' ||
                candidate.imageStatus == 'waiting') &&
            candidate.imagePrompts.contains(prompt)) {
          targetId = candidate.id;
          break;
        }
      }
      assignments.putIfAbsent(targetId, () => []).add(request);
    }
    for (final assignment in assignments.entries) {
      UiMessage? target;
      for (final item in state) {
        if (item.id == assignment.key) {
          target = item;
          break;
        }
      }
      if (target == null) continue;
      target.imageStatus = 'waiting';
      target.text = '正在生成图片…';
      target.imageExpected = assignment.value.fold<int>(0, (sum, request) {
        return sum + ((request['n'] as num?)?.toInt() ?? 1).clamp(1, 4);
      });
      target.imagePrompts = assignment.value
          .map((request) => request['prompt'])
          .whereType<String>()
          .where((prompt) => prompt.trim().isNotEmpty)
          .toList();
    }
    state = [...state];
    var taskIndex = 0;
    for (final assignment in assignments.entries) {
      for (final request in assignment.value) {
        final taskId =
            'chat-studio-${DateTime.now().microsecondsSinceEpoch}-${taskIndex++}';
        _runImageRequest(request, assignment.key, taskId: taskId);
      }
    }
  }

  Future<void> _runImageRequest(
    Map<String, dynamic> request,
    String messageId, {
    required String taskId,
  }) async {
    try {
      final streamId = await HarnessClient.instance.studioGenerate(
        prompt: request['prompt'] as String? ?? '',
        mode: request['mode'] as String? ?? 'generate',
        negativePrompt: request['negativePrompt'] as String?,
        aspect:
            request['aspect'] as String? ?? request['aspectRatio'] as String?,
        resolution: request['resolution'] as String?,
        quality: request['quality'] as String?,
        format:
            request['format'] as String? ?? request['outputFormat'] as String?,
        size: request['size'] as String?,
        n: (request['n'] as num?)?.toInt() ?? 1,
        inputImageB64: request['inputImageB64'] as String?,
        inputImages:
            (request['inputImages'] as List?)?.whereType<String>().toList() ??
            const [],
        folder: request['folder'] as String?,
        tags:
            (request['tags'] as List?)?.whereType<String>().toList() ??
            const [],
        providerId: request['providerId'] as String?,
        model: request['model'] as String?,
      );
      final taskRequest = <String, dynamic>{
        ...request,
        '_chatControlled': true,
        '_streamId': streamId,
      };
      await _persistChatTask(taskId, taskRequest, status: 'running');
      _imageStreamMessages[streamId] = messageId;
      _messageImageStreams.putIfAbsent(messageId, () => {}).add(streamId);
      final sub = HarnessClient.instance
          .subscribeStream(streamId)
          .listen(
            (frame) {
              if (frame.kind == 'image_ready') {
                final raw = frame.data['entry'];
                if (raw is Map) {
                  _appendChatTaskEntry(
                    taskId,
                    ImageEntry.fromJson(raw.cast<String, dynamic>()),
                  );
                }
              } else if (frame.kind == 'error') {
                _markImageError(
                  messageId,
                  frame.data['message'] as String? ?? '生成失败',
                );
                _persistChatTask(
                  taskId,
                  taskRequest,
                  status: 'error',
                  error: frame.data['message'] as String? ?? '生成失败',
                );
                _cleanupImageStream(streamId);
              } else if (frame.kind == 'done') {
                _persistChatTask(taskId, taskRequest, status: 'success');
                _cleanupImageStream(streamId);
              }
            },
            onError: (Object error) {
              _markImageError(messageId, error.toString());
              _persistChatTask(
                taskId,
                taskRequest,
                status: 'error',
                error: error.toString(),
              );
            },
            onDone: () => _cleanupImageStream(streamId),
          );
      _imageStreams[streamId] = sub;
    } catch (error) {
      _markImageError(messageId, error.toString());
      await _persistChatTask(
        taskId,
        request,
        status: 'error',
        error: error.toString(),
      );
    }
  }

  Future<void> _persistChatTask(
    String taskId,
    Map<String, dynamic> request, {
    required String status,
    String? error,
  }) async {
    _studioTaskWrites = _studioTaskWrites.catchError((_) {}).then((_) async {
      await HarnessClient.instance.mutateStudioTasks((existing) {
        StudioTask? previous;
        for (final item in existing) {
          if (item.id == taskId) {
            previous = item;
            break;
          }
        }
        final task = StudioTask(
          id: taskId,
          status: status,
          createdAt:
              previous?.createdAt ?? DateTime.now().microsecondsSinceEpoch,
          request: request,
          label: request['prompt'] as String? ?? '',
          createdByAgent: true,
          error: error,
          entries: previous?.entries ?? const [],
        );
        return [...existing.where((item) => item.id != taskId), task];
      });
      HarnessClient.instance.notifyStudioTasksChanged();
    });
    await _studioTaskWrites;
  }

  Future<void> _appendChatTaskEntry(String taskId, ImageEntry entry) async {
    _studioTaskWrites = _studioTaskWrites.catchError((_) {}).then((_) async {
      await HarnessClient.instance.mutateStudioTasks((existing) {
        final next = <StudioTask>[];
        for (final task in existing) {
          if (task.id != taskId) {
            next.add(task);
            continue;
          }
          final entries = task.entries.any((item) => item.id == entry.id)
              ? task.entries
              : [...task.entries, entry];
          next.add(task.copyWith(status: 'running', entries: entries));
        }
        return next;
      });
      HarnessClient.instance.notifyStudioTasksChanged();
    });
    await _studioTaskWrites;
  }

  void _markImageError(String messageId, String error) {
    for (final message in state) {
      if (message.id == messageId) {
        message.imageStatus = 'error';
        message.isError = true;
        message.text = '图片生成失败：$error';
        state = [...state];
        return;
      }
    }
  }

  void _cleanupImageStream(String streamId) {
    HarnessClient.instance.markStudioStreamFinished(streamId);
    final messageId = _imageStreamMessages.remove(streamId);
    _imageStreams.remove(streamId)?.cancel();
    if (messageId == null) return;
    final active = _messageImageStreams[messageId];
    active?.remove(streamId);
    if (active?.isNotEmpty == true) return;
    _messageImageStreams.remove(messageId);
    for (final message in state) {
      if (message.id != messageId || message.imageStatus != 'waiting') continue;
      if (message.imageEntries.isNotEmpty) {
        message.imageStatus = 'done';
        message.text = '图片生成完成 · ${message.imageEntries.length} 张';
      } else {
        message.imageStatus = 'error';
        message.isError = true;
        message.text = '图片生成未返回结果';
      }
      state = [...state];
      return;
    }
  }

  Future<void> abort() async {
    final conversation = ref.read(currentConversationProvider);
    await HarnessClient.instance.abortChat(conversationId: conversation?.id);
    _replacePending(null);
    _busy = false;
    _activeStreamId = null;
  }

  void clear() {
    _sub?.cancel();
    _sub = null;
    for (final sub in _imageStreams.values) {
      sub.cancel();
    }
    _imageStreams.clear();
    _imageStreamMessages.clear();
    _messageImageStreams.clear();
    _activeStreamId = null;
    _busy = false;
    state = [];
  }
}

final chatProvider = NotifierProvider<ChatController, List<UiMessage>>(
  ChatController.new,
);

/// 群组 UI 状态。
class GroupChatController extends Notifier<List<UiMessage>> {
  @override
  List<UiMessage> build() => [];

  GroupSession? _session;
  StreamSubscription<EventFrame>? _sub;
  String? _activeStreamId;
  String? _latestNotice;
  String _assistantBuffer = '';
  bool _receivedReply = false;
  bool _terminalReceived = false;
  bool _busy = false;

  GroupSession? get session => _session;
  bool get busy => _busy;

  Future<void> createAndOpen({
    required String topic,
    required String mode,
    required List<Map<String, String>> members,
    String? coordinator,
    int maxParallelWorkers = 2,
  }) async {
    _session = await HarnessClient.instance.groupCreate(
      topic: topic,
      mode: mode,
      members: members,
      coordinator: coordinator,
      maxParallelWorkers: maxParallelWorkers,
    );
    state = [];
  }

  Future<void> openAgentGroup(
    AgentGroupDefinition group,
    List<AgentDefinition> agents,
  ) async {
    final agentsById = {for (final agent in agents) agent.id: agent};
    final members = <Map<String, String>>[];
    for (final id in group.memberAgentIds) {
      final agent = agentsById[id];
      if (agent == null) continue;
      members.add({
        'name': agent.name,
        'persona': agent.systemPrompt.isNotEmpty
            ? agent.systemPrompt
            : agent.description,
        'agentId': agent.id,
      });
    }
    if (members.length < 2) {
      throw StateError('群组至少需要两个有效 Agent，请先在 Agent 工作区检查成员');
    }
    final coordinator = agentsById[group.coordinatorAgentId];
    if (coordinator == null) {
      throw StateError('群组协调者不存在，请先在 Agent 工作区检查配置');
    }
    await createAndOpen(
      topic: group.name,
      mode: 'discussion',
      members: members,
      coordinator: coordinator.name,
      maxParallelWorkers: group.maxParallelWorkers.clamp(1, 5),
    );
  }

  Future<bool> send(String text) async {
    if (_busy || text.trim().isEmpty || _session == null) return false;
    _busy = true;
    _latestNotice = null;
    _assistantBuffer = '';
    _receivedReply = false;
    _terminalReceived = false;
    final normalized = text.trim();
    final members = _session!.mentionedMemberIds(normalized);
    try {
      final streamId = await HarnessClient.instance.groupMessage(
        _session!.id,
        normalized,
        memberIds: members,
      );
      state = [
        ...state,
        UiMessage(
          id: '${DateTime.now().microsecondsSinceEpoch}',
          role: 'user',
          text: normalized,
        ),
        UiMessage(
          id: '${DateTime.now().microsecondsSinceEpoch}-p',
          role: 'assistant',
          text: '',
          streaming: true,
        ),
      ];
      _activeStreamId = streamId;
      await _sub?.cancel();
      _sub = HarnessClient.instance
          .subscribeStream(streamId)
          .listen(
            _handleFrame,
            onError: (Object error) => _finishWithError('$error'),
            onDone: () {
              if (!_terminalReceived && _busy) {
                _finishWithError('群聊事件流提前结束');
              }
            },
          );
      return true;
    } catch (error) {
      _busy = false;
      _activeStreamId = null;
      state = [
        ...state.where((message) => !message.streaming),
        UiMessage(
          id: 'error-${DateTime.now().microsecondsSinceEpoch}',
          role: 'assistant',
          text: '发送失败：$error',
          isError: true,
        ),
      ];
      return false;
    }
  }

  void _handleFrame(EventFrame frame) {
    if (_terminalReceived) return;
    switch (frame.kind) {
      case 'notice':
        final notice = frame.data['text'] as String? ?? '';
        if (notice.trim().isEmpty) return;
        _latestNotice = notice.trim();
        if (_assistantBuffer.isEmpty) _updatePendingText(_latestNotice!);
      case 'delta':
        final delta = frame.data['text'] as String? ?? '';
        if (delta.isEmpty) return;
        _assistantBuffer += delta;
        _updatePendingText(_assistantBuffer);
      case 'assistant_message':
        final content = frame.data['content'] as String? ?? _assistantBuffer;
        _assistantBuffer = '';
        _appendGroupReply(
          id: 'assistant-${frame.seq}',
          member: _session?.coordinator ?? 'AI',
          content: content,
        );
      case 'group_message':
        _appendGroupReply(
          id: 'group-${frame.seq}',
          member: frame.data['member'] as String?,
          content: frame.data['content'] as String? ?? '',
        );
      case 'group_direct_reply':
        final reply = (frame.data['reply'] as Map?)?.cast<String, dynamic>();
        if (reply == null) return;
        _appendGroupReply(
          id: 'direct-${reply['id'] ?? frame.seq}',
          member: reply['agentName'] as String?,
          content: reply['content'] as String? ?? '',
        );
      case 'board_update':
        final sessionId = _session?.id;
        if (sessionId == null) return;
        // 黑板更新后刷新 session 快照。
        HarnessClient.instance.groupGet(sessionId).then((snapshot) {
          if (_session?.id == sessionId) _session = snapshot;
        });
      case 'error':
        _finishWithError(frame.data['message'] as String? ?? '群聊执行失败');
      case 'done':
        final stopReason =
            (frame.data['stopReason'] ?? frame.data['stop_reason'])
                as String? ??
            '';
        if (stopReason == 'group_error') {
          _finishWithError(_latestNotice ?? '群聊执行失败');
        } else {
          _finishSuccessfully();
        }
    }
  }

  @visibleForTesting
  void handleFrameForTesting(EventFrame frame) => _handleFrame(frame);

  void _appendGroupReply({
    required String id,
    required String content,
    String? member,
  }) {
    if (content.trim().isEmpty) return;
    final pending = state.where((message) => message.streaming).toList();
    state = [
      ...state.where((message) => !message.streaming),
      UiMessage(id: id, role: 'group', member: member, text: content),
      ...pending,
    ];
    _receivedReply = true;
  }

  void _updatePendingText(String text) {
    for (final message in state) {
      if (!message.streaming) continue;
      message.text = text;
      state = [...state];
      return;
    }
  }

  void _finishSuccessfully() {
    if (_terminalReceived) return;
    if (_assistantBuffer.trim().isNotEmpty) {
      _appendGroupReply(
        id: 'assistant-${DateTime.now().microsecondsSinceEpoch}',
        member: _session?.coordinator ?? 'AI',
        content: _assistantBuffer,
      );
      _assistantBuffer = '';
    }
    _terminalReceived = true;
    _busy = false;
    _activeStreamId = null;
    _dropPending();
    if (_receivedReply) return;
    state = [
      ...state,
      UiMessage(
        id: 'empty-${DateTime.now().microsecondsSinceEpoch}',
        role: 'assistant',
        text: '群聊已完成，但没有返回可展示的成员回复',
        isError: true,
      ),
    ];
  }

  void _finishWithError(String message) {
    if (_terminalReceived) return;
    _terminalReceived = true;
    _busy = false;
    _activeStreamId = null;
    final messages = state.where((item) => !item.streaming).toList();
    messages.add(
      UiMessage(
        id: 'error-${DateTime.now().microsecondsSinceEpoch}',
        role: 'assistant',
        text: '群聊失败：$message',
        isError: true,
      ),
    );
    state = messages;
  }

  /// HITL 注入：讨论进行中发送澄清。
  Future<void> inject(String content) async {
    if (_session == null) return;
    await HarnessClient.instance.groupInject(_session!.id, content);
    state = [
      ...state,
      UiMessage(
        id: 'inject-${DateTime.now().microsecondsSinceEpoch}',
        role: 'user',
        text: '💬 注入：$content',
      ),
    ];
  }

  void _dropPending() {
    final messages = [...state];
    messages.removeWhere((m) => m.streaming);
    state = messages;
  }

  Future<void> close() async {
    final streamId = _activeStreamId;
    if (streamId != null) {
      try {
        await HarnessClient.instance.abortChat(streamId: streamId);
      } catch (_) {}
    }
    _sub?.cancel();
    _sub = null;
    _activeStreamId = null;
    _latestNotice = null;
    _assistantBuffer = '';
    _receivedReply = false;
    _terminalReceived = false;
    _session = null;
    _busy = false;
    state = [];
  }
}

final groupChatProvider =
    NotifierProvider<GroupChatController, List<UiMessage>>(
      GroupChatController.new,
    );
