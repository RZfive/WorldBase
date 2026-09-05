import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'chat_attachments.dart';
import 'harness_client.dart';
import 'harness_ffi.dart';

export 'harness_client.dart';
export 'chat_attachments.dart';

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

/// 连接状态（仅使用应用进程内的 FFI harness）。
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
    final authToken = HarnessFfi.authToken;
    if (port != null && port > 0 && authToken != null) {
      HarnessClient.instance.configure(
        host: '127.0.0.1',
        port: port,
        authToken: authToken,
      );
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
  const ChatSwitches({
    this.enableThinking = false,
    this.reasoningStrength = 'max',
    this.temperature,
  });

  final bool enableThinking;
  final String reasoningStrength;
  final double? temperature;

  ChatSwitches copyWith({
    bool? enableThinking,
    String? reasoningStrength,
    double? temperature,
  }) => ChatSwitches(
    enableThinking: enableThinking ?? this.enableThinking,
    reasoningStrength: reasoningStrength ?? this.reasoningStrength,
    temperature: temperature ?? this.temperature,
  );

  ChatSwitches withTemperature(double value) => ChatSwitches(
    enableThinking: enableThinking,
    reasoningStrength: reasoningStrength,
    temperature: value.clamp(0, 2).toDouble(),
  );
}

class ChatSwitchesNotifier extends Notifier<ChatSwitches> {
  @override
  ChatSwitches build() => const ChatSwitches();

  void setEnableThinking(bool value) {
    state = state.copyWith(enableThinking: value);
  }

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
    this.attachments = const [],
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
  List<ChatAttachment> attachments;
  bool get isTool => role == 'tool';
  bool get isGroup => role == 'group';
}

class _ChatImageTarget {
  const _ChatImageTarget({
    required this.conversationId,
    required this.messageId,
  });

  final String conversationId;
  final String messageId;
}

/// 聊天控制器：流式接收、工具渲染、分叉/编辑。
class ChatController extends Notifier<List<UiMessage>> {
  static const _draftConversationId = '__new_conversation__';

  @override
  List<UiMessage> build() {
    _imageSub = HarnessClient.instance.events.listen(_onImageEvent);
    ref.onDispose(() {
      _imageSub?.cancel();
      for (final sub in _chatSubscriptions.values) {
        sub.cancel();
      }
      for (final sub in _imageStreams.values) {
        sub.cancel();
      }
    });
    return _conversationMessages.putIfAbsent(
      _draftConversationId,
      () => <UiMessage>[],
    );
  }

  StreamSubscription<EventFrame>? _imageSub;
  final Map<String, List<UiMessage>> _conversationMessages = {};
  final Map<String, String> _streamConversationIds = {};
  final Map<String, String> _conversationStreamIds = {};
  final Map<String, StreamSubscription<EventFrame>> _chatSubscriptions = {};
  final Set<String> _startingConversationIds = {};
  final Set<String> _deletedConversationIds = {};
  final Map<String, _ChatImageTarget> _imageStreamMessages = {};
  final Map<String, StreamSubscription<EventFrame>> _imageStreams = {};
  final Map<String, Set<String>> _messageImageStreams = {};
  final Map<String, Set<String>> _messageStudioQueueTasks = {};
  final Map<String, String> _messageStudioQueueErrors = {};
  Future<void> _studioTaskWrites = Future<void>.value();
  int _seq = 0;

  String get _currentConversationId =>
      ref.read(currentConversationProvider)?.id ?? _draftConversationId;

  bool get busy => isConversationRunning(_currentConversationId);

  Set<String> get runningConversationIds =>
      {..._conversationStreamIds.keys, ..._startingConversationIds}
        ..remove(_draftConversationId);

  bool isConversationRunning(String conversationId) =>
      _startingConversationIds.contains(conversationId) ||
      _conversationStreamIds.containsKey(conversationId);

  String _imageMessageKey(String conversationId, String messageId) =>
      '$conversationId\u0000$messageId';

  List<UiMessage> _messagesFor(String conversationId) =>
      _conversationMessages.putIfAbsent(conversationId, () => <UiMessage>[]);

  void _publishMessages(String conversationId, List<UiMessage> messages) {
    if (_deletedConversationIds.contains(conversationId)) return;
    _conversationMessages[conversationId] = messages;
    if (_currentConversationId == conversationId) {
      state = [...messages];
    } else {
      // The visible messages are unchanged, but listeners such as the
      // conversation drawer still need a rebuild for background run status.
      state = [...state];
    }
  }

  void _publishRuntimeChange(String conversationId) {
    if (_deletedConversationIds.contains(conversationId)) return;
    if (_currentConversationId == conversationId) {
      state = [..._messagesFor(conversationId)];
    } else {
      state = [...state];
    }
  }

  String _newId() =>
      '${DateTime.now().microsecondsSinceEpoch}-${_seq++ % 1000}';

  Future<void> loadHistory(
    ConversationMeta conversation, {
    bool force = false,
  }) async {
    if (_deletedConversationIds.contains(conversation.id)) return;
    ref.read(currentConversationProvider.notifier).set(conversation);
    final cached = _conversationMessages[conversation.id];
    if (!force && cached != null) {
      state = [...cached];
      return;
    }
    state = cached == null ? [] : [...cached];
    final messages = await HarnessClient.instance.listMessages(conversation.id);
    if (_deletedConversationIds.contains(conversation.id)) return;
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
      if (m.content.isNotEmpty || m.parts.isNotEmpty) {
        final projection = projectChatAttachments(m.content, m.parts);
        list.add(
          UiMessage(
            id: _newId(),
            role: m.role,
            text: projection.text,
            attachments: projection.attachments,
            dbId: m.id,
          ),
        );
      }
    }
    _conversationMessages[conversation.id] = list;
    if (_currentConversationId == conversation.id) state = [...list];
  }

  void startNewConversation() {
    ref.read(currentConversationProvider.notifier).set(null);
    _conversationMessages[_draftConversationId] = <UiMessage>[];
    state = [];
  }

  String? _detachConversationRuntime(String conversationId) {
    final streamId = _conversationStreamIds.remove(conversationId);
    if (streamId != null) {
      _streamConversationIds.remove(streamId);
      _chatSubscriptions.remove(streamId)?.cancel();
    }
    _startingConversationIds.remove(conversationId);
    final imagePrefix = '$conversationId\u0000';
    final imageStreamIds = _messageImageStreams.entries
        .where((entry) => entry.key.startsWith(imagePrefix))
        .expand((entry) => entry.value)
        .toList();
    for (final imageStreamId in imageStreamIds) {
      _cleanupImageStream(imageStreamId, finalizeMessage: false);
    }
    _messageStudioQueueTasks.removeWhere(
      (key, _) => key.startsWith(imagePrefix),
    );
    _messageStudioQueueErrors.removeWhere(
      (key, _) => key.startsWith(imagePrefix),
    );
    return streamId;
  }

  void _removeConversationCache(String conversationId) {
    _conversationMessages.remove(conversationId);
    if (_currentConversationId == conversationId) startNewConversation();
  }

  /// Delete is coordinated through the controller so a running Rust task is
  /// cancelled before its conversation disappears. The tombstone prevents
  /// already-queued callbacks from recreating the removed cache.
  Future<void> deleteConversation(String conversationId) => _deleteConversation(
    conversationId,
    abortRemote: (streamId, id) => HarnessClient.instance.abortChat(
      streamId: streamId,
      conversationId: id,
    ),
    deleteRemote: HarnessClient.instance.deleteConversation,
  );

  Future<void> _deleteConversation(
    String conversationId, {
    required Future<void> Function(String? streamId, String conversationId)
    abortRemote,
    required Future<void> Function(String conversationId) deleteRemote,
  }) async {
    if (_deletedConversationIds.contains(conversationId)) return;
    final selected = ref.read(currentConversationProvider);
    final cached = _conversationMessages[conversationId];
    final wasSelected = selected?.id == conversationId;
    final streamId = _conversationStreamIds[conversationId];
    final wasRunning =
        streamId != null || _startingConversationIds.contains(conversationId);

    _deletedConversationIds.add(conversationId);
    _detachConversationRuntime(conversationId);
    if (wasSelected) startNewConversation();

    try {
      if (wasRunning) {
        try {
          await abortRemote(streamId, conversationId);
        } catch (_) {
          // Deletion is still authoritative when the run already terminated.
        }
      }
      await deleteRemote(conversationId);
      _removeConversationCache(conversationId);
    } catch (_) {
      _deletedConversationIds.remove(conversationId);
      if (cached != null) _conversationMessages[conversationId] = cached;
      if (wasSelected && selected != null) {
        ref.read(currentConversationProvider.notifier).set(selected);
        state = [...?cached];
      }
      rethrow;
    }
  }

  /// Drop local state after an externally completed deletion.
  void forgetConversation(String conversationId) {
    _deletedConversationIds.add(conversationId);
    _detachConversationRuntime(conversationId);
    _removeConversationCache(conversationId);
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
    final imageTarget = _imageStreamMessages[frame.streamId];
    if (imageTarget == null ||
        _deletedConversationIds.contains(imageTarget.conversationId)) {
      return;
    }
    final entry = ImageEntry.fromJson(raw.cast<String, dynamic>());
    final conversationId = imageTarget.conversationId;
    final cachedMessages = _conversationMessages[conversationId];
    if (cachedMessages == null) return;
    final messages = [...cachedMessages];
    UiMessage? target;
    for (final message in messages) {
      if (message.id == imageTarget.messageId) {
        target = message;
        break;
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
    _publishMessages(conversationId, messages);
  }

  /// 发送用户消息并跟踪流式回复。
  Future<bool> send(
    String text, {
    List<ChatAttachment> attachments = const [],
  }) async {
    final normalized = text.trim();
    var conversation = ref.read(currentConversationProvider);
    final initialConversationId = conversation?.id ?? _draftConversationId;
    if (isConversationRunning(initialConversationId) ||
        (normalized.isEmpty && attachments.isEmpty)) {
      return false;
    }
    _startingConversationIds.add(initialConversationId);
    _publishRuntimeChange(initialConversationId);

    final client = HarnessClient.instance;
    // Snapshot per-turn controls before any async conversation creation. A
    // toggle changed while the RPC is in flight must affect only the next
    // message, not this one.
    final target = ref.read(chatTargetProvider);
    final switches = ref.read(chatSwitchesProvider);
    var conversationId = initialConversationId;
    try {
      final filesPrompt = buildChatUploadedFilesPrompt(attachments);
      final modelText = [
        normalized,
        filesPrompt,
      ].where((part) => part.isNotEmpty).join('\n\n');
      final contentParts = <Map<String, dynamic>>[
        if (modelText.isNotEmpty) {'type': 'text', 'text': modelText},
        for (final attachment in attachments)
          if (attachment.isImage)
            {
              'type': 'image_url',
              'image_url': {'url': attachment.dataUrl},
            },
      ];
      final titleSeed = normalized.isNotEmpty
          ? normalized
          : '附件：${attachments.map((item) => item.name).join('、')}';
      if (conversation == null) {
        conversation = await client.createConversation(
          titleSeed.length > 16 ? '${titleSeed.substring(0, 16)}…' : titleSeed,
          agentId: ref.read(selectedAgentProvider)?.id,
        );
        conversationId = conversation.id;
        _startingConversationIds.remove(_draftConversationId);
        _startingConversationIds.add(conversationId);
        if (ref.read(currentConversationProvider) == null) {
          ref.read(currentConversationProvider.notifier).set(conversation);
        }
        unawaited(ref.read(conversationsProvider.notifier).refresh());
      }

      if (_deletedConversationIds.contains(conversationId)) {
        _startingConversationIds
          ..remove(initialConversationId)
          ..remove(conversationId);
        return false;
      }
      _publishMessages(conversationId, [
        ..._messagesFor(conversationId),
        UiMessage(
          id: _newId(),
          role: 'user',
          text: normalized,
          attachments: [...attachments],
        ),
        UiMessage(id: 'pending', role: 'assistant', text: '', streaming: true),
      ]);

      final streamId = await client.sendChat(
        conversationId,
        modelText,
        providerId: target.providerId,
        model: target.model,
        enableThinking: switches.enableThinking,
        reasoningEffort: switches.reasoningStrength,
        temperature: switches.temperature,
        contentParts: contentParts,
      );

      if (_deletedConversationIds.contains(conversationId)) {
        _startingConversationIds.remove(conversationId);
        try {
          await client.abortChat(
            streamId: streamId,
            conversationId: conversationId,
          );
        } catch (_) {}
        return false;
      }
      _startingConversationIds.remove(conversationId);
      _conversationStreamIds[conversationId] = streamId;
      _streamConversationIds[streamId] = conversationId;
      final sub = client
          .subscribeStream(streamId)
          .listen(
            _onEvent,
            onError: (Object error) {
              if (_streamConversationIds[streamId] != conversationId) return;
              _replacePending(conversationId, '⚠️ $error');
              _finishChatStream(streamId, conversationId);
            },
            onDone: () => _finishChatStream(streamId, conversationId),
          );
      _chatSubscriptions[streamId] = sub;
      _publishRuntimeChange(conversationId);
      return true;
    } catch (e) {
      _startingConversationIds
        ..remove(initialConversationId)
        ..remove(conversationId);
      if (_deletedConversationIds.contains(conversationId)) return false;
      // Conversation creation can fail before a pending bubble exists.
      // `_replacePending` is a no-op in that case; keep the error visible.
      final messages = _messagesFor(conversationId);
      final hadPending = messages.any((message) => message.id == 'pending');
      if (hadPending) {
        _replacePending(conversationId, '⚠️ 发送失败：$e');
      } else {
        _publishMessages(conversationId, [
          ...messages,
          UiMessage(id: _newId(), role: 'assistant', text: '⚠️ 发送失败：$e'),
        ]);
      }
      // Once the optimistic user bubble exists, the composer payload belongs
      // to that failed turn and must not remain queued for an accidental
      // duplicate retry.
      return hadPending;
    }
  }

  void _onEvent(EventFrame frame) {
    final conversationId = _streamConversationIds[frame.streamId];
    if (conversationId == null ||
        _conversationStreamIds[conversationId] != frame.streamId) {
      return;
    }
    // ignore: avoid_print
    print(
      '[chat] evt ${frame.kind} ${frame.kind == 'delta' ? frame.data['text'] : ''}',
    );
    switch (frame.kind) {
      case 'delta':
        _appendToLastAssistant(
          conversationId,
          frame.data['text'] as String? ?? '',
        );
      case 'assistant_message':
        _applyAssistantMessage(conversationId, frame.data);
      case 'tool_call':
        _insertToolCall(
          conversationId,
          frame.data['name'] as String? ?? '',
          (frame.data['args'] as Map?)?.toString() ?? '',
        );
      case 'tool_result':
        final toolName = frame.data['name'] as String? ?? '';
        _insertToolResult(
          conversationId,
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
          conversationId,
          frame.kind == 'error' ? '⚠️ ${frame.data['message'] ?? '出错了'}' : null,
        );
        _finishChatStream(frame.streamId, conversationId);
      default:
        break;
    }
  }

  void _finishChatStream(String streamId, String conversationId) {
    if (_streamConversationIds[streamId] != conversationId) return;
    _streamConversationIds.remove(streamId);
    if (_conversationStreamIds[conversationId] == streamId) {
      _conversationStreamIds.remove(conversationId);
    }
    _chatSubscriptions.remove(streamId)?.cancel();
    _publishRuntimeChange(conversationId);
  }

  void _appendToLastAssistant(String conversationId, String delta) {
    final cached = _conversationMessages[conversationId];
    if (delta.isEmpty ||
        cached == null ||
        _deletedConversationIds.contains(conversationId)) {
      return;
    }
    final messages = [...cached];
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role == 'assistant') {
        messages[i].text += delta;
        _publishMessages(conversationId, messages);
        return;
      }
    }
  }

  void _applyAssistantMessage(
    String conversationId,
    Map<String, dynamic> data,
  ) {
    final cached = _conversationMessages[conversationId];
    if (cached == null || _deletedConversationIds.contains(conversationId)) {
      return;
    }
    final parts = (data['parts'] as List? ?? const [])
        .whereType<Map>()
        .map((part) => part.cast<String, dynamic>())
        .toList();
    final projection = projectChatAttachments(
      data['content'] as String? ?? '',
      parts,
    );
    final messages = [...cached];
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role != 'assistant') continue;
      messages[i].text = projection.text;
      messages[i].attachments = projection.attachments;
      _publishMessages(conversationId, messages);
      return;
    }
  }

  void _replacePending(String conversationId, [String? finalText]) {
    final cached = _conversationMessages[conversationId];
    if (cached == null || _deletedConversationIds.contains(conversationId)) {
      return;
    }
    final messages = [...cached];
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].id == 'pending') {
        final m = messages[i];
        messages[i] = UiMessage(
          id: _newId(),
          role: 'assistant',
          text: finalText ?? m.text,
          streaming: false,
          attachments: m.attachments,
        );
        _publishMessages(conversationId, messages);
        return;
      }
    }
    if (finalText != null && finalText.isNotEmpty) {
      _publishMessages(conversationId, [
        ...messages,
        UiMessage(id: _newId(), role: 'assistant', text: finalText),
      ]);
    }
  }

  void _insertToolCall(String conversationId, String name, String argsSummary) {
    final cached = _conversationMessages[conversationId];
    if (cached == null || _deletedConversationIds.contains(conversationId)) {
      return;
    }
    final messages = [...cached];
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].id == 'pending') {
        messages[i] = UiMessage(
          id: _newId(),
          role: 'tool',
          toolName: name,
          text: argsSummary.isEmpty ? '执行中…' : argsSummary,
        );
        _publishMessages(conversationId, [
          ...messages,
          UiMessage(
            id: 'pending',
            role: 'assistant',
            text: '',
            streaming: true,
          ),
        ]);
        return;
      }
    }
  }

  void _insertToolResult(
    String conversationId,
    String name,
    String content,
    bool isError,
  ) {
    final messages = _conversationMessages[conversationId];
    if (messages == null || _deletedConversationIds.contains(conversationId)) {
      return;
    }
    final short = content.length > 160
        ? '${content.substring(0, 160)}…'
        : content;
    if (!isError && (name == 'generate_image' || name == 'edit_image')) {
      try {
        final result = jsonDecode(content);
        if (result is Map && ((result['queued'] as num?)?.toInt() ?? 0) > 0) {
          final tasks = (result['tasks'] as List? ?? const [])
              .whereType<Map>()
              .map((task) => task.cast<String, dynamic>())
              .toList();
          final expected = tasks.fold<int>(0, (sum, task) {
            return sum + ((task['n'] as num?)?.toInt() ?? 1).clamp(1, 4);
          });
          final prompts = tasks
              .map((task) => task['prompt'] as String? ?? '')
              .toList();
          final queueIds = tasks
              .map((task) => task['_queueId'] as String? ?? '')
              .toList();
          final expectedCount = expected > 0
              ? expected
              : ((result['queued'] as num?)?.toInt() ?? 1);
          final imageMessage = UiMessage(
            id: _newId(),
            role: 'tool',
            toolName: name,
            text: '已加入图片队列 · ${result['queued']} 个任务',
            imageStatus: 'waiting',
            imageExpected: expectedCount,
            imagePrompts: prompts
                .where((prompt) => prompt.trim().isNotEmpty)
                .toList(),
          );
          _publishMessages(conversationId, [...messages, imageMessage]);
          ref
              .read(studioQueueProvider.notifier)
              .registerChatTasks(
                conversationId: conversationId,
                messageId: imageMessage.id,
                prompts: prompts,
                queueIds: queueIds,
                taskCount: (result['queued'] as num?)?.toInt() ?? 1,
              );
          return;
        }
        final images = result is Map ? result['images'] as List? : null;
        if (images != null && images.isNotEmpty) {
          final entries = images
              .whereType<Map>()
              .map((item) => ImageEntry.fromJson(item.cast<String, dynamic>()))
              .toList();
          _publishMessages(conversationId, [
            ...messages,
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
          ]);
          return;
        }
      } catch (_) {
        // Fall through to the compact text receipt for older hosts.
      }
    }
    _publishMessages(conversationId, [
      ...messages,
      UiMessage(
        id: _newId(),
        role: 'tool',
        toolName: name,
        text: isError ? '❌ $short' : '✅ $short',
        isError: isError,
      ),
    ]);
  }

  Future<void> waitForImages(String messageId) async {
    final conversationId = _currentConversationId;
    final messages = _messagesFor(conversationId);
    UiMessage? message;
    for (final item in messages) {
      if (item.id == messageId) {
        message = item;
        break;
      }
    }
    if (message == null || message.imageStatus != 'queued') return;
    message.imageStatus = 'waiting';
    message.text = '正在准备图片生成…';
    _publishMessages(conversationId, [...messages]);
    final requests = await HarnessClient.instance.drainStudioTasks();
    if (requests.isEmpty) {
      message.text = '已由绘图工作室接管，生成后会自动显示';
      _publishMessages(conversationId, [...messages]);
      return;
    }
    final assignments = <String, List<Map<String, dynamic>>>{};
    for (final request in requests) {
      final prompt = request['prompt'] as String? ?? '';
      var targetId = messageId;
      for (final candidate in messages.reversed) {
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
      for (final item in messages) {
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
    _publishMessages(conversationId, [...messages]);
    var taskIndex = 0;
    for (final assignment in assignments.entries) {
      for (final request in assignment.value) {
        final taskId =
            'chat-studio-${DateTime.now().microsecondsSinceEpoch}-${taskIndex++}';
        _runImageRequest(
          request,
          conversationId,
          assignment.key,
          taskId: taskId,
        );
      }
    }
  }

  Future<void> _runImageRequest(
    Map<String, dynamic> request,
    String conversationId,
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
      if (_deletedConversationIds.contains(conversationId) ||
          !_conversationMessages.containsKey(conversationId)) {
        HarnessClient.instance.markStudioStreamFinished(streamId);
        return;
      }
      final taskRequest = <String, dynamic>{
        ...request,
        '_chatControlled': true,
        '_conversationId': conversationId,
        '_messageId': messageId,
        '_streamId': streamId,
      };
      await _persistChatTask(taskId, taskRequest, status: 'running');
      _imageStreamMessages[streamId] = _ChatImageTarget(
        conversationId: conversationId,
        messageId: messageId,
      );
      _messageImageStreams
          .putIfAbsent(
            _imageMessageKey(conversationId, messageId),
            () => <String>{},
          )
          .add(streamId);
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
                  conversationId,
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
              _markImageError(conversationId, messageId, error.toString());
              _persistChatTask(
                taskId,
                taskRequest,
                status: 'error',
                error: error.toString(),
              );
              _cleanupImageStream(streamId);
            },
            onDone: () => _cleanupImageStream(streamId),
          );
      _imageStreams[streamId] = sub;
    } catch (error) {
      _markImageError(conversationId, messageId, error.toString());
      await _persistChatTask(
        taskId,
        {
          ...request,
          '_chatControlled': true,
          '_conversationId': conversationId,
          '_messageId': messageId,
        },
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

  void _markImageError(String conversationId, String messageId, String error) {
    final messages = _conversationMessages[conversationId];
    if (messages == null || _deletedConversationIds.contains(conversationId)) {
      return;
    }
    for (final message in messages) {
      if (message.id == messageId) {
        message.imageStatus = 'error';
        message.isError = true;
        message.text = '图片生成失败：$error';
        _publishMessages(conversationId, [...messages]);
        return;
      }
    }
  }

  void trackStudioQueueTask(
    String taskId,
    String conversationId,
    String messageId,
  ) {
    if (_deletedConversationIds.contains(conversationId)) return;
    final key = _imageMessageKey(conversationId, messageId);
    _messageStudioQueueTasks.putIfAbsent(key, () => <String>{}).add(taskId);
    final messages = _conversationMessages[conversationId];
    if (messages == null) return;
    for (final message in messages) {
      if (message.id != messageId || message.imageStatus == 'done') continue;
      message.imageStatus = 'waiting';
      message.isError = false;
      message.text = '正在生成图片…';
      _publishMessages(conversationId, [...messages]);
      return;
    }
  }

  void appendStudioQueueImage(
    String conversationId,
    String messageId,
    ImageEntry entry,
  ) {
    if (_deletedConversationIds.contains(conversationId)) return;
    final messages = _conversationMessages[conversationId];
    if (messages == null) return;
    for (final message in messages) {
      if (message.id != messageId) continue;
      if (!message.imageEntries.any((item) => item.id == entry.id)) {
        message.imageEntries = [...message.imageEntries, entry];
        message.imageReceived += 1;
      }
      message.isError = false;
      message.imageStatus =
          message.imageExpected > 0 &&
              message.imageReceived >= message.imageExpected
          ? 'done'
          : 'waiting';
      message.text = message.imageStatus == 'done'
          ? '图片生成完成 · ${message.imageEntries.length} 张'
          : '正在生成图片 · ${message.imageEntries.length}${message.imageExpected > 0 ? '/${message.imageExpected}' : ''}';
      _publishMessages(conversationId, [...messages]);
      return;
    }
  }

  void finishStudioQueueTask(
    String taskId,
    String conversationId,
    String messageId, {
    String? error,
  }) {
    if (_deletedConversationIds.contains(conversationId)) return;
    final key = _imageMessageKey(conversationId, messageId);
    if (error != null) _messageStudioQueueErrors[key] = error;
    final active = _messageStudioQueueTasks[key];
    active?.remove(taskId);
    if (active?.isNotEmpty == true) return;
    _messageStudioQueueTasks.remove(key);
    final lastError = _messageStudioQueueErrors.remove(key);
    final messages = _conversationMessages[conversationId];
    if (messages == null) return;
    for (final message in messages) {
      if (message.id != messageId || message.imageStatus == 'done') continue;
      if (message.imageEntries.isNotEmpty) {
        message.imageStatus = 'done';
        message.text = '图片生成完成 · ${message.imageEntries.length} 张';
      } else if (lastError != null) {
        message.imageStatus = 'error';
        message.isError = true;
        message.text = '图片生成失败：$lastError';
      } else {
        message.imageStatus = 'error';
        message.isError = true;
        message.text = '图片生成未返回结果';
      }
      _publishMessages(conversationId, [...messages]);
      return;
    }
  }

  void _cleanupImageStream(String streamId, {bool finalizeMessage = true}) {
    HarnessClient.instance.markStudioStreamFinished(streamId);
    final imageTarget = _imageStreamMessages.remove(streamId);
    _imageStreams.remove(streamId)?.cancel();
    if (imageTarget == null) return;
    final imageMessageKey = _imageMessageKey(
      imageTarget.conversationId,
      imageTarget.messageId,
    );
    final active = _messageImageStreams[imageMessageKey];
    active?.remove(streamId);
    if (active?.isNotEmpty == true) return;
    _messageImageStreams.remove(imageMessageKey);
    if (!finalizeMessage) return;
    final messages = _conversationMessages[imageTarget.conversationId];
    if (messages == null ||
        _deletedConversationIds.contains(imageTarget.conversationId)) {
      return;
    }
    for (final message in messages) {
      if (message.id != imageTarget.messageId ||
          message.imageStatus != 'waiting') {
        continue;
      }
      if (message.imageEntries.isNotEmpty) {
        message.imageStatus = 'done';
        message.text = '图片生成完成 · ${message.imageEntries.length} 张';
      } else {
        message.imageStatus = 'error';
        message.isError = true;
        message.text = '图片生成未返回结果';
      }
      _publishMessages(imageTarget.conversationId, [...messages]);
      return;
    }
  }

  Future<void> abort() async {
    final conversation = ref.read(currentConversationProvider);
    final conversationId = conversation?.id ?? _draftConversationId;
    final streamId = _conversationStreamIds[conversationId];
    await HarnessClient.instance.abortChat(
      streamId: streamId,
      conversationId: conversation?.id,
    );
    _replacePending(conversationId);
    _startingConversationIds.remove(conversationId);
    if (streamId != null) _finishChatStream(streamId, conversationId);
  }

  void clear() => startNewConversation();

  @visibleForTesting
  void restoreConversationForTesting(
    String conversationId,
    List<UiMessage> messages, {
    bool select = false,
  }) {
    _conversationMessages[conversationId] = [...messages];
    if (select) selectConversationForTesting(conversationId);
  }

  @visibleForTesting
  void selectConversationForTesting(String conversationId) {
    ref
        .read(currentConversationProvider.notifier)
        .set(
          ConversationMeta(
            id: conversationId,
            title: conversationId,
            updatedAt: '',
          ),
        );
    state = [..._messagesFor(conversationId)];
  }

  @visibleForTesting
  void startConversationRunForTesting(String conversationId, String streamId) {
    _conversationStreamIds[conversationId] = streamId;
    _streamConversationIds[streamId] = conversationId;
    _publishRuntimeChange(conversationId);
  }

  @visibleForTesting
  void handleFrameForTesting(EventFrame frame) => _onEvent(frame);

  @visibleForTesting
  void bindImageStreamForTesting(
    String streamId,
    String conversationId,
    String messageId,
  ) {
    _imageStreamMessages[streamId] = _ChatImageTarget(
      conversationId: conversationId,
      messageId: messageId,
    );
  }

  @visibleForTesting
  void handleImageFrameForTesting(EventFrame frame) => _onImageEvent(frame);

  @visibleForTesting
  Future<void> deleteConversationForTesting(
    String conversationId, {
    required Future<void> Function(String? streamId, String conversationId)
    abortRemote,
    required Future<void> Function(String conversationId) deleteRemote,
  }) => _deleteConversation(
    conversationId,
    abortRemote: abortRemote,
    deleteRemote: deleteRemote,
  );

  @visibleForTesting
  bool hasConversationForTesting(String conversationId) =>
      _conversationMessages.containsKey(conversationId);
}

final chatProvider = NotifierProvider<ChatController, List<UiMessage>>(
  ChatController.new,
);

class _PendingChatImageTask {
  const _PendingChatImageTask({
    required this.conversationId,
    required this.messageId,
    required this.prompt,
    this.queueId,
  });

  final String conversationId;
  final String messageId;
  final String prompt;
  final String? queueId;
}

class StudioQueueState {
  const StudioQueueState({
    this.tasks = const [],
    this.maxConcurrentTasks = 2,
    this.initialized = false,
    this.galleryRevision = 0,
  });

  final List<StudioTask> tasks;
  final int maxConcurrentTasks;
  final bool initialized;
  final int galleryRevision;

  StudioQueueState copyWith({
    List<StudioTask>? tasks,
    int? maxConcurrentTasks,
    bool? initialized,
    int? galleryRevision,
  }) => StudioQueueState(
    tasks: tasks ?? this.tasks,
    maxConcurrentTasks: maxConcurrentTasks ?? this.maxConcurrentTasks,
    initialized: initialized ?? this.initialized,
    galleryRevision: galleryRevision ?? this.galleryRevision,
  );
}

/// 应用级绘图队列。页面切换只销毁表单，不会销毁任务和事件订阅。
class StudioQueueController extends Notifier<StudioQueueState> {
  @override
  StudioQueueState build() {
    _agentTaskSub = HarnessClient.instance.events.listen((frame) {
      if (frame.kind != 'tool_result') return;
      final name = frame.data['name'] as String? ?? '';
      if (name != 'generate_image' && name != 'edit_image') return;
      final content = frame.data['content'] as String? ?? '';
      try {
        final result = jsonDecode(content);
        if (result is Map && ((result['queued'] as num?)?.toInt() ?? 0) > 0) {
          unawaited(drainAgentTasks());
        }
      } catch (_) {}
    });
    _studioTaskChangedSub = HarnessClient.instance.studioTasksChanged.listen((
      _,
    ) {
      unawaited(refresh(preserveRunning: true));
    });
    ref.onDispose(() {
      _agentTaskSub?.cancel();
      _studioTaskChangedSub?.cancel();
      for (final sub in _taskSubscriptions.values) {
        sub.cancel();
      }
    });
    Future.microtask(_initialize);
    return const StudioQueueState();
  }

  final Map<String, StreamSubscription<EventFrame>> _taskSubscriptions = {};
  StreamSubscription<EventFrame>? _agentTaskSub;
  StreamSubscription<void>? _studioTaskChangedSub;
  Future<void> _taskSaveQueue = Future<void>.value();
  Future<void>? _drainFuture;
  final List<_PendingChatImageTask> _pendingChatTasks = [];
  int _taskSequence = 0;

  Future<void> _initialize() async {
    await _loadConcurrency();
    if (!ref.mounted) return;
    await refresh();
    if (!ref.mounted) return;
    await drainAgentTasks();
    if (!ref.mounted) return;
    state = state.copyWith(initialized: true);
    _runScheduler();
  }

  List<StudioTask> _sortTasks(Iterable<StudioTask> tasks) {
    final sorted = [...tasks];
    sorted.sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return sorted;
  }

  Future<void> refresh({bool preserveRunning = false}) async {
    try {
      final loaded = await HarnessClient.instance.loadStudioTasks();
      if (!ref.mounted) return;
      final localById = {for (final task in state.tasks) task.id: task};
      final restored = loaded.map((task) {
        if (task.status != 'running') return task;
        final local = localById[task.id];
        if (_taskSubscriptions.containsKey(task.id) && local != null) {
          return local;
        }
        final streamId = task.request['_streamId'] as String?;
        if (preserveRunning && local?.status == 'running') return local!;
        if (task.request['_chatControlled'] == true &&
            streamId != null &&
            HarnessClient.instance.isStudioStreamActive(streamId)) {
          return task;
        }
        return task.copyWith(status: 'queued');
      });
      state = state.copyWith(tasks: _sortTasks(restored));
      for (final task in state.tasks) {
        if (task.status == 'queued') _trackChatTask(task);
      }
      _runScheduler();
    } catch (_) {}
  }

  Future<void> _loadConcurrency() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (!ref.mounted) return;
      final value = (prefs.getInt('studio:maxConcurrentTasks') ?? 2).clamp(
        1,
        8,
      );
      state = state.copyWith(maxConcurrentTasks: value);
    } catch (_) {}
  }

  Future<void> setConcurrency(int next) async {
    final value = next.clamp(1, 8);
    if (value == state.maxConcurrentTasks) return;
    state = state.copyWith(maxConcurrentTasks: value);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setInt('studio:maxConcurrentTasks', value);
    } catch (_) {}
    _runScheduler();
  }

  Future<void> _saveTasks() async {
    final snapshot = [...state.tasks];
    _taskSaveQueue = _taskSaveQueue
        .catchError((_) {})
        .then((_) => HarnessClient.instance.saveStudioTasks(snapshot));
    try {
      await _taskSaveQueue;
    } catch (_) {}
  }

  Future<void> drainAgentTasks() {
    final active = _drainFuture;
    if (active != null) return active;
    final future = _drainAgentTasksOnce();
    _drainFuture = future;
    return future.whenComplete(() {
      if (identical(_drainFuture, future)) _drainFuture = null;
    });
  }

  void registerChatTasks({
    required String conversationId,
    required String messageId,
    required List<String> prompts,
    List<String> queueIds = const [],
    required int taskCount,
  }) => _registerChatTasks(
    conversationId: conversationId,
    messageId: messageId,
    prompts: prompts,
    queueIds: queueIds,
    taskCount: taskCount,
    scheduleDrain: true,
  );

  void _registerChatTasks({
    required String conversationId,
    required String messageId,
    required List<String> prompts,
    required List<String> queueIds,
    required int taskCount,
    required bool scheduleDrain,
  }) {
    final count = taskCount.clamp(1, 32);
    for (var index = 0; index < count; index++) {
      final prompt = prompts.isEmpty
          ? ''
          : prompts[index.clamp(0, prompts.length - 1)];
      final rawQueueId = queueIds.isEmpty
          ? ''
          : queueIds[index.clamp(0, queueIds.length - 1)];
      _pendingChatTasks.add(
        _PendingChatImageTask(
          conversationId: conversationId,
          messageId: messageId,
          prompt: prompt,
          queueId: rawQueueId.trim().isEmpty ? null : rawQueueId.trim(),
        ),
      );
    }
    if (scheduleDrain) unawaited(drainAgentTasks());
  }

  _PendingChatImageTask? _takePendingChatTask(Map<String, dynamic> request) {
    final rawQueueId = request['_queueId'];
    final queueId = rawQueueId is String && rawQueueId.trim().isNotEmpty
        ? rawQueueId.trim()
        : null;
    int index;
    if (queueId != null) {
      // An identified handoff must never fall back to prompt matching.
      index = _pendingChatTasks.indexWhere(
        (target) => target.queueId == queueId,
      );
    } else {
      final prompt = request['prompt'] as String? ?? '';
      index = _pendingChatTasks.indexWhere(
        (target) => target.queueId == null && target.prompt == prompt,
      );
      if (index < 0) {
        index = _pendingChatTasks.indexWhere(
          (target) => target.queueId == null && target.prompt.isEmpty,
        );
      }
    }
    return index < 0 ? null : _pendingChatTasks.removeAt(index);
  }

  Map<String, dynamic> _attachPendingChatTarget(Map<String, dynamic> request) {
    final chatTarget = _takePendingChatTask(request);
    if (chatTarget == null) return request;
    return <String, dynamic>{
      ...request,
      '_conversationId': chatTarget.conversationId,
      '_messageId': chatTarget.messageId,
    };
  }

  Future<void> _drainAgentTasksOnce() async {
    try {
      final pending = await HarnessClient.instance.drainStudioTasks();
      if (!ref.mounted) return;
      if (pending.isEmpty) return;
      final tasks = [...state.tasks];
      final chatTasks = <StudioTask>[];
      for (final request in pending) {
        final taskRequest = _attachPendingChatTarget(request);
        final task = _newTask(taskRequest, createdByAgent: true);
        tasks.insert(0, task);
        if (_chatTargetFor(task) != null) chatTasks.add(task);
      }
      state = state.copyWith(tasks: _sortTasks(tasks));
      for (final task in chatTasks) {
        _trackChatTask(task);
      }
      await _saveTasks();
      _runScheduler();
    } catch (_) {}
  }

  StudioTask _newTask(
    Map<String, dynamic> request, {
    required bool createdByAgent,
  }) {
    final now = DateTime.now().microsecondsSinceEpoch;
    return StudioTask(
      id: 'studio-$now-${_taskSequence++}',
      status: 'queued',
      createdAt: now,
      request: Map<String, dynamic>.from(request),
      label: request['prompt'] as String? ?? '',
      createdByAgent: createdByAgent,
    );
  }

  void enqueue(Map<String, dynamic> request, {bool createdByAgent = false}) {
    final task = _newTask(request, createdByAgent: createdByAgent);
    state = state.copyWith(tasks: [task, ...state.tasks]);
    unawaited(_saveTasks());
    _runScheduler();
  }

  StudioTask? _taskById(String id) {
    for (final task in state.tasks) {
      if (task.id == id) return task;
    }
    return null;
  }

  ({String conversationId, String messageId})? _chatTargetFor(StudioTask task) {
    final conversationId = task.request['_conversationId'] as String?;
    final messageId = task.request['_messageId'] as String?;
    if (conversationId == null || messageId == null) return null;
    return (conversationId: conversationId, messageId: messageId);
  }

  void _trackChatTask(StudioTask task) {
    final target = _chatTargetFor(task);
    if (target == null) return;
    ref
        .read(chatProvider.notifier)
        .trackStudioQueueTask(task.id, target.conversationId, target.messageId);
  }

  void _appendChatImage(StudioTask task, ImageEntry entry) {
    final target = _chatTargetFor(task);
    if (target == null) return;
    ref
        .read(chatProvider.notifier)
        .appendStudioQueueImage(target.conversationId, target.messageId, entry);
  }

  void _completeChatTask(StudioTask task, {String? error}) {
    final target = _chatTargetFor(task);
    if (target == null) return;
    ref
        .read(chatProvider.notifier)
        .finishStudioQueueTask(
          task.id,
          target.conversationId,
          target.messageId,
          error: error,
        );
  }

  void _replaceTask(StudioTask task, {bool imageAdded = false}) {
    state = state.copyWith(
      tasks: [
        for (final item in state.tasks)
          if (item.id == task.id) task else item,
      ],
      galleryRevision: imageAdded
          ? state.galleryRevision + 1
          : state.galleryRevision,
    );
  }

  void _runScheduler() {
    var running = state.tasks.where((task) => task.status == 'running').length;
    while (running < state.maxConcurrentTasks) {
      StudioTask? next;
      for (final task in state.tasks.reversed) {
        if (task.status == 'queued') {
          next = task;
          break;
        }
      }
      if (next == null) break;
      running += 1;
      unawaited(_executeTask(next));
    }
  }

  Future<void> _executeTask(StudioTask queuedTask) async {
    if (_taskById(queuedTask.id)?.status != 'queued') return;
    var task = queuedTask.copyWith(status: 'running');
    _trackChatTask(task);
    _replaceTask(task);
    unawaited(_saveTasks());
    final request = task.request;
    final taskId = task.id;
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
      task = StudioTask(
        id: task.id,
        status: task.status,
        createdAt: task.createdAt,
        request: {...task.request, '_streamId': streamId},
        label: task.label,
        createdByAgent: task.createdByAgent,
        error: task.error,
        entries: task.entries,
      );
      _replaceTask(task);
      unawaited(_saveTasks());
      final sub = HarnessClient.instance
          .subscribeStream(streamId)
          .listen(
            (frame) {
              final current = _taskById(taskId);
              if (current == null) return;
              if (frame.kind == 'image_ready') {
                final raw = frame.data['entry'];
                if (raw is! Map) return;
                final entry = ImageEntry.fromJson(raw.cast<String, dynamic>());
                final entries =
                    current.entries.any((item) => item.id == entry.id)
                    ? current.entries
                    : [...current.entries, entry];
                _replaceTask(
                  current.copyWith(entries: entries),
                  imageAdded: entries.length != current.entries.length,
                );
                _appendChatImage(current, entry);
                unawaited(_saveTasks());
              } else if (frame.kind == 'done' || frame.kind == 'error') {
                _finishTask(
                  taskId,
                  streamId,
                  error: frame.kind == 'error'
                      ? frame.data['message'] as String? ?? '生成失败'
                      : null,
                );
              }
            },
            onError: (Object error) =>
                _finishTask(taskId, streamId, error: error.toString()),
            onDone: () {
              final current = _taskById(taskId);
              if (current?.status != 'running') return;
              _finishTask(
                taskId,
                streamId,
                error: current!.entries.isEmpty ? '连接中断' : null,
              );
            },
          );
      _taskSubscriptions[taskId] = sub;
    } catch (error) {
      final current = _taskById(taskId);
      if (current != null) {
        _replaceTask(current.copyWith(status: 'error', error: '$error'));
        _completeChatTask(current, error: '$error');
        unawaited(_saveTasks());
      }
      _runScheduler();
    }
  }

  void _finishTask(String taskId, String streamId, {String? error}) {
    final current = _taskById(taskId);
    if (current?.status == 'running') {
      _replaceTask(
        error == null
            ? current!.copyWith(status: 'success')
            : current!.copyWith(status: 'error', error: error),
      );
      _completeChatTask(current, error: error);
      unawaited(_saveTasks());
    }
    HarnessClient.instance.markStudioStreamFinished(streamId);
    _taskSubscriptions.remove(taskId)?.cancel();
    _runScheduler();
  }

  void retryTask(String id) {
    final task = _taskById(id);
    if (task == null || task.status == 'running') return;
    _replaceTask(
      task.copyWith(status: 'queued', clearError: true, entries: const []),
    );
    _trackChatTask(task);
    unawaited(_saveTasks());
    _runScheduler();
  }

  void removeTask(String id) {
    final task = _taskById(id);
    if (task?.status == 'running') return;
    if (task?.status == 'queued') {
      _completeChatTask(task!, error: '任务已移除');
    }
    state = state.copyWith(
      tasks: state.tasks.where((task) => task.id != id).toList(),
    );
    unawaited(_saveTasks());
  }

  void clearFinishedTasks() {
    state = state.copyWith(
      tasks: state.tasks
          .where((task) => task.status == 'queued' || task.status == 'running')
          .toList(),
    );
    unawaited(_saveTasks());
  }

  void retryAllFailedTasks() {
    state = state.copyWith(
      tasks: state.tasks
          .map(
            (task) => task.status == 'error'
                ? task.copyWith(
                    status: 'queued',
                    clearError: true,
                    entries: const [],
                  )
                : task,
          )
          .toList(),
    );
    for (final task in state.tasks.where((task) => task.status == 'queued')) {
      _trackChatTask(task);
    }
    unawaited(_saveTasks());
    _runScheduler();
  }

  @visibleForTesting
  void restoreTasksForTesting(List<StudioTask> tasks) {
    state = state.copyWith(tasks: _sortTasks(tasks), initialized: true);
  }

  @visibleForTesting
  void registerChatTasksForTesting({
    required String conversationId,
    required String messageId,
    required List<String> prompts,
    required List<String> queueIds,
  }) {
    _registerChatTasks(
      conversationId: conversationId,
      messageId: messageId,
      prompts: prompts,
      queueIds: queueIds,
      taskCount: prompts.length,
      scheduleDrain: false,
    );
  }

  @visibleForTesting
  Map<String, dynamic> attachPendingChatTargetForTesting(
    Map<String, dynamic> request,
  ) => _attachPendingChatTarget(request);
}

final studioQueueProvider =
    NotifierProvider<StudioQueueController, StudioQueueState>(
      StudioQueueController.new,
    );

/// 群组 UI 状态。
class GroupChatController extends Notifier<List<UiMessage>> {
  static const _memberHistoryPrefix = '[[worldbase-group-member]]';

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
    String? sessionId,
    int maxParallelWorkers = 2,
  }) async {
    _session = await HarnessClient.instance.groupCreate(
      topic: topic,
      mode: mode,
      members: members,
      coordinator: coordinator,
      sessionId: sessionId,
      maxParallelWorkers: maxParallelWorkers,
    );
    await _restoreHistory();
  }

  Future<void> openAgentGroup(
    AgentGroupDefinition group,
    List<AgentDefinition> agents,
  ) async {
    if (_session?.id == group.id) {
      if (!_busy) await refreshSession();
      return;
    }
    if (_busy) {
      throw StateError('“${_session?.topic ?? '当前群聊'}”仍在执行，请等待完成后再切换群聊');
    }
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
      sessionId: group.id,
      maxParallelWorkers: group.maxParallelWorkers.clamp(1, 5),
    );
  }

  Future<void> _restoreHistory() async {
    final conversationId = _session?.conversationId;
    if (conversationId == null || conversationId.isEmpty) {
      state = [];
      return;
    }
    final messages = await HarnessClient.instance.listMessages(conversationId);
    _setPersistedHistory(messages);
  }

  void _setPersistedHistory(List<ChatMessage> messages) {
    final restored = <UiMessage>[];
    for (final message in messages) {
      if (message.isTool || message.content.trim().isEmpty) continue;
      final decoded = _decodeMemberHistory(message.content);
      final visibleText = message.role == 'user'
          ? decoded.text.trim()
          : _sanitizeGroupReply(decoded.text);
      if (visibleText.isEmpty) continue;
      restored.add(
        UiMessage(
          id: 'history-${message.id}',
          role: decoded.member == null ? message.role : 'group',
          member: decoded.member,
          text: visibleText,
          dbId: message.id,
        ),
      );
    }
    state = restored;
  }

  ({String? member, String text}) _decodeMemberHistory(String content) {
    if (!content.startsWith(_memberHistoryPrefix)) {
      return (member: null, text: content);
    }
    final lineEnd = content.indexOf('\n');
    if (lineEnd < 0) return (member: null, text: content);
    try {
      final metadata = jsonDecode(
        content.substring(_memberHistoryPrefix.length, lineEnd),
      );
      final member = metadata is Map ? metadata['name'] as String? : null;
      if (member == null || member.trim().isEmpty) {
        return (member: null, text: content.substring(lineEnd + 1));
      }
      return (member: member, text: content.substring(lineEnd + 1));
    } catch (_) {
      return (member: null, text: content);
    }
  }

  @visibleForTesting
  void restoreHistoryForTesting(List<ChatMessage> messages) =>
      _setPersistedHistory(messages);

  Future<GroupSession?> refreshSession() async {
    final sessionId = _session?.id;
    if (sessionId == null) return null;
    try {
      final snapshot = await HarnessClient.instance.groupGet(sessionId);
      if (_session?.id == sessionId) _session = snapshot;
    } catch (_) {
      // Keep the last valid snapshot when a transient refresh fails.
    }
    return _session;
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
      case 'delta':
        final delta = frame.data['text'] as String? ?? '';
        if (delta.isEmpty) return;
        _assistantBuffer += delta;
        _updatePendingText(_sanitizeGroupReply(_assistantBuffer));
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
        unawaited(refreshSession());
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
    final visibleContent = _sanitizeGroupReply(content);
    if (visibleContent.isEmpty) return;
    final pending = state.where((message) => message.streaming).toList();
    state = [
      ...state.where((message) => !message.streaming),
      UiMessage(id: id, role: 'group', member: member, text: visibleContent),
      ...pending,
    ];
    _receivedReply = true;
  }

  String _sanitizeGroupReply(String content) {
    final visible = <String>[];
    var inBoardSnapshot = false;
    for (final line in content.split('\n')) {
      var normalized = line.trim();
      if (normalized.startsWith('- ') ||
          normalized.startsWith('* ') ||
          normalized.startsWith('> ')) {
        normalized = normalized.substring(2).trimLeft();
      }
      normalized = normalized.replaceFirst(RegExp(r'^#{1,6}\s*'), '');
      if (normalized.startsWith('[board]')) continue;

      final heading = normalized
          .replaceAll(RegExp(r'[：:]$'), '')
          .trim()
          .toLowerCase();
      if (const {'当前黑板', '任务黑板', '共享黑板'}.contains(heading) ||
          heading.startsWith('shared group board')) {
        inBoardSnapshot = true;
        continue;
      }

      final isBoardField = RegExp(
        r'^(目标|假设|任务|决策|证据|待解问题|goal|assumptions|tasks|decisions|evidence|open questions)\s*[：:]',
        caseSensitive: false,
      ).hasMatch(normalized);
      final isBoardTask = RegExp(
        r'^(?:·\s*)?\[(todo|running|blocked|done)\]',
        caseSensitive: false,
      ).hasMatch(normalized);
      if (inBoardSnapshot) {
        if (normalized.isEmpty || isBoardField || isBoardTask) continue;
        inBoardSnapshot = false;
      }
      final isCompactBoardList =
          isBoardField && RegExp(r'[：:]\s*\[').hasMatch(normalized);
      if (!isCompactBoardList) visible.add(line);
    }
    return visible.join('\n').trim();
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
