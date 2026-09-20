import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/daily_suggestions_provider.dart';
import '../../core/glass.dart';
import '../../core/ios_ui.dart';
import '../../core/providers.dart';
import '../common/model_picker.dart';
import 'settings_tab.dart';

/// 每日推荐设置子页(对齐桌面端 DailySuggestionsPanel)。
class DailySuggestionsPage extends StatelessWidget {
  const DailySuggestionsPage({super.key});

  @override
  Widget build(BuildContext context) {
    return SettingsSubPage(
      title: '每日推荐',
      child: ListView(
        padding: const EdgeInsets.only(bottom: 24),
        children: const [_DailySuggestionsCard()],
      ),
    );
  }
}

class _DailySuggestionsCard extends ConsumerStatefulWidget {
  const _DailySuggestionsCard();

  @override
  ConsumerState<_DailySuggestionsCard> createState() => _DailySuggestionsCardState();
}

class _DailySuggestionsCardState extends ConsumerState<_DailySuggestionsCard> {
  bool _generating = false;
  bool _shuffling = false;
  bool _replenishing = false;
  String? _feedback;
  Timer? _feedbackTimer;
  final _interestCtrl = TextEditingController();
  final _professionCtrl = TextEditingController();
  final _professionFocus = FocusNode();
  bool _professionSeeded = false;

  @override
  void initState() {
    super.initState();
    // Commit the profession when the field loses focus, like the desktop panel.
    _professionFocus.addListener(() {
      if (!_professionFocus.hasFocus) _commitProfession();
    });
  }

  @override
  void dispose() {
    _feedbackTimer?.cancel();
    _interestCtrl.dispose();
    _professionCtrl.dispose();
    _professionFocus.dispose();
    super.dispose();
  }

  DailySuggestionsNotifier get _notifier => ref.read(dailySuggestionsProvider.notifier);

  void _setFeedback(String message) {
    _feedbackTimer?.cancel();
    setState(() => _feedback = message);
    _feedbackTimer = Timer(const Duration(milliseconds: 2400), () {
      if (mounted) setState(() => _feedback = null);
    });
  }

  Future<void> _update(DailySuggestionPreferences next) async {
    await _notifier.setPreferences(next);
  }

  Future<void> _updateKnowledge(KnowledgePreferences next) async {
    await _notifier.setKnowledgePreferences(next);
  }

  void _toggleType(DailySuggestionPreferences prefs, SuggestionType type) {
    final current = prefs.types.toList();
    if (current.contains(type)) {
      if (current.length == 1) {
        _setFeedback('至少保留一种推荐类型');
        return;
      }
      current.remove(type);
    } else {
      current.add(type);
    }
    // Keep the canonical enum order so generation and display agree.
    final ordered = SuggestionType.values.where(current.contains).toList();
    unawaited(_update(prefs.copyWith(types: ordered)));
  }

  // ---------------------------------------------------------------- knowledge

  void _toggleSource(KnowledgePreferences knowledge, KnowledgeSource source) {
    final current = knowledge.sources.toList();
    if (current.contains(source)) {
      if (current.length == 1) {
        _setFeedback('至少保留一种知识来源');
        return;
      }
      current.remove(source);
    } else {
      current.add(source);
    }
    final ordered = KnowledgeSource.values.where(current.contains).toList();
    unawaited(_updateKnowledge(knowledge.copyWith(sources: ordered)));
  }

  void _addInterest(KnowledgePreferences knowledge) {
    final value = _interestCtrl.text.trim().replaceAll(RegExp(r'\s+'), ' ');
    if (value.isEmpty) return;
    if (knowledge.interests.length >= knowledgeMaxInterests) {
      _setFeedback('最多只能添加 $knowledgeMaxInterests 条主题');
      return;
    }
    final next = value.length > knowledgeInterestMaxLength ? value.substring(0, knowledgeInterestMaxLength) : value;
    _interestCtrl.clear();
    if (knowledge.interests.any((item) => item.toLowerCase() == next.toLowerCase())) return;
    unawaited(_updateKnowledge(knowledge.copyWith(interests: [...knowledge.interests, next])));
  }

  void _removeInterest(KnowledgePreferences knowledge, String interest) {
    unawaited(
      _updateKnowledge(knowledge.copyWith(interests: knowledge.interests.where((item) => item != interest).toList())),
    );
  }

  void _commitProfession() {
    final knowledge = ref.read(dailySuggestionsProvider).preferences.knowledge;
    var next = _professionCtrl.text.trim().replaceAll(RegExp(r'\s+'), ' ');
    if (next.length > knowledgeProfessionMaxLength) next = next.substring(0, knowledgeProfessionMaxLength);
    if (_professionCtrl.text != next) _professionCtrl.text = next;
    if (next == knowledge.profession) return;
    unawaited(_updateKnowledge(knowledge.copyWith(profession: next)));
  }

  Future<void> _shuffle() async {
    if (_shuffling) return;
    setState(() => _shuffling = true);
    try {
      await _notifier.shuffleKnowledge();
    } on StateError catch (error) {
      _setFeedback(
        error.message == 'KNOWLEDGE_SHUFFLE_LIMIT' ? '今天的次数用完了,明天见' : '换不了:${error.message}',
      );
    } finally {
      if (mounted) setState(() => _shuffling = false);
    }
  }

  Future<void> _replenishPool() async {
    if (_replenishing) return;
    setState(() => _replenishing = true);
    try {
      final added = await _notifier.replenishKnowledgePoolNow();
      _setFeedback('新增 $added 条题目');
    } on StateError catch (error) {
      _setFeedback(error.message == 'PROVIDER_MISSING' ? '没有可用的模型服务' : '补充失败:${error.message}');
    } catch (error) {
      _setFeedback('补充失败:${_replenishReason(error.toString())}');
    } finally {
      if (mounted) setState(() => _replenishing = false);
    }
  }

  String _replenishReason(String error) {
    if (error.contains('PROVIDER_MISSING')) return '没有可用的模型服务';
    if (error.contains('MODEL_OUTPUT_NOT_JSON') || error.contains('MODEL_OUTPUT_EMPTY')) return '模型返回的内容无法解析';
    if (error.contains('MODEL_TIMEOUT')) return '模型响应超时';
    return error;
  }

  String _poolStatusLabel(KnowledgePoolState pool, {required bool hasProviders}) {
    final error = pool.lastReplenishError;
    if (error != null) return '上次补充失败:${_replenishReason(error)}';
    final at = pool.lastReplenishAt == null ? null : DateTime.tryParse(pool.lastReplenishAt!);
    if (at == null) {
      return hasProviders ? '还没有补充过。题库变少或超过一周时会自动补充一批。' : '配置模型服务后,题库会自动补充新题。';
    }
    final when = '${at.month}/${at.day} ${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}';
    return '上次补充 $when,每周或题库变少时自动补充。';
  }

  Future<void> _pickTime(DailySuggestionPreferences prefs) async {
    final p = DawnPalette.of(context);
    final parts = prefs.trigger.timeOfDay.split(':').map(int.parse).toList();
    var picked = DateTime(2000, 1, 1, parts[0], parts[1]);
    var confirmed = false;
    await showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => Container(
        height: 300,
        decoration: BoxDecoration(
          color: p.cardBg,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
        ),
        child: SafeArea(
          top: false,
          child: Column(
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  CupertinoButton(
                    onPressed: () => Navigator.pop(ctx),
                    child: const Text('取消'),
                  ),
                  CupertinoButton(
                    onPressed: () {
                      confirmed = true;
                      Navigator.pop(ctx);
                    },
                    child: const Text('完成'),
                  ),
                ],
              ),
              Expanded(
                child: CupertinoDatePicker(
                  mode: CupertinoDatePickerMode.time,
                  use24hFormat: true,
                  initialDateTime: picked,
                  onDateTimeChanged: (value) => picked = value,
                ),
              ),
            ],
          ),
        ),
      ),
    );
    if (!confirmed) return;
    final timeOfDay =
        '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}';
    await _update(prefs.copyWith(trigger: DailySuggestionTrigger.time(timeOfDay)));
  }

  Future<void> _pickModel(DailySuggestionPreferences prefs) async {
    await showModelPickerSheet(
      context,
      title: '每日推荐使用的模型',
      selectedProviderId: prefs.providerId,
      selectedModel: prefs.modelId,
      onSelected: (providerId, model, _) {
        unawaited(_update(prefs.copyWith(providerId: providerId, modelId: model)));
      },
    );
  }

  Future<void> _generateNow() async {
    if (_generating) return;
    setState(() => _generating = true);
    try {
      await _notifier.generateNow();
      final state = ref.read(dailySuggestionsProvider);
      // 今日随机卡可能是生成题;只统计本次请求产出的条目。
      final count = state.daily.length +
          state.knowledge.where((item) => item.source == 'llm' && !item.isRandomKnowledge).length;
      _setFeedback(
        state.lastGeneration?.status == 'failed'
            ? '生成失败,请查看下方原因'
            : '已生成 $count 条推荐',
      );
    } on StateError catch (error) {
      _setFeedback(
        error.message == 'DAILY_SUGGESTIONS_REFRESH_LIMIT' ? '今天的手动生成次数已用完' : '生成失败:${error.message}',
      );
    } catch (error) {
      _setFeedback('生成失败:$error');
    } finally {
      if (mounted) setState(() => _generating = false);
    }
  }

  String _statusLabel(DailySuggestionState state) {
    final last = state.lastGeneration;
    if (last == null) return '还没有生成过。';
    final at = DateTime.tryParse(last.at);
    final when = at == null
        ? last.date
        : '${at.month}/${at.day} ${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}';
    switch (last.status) {
      case 'ok':
        return '上次生成:$when,成功。';
      case 'partial':
        return '上次生成:$when,部分类型条数不足,已用内置建议补齐。';
      default:
        final reason = switch (last.error) {
          'PROVIDER_MISSING' => '没有可用的模型服务',
          _ when (last.error ?? '').contains('MODEL_OUTPUT_NOT_JSON') => '模型返回的内容无法解析',
          _ when (last.error ?? '').contains('MODEL_TIMEOUT') => '模型响应超时',
          _ => last.error ?? '未知错误',
        };
        return '上次生成:$when,失败:$reason';
    }
  }

  String _modelLabel(DailySuggestionPreferences prefs) {
    if (prefs.providerId == null) return '跟随默认';
    final config = ref.watch(providersProvider).value;
    var providerName = prefs.providerId!;
    if (config != null) {
      for (final raw in (config['providers'] as List? ?? const []).whereType<Map>()) {
        if (raw['id'] == prefs.providerId && raw['name'] is String) {
          providerName = raw['name'] as String;
          break;
        }
      }
    }
    return '$providerName · ${prefs.modelId ?? '默认模型'}';
  }

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    final state = ref.watch(dailySuggestionsProvider);
    final prefs = state.preferences;
    final enabled = prefs.enabled;
    final knowledge = prefs.knowledge;
    final knowledgeEnabled = knowledge.enabled;
    final generating = _generating || state.generating;
    final remaining = state.lastGeneration?.manualRefreshRemaining;
    final providerConfig = ref.watch(providersProvider).value;
    // Until the provider list is known, do not block model-backed sources.
    final hasProviders = providerConfig == null || ((providerConfig['providers'] as List?)?.isNotEmpty ?? false);
    final needsInterests = knowledge.sources.contains(KnowledgeSource.interest) && knowledge.interests.isEmpty;
    final todayRandom = state.randomKnowledge;
    if (!_professionSeeded && state.loaded) {
      _professionSeeded = true;
      _professionCtrl.text = knowledge.profession;
    }

    Widget gated(Widget child, {bool on = true}) => IgnorePointer(
      ignoring: !on,
      child: AnimatedOpacity(
        duration: const Duration(milliseconds: 160),
        opacity: on ? 1 : 0.5,
        child: child,
      ),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_feedback != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: p.indigo.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(_feedback!, style: TextStyle(fontSize: 12.5, color: p.indigo)),
            ),
          ),
        IosSection(
          header: '每日推荐',
          footer: '开启后每天生成一次,会消耗一次模型调用(约 2–4k tokens)。关闭后已生成内容会立即从对话页移除。',
          children: [
            _SwitchRow(
              icon: CupertinoIcons.lightbulb_fill,
              iconColor: iosPurple,
              title: '开启每日推荐',
              subtitle: '在对话空态展示基于你的会话和应用生成的卡片',
              value: enabled,
              onChanged: (value) => unawaited(_notifier.setEnabled(value)),
            ),
          ],
        ),
        const SizedBox(height: 14),
        gated(
          on: enabled,
          IosSection(
            header: '推荐类型 · 已选 ${prefs.types.length} 项',
            footer: '至少选择一项。生成结果严格限定在勾选的类型内,不会出现其他类型。',
            children: [
              for (final type in SuggestionType.values)
                _TypeRow(
                  copy: suggestionTypeCopy[type]!,
                  selected: prefs.types.contains(type),
                  onTap: () => _toggleType(prefs, type),
                ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        gated(
          on: enabled,
          IosSection(
            header: '每类条数',
            footer: '每种类型生成的条数,展示总数不超过 9 张卡片。',
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                child: SizedBox(
                  width: double.infinity,
                  child: CupertinoSlidingSegmentedControl<int>(
                    groupValue: prefs.countPerType,
                    children: {
                      for (final count in DailySuggestionPreferences.countOptions)
                        count: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 4),
                          child: Text('$count', style: TextStyle(fontSize: 14, color: p.ink)),
                        ),
                    },
                    onValueChanged: (value) {
                      if (value != null) unawaited(_update(prefs.copyWith(countPerType: value)));
                    },
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        gated(
          on: prefs.needsModel,
          IosSection(
            header: '生成时机',
            footer: '首次打开模式在每天第一次启动应用时生成;定时模式在指定时间生成,若当时未运行则下次启动补生成。',
            children: [
              _CheckRow(
                title: '每天首次打开时',
                selected: prefs.trigger.kind == DailySuggestionTriggerKind.firstOpen,
                onTap: () => unawaited(
                  _update(prefs.copyWith(trigger: const DailySuggestionTrigger.firstOpen())),
                ),
              ),
              _CheckRow(
                title: '每天固定时间',
                selected: prefs.trigger.kind == DailySuggestionTriggerKind.time,
                trailing: prefs.trigger.kind == DailySuggestionTriggerKind.time
                    ? CupertinoButton(
                        padding: EdgeInsets.zero,
                        minimumSize: const Size(0, 0),
                        onPressed: () => _pickTime(prefs),
                        child: Text(prefs.trigger.timeOfDay, style: TextStyle(fontSize: 15, color: p.indigo)),
                      )
                    : null,
                onTap: () async {
                  if (prefs.trigger.kind != DailySuggestionTriggerKind.time) {
                    await _update(prefs.copyWith(trigger: const DailySuggestionTrigger.time('09:00')));
                  }
                  if (!mounted) return;
                  await _pickTime(ref.read(dailySuggestionsProvider).preferences);
                },
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        gated(
          on: prefs.needsModel,
          IosSection(
            header: '使用模型',
            footer: '可以选一个更便宜的模型专门用于生成推荐,默认跟随当前对话模型。',
            children: [
              IosRow(
                icon: CupertinoIcons.cloud_fill,
                iconColor: iosIndigo,
                title: '模型',
                subtitle: _modelLabel(prefs),
                trailing: Icon(CupertinoIcons.chevron_forward, size: 14, color: p.ink2),
                onTap: () => _pickModel(prefs),
              ),
              if (prefs.providerId != null)
                IosRow(
                  icon: CupertinoIcons.arrow_counterclockwise,
                  iconColor: p.ink3,
                  title: '恢复为跟随默认',
                  onTap: () => unawaited(_update(prefs.copyWith(providerId: null, modelId: null))),
                ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        gated(
          on: prefs.needsModel,
          IosSection(
            header: '上下文范围',
            footer: '控制哪些信息会发送给模型。未勾选的内容不会被读取。',
            children: [
              _SwitchRow(
                icon: CupertinoIcons.square_grid_2x2_fill,
                iconColor: iosBlue,
                title: '轻应用列表',
                subtitle: '仅应用名称,不包含代码',
                value: prefs.context.lightApps,
                onChanged: (value) =>
                    unawaited(_update(prefs.copyWith(context: prefs.context.copyWith(lightApps: value)))),
              ),
              _SwitchRow(
                icon: CupertinoIcons.chat_bubble_2_fill,
                iconColor: iosTeal,
                title: '会话标题',
                subtitle: '最近 20 条会话的标题,不包含消息内容',
                value: prefs.context.conversationTitles,
                onChanged: (value) => unawaited(
                  _update(prefs.copyWith(context: prefs.context.copyWith(conversationTitles: value))),
                ),
              ),
              _SwitchRow(
                icon: CupertinoIcons.doc_text_fill,
                iconColor: iosOrange,
                title: '已导入文档',
                subtitle: '文档文件名与类型,不包含正文。默认关闭',
                value: prefs.context.documents,
                onChanged: (value) =>
                    unawaited(_update(prefs.copyWith(context: prefs.context.copyWith(documents: value)))),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        gated(
          on: prefs.needsModel,
          IosSection(
            header: '生成状态',
            footer: state.lastGeneration == null
                ? null
                : '今天还可以手动生成 ${remaining ?? 0}/$dailySuggestionManualRefreshLimit 次',
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _statusLabel(state),
                      style: TextStyle(
                        fontSize: 13,
                        height: 1.5,
                        color: state.lastGeneration?.status == 'failed' ? iosRed : p.ink2,
                      ),
                    ),
                    const SizedBox(height: 10),
                    SizedBox(
                      width: double.infinity,
                      child: CupertinoButton.filled(
                        padding: const EdgeInsets.symmetric(vertical: 10),
                        onPressed: !prefs.needsModel || generating || remaining == 0 ? null : _generateNow,
                        child: Text(generating ? '生成中…' : '立即生成'),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),

        // 知识探索:独立于每日推荐的开关,因为随机知识不需要模型。
        const SizedBox(height: 24),
        IosSection(
          header: '知识探索',
          footer: '每天在对话页放几张能引起好奇的知识卡片,点开就能和 AI 聊起来。随机知识用本地题库,不依赖模型;配置模型后题库会自动补充,其余来源需要模型服务。',
          children: [
            _SwitchRow(
              icon: CupertinoIcons.sparkles,
              iconColor: iosOrange,
              title: '开启知识探索',
              subtitle: '在对话空态展示今日知识卡片',
              value: knowledgeEnabled,
              onChanged: (value) => unawaited(_updateKnowledge(knowledge.copyWith(enabled: value))),
            ),
          ],
        ),
        if (todayRandom != null) ...[
          const SizedBox(height: 14),
          gated(
            on: knowledgeEnabled,
            _TodayRandomCard(
              item: todayRandom,
              remaining: state.knowledgeShuffleRemaining,
              shuffling: _shuffling,
              onShuffle: _shuffle,
            ),
          ),
        ],
        // 随机题库:内置题冷启动,配置模型后由模型补充。
        const SizedBox(height: 14),
        gated(
          on: knowledgeEnabled,
          IosSection(
            header: '随机题库',
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '内置 ${state.knowledgePool.builtin} 条,模型补充 ${state.knowledgePool.generated} 条,'
                      '其中 ${state.knowledgePool.unseen} 条近 30 天没出现过',
                      style: TextStyle(fontSize: 13, height: 1.5, color: p.ink2),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      _poolStatusLabel(state.knowledgePool, hasProviders: hasProviders),
                      style: TextStyle(
                        fontSize: 13,
                        height: 1.5,
                        color: state.knowledgePool.lastReplenishError != null ? iosRed : p.ink2,
                      ),
                    ),
                    const SizedBox(height: 10),
                    SizedBox(
                      width: double.infinity,
                      child: CupertinoButton.filled(
                        padding: const EdgeInsets.symmetric(vertical: 10),
                        onPressed: !knowledgeEnabled ||
                                !knowledge.sources.contains(KnowledgeSource.random) ||
                                !hasProviders ||
                                _replenishing ||
                                state.knowledgePool.replenishing
                            ? null
                            : _replenishPool,
                        child: Text(_replenishing || state.knowledgePool.replenishing ? '补充中…' : '补充题库'),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        gated(
          on: knowledgeEnabled,
          IosSection(
            header: '知识来源 · 已选 ${knowledge.sources.length} 项',
            footer: hasProviders
                ? '至少保留一项。跨学科、工作领域、我想学的三种来源会在每日推荐生成时一并请求模型。'
                : '还没有配置模型服务,需要模型的来源暂不可选。',
            children: [
              for (final source in KnowledgeSource.values)
                _SourceRow(
                  source: source,
                  selected: knowledge.sources.contains(source),
                  enabled: !source.needsModel || hasProviders || knowledge.sources.contains(source),
                  onTap: () => _toggleSource(knowledge, source),
                ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        gated(
          on: knowledgeEnabled,
          IosSection(
            header: '我想学的主题',
            footer: needsInterests
                ? '勾选了「我想学的」,填几个主题才能生成。'
                : '最多 $knowledgeMaxInterests 条,回车添加。「我想学的」来源会严格围绕这些主题。',
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (knowledge.interests.isNotEmpty) ...[
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          for (final interest in knowledge.interests)
                            _InterestChip(label: interest, onRemove: () => _removeInterest(knowledge, interest)),
                        ],
                      ),
                      const SizedBox(height: 10),
                    ],
                    CupertinoTextField(
                      controller: _interestCtrl,
                      placeholder: '例如:天文学、经济史、认知心理学',
                      placeholderStyle: TextStyle(fontSize: 14, color: p.ink3),
                      style: TextStyle(fontSize: 14, color: p.ink),
                      maxLength: knowledgeInterestMaxLength,
                      textInputAction: TextInputAction.done,
                      onSubmitted: (_) => _addInterest(knowledge),
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                      decoration: BoxDecoration(
                        color: p.groupedBg,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: p.separator),
                      ),
                      suffix: CupertinoButton(
                        padding: const EdgeInsets.symmetric(horizontal: 10),
                        minimumSize: const Size(0, 0),
                        onPressed: () => _addInterest(knowledge),
                        child: Text('添加', style: TextStyle(fontSize: 13, color: p.indigo)),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        gated(
          on: knowledgeEnabled,
          IosSection(
            header: '职业 / 领域',
            footer: '可选。帮助模型判断什么算「跨学科」、什么算「工作领域」。',
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                child: CupertinoTextField(
                  controller: _professionCtrl,
                  focusNode: _professionFocus,
                  placeholder: '例如:独立开发者,主要做 SaaS 后台',
                  placeholderStyle: TextStyle(fontSize: 14, color: p.ink3),
                  style: TextStyle(fontSize: 14, color: p.ink),
                  maxLength: knowledgeProfessionMaxLength,
                  textInputAction: TextInputAction.done,
                  onSubmitted: (_) => _commitProfession(),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                  decoration: BoxDecoration(
                    color: p.groupedBg,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: p.separator),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        gated(
          on: knowledgeEnabled,
          IosSection(
            header: '每来源条数',
            footer: '只对需要模型的来源生效,随机知识固定 1 条。开启需要模型的来源后,「我想学的主题」和「职业 / 领域」会随轻应用列表、会话标题一起发送给模型。',
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                child: SizedBox(
                  width: double.infinity,
                  child: CupertinoSlidingSegmentedControl<int>(
                    groupValue: knowledge.countPerSource,
                    children: {
                      for (final count in const [1, 2])
                        count: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 4),
                          child: Text('$count', style: TextStyle(fontSize: 14, color: p.ink)),
                        ),
                    },
                    onValueChanged: (value) {
                      if (value != null) unawaited(_updateKnowledge(knowledge.copyWith(countPerSource: value)));
                    },
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// 设置页里的「今日随机知识」预览:配置时就能感受到效果,也能直接「换一个」。
class _TodayRandomCard extends StatelessWidget {
  const _TodayRandomCard({
    required this.item,
    required this.remaining,
    required this.shuffling,
    required this.onShuffle,
  });

  final WorkSuggestion item;
  final int remaining;
  final bool shuffling;
  final Future<void> Function() onShuffle;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    const amber = Color(0xFFF59E0B);
    final amberInk = p.isDark ? const Color(0xFFFBBF24) : const Color(0xFFB45309);
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
      decoration: BoxDecoration(
        color: Color.alphaBlend(amber.withValues(alpha: 0.08), p.cardBg),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: amber.withValues(alpha: 0.4)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '今日随机知识 · ${item.knowledge?.disciplineLabel ?? ''}',
                  style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: amberInk),
                ),
                const SizedBox(height: 5),
                Text(item.title, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, height: 1.3, color: p.ink)),
                const SizedBox(height: 3),
                Text(item.description, style: TextStyle(fontSize: 12.5, height: 1.4, color: p.ink2)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          CupertinoButton(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            minimumSize: const Size(0, 0),
            onPressed: remaining > 0 && !shuffling ? () => unawaited(onShuffle()) : null,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  CupertinoIcons.arrow_2_circlepath,
                  size: 18,
                  color: remaining > 0 ? p.indigo : p.ink3,
                ),
                const SizedBox(height: 2),
                Text(
                  remaining > 0 ? '换一个 $remaining' : '明天见',
                  style: TextStyle(fontSize: 10.5, color: remaining > 0 ? p.indigo : p.ink3),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// 知识来源行:勾选框 + 名称 + 说明 + 是否需要模型。
class _SourceRow extends StatelessWidget {
  const _SourceRow({
    required this.source,
    required this.selected,
    required this.enabled,
    required this.onTap,
  });

  final KnowledgeSource source;
  final bool selected;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return CupertinoButton(
      padding: EdgeInsets.zero,
      minimumSize: const Size(0, 0),
      onPressed: enabled ? onTap : null,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 22,
              height: 22,
              margin: const EdgeInsets.only(top: 1),
              decoration: BoxDecoration(
                color: selected ? p.indigo : const Color(0x00000000),
                borderRadius: BorderRadius.circular(7),
                border: Border.all(color: selected ? p.indigo : p.separator, width: 1.2),
              ),
              child: selected
                  ? const Icon(CupertinoIcons.checkmark, size: 13, color: Color(0xFFFFFFFF))
                  : null,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(source.label, style: TextStyle(fontSize: 15, letterSpacing: -0.2, color: p.ink)),
                  const SizedBox(height: 2),
                  Text(source.description, style: TextStyle(fontSize: 12.5, height: 1.4, color: p.ink2)),
                  const SizedBox(height: 2),
                  Text(source.needsModel ? '需要模型' : '不需要模型', style: TextStyle(fontSize: 11.5, color: p.ink3)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _InterestChip extends StatelessWidget {
  const _InterestChip({required this.label, required this.onRemove});

  final String label;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return Container(
      padding: const EdgeInsets.only(left: 10, right: 4, top: 3, bottom: 3),
      decoration: BoxDecoration(
        color: p.indigo.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(99),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(label, style: TextStyle(fontSize: 12.5, color: p.indigo)),
          const SizedBox(width: 2),
          CupertinoButton(
            padding: const EdgeInsets.all(3),
            minimumSize: const Size(0, 0),
            onPressed: onRemove,
            child: Icon(CupertinoIcons.xmark, size: 11, color: p.indigo),
          ),
        ],
      ),
    );
  }
}

class _SwitchRow extends StatelessWidget {
  const _SwitchRow({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.value,
    required this.onChanged,
    this.subtitle,
  });

  final IconData icon;
  final Color iconColor;
  final String title;
  final String? subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return IosRow(
      icon: icon,
      iconColor: iconColor,
      title: title,
      subtitle: subtitle,
      trailing: CupertinoSwitch(activeTrackColor: iosGreen, value: value, onChanged: onChanged),
      onTap: () => onChanged(!value),
    );
  }
}

/// 推荐类型行:勾选框 + 标签 + 说明 + 会用到的数据。
class _TypeRow extends StatelessWidget {
  const _TypeRow({required this.copy, required this.selected, required this.onTap});

  final SuggestionTypeCopy copy;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return CupertinoButton(
      padding: EdgeInsets.zero,
      minimumSize: const Size(0, 0),
      onPressed: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 22,
              height: 22,
              margin: const EdgeInsets.only(top: 1),
              decoration: BoxDecoration(
                color: selected ? p.indigo : const Color(0x00000000),
                borderRadius: BorderRadius.circular(7),
                border: Border.all(color: selected ? p.indigo : p.separator, width: 1.2),
              ),
              child: selected
                  ? const Icon(CupertinoIcons.checkmark, size: 13, color: Color(0xFFFFFFFF))
                  : null,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(copy.label, style: TextStyle(fontSize: 15, letterSpacing: -0.2, color: p.ink)),
                  const SizedBox(height: 2),
                  Text(copy.description, style: TextStyle(fontSize: 12.5, height: 1.4, color: p.ink2)),
                  const SizedBox(height: 2),
                  Text('会用到:${copy.uses}', style: TextStyle(fontSize: 11.5, color: p.ink3)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CheckRow extends StatelessWidget {
  const _CheckRow({required this.title, required this.selected, required this.onTap, this.trailing});

  final String title;
  final bool selected;
  final VoidCallback onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return CupertinoButton(
      padding: EdgeInsets.zero,
      minimumSize: const Size(0, 0),
      onPressed: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          children: [
            Expanded(child: Text(title, style: TextStyle(fontSize: 15, color: p.ink))),
            ?trailing,
            if (trailing != null) const SizedBox(width: 10),
            Icon(
              selected ? CupertinoIcons.checkmark_circle_fill : CupertinoIcons.circle,
              size: 20,
              color: selected ? p.indigo : p.ink3,
            ),
          ],
        ),
      ),
    );
  }
}
