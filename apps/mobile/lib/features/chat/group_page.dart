import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/glass.dart';
import '../../core/ios_ui.dart';
import '../../core/providers.dart';

/// 群组协作页：创建（5 模式 + 成员编辑）→ 讨论 → 黑板 → HITL 注入（iOS 风格）。
class GroupPage extends ConsumerStatefulWidget {
  const GroupPage({super.key});

  @override
  ConsumerState<GroupPage> createState() => _GroupPageState();
}

class _GroupPageState extends ConsumerState<GroupPage> {
  final _inputCtrl = TextEditingController();
  final _inputFocus = FocusNode();
  final _messageScrollCtrl = ScrollController();
  late final GroupChatController _groupController;
  String? _openingGroupId;
  String? _catalogError;
  int? _mentionStart;
  String _mentionQuery = '';

  static const _modeLabels = {
    'coordinator_only': '仅协调者',
    'targeted': '定向',
    'discussion': '全员讨论',
    'coordinator_decides': '协调者规划',
    'mentioned_agent_decides': '被@成员自主',
  };

  @override
  void initState() {
    super.initState();
    _groupController = ref.read(groupChatProvider.notifier);
    _inputCtrl.addListener(_updateMentionState);
    Future.microtask(() {
      ref.read(agentsProvider.notifier).refresh();
      ref.read(agentGroupsProvider.notifier).refresh();
    });
  }

  @override
  void dispose() {
    _inputCtrl.removeListener(_updateMentionState);
    _inputCtrl.dispose();
    _inputFocus.dispose();
    _messageScrollCtrl.dispose();
    super.dispose();
  }

  void _scrollToLatestMessage() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_messageScrollCtrl.hasClients) return;
      _messageScrollCtrl.animateTo(
        _messageScrollCtrl.position.maxScrollExtent,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    });
  }

  Future<void> _createGroup() async {
    await showCupertinoModalPopup<void>(
      context: context,
      builder: (_) => const _CreateGroupSheet(),
    );
  }

  Future<void> _openSavedGroup(
    AgentGroupDefinition group,
    List<AgentDefinition> agents,
  ) async {
    if (_openingGroupId != null) return;
    setState(() {
      _openingGroupId = group.id;
      _catalogError = null;
    });
    try {
      await ref.read(groupChatProvider.notifier).openAgentGroup(group, agents);
    } catch (error) {
      if (mounted) setState(() => _catalogError = '$error');
    } finally {
      if (mounted) setState(() => _openingGroupId = null);
    }
  }

  Future<void> _backToGroupList() async {
    await ref.read(groupChatProvider.notifier).close();
  }

  Future<void> _exitGroupPage() async {
    await ref.read(groupChatProvider.notifier).close();
    if (mounted) Navigator.of(context).pop();
  }

  Future<void> _send() async {
    final text = _inputCtrl.text.trim();
    final controller = ref.read(groupChatProvider.notifier);
    if (text.isEmpty || controller.busy) return;
    final sent = await controller.send(text);
    if (sent) _inputCtrl.clear();
    if (mounted) _inputFocus.requestFocus();
  }

  void _updateMentionState() {
    final text = _inputCtrl.text;
    final selection = _inputCtrl.selection;
    final cursor = selection.isValid
        ? selection.baseOffset.clamp(0, text.length)
        : text.length;
    final prefix = text.substring(0, cursor);
    final match = RegExp(r'(^|[\s,，。.!！？;；:：])@([^\s@]*)$').firstMatch(prefix);
    final start = match == null ? null : prefix.lastIndexOf('@');
    final query = match?.group(2) ?? '';
    if (_mentionStart == start && _mentionQuery == query) return;
    if (!mounted) return;
    setState(() {
      _mentionStart = start;
      _mentionQuery = query;
    });
  }

  void _showAllMentions() {
    final text = _inputCtrl.text;
    final selection = _inputCtrl.selection;
    final cursor = selection.isValid
        ? selection.baseOffset.clamp(0, text.length)
        : text.length;
    final needsSpace = cursor > 0 && !RegExp(r'\s').hasMatch(text[cursor - 1]);
    final inserted = '${needsSpace ? ' ' : ''}@';
    _inputCtrl.value = TextEditingValue(
      text: text.replaceRange(cursor, cursor, inserted),
      selection: TextSelection.collapsed(offset: cursor + inserted.length),
    );
    _inputFocus.requestFocus();
  }

  void _insertMention(String name) {
    final text = _inputCtrl.text;
    final selection = _inputCtrl.selection;
    final cursor = selection.isValid
        ? selection.baseOffset.clamp(0, text.length)
        : text.length;
    final start = _mentionStart ?? cursor;
    final mention = '@$name ';
    _inputCtrl.value = TextEditingValue(
      text: text.replaceRange(start, cursor, mention),
      selection: TextSelection.collapsed(offset: start + mention.length),
    );
    _inputFocus.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<List<UiMessage>>(
      groupChatProvider,
      (_, _) => _scrollToLatestMessage(),
    );
    final controller = ref.watch(groupChatProvider.notifier);
    final session = controller.session;
    final messages = ref.watch(groupChatProvider);
    final p = DawnPalette.of(context);

    return PopScope(
      onPopInvokedWithResult: (didPop, _) {
        if (didPop && _groupController.session != null) {
          unawaited(_groupController.close());
        }
      },
      child: IosScreen(
        navBar: IosNavBar(
          leading: IosIconButton(
            icon: CupertinoIcons.chevron_left,
            onPressed: _exitGroupPage,
          ),
          actions: [
            if (session != null)
              IosIconButton(
                icon: CupertinoIcons.person_2_fill,
                onPressed: _backToGroupList,
              ),
            if (session != null)
              IosIconButton(
                icon: CupertinoIcons.square_list,
                onPressed: () => _showBoard(context, controller),
              ),
            IosIconButton(
              icon: CupertinoIcons.add_circled,
              onPressed: _createGroup,
            ),
          ],
        ),
        child: session == null
            ? _buildGroupCatalog(p)
            : Column(
                children: [
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 4,
                    ),
                    child: Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 4,
                          ),
                          decoration: BoxDecoration(
                            color: iosBlue.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: Text(
                            _modeLabels[session.mode] ?? session.mode,
                            style: const TextStyle(
                              fontSize: 12,
                              color: iosBlue,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          '协调者: ${session.coordinator ?? '-'}',
                          style: TextStyle(fontSize: 12, color: p.ink2),
                        ),
                      ],
                    ),
                  ),
                  Expanded(
                    child: messages.isEmpty
                        ? const IosEmptyHint(
                            icon: CupertinoIcons.text_bubble,
                            title: '开始讨论',
                            subtitle: '输入议题；@成员名 定向发言',
                          )
                        : ListView.builder(
                            controller: _messageScrollCtrl,
                            padding: const EdgeInsets.fromLTRB(0, 6, 0, 6),
                            itemCount: messages.length,
                            itemBuilder: (ctx, i) => IosBubble(
                              text: messages[i].text,
                              isUser: messages[i].role == 'user',
                              isStreaming: messages[i].streaming,
                              isGroup: messages[i].isGroup,
                              member: messages[i].member,
                            ),
                          ),
                  ),
                  if (controller.busy)
                    CupertinoButton(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      onPressed: _injectDialog,
                      minimumSize: Size(0, 0),
                      child: const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            CupertinoIcons.bolt_fill,
                            size: 14,
                            color: iosOrange,
                          ),
                          SizedBox(width: 4),
                          Text(
                            '注入澄清 (HITL)',
                            style: TextStyle(fontSize: 13, color: iosOrange),
                          ),
                        ],
                      ),
                    ),
                  if (_mentionStart != null)
                    _buildMentionSuggestions(session, p),
                  IosChatInputBar(
                    controller: _inputCtrl,
                    focusNode: _inputFocus,
                    leading: CupertinoButton(
                      padding: EdgeInsets.zero,
                      minimumSize: const Size(32, 32),
                      onPressed: _showAllMentions,
                      child: const Icon(CupertinoIcons.at, size: 21),
                    ),
                    onSend: () => _send(),
                    onSubmitted: (_) => _send(),
                    sendEnabled: !controller.busy,
                    hint: '议题或 @成员…',
                  ),
                ],
              ),
      ),
    );
  }

  Widget _buildMentionSuggestions(GroupSession session, DawnPalette p) {
    final query = _mentionQuery.toLowerCase();
    final members = session.memberNames
        .where(
          (name) =>
              name.isNotEmpty &&
              (query.isEmpty || name.toLowerCase().contains(query)),
        )
        .toList();
    if (members.isEmpty) return const SizedBox.shrink();
    return Container(
      height: 44,
      decoration: BoxDecoration(
        color: p.groupedBg,
        border: Border(top: BorderSide(color: p.separator, width: 0.5)),
      ),
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        itemCount: members.length,
        separatorBuilder: (_, _) => const SizedBox(width: 6),
        itemBuilder: (_, index) => CupertinoButton(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          minimumSize: const Size(0, 32),
          color: p.cardBg,
          borderRadius: BorderRadius.circular(8),
          onPressed: () => _insertMention(members[index]),
          child: Text(
            '@${members[index]}',
            style: TextStyle(fontSize: 13, color: p.indigo),
          ),
        ),
      ),
    );
  }

  Widget _buildGroupCatalog(DawnPalette p) {
    return ref
        .watch(agentGroupsProvider)
        .when(
          loading: () => const Center(child: CupertinoActivityIndicator()),
          error: (error, _) => Center(
            child: IosEmptyHint(
              icon: CupertinoIcons.exclamationmark_circle,
              title: '群聊加载失败',
              subtitle: '$error',
            ),
          ),
          data: (groups) {
            if (groups.isEmpty) {
              return Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(
                      CupertinoIcons.person_2_fill,
                      size: 56,
                      color: Color(0xFFC7C7CC),
                    ),
                    const SizedBox(height: 12),
                    const Text(
                      '还没有群聊',
                      style: TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      '新建群组，或在对话中让 AI 创建',
                      style: TextStyle(fontSize: 13, color: p.ink2),
                    ),
                    const SizedBox(height: 16),
                    IosPrimaryButton(
                      label: '新建群组',
                      icon: CupertinoIcons.add,
                      onPressed: _createGroup,
                    ),
                  ],
                ),
              );
            }
            return ref
                .watch(agentsProvider)
                .when(
                  loading: () =>
                      const Center(child: CupertinoActivityIndicator()),
                  error: (error, _) => Center(
                    child: IosEmptyHint(
                      icon: CupertinoIcons.exclamationmark_circle,
                      title: 'Agent 加载失败',
                      subtitle: '$error',
                    ),
                  ),
                  data: (agents) {
                    final agentsById = {
                      for (final agent in agents) agent.id: agent,
                    };
                    return ListView(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
                      children: [
                        const Text(
                          '群聊',
                          style: TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '选择群组进入协作会话',
                          style: TextStyle(fontSize: 13, color: p.ink2),
                        ),
                        if (_catalogError != null) ...[
                          const SizedBox(height: 10),
                          Text(
                            _catalogError!,
                            style: const TextStyle(fontSize: 13, color: iosRed),
                          ),
                        ],
                        const SizedBox(height: 12),
                        IosSection(
                          children: [
                            for (final group in groups)
                              IosRow(
                                icon: CupertinoIcons.person_2_fill,
                                iconColor: iosIndigo,
                                title:
                                    '${group.icon.isEmpty ? '👥' : group.icon} ${group.name}',
                                subtitle: _groupSubtitle(group, agentsById),
                                trailing: _openingGroupId == group.id
                                    ? const CupertinoActivityIndicator(
                                        radius: 9,
                                      )
                                    : const Icon(
                                        CupertinoIcons.chevron_right,
                                        size: 15,
                                        color: CupertinoColors.systemGrey2,
                                      ),
                                onTap: () => _openSavedGroup(group, agents),
                              ),
                          ],
                        ),
                      ],
                    );
                  },
                );
          },
        );
  }

  String _groupSubtitle(
    AgentGroupDefinition group,
    Map<String, AgentDefinition> agentsById,
  ) {
    final names = group.memberAgentIds
        .map((id) => agentsById[id]?.name ?? id)
        .where((name) => name.isNotEmpty)
        .join('、');
    return group.description.isNotEmpty
        ? '${group.description} · $names'
        : names;
  }

  Future<void> _injectDialog() async {
    final ctrl = TextEditingController();
    final content = await showCupertinoDialog<String>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: const Text('注入澄清（HITL）'),
        content: Padding(
          padding: const EdgeInsets.only(top: 10),
          child: CupertinoTextField(
            controller: ctrl,
            autofocus: true,
            placeholder: '你的澄清内容',
          ),
        ),
        actions: [
          CupertinoDialogAction(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('取消'),
          ),
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () => Navigator.pop(ctx, ctrl.text),
            child: const Text('注入'),
          ),
        ],
      ),
    );
    if (content != null && content.trim().isNotEmpty) {
      await ref.read(groupChatProvider.notifier).inject(content);
    }
  }

  void _showBoard(BuildContext context, GroupChatController controller) {
    final session = controller.session;
    if (session == null) return;
    final board = session.board;
    List<String> asList(dynamic v) =>
        (v as List?)?.map((e) => e.toString()).toList() ?? [];
    final p = DawnPalette.of(context);
    showCupertinoModalPopup<void>(
      context: context,
      builder: (_) => Container(
        height: MediaQuery.of(context).size.height * 0.62,
        decoration: BoxDecoration(
          color: p.groupedBg,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
        ),
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
            children: [
              const Text(
                '共享黑板',
                style: TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -0.4,
                ),
              ),
              const SizedBox(height: 8),
              IosSection(
                children: [
                  IosRow(
                    icon: CupertinoIcons.flag_fill,
                    iconColor: iosRed,
                    title: '目标',
                    subtitle: board['goal']?.toString() ?? '',
                  ),
                ],
              ),
              const SizedBox(height: 10),
              IosSection(
                header: '假设',
                children: asList(board['assumptions'])
                    .map(
                      (t) => IosRow(
                        icon: CupertinoIcons.lightbulb_fill,
                        iconColor: iosOrange,
                        title: t,
                      ),
                    )
                    .toList(),
              ),
              const SizedBox(height: 10),
              IosSection(
                header: '任务',
                children: asList(board['tasks'])
                    .map(
                      (t) => IosRow(
                        icon: CupertinoIcons.checkmark_circle_fill,
                        iconColor: iosGreen,
                        title: t,
                      ),
                    )
                    .toList(),
              ),
              const SizedBox(height: 10),
              IosSection(
                header: '决策',
                children: asList(board['decisions'])
                    .map(
                      (t) => IosRow(
                        icon: CupertinoIcons.checkmark_seal_fill,
                        iconColor: iosBlue,
                        title: t,
                      ),
                    )
                    .toList(),
              ),
              const SizedBox(height: 10),
              IosSection(
                header: '待解问题',
                children: asList(board['openQuestions'])
                    .map(
                      (t) => IosRow(
                        icon: CupertinoIcons.question_circle_fill,
                        iconColor: iosPurple,
                        title: t,
                      ),
                    )
                    .toList(),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 新建群组表单（iOS 弹层）。
class _CreateGroupSheet extends ConsumerStatefulWidget {
  const _CreateGroupSheet();

  @override
  ConsumerState<_CreateGroupSheet> createState() => _CreateGroupSheetState();
}

class _CreateGroupSheetState extends ConsumerState<_CreateGroupSheet> {
  final _topicCtrl = TextEditingController();
  final _memberCtrl = TextEditingController();
  String _mode = 'discussion';
  final int _maxParallelWorkers = 2;
  bool _creating = false;
  String? _error;
  final List<Map<String, String>> _members = [
    {'name': '协调者', 'persona': '统筹规划，收敛结论'},
    {'name': '工程师', 'persona': '务实落地，关注实现细节'},
  ];

  static const _modes = [
    ('coordinator_only', '仅协调者'),
    ('targeted', '定向'),
    ('discussion', '全员讨论'),
    ('coordinator_decides', '协调者规划'),
    ('mentioned_agent_decides', '被@成员自主'),
  ];

  @override
  void dispose() {
    _topicCtrl.dispose();
    _memberCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return Container(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.of(context).size.height * 0.85,
      ),
      decoration: BoxDecoration(
        color: p.groupedBg,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
      ),
      child: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                '新建群组',
                style: TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -0.4,
                ),
              ),
              const SizedBox(height: 12),
              CupertinoTextField(
                controller: _topicCtrl,
                placeholder: '讨论主题',
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: p.cardBg,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: p.separator),
                ),
              ),
              const SizedBox(height: 14),
              Text('协作模式', style: TextStyle(fontSize: 13, color: p.ink2)),
              const SizedBox(height: 6),
              CupertinoSlidingSegmentedControl<String>(
                groupValue: _mode,
                children: {
                  for (final (k, label) in _modes)
                    k: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 6,
                        vertical: 5,
                      ),
                      child: Text(label, style: const TextStyle(fontSize: 12)),
                    ),
                },
                onValueChanged: (v) => setState(() => _mode = v ?? _mode),
              ),
              const SizedBox(height: 14),
              Text('成员', style: TextStyle(fontSize: 13, color: p.ink2)),
              const SizedBox(height: 6),
              IosSection(
                children: [
                  for (final m in _members)
                    IosRow(
                      icon: CupertinoIcons.person_fill,
                      iconColor: iosIndigo,
                      title: m['name']!,
                      subtitle: m['persona'],
                      trailing: _members.length > 2
                          ? GestureDetector(
                              onTap: () => setState(() {
                                _members.remove(m);
                              }),
                              child: const Icon(
                                CupertinoIcons.minus_circle_fill,
                                size: 20,
                                color: iosRed,
                              ),
                            )
                          : const SizedBox(width: 20),
                    ),
                  IosRow(
                    icon: CupertinoIcons.person_badge_plus,
                    iconColor: iosGreen,
                    title: '添加成员（名字 | 人设，先在下方输入）',
                    onTap: () {
                      final parts = _memberCtrl.text.split('|');
                      final name = parts[0].trim();
                      if (name.isEmpty) return;
                      final persona = parts.length > 1 ? parts[1].trim() : '成员';
                      setState(() {
                        _members.add({'name': name, 'persona': persona});
                        _memberCtrl.clear();
                        _error = null;
                      });
                    },
                  ),
                ],
              ),
              const SizedBox(height: 8),
              CupertinoTextField(
                controller: _memberCtrl,
                placeholder: '名字 | 人设',
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: p.cardBg,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: p.separator),
                ),
              ),
              const SizedBox(height: 14),
              if (_error != null) ...[
                Text(
                  _error!,
                  style: const TextStyle(fontSize: 13, color: iosRed),
                ),
                const SizedBox(height: 8),
              ],
              SizedBox(
                width: double.infinity,
                child: CupertinoButton.filled(
                  onPressed: _creating
                      ? null
                      : () async {
                          final topic = _topicCtrl.text.trim();
                          if (topic.isEmpty || _members.length < 2) {
                            setState(() {
                              _error = topic.isEmpty
                                  ? '请输入讨论主题'
                                  : '群组至少需要两个 Agent';
                            });
                            return;
                          }
                          setState(() {
                            _creating = true;
                            _error = null;
                          });
                          try {
                            await ref
                                .read(groupChatProvider.notifier)
                                .createAndOpen(
                                  topic: topic,
                                  mode: _mode,
                                  members: _members,
                                  maxParallelWorkers: _maxParallelWorkers,
                                );
                            if (context.mounted) Navigator.pop(context);
                          } catch (error) {
                            if (mounted) {
                              setState(() => _error = '创建失败：$error');
                            }
                          } finally {
                            if (mounted) setState(() => _creating = false);
                          }
                        },
                  child: _creating
                      ? const CupertinoActivityIndicator(
                          color: CupertinoColors.white,
                        )
                      : const Text(
                          '创建并进入',
                          style: TextStyle(fontWeight: FontWeight.w600),
                        ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
