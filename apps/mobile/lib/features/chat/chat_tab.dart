import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart' show Scaffold;
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/ios_ui.dart';
import '../../core/providers.dart';
import '../common/model_picker.dart';
import 'group_page.dart';

/// 对话 Tab：会话抽屉 + 流式对话 + 分叉/编辑 + Agent/群组入口（iOS 风格）。
class ChatTab extends ConsumerStatefulWidget {
  const ChatTab({super.key});

  @override
  ConsumerState<ChatTab> createState() => _ChatTabState();
}

class _ChatTabState extends ConsumerState<ChatTab> {
  final _inputCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    Future.microtask(() async {
      final conversations = ref.read(conversationsProvider).value;
      final current = ref.read(currentConversationProvider);
      if (current == null && conversations != null && conversations.isNotEmpty) {
        ref.read(currentConversationProvider.notifier).set(conversations.first);
        await ref.read(chatProvider.notifier).loadHistory(conversations.first);
      }
    });
  }

  @override
  void dispose() {
    _inputCtrl.dispose();
    super.dispose();
  }

  void _send() {
    final text = _inputCtrl.text.trim();
    if (text.isEmpty) return;
    _inputCtrl.clear();
    ref.read(chatProvider.notifier).send(text);
  }

  Future<void> _newConversation() async {
    final agents = ref.read(agentsProvider).value ?? [];
    AgentDefinition? picked;
    if (agents.isNotEmpty) {
      picked = await showCupertinoModalPopup<AgentDefinition>(
        context: context,
        builder: (ctx) => _AgentPickerSheet(agents: agents),
      );
    }
    ref.read(selectedAgentProvider.notifier).set(picked);
    ref.read(currentConversationProvider.notifier).set(null);
    ref.read(chatProvider.notifier).clear();
  }

  void _openGroups() {
    Navigator.of(context).push(cupertinoRoute(const GroupPage()));
  }

  @override
  Widget build(BuildContext context) {
    final messages = ref.watch(chatProvider);

    return Scaffold(
      backgroundColor: iosGroupedBg,
      drawer: const _ConversationDrawer(),
      body: Column(
        children: [
          SafeArea(
            bottom: false,
            child: IosNavBar(
              leading: Builder(
                builder: (ctx) => IosIconButton(
                  icon: CupertinoIcons.sidebar_left,
                  onPressed: () => Scaffold.of(ctx).openDrawer(),
                ),
              ),
              actions: [
                IosIconButton(icon: CupertinoIcons.person_2, onPressed: _openGroups),
                IosIconButton(icon: CupertinoIcons.square_pencil, onPressed: _newConversation),
              ],
            ),
          ),
          Expanded(
            child: messages.isEmpty
                ? const IosEmptyHint(
                    icon: CupertinoIcons.chat_bubble,
                    title: '开始新对话',
                    subtitle: '流式回复 · 工具调用 · 分叉编辑 · 群组协作',
                  )
                : ListView.builder(
                    padding: const EdgeInsets.fromLTRB(0, 8, 0, 8),
                    itemCount: messages.length,
                    itemBuilder: (ctx, i) {
                      final m = messages[i];
                      if (m.isTool) {
                        return IosToolCard(name: m.toolName ?? '', text: m.text, isError: m.isError);
                      }
                      return IosBubble(
                        text: m.text,
                        isUser: m.role == 'user',
                        isStreaming: m.streaming,
                        onLongPress:
                            m.role == 'user' && m.dbId > 0 ? () => _showMessageActions(m) : null,
                      );
                    },
                  ),
          ),
          // 供应商/模型快速切换
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 2, 12, 2),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Consumer(builder: (context, watchRef, _) {
                final target = watchRef.watch(chatTargetProvider);
                return ModelPickerChip(
                  label: target.label,
                  onTap: () => showModelPickerSheet(
                    context,
                    title: '选择模型',
                    selectedProviderId: target.providerId,
                    selectedModel: target.model,
                    onSelected: (pid, model, pname) => watchRef
                        .read(chatTargetProvider.notifier)
                        .set(ChatTarget(providerId: pid, model: model, providerName: pname)),
                  ),
                );
              }),
            ),
          ),
          if (ref.watch(chatProvider.notifier).busy)
            CupertinoButton(
              minSize: 0,
              padding: const EdgeInsets.symmetric(vertical: 4),
              onPressed: () => ref.read(chatProvider.notifier).abort(),
              child: const Text('■ 停止', style: TextStyle(fontSize: 13, color: iosRed)),
            ),
          IosChatInputBar(
            controller: _inputCtrl,
            onSend: _send,
            onSubmitted: (_) => _send(),
            hint: '信息',
          ),
        ],
      ),
    );
  }

  void _showMessageActions(UiMessage message) {
    final conversation = ref.read(currentConversationProvider);
    if (conversation == null) return;
    showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        title: Text(message.text,
            maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
        actions: [
          CupertinoActionSheetAction(
            onPressed: () {
              Navigator.pop(ctx);
              Clipboard.setData(ClipboardData(text: message.text));
            },
            child: const Text('复制'),
          ),
          CupertinoActionSheetAction(
            onPressed: () => _editAndResend(ctx, conversation, message, 'fork'),
            child: const Text('编辑并重发（分叉）'),
          ),
          CupertinoActionSheetAction(
            isDestructiveAction: true,
            onPressed: () => _editAndResend(ctx, conversation, message, 'inplace'),
            child: const Text('编辑并重发（就地覆盖）'),
          ),
          CupertinoActionSheetAction(
            onPressed: () async {
              Navigator.pop(ctx);
              final result = await HarnessClient.instance
                  .forkConversation(conversation.id, message.dbId, mode: 'fork');
              final newId = result['conversationId'] as String;
              final conversations = await HarnessClient.instance.listConversations();
              final newConv = conversations.firstWhere((c) => c.id == newId);
              ref.read(currentConversationProvider.notifier).set(newConv);
              await ref.read(chatProvider.notifier).loadHistory(newConv);
              ref.read(conversationsProvider.notifier).refresh();
            },
            child: const Text('从此消息分叉'),
          ),
        ],
        cancelButton: CupertinoActionSheetAction(
          onPressed: () => Navigator.pop(ctx),
          child: const Text('取消'),
        ),
      ),
    );
  }

  Future<void> _editAndResend(
      BuildContext ctx, ConversationMeta conversation, UiMessage message, String mode) async {
    final ctrl = TextEditingController(text: message.text);
    final newText = await showCupertinoDialog<String>(
      context: ctx,
      builder: (dctx) => CupertinoAlertDialog(
        title: Text(mode == 'inplace' ? '编辑重发（就地）' : '编辑重发（分叉）'),
        content: Padding(
          padding: const EdgeInsets.only(top: 10),
          child: CupertinoTextField(controller: ctrl, maxLines: 4, autofocus: true),
        ),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.pop(dctx), child: const Text('取消')),
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () => Navigator.pop(dctx, ctrl.text),
            child: const Text('发送'),
          ),
        ],
      ),
    );
    if (newText == null || newText.trim().isEmpty || !ctx.mounted) return;
    Navigator.pop(ctx);

    final result = await HarnessClient.instance
        .forkConversation(conversation.id, message.dbId, newText: newText, mode: mode);
    final targetId = result['conversationId'] as String;
    final conversations = await HarnessClient.instance.listConversations();
    final target = conversations.firstWhere((c) => c.id == targetId);
    ref.read(currentConversationProvider.notifier).set(target);
    await ref.read(chatProvider.notifier).loadHistory(target);
    ref.read(conversationsProvider.notifier).refresh();
    await ref.read(chatProvider.notifier).send(newText);
  }
}

/// Agent 选择弹层。
class _AgentPickerSheet extends StatelessWidget {
  const _AgentPickerSheet({required this.agents});

  final List<AgentDefinition> agents;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: iosGroupedBg,
        borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
      ),
      child: SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 14, 20, 6),
              child: Text('选择 Agent（新会话）',
                  style: TextStyle(fontSize: 13, color: iosSecondaryLabel)),
            ),
            IosSection(
              children: [
                IosRow(
                  icon: CupertinoIcons.sparkles,
                  iconColor: iosBlue,
                  title: '默认助手',
                  onTap: () => Navigator.pop(context),
                ),
                for (final a in agents)
                  IosRow(
                    icon: CupertinoIcons.person_crop_circle,
                    iconColor: iosIndigo,
                    title: '${a.icon.isEmpty ? '🤖' : a.icon} ${a.name}',
                    subtitle: a.description,
                    onTap: () => Navigator.pop(context, a),
                  ),
              ],
            ),
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }
}

/// 会话抽屉（iOS 风格）。
class _ConversationDrawer extends ConsumerStatefulWidget {
  const _ConversationDrawer();

  @override
  ConsumerState<_ConversationDrawer> createState() => _ConversationDrawerState();
}

class _ConversationDrawerState extends ConsumerState<_ConversationDrawer> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final conversations = ref.watch(conversationsProvider);
    return IosDrawer(
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 14, 20, 4),
              child: Text('会话',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, letterSpacing: -0.4)),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
              child: CupertinoSearchTextField(
                placeholder: '搜索',
                onChanged: (v) => setState(() => _query = v),
              ),
            ),
            Expanded(
              child: conversations.when(
                data: (list) {
                  final filtered = _query.isEmpty
                      ? list
                      : list
                          .where((c) => c.title.toLowerCase().contains(_query.toLowerCase()))
                          .toList();
                  if (filtered.isEmpty) {
                    return const Center(
                        child: Text('暂无会话', style: TextStyle(color: iosSecondaryLabel)));
                  }
                  return ListView.builder(
                    padding: const EdgeInsets.only(bottom: 16),
                    itemCount: filtered.length,
                    itemBuilder: (ctx, i) {
                      final c = filtered[i];
                      final selected = ref.watch(currentConversationProvider)?.id == c.id;
                      return Container(
                        margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
                        decoration: BoxDecoration(
                          color: selected ? iosBlue.withValues(alpha: 0.12) : iosCardBg,
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: IosRow(
                          icon: c.forkedFrom != null
                              ? CupertinoIcons.arrow_branch
                              : CupertinoIcons.chat_bubble_fill,
                          iconColor: c.forkedFrom != null ? iosPurple : iosBlue,
                          title: c.title,
                          subtitle: '${c.messageCount} 条消息',
                          trailing: _ConversationMenu(
                            conversation: c,
                            onRenamed: () => ref.read(conversationsProvider.notifier).refresh(),
                            onDeleted: () {
                              if (ref.read(currentConversationProvider)?.id == c.id) {
                                ref.read(currentConversationProvider.notifier).set(null);
                                ref.read(chatProvider.notifier).clear();
                              }
                              ref.read(conversationsProvider.notifier).refresh();
                            },
                          ),
                          onTap: () async {
                            ref.read(currentConversationProvider.notifier).set(c);
                            await ref.read(chatProvider.notifier).loadHistory(c);
                            if (context.mounted) Navigator.of(context).pop();
                          },
                        ),
                      );
                    },
                  );
                },
                loading: () => const Center(child: CupertinoActivityIndicator()),
                error: (e, _) =>
                    Center(child: Text('加载失败：$e', style: const TextStyle(fontSize: 12))),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 会话操作（长按弹层）。
class _ConversationMenu extends StatelessWidget {
  const _ConversationMenu({
    required this.conversation,
    required this.onRenamed,
    required this.onDeleted,
  });

  final ConversationMeta conversation;
  final VoidCallback onRenamed;
  final VoidCallback onDeleted;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => _open(context),
      child: const Padding(
        padding: EdgeInsets.all(6),
        child: Icon(CupertinoIcons.ellipsis, size: 16, color: iosSecondaryLabel),
      ),
    );
  }

  void _open(BuildContext context) {
    showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        title: Text(conversation.title),
        actions: [
          CupertinoActionSheetAction(
            onPressed: () async {
              Navigator.pop(ctx);
              await _rename(context);
            },
            child: const Text('重命名'),
          ),
          CupertinoActionSheetAction(
            isDestructiveAction: true,
            onPressed: () async {
              Navigator.pop(ctx);
              await HarnessClient.instance.deleteConversation(conversation.id);
              onDeleted();
            },
            child: const Text('删除'),
          ),
        ],
        cancelButton: CupertinoActionSheetAction(
          onPressed: () => Navigator.pop(ctx),
          child: const Text('取消'),
        ),
      ),
    );
  }

  Future<void> _rename(BuildContext context) async {
    final ctrl = TextEditingController(text: conversation.title);
    final newTitle = await showCupertinoDialog<String>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: const Text('重命名会话'),
        content: Padding(
          padding: const EdgeInsets.only(top: 10),
          child: CupertinoTextField(controller: ctrl, autofocus: true),
        ),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () => Navigator.pop(ctx, ctrl.text),
            child: const Text('保存'),
          ),
        ],
      ),
    );
    if (newTitle != null && newTitle.isNotEmpty) {
      await HarnessClient.instance.renameConversation(conversation.id, newTitle);
      onRenamed();
    }
  }
}
