import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'harness_client.dart';
import 'harness_ffi.dart';

export 'harness_client.dart';

export 'harness_client.dart'
    show
        AgentDefinition,
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

final connectionProvider =
    NotifierProvider<ConnectionNotifier, HarnessState>(ConnectionNotifier.new);

/// 当前会话。
class CurrentConversationNotifier extends Notifier<ConversationMeta?> {
  @override
  ConversationMeta? build() => null;

  void set(ConversationMeta? conversation) => state = conversation;
}

final currentConversationProvider =
    NotifierProvider<CurrentConversationNotifier, ConversationMeta?>(
        CurrentConversationNotifier.new);

/// 会话列表。
class ConversationsNotifier extends AsyncNotifier<List<ConversationMeta>> {
  @override
  Future<List<ConversationMeta>> build() => HarnessClient.instance.listConversations();

  Future<void> refresh() async {
    state = await AsyncValue.guard(() => HarnessClient.instance.listConversations());
  }
}

final conversationsProvider =
    AsyncNotifierProvider<ConversationsNotifier, List<ConversationMeta>>(
        ConversationsNotifier.new);

/// 供应商配置。
class ProvidersNotifier extends AsyncNotifier<Map<String, dynamic>> {
  @override
  Future<Map<String, dynamic>> build() => HarnessClient.instance.listProviders();

  Future<void> refresh() async {
    state = await AsyncValue.guard(() => HarnessClient.instance.listProviders());
  }
}

final providersProvider =
    AsyncNotifierProvider<ProvidersNotifier, Map<String, dynamic>>(ProvidersNotifier.new);

/// Agent 列表。
class AgentsNotifier extends AsyncNotifier<List<AgentDefinition>> {
  @override
  Future<List<AgentDefinition>> build() => HarnessClient.instance.listAgents();

  Future<void> refresh() async {
    state = await AsyncValue.guard(() => HarnessClient.instance.listAgents());
  }
}

final agentsProvider =
    AsyncNotifierProvider<AgentsNotifier, List<AgentDefinition>>(AgentsNotifier.new);

/// 当前会话选择的 Agent（新会话时用）。
class SelectedAgentNotifier extends Notifier<AgentDefinition?> {
  @override
  AgentDefinition? build() => null;

  void set(AgentDefinition? agent) => state = agent;
}

final selectedAgentProvider =
    NotifierProvider<SelectedAgentNotifier, AgentDefinition?>(SelectedAgentNotifier.new);

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
    await prefs.setString('webapps', jsonEncode(apps.map((a) => a.toJson()).toList()));
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

final webAppsProvider =
    AsyncNotifierProvider<WebAppsNotifier, List<WebApp>>(WebAppsNotifier.new);

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

final chatTargetProvider =
    NotifierProvider<ChatTargetNotifier, ChatTarget>(ChatTargetNotifier.new);

/// 对话开关:深度思考 / 联网搜索(输入条上方 TogglePill 的状态)。
/// 目前仅 UI 态;待 harness 支持对应参数后,随 sendChat 一并传递即可。
class ChatSwitches {
  const ChatSwitches({this.deepThink = false, this.webSearch = false});

  final bool deepThink;
  final bool webSearch;

  ChatSwitches copyWith({bool? deepThink, bool? webSearch}) => ChatSwitches(
        deepThink: deepThink ?? this.deepThink,
        webSearch: webSearch ?? this.webSearch,
      );
}

class ChatSwitchesNotifier extends Notifier<ChatSwitches> {
  @override
  ChatSwitches build() => const ChatSwitches();

  void toggleDeepThink() => state = state.copyWith(deepThink: !state.deepThink);
  void toggleWebSearch() => state = state.copyWith(webSearch: !state.webSearch);
}

final chatSwitchesProvider =
    NotifierProvider<ChatSwitchesNotifier, ChatSwitches>(ChatSwitchesNotifier.new);

/// 轻应用列表版本号：工具生成新应用 / 切到应用 Tab 时自增，触发列表刷新。
class LightAppsVersionNotifier extends Notifier<int> {
  @override
  int build() => 0;

  void bump() => state++;
}

final lightAppsVersionProvider =
    NotifierProvider<LightAppsVersionNotifier, int>(LightAppsVersionNotifier.new);

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
  });

  final String id;
  final String role; // user / assistant / tool / group
  String text;
  String? toolName;
  bool isError;
  bool streaming;
  String? member; // 群组成员名
  int dbId; // harness 落库 id（分叉/编辑锚点）
  bool get isTool => role == 'tool';
  bool get isGroup => role == 'group';
}

/// 聊天控制器：流式接收、工具渲染、分叉/编辑。
class ChatController extends Notifier<List<UiMessage>> {
  @override
  List<UiMessage> build() => [];

  StreamSubscription<EventFrame>? _sub;
  bool _busy = false;
  int _seq = 0;

  bool get busy => _busy;

  String _newId() => '${DateTime.now().microsecondsSinceEpoch}-${_seq++ % 1000}';

  Future<void> loadHistory(ConversationMeta conversation) async {
    clear();
    final messages = await HarnessClient.instance.listMessages(conversation.id);
    final list = <UiMessage>[];
    for (final m in messages) {
      for (final call in m.toolCalls) {
        final map = call is Map ? call.cast<String, dynamic>() : <String, dynamic>{};
        list.add(UiMessage(
          id: _newId(),
          role: 'tool',
          toolName: map['name'] as String?,
          text: '调用 ${map['name'] ?? '工具'}',
          dbId: m.id,
        ));
      }
      if (m.content.isNotEmpty) {
        list.add(UiMessage(id: _newId(), role: m.role, text: m.content, dbId: m.id));
      }
    }
    state = list;
  }

  /// 发送用户消息并跟踪流式回复。
  Future<void> send(String text) async {
    if (_busy || text.trim().isEmpty) return;
    _busy = true;

    final client = HarnessClient.instance;
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

    String streamId;
    try {
      streamId = await client.sendChat(conversation.id, text);
    } catch (e) {
      _busy = false;
      _replacePending('⚠️ 发送失败：$e');
      return;
    }
    _sub?.cancel();
    _sub = client.subscribeStream(streamId).listen(_onEvent, onDone: () {
      _busy = false;
    });
  }

  void _onEvent(EventFrame frame) {
    // ignore: avoid_print
    print('[chat] evt ${frame.kind} ${frame.kind == 'delta' ? frame.data['text'] : ''}');
    switch (frame.kind) {
      case 'delta':
        _appendToLastAssistant(frame.data['text'] as String? ?? '');
      case 'tool_call':
        _insertToolCall(
          frame.data['name'] as String? ?? '',
          (frame.data['args'] as Map?)?.toString() ?? '',
        );
      case 'tool_result':
        _insertToolResult(
          frame.data['name'] as String? ?? '',
          frame.data['content'] as String? ?? '',
          frame.data['isError'] as bool? ?? false,
        );
        // Agent 生成了新轻应用 → 应用 Tab 自动刷新
        if (frame.data['name'] == 'create_lightweight_app' &&
            frame.data['isError'] != true) {
          ref.read(lightAppsVersionProvider.notifier).bump();
        }
      case 'done' || 'error':
        _replacePending(frame.kind == 'error'
            ? '⚠️ ${frame.data['message'] ?? '出错了'}'
            : null);
        _busy = false;
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
      state = [...messages, UiMessage(id: _newId(), role: 'assistant', text: finalText)];
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
        state = [...messages, UiMessage(id: 'pending', role: 'assistant', text: '', streaming: true)];
        return;
      }
    }
  }

  void _insertToolResult(String name, String content, bool isError) {
    final short = content.length > 160 ? '${content.substring(0, 160)}…' : content;
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

  Future<void> abort() async {
    final conversation = ref.read(currentConversationProvider);
    await HarnessClient.instance.abortChat(conversationId: conversation?.id);
    _replacePending(null);
    _busy = false;
  }

  void clear() {
    _sub?.cancel();
    _sub = null;
    _busy = false;
    state = [];
  }
}

final chatProvider = NotifierProvider<ChatController, List<UiMessage>>(ChatController.new);

/// 群组 UI 状态。
class GroupChatController extends Notifier<List<UiMessage>> {
  @override
  List<UiMessage> build() => [];

  GroupSession? _session;
  StreamSubscription<EventFrame>? _sub;
  bool _busy = false;

  GroupSession? get session => _session;
  bool get busy => _busy;

  Future<void> createAndOpen({
    required String topic,
    required String mode,
    required List<Map<String, String>> members,
    String? coordinator,
  }) async {
    _session = await HarnessClient.instance.groupCreate(
      topic: topic,
      mode: mode,
      members: members,
      coordinator: coordinator,
    );
    state = [];
  }

  Future<void> send(String text) async {
    if (_busy || text.trim().isEmpty || _session == null) return;
    _busy = true;
    state = [
      ...state,
      UiMessage(id: '${DateTime.now().microsecondsSinceEpoch}', role: 'user', text: text),
      UiMessage(id: '${DateTime.now().microsecondsSinceEpoch}-p', role: 'assistant', text: '', streaming: true),
    ];
    final streamId = await HarnessClient.instance.groupMessage(_session!.id, text);
    _sub?.cancel();
    _sub = HarnessClient.instance.subscribeStream(streamId).listen((frame) {
      switch (frame.kind) {
        case 'group_message':
          _dropPending();
          state = [
            ...state,
            UiMessage(
              id: '${frame.seq}',
              role: 'group',
              member: frame.data['member'] as String?,
              text: frame.data['content'] as String? ?? '',
            ),
          ];
        case 'board_update':
          _dropPending();
          // 黑板更新后刷新 session 快照
          HarnessClient.instance.groupGet(_session!.id).then((s) => _session = s);
        case 'done' || 'error':
          _dropPending();
          _busy = false;
      }
    }, onDone: () {
      _busy = false;
    });
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
          text: '💬 注入：$content'),
    ];
  }

  void _dropPending() {
    final messages = [...state];
    messages.removeWhere((m) => m.streaming);
    state = messages;
  }

  Future<void> close() async {
    _sub?.cancel();
    _session = null;
    _busy = false;
    state = [];
  }
}

final groupChatProvider =
    NotifierProvider<GroupChatController, List<UiMessage>>(GroupChatController.new);
