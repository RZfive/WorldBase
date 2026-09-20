import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:worldbase_mobile/core/daily_suggestions_provider.dart';

// Daily suggestions on mobile: the opt-in feature must never generate outside
// the types the user selected, must fall back to built-in tips when the model
// comes up short, must enforce the per-day manual regeneration limit, and must
// keep the built-in exploration pool available while switched off.

class FakeBackend implements DailySuggestionBackend {
  FakeBackend({this.reply, this.replyFor, this.provider = true});

  Object? Function(int call)? reply;

  /// 按提示词内容决定回复,优先于 [reply];用于区分题库补充请求与每日/知识请求。
  Object? Function(String prompt)? replyFor;
  bool provider;
  final prompts = <String>[];
  final contextScopes = <DailySuggestionContextScope>[];

  @override
  bool get isConnected => true;

  @override
  Future<DailySuggestionContext> collectContext(DailySuggestionContextScope scope) async {
    contextScopes.add(scope);
    return DailySuggestionContext(
      lightAppNames: scope.lightApps ? const ['打卡日历'] : const [],
      conversationTitles: scope.conversationTitles ? const ['修复登录问题'] : const [],
      documentNames: scope.documents ? const ['销售表.xlsx'] : const [],
      skillNames: const ['周报'],
      scheduleCount: 1,
      agentGroupCount: 0,
    );
  }

  @override
  Future<bool> hasProvider(String? providerId) async => provider;

  @override
  Future<String> complete(String prompt, {String? providerId, String? modelId}) async {
    prompts.add(prompt);
    final result = replyFor?.call(prompt) ?? reply?.call(prompts.length);
    if (result is Exception) throw result;
    return result as String? ?? '[]';
  }
}

String item(String type, int index) =>
    '{"type":"$type","title":"$type #$index","description":"why","prompt":"do $type $index"}';

/// 一次题库补充的模型回复:12 个学科各一条,slug 互不相同。
String seedReply({int count = knowledgeReplenishBatch, String tag = 'a'}) => jsonEncode([
  for (var i = 0; i < count; i++)
    {
      'discipline': KnowledgeDiscipline.values[i].key,
      'slug': '${KnowledgeDiscipline.values[i].key}-topic-$tag-$i',
      'title': '为什么 ${KnowledgeDiscipline.values[i].key} $tag $i？',
      'description': 'hook $i',
      'prompt': '我对「${KnowledgeDiscipline.values[i].key} $tag $i」有点好奇。',
    },
]);

bool isReplenishPrompt(String prompt) => prompt.contains('## Already in the pool');

const String storageKey = 'dailySuggestions:v1';

/// 预置持久化内容。默认把「今天已尝试、刚补充过」写进去屏蔽自动补充,
/// 这样既有测试的模型调用计数只反映每日/知识请求;要测补充逻辑时传
/// `allowReplenish: true`。
void seedStore({bool allowReplenish = false, Map<String, dynamic> extra = const {}}) {
  SharedPreferences.setMockInitialValues({
    storageKey: jsonEncode({
      if (!allowReplenish)
        'knowledgeReplenish': {'lastSuccessAt': '2026-09-19T09:00:00.000', 'lastAttemptDate': '2026-09-19'},
      ...extra,
    }),
  });
}

Future<Map<String, dynamic>> readStore() async {
  final raw = (await SharedPreferences.getInstance()).getString(storageKey);
  return raw == null ? const {} : (jsonDecode(raw) as Map).cast<String, dynamic>();
}

Future<void> settle() async {
  for (var i = 0; i < 6; i++) {
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

ProviderContainer makeContainer(FakeBackend backend, {DateTime Function()? now, bool autoDispose = true}) {
  final container = ProviderContainer(
    overrides: [
      dailySuggestionDepsProvider.overrideWith(
        (_) => DailySuggestionDeps(
          backend: backend,
          now: now ?? () => DateTime(2026, 9, 19, 10),
          prefs: SharedPreferences.getInstance,
        ),
      ),
    ],
  );
  if (autoDispose) addTearDown(container.dispose);
  container.listen(dailySuggestionsProvider, (_, _) {});
  return container;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    seedStore();
  });

  test('preferences normalize to safe defaults and never end up with zero types', () {
    final prefs = DailySuggestionPreferences.fromJson({
      'enabled': true,
      'types': ['bogus'],
      'countPerType': 7,
      'trigger': {'kind': 'time', 'timeOfDay': '25:99'},
      'context': {'documents': true},
    });
    expect(prefs.enabled, isTrue);
    expect(prefs.types, DailySuggestionPreferences.defaultTypes);
    expect(prefs.countPerType, 3);
    expect(prefs.trigger.kind, DailySuggestionTriggerKind.time);
    expect(prefs.trigger.timeOfDay, '09:00');
    expect(prefs.context.documents, isTrue);
    expect(prefs.context.lightApps, isTrue);
  });

  test('extractJsonArray tolerates prose and code fences around the array', () {
    expect(extractJsonArray('Here you go:\n```json\n[{"a":1}]\n```'), [
      {'a': 1},
    ]);
    expect(extractJsonArray('[{"a":1}] trailing'), [
      {'a': 1},
    ]);
    expect(extractJsonArray('no array here'), isNull);
  });

  test('normalizeLlmSuggestion drops types outside the allow-list', () {
    final allowed = {SuggestionType.newIdea};
    expect(
      normalizeLlmSuggestion({'type': 'automation', 'title': 't', 'prompt': 'p'}, allowed, date: 'd', index: 0),
      isNull,
    );
    final ok = normalizeLlmSuggestion(
      {'type': 'new-idea', 'title': 't', 'prompt': 'p', 'scene': {'enableThinking': true}},
      allowed,
      date: 'd',
      index: 1,
    );
    expect(ok, isNotNull);
    expect(ok!.type, 'new-idea');
    expect(ok.source, 'llm');
    expect(ok.fresh, isTrue);
    expect(ok.scene?.enableThinking, isTrue);
  });

  test('weekly theme rotates by ISO week and explore items lead with the theme', () {
    final date = DateTime(2026, 9, 19);
    expect(isoWeekNumber(date), 38);
    final theme = resolveWeeklyTheme(date);
    final explore = buildExploreSuggestions(date);
    expect(explore.theme.id, theme.id);
    expect(
      explore.items.take(theme.itemIds.length).map((item) => item.id).toList(),
      theme.itemIds.map((id) => 'static:$id').toList(),
    );
    expect(explore.items.every((item) => item.source == 'static' && item.layer == 'explore'), isTrue);
  });

  test('prompt lists only selected types and respects the context scope', () {
    const prefs = DailySuggestionPreferences(
      enabled: true,
      types: [SuggestionType.newIdea, SuggestionType.featureTip],
      countPerType: 2,
      context: DailySuggestionContextScope(documents: false),
    );
    final prompt = buildDailySuggestionPrompt(
      prefs,
      const DailySuggestionContext(lightAppNames: ['打卡日历'], conversationTitles: ['修复登录问题']),
      dismissStreaks: {SuggestionType.newIdea: 3},
    );
    expect(prompt, contains('"new-idea"'));
    expect(prompt, contains('"feature-tip"'));
    expect(prompt, isNot(contains('"automation":')));
    expect(prompt, contains('exactly 2 items'));
    expect(prompt, contains('打卡日历'));
    expect(prompt, contains('修复登录问题'));
    expect(prompt, contains('recently dismissed several items of this type'));
    expect(prompt, contains('Imported documents: none listed.'));
  });

  test('assembleDailyBatch caps per type and tops up with built-in fallbacks', () {
    const prefs = DailySuggestionPreferences(
      enabled: true,
      types: [SuggestionType.newIdea, SuggestionType.featureTip],
      countPerType: 2,
    );
    final llm = [
      for (var i = 1; i <= 3; i++)
        normalizeLlmSuggestion(
          {'type': 'new-idea', 'title': 'idea $i', 'prompt': 'p$i'},
          prefs.types.toSet(),
          date: 'd',
          index: i,
        )!,
      normalizeLlmSuggestion(
        {'type': 'feature-tip', 'title': 'tip', 'prompt': 'p'},
        prefs.types.toSet(),
        date: 'd',
        index: 9,
      )!,
    ];
    final assembled = assembleDailyBatch(llm, prefs);
    expect(assembled.status, 'partial');
    expect(assembled.items.where((item) => item.type == 'new-idea').length, 2);
    expect(assembled.items.where((item) => item.type == 'new-idea').every((item) => item.source == 'llm'), isTrue);
    final tips = assembled.items.where((item) => item.type == 'feature-tip').toList();
    expect(tips.map((item) => item.source).toList(), ['llm', 'static']);
    expect(assembleDailyBatch(const [], prefs).status, 'failed');
  });

  test('disabled feature shows only the explore pool and never calls the model', () async {
    final backend = FakeBackend(reply: (_) => '[]');
    final container = makeContainer(backend);
    await settle();
    final state = container.read(dailySuggestionsProvider);
    expect(state.loaded, isTrue);
    expect(state.preferences.enabled, isFalse);
    expect(state.daily, isEmpty);
    expect(state.explore, isNotEmpty);
    expect(backend.prompts, isEmpty);
    await expectLater(
      container.read(dailySuggestionsProvider.notifier).generateNow(),
      throwsA(isA<StateError>().having((e) => e.message, 'message', 'DAILY_SUGGESTIONS_DISABLED')),
    );
  });

  test('enabling generates today, constrained to the selected types', () async {
    final backend = FakeBackend(
      reply: (_) => '[${item('new-idea', 1)},${item('new-idea', 2)},${item('automation', 1)}]',
    );
    final container = makeContainer(backend);
    await settle();
    await container.read(dailySuggestionsProvider.notifier).setPreferences(
      const DailySuggestionPreferences(
        enabled: true,
        types: [SuggestionType.newIdea],
        countPerType: 2,
        context: DailySuggestionContextScope(conversationTitles: false),
      ),
    );
    await settle();
    final state = container.read(dailySuggestionsProvider);
    expect(backend.prompts, hasLength(1));
    expect(backend.contextScopes.single.conversationTitles, isFalse);
    expect(state.daily.map((item) => item.type).toSet(), {'new-idea'});
    expect(state.daily, hasLength(2));
    expect(state.daily.every((item) => item.source == 'llm'), isTrue);
    expect(state.hasFreshDaily, isTrue);
    expect(state.lastGeneration?.status, 'ok');
    expect(state.lastGeneration?.manualRefreshCount, 0);

    // The persisted snapshot survives a fresh container.
    final reloaded = makeContainer(FakeBackend(reply: (_) => '[]'));
    await settle();
    expect(reloaded.read(dailySuggestionsProvider).daily, hasLength(2));
    expect(reloaded.read(dailySuggestionsProvider).preferences.enabled, isTrue);
  });

  test('manual regeneration is limited per day and the first run does not count', () async {
    final backend = FakeBackend(reply: (_) => '[${item('new-idea', 1)}]');
    final container = makeContainer(backend);
    await settle();
    final notifier = container.read(dailySuggestionsProvider.notifier);
    await notifier.setPreferences(
      const DailySuggestionPreferences(enabled: true, types: [SuggestionType.newIdea], countPerType: 2),
    );
    await settle();
    expect(container.read(dailySuggestionsProvider).lastGeneration?.manualRefreshCount, 0);
    for (var i = 0; i < dailySuggestionManualRefreshLimit; i++) {
      await notifier.generateNow();
    }
    expect(
      container.read(dailySuggestionsProvider).lastGeneration?.manualRefreshCount,
      dailySuggestionManualRefreshLimit,
    );
    expect(container.read(dailySuggestionsProvider).lastGeneration?.manualRefreshRemaining, 0);
    await expectLater(
      notifier.generateNow(),
      throwsA(isA<StateError>().having((e) => e.message, 'message', 'DAILY_SUGGESTIONS_REFRESH_LIMIT')),
    );
  });

  test('a failed generation keeps the previous good batch visible and reports the failure', () async {
    var clock = DateTime(2026, 9, 19, 10);
    final backend = FakeBackend(
      reply: (call) => call == 1 ? '[${item('new-idea', 1)},${item('new-idea', 2)}]' : Exception('boom'),
    );
    final container = makeContainer(backend, now: () => clock);
    await settle();
    final notifier = container.read(dailySuggestionsProvider.notifier);
    await notifier.setPreferences(
      const DailySuggestionPreferences(enabled: true, types: [SuggestionType.newIdea], countPerType: 2),
    );
    await settle();
    expect(container.read(dailySuggestionsProvider).lastGeneration?.status, 'ok');

    clock = DateTime(2026, 9, 20, 10);
    await notifier.generateNow();
    final state = container.read(dailySuggestionsProvider);
    expect(state.lastGeneration?.status, 'failed');
    expect(state.lastGeneration?.error, contains('boom'));
    expect(state.daily, hasLength(2), reason: "yesterday's items stay while today failed");
  });

  test('missing provider marks the batch failed without calling the model', () async {
    final backend = FakeBackend(reply: (_) => '[]', provider: false);
    final container = makeContainer(backend);
    await settle();
    await container.read(dailySuggestionsProvider.notifier).setPreferences(
      const DailySuggestionPreferences(enabled: true),
    );
    await settle();
    final state = container.read(dailySuggestionsProvider);
    expect(backend.prompts, isEmpty);
    expect(state.providerMissing, isTrue);
    expect(state.lastGeneration?.status, 'failed');
    expect(state.lastGeneration?.error, 'PROVIDER_MISSING');
  });

  test('dismiss hides items, streaks feed the prompt, pick resets the streak and the badge', () async {
    final backend = FakeBackend(
      reply: (_) => '[${item('new-idea', 1)},${item('new-idea', 2)},${item('new-idea', 3)}]',
    );
    final container = makeContainer(backend);
    await settle();
    final notifier = container.read(dailySuggestionsProvider.notifier);
    await notifier.setPreferences(
      const DailySuggestionPreferences(enabled: true, types: [SuggestionType.newIdea], countPerType: 3),
    );
    await settle();
    final items = container.read(dailySuggestionsProvider).daily;
    expect(items, hasLength(3));
    for (final suggestion in items) {
      await notifier.dismiss(suggestion);
    }
    expect(container.read(dailySuggestionsProvider).daily, isEmpty);

    await notifier.generateNow();
    expect(backend.prompts.last, contains('recently dismissed several items of this type'));
    final fresh = container.read(dailySuggestionsProvider).daily.first;
    expect(fresh.fresh, isTrue);
    await notifier.recordPick(fresh);
    expect(container.read(dailySuggestionsProvider).daily.first.fresh, isFalse);

    await notifier.generateNow();
    expect(backend.prompts.last, isNot(contains('recently dismissed several items of this type')));

    final explore = container.read(dailySuggestionsProvider).explore.first;
    await notifier.dismiss(explore);
    expect(container.read(dailySuggestionsProvider).explore.any((item) => item.id == explore.id), isFalse);
  });

  test('a time trigger only catches up once its slot has passed', () async {
    // Persist time-trigger preferences directly so no enable-time force run happens.
    seedStore(
      extra: {
        'preferences': {
          'enabled': true,
          'types': ['new-idea'],
          'trigger': {'kind': 'time', 'timeOfDay': '09:00'},
        },
      },
    );

    final beforeSlot = FakeBackend(reply: (_) => '[${item('new-idea', 1)}]');
    final beforeContainer = makeContainer(beforeSlot, now: () => DateTime(2026, 9, 19, 8), autoDispose: false);
    await settle();
    expect(beforeSlot.prompts, isEmpty, reason: '09:00 has not passed yet');
    beforeContainer.dispose();

    final afterSlot = FakeBackend(reply: (_) => '[${item('new-idea', 1)}]');
    makeContainer(afterSlot, now: () => DateTime(2026, 9, 19, 10));
    await settle();
    expect(afterSlot.prompts, hasLength(1), reason: 'past 09:00 with no batch today');
  });

  // ── Knowledge exploration ────────────────────────────────────────────────

  test('knowledge preferences default to the random source and clamp interests / profession', () {
    final defaults = DailySuggestionPreferences.fromJson({}).knowledge;
    expect(defaults.enabled, isTrue);
    expect(defaults.sources, [KnowledgeSource.random]);
    expect(defaults.interests, isEmpty);
    expect(defaults.profession, '');
    expect(defaults.countPerSource, 1);

    final prefs = DailySuggestionPreferences.fromJson({
      'knowledge': {
        'enabled': true,
        'sources': ['bogus', 'interest', 'cross-discipline'],
        'interests': [' Astronomy ', 'astronomy', '', 'x' * 50, for (var i = 0; i < 20; i++) 'topic $i'],
        'profession': 'p' * 100,
        'countPerSource': 7,
      },
    }).knowledge;
    expect(prefs.sources, [KnowledgeSource.crossDiscipline, KnowledgeSource.interest]);
    expect(prefs.interests, hasLength(knowledgeMaxInterests));
    expect(prefs.interests.first, 'Astronomy');
    expect(prefs.interests[1].length, knowledgeInterestMaxLength);
    expect(prefs.profession.length, knowledgeProfessionMaxLength);
    expect(prefs.countPerSource, 1);
    expect(prefs.needsModel, isTrue);

    final empty = DailySuggestionPreferences.fromJson({
      'knowledge': {'sources': []},
    }).knowledge;
    expect(empty.sources, [KnowledgeSource.random], reason: 'an empty source list falls back to random');
    expect(empty.needsModel, isFalse);
  });

  test('every knowledge seed has a unique id, complete copy, and a discussion-template prompt', () {
    final ids = <String>{};
    for (final seed in knowledgeSeeds) {
      expect(ids.add(seed.id), isTrue, reason: 'duplicate seed id ${seed.id}');
      expect(seed.title, isNotEmpty);
      expect(seed.description, isNotEmpty);
      expect(seed.prompt, contains(seed.topic));
      expect(seed.prompt, contains('三个可以继续追问的方向'));
    }
    expect(knowledgeSeeds.length, greaterThanOrEqualTo(36));
    expect(knowledgeSeeds.map((seed) => seed.discipline).toSet(), hasLength(KnowledgeDiscipline.values.length));
  });

  test('the seed draw is stable per day, avoids the 30-day history, and relaxes when the pool runs dry', () {
    expect(hashString('a'), hashString('a'));
    expect(hashString('2026-09-19|x|0'), isNot(hashString('2026-09-20|x|0')));

    final first = drawKnowledgeSeed('2026-09-19', 'salt', const []);
    expect(drawKnowledgeSeed('2026-09-19', 'salt', const []).id, first.id, reason: 'same inputs, same seed');

    final recent = [KnowledgeSeedHistoryEntry(seedId: first.id, date: '2026-09-10')];
    expect(drawKnowledgeSeed('2026-09-19', 'salt', recent).id, isNot(first.id), reason: 'shown 9 days ago');

    final old = [KnowledgeSeedHistoryEntry(seedId: first.id, date: '2026-08-01')];
    expect(drawKnowledgeSeed('2026-09-19', 'salt', old).id, first.id, reason: 'shown 49 days ago');

    final allButOne = [
      for (final seed in knowledgeSeeds.skip(1)) KnowledgeSeedHistoryEntry(seedId: seed.id, date: '2026-09-15'),
    ];
    expect(drawKnowledgeSeed('2026-09-19', 'salt', allButOne).id, knowledgeSeeds.first.id);

    final mixed = [
      for (var i = 0; i < knowledgeSeeds.length; i++)
        KnowledgeSeedHistoryEntry(seedId: knowledgeSeeds[i].id, date: i < 3 ? '2026-08-25' : '2026-09-15'),
    ];
    final relaxed = drawKnowledgeSeed('2026-09-19', 'salt', mixed);
    expect(knowledgeSeeds.take(3).map((seed) => seed.id), contains(relaxed.id), reason: 'relaxed 14-day window');

    final all = [for (final seed in knowledgeSeeds) KnowledgeSeedHistoryEntry(seedId: seed.id, date: '2026-09-18')];
    expect(drawKnowledgeSeed('2026-09-19', 'salt', all).id, isNotEmpty);
  });

  test('normalizeKnowledgeSuggestion enforces the source allow-list, needs interests for interest, ignores scenes', () {
    const base = {
      'title': 'Why is the sky blue?',
      'description': 'hook',
      'prompt': 'tell me',
      'discipline': 'physics',
      'scene': {'enableThinking': true},
    };
    const prefs = KnowledgePreferences(
      sources: [KnowledgeSource.random, KnowledgeSource.crossDiscipline, KnowledgeSource.interest],
    );
    WorkSuggestion? normalize(Map<String, Object> patch, [KnowledgePreferences p = prefs]) =>
        normalizeKnowledgeSuggestion({...base, ...patch}, p, date: 'd', index: 0);

    expect(normalize({'source': 'work-domain'}), isNull, reason: 'not selected');
    expect(normalize({'source': 'random'}), isNull, reason: 'random is never model-generated');
    expect(normalize({'source': 'interest'}), isNull, reason: 'no interests declared');
    expect(normalize({'source': 'cross-discipline', 'title': ''}), isNull);

    final ok = normalize({'source': 'cross-discipline'});
    expect(ok, isNotNull);
    expect(ok!.layer, 'knowledge');
    expect(ok.type, 'knowledge');
    expect(ok.source, 'llm');
    expect(ok.isKnowledge, isTrue);
    expect(ok.knowledge?.source, KnowledgeSource.crossDiscipline);
    expect(ok.knowledge?.discipline, 'physics');
    expect(ok.scene, isNull, reason: 'knowledge cards never carry a scene');
    expect(ok.fresh, isTrue);

    final withInterests = normalize({'source': 'interest'}, prefs.copyWith(interests: ['astronomy']));
    expect(withInterests?.knowledge?.source, KnowledgeSource.interest);

    // Round-trips through JSON, keeping the knowledge meta; knowledge cards without meta are rejected.
    final restored = WorkSuggestion.fromJson(ok.toJson());
    expect(restored?.knowledge?.source, KnowledgeSource.crossDiscipline);
    expect(WorkSuggestion.fromJson({...ok.toJson(), 'knowledge': null}), isNull);
  });

  test('with no provider the random knowledge card still shows and never calls the model', () async {
    final backend = FakeBackend(reply: (_) => '[]', provider: false);
    final container = makeContainer(backend);
    await settle();
    final state = container.read(dailySuggestionsProvider);
    expect(backend.prompts, isEmpty);
    expect(state.knowledge, hasLength(1));
    final card = state.knowledge.single;
    expect(card.isRandomKnowledge, isTrue);
    expect(card.source, 'static');
    expect(card.id, startsWith('knowledge:2026-09-19:'));
    expect(card.knowledge?.disciplineLabel, isNotEmpty);
    expect(state.knowledgeShuffleRemaining, knowledgeShuffleLimit);
    expect(state.providerMissing, isFalse, reason: 'the random card alone does not need a provider');
    expect(state.randomKnowledge?.id, card.id);

    // Same day, fresh container → same card (the seed is pinned and persisted).
    final reloaded = makeContainer(FakeBackend(reply: (_) => '[]', provider: false));
    await settle();
    expect(reloaded.read(dailySuggestionsProvider).knowledge.single.id, card.id);
  });

  test('shuffling swaps the random seed, is limited per day, and resets the next day', () async {
    var clock = DateTime(2026, 9, 19, 10);
    final backend = FakeBackend(reply: (_) => '[]');
    final container = makeContainer(backend, now: () => clock);
    await settle();
    final notifier = container.read(dailySuggestionsProvider.notifier);
    final first = container.read(dailySuggestionsProvider).randomKnowledge!.knowledge!.seedId!;
    final seen = {first};
    for (var i = 0; i < knowledgeShuffleLimit; i++) {
      await notifier.shuffleKnowledge();
      final next = container.read(dailySuggestionsProvider).randomKnowledge!.knowledge!.seedId!;
      expect(seen.add(next), isTrue, reason: 'each shuffle yields a seed not shown today');
    }
    expect(container.read(dailySuggestionsProvider).knowledgeShuffleRemaining, 0);
    await expectLater(
      notifier.shuffleKnowledge(),
      throwsA(isA<StateError>().having((e) => e.message, 'message', 'KNOWLEDGE_SHUFFLE_LIMIT')),
    );

    clock = DateTime(2026, 9, 20, 10);
    await notifier.setPreferences(container.read(dailySuggestionsProvider).preferences);
    final tomorrow = container.read(dailySuggestionsProvider);
    expect(tomorrow.knowledgeShuffleRemaining, knowledgeShuffleLimit);
    expect(seen.contains(tomorrow.randomKnowledge!.knowledge!.seedId), isFalse, reason: 'avoids everything shown today');

    // Dismissing today's random card hides it for the day; no replacement is pushed.
    await notifier.dismiss(tomorrow.randomKnowledge!);
    expect(container.read(dailySuggestionsProvider).knowledge, isEmpty);
    await expectLater(
      notifier.shuffleKnowledge(),
      completes,
      reason: 'shuffle still works on a dismissed day and brings a new card',
    );
    expect(container.read(dailySuggestionsProvider).knowledge, hasLength(1));

    // Turning the random source off removes the card without touching the model.
    await notifier.setKnowledgePreferences(const KnowledgePreferences(enabled: false));
    expect(container.read(dailySuggestionsProvider).knowledge, isEmpty);
    expect(backend.prompts, isEmpty);
  });

  test('LLM knowledge sources run as a separate request, respect countPerSource, and survive the daily group failing',
      () async {
    const knowledgeReply =
        '[{"source":"cross-discipline","discipline":"biology","title":"Why hexagons?","description":"d","prompt":"p1"},'
        '{"source":"cross-discipline","discipline":"history","title":"Extra","description":"d","prompt":"p2"},'
        '{"source":"interest","discipline":"astronomy","title":"Why is Venus hot?","description":"d","prompt":"p3"},'
        '{"source":"work-domain","discipline":"x","title":"not selected","description":"d","prompt":"p4"}]';
    final backend = FakeBackend(
      reply: (call) => call == 1 ? Exception('daily boom') : knowledgeReply,
    );
    final container = makeContainer(backend);
    await settle();
    await container.read(dailySuggestionsProvider.notifier).setPreferences(
      const DailySuggestionPreferences(
        enabled: true,
        types: [SuggestionType.newIdea],
        countPerType: 2,
        knowledge: KnowledgePreferences(
          sources: [KnowledgeSource.random, KnowledgeSource.crossDiscipline, KnowledgeSource.interest],
          interests: ['astronomy'],
          profession: 'indie developer',
        ),
      ),
    );
    await settle();
    final state = container.read(dailySuggestionsProvider);
    expect(backend.prompts, hasLength(2), reason: 'daily and knowledge are separate completions');
    final knowledgePrompt = backend.prompts[1];
    expect(knowledgePrompt, contains('curiosity hooks'));
    expect(knowledgePrompt, contains('indie developer'));
    expect(knowledgePrompt, contains('astronomy'));
    expect(knowledgePrompt, contains('"cross-discipline"'));
    expect(knowledgePrompt, isNot(contains('"work-domain":')));
    expect(knowledgePrompt, contains('Already shown today from the built-in pool'));

    expect(state.lastGeneration?.status, 'partial', reason: 'daily failed, knowledge succeeded');
    expect(state.lastGeneration?.error, contains('daily boom'));
    expect(state.knowledge.first.isRandomKnowledge, isTrue, reason: 'random card leads');
    final llm = state.knowledge.where((item) => item.source == 'llm').toList();
    expect(llm.map((item) => item.knowledge!.source).toSet(), {KnowledgeSource.crossDiscipline, KnowledgeSource.interest});
    expect(llm.every((item) => item.fresh && item.isKnowledge), isTrue);
    expect(state.hasFreshDaily, isTrue);
    expect(state.daily, isEmpty, reason: 'a fully failed daily request keeps the previous daily items (none on day one)');

    // Dismissing a knowledge card counts toward that source's streak; picking one clears it.
    final notifier = container.read(dailySuggestionsProvider.notifier);
    final cross = llm.firstWhere((item) => item.knowledge!.source == KnowledgeSource.crossDiscipline);
    await notifier.dismiss(cross);
    expect(container.read(dailySuggestionsProvider).knowledge.any((item) => item.id == cross.id), isFalse);
    await notifier.dismiss(cross);
    await notifier.generateNow();
    expect(backend.prompts.last, isNot(contains('recently dismissed several items from this source')));
  });

  test('knowledge-only model sources generate without the daily group and gate generateNow', () async {
    const knowledgeReply =
        '[{"source":"work-domain","discipline":"databases","title":"Why B-trees?","description":"d","prompt":"p"}]';
    final backend = FakeBackend(reply: (_) => knowledgeReply);
    final container = makeContainer(backend);
    await settle();
    final notifier = container.read(dailySuggestionsProvider.notifier);
    await expectLater(
      notifier.generateNow(),
      throwsA(isA<StateError>().having((e) => e.message, 'message', 'DAILY_SUGGESTIONS_DISABLED')),
    );
    await notifier.setKnowledgePreferences(
      const KnowledgePreferences(sources: [KnowledgeSource.random, KnowledgeSource.workDomain]),
    );
    await settle();
    final state = container.read(dailySuggestionsProvider);
    expect(backend.prompts, hasLength(1), reason: 'only the knowledge request runs while daily is off');
    expect(backend.prompts.single, contains('"work-domain"'));
    expect(state.preferences.enabled, isFalse);
    expect(state.daily, isEmpty);
    expect(state.knowledge.map((item) => item.knowledge!.source).toList(), [
      KnowledgeSource.random,
      KnowledgeSource.workDomain,
    ]);
    expect(state.lastGeneration?.status, 'ok');
  });

  // ── 随机题库动态补充 ──────────────────────────────────────────────────
  // 内置题冷启动;配置模型后由模型补充。生成题要和内置题一样参与抽签,
  // 与所有已知题目去重,每天最多尝试一次。

  test('normalizeGeneratedSeed derives a stable id from the slug and rejects collisions and bad disciplines', () {
    final now = DateTime(2026, 9, 19, 10);
    final ids = {for (final seed in knowledgeSeeds) seed.id};
    final titles = <String>{};
    const base = {
      'discipline': 'physics',
      'slug': 'Physics Mpemba Effect!',
      'title': '热水为什么比冷水先结冰？',
      'description': 'd',
      'prompt': '我对「姆潘巴效应」有点好奇。',
    };
    KnowledgeSeed? normalize(Map<String, Object> patch) => normalizeGeneratedSeed({...base, ...patch}, now, ids, titles);

    final ok = normalize({});
    expect(ok, isNotNull);
    expect(ok!.id, 'gen-physics-mpemba-effect');
    expect(ok.discipline, KnowledgeDiscipline.physics);
    expect(ok.isGenerated, isTrue);
    expect(ok.title, base['title']);
    expect(ok.prompt, base['prompt']);
    expect(ok.createdAt, now.toIso8601String());
    expect(ids, contains('gen-physics-mpemba-effect'), reason: 'accepted ids extend the set');

    expect(normalize({}), isNull, reason: 'same slug again');
    expect(normalize({'slug': 'bio-thermal-inversion', 'title': '热水为什么比冷水先结冰?'}), isNull, reason: 'same title modulo punctuation');
    expect(normalize({'slug': 'math-birthday-paradox'}), isNull, reason: 'collides with a built-in id');
    expect(normalize({'slug': 'econ-x', 'discipline': 'astrology'}), isNull, reason: 'unknown discipline');
    expect(normalize({'slug': 'ab'}), isNull, reason: 'slug too short');
    expect(normalize({'slug': 'econ-no-prompt', 'title': 'x', 'prompt': ''}), isNull, reason: 'prompt required');

    // 持久化往返:生成题带字面 prompt,内置题不参与。
    final round = KnowledgeSeed.generatedFromJson(ok.toJson());
    expect(round?.id, ok.id);
    expect(round?.prompt, ok.prompt);
    expect(KnowledgeSeed.generatedFromJson({'id': 'no-prefix', 'discipline': 'physics', 'title': 't', 'prompt': 'p'}), isNull);
    expect(KnowledgeSeed.generatedFromJson({'id': 'gen-colon:id', 'discipline': 'physics', 'title': 't', 'prompt': 'p'}), isNull);
    expect(KnowledgeSeed.generatedFromJson({'id': 'gen-ok', 'discipline': 'astrology', 'title': 't', 'prompt': 'p'}), isNull);
    expect(KnowledgeSeed.generatedFromJson({'id': 'gen-ok', 'discipline': 'physics', 'title': 't', 'prompt': 'p'})?.description, '');
  });

  test('the draw covers generated seeds and a generated card carries literal text', () {
    const generated = KnowledgeSeed.generated(
      id: 'gen-physics-a',
      discipline: KnowledgeDiscipline.physics,
      title: '生成题',
      description: 'd',
      prompt: 'p',
      createdAt: '2026-09-01T00:00:00.000',
    );
    final pool = buildKnowledgePool(const [generated]);
    expect(pool, hasLength(knowledgeSeeds.length + 1));
    expect(findKnowledgeSeed('gen-physics-a', const [generated])?.id, 'gen-physics-a');
    expect(findKnowledgeSeed(knowledgeSeeds.first.id, const [generated])?.isGenerated, isFalse);

    // 内置题全部近期出现过 → 只剩生成题可抽。
    final history = [for (final seed in knowledgeSeeds) KnowledgeSeedHistoryEntry(seedId: seed.id, date: '2026-09-15')];
    expect(countUnseenSeeds(pool, '2026-09-19', history), 1);
    final drawn = drawKnowledgeSeed('2026-09-19', 'salt', history, pool: pool);
    expect(drawn.id, 'gen-physics-a');

    final card = buildKnowledgeSeedSuggestion(drawn, '2026-09-19');
    expect(card.source, 'llm');
    expect(card.isRandomKnowledge, isTrue);
    expect(card.title, '生成题');
    expect(card.knowledge?.disciplineLabel, '物理');
    expect(card.id, 'knowledge:2026-09-19:gen-physics-a');
  });

  test('automatic top-up runs once a provider exists, dedupes against the pool, and is gated to once a day', () async {
    seedStore(allowReplenish: true);
    final backend = FakeBackend(replyFor: (prompt) => isReplenishPrompt(prompt) ? seedReply() : '[]');
    final container = makeContainer(backend);
    await settle();
    expect(backend.prompts, hasLength(1), reason: 'the only model call at load is the pool top-up');
    expect(backend.prompts.single, contains('- math-birthday-paradox'));
    expect(backend.prompts.single, contains('Simplified Chinese'));

    final state = container.read(dailySuggestionsProvider);
    expect(state.knowledgePool.builtin, knowledgeSeeds.length);
    expect(state.knowledgePool.generated, knowledgeReplenishBatch);
    expect(state.knowledgePool.unseen, knowledgeSeeds.length + knowledgeReplenishBatch - 1, reason: 'only today\'s pinned seed is seen');
    expect(state.knowledgePool.lastReplenishAt, isNotNull);
    expect(state.knowledgePool.lastReplenishError, isNull);
    expect(state.knowledgePool.replenishing, isFalse);

    // 同一天:手动生成也不会再触发补充。
    final notifier = container.read(dailySuggestionsProvider.notifier);
    await notifier.setPreferences(state.preferences.copyWith(enabled: true, types: [SuggestionType.newIdea]));
    await settle();
    expect(backend.prompts.where(isReplenishPrompt), hasLength(1), reason: 'once a day');

    // 手动补充:同样的回复全部去重后报错并记录 lastError;题库不变。
    await expectLater(
      notifier.replenishKnowledgePoolNow(),
      throwsA(isA<FormatException>().having((e) => e.message, 'message', 'MODEL_OUTPUT_EMPTY')),
    );
    final second = backend.prompts.where(isReplenishPrompt).last;
    expect(second, contains('- gen-math-topic-a-0: 为什么 math a 0？'), reason: 'generated seeds are listed with their title');
    final after = container.read(dailySuggestionsProvider);
    expect(after.knowledgePool.generated, knowledgeReplenishBatch);
    expect(after.knowledgePool.lastReplenishError, contains('MODEL_OUTPUT_EMPTY'));

    // 生成题持久化:重开后还在。
    final reloaded = makeContainer(FakeBackend());
    await settle();
    expect(reloaded.read(dailySuggestionsProvider).knowledgePool.generated, knowledgeReplenishBatch);
  });

  test('top-up stays quiet without a provider or with the random source off, and skips when fresh and full', () async {
    seedStore(allowReplenish: true);
    final noProvider = FakeBackend(replyFor: (_) => seedReply(), provider: false);
    final noProviderContainer = makeContainer(noProvider);
    await settle();
    expect(noProvider.prompts, isEmpty, reason: 'no provider → built-in pool alone');
    expect(noProviderContainer.read(dailySuggestionsProvider).knowledgePool.generated, 0);
    await expectLater(
      noProviderContainer.read(dailySuggestionsProvider.notifier).replenishKnowledgePoolNow(),
      throwsA(isA<StateError>().having((e) => e.message, 'message', 'PROVIDER_MISSING')),
    );

    seedStore(
      allowReplenish: true,
      extra: {
        'preferences': const DailySuggestionPreferences(
          knowledge: KnowledgePreferences(sources: [KnowledgeSource.workDomain]),
        ).toJson(),
      },
    );
    final randomOff = FakeBackend(replyFor: (prompt) => isReplenishPrompt(prompt) ? seedReply() : '[]');
    final randomOffContainer = makeContainer(randomOff);
    await settle();
    expect(randomOff.prompts.where(isReplenishPrompt), isEmpty, reason: 'random source off → no top-up');
    final randomOffNotifier = randomOffContainer.read(dailySuggestionsProvider.notifier);
    await expectLater(
      randomOffNotifier.replenishKnowledgePoolNow(),
      throwsA(isA<StateError>().having((e) => e.message, 'message', 'KNOWLEDGE_RANDOM_DISABLED')),
    );
    // 之后勾上随机来源 → 立即补充。
    await randomOffNotifier.setKnowledgePreferences(
      const KnowledgePreferences(sources: [KnowledgeSource.random, KnowledgeSource.workDomain]),
    );
    await settle();
    expect(randomOff.prompts.where(isReplenishPrompt), hasLength(1));

    // 两天前补过且未出现的题充足 → 跳过。
    seedStore(allowReplenish: true, extra: {'knowledgeReplenish': {'lastSuccessAt': '2026-09-17T09:00:00.000'}});
    final fresh = FakeBackend(replyFor: (_) => seedReply());
    makeContainer(fresh);
    await settle();
    expect(fresh.prompts, isEmpty);

    // 超过一周 → 即使题库不少也再补。
    seedStore(allowReplenish: true, extra: {'knowledgeReplenish': {'lastSuccessAt': '2026-09-10T09:00:00.000'}});
    final stale = FakeBackend(replyFor: (_) => seedReply());
    makeContainer(stale);
    await settle();
    expect(stale.prompts, hasLength(1), reason: 'weekly refresh');
  });

  test('a generated seed can be today\'s card, survives eviction, and malformed stored seeds are dropped', () async {
    const pinnedId = 'gen-pinned-topic';
    Map<String, dynamic> generated(String id, {String createdAt = '2026-09-02T00:00:00.000'}) => {
      'id': id,
      'discipline': 'math',
      'title': '题目 $id',
      'description': 'd',
      'prompt': 'p',
      'createdAt': createdAt,
    };
    seedStore(
      allowReplenish: true,
      extra: {
        'knowledgeToday': {'date': '2026-09-19', 'seedId': pinnedId, 'shuffleCount': 0},
        'knowledgeGeneratedSeeds': [
          generated(pinnedId, createdAt: '2026-09-01T00:00:00.000'),
          for (var i = 0; i < maxGeneratedSeeds - 1; i++) generated('gen-filler-$i'),
          // 畸形条目:无前缀、学科非法、缺 prompt、id 含冒号。
          {'id': 'no-prefix', 'discipline': 'math', 'title': 't', 'prompt': 'p'},
          {'id': 'gen-bad-discipline', 'discipline': 'astrology', 'title': 't', 'prompt': 'p'},
          {'id': 'gen-no-prompt', 'discipline': 'math', 'title': 't'},
          {'id': 'gen-colon:id', 'discipline': 'math', 'title': 't', 'prompt': 'p'},
        ],
      },
    );
    final backend = FakeBackend(replyFor: (prompt) => isReplenishPrompt(prompt) ? seedReply() : '[]');
    final container = makeContainer(backend);
    await settle();
    final state = container.read(dailySuggestionsProvider);
    final card = state.randomKnowledge!;
    expect(card.knowledge?.seedId, pinnedId, reason: 'the pinned generated seed is today\'s card');
    expect(card.source, 'llm');
    expect(card.title, '题目 $pinnedId');
    expect(card.knowledge?.disciplineLabel, '数学');

    // 补充 12 条后超出上限:淘汰最旧的,但钉住的题保留。
    expect(state.knowledgePool.generated, maxGeneratedSeeds);
    final stored = (await readStore())['knowledgeGeneratedSeeds'] as List;
    final ids = stored.map((seed) => (seed as Map)['id']).toList();
    expect(ids, hasLength(maxGeneratedSeeds));
    expect(ids, contains(pinnedId));
    expect(ids, isNot(contains('gen-filler-0')), reason: 'oldest unpinned seeds go first');
    expect(ids, contains('gen-math-topic-a-0'));
    expect(ids.where((id) => (id as String).startsWith('gen-filler-')), hasLength(maxGeneratedSeeds - 1 - knowledgeReplenishBatch));
    expect(ids, isNot(contains('no-prefix')));
    expect(ids, isNot(contains('gen-bad-discipline')));
    expect(ids, isNot(contains('gen-no-prompt')));
    expect(ids, isNot(contains('gen-colon:id')));

    // dismiss / pick 通过生成池解析这张卡。
    final notifier = container.read(dailySuggestionsProvider.notifier);
    await notifier.recordPick(card);
    await notifier.dismiss(card);
    expect(container.read(dailySuggestionsProvider).knowledge, isEmpty);
  });
}
