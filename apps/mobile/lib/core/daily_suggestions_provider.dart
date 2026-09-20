/// 每日推荐:状态、持久化与生成(移动端)。
///
/// 与桌面端 `DailySuggestionService` 对齐,但运行在 App 进程内:
///  - 持久化用 SharedPreferences(偏好 / 最近 7 批 / 不感兴趣 / 连续关闭计数 /
///    随机知识的抽签历史与当日结果)。
///  - 生成走进程内 harness 的 `chat.send`:临时会话 + 禁用全部工具的一次纯文本补全,
///    完成后删除临时会话,不污染会话列表。每日推荐与知识探索是两次独立请求,
///    一个失败不会清空另一个。
///  - 未开启任何需要模型的组时只展示内置能力探索池与随机知识,不会消耗模型调用。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'daily_suggestions.dart';
import 'harness_client.dart';
import 'providers.dart' show connectionProvider;

export 'daily_suggestions.dart';

const String _storageKey = 'dailySuggestions:v1';
const int _maxBatchHistory = 7;
const int _maxDismissedIds = 400;
const int _maxSeedHistory = 60;
const Duration _generationTimeout = Duration(seconds: 150);

/// 上一次生成的摘要(供设置页与空态状态行使用)。
class DailySuggestionGenerationState {
  const DailySuggestionGenerationState({
    required this.date,
    required this.at,
    required this.status,
    required this.manualRefreshCount,
    this.error,
  });

  final String date;
  final String at;
  final String status;
  final int manualRefreshCount;
  final String? error;

  int get manualRefreshRemaining =>
      (dailySuggestionManualRefreshLimit - manualRefreshCount).clamp(0, dailySuggestionManualRefreshLimit).toInt();
}

class DailySuggestionState {
  const DailySuggestionState({
    this.preferences = const DailySuggestionPreferences(),
    this.daily = const [],
    this.explore = const [],
    this.knowledge = const [],
    this.knowledgeShuffleRemaining = 0,
    this.weekTheme = '',
    this.lastGeneration,
    this.generating = false,
    this.providerMissing = false,
    this.loaded = false,
  });

  final DailySuggestionPreferences preferences;

  /// 今日模型推荐,已去掉「不感兴趣」;功能关闭时为空。
  final List<WorkSuggestion> daily;

  /// 内置能力探索池,已去掉「不感兴趣」。
  final List<WorkSuggestion> explore;

  /// 今日知识卡(随机卡永远在前),已去掉「不感兴趣」;知识探索关闭时为空。
  final List<WorkSuggestion> knowledge;

  /// 今天还能「换一个」随机知识的次数。
  final int knowledgeShuffleRemaining;
  final String weekTheme;
  final DailySuggestionGenerationState? lastGeneration;
  final bool generating;
  final bool providerMissing;
  final bool loaded;

  /// 今日新到的模型卡片(每日推荐或知识探索)尚未被看到。
  bool get hasFreshDaily => daily.any((item) => item.fresh) || knowledge.any((item) => item.fresh);

  /// 当天抽中的随机知识卡(可能已被「不感兴趣」)。
  WorkSuggestion? get randomKnowledge {
    for (final item in knowledge) {
      if (item.isRandomKnowledge) return item;
    }
    return null;
  }

  DailySuggestionState copyWith({
    DailySuggestionPreferences? preferences,
    List<WorkSuggestion>? daily,
    List<WorkSuggestion>? explore,
    List<WorkSuggestion>? knowledge,
    int? knowledgeShuffleRemaining,
    String? weekTheme,
    Object? lastGeneration = _unset,
    bool? generating,
    bool? providerMissing,
    bool? loaded,
  }) => DailySuggestionState(
    preferences: preferences ?? this.preferences,
    daily: daily ?? this.daily,
    explore: explore ?? this.explore,
    knowledge: knowledge ?? this.knowledge,
    knowledgeShuffleRemaining: knowledgeShuffleRemaining ?? this.knowledgeShuffleRemaining,
    weekTheme: weekTheme ?? this.weekTheme,
    lastGeneration: identical(lastGeneration, _unset)
        ? this.lastGeneration
        : lastGeneration as DailySuggestionGenerationState?,
    generating: generating ?? this.generating,
    providerMissing: providerMissing ?? this.providerMissing,
    loaded: loaded ?? this.loaded,
  );
}

const Object _unset = Object();

/// 当天钉住的随机题目与已换次数。
class _KnowledgeToday {
  const _KnowledgeToday({required this.date, required this.seedId, required this.shuffleCount});

  final String date;
  final String seedId;
  final int shuffleCount;

  Map<String, dynamic> toJson() => {'date': date, 'seedId': seedId, 'shuffleCount': shuffleCount};

  static _KnowledgeToday? fromJson(Object? value) {
    if (value is! Map) return null;
    final date = value['date'];
    final seedId = value['seedId'];
    final count = value['shuffleCount'];
    if (date is! String || !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(date)) return null;
    if (seedId is! String || seedId.trim().isEmpty) return null;
    return _KnowledgeToday(
      date: date,
      seedId: seedId.trim(),
      shuffleCount: count is num ? count.toInt().clamp(0, 1 << 20).toInt() : 0,
    );
  }
}

String _newSalt() {
  final random = math.Random.secure();
  return List.generate(16, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
}

/// 持久化快照。
class _StoreSnapshot {
  _StoreSnapshot({
    required this.preferences,
    required this.batches,
    required this.dismissedIds,
    required this.typeDismissStreaks,
    required this.knowledgeDismissStreaks,
    required this.knowledgeSeedHistory,
    required this.knowledgeSalt,
    this.knowledgeToday,
    this.dirty = false,
  });

  DailySuggestionPreferences preferences;

  /// 新的在前。
  List<DailySuggestionBatch> batches;
  List<String> dismissedIds;
  Map<SuggestionType, int> typeDismissStreaks;
  Map<KnowledgeSource, int> knowledgeDismissStreaks;

  /// 最近出现过的随机题目,旧的在前,供抽签去重。
  List<KnowledgeSeedHistoryEntry> knowledgeSeedHistory;
  _KnowledgeToday? knowledgeToday;

  /// 按安装随机的盐,让不同用户同一天不会抽到同一条。
  String knowledgeSalt;

  /// 加载时补生成了盐,需要写回一次。
  bool dirty;

  Map<String, dynamic> toJson() => {
    'preferences': preferences.toJson(),
    'batches': batches.map((batch) => batch.toJson()).toList(),
    'dismissedIds': dismissedIds,
    'typeDismissStreaks': {
      for (final entry in typeDismissStreaks.entries) entry.key.key: entry.value,
    },
    'knowledgeDismissStreaks': {
      for (final entry in knowledgeDismissStreaks.entries) entry.key.key: entry.value,
    },
    'knowledgeSeedHistory': knowledgeSeedHistory.map((entry) => entry.toJson()).toList(),
    'knowledgeToday': knowledgeToday?.toJson(),
    'knowledgeSalt': knowledgeSalt,
  };

  static _StoreSnapshot fromJson(Object? value) {
    final raw = value is Map ? value.cast<String, dynamic>() : const <String, dynamic>{};
    final batches = (raw['batches'] is List ? raw['batches'] as List : const [])
        .map(DailySuggestionBatch.fromJson)
        .whereType<DailySuggestionBatch>()
        .toList()
      ..sort((a, b) => b.date.compareTo(a.date));
    final streaks = <SuggestionType, int>{};
    final rawStreaks = raw['typeDismissStreaks'];
    if (rawStreaks is Map) {
      for (final entry in rawStreaks.entries) {
        final type = SuggestionType.fromKey(entry.key);
        final count = entry.value;
        if (type != null && count is num && count > 0) streaks[type] = count.toInt();
      }
    }
    final knowledgeStreaks = <KnowledgeSource, int>{};
    final rawKnowledgeStreaks = raw['knowledgeDismissStreaks'];
    if (rawKnowledgeStreaks is Map) {
      for (final entry in rawKnowledgeStreaks.entries) {
        final source = KnowledgeSource.fromKey(entry.key);
        final count = entry.value;
        if (source != null && count is num && count > 0) knowledgeStreaks[source] = count.toInt();
      }
    }
    final dismissed = (raw['dismissedIds'] is List ? raw['dismissedIds'] as List : const [])
        .whereType<String>()
        .toList();
    final history = (raw['knowledgeSeedHistory'] is List ? raw['knowledgeSeedHistory'] as List : const [])
        .map(KnowledgeSeedHistoryEntry.fromJson)
        .whereType<KnowledgeSeedHistoryEntry>()
        .toList();
    final rawSalt = raw['knowledgeSalt'];
    final hasSalt = rawSalt is String && rawSalt.trim().isNotEmpty;
    return _StoreSnapshot(
      preferences: DailySuggestionPreferences.fromJson(raw['preferences']),
      batches: batches.take(_maxBatchHistory).toList(),
      dismissedIds: dismissed.length > _maxDismissedIds
          ? dismissed.sublist(dismissed.length - _maxDismissedIds)
          : dismissed,
      typeDismissStreaks: streaks,
      knowledgeDismissStreaks: knowledgeStreaks,
      knowledgeSeedHistory: history.length > _maxSeedHistory
          ? history.sublist(history.length - _maxSeedHistory)
          : history,
      knowledgeToday: _KnowledgeToday.fromJson(raw['knowledgeToday']),
      knowledgeSalt: hasSalt ? rawSalt.trim() : _newSalt(),
      dirty: !hasSalt,
    );
  }
}

/// 生成所需的宿主能力,抽象出来便于测试替换。
abstract class DailySuggestionBackend {
  bool get isConnected;
  Future<DailySuggestionContext> collectContext(DailySuggestionContextScope scope);

  /// 是否存在可用的模型服务(providerId 为 null 表示跟随默认)。
  Future<bool> hasProvider(String? providerId);

  /// 一次纯文本补全,返回模型回复全文。
  Future<String> complete(String prompt, {String? providerId, String? modelId});
}

/// 通过进程内 harness 实现的默认后端。
class HarnessDailySuggestionBackend implements DailySuggestionBackend {
  HarnessDailySuggestionBackend([HarnessClient? client]) : _client = client ?? HarnessClient.instance;

  final HarnessClient _client;

  @override
  bool get isConnected => _client.state == HarnessState.connected;

  @override
  Future<DailySuggestionContext> collectContext(DailySuggestionContextScope scope) async {
    Future<List<T>> safe<T>(Future<List<T>> Function() load) async {
      try {
        return await load();
      } catch (_) {
        return const [];
      }
    }

    final lightApps = scope.lightApps ? await safe(_client.listLightApps) : const <LightApp>[];
    final conversations = scope.conversationTitles
        ? await safe(_client.listConversations)
        : const <ConversationMeta>[];
    final documents = scope.documents ? await safe(_client.listDocuments) : const <DocumentSummary>[];
    final skills = await safe(_client.listSkills);
    final schedules = await safe(_client.listSchedules);
    final groups = await safe(_client.listAgentGroups);
    var mcpNames = const <String>[];
    try {
      final mcp = await _client.getMcpState();
      mcpNames = mcp.servers.where((server) => server.enabled).map((server) => server.name).toList();
    } catch (_) {}

    final sortedConversations = [...conversations]
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return DailySuggestionContext(
      lightAppNames: lightApps.map((app) => app.name).where((name) => name.isNotEmpty).toList(),
      conversationTitles: sortedConversations
          .where((conversation) => !conversation.isGroup && conversation.title.isNotEmpty)
          .map((conversation) => conversation.title)
          .toList(),
      documentNames: documents.map((doc) => doc.fileName).where((name) => name.isNotEmpty).toList(),
      skillNames: skills.map((skill) => skill.name).toList(),
      mcpServerNames: mcpNames,
      scheduleCount: schedules.length,
      agentGroupCount: groups.length,
    );
  }

  @override
  Future<bool> hasProvider(String? providerId) async {
    try {
      final config = await _client.listProviders();
      final providers = (config['providers'] as List? ?? const [])
          .whereType<Map>()
          .map((raw) => raw.cast<String, dynamic>())
          .toList();
      if (providers.isEmpty) return false;
      if (providerId == null) return true;
      return providers.any((provider) => provider['id'] == providerId);
    } catch (_) {
      return false;
    }
  }

  @override
  Future<String> complete(String prompt, {String? providerId, String? modelId}) async {
    final conversation = await _client.createConversation('每日推荐 · 生成中');
    try {
      final result = await _client.call('chat.send', {
        'conversationId': conversation.id,
        'text': prompt,
        'providerId': ?providerId,
        if (modelId != null && modelId.isNotEmpty) 'model': modelId,
        'enableThinking': false,
        // A non-empty allow list that matches no tool turns the run into a
        // plain completion; an empty list would mean "every tool".
        'allowedToolNames': const ['__daily_suggestions_no_tools__'],
      });
      final streamId = result is Map ? (result['streamId'] ?? result['stream_id']) : null;
      if (streamId is! String || streamId.isEmpty) {
        throw const FormatException('chat.send response missing streamId');
      }
      final buffer = StringBuffer();
      String? finalText;
      final completer = Completer<String>();
      late final StreamSubscription<EventFrame> sub;
      sub = _client.subscribeStream(streamId).listen(
        (frame) {
          switch (frame.kind) {
            case 'delta':
              buffer.write(frame.data['text'] as String? ?? '');
            case 'assistant_message':
              final content = frame.data['content'];
              if (content is String && content.isNotEmpty) finalText = content;
            case 'reset':
              buffer.clear();
            case 'done':
              if (!completer.isCompleted) completer.complete(finalText ?? buffer.toString());
            case 'error':
              if (!completer.isCompleted) {
                completer.completeError(
                  Exception(frame.data['message'] as String? ?? 'MODEL_ERROR'),
                );
              }
            default:
              break;
          }
        },
        onError: (Object error) {
          if (!completer.isCompleted) completer.completeError(error);
        },
        onDone: () {
          if (!completer.isCompleted) completer.complete(finalText ?? buffer.toString());
        },
      );
      try {
        return await completer.future.timeout(_generationTimeout, onTimeout: () {
          unawaited(_client.abortChat(streamId: streamId, conversationId: conversation.id).catchError((_) {}));
          throw TimeoutException('MODEL_TIMEOUT');
        });
      } finally {
        await sub.cancel();
      }
    } finally {
      // The scratch conversation only exists to host the completion.
      unawaited(_client.deleteConversation(conversation.id).catchError((_) {}));
    }
  }
}

/// 可注入的依赖(测试用)。
class DailySuggestionDeps {
  const DailySuggestionDeps({this.backend, this.now, this.prefs});

  final DailySuggestionBackend? backend;
  final DateTime Function()? now;
  final Future<SharedPreferences> Function()? prefs;
}

final dailySuggestionDepsProvider = Provider<DailySuggestionDeps>((ref) => const DailySuggestionDeps());

class DailySuggestionsNotifier extends Notifier<DailySuggestionState> {
  _StoreSnapshot _store = _StoreSnapshot(
    preferences: const DailySuggestionPreferences(),
    batches: [],
    dismissedIds: [],
    typeDismissStreaks: {},
    knowledgeDismissStreaks: {},
    knowledgeSeedHistory: [],
    knowledgeSalt: _newSalt(),
  );
  Future<void>? _generating;
  Timer? _timeTriggerTimer;
  bool _providerMissing = false;

  DailySuggestionBackend get _backend =>
      ref.read(dailySuggestionDepsProvider).backend ?? HarnessDailySuggestionBackend();

  DateTime _now() => ref.read(dailySuggestionDepsProvider).now?.call() ?? DateTime.now();

  Future<SharedPreferences> _prefs() =>
      ref.read(dailySuggestionDepsProvider).prefs?.call() ?? SharedPreferences.getInstance();

  @override
  DailySuggestionState build() {
    ref.onDispose(() => _timeTriggerTimer?.cancel());
    // A connected harness is what makes generation possible; catch up as soon
    // as it comes online instead of waiting for the next app launch.
    ref.listen<HarnessState>(connectionProvider, (previous, next) {
      if (next == HarnessState.connected && previous != HarnessState.connected) {
        unawaited(runIfDue());
      }
    });
    unawaited(_load());
    return _project(loaded: false);
  }

  // ---------------------------------------------------------------- persistence

  Future<void> _load() async {
    try {
      final prefs = await _prefs();
      final raw = prefs.getString(_storageKey);
      if (raw != null) _store = _StoreSnapshot.fromJson(jsonDecode(raw));
    } catch (_) {
      // Keep defaults; the feature degrades to the built-in pool.
    }
    if (!ref.mounted) return;
    // Pin today's random seed before the first projection so the salt and the
    // draw are both persisted together.
    final needsSave = _store.dirty || _pinRandomSeed(formatLocalDate(_now()));
    _store.dirty = false;
    state = _project(loaded: true);
    if (needsSave) await _persist();
    _reschedule();
    unawaited(runIfDue());
  }

  Future<void> _persist() async {
    try {
      final prefs = await _prefs();
      await prefs.setString(_storageKey, jsonEncode(_store.toJson()));
    } catch (_) {}
  }

  DailySuggestionBatch? _batchFor(String date) {
    for (final batch in _store.batches) {
      if (batch.date == date) return batch;
    }
    return null;
  }

  void _saveBatch(DailySuggestionBatch batch) {
    _store.batches = [batch, ..._store.batches.where((existing) => existing.date != batch.date)]
        .take(_maxBatchHistory)
        .toList();
  }

  /// 今天的批次;若今天失败或缺失,则沿用最近 3 天内的成功批次并保留今天的失败信息。
  DailySuggestionBatch? _displayBatch(String today) {
    if (!_store.preferences.needsModel) return null;
    final todays = _batchFor(today);
    if (todays != null && todays.status != 'failed') return todays;
    for (final batch in _store.batches) {
      if (batch.status == 'failed') continue;
      if (daysBetweenLocalDates(batch.date, today) > dailySuggestionStaleBatchMaxAgeDays) continue;
      if (todays == null) return batch;
      return DailySuggestionBatch(
        date: today,
        status: 'failed',
        items: batch.items,
        generatedAt: todays.generatedAt,
        error: todays.error,
        manualRefreshCount: todays.manualRefreshCount,
      );
    }
    return todays;
  }

  // ---------------------------------------------------------------- knowledge seeds

  /// 当天钉住的随机题目;还没抽过时抽一条并钉住。返回是否有改动需要持久化。
  bool _pinRandomSeed(String today) {
    final current = _store.knowledgeToday;
    if (current != null && current.date == today && knowledgeSeedById(current.seedId) != null) return false;
    final seed = drawKnowledgeSeed(today, _store.knowledgeSalt, _store.knowledgeSeedHistory);
    _setKnowledgeToday(today, seed.id, shuffle: false);
    return true;
  }

  KnowledgeSeed? _todaySeed(String today) {
    final current = _store.knowledgeToday;
    if (current == null || current.date != today) return null;
    return knowledgeSeedById(current.seedId);
  }

  void _setKnowledgeToday(String today, String seedId, {required bool shuffle}) {
    final current = _store.knowledgeToday;
    final sameDay = current != null && current.date == today;
    final count = (sameDay ? current.shuffleCount : 0) + (shuffle ? 1 : 0);
    _store.knowledgeToday = _KnowledgeToday(date: today, seedId: seedId, shuffleCount: count);
    final alreadyRecorded = _store.knowledgeSeedHistory.any((entry) => entry.seedId == seedId && entry.date == today);
    if (!alreadyRecorded) {
      final history = [..._store.knowledgeSeedHistory, KnowledgeSeedHistoryEntry(seedId: seedId, date: today)];
      _store.knowledgeSeedHistory = history.length > _maxSeedHistory
          ? history.sublist(history.length - _maxSeedHistory)
          : history;
    }
  }

  int _shuffleRemaining(String today) {
    final current = _store.knowledgeToday;
    final used = current != null && current.date == today ? current.shuffleCount : 0;
    return (knowledgeShuffleLimit - used).clamp(0, knowledgeShuffleLimit).toInt();
  }

  /// 「换一个」:换掉今天的随机知识。每天限 [knowledgeShuffleLimit] 次,
  /// 与模型批次的「换一批」互不占用。
  Future<void> shuffleKnowledge() async {
    final preferences = _store.preferences.knowledge;
    if (!preferences.enabled || !preferences.sources.contains(KnowledgeSource.random)) {
      throw StateError('KNOWLEDGE_RANDOM_DISABLED');
    }
    final today = formatLocalDate(_now());
    _pinRandomSeed(today);
    final current = _store.knowledgeToday!;
    if (current.shuffleCount >= knowledgeShuffleLimit) throw StateError('KNOWLEDGE_SHUFFLE_LIMIT');
    KnowledgeSeed? next;
    // Attempts are deterministic; walk forward until the draw lands on a different seed.
    for (var attempt = current.shuffleCount + 1; attempt <= current.shuffleCount + 40; attempt++) {
      final candidate = drawKnowledgeSeed(today, _store.knowledgeSalt, _store.knowledgeSeedHistory, attempt: attempt);
      if (candidate.id != current.seedId) {
        next = candidate;
        break;
      }
    }
    if (next == null) throw StateError('KNOWLEDGE_POOL_EXHAUSTED');
    _setKnowledgeToday(today, next.id, shuffle: true);
    _publish();
    await _persist();
  }

  List<WorkSuggestion> _knowledgeItems(DailySuggestionBatch? batch, String today, Set<String> dismissed) {
    final preferences = _store.preferences.knowledge;
    if (!preferences.enabled) return const [];
    final items = <WorkSuggestion>[];
    final llmItems = (batch?.items ?? const <WorkSuggestion>[])
        .where((item) => item.isKnowledge && !dismissed.contains(item.id))
        .toList();
    if (preferences.sources.contains(KnowledgeSource.random)) {
      final seed = _todaySeed(today);
      if (seed != null) {
        final card = buildKnowledgeSeedSuggestion(seed, today);
        if (!dismissed.contains(card.id)) items.add(card);
        // Items sharing the random card's discipline read as repeats; push them to the back.
        final key = seed.discipline.key;
        llmItems.sort((a, b) => (a.knowledge?.discipline == key ? 1 : 0) - (b.knowledge?.discipline == key ? 1 : 0));
      }
    }
    return items..addAll(llmItems);
  }

  DailySuggestionState _project({bool? loaded}) {
    final now = _now();
    final today = formatLocalDate(now);
    final dismissed = _store.dismissedIds.toSet();
    final explore = buildExploreSuggestions(now);
    final batch = _displayBatch(today);
    final preferences = _store.preferences;
    return DailySuggestionState(
      preferences: preferences,
      daily: batch == null || !preferences.enabled
          ? const []
          : batch.items.where((item) => item.isDaily && !dismissed.contains(item.id)).toList(),
      explore: explore.items.where((item) => !dismissed.contains(item.id)).toList(),
      knowledge: _knowledgeItems(batch, today, dismissed),
      knowledgeShuffleRemaining: _shuffleRemaining(today),
      weekTheme: explore.theme.label,
      lastGeneration: batch == null
          ? null
          : DailySuggestionGenerationState(
              date: batch.date,
              at: batch.generatedAt,
              status: batch.status,
              error: batch.error,
              manualRefreshCount: batch.manualRefreshCount,
            ),
      generating: _generating != null,
      providerMissing: _providerMissing,
      loaded: loaded ?? state.loaded,
    );
  }

  void _publish() {
    if (ref.mounted) state = _project();
  }

  // ---------------------------------------------------------------- preferences

  Future<void> setPreferences(DailySuggestionPreferences next) async {
    final previous = _store.preferences;
    _store.preferences = DailySuggestionPreferences.fromJson(next.toJson());
    final current = _store.preferences;
    // A new day may have started since load; keep the random card pinned.
    if (current.knowledge.enabled) _pinRandomSeed(formatLocalDate(_now()));
    _publish();
    await _persist();
    _reschedule();
    // Turning a model-backed group on should show something today, not tomorrow.
    final knowledgeScopeGrew = current.knowledge.needsModel &&
        (!previous.knowledge.needsModel ||
            current.knowledge.sources.any((source) => !previous.knowledge.sources.contains(source)) ||
            (current.knowledge.interests.isNotEmpty && previous.knowledge.interests.isEmpty));
    if ((current.needsModel && !previous.needsModel) || (current.enabled && !previous.enabled) || knowledgeScopeGrew) {
      unawaited(runIfDue(force: true));
    }
  }

  Future<void> setEnabled(bool enabled) => setPreferences(_store.preferences.copyWith(enabled: enabled));

  Future<void> setKnowledgePreferences(KnowledgePreferences knowledge) =>
      setPreferences(_store.preferences.copyWith(knowledge: knowledge));

  // ---------------------------------------------------------------- interactions

  Future<void> dismiss(WorkSuggestion suggestion) async {
    if (_store.dismissedIds.contains(suggestion.id)) return;
    _store.dismissedIds = [..._store.dismissedIds, suggestion.id];
    final type = SuggestionType.fromKey(suggestion.type);
    if (type != null) {
      _store.typeDismissStreaks[type] = (_store.typeDismissStreaks[type] ?? 0) + 1;
    }
    final source = suggestion.knowledge?.source;
    if (source != null) {
      _store.knowledgeDismissStreaks[source] = (_store.knowledgeDismissStreaks[source] ?? 0) + 1;
    }
    _publish();
    await _persist();
  }

  /// 使用了一张卡片:结束该类型 / 来源的连续关闭计数,并清掉「新」角标。
  Future<void> recordPick(WorkSuggestion suggestion) async {
    final type = SuggestionType.fromKey(suggestion.type);
    var changed = false;
    if (type != null && _store.typeDismissStreaks.remove(type) != null) changed = true;
    final source = suggestion.knowledge?.source;
    if (source != null && _store.knowledgeDismissStreaks.remove(source) != null) changed = true;
    if (suggestion.fresh && _clearFresh({suggestion.id})) changed = true;
    if (!changed) return;
    _publish();
    await _persist();
  }

  /// 今日卡片已被看到,「新」角标只展示一次。
  Future<void> markSeen() async {
    final today = formatLocalDate(_now());
    final batch = _batchFor(today);
    if (batch == null) return;
    if (!_clearFresh(batch.items.where((item) => item.fresh).map((item) => item.id).toSet())) return;
    _publish();
    await _persist();
  }

  bool _clearFresh(Set<String> ids) {
    if (ids.isEmpty) return false;
    var changed = false;
    _store.batches = _store.batches.map((batch) {
      if (!batch.items.any((item) => ids.contains(item.id) && item.fresh)) return batch;
      changed = true;
      return batch.copyWith(
        items: batch.items.map((item) => ids.contains(item.id) ? item.copyWith(fresh: false) : item).toList(),
      );
    }).toList();
    return changed;
  }

  // ---------------------------------------------------------------- scheduling

  void _reschedule() {
    _timeTriggerTimer?.cancel();
    _timeTriggerTimer = null;
    final preferences = _store.preferences;
    if (!preferences.needsModel || preferences.trigger.kind != DailySuggestionTriggerKind.time) return;
    final now = _now();
    final parts = preferences.trigger.timeOfDay.split(':').map(int.parse).toList();
    var next = DateTime(now.year, now.month, now.day, parts[0], parts[1]);
    if (!next.isAfter(now)) next = next.add(const Duration(days: 1));
    _timeTriggerTimer = Timer(next.difference(now), () {
      _timeTriggerTimer = null;
      unawaited(runIfDue().whenComplete(_reschedule));
    });
  }

  /// 今天还没有批次且触发条件满足时生成:
  ///  - 首次打开:任何时机都算。
  ///  - 固定时间:只有当天该时刻已过才补跑(定时器到点时也走这里)。
  ///  - `force`(刚开启某个组):已有批次但缺少该组的条目时也再跑一次。
  Future<void> runIfDue({bool force = false}) async {
    final preferences = _store.preferences;
    if (!preferences.needsModel) return;
    final now = _now();
    final today = formatLocalDate(now);
    final existing = _batchFor(today);
    final missingGroup = existing != null &&
        force &&
        ((preferences.enabled && !existing.items.any((item) => item.isDaily)) ||
            (preferences.knowledge.needsModel && !existing.items.any((item) => item.isKnowledge)));
    if (existing != null && !missingGroup) return;
    if (!force && preferences.trigger.kind == DailySuggestionTriggerKind.time) {
      final parts = preferences.trigger.timeOfDay.split(':').map(int.parse).toList();
      final scheduled = DateTime(now.year, now.month, now.day, parts[0], parts[1]);
      if (scheduled.isAfter(now)) return;
    }
    if (!_backend.isConnected) return;
    await _generate(manual: false);
  }

  /// 用户主动「换一批」/「立即生成」。当天第一次生成不计入手动次数。
  Future<void> generateNow() async {
    if (!_store.preferences.needsModel) throw StateError('DAILY_SUGGESTIONS_DISABLED');
    final existing = _batchFor(formatLocalDate(_now()));
    if (existing != null && existing.manualRefreshCount >= dailySuggestionManualRefreshLimit) {
      throw StateError('DAILY_SUGGESTIONS_REFRESH_LIMIT');
    }
    await _generate(manual: true);
  }

  Future<void> _generate({required bool manual}) {
    final active = _generating;
    if (active != null) return active;
    final future = _generateInternal(manual: manual);
    _generating = future;
    _publish();
    return future.whenComplete(() {
      if (identical(_generating, future)) _generating = null;
      _publish();
    });
  }

  Future<void> _generateInternal({required bool manual}) async {
    final now = _now();
    final today = formatLocalDate(now);
    final preferences = _store.preferences;
    final previous = _batchFor(today);
    final manualRefreshCount = (previous?.manualRefreshCount ?? 0) + (manual && previous != null ? 1 : 0);
    final backend = _backend;
    final wantDaily = preferences.enabled;
    final wantKnowledge = preferences.knowledge.needsModel;

    if (!await backend.hasProvider(preferences.providerId)) {
      _providerMissing = true;
      _saveBatch(
        DailySuggestionBatch(
          date: today,
          status: 'failed',
          items: previous?.items ?? const [],
          generatedAt: now.toIso8601String(),
          error: 'PROVIDER_MISSING',
          manualRefreshCount: manualRefreshCount,
        ),
      );
      await _persist();
      return;
    }
    _providerMissing = false;

    final context = await backend.collectContext(preferences.context);
    if (preferences.knowledge.enabled) _pinRandomSeed(today);

    // The two groups are separate requests so one failing never empties the
    // other, and the daily JSON contract stays exactly as it was.
    final results = await Future.wait([
      wantDaily
          ? _requestItems(
              backend,
              buildDailySuggestionPrompt(preferences, context, dismissStreaks: _store.typeDismissStreaks),
              (item, index) => normalizeLlmSuggestion(item, preferences.types.toSet(), date: today, index: index),
            )
          : Future.value(const _RequestResult()),
      wantKnowledge
          ? _requestItems(
              backend,
              buildKnowledgePrompt(
                preferences,
                context,
                todaySeed: _todaySeed(today),
                dismissStreaks: _store.knowledgeDismissStreaks,
              ),
              (item, index) => normalizeKnowledgeSuggestion(item, preferences.knowledge, date: today, index: index),
            )
          : Future.value(const _RequestResult()),
    ]);
    final dailyResult = results[0];
    final knowledgeResult = results[1];

    var dailyItems = const <WorkSuggestion>[];
    var dailyStatus = 'ok';
    if (wantDaily) {
      final assembled = assembleDailyBatch(dailyResult.items, preferences);
      dailyItems = assembled.items;
      dailyStatus = assembled.status;
    }
    final knowledgeItems = wantKnowledge
        ? assembleKnowledgeItems(knowledgeResult.items, preferences.knowledge)
        : const <WorkSuggestion>[];

    final dailyFailed = wantDaily && dailyStatus == 'failed';
    final knowledgeFailed = wantKnowledge && knowledgeItems.isEmpty;
    final previousItems = previous?.items ?? const <WorkSuggestion>[];
    final String status;
    if ((!wantDaily || dailyFailed) && (!wantKnowledge || knowledgeFailed)) {
      status = 'failed';
    } else if (dailyFailed || knowledgeFailed || dailyStatus == 'partial') {
      status = 'partial';
    } else {
      status = 'ok';
    }

    _saveBatch(
      DailySuggestionBatch(
        date: today,
        status: status,
        items: [
          ...(dailyFailed ? previousItems.where((item) => item.isDaily) : dailyItems),
          ...(knowledgeFailed ? previousItems.where((item) => item.isKnowledge) : knowledgeItems),
        ],
        generatedAt: now.toIso8601String(),
        error: dailyResult.error ?? knowledgeResult.error,
        manualRefreshCount: manualRefreshCount,
      ),
    );
    await _persist();
  }

  /// 一次纯文本补全,解析为 JSON 数组并逐条经 `normalize` 过滤。
  Future<_RequestResult> _requestItems(
    DailySuggestionBackend backend,
    String prompt,
    WorkSuggestion? Function(Object? item, int index) normalize,
  ) async {
    final preferences = _store.preferences;
    try {
      final reply = await backend.complete(
        prompt,
        providerId: preferences.providerId,
        modelId: preferences.modelId,
      );
      final parsed = extractJsonArray(reply);
      if (parsed == null) throw const FormatException('MODEL_OUTPUT_NOT_JSON');
      var index = 0;
      return _RequestResult(
        items: parsed.map((item) => normalize(item, index++)).whereType<WorkSuggestion>().toList(),
      );
    } catch (caught) {
      return _RequestResult(error: caught.toString());
    }
  }
}

class _RequestResult {
  const _RequestResult({this.items = const [], this.error});

  final List<WorkSuggestion> items;
  final String? error;
}

final dailySuggestionsProvider = NotifierProvider<DailySuggestionsNotifier, DailySuggestionState>(
  DailySuggestionsNotifier.new,
);
