import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show ImageFilter;

import 'package:flutter/cupertino.dart';
import 'package:flutter/physics.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/daily_suggestions_provider.dart';
import '../../core/glass.dart';

/// 对话空态的「手牌」:今日推荐、知识探索与能力探索叠成一副牌。
///
/// 对齐桌面端的扇形手牌,但移动端没有悬停:整副牌重叠在一起,只有当前这张完整
/// 展开并抬起,两侧的牌只露出牌边。左右滑动做一次「切牌」:当前的牌被抽出、向外
/// 一甩、塞回牌底,下一张升到最上面。点当前的牌即采用;点露出的牌边把它切到前面。
class SuggestionHand extends ConsumerStatefulWidget {
  const SuggestionHand({
    required this.onPick,
    required this.onOpenSettings,
    super.key,
  });

  final void Function(WorkSuggestion suggestion) onPick;
  final VoidCallback onOpenSettings;

  @override
  ConsumerState<SuggestionHand> createState() => _SuggestionHandState();
}

enum _CardGroup { daily, knowledge, explore }

class _HandCard {
  const _HandCard.item(WorkSuggestion this.item, _CardGroup this.group)
    : isEnableCta = false;
  const _HandCard.enable() : item = null, group = null, isEnableCta = true;

  final WorkSuggestion? item;
  final _CardGroup? group;
  final bool isEnableCta;

  String get id => item?.id ?? 'enable';
}

class _SuggestionHandState extends ConsumerState<SuggestionHand>
    with TickerProviderStateMixin {
  static const _maxCards = 9;
  static const _maxDailyCards = 5;
  static const _maxKnowledgeCards = 3;
  static const _cardHeight = 172.0;

  /// 当前这张抬起的高度;其余的牌按距离逐张下沉。
  static const _lift = 14.0;
  static const _sinkStep = 7.0;

  /// 相邻牌露出的牌边宽度;更远的牌挤得更紧。
  static const _nearStep = 26.0;
  static const _farStep = 11.0;
  static const _tiltDegrees = 4.5;
  static const _maxTiltSteps = 2.5;

  /// 切牌:被抽出的那张向外甩多远、抬多高、再多转几度。
  static const _cutSwing = 56.0;
  static const _cutLift = 24.0;
  static const _cutTiltDegrees = 9.0;

  /// 页码是连续值:整数处停在某张牌上,小数是切牌进行到一半。
  late final AnimationController _pageCtrl = AnimationController.unbounded(
    vsync: this,
  );
  late final AnimationController _dealCtrl = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 640),
  );
  late final AnimationController _swapCtrl = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 460),
  );
  late final Listenable _repaint = Listenable.merge([
    _pageCtrl,
    _dealCtrl,
    _swapCtrl,
  ]);

  /// 正在被抽出、塞回牌底的那张牌。
  int? _cutting;
  bool _dragging = false;
  bool _dealt = false;
  int _cardCount = 0;
  double _dragWidth = 260;
  Timer? _seenTimer;
  bool _refreshing = false;
  bool _shuffling = false;

  /// 牌面子树按牌 id 缓存。切牌动画每帧只改 Transform 与层级顺序:widget 实例
  /// 不变时 Flutter 会整棵跳过重建,再配合 RepaintBoundary,动画帧退化为纯合成。
  final Map<String, (int, Widget)> _faces = <String, (int, Widget)>{};

  @override
  void initState() {
    super.initState();
    _pageCtrl.addStatusListener(_onPageStatus);
  }

  @override
  void didUpdateWidget(SuggestionHand oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 回调闭包可能已换新,牌面上挂着的旧闭包不能再用。
    _faces.clear();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // 主题/明暗切换后,旧配色画出来的牌面全部作废。
    _faces.clear();
  }

  @override
  void dispose() {
    _seenTimer?.cancel();
    _pageCtrl.dispose();
    _dealCtrl.dispose();
    _swapCtrl.dispose();
    super.dispose();
  }

  void _onPageStatus(AnimationStatus status) {
    if (status != AnimationStatus.completed &&
        status != AnimationStatus.dismissed) {
      return;
    }
    if (_dragging || _cutting == null) return;
    setState(() => _cutting = null);
  }

  // ------------------------------------------------------------------ cards

  List<_HandCard> _allSuggestionCards(DailySuggestionState state) => [
    for (final item in state.daily) _HandCard.item(item, _CardGroup.daily),
    for (final item in state.knowledge)
      _HandCard.item(item, _CardGroup.knowledge),
    for (final item in state.explore) _HandCard.item(item, _CardGroup.explore),
  ];

  List<_HandCard> _cards(DailySuggestionState state) {
    final cards = <_HandCard>[
      for (final item in state.daily.take(_maxDailyCards))
        _HandCard.item(item, _CardGroup.daily),
      for (final item in state.knowledge.take(_maxKnowledgeCards))
        _HandCard.item(item, _CardGroup.knowledge),
    ];
    final enabled = state.preferences.enabled;
    var exploreBudget = _maxCards - cards.length - (enabled ? 0 : 1);
    if (exploreBudget < 0) exploreBudget = 0;
    for (final item in state.explore.take(exploreBudget)) {
      cards.add(_HandCard.item(item, _CardGroup.explore));
    }
    if (!enabled && state.loaded) cards.add(const _HandCard.enable());
    return cards;
  }

  int _hiddenCount(DailySuggestionState state, List<_HandCard> visible) {
    final visibleIds = visible
        .where((card) => !card.isEnableCta)
        .map((card) => card.id)
        .toSet();
    return _allSuggestionCards(
      state,
    ).where((card) => !visibleIds.contains(card.id)).length;
  }

  void _showAllSuggestions(DailySuggestionState state) {
    if (_hiddenCount(state, _cards(state)) == 0) return;
    showCupertinoModalPopup<void>(
      context: context,
      builder: (sheetContext) => _AllSuggestionsSheet(
        onPick: (item) {
          Navigator.of(sheetContext).pop();
          widget.onPick(item);
        },
        onDismiss: (item) => unawaited(
          ref.read(dailySuggestionsProvider.notifier).dismiss(item),
        ),
        onShuffle: _shuffle,
        shuffling: _shuffling,
      ),
    );
  }

  void _scheduleSeen(DailySuggestionState state) {
    if (!state.hasFreshDaily || _seenTimer != null) return;
    // 「新」角标在首次露出的这次访问里保留几秒,然后清掉。
    _seenTimer = Timer(const Duration(seconds: 4), () {
      _seenTimer = null;
      if (mounted) {
        unawaited(ref.read(dailySuggestionsProvider.notifier).markSeen());
      }
    });
  }

  // ------------------------------------------------------------------ gestures

  double get _maxPage => math.max(0, _cardCount - 1).toDouble();

  // `num.clamp` returns num; keep page geometry in doubles.
  double get _clampedPage => _pageCtrl.value.clamp(0.0, _maxPage).toDouble();

  int get _activeIndex => _clampedPage.round();

  void _snapTo(int target, {double velocity = 0}) {
    final to = target.clamp(0, _maxPage.toInt()).toDouble();
    final from = _pageCtrl.value;
    if ((to - from).abs() < 0.001) {
      _pageCtrl.value = to;
      if (_cutting != null && !_dragging) setState(() => _cutting = null);
      return;
    }
    _cutting ??= from.round();
    final spring = SpringDescription.withDampingRatio(
      mass: 1,
      stiffness: 340,
      ratio: 0.88,
    );
    // A hard fling still lands on the next card; cap the carry-over so it does not overshoot past it.
    _pageCtrl.animateWith(
      SpringSimulation(spring, from, to, velocity.clamp(-6.0, 6.0).toDouble()),
    );
  }

  void _onDragStart(DragStartDetails details) {
    _pageCtrl.stop();
    _dragging = true;
    _cutting ??= _pageCtrl.value.round();
  }

  void _onDragUpdate(DragUpdateDetails details) {
    final current = _pageCtrl.value;
    // 拖过两端时加阻尼,像牌被手指按住。
    final beyond = current < 0 || current > _maxPage;
    final delta =
        -(details.primaryDelta ?? 0) / _dragWidth * (beyond ? 0.3 : 1);
    _pageCtrl.value = (current + delta)
        .clamp(-0.45, _maxPage + 0.45)
        .toDouble();
  }

  void _onDragEnd(DragEndDetails details) {
    _dragging = false;
    final velocity = -(details.primaryVelocity ?? 0) / _dragWidth;
    final anchor = _cutting ?? _pageCtrl.value.round();
    // 一次滑动最多切一张:顺着甩出去的方向,或者按停下的位置就近落牌。
    final projected = _pageCtrl.value + velocity * 0.16;
    final target = projected.round().clamp(anchor - 1, anchor + 1).toInt();
    _snapTo(target, velocity: velocity);
  }

  void _tapCard(int index, _HandCard card) {
    if ((index - _pageCtrl.value).abs() > 0.5) {
      _snapTo(index);
      return;
    }
    if (card.isEnableCta) {
      widget.onOpenSettings();
      return;
    }
    widget.onPick(card.item!);
  }

  Future<void> _refresh() async {
    if (_refreshing) return;
    setState(() => _refreshing = true);
    try {
      await ref.read(dailySuggestionsProvider.notifier).generateNow();
    } catch (_) {
      // 状态行会解释原因(次数用尽 / 未配置模型 / 失败)。
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  /// 「换一个」随机知识:牌先被抽出去一半,换掉内容,再落回来。
  Future<void> _shuffle() async {
    if (_shuffling) return;
    setState(() => _shuffling = true);
    try {
      await _swapCtrl.animateTo(
        0.5,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeIn,
      );
      await ref.read(dailySuggestionsProvider.notifier).shuffleKnowledge();
    } catch (_) {
      // 次数用尽或来源已关闭:按钮态与提示会说明。
    } finally {
      if (mounted) {
        await _swapCtrl.animateTo(
          1,
          duration: const Duration(milliseconds: 260),
          curve: Curves.easeOut,
        );
        if (mounted) {
          _swapCtrl.value = 0;
          setState(() => _shuffling = false);
        }
      }
    }
  }

  // ------------------------------------------------------------------ layout

  /// 一张牌相对牌堆中心的位置。`deal` 是发牌进度:0 时整副牌叠在中间,1 时展开。
  Matrix4 _cardTransform(int index, double page, double deal) {
    final delta = index - page;
    final dist = delta.abs();
    final sign = delta == 0 ? 1.0 : delta.sign;
    final near = math.min(dist, 1.0);
    var x = dist <= 1
        ? delta * _nearStep
        : sign * (_nearStep + (dist - 1) * _farStep);
    var y = -_lift * (1 - near) + math.min(dist, 3.0) * _sinkStep;
    var tilt =
        delta.clamp(-_maxTiltSteps, _maxTiltSteps).toDouble() * _tiltDegrees;
    final scale = 1 - near * 0.05;
    if (index == _cutting) {
      // 切牌弧线:抽出时抬起、向外甩,过了一半塞到下一张后面。
      final swing = math.sin(math.pi * near);
      x += sign * swing * _cutSwing;
      y -= swing * _cutLift;
      tilt += sign * swing * _cutTiltDegrees;
    }
    if (_swapCtrl.value > 0 && index == _activeIndex) {
      final swing = math.sin(math.pi * _swapCtrl.value);
      x += swing * 44;
      y -= swing * 18;
      tilt += swing * 8;
    }
    x *= deal;
    tilt *= deal;
    y = 24 + (y - 24) * deal;
    return Matrix4.translationValues(x, y, 0)
      ..multiply(Matrix4.rotationZ(tilt * math.pi / 180))
      ..multiply(Matrix4.diagonal3Values(scale, scale, 1));
  }

  Widget _buildHand(List<_HandCard> cards, DailySuggestionState state) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final cardWidth = math.min(312.0, constraints.maxWidth - 76);
        _dragWidth = cardWidth * 0.82;
        final left = (constraints.maxWidth - cardWidth) / 2;
        const top = _lift + _cutLift + 6;
        return GestureDetector(
          behavior: HitTestBehavior.translucent,
          onHorizontalDragStart: _onDragStart,
          onHorizontalDragUpdate: _onDragUpdate,
          onHorizontalDragEnd: _onDragEnd,
          child: SizedBox(
            height: top + _cardHeight + 3 * _sinkStep + 10,
            child: AnimatedBuilder(
              animation: _repaint,
              builder: (context, _) {
                final page = _clampedPage;
                final deal = Curves.easeOutCubic.transform(_dealCtrl.value);
                final active = _activeIndex;
                // 离当前牌越远画得越早,当前这张永远在最上面;切牌到一半时两张交换层级。
                final order = List<int>.generate(cards.length, (index) => index)
                  ..sort((a, b) {
                    final byDistance = (b - page).abs().compareTo(
                      (a - page).abs(),
                    );
                    return byDistance != 0 ? byDistance : a.compareTo(b);
                  });
                return Stack(
                  clipBehavior: Clip.none,
                  children: [
                    for (final index in order)
                      Positioned(
                        left: left,
                        top: top,
                        width: cardWidth,
                        height: _cardHeight,
                        child: Transform(
                          alignment: Alignment.bottomCenter,
                          transform: _cardTransform(
                            index,
                            _pageCtrl.value,
                            deal,
                          ),
                          // 边界在 Transform 内侧:矩阵每帧变化只重画这一层的合成,
                          // 牌面(连同 40px 投影)的位图被缓存,拖动不再整片重绘。
                          child: RepaintBoundary(
                            // Opacity at 1.0 paints straight through, so keeping the
                            // wrapper avoids re-parenting the card when the deal ends.
                            child: Opacity(
                              opacity: deal,
                              child: _cardFace(
                                index,
                                cards[index],
                                index == active,
                                state,
                              ),
                            ),
                          ),
                        ),
                      ),
                  ],
                );
              },
            ),
          ),
        );
      },
    );
  }

  /// 取(或建)一张牌的牌面。只在离散状态变化时重建;动画帧之间返回同一个
  /// widget 实例,Flutter 检测到 identical 后整棵子树都不重建、不重排版。
  /// 索引参与键:移除一张牌后其余牌会前移,闭包里的旧索引不能复用。
  Widget _cardFace(
    int index,
    _HandCard card,
    bool active,
    DailySuggestionState state,
  ) {
    final key = Object.hash(
      index,
      identityHashCode(card.item),
      active,
      state.knowledgeShuffleRemaining,
      _shuffling,
      identityHashCode(widget.onPick),
      identityHashCode(widget.onOpenSettings),
    );
    final cached = _faces[card.id];
    if (cached != null && cached.$1 == key) return cached.$2;
    final face = _buildCard(index, card, active, state);
    _faces[card.id] = (key, face);
    return face;
  }

  Widget _buildCard(
    int index,
    _HandCard card,
    bool active,
    DailySuggestionState state,
  ) {
    if (card.isEnableCta) {
      return _EnableCard(
        key: ValueKey(card.id),
        lifted: active,
        // 只有当前这张做背景模糊:两侧的牌只露一条 11~26px 的牌边,磨砂底色
        // 本就近乎不透明,省掉它们的 BackdropFilter 是滑动流畅度的大头。
        blur: active,
        onTap: () => _tapCard(index, card),
      );
    }
    final item = card.item!;
    return _SuggestionCard(
      key: ValueKey(card.id),
      item: item,
      group: card.group!,
      lifted: active,
      blur: active,
      shuffleRemaining: state.knowledgeShuffleRemaining,
      shuffling: _shuffling,
      onTap: () => _tapCard(index, card),
      onDismiss: () {
        unawaited(ref.read(dailySuggestionsProvider.notifier).dismiss(item));
      },
      onShuffle: item.isRandomKnowledge ? _shuffle : null,
    );
  }

  String _statusLine(DailySuggestionState state) {
    if (!state.preferences.enabled) return '';
    if (state.generating || _refreshing) return '正在生成今日推荐…';
    if (state.daily.isNotEmpty) return '';
    if (state.providerMissing) return '还没有配置可用的模型服务,请先到「模型供应商」中添加。';
    if (state.lastGeneration?.status == 'failed') {
      return '今日推荐生成失败,可以稍后「换一批」或到设置中查看原因。';
    }
    return '今天还没有推荐,点「换一批」立即生成。';
  }

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    final state = ref.watch(dailySuggestionsProvider);
    _scheduleSeen(state);
    final cards = _cards(state);
    _cardCount = cards.length;
    // 牌被换掉/移除后,缓存里不再存在的牌面一并清掉。
    if (_faces.length > cards.length) {
      final ids = {for (final card in cards) card.id};
      _faces.removeWhere((id, _) => !ids.contains(id));
    }
    if (cards.isEmpty) {
      _dealt = false;
    } else if (!_dealt) {
      _dealt = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _dealCtrl.forward(from: 0);
      });
    }
    // 牌被「不感兴趣」后可能少于当前页码;下一帧把页码收回牌堆内。
    if (!_dragging && !_pageCtrl.isAnimating && _pageCtrl.value > _maxPage) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && !_dragging && !_pageCtrl.isAnimating) {
          _pageCtrl.value = _maxPage;
        }
      });
    }

    final prefs = state.preferences;
    final generating = state.generating || _refreshing;
    final remaining = state.lastGeneration?.manualRefreshRemaining;
    final refreshDisabled = generating || remaining == 0;
    final status = _statusLine(state);
    final knowledgeEnabled =
        prefs.knowledge.enabled && state.knowledge.isNotEmpty;
    final todayDiscipline =
        state.randomKnowledge?.knowledge?.disciplineLabel ?? '';
    final hiddenCount = _hiddenCount(state, cards);

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(22, 0, 18, 2),
          child: Row(
            children: [
              Expanded(
                child: Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 6,
                  runSpacing: 2,
                  children: [
                    if (prefs.enabled) ...[
                      Text(
                        '今日推荐',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: p.ink2,
                        ),
                      ),
                      if (state.hasFreshDaily)
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 6,
                            vertical: 1,
                          ),
                          decoration: BoxDecoration(
                            color: p.indigo,
                            borderRadius: BorderRadius.circular(99),
                          ),
                          child: const Text(
                            '新',
                            style: TextStyle(
                              fontSize: 9.5,
                              fontWeight: FontWeight.w700,
                              color: Color(0xFFFFFFFF),
                            ),
                          ),
                        ),
                      Text('·', style: TextStyle(fontSize: 12, color: p.ink3)),
                    ],
                    Text(
                      '能力探索',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: prefs.enabled
                            ? FontWeight.w500
                            : FontWeight.w600,
                        color: p.ink2,
                      ),
                    ),
                    if (state.weekTheme.isNotEmpty)
                      Text(
                        '本周:${state.weekTheme}',
                        style: TextStyle(fontSize: 11, color: p.ink3),
                      ),
                    if (knowledgeEnabled) ...[
                      Text('·', style: TextStyle(fontSize: 12, color: p.ink3)),
                      Text(
                        '知识探索',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w500,
                          color: p.ink2,
                        ),
                      ),
                      if (todayDiscipline.isNotEmpty)
                        Text(
                          '今日:$todayDiscipline',
                          style: TextStyle(fontSize: 11, color: p.ink3),
                        ),
                    ],
                  ],
                ),
              ),
              if (prefs.needsModel)
                if (generating)
                  const Padding(
                    padding: EdgeInsets.only(right: 6),
                    child: CupertinoActivityIndicator(radius: 6),
                  )
                else
                  _LinkButton(
                    label: '换一批',
                    enabled: !refreshDisabled,
                    onTap: _refresh,
                  ),
              _LinkButton(
                label: '设置',
                enabled: true,
                onTap: widget.onOpenSettings,
              ),
            ],
          ),
        ),
        if (status.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 0, 22, 2),
            child: Text(
              status,
              style: TextStyle(fontSize: 11.5, color: p.ink2),
            ),
          ),
        if (cards.isEmpty)
          const SizedBox(height: 24)
        else ...[
          _buildHand(cards, state),
          const SizedBox(height: 4),
          AnimatedBuilder(
            animation: _pageCtrl,
            builder: (context, _) =>
                _PageDots(count: cards.length, page: _clampedPage),
          ),
          if (hiddenCount > 0)
            _ViewAllButton(
              count: hiddenCount,
              onTap: () => _showAllSuggestions(state),
            ),
        ],
      ],
    );
  }
}

class _ViewAllButton extends StatelessWidget {
  const _ViewAllButton({required this.count, required this.onTap});

  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return CupertinoButton(
      padding: const EdgeInsets.symmetric(vertical: 7),
      minimumSize: const Size(0, 0),
      onPressed: onTap,
      child: Text(
        '查看全部 · 还有 $count 张',
        style: TextStyle(fontSize: 11.5, color: p.ink2),
      ),
    );
  }
}

class _AllSuggestionsSheet extends ConsumerWidget {
  const _AllSuggestionsSheet({
    required this.onPick,
    required this.onDismiss,
    required this.onShuffle,
    required this.shuffling,
  });

  final void Function(WorkSuggestion suggestion) onPick;
  final void Function(WorkSuggestion suggestion) onDismiss;
  final Future<void> Function() onShuffle;
  final bool shuffling;

  String _groupTitle(_CardGroup group) => switch (group) {
    _CardGroup.daily => '今日推荐',
    _CardGroup.knowledge => '知识探索',
    _CardGroup.explore => '能力探索',
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = DawnPalette.of(context);
    final state = ref.watch(dailySuggestionsProvider);
    final visibleIds = {
      for (final item in state.daily.take(_SuggestionHandState._maxDailyCards))
        item.id,
      for (final item in state.knowledge.take(
        _SuggestionHandState._maxKnowledgeCards,
      ))
        item.id,
    };
    final visibleExploreBudget = math.max(
      0,
      _SuggestionHandState._maxCards -
          state.daily.take(_SuggestionHandState._maxDailyCards).length -
          state.knowledge.take(_SuggestionHandState._maxKnowledgeCards).length -
          (state.preferences.enabled ? 0 : 1),
    );
    visibleIds.addAll(
      state.explore.take(visibleExploreBudget).map((item) => item.id),
    );
    final groups = <(_CardGroup, List<WorkSuggestion>)>[
      (
        _CardGroup.daily,
        state.daily.where((item) => !visibleIds.contains(item.id)).toList(),
      ),
      (
        _CardGroup.knowledge,
        state.knowledge.where((item) => !visibleIds.contains(item.id)).toList(),
      ),
      (
        _CardGroup.explore,
        state.explore.where((item) => !visibleIds.contains(item.id)).toList(),
      ),
    ].where((entry) => entry.$2.isNotEmpty).toList();

    return SafeArea(
      child: Container(
        height: MediaQuery.sizeOf(context).height * 0.86,
        decoration: BoxDecoration(
          color: p.isDark ? const Color(0xFF171925) : const Color(0xFFF7F7FB),
          borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        ),
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 12, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      '全部建议',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                        color: p.ink,
                      ),
                    ),
                  ),
                  CupertinoButton(
                    padding: const EdgeInsets.all(8),
                    minimumSize: const Size(0, 0),
                    onPressed: () => Navigator.of(context).pop(),
                    child: Icon(CupertinoIcons.xmark, size: 16, color: p.ink2),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                children: [
                  for (final (group, items) in groups) ...[
                    Padding(
                      padding: const EdgeInsets.fromLTRB(4, 10, 4, 8),
                      child: Text(
                        '${_groupTitle(group)}  ${items.length}',
                        style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w600,
                          color: p.ink2,
                        ),
                      ),
                    ),
                    for (final item in items)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: SizedBox(
                          height: _SuggestionHandState._cardHeight,
                          child: _SuggestionCard(
                            item: item,
                            group: group,
                            lifted: true,
                            blur: false,
                            shuffleRemaining: state.knowledgeShuffleRemaining,
                            shuffling: shuffling,
                            onTap: () => onPick(item),
                            onDismiss: () => onDismiss(item),
                            onShuffle: item.isRandomKnowledge
                                ? onShuffle
                                : null,
                          ),
                        ),
                      ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LinkButton extends StatelessWidget {
  const _LinkButton({
    required this.label,
    required this.enabled,
    required this.onTap,
  });

  final String label;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return CupertinoButton(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
      minimumSize: const Size(0, 0),
      onPressed: enabled ? onTap : null,
      child: Text(
        label,
        style: TextStyle(fontSize: 11.5, color: enabled ? p.ink2 : p.ink3),
      ),
    );
  }
}

/// 牌堆下方的位置指示:当前这张拉长成一条。
class _PageDots extends StatelessWidget {
  const _PageDots({required this.count, required this.page});

  final int count;
  final double page;

  @override
  Widget build(BuildContext context) {
    if (count <= 1) return const SizedBox(height: 6);
    final p = DawnPalette.of(context);
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        for (var index = 0; index < count; index++)
          Builder(
            builder: (context) {
              final near = (1 - (index - page).abs()).clamp(0.0, 1.0);
              return Container(
                width: 4 + 10 * near,
                height: 4,
                margin: const EdgeInsets.symmetric(horizontal: 2),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(2),
                  color: Color.lerp(
                    p.ink3.withValues(alpha: 0.35),
                    p.indigo,
                    near,
                  ),
                ),
              );
            },
          ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// 磨砂玻璃牌面
// ---------------------------------------------------------------------------

const Color _amber = Color(0xFFF59E0B);
const Color _amberInkLight = Color(0xFFB45309);
const Color _amberInkDark = Color(0xFFFBBF24);

/// 一张磨砂玻璃牌:背景模糊 + 近乎不透明的底色 + 极淡的斜向渐变 + 一条 1px 顶部内高光。
///
/// 故意不用 [GlassContainer] 的大块 sheen:牌是叠在一起看的,大片高光会盖住
/// 下面那张的牌边,也让牌面看起来像贴了一层白雾。
class _FrostedCard extends StatelessWidget {
  const _FrostedCard({
    required this.child,
    required this.lifted,
    this.blur = true,
    this.tint,
    this.dashed = false,
    this.padding = const EdgeInsets.fromLTRB(14, 12, 12, 12),
  });

  final Widget child;
  final bool lifted;

  /// 是否做背景模糊。牌堆深处只露一条牌边的牌可以省掉。
  final bool blur;

  /// 分组色:今日推荐偏晨蓝,知识探索偏琥珀,能力探索中性。
  final Color? tint;
  final bool dashed;
  final EdgeInsetsGeometry padding;

  static const double radius = 18;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    final dark = p.isDark;
    final base = dark ? const Color(0xFF181A26) : const Color(0xFFFFFFFF);
    final body = tint == null
        ? base
        : Color.alphaBlend(tint!.withValues(alpha: dark ? 0.16 : 0.10), base);
    final fillAlpha = dark ? (lifted ? 0.88 : 0.78) : (lifted ? 0.84 : 0.72);
    final borderColor = dashed
        ? p.indigo.withValues(alpha: 0.5)
        : dark
        ? const Color(0xFFFFFFFF).withValues(alpha: lifted ? 0.2 : 0.14)
        : const Color(0xFF6068B4).withValues(alpha: lifted ? 0.28 : 0.18);
    final shadowColor = dark
        ? const Color(0xFF000000)
        : const Color(0xFF0F172A);
    final border = BorderRadius.circular(radius);

    Widget face = DecoratedBox(
      decoration: BoxDecoration(
        color: body.withValues(alpha: fillAlpha),
        borderRadius: border,
      ),
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: border,
          border: dashed ? null : Border.all(color: borderColor),
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              const Color(0xFFFFFFFF).withValues(alpha: dark ? 0.09 : 0.28),
              const Color(0xFFFFFFFF).withValues(alpha: dark ? 0.015 : 0.04),
            ],
          ),
        ),
        child: Stack(
          children: [
            if (dashed)
              Positioned.fill(
                child: IgnorePointer(
                  child: CustomPaint(
                    painter: _DashedBorderPainter(
                      color: borderColor,
                      radius: radius,
                    ),
                  ),
                ),
              ),
            // 顶部一条 1px 内高光:透镜边缘感,而不是一片白雾。
            Positioned(
              top: 1,
              left: 14,
              right: 14,
              height: 1,
              child: IgnorePointer(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      colors: [
                        const Color(0x00FFFFFF),
                        const Color(
                          0xFFFFFFFF,
                        ).withValues(alpha: dark ? 0.16 : 0.6),
                        const Color(0x00FFFFFF),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            Padding(padding: padding, child: child),
          ],
        ),
      ),
    );
    if (blur) {
      face = BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 22, sigmaY: 22),
        child: face,
      );
    }

    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: border,
        boxShadow: [
          BoxShadow(
            color: shadowColor.withValues(
              alpha: dark ? (lifted ? 0.45 : 0.28) : (lifted ? 0.18 : 0.08),
            ),
            blurRadius: lifted ? 40 : 18,
            offset: Offset(0, lifted ? 22 : 6),
          ),
        ],
      ),
      child: ClipRRect(borderRadius: border, child: face),
    );
  }
}

class _DashedBorderPainter extends CustomPainter {
  const _DashedBorderPainter({required this.color, required this.radius});

  final Color color;
  final double radius;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = RRect.fromRectAndRadius(
      Offset.zero.translate(0.5, 0.5) & Size(size.width - 1, size.height - 1),
      Radius.circular(radius),
    );
    final path = Path()..addRRect(rect);
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    const dash = 6.0;
    const gap = 4.0;
    for (final metric in path.computeMetrics()) {
      var distance = 0.0;
      while (distance < metric.length) {
        final end = math.min(distance + dash, metric.length);
        canvas.drawPath(metric.extractPath(distance, end), paint);
        distance = end + gap;
      }
    }
  }

  @override
  bool shouldRepaint(_DashedBorderPainter oldDelegate) =>
      oldDelegate.color != color || oldDelegate.radius != radius;
}

/// 一张建议牌:分组芯片 + 标题 + 描述 + 脚注(学科 / 能力 / 场景提示)+ 右上角工具。
class _SuggestionCard extends StatelessWidget {
  const _SuggestionCard({
    required this.item,
    required this.group,
    required this.lifted,
    required this.blur,
    required this.shuffleRemaining,
    required this.shuffling,
    required this.onTap,
    required this.onDismiss,
    this.onShuffle,
    super.key,
  });

  final WorkSuggestion item;
  final _CardGroup group;
  final bool lifted;
  final bool blur;
  final int shuffleRemaining;
  final bool shuffling;
  final VoidCallback onTap;
  final VoidCallback onDismiss;
  final Future<void> Function()? onShuffle;

  String get _chip => switch (group) {
    _CardGroup.daily =>
      SuggestionType.fromKey(item.type) == null
          ? item.type
          : suggestionTypeCopy[SuggestionType.fromKey(item.type)!]!.label,
    _CardGroup.knowledge => item.knowledge?.source.label ?? '知识探索',
    _CardGroup.explore => suggestionFeatureLabels[item.featureTag] ?? '能力探索',
  };

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    final amberInk = p.isDark ? _amberInkDark : _amberInkLight;
    final (chipBg, chipFg, tint) = switch (group) {
      _CardGroup.daily => (
        p.indigo.withValues(alpha: 0.14),
        p.indigo,
        p.indigo,
      ),
      _CardGroup.knowledge => (
        _amber.withValues(alpha: 0.18),
        amberInk,
        _amber,
      ),
      _CardGroup.explore => (
        p.ink.withValues(alpha: p.isDark ? 0.12 : 0.07),
        p.ink2,
        null,
      ),
    };
    final isKnowledge = group == _CardGroup.knowledge;
    final discipline = item.knowledge?.disciplineLabel ?? '';
    final featureLabel = suggestionFeatureLabels[item.featureTag];
    final shuffleEnabled =
        onShuffle != null && shuffleRemaining > 0 && !shuffling;

    final String foot;
    if (isKnowledge && discipline.isNotEmpty) {
      foot = discipline;
    } else if (group == _CardGroup.daily && featureLabel != null) {
      foot = featureLabel;
    } else {
      foot = '';
    }
    final String hint;
    if (item.isRandomKnowledge) {
      hint = shuffleRemaining > 0
          ? '今天还能换 $shuffleRemaining 次'
          : '今天的次数用完了,明天见';
    } else if (item.scene?.enableThinking == true) {
      hint = '点击后将开启深度思考';
    } else {
      hint = '';
    }

    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: _FrostedCard(
        lifted: lifted,
        blur: blur,
        tint: tint,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(right: 44),
                  child: Row(
                    children: [
                      Flexible(
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: chipBg,
                            borderRadius: BorderRadius.circular(99),
                          ),
                          child: Text(
                            _chip,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w600,
                              color: chipFg,
                            ),
                          ),
                        ),
                      ),
                      if (group == _CardGroup.daily &&
                          item.source == 'static') ...[
                        const SizedBox(width: 5),
                        Text(
                          '内置',
                          style: TextStyle(fontSize: 10, color: p.ink3),
                        ),
                      ],
                      if (item.fresh) ...[
                        const SizedBox(width: 6),
                        Container(
                          width: 6,
                          height: 6,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: p.indigo,
                            boxShadow: [
                              BoxShadow(
                                color: p.indigo.withValues(alpha: 0.22),
                                spreadRadius: 3,
                              ),
                            ],
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  item.title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: isKnowledge ? 15 : 14,
                    fontWeight: FontWeight.w600,
                    height: 1.3,
                    color: p.ink,
                  ),
                ),
                const SizedBox(height: 4),
                Expanded(
                  child: Text(
                    item.description,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11.5,
                      height: 1.4,
                      color: p.ink2,
                    ),
                  ),
                ),
                if (foot.isNotEmpty || (lifted && hint.isNotEmpty))
                  Row(
                    children: [
                      if (foot.isNotEmpty)
                        Flexible(
                          child: Text(
                            foot,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 10.5,
                              fontWeight: FontWeight.w600,
                              color: isKnowledge ? amberInk : p.indigo,
                            ),
                          ),
                        ),
                      if (foot.isNotEmpty && lifted && hint.isNotEmpty)
                        const SizedBox(width: 8),
                      if (lifted && hint.isNotEmpty)
                        Flexible(
                          child: Text(
                            hint,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 10.5, color: p.ink3),
                          ),
                        ),
                    ],
                  ),
              ],
            ),
            if (lifted)
              Positioned(
                top: -7,
                right: -7,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (onShuffle != null)
                      _ToolButton(
                        icon: CupertinoIcons.arrow_2_circlepath,
                        enabled: shuffleEnabled,
                        onTap: () => unawaited(onShuffle!()),
                      ),
                    _ToolButton(
                      icon: CupertinoIcons.xmark,
                      enabled: true,
                      onTap: onDismiss,
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// 牌右上角的小工具(换一个 / 不感兴趣),只在抬起的牌上出现。
class _ToolButton extends StatelessWidget {
  const _ToolButton({
    required this.icon,
    required this.enabled,
    required this.onTap,
  });

  final IconData icon;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return CupertinoButton(
      padding: const EdgeInsets.all(7),
      minimumSize: const Size(0, 0),
      onPressed: enabled ? onTap : null,
      child: Icon(
        icon,
        size: 14,
        color: enabled ? p.ink3 : p.ink3.withValues(alpha: 0.4),
      ),
    );
  }
}

/// 未开启每日推荐时,牌堆末尾的入口牌。
class _EnableCard extends StatelessWidget {
  const _EnableCard({
    required this.lifted,
    required this.blur,
    required this.onTap,
    super.key,
  });

  final bool lifted;
  final bool blur;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: _FrostedCard(
        lifted: lifted,
        blur: blur,
        tint: p.indigo,
        dashed: true,
        padding: const EdgeInsets.all(14),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Container(
              width: 28,
              height: 28,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: p.indigo,
              ),
              child: const Icon(
                CupertinoIcons.add,
                size: 16,
                color: Color(0xFFFFFFFF),
              ),
            ),
            const SizedBox(height: 10),
            Text(
              '开启每日推荐',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: p.indigo,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              '每天根据你的会话和应用,生成新想法、问题和自动化建议。',
              textAlign: TextAlign.center,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11.5, height: 1.4, color: p.ink2),
            ),
          ],
        ),
      ),
    );
  }
}
