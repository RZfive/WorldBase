import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart' show Colors, Divider, Drawer, Scaffold;
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

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
  final List<ChatAttachment> _pendingAttachments = [];
  bool _advancedExpanded = false;
  bool _isImportingAttachments = false;
  String? _attachmentError;

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

  Future<void> _send([String? preset]) async {
    final text = (preset ?? _inputCtrl.text).trim();
    if (text.isEmpty && _pendingAttachments.isEmpty) return;
    final attachments = [..._pendingAttachments];
    final sent = await ref
        .read(chatProvider.notifier)
        .send(text, attachments: attachments);
    if (!sent || !mounted) return;
    _inputCtrl.clear();
    setState(() {
      _pendingAttachments.clear();
      _attachmentError = null;
    });
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
    ref.read(chatProvider.notifier).startNewConversation();
    if (mounted) {
      setState(() {
        _pendingAttachments.clear();
        _attachmentError = null;
      });
    }
  }

  Future<void> _pickAttachments() async {
    if (_isImportingAttachments || ref.read(chatProvider.notifier).busy) return;
    setState(() {
      _isImportingAttachments = true;
      _attachmentError = null;
    });
    final imported = <ChatAttachment>[];
    final errors = <String>[];
    try {
      final result = await FilePicker.platform.pickFiles(
        allowMultiple: true,
        withData: true,
      );
      if (result == null) return;
      for (final file in result.files) {
        try {
          imported.add(await _importAttachment(file));
        } catch (error) {
          errors.add('${file.name}：$error');
        }
      }
    } catch (error) {
      errors.add('打开文件选择器失败：$error');
    } finally {
      if (mounted) {
        setState(() {
          _pendingAttachments.addAll(imported);
          _attachmentError = errors.isEmpty ? null : errors.join('\n');
          _isImportingAttachments = false;
        });
      }
    }
  }

  Future<ChatAttachment> _importAttachment(PlatformFile file) async {
    final size = file.size;
    final isImage = isChatImageAttachment(file.name);
    final limit = isImage
        ? maxChatImageAttachmentBytes
        : maxChatFileAttachmentBytes;
    if (size > limit) {
      throw FormatException(
        '${isImage ? '图片' : '文件'}不能超过 ${limit ~/ 1024 ~/ 1024}MB',
      );
    }

    final bytes = await _readPickedFile(file);
    final id =
        'attachment-${DateTime.now().microsecondsSinceEpoch}-${_pendingAttachments.length}';
    if (isImage) {
      return ChatAttachment(
        id: id,
        name: file.name,
        fileType: chatAttachmentExtension(file.name),
        size: size,
        imageData: bytes,
      );
    }

    String content;
    String fileType;
    if (isChatDocumentAttachment(file.name)) {
      final path = await _attachmentPath(file, bytes);
      try {
        final parsed = await HarnessClient.instance.parseDocumentFile(path);
        content = trimChatAttachmentContent(parsed['text'] as String? ?? '');
        fileType =
            parsed['kind'] as String? ?? chatAttachmentFileType(file.name);
      } finally {
        try {
          await File(path).delete();
        } catch (_) {}
      }
    } else if (isSupportedChatTextAttachment(file.name) ||
        looksLikeChatText(bytes)) {
      content = decodeChatTextAttachment(bytes);
      fileType = chatAttachmentFileType(file.name);
    } else {
      final extension = chatAttachmentExtension(file.name);
      throw FormatException(
        '暂不支持的附件格式：${extension.isEmpty ? '未知' : extension}',
      );
    }
    return ChatAttachment(
      id: id,
      name: file.name,
      fileType: fileType,
      size: size,
      promptContent: content,
    );
  }

  Future<Uint8List> _readPickedFile(PlatformFile file) async {
    if (file.bytes != null) return file.bytes!;
    final path = file.path;
    if (path == null || path.isEmpty) throw const FileSystemException('无法读取文件');
    return File(path).readAsBytes();
  }

  Future<String> _attachmentPath(PlatformFile file, Uint8List bytes) async {
    final temp = await getTemporaryDirectory();
    final safeName = file.name.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
    final target = File(
      '${temp.path}${Platform.pathSeparator}worldbase-attachment-${DateTime.now().microsecondsSinceEpoch}-$safeName',
    );
    await target.writeAsBytes(bytes, flush: true);
    return target.path;
  }

  void _removeAttachment(String id) {
    setState(() {
      _pendingAttachments.removeWhere((item) => item.id == id);
      if (_pendingAttachments.isEmpty) _attachmentError = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final messages = ref.watch(chatProvider);
    final busy = ref.read(chatProvider.notifier).busy;
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
                  ? _EmptyState(
                      bottomInset:
                          128 +
                          (_pendingAttachments.isEmpty ? 0 : 76) +
                          ((_attachmentError != null || _isImportingAttachments)
                              ? 34
                              : 0),
                    )
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
    final attachmentDockHeight = _pendingAttachments.isEmpty ? 0.0 : 76.0;
    final feedbackHeight = (_attachmentError != null || _isImportingAttachments)
        ? 34.0
        : 0.0;
    return ListView.builder(
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: EdgeInsets.fromLTRB(
        0,
        topPad,
        0,
        (_advancedExpanded ? 294 : 112) + attachmentDockHeight + feedbackHeight,
      ),
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
          attachments: m.attachments,
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
        showSheen: false,
        padding: const EdgeInsets.fromLTRB(8, 6, 6, 6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (_pendingAttachments.isNotEmpty) ...[
              _PendingAttachmentStrip(
                attachments: _pendingAttachments,
                onRemove: _removeAttachment,
              ),
              const SizedBox(height: 6),
            ],
            if (_isImportingAttachments || _attachmentError != null) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 0, 8, 6),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (_isImportingAttachments)
                      const Padding(
                        padding: EdgeInsets.only(top: 1),
                        child: CupertinoActivityIndicator(radius: 7),
                      )
                    else
                      const Icon(
                        CupertinoIcons.exclamationmark_circle_fill,
                        size: 14,
                        color: iosRed,
                      ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        _isImportingAttachments ? '正在读取附件…' : _attachmentError!,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 11,
                          color: _isImportingAttachments ? p.ink2 : iosRed,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
            if (_advancedExpanded) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
                child: Column(
                  children: [
                    SizedBox(
                      height: 44,
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              '深度思考',
                              style: TextStyle(fontSize: 13, color: p.ink),
                            ),
                          ),
                          CupertinoSwitch(
                            activeTrackColor: p.indigo,
                            value: switches.enableThinking,
                            onChanged: ref
                                .read(chatSwitchesProvider.notifier)
                                .setEnableThinking,
                          ),
                        ],
                      ),
                    ),
                    if (switches.enableThinking)
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
                Semantics(
                  button: true,
                  label: '导入附件',
                  child: CupertinoButton(
                    padding: EdgeInsets.zero,
                    minimumSize: const Size(34, 34),
                    onPressed: busy || _isImportingAttachments
                        ? null
                        : _pickAttachments,
                    child: Icon(
                      CupertinoIcons.paperclip,
                      size: 21,
                      color: busy || _isImportingAttachments
                          ? p.ink3
                          : p.indigo,
                    ),
                  ),
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
    await ref.read(chatProvider.notifier).loadHistory(target, force: true);
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
              onTap: () {
                unawaited(ref.read(conversationsProvider.notifier).refresh());
                Scaffold.of(ctx).openDrawer();
              },
            ),
          ),
          Expanded(
            child: Center(
              child: GlassContainer(
                key: const ValueKey('chat-model-selector'),
                level: GlassLevel.l1,
                radius: 19,
                showSheen: false,
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
      showSheen: false,
      padding: const EdgeInsets.all(10),
      onTap: onTap,
      child: Icon(icon, size: 17, color: p.ink),
    );
  }
}

/// 空态:只保留品牌呼吸 Orb 与时间问候，不用预设提示词干扰输入。
class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.bottomInset});

  final double bottomInset;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return Padding(
      padding: EdgeInsets.fromLTRB(18, 72, 18, bottomInset),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
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
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12.5, color: p.ink2),
            ),
          ],
        ),
      ),
    );
  }
}

class _PendingAttachmentStrip extends StatelessWidget {
  const _PendingAttachmentStrip({
    required this.attachments,
    required this.onRemove,
  });

  final List<ChatAttachment> attachments;
  final ValueChanged<String> onRemove;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 62,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 4),
        itemCount: attachments.length,
        separatorBuilder: (_, _) => const SizedBox(width: 6),
        itemBuilder: (_, index) => _ChatAttachmentTile(
          attachment: attachments[index],
          onRemove: () => onRemove(attachments[index].id),
        ),
      ),
    );
  }
}

class _ChatAttachmentTile extends StatelessWidget {
  const _ChatAttachmentTile({
    required this.attachment,
    this.onRemove,
    this.onUserBubble = false,
  });

  final ChatAttachment attachment;
  final VoidCallback? onRemove;
  final bool onUserBubble;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    final foreground = onUserBubble ? CupertinoColors.white : p.ink;
    final secondary = onUserBubble
        ? CupertinoColors.white.withValues(alpha: 0.76)
        : p.ink2;
    final fill = onUserBubble
        ? CupertinoColors.white.withValues(alpha: 0.16)
        : p.glassFill2;
    final border = onUserBubble
        ? CupertinoColors.white.withValues(alpha: 0.22)
        : p.separator;
    final imageBytes = attachment.imageBytes;

    return Container(
      width: attachment.isImage ? 92 : 184,
      height: 58,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(7),
        border: Border.all(color: border),
      ),
      child: Stack(
        children: [
          if (attachment.isImage && imageBytes != null)
            Positioned.fill(
              child: Image.memory(
                imageBytes,
                fit: BoxFit.cover,
                errorBuilder: (_, _, _) => Center(
                  child: Icon(CupertinoIcons.photo, color: foreground),
                ),
              ),
            )
          else if (attachment.isImage &&
              attachment.dataUrl != null &&
              (attachment.dataUrl!.startsWith('https://') ||
                  attachment.dataUrl!.startsWith('http://')))
            Positioned.fill(
              child: Image.network(
                attachment.dataUrl!,
                fit: BoxFit.cover,
                errorBuilder: (_, _, _) => Center(
                  child: Icon(CupertinoIcons.photo, color: foreground),
                ),
              ),
            )
          else
            Positioned.fill(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(9, 7, 26, 7),
                child: Row(
                  children: [
                    Icon(CupertinoIcons.doc_fill, size: 19, color: foreground),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            attachment.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 11.5,
                              fontWeight: FontWeight.w600,
                              color: foreground,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            attachment.size > 0
                                ? '${attachment.fileType.toUpperCase()} · ${attachment.sizeLabel}'
                                : attachment.fileType.toUpperCase(),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 9.5, color: secondary),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          if (onRemove != null)
            Positioned(
              top: 3,
              right: 3,
              child: GestureDetector(
                onTap: onRemove,
                child: Container(
                  width: 20,
                  height: 20,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: CupertinoColors.black.withValues(alpha: 0.58),
                  ),
                  child: const Icon(
                    CupertinoIcons.xmark,
                    size: 10,
                    color: CupertinoColors.white,
                  ),
                ),
              ),
            ),
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
    this.attachments = const [],
    this.onLongPress,
  });

  final String text;
  final bool isUser;
  final bool isStreaming;
  final List<ChatAttachment> attachments;
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
              if (attachments.isNotEmpty) ...[
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final attachment in attachments)
                      _ChatAttachmentTile(
                        attachment: attachment,
                        onUserBubble: isUser,
                      ),
                  ],
                ),
                if (text.isNotEmpty) const SizedBox(height: 7),
              ],
              if (text.isNotEmpty && !(isStreaming && text.isEmpty))
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
                              HarnessClient.instance
                                  .resourceUri(
                                    '/studio/${imageEntries[index].id}',
                                  )
                                  .toString(),
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
                  HarnessClient.instance
                      .resourceUri('/studio/${entry.id}')
                      .toString(),
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
    ref.watch(chatProvider);
    ref.watch(groupChatProvider);
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
            showSheen: false,
            showShadow: false,
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
    final groupId = c.groupId;
    final selected =
        groupId == null && ref.watch(currentConversationProvider)?.id == c.id;
    final groupController = ref.read(groupChatProvider.notifier);
    final running = groupId == null
        ? ref.read(chatProvider.notifier).isConversationRunning(c.id)
        : groupController.busy &&
              groupController.session?.conversationId == c.id;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
      child: GestureDetector(
        onTap: () async {
          if (groupId != null) {
            Navigator.of(context).pop();
            await Navigator.of(
              context,
            ).push(cupertinoRoute(GroupPage(initialGroupId: groupId)));
            return;
          }
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
              if (groupId != null) ...[
                Icon(CupertinoIcons.person_2_fill, size: 14, color: p.indigo),
                const SizedBox(width: 6),
              ] else if (c.forkedFrom != null) ...[
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
              if (running) ...[
                const SizedBox(width: 6),
                const CupertinoActivityIndicator(radius: 6),
                const SizedBox(width: 4),
                Text('执行中', style: TextStyle(fontSize: 10, color: p.ink2)),
              ],
              _ConversationMenu(
                conversation: c,
                onRenamed: () =>
                    ref.read(conversationsProvider.notifier).refresh(),
                onDeleted: () async {
                  await ref
                      .read(chatProvider.notifier)
                      .deleteConversation(c.id);
                  await ref.read(conversationsProvider.notifier).refresh();
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
    final media = MediaQuery.of(context);
    final contentHeight =
        52.0 + ((agents.length + 1) * 56.0) + media.padding.bottom;
    final sheetHeight = math.min(media.size.height * 0.72, contentHeight);
    return SizedBox(
      height: sheetHeight,
      child: Container(
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
              Expanded(
                child: ListView(
                  key: const ValueKey('agent-picker-list'),
                  padding: const EdgeInsets.only(bottom: 12),
                  children: [
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
                            title:
                                '${a.icon.isEmpty ? '🤖' : a.icon} ${a.name}',
                            subtitle: a.description,
                            onTap: () => Navigator.pop(context, a),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
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
  final Future<void> Function() onDeleted;

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
              await onDeleted();
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
