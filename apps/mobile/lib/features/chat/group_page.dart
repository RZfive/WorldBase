import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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

  static const _modeLabels = {
    'coordinator_only': '仅协调者',
    'targeted': '定向',
    'discussion': '全员讨论',
    'coordinator_decides': '协调者规划',
    'mentioned_agent_decides': '被@成员自主',
  };

  @override
  void dispose() {
    _inputCtrl.dispose();
    super.dispose();
  }

  Future<void> _createGroup() async {
    await showCupertinoModalPopup<void>(
      context: context,
      builder: (_) => const _CreateGroupSheet(),
    );
  }

  void _send() {
    final text = _inputCtrl.text.trim();
    if (text.isEmpty) return;
    _inputCtrl.clear();
    ref.read(groupChatProvider.notifier).send(text);
  }

  @override
  Widget build(BuildContext context) {
    final controller = ref.watch(groupChatProvider.notifier);
    final session = controller.session;
    final messages = ref.watch(groupChatProvider);

    return IosScreen(
      navBar: IosNavBar(
        leading: IosIconButton(
          icon: CupertinoIcons.chevron_left,
          onPressed: () => Navigator.of(context).pop(),
        ),
        actions: [
          if (session != null)
            IosIconButton(
              icon: CupertinoIcons.square_list,
              onPressed: () => _showBoard(context, controller),
            ),
          IosIconButton(icon: CupertinoIcons.add_circled, onPressed: _createGroup),
        ],
      ),
      child: session == null
          ? Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(CupertinoIcons.person_2_fill, size: 56, color: Color(0xFFC7C7CC)),
                  const SizedBox(height: 12),
                  const Text('创建群组，让多个 Agent 协作讨论',
                      style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, letterSpacing: -0.4)),
                  const SizedBox(height: 16),
                  IosPrimaryButton(label: '新建群组', icon: CupertinoIcons.add, onPressed: _createGroup),
                ],
              ),
            )
          : Column(
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                        decoration: BoxDecoration(
                          color: iosBlue.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Text(_modeLabels[session.mode] ?? session.mode,
                            style: const TextStyle(
                                fontSize: 12, color: iosBlue, fontWeight: FontWeight.w500)),
                      ),
                      const SizedBox(width: 8),
                      Text('协调者: ${session.coordinator ?? '-'}',
                          style: const TextStyle(fontSize: 12, color: iosSecondaryLabel)),
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
                          padding: const EdgeInsets.fromLTRB(0, 6, 0, 6),
                          itemCount: messages.length,
                          itemBuilder: (ctx, i) => IosBubble(
                            text: messages[i].text,
                            isUser: messages[i].role == 'user',
                            isGroup: messages[i].isGroup,
                            member: messages[i].member,
                          ),
                        ),
                ),
                if (controller.busy)
                  CupertinoButton(
                    minSize: 0,
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    onPressed: _injectDialog,
                    child: const Row(mainAxisSize: MainAxisSize.min, children: [
                      Icon(CupertinoIcons.bolt_fill, size: 14, color: iosOrange),
                      SizedBox(width: 4),
                      Text('注入澄清 (HITL)', style: TextStyle(fontSize: 13, color: iosOrange)),
                    ]),
                  ),
                IosChatInputBar(
                  controller: _inputCtrl,
                  onSend: _send,
                  onSubmitted: (_) => _send(),
                  hint: '议题或 @成员…',
                ),
              ],
            ),
    );
  }

  Future<void> _injectDialog() async {
    final ctrl = TextEditingController();
    final content = await showCupertinoDialog<String>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: const Text('注入澄清（HITL）'),
        content: Padding(
          padding: const EdgeInsets.only(top: 10),
          child: CupertinoTextField(controller: ctrl, autofocus: true, placeholder: '你的澄清内容'),
        ),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
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
    List<String> asList(dynamic v) => (v as List?)?.map((e) => e.toString()).toList() ?? [];
    showCupertinoModalPopup<void>(
      context: context,
      builder: (_) => Container(
        height: MediaQuery.of(context).size.height * 0.62,
        decoration: const BoxDecoration(
          color: iosGroupedBg,
          borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
        ),
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
            children: [
              const Text('共享黑板',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, letterSpacing: -0.4)),
              const SizedBox(height: 8),
              IosSection(
                children: [
                  IosRow(
                      icon: CupertinoIcons.flag_fill,
                      iconColor: iosRed,
                      title: '目标',
                      subtitle: board['goal']?.toString() ?? ''),
                ],
              ),
              const SizedBox(height: 10),
              IosSection(
                header: '假设',
                children: asList(board['assumptions'])
                    .map((t) => IosRow(
                        icon: CupertinoIcons.lightbulb_fill, iconColor: iosOrange, title: t))
                    .toList(),
              ),
              const SizedBox(height: 10),
              IosSection(
                header: '任务',
                children: asList(board['tasks'])
                    .map((t) => IosRow(
                        icon: CupertinoIcons.checkmark_circle_fill, iconColor: iosGreen, title: t))
                    .toList(),
              ),
              const SizedBox(height: 10),
              IosSection(
                header: '决策',
                children: asList(board['decisions'])
                    .map((t) => IosRow(
                        icon: CupertinoIcons.checkmark_seal_fill, iconColor: iosBlue, title: t))
                    .toList(),
              ),
              const SizedBox(height: 10),
              IosSection(
                header: '待解问题',
                children: asList(board['openQuestions'])
                    .map((t) => IosRow(
                        icon: CupertinoIcons.question_circle_fill, iconColor: iosPurple, title: t))
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
  Widget build(BuildContext context) {
    return Container(
      constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.85),
      decoration: const BoxDecoration(
        color: iosGroupedBg,
        borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
      ),
      child: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('新建群组',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, letterSpacing: -0.4)),
              const SizedBox(height: 12),
              CupertinoTextField(
                controller: _topicCtrl,
                placeholder: '讨论主题',
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: iosCardBg,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: iosSeparator),
                ),
              ),
              const SizedBox(height: 14),
              const Text('协作模式', style: TextStyle(fontSize: 13, color: iosSecondaryLabel)),
              const SizedBox(height: 6),
              CupertinoSlidingSegmentedControl<String>(
                groupValue: _mode,
                children: {
                  for (final (k, label) in _modes)
                    k: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
                      child: Text(label, style: const TextStyle(fontSize: 12)),
                    ),
                },
                onValueChanged: (v) => setState(() => _mode = v ?? _mode),
              ),
              const SizedBox(height: 14),
              const Text('成员', style: TextStyle(fontSize: 13, color: iosSecondaryLabel)),
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
                              onTap: () => setState(() => _members.remove(m)),
                              child: const Icon(CupertinoIcons.minus_circle_fill,
                                  size: 20, color: iosRed),
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
                      });
                    },
                  ),
                ],
              ),
              const SizedBox(height: 8),
              CupertinoTextField(
                controller: _memberCtrl,
                placeholder: '名字 | 人设',
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: iosCardBg,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: iosSeparator),
                ),
              ),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: CupertinoButton.filled(
                  onPressed: () async {
                    if (_topicCtrl.text.trim().isEmpty) return;
                    await ref.read(groupChatProvider.notifier).createAndOpen(
                          topic: _topicCtrl.text.trim(),
                          mode: _mode,
                          members: _members,
                        );
                    if (context.mounted) Navigator.pop(context);
                  },
                  child: const Text('创建并进入', style: TextStyle(fontWeight: FontWeight.w600)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
