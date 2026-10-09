import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:worldbase_mobile/core/daily_suggestions_provider.dart';
import 'package:worldbase_mobile/core/ios_ui.dart';
import 'package:worldbase_mobile/features/chat/suggestion_hand.dart';

// The empty-state hand is one overlapping deck: only the active card is fully
// shown and lifted, neighbours peek out as card edges, a horizontal swipe cuts
// to the next card, and the random-knowledge card carries its own shuffle tool.

class _NoModelBackend implements DailySuggestionBackend {
  @override
  bool get isConnected => false;

  @override
  Future<DailySuggestionContext> collectContext(DailySuggestionContextScope scope) async =>
      const DailySuggestionContext();

  @override
  Future<bool> hasProvider(String? providerId) async => false;

  @override
  Future<String> complete(String prompt, {String? providerId, String? modelId}) async => '[]';
}

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

/// Pump real frames so tickers advance (a single long pump only starts a ticker).
Future<void> pumpFrames(WidgetTester tester, int milliseconds) async {
  for (var elapsed = 0; elapsed < milliseconds; elapsed += 16) {
    await tester.pump(const Duration(milliseconds: 16));
  }
}

/// Centre of a card, transforms included; cards are keyed by suggestion id.
Offset cardCenter(WidgetTester tester, WorkSuggestion item) => tester.getCenter(find.byKey(ValueKey(item.id)));

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  Future<void> pumpHand(WidgetTester tester, {required List<WorkSuggestion> picked}) async {
    await tester.binding.setSurfaceSize(const Size(390, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dailySuggestionDepsProvider.overrideWith(
            (_) => DailySuggestionDeps(
              backend: _NoModelBackend(),
              now: () => DateTime(2026, 9, 19, 10),
              prefs: SharedPreferences.getInstance,
            ),
          ),
        ],
        child: MaterialApp(
          theme: buildIosTheme(),
          home: Scaffold(
            body: Center(
              child: SuggestionHand(onPick: picked.add, onOpenSettings: () {}),
            ),
          ),
        ),
      ),
    );
    await settle(tester);
    // Let the deal-in animation finish so positions are final.
    await pumpFrames(tester, 760);
  }

  testWidgets('deck shows one lifted card with neighbours peeking, and a swipe cuts to the next', (tester) async {
    final picked = <WorkSuggestion>[];
    await pumpHand(tester, picked: picked);

    final container = ProviderScope.containerOf(tester.element(find.byType(SuggestionHand)));
    final state = container.read(dailySuggestionsProvider);
    expect(state.knowledge, hasLength(1), reason: 'random knowledge needs no model');
    final random = state.knowledge.single;
    final firstExplore = state.explore.first;
    final secondExplore = state.explore[1];

    // The random knowledge card leads the deck and is the active (lifted) card.
    expect(find.text(random.title), findsOneWidget);
    expect(find.byIcon(CupertinoIcons.arrow_2_circlepath), findsOneWidget, reason: 'shuffle tool on the active card');
    expect(find.byIcon(CupertinoIcons.xmark), findsOneWidget, reason: 'dismiss only on the active card');
    expect(find.text('今天还能换 $knowledgeShuffleLimit 次'), findsOneWidget);
    expect(find.text('知识探索'), findsOneWidget);
    expect(find.text('今日:${random.knowledge!.disciplineLabel}'), findsOneWidget);

    // Neighbours overlap: the next card's centre is only a card-edge to the right.
    final activeCenter = cardCenter(tester, random);
    final nextCenter = cardCenter(tester, firstExplore);
    expect(nextCenter.dx - activeCenter.dx, inInclusiveRange(10, 60));
    expect(nextCenter.dy, greaterThan(activeCenter.dy), reason: 'inactive cards sink');

    // Tapping the active card picks it.
    await tester.tapAt(activeCenter);
    await tester.pump();
    expect(picked.map((item) => item.id), [random.id]);

    // Swiping left cuts to the next card.
    await tester.fling(find.byType(SuggestionHand), const Offset(-220, 0), 900);
    await pumpFrames(tester, 900);
    expect(find.byIcon(CupertinoIcons.arrow_2_circlepath), findsNothing, reason: 'tools follow the active card');
    final newActive = cardCenter(tester, firstExplore);
    expect((newActive.dx - activeCenter.dx).abs(), lessThan(4), reason: 'the next card moved to centre');
    expect(cardCenter(tester, secondExplore).dx, greaterThan(newActive.dx + 10));
    await tester.tapAt(newActive);
    await tester.pump();
    expect(picked.last.id, firstExplore.id);

    // One swipe never cuts more than one card, even when flung hard.
    await tester.fling(find.byType(SuggestionHand), const Offset(-300, 0), 4000);
    await pumpFrames(tester, 900);
    expect((cardCenter(tester, secondExplore).dx - activeCenter.dx).abs(), lessThan(4));
    expect(find.text(random.title), findsOneWidget, reason: 'cut cards stay in the deck');

    // Tapping a peeking edge cuts back to that card instead of picking it. The
    // active card covers most of its neighbour, so aim at the exposed left strip.
    final before = picked.length;
    final edge = tester.getRect(find.byKey(ValueKey(firstExplore.id)));
    await tester.tapAt(Offset(edge.left + 9, edge.top + edge.height * 0.25));
    await pumpFrames(tester, 900);
    expect(picked.length, before);
    expect((cardCenter(tester, firstExplore).dx - activeCenter.dx).abs(), lessThan(4));
  });

  testWidgets('shuffle swaps the random card in place and dismiss removes it', (tester) async {
    final picked = <WorkSuggestion>[];
    await pumpHand(tester, picked: picked);
    final container = ProviderScope.containerOf(tester.element(find.byType(SuggestionHand)));
    final before = container.read(dailySuggestionsProvider).knowledge.single;

    await tester.tap(find.byIcon(CupertinoIcons.arrow_2_circlepath));
    await pumpFrames(tester, 700);
    await settle(tester);
    final after = container.read(dailySuggestionsProvider).knowledge.single;
    expect(after.knowledge!.seedId, isNot(before.knowledge!.seedId));
    expect(find.text(after.title), findsOneWidget);
    expect(find.text(before.title), findsNothing);
    expect(find.text('今天还能换 ${knowledgeShuffleLimit - 1} 次'), findsOneWidget);

    await tester.tap(find.byIcon(CupertinoIcons.xmark));
    await settle(tester);
    expect(container.read(dailySuggestionsProvider).knowledge, isEmpty);
    expect(find.text(after.title), findsNothing);
    expect(find.text('知识探索'), findsNothing);
    // The first explore card becomes the active one; the deck keeps working.
    expect(find.byIcon(CupertinoIcons.xmark), findsOneWidget);
    expect(picked, isEmpty);
  });

  testWidgets('view all opens the complete suggestion list when the hand is capped', (tester) async {
    final picked = <WorkSuggestion>[];
    await pumpHand(tester, picked: picked);

    expect(find.textContaining('查看全部 · 还有'), findsOneWidget);
    await tester.tap(find.textContaining('查看全部 · 还有'));
    await tester.pumpAndSettle();

    expect(find.text('全部建议'), findsOneWidget);
    expect(find.text('能力探索'), findsWidgets);
  });
}
