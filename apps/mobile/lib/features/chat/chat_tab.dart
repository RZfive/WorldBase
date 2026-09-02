import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart' show Colors, Divider, Drawer, Scaffold;
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/glass.dart';
import '../../core/ios_ui.dart';
import '../../core/markdown_renderer.dart';
import '../../core/providers.dart';
import '../common/model_picker.dart';
import '../launchpad/launchpad_tab.dart';
import '../settings/settings_tab.dart';
import '../studio/studio_tab.dart';
import 'group_page.dart';

/// 对话主页(晨昏 2.0):对话即主页。
/// 悬浮顶栏(抽屉 / 模型胶囊 / 新会话)+ 空态问候 + 流体玻璃对话流
/// + 带折叠模型参数的胶囊输入条 + 悬浮玻璃抽屉。
class ChatTab extends ConsumerStatefulWidget {
  const ChatTab({super.key});

  @override
  ConsumerState<ChatTab> createState() => _ChatTabState();
}

class _ChatTabState extends ConsumerState<ChatTab> {
  final _inputCtrl = TextEditingController();
  bool _advancedExpanded = false;

  static const _reasoningLevels = ['low', 'medium', 'high', 'max'];
  static const _reasoningLabels = {
    'low': '低',
    'medium': '中',
    'high': '高',
    'max': '最高',
  };

  @override
  void initState() {
    super.initState();
    Future.microtask(() async {
      final conversations = ref.read(conversationsProvider).value;
      final current = ref.read(currentConversationProvider);
      if (current == null &&
          conversations != null &&
          conversations.isNotEmpty) {
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

  void _send([String? preset]) {
    final text = (preset ?? _inputCtrl.text).trim();
    if (text.isEmpty) return;
    _inputCtrl.clear();
    ref.read(chatProvider.notifier).send(text);
  }

  Future<void> _newConversation() async {
    final cachedAgents = ref.read(agentsProvider).value;
    late final List<AgentDefinition> agents;
    if (cachedAgents == null) {
      try {
        agents = await HarnessClient.instance.listAgents();
      } catch (_) {
        agents = const [];
      }
    } else {
      agents = cachedAgents;
    }
    if (!mounted) return;
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

  /// 「+」能力面板:应用 / 绘图 / 群组是对话的输入,不是平级 Tab。
  void _openCapabilities() {
    showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        actions: [
          CupertinoActionSheetAction(
            onPressed: () {
              Navigator.pop(ctx);
              _pushSubPage(const LaunchpadTab());
            },
            child: const Text('应用广场'),
          ),
          CupertinoActionSheetAction(
            onPressed: () {
              Navigator.pop(ctx);
              _pushSubPage(const StudioTab());
            },
            child: const Text('绘图工作室'),
          ),
          CupertinoActionSheetAction(
            onPressed: () {
              Navigator.pop(ctx);
              Navigator.of(context).push(cupertinoRoute(const GroupPage()));
            },
            child: const Text('群组协作'),
          ),
        ],
        cancelButton: CupertinoActionSheetAction(
          onPressed: () => Navigator.pop(ctx),
          child: const Text('取消'),
        ),
      ),
    );
  }

  /// 推送子页(应用 / 绘图 / 设置):自带悬浮玻璃返回按钮。
  void _pushSubPage(Widget page) {
    Navigator.of(context).push(cupertinoRoute(_SubPageBack(child: page)));
  }

  @override
  Widget build(BuildContext context) {
    final messages = ref.watch(chatProvider);
    final busy = messages.any((m) => m.streaming);
    final p = DawnPalette.of(context);

    return Scaffold(
      backgroundColor: p.bgGradient.first,
      drawer: const _ConversationDrawer(),
      drawerScrimColor: p.isDark ? Colors.black54 : const Color(0x3324283C),
      body: DawnBackground(
        child: Stack(
          children: [
            // 内容层:延伸到浮岛之下滚动,玻璃把它们柔化成背景色。
            Positioned.fill(
              child: messages.isEmpty
                  ? _EmptyState(onChipTap: _send)
                  : _buildMessageList(messages),
            ),
            // L1 浮岛:顶部三件套。
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: SafeArea(
                bottom: false,
                child: _TopBar(onNewChat: _newConversation),
              ),
            ),
            // L1 浮岛:输入胶囊 + 折叠模型参数。
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: SafeArea(top: false, child: _buildDock(busy)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMessageList(List<UiMessage> messages) {
    final topPad = MediaQuery.paddingOf(context).top + 54;
    return ListView.builder(
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: EdgeInsets.fromLTRB(0, topPad, 0, _advancedExpanded ? 244 : 112),
      itemCount: messages.length,
      itemBuilder: (ctx, i) {
        final m = messages[i];
        if (m.isTool) {
          return _DawnToolCard(
            name: m.toolName ?? '',
            text: m.text,
            isError: m.isError,
            imageStatus: m.imageStatus,
            imageEntries: m.imageEntries,
            onWaitForImages: m.imageStatus == 'queued'
                ? () => ref.read(chatProvider.notifier).waitForImages(m.id)
                : null,
          );
        }
        return _DawnBubble(
          text: m.text,
          isUser: m.role == 'user',
          isStreaming: m.streaming,
          onLongPress: m.role == 'user' && m.dbId > 0
              ? () => _showMessageActions(m)
              : null,
        );
      },
    );
  }

  Widget _buildDock(bool busy) {
    final p = DawnPalette.of(context);
    final switches = ref.watch(chatSwitchesProvider);
    final reasoningIndex = _reasoningLevels.indexOf(switches.reasoningStrength);
    final normalizedReasoningIndex = reasoningIndex < 0 ? 1 : reasoningIndex;
    final effectiveTemperature =
        switches.temperature ?? _providerDefaultTemperature();
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
      child: GlassContainer(
        level: GlassLevel.l1,
        radius: 8,
        padding: const EdgeInsets.fromLTRB(8, 6, 6, 6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (_advancedExpanded) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
                child: Column(
                  children: [
                    _AdvancedSliderRow(
                      label:
                          '思考强度 (${_reasoningLabels[switches.reasoningStrength] ?? '中'})',
                      value: normalizedReasoningIndex.toDouble(),
                      min: 0,
                      max: 3,
                      divisions: 3,
                      onChanged: (value) => ref
                          .read(chatSwitchesProvider.notifier)
                          .setReasoningStrength(
                            _reasoningLevels[value.round().clamp(0, 3)],
                          ),
                    ),
                    _AdvancedSliderRow(
                      label:
                          '模型温度 (${effectiveTemperature.toStringAsFixed(1)})',
                      value: effectiveTemperature.clamp(0, 2).toDouble(),
                      min: 0,
                      max: 2,
                      divisions: 20,
                      onChanged: (value) => ref
                          .read(chatSwitchesProvider.notifier)
                          .setTemperature(value),
                    ),
                  ],
                ),
              ),
              Container(height: 0.5, color: p.separator),
              const SizedBox(height: 4),
            ],
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                CupertinoButton(
                  padding: EdgeInsets.zero,
                  minimumSize: const Size(34, 34),
                  onPressed: () =>
                      setState(() => _advancedExpanded = !_advancedExpanded),
                  child: Icon(
                    CupertinoIcons.gear_alt,
                    size: 20,
                    color: _advancedExpanded ? p.indigo : p.ink2,
                  ),
                ),
                CupertinoButton(
                  padding: EdgeInsets.zero,
                  minimumSize: const Size(34, 34),
                  onPressed: _openCapabilities,
                  child: Icon(CupertinoIcons.add, size: 22, color: p.indigo),
                ),
                Expanded(
                  child: CupertinoTextField(
                    controller: _inputCtrl,
                    placeholder: '问点什么…',
                    placeholderStyle: TextStyle(fontSize: 15, color: p.ink3),
                    style: TextStyle(fontSize: 15, color: p.ink),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 6,
                      vertical: 8,
                    ),
                    decoration: const BoxDecoration(),
                    minLines: 1,
                    maxLines: 4,
                    onSubmitted: (_) => _send(),
                  ),
                ),
                const SizedBox(width: 6),
                if (busy)
                  GestureDetector(
                    onTap: () => ref.read(chatProvider.notifier).abort(),
                    child: Container(
                      width: 32,
                      height: 32,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: p.glassFill2,
                        border: Border.all(color: p.glassBorder),
                      ),
                      child: const Icon(
                        CupertinoIcons.stop_fill,
                        size: 14,
                        color: iosRed,
                      ),
                    ),
                  )
                else
                  DawnSendButton(onTap: _send),
              ],
            ),
          ],
        ),
      ),
    );
  }

  double _providerDefaultTemperature() {
    final config = ref.watch(providersProvider).value;
    if (config == null) return 0.3;
    final target = ref.watch(chatTargetProvider);
    final selectedAgent = ref.watch(selectedAgentProvider);
    final providerId =
        target.providerId ??
        selectedAgent?.providerId ??
        config['activeProviderId'];
    final providers = (config['providers'] as List? ?? const [])
        .whereType<Map>()
        .map((raw) => ProviderEntry.fromJson(raw.cast<String, dynamic>()));
    for (final provider in providers) {
      if (provider.id == providerId && provider.temperature != null) {
        return provider.temperature!.clamp(0, 2).toDouble();
      }
    }
    return 0.3;
  }

  void _showMessageActions(UiMessage message) {
    final conversation = ref.read(currentConversationProvider);
    if (conversation == null) return;
    showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        title: Text(
          message.text,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 13),
        ),
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
            child: const Text('编辑并重发(分叉)'),
          ),
          CupertinoActionSheetAction(
            isDestructiveAction: true,
            onPressed: () =>
                _editAndResend(ctx, conversation, message, 'inplace'),
            child: const Text('编辑并重发(就地覆盖)'),
          ),
          CupertinoActionSheetAction(
            onPressed: () async {
              Navigator.pop(ctx);
              final result = await HarnessClient.instance.forkConversation(
                conversation.id,
                message.dbId,
                mode: 'fork',
              );
              final newId = result['conversationId'] as String;
              final conversations = await HarnessClient.instance
                  .listConversations();
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
    BuildContext ctx,
    ConversationMeta conversation,
    UiMessage message,
    String mode,
  ) async {
    final ctrl = TextEditingController(text: message.text);
    final newText = await showCupertinoDialog<String>(
      context: ctx,
      builder: (dctx) => CupertinoAlertDialog(
        title: Text(mode == 'inplace' ? '编辑重发(就地)' : '编辑重发(分叉)'),
        content: Padding(
          padding: const EdgeInsets.only(top: 10),
          child: CupertinoTextField(
            controller: ctrl,
            maxLines: 4,
            autofocus: true,
          ),
        ),
        actions: [
          CupertinoDialogAction(
            onPressed: () => Navigator.pop(dctx),
            child: const Text('取消'),
          ),
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

    final result = await HarnessClient.instance.forkConversation(
      conversation.id,
      message.dbId,
      newText: newText,
      mode: mode,
    );
    final targetId = result['conversationId'] as String;
    final conversations = await HarnessClient.instance.listConversations();
    final target = conversations.firstWhere((c) => c.id == targetId);
    ref.read(currentConversationProvider.notifier).set(target);
    await ref.read(chatProvider.notifier).loadHistory(target);
    ref.read(conversationsProvider.notifier).refresh();
    await ref.read(chatProvider.notifier).send(newText);
  }
}

class _AdvancedSliderRow extends StatelessWidget {
  const _AdvancedSliderRow({
    required this.label,
    required this.value,
    required this.min,
    required this.max,
    required this.divisions,
    required this.onChanged,
  });

  final String label;
  final double value;
  final double min;
  final double max;
  final int divisions;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return SizedBox(
      height: 48,
      child: Row(
        children: [
          SizedBox(
            width: 112,
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w500,
                color: p.ink,
              ),
            ),
          ),
          Expanded(
            child: CupertinoSlider(
              value: value,
              min: min,
              max: max,
              divisions: divisions,
              activeColor: p.indigo,
              onChanged: onChanged,
            ),
          ),
        ],
      ),
    );
  }
}

/// 顶部三浮岛:抽屉菜单 / 模型胶囊 / 新会话。
class _TopBar extends ConsumerWidget {
  const _TopBar({required this.onNewChat});

  final VoidCallback onNewChat;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = DawnPalette.of(context);
    final target = ref.watch(chatTargetProvider);
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 4, 14, 8),
      child: Row(
        children: [
          Builder(
            builder: (ctx) => _GlassIconButton(
              icon: CupertinoIcons.sidebar_left,
              onTap: () => Scaffold.of(ctx).openDrawer(),
            ),
          ),
          Expanded(
            child: Center(
              child: GlassContainer(
                level: GlassLevel.l1,
                radius: 19,
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 9,
                ),
                onTap: () => showModelPickerSheet(
                  context,
                  title: '选择模型',
                  selectedProviderId: target.providerId,
                  selectedModel: target.model,
                  onSelected: (pid, model, pname) => ref
                      .read(chatTargetProvider.notifier)
                      .set(
                        ChatTarget(
                          providerId: pid,
                          model: model,
                          providerName: pname,
                        ),
                      ),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        gradient: LinearGradient(colors: [p.indigo, p.coral]),
                      ),
                    ),
                    const SizedBox(width: 7),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 150),
                      child: Text(
                        target.label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: p.ink,
                        ),
                      ),
                    ),
                    const SizedBox(width: 5),
                    Icon(CupertinoIcons.chevron_down, size: 11, color: p.ink2),
                  ],
                ),
              ),
            ),
          ),
          _GlassIconButton(
            icon: CupertinoIcons.square_pencil,
            onTap: onNewChat,
          ),
        ],
      ),
    );
  }
}

/// L1 玻璃圆形图标按钮。
class _GlassIconButton extends StatelessWidget {
  const _GlassIconButton({required this.icon, required this.onTap});

  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return GlassContainer(
      level: GlassLevel.l1,
      radius: 99,
      padding: const EdgeInsets.all(10),
      onTap: onTap,
      child: Icon(icon, size: 17, color: p.ink),
    );
  }
}

/// 空态:呼吸 Orb + 时间问候 + 每日建议 chips。
class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.onChipTap});

  final ValueChanged<String> onChipTap;

  static const _chips = [
    (CupertinoIcons.envelope, '帮我写一封得体的请假邮件'),
    (CupertinoIcons.calendar, '看看今天的日程,留个喘息的空档'),
    (CupertinoIcons.sparkles, '用大白话解释「量子纠缠」'),
  ];

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 18),
      child: Column(
        children: [
          const Spacer(flex: 3),
          const DawnOrb(size: 56),
          const SizedBox(height: 14),
          Text(
            dawnGreeting(),
            style: TextStyle(
              fontSize: 21,
              fontWeight: FontWeight.w600,
              color: p.ink,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            '我是晨昏,今天想做点什么?',
            style: TextStyle(fontSize: 12.5, color: p.ink2),
          ),
          const Spacer(flex: 2),
          for (final (icon, text) in _chips) ...[
            GlassContainer(
              level: GlassLevel.l3,
              radius: 16,
              padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 10),
              onTap: () => onChipTap(text),
              child: Row(
                children: [
                  Icon(icon, size: 14, color: p.indigo),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      text,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12.5, color: p.ink),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
          ],
          const SizedBox(height: 128), // 给输入胶囊与开关留出悬浮空间
        ],
      ),
    );
  }
}

/// 晨昏气泡:用户 = 晨蓝→曦橙渐变;AI = 雾白磨砂(列表内免 blur)。
class _DawnBubble extends StatelessWidget {
  const _DawnBubble({
    required this.text,
    required this.isUser,
    this.isStreaming = false,
    this.onLongPress,
  });

  final String text;
  final bool isUser;
  final bool isStreaming;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: GestureDetector(
        onLongPress: onLongPress,
        child: Container(
          margin: EdgeInsets.only(
            top: 4,
            bottom: 4,
            left: isUser ? 56 : 12,
            right: isUser ? 12 : 56,
          ),
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 9),
          constraints: BoxConstraints(
            maxWidth:
                (MediaQuery.sizeOf(context).width * (isUser ? 0.86 : 0.96))
                    .clamp(260.0, 680.0),
          ),
          decoration: BoxDecoration(
            gradient: isUser
                ? LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: p.userBubbleGradient,
                  )
                : null,
            color: isUser ? null : p.aiBubbleFill,
            border: isUser ? null : Border.all(color: p.aiBubbleBorder),
            borderRadius: BorderRadius.only(
              topLeft: const Radius.circular(21),
              topRight: const Radius.circular(21),
              bottomLeft: Radius.circular(isUser ? 21 : 8),
              bottomRight: Radius.circular(isUser ? 8 : 21),
            ),
            boxShadow: isUser
                ? [
                    BoxShadow(
                      color: p.indigo.withValues(alpha: 0.3),
                      blurRadius: 14,
                      offset: const Offset(0, 6),
                    ),
                  ]
                : [
                    BoxShadow(
                      color: p.shadowColor.withValues(alpha: 0.14),
                      blurRadius: 12,
                      offset: const Offset(0, 5),
                    ),
                  ],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (!(isStreaming && text.isEmpty))
                MarkdownMessage(
                  data: text,
                  isUser: isUser,
                  isStreaming: isStreaming,
                ),
              if (isStreaming)
                Padding(
                  padding: EdgeInsets.only(top: text.isEmpty ? 0 : 6),
                  child: text.isEmpty
                      ? Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const DawnOrb(size: 12),
                            const SizedBox(width: 7),
                            Text(
                              '正在思考…',
                              style: TextStyle(fontSize: 11, color: p.ink2),
                            ),
                          ],
                        )
                      : const LightCursor(),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 工具调用卡(L3 内容玻璃观感,列表内免 blur)。
class _DawnToolCard extends StatelessWidget {
  const _DawnToolCard({
    required this.name,
    required this.text,
    this.isError = false,
    this.imageStatus,
    this.imageEntries = const [],
    this.onWaitForImages,
  });

  final String name;
  final String text;
  final bool isError;
  final String? imageStatus;
  final List<ImageEntry> imageEntries;
  final VoidCallback? onWaitForImages;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    final isImageTool = name == 'generate_image' || name == 'edit_image';
    final title = switch (name) {
      'generate_image' => '图片生成',
      'edit_image' => '图片编辑',
      _ => '工具 · $name',
    };
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 12),
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
        constraints: const BoxConstraints(maxWidth: 300),
        decoration: BoxDecoration(
          color: p.aiBubbleFill,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: isError ? iosRed.withValues(alpha: 0.45) : p.aiBubbleBorder,
          ),
          boxShadow: [
            BoxShadow(
              color: p.shadowColor.withValues(alpha: 0.12),
              blurRadius: 12,
              offset: const Offset(0, 5),
            ),
          ],
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 22,
              height: 22,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(7),
                gradient: isError
                    ? null
                    : LinearGradient(
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                        colors: [p.indigo, const Color(0xFF9A6BD6)],
                      ),
                color: isError ? iosRed.withValues(alpha: 0.12) : null,
              ),
              child: Icon(
                isError
                    ? CupertinoIcons.exclamationmark_circle_fill
                    : (isImageTool
                          ? CupertinoIcons.photo_fill
                          : CupertinoIcons.wrench_fill),
                size: 12,
                color: isError ? iosRed : Colors.white,
              ),
            ),
            const SizedBox(width: 8),
            Flexible(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: p.ink,
                    ),
                  ),
                  const SizedBox(height: 1),
                  Text(
                    text,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11, color: p.ink2),
                  ),
                  if (imageEntries.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    SizedBox(
                      height: 92,
                      child: ListView.separated(
                        scrollDirection: Axis.horizontal,
                        itemCount: imageEntries.length,
                        separatorBuilder: (_, _) => const SizedBox(width: 6),
                        itemBuilder: (_, index) => GestureDetector(
                          onTap: () => _openImage(context, imageEntries[index]),
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(9),
                            child: Image.network(
                              '${HarnessClient.instance.httpBase}/studio/${imageEntries[index].id}',
                              width: 92,
                              height: 92,
                              fit: BoxFit.cover,
                              errorBuilder: (_, _, _) => ColoredBox(
                                color: p.groupedBg,
                                child: const SizedBox(width: 92, height: 92),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                  if (imageStatus == 'queued' && onWaitForImages != null) ...[
                    const SizedBox(height: 7),
                    SizedBox(
                      height: 30,
                      child: CupertinoButton(
                        padding: const EdgeInsets.symmetric(horizontal: 10),
                        minimumSize: const Size(0, 30),
                        color: p.indigo.withValues(alpha: .12),
                        onPressed: onWaitForImages,
                        child: Text(
                          '等待生成并显示',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                            color: p.indigo,
                          ),
                        ),
                      ),
                    ),
                  ] else if (imageStatus == 'waiting') ...[
                    const SizedBox(height: 7),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        CupertinoActivityIndicator(radius: 6, color: p.indigo),
                        const SizedBox(width: 6),
                        Text(
                          '正在生成图片…',
                          style: TextStyle(fontSize: 11, color: p.indigo),
                        ),
                      ],
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

  void _openImage(BuildContext context, ImageEntry entry) {
    final p = DawnPalette.of(context);
    Navigator.of(context).push(
      CupertinoPageRoute<void>(
        builder: (ctx) => CupertinoPageScaffold(
          backgroundColor: p.isDark
              ? const Color(0xFF0C0D12)
              : const Color(0xFFE9EAF0),
          navigationBar: CupertinoNavigationBar(
            backgroundColor: p.cardBg,
            border: Border(bottom: BorderSide(color: p.separator)),
            leading: CupertinoNavigationBarBackButton(
              color: p.indigo,
              previousPageTitle: '对话',
              onPressed: () => Navigator.pop(ctx),
            ),
            middle: Text(
              '生成结果',
              style: TextStyle(
                color: p.ink,
                fontSize: 15,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          child: SafeArea(
            top: false,
            child: InteractiveViewer(
              minScale: .7,
              maxScale: 5,
              boundaryMargin: const EdgeInsets.all(120),
              child: Center(
                child: Image.network(
                  '${HarnessClient.instance.httpBase}/studio/${entry.id}',
                  fit: BoxFit.contain,
                  errorBuilder: (_, _, _) =>
                      Icon(CupertinoIcons.photo, size: 44, color: p.ink3),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 子页容器:为无返回键的分组列表页叠加悬浮玻璃返回按钮。
class _SubPageBack extends StatelessWidget {
  const _SubPageBack({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        child,
        Positioned(
          top: 0,
          left: 0,
          child: SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.only(left: 10, top: 4),
              child: _GlassIconButton(
                icon: CupertinoIcons.chevron_left,
                onTap: () => Navigator.of(context).pop(),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// 悬浮玻璃抽屉:搜索 + 今天/昨天/更早 + 应用入口 + 用户行。
class _ConversationDrawer extends ConsumerStatefulWidget {
  const _ConversationDrawer();

  @override
  ConsumerState<_ConversationDrawer> createState() =>
      _ConversationDrawerState();
}

class _ConversationDrawerState extends ConsumerState<_ConversationDrawer> {
  String _query = '';

  void _open(Widget page, {bool wrap = true}) {
    Navigator.of(context).pop(); // 先收抽屉
    Navigator.of(
      context,
    ).push(cupertinoRoute(wrap ? _SubPageBack(child: page) : page));
  }

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    final conversations = ref.watch(conversationsProvider);
    final width = math.min(320.0, MediaQuery.sizeOf(context).width * 0.82);

    return Drawer(
      backgroundColor: Colors.transparent,
      elevation: 0,
      width: width,
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 10, 0, 10),
          child: GlassContainer(
            level: GlassLevel.l1,
            radius: 26,
            fill: p.drawerFill,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
                  child: CupertinoSearchTextField(
                    placeholder: '搜索对话',
                    onChanged: (v) => setState(() => _query = v),
                    style: TextStyle(fontSize: 13, color: p.ink),
                    placeholderStyle: TextStyle(fontSize: 13, color: p.ink3),
                    decoration: BoxDecoration(
                      color: p.isDark
                          ? Colors.white.withValues(alpha: 0.08)
                          : Colors.white.withValues(alpha: 0.55),
                      borderRadius: BorderRadius.circular(14),
                    ),
                  ),
                ),
                Expanded(
                  child: conversations.when(
                    data: (list) => _buildGroupedList(list, p),
                    loading: () =>
                        const Center(child: CupertinoActivityIndicator()),
                    error: (e, _) => Center(
                      child: Text(
                        '加载失败:$e',
                        style: const TextStyle(fontSize: 12),
                      ),
                    ),
                  ),
                ),
                Divider(height: 1, thickness: 0.5, color: p.glassBorder),
                _DrawerEntry(
                  icon: CupertinoIcons.square_grid_2x2,
                  colors: [p.indigo, const Color(0xFF9A6BD6)],
                  label: '应用广场',
                  onTap: () => _open(const LaunchpadTab()),
                ),
                _DrawerEntry(
                  icon: CupertinoIcons.star_fill,
                  colors: [p.coral, const Color(0xFFE8A26B)],
                  label: '绘图工作室',
                  onTap: () => _open(const StudioTab()),
                ),
                _DrawerEntry(
                  icon: CupertinoIcons.person_2_fill,
                  colors: [const Color(0xFF9A6BD6), p.coral],
                  label: '群组协作',
                  onTap: () => _open(const GroupPage(), wrap: false),
                ),
                Divider(height: 1, thickness: 0.5, color: p.glassBorder),
                Padding(
                  padding: const EdgeInsets.fromLTRB(14, 10, 8, 12),
                  child: Row(
                    children: [
                      Container(
                        width: 28,
                        height: 28,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          gradient: LinearGradient(colors: [p.indigo, p.coral]),
                        ),
                        child: const Icon(
                          CupertinoIcons.person_fill,
                          size: 15,
                          color: Colors.white,
                        ),
                      ),
                      const SizedBox(width: 9),
                      Expanded(
                        child: Text(
                          '我的',
                          style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w600,
                            color: p.ink,
                          ),
                        ),
                      ),
                      CupertinoButton(
                        padding: const EdgeInsets.all(8),
                        onPressed: () => _open(const SettingsTab()),
                        minimumSize: Size(0, 0),
                        child: Icon(
                          CupertinoIcons.gear,
                          size: 17,
                          color: p.ink3,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildGroupedList(List<ConversationMeta> list, DawnPalette p) {
    final filtered = _query.isEmpty
        ? list
        : list
              .where(
                (c) => c.title.toLowerCase().contains(_query.toLowerCase()),
              )
              .toList();
    if (filtered.isEmpty) {
      return Center(
        child: Text('暂无会话', style: TextStyle(fontSize: 12.5, color: p.ink2)),
      );
    }

    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final yesterday = today.subtract(const Duration(days: 1));
    final groups = <String, List<ConversationMeta>>{
      '今天': [],
      '昨天': [],
      '更早': [],
    };
    for (final c in filtered) {
      final dt = DateTime.tryParse(c.updatedAt)?.toLocal();
      final day = dt == null ? null : DateTime(dt.year, dt.month, dt.day);
      if (day == today) {
        groups['今天']!.add(c);
      } else if (day == yesterday) {
        groups['昨天']!.add(c);
      } else {
        groups['更早']!.add(c);
      }
    }

    return ListView(
      padding: const EdgeInsets.only(bottom: 8),
      children: [
        for (final entry in groups.entries)
          if (entry.value.isNotEmpty) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 3),
              child: Text(
                entry.key,
                style: TextStyle(
                  fontSize: 9.5,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 1.4,
                  color: p.ink3,
                ),
              ),
            ),
            for (final c in entry.value) _buildConversationTile(c, p),
          ],
      ],
    );
  }

  Widget _buildConversationTile(ConversationMeta c, DawnPalette p) {
    final selected = ref.watch(currentConversationProvider)?.id == c.id;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
      child: GestureDetector(
        onTap: () async {
          ref.read(currentConversationProvider.notifier).set(c);
          await ref.read(chatProvider.notifier).loadHistory(c);
          if (mounted) Navigator.of(context).pop();
        },
        child: Container(
          padding: const EdgeInsets.fromLTRB(10, 8, 4, 8),
          decoration: BoxDecoration(
            color: selected
                ? (p.isDark
                      ? Colors.white.withValues(alpha: 0.12)
                      : Colors.white.withValues(alpha: 0.6))
                : null,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(
            children: [
              if (c.forkedFrom != null) ...[
                Icon(CupertinoIcons.arrow_branch, size: 12, color: p.indigo),
                const SizedBox(width: 6),
              ],
              Expanded(
                child: Text(
                  c.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                    color: p.ink,
                  ),
                ),
              ),
              _ConversationMenu(
                conversation: c,
                onRenamed: () =>
                    ref.read(conversationsProvider.notifier).refresh(),
                onDeleted: () {
                  if (ref.read(currentConversationProvider)?.id == c.id) {
                    ref.read(currentConversationProvider.notifier).set(null);
                    ref.read(chatProvider.notifier).clear();
                  }
                  ref.read(conversationsProvider.notifier).refresh();
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 抽屉内的应用入口行(渐变图标块 + 名称)。
class _DrawerEntry extends StatelessWidget {
  const _DrawerEntry({
    required this.icon,
    required this.colors,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final List<Color> colors;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return CupertinoButton(
      padding: EdgeInsets.zero,
      onPressed: onTap,
      minimumSize: Size(0, 0),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
        child: Row(
          children: [
            Container(
              width: 24,
              height: 24,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(8),
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: colors,
                ),
              ),
              child: Icon(icon, size: 13, color: Colors.white),
            ),
            const SizedBox(width: 9),
            Text(
              label,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w500,
                color: p.ink,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Agent 选择弹层。
class _AgentPickerSheet extends StatelessWidget {
  const _AgentPickerSheet({required this.agents});

  final List<AgentDefinition> agents;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return Container(
      decoration: BoxDecoration(
        color: p.groupedBg,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
      ),
      child: SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 20, 6),
              child: Text(
                '选择 Agent(新会话)',
                style: TextStyle(fontSize: 13, color: p.ink2),
              ),
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

/// 会话操作(长按弹层)。
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
      child: Padding(
        padding: const EdgeInsets.all(6),
        child: Icon(
          CupertinoIcons.ellipsis,
          size: 16,
          color: DawnPalette.of(context).ink2,
        ),
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
          CupertinoDialogAction(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('取消'),
          ),
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () => Navigator.pop(ctx, ctrl.text),
            child: const Text('保存'),
          ),
        ],
      ),
    );
    if (newTitle != null && newTitle.isNotEmpty) {
      await HarnessClient.instance.renameConversation(
        conversation.id,
        newTitle,
      );
      onRenamed();
    }
  }
}
