import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:worldbase_mobile/core/daily_suggestions_provider.dart';

// Daily suggestions on mobile: the opt-in feature must never generate outside
// the types the user selected, must fall back to built-in tips when the model
// comes up short, must enforce the per-day manual regeneration limit, and must
// keep the built-in exploration pool available while switched off.

class FakeBackend implements DailySuggestionBackend {
  FakeBackend({this.reply, this.provider = true});

  Object? Function(int call)? reply;
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
    final result = reply?.call(prompts.length);
    if (result is Exception) throw result;
    return result as String? ?? '[]';
  }
}

String item(String type, int index) =>
    '{"type":"$type","title":"$type #$index","description":"why","prompt":"do $type $index"}';

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
    SharedPreferences.setMockInitialValues({});
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
    SharedPreferences.setMockInitialValues({
      'dailySuggestions:v1':
          '{"preferences":{"enabled":true,"types":["new-idea"],"trigger":{"kind":"time","timeOfDay":"09:00"}}}',
    });

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
}
