import 'dart:async';
import 'dart:convert';

import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/glass.dart';
import '../../core/ios_ui.dart';
import '../../core/providers.dart';

/// 我的 Tab：设置层级与 Electron 桌面端一致（降级项除外）：
/// 模型供应商 / 用量统计 / MCP 服务 / 技能 / Agent 工作区 / 定时任务 / 通用与关于。
class SettingsTab extends ConsumerWidget {
  const SettingsTab({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = DawnPalette.of(context);
    return IosScreen(
      navBar: const IosNavBar(),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(0, 4, 0, 24),
        children: [
          const IosSection(
            header: '模型',
            children: [
              SettingsEntry(
                icon: CupertinoIcons.cloud_fill,
                iconColor: iosIndigo,
                title: '模型供应商',
                subtitle: '多供应商 · 模型上下文与价格 · 生图能力',
                page: ProvidersPage(),
              ),
            ],
          ),
          const SizedBox(height: 14),
          IosSection(
            header: '智能体',
            children: [
              SettingsEntry(
                icon: CupertinoIcons.person_2_fill,
                iconColor: iosTeal,
                title: 'Agent 工作区',
                subtitle: 'Agent 管理 · 长期记忆',
                page: const AgentWorkspacePage(),
              ),
            ],
          ),
          const SizedBox(height: 14),
          const IosSection(
            header: '数据与效率',
            children: [
              SettingsEntry(
                icon: CupertinoIcons.chart_pie_fill,
                iconColor: iosBlue,
                title: '用量统计',
                subtitle: '成本 · tokens · 每日趋势',
                page: UsagePage(),
              ),
              SettingsEntry(
                icon: CupertinoIcons.doc_text_fill,
                iconColor: iosOrange,
                title: '技能',
                subtitle: 'YAML 技能的新建与管理',
                page: SkillsPage(),
              ),
              SettingsEntry(
                icon: CupertinoIcons.alarm_fill,
                iconColor: iosGreen,
                title: '定时任务',
                subtitle: 'cron 定时 · 移动端补跑语义',
                page: SchedulesPage(),
              ),
            ],
          ),
          const SizedBox(height: 14),
          IosSection(
            header: '扩展与连接',
            children: [
              SettingsEntry(
                icon: CupertinoIcons.cube_box_fill,
                iconColor: iosPink,
                title: 'MCP 服务',
                subtitle: '远程 server 连接与工具',
                page: McpPage(),
              ),
              SettingsEntry(
                icon: CupertinoIcons.gear_alt_fill,
                iconColor: p.ink2,
                title: '通用与关于',
                subtitle: 'Harness 连接 · 版本信息',
                page: AdvancedPage(),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 设置入口行（chevron）。
class SettingsEntry extends StatelessWidget {
  const SettingsEntry({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.page,
    this.subtitle,
    super.key,
  });

  final IconData icon;
  final Color iconColor;
  final String title;
  final String? subtitle;
  final Widget page;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return IosRow(
      icon: icon,
      iconColor: iconColor,
      title: title,
      subtitle: subtitle,
      trailing: Icon(CupertinoIcons.chevron_forward, size: 14, color: p.ink2),
      onTap: () => Navigator.of(context).push(cupertinoRoute(page)),
    );
  }
}

/// 设置子页面容器：大标题 + 返回。
class SettingsSubPage extends StatelessWidget {
  const SettingsSubPage({required this.title, required this.child, super.key});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return IosScreen(
      navBar: IosNavBar(
        leading: IosIconButton(
          icon: CupertinoIcons.chevron_left,
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      child: child,
    );
  }
}

/// 供应商子页。
class ProvidersPage extends StatelessWidget {
  const ProvidersPage({super.key});

  @override
  Widget build(BuildContext context) {
    return SettingsSubPage(
      title: '模型供应商',
      child: ListView(children: const [_ProvidersCard()]),
    );
  }
}

/// Agent 工作区子页（对齐桌面 agent-workspace 分区：Agent / 群组 / 记忆）。
class AgentWorkspacePage extends ConsumerStatefulWidget {
  const AgentWorkspacePage({super.key});

  @override
  ConsumerState<AgentWorkspacePage> createState() => _AgentWorkspacePageState();
}

class _AgentWorkspacePageState extends ConsumerState<AgentWorkspacePage> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    return SettingsSubPage(
      title: 'Agent 工作区',
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            child: CupertinoSlidingSegmentedControl<int>(
              groupValue: _tab,
              children: const {
                0: Padding(
                  padding: EdgeInsets.symmetric(vertical: 5),
                  child: Text('Agent', style: TextStyle(fontSize: 13)),
                ),
                1: Padding(
                  padding: EdgeInsets.symmetric(vertical: 5),
                  child: Text('群组', style: TextStyle(fontSize: 13)),
                ),
                2: Padding(
                  padding: EdgeInsets.symmetric(vertical: 5),
                  child: Text('记忆', style: TextStyle(fontSize: 13)),
                ),
              },
              onValueChanged: (v) => setState(() => _tab = v ?? 0),
            ),
          ),
          Expanded(
            child: switch (_tab) {
              0 => ListView(children: const [_AgentsCard()]),
              1 => ListView(children: const [_AgentGroupsCard()]),
              _ => ListView(children: const [_MemoryCard()]),
            },
          ),
        ],
      ),
    );
  }
}

/// 用量子页。
class UsagePage extends StatelessWidget {
  const UsagePage({super.key});

  @override
  Widget build(BuildContext context) {
    return SettingsSubPage(
      title: '用量统计',
      child: ListView(children: const [_UsageCard()]),
    );
  }
}

/// 技能子页。
class SkillsPage extends StatelessWidget {
  const SkillsPage({super.key});

  @override
  Widget build(BuildContext context) {
    return SettingsSubPage(
      title: '技能',
      child: ListView(children: const [_SkillsCard()]),
    );
  }
}

/// 定时任务子页。
class SchedulesPage extends StatelessWidget {
  const SchedulesPage({super.key});

  @override
  Widget build(BuildContext context) {
    return SettingsSubPage(
      title: '定时任务',
      child: ListView(children: const [_SchedulesCard()]),
    );
  }
}

/// MCP 子页。
class McpPage extends StatelessWidget {
  const McpPage({super.key});

  @override
  Widget build(BuildContext context) {
    return SettingsSubPage(
      title: 'MCP 服务',
      child: ListView(children: const [_McpCard()]),
    );
  }
}

/// 通用与关于子页。
class AdvancedPage extends StatelessWidget {
  const AdvancedPage({super.key});

  @override
  Widget build(BuildContext context) {
    return SettingsSubPage(
      title: '通用与关于',
      child: ListView(children: const [_AdvancedCard(), SizedBox(height: 14)]),
    );
  }
}

class _ProvidersCard extends ConsumerStatefulWidget {
  const _ProvidersCard();

  @override
  ConsumerState<_ProvidersCard> createState() => _ProvidersCardState();
}

class _ProvidersCardState extends ConsumerState<_ProvidersCard> {
  Map<String, dynamic>? _config;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final config = await HarnessClient.instance.listProviders();
      if (mounted) setState(() => _config = config);
    } catch (_) {}
  }

  List<ProviderEntry> _entries() {
    final list = _config?['providers'] as List? ?? [];
    return list
        .map((e) => ProviderEntry.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
  }

  String? _activeId() => _config?['activeProviderId'] as String?;

  @override
  Widget build(BuildContext context) {
    final entries = _entries();
    final activeId = _activeId();
    return IosSection(
      header: '模型供应商',
      footer: entries.isEmpty
          ? '未配置时使用 mock（演示模式）。添加 Anthropic 或任意 OpenAI 兼容端点。'
          : '每个模型可单独设置上下文、价格与生图/编辑能力',
      children: [
        if (entries.isEmpty)
          IosRow(
            icon: CupertinoIcons.plus_circle_fill,
            iconColor: iosBlue,
            title: '添加供应商',
            onTap: () => _editProvider(null),
          )
        else
          for (final p in entries)
            IosRow(
              icon: CupertinoIcons.cloud_fill,
              iconColor: p.id == activeId ? iosGreen : iosIndigo,
              title: p.id == activeId ? '${p.name}（默认）' : p.name,
              subtitle:
                  '${p.apiProtocol.isEmpty ? 'auto' : p.apiProtocol} · ${p.models.length} 个模型 · ${p.models.any((m) => m.imageGeneration) ? '支持生图' : '纯文本'}',
              onTap: () => _showProviderActions(context, p),
            ),
      ],
    );
  }

  void _showProviderActions(BuildContext context, ProviderEntry p) {
    showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        title: Text(p.name),
        actions: [
          if (p.id != _activeId())
            CupertinoActionSheetAction(
              onPressed: () async {
                Navigator.pop(ctx);
                await HarnessClient.instance.setActiveProvider(p.id);
                await _load();
                ref.read(providersProvider.notifier).refresh();
              },
              child: const Text('设为默认'),
            ),
          CupertinoActionSheetAction(
            onPressed: () {
              Navigator.pop(ctx);
              _editProvider(p);
            },
            child: const Text('编辑'),
          ),
          CupertinoActionSheetAction(
            isDestructiveAction: true,
            onPressed: () async {
              Navigator.pop(ctx);
              await HarnessClient.instance.deleteProvider(p.id);
              await _load();
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

  Future<void> _editProvider(ProviderEntry? existing) async {
    final p = DawnPalette.of(context);
    final nameCtrl = TextEditingController(text: existing?.name ?? '');
    final urlCtrl = TextEditingController(text: existing?.baseUrl ?? '');
    final keyCtrl = TextEditingController(text: existing?.apiKey ?? '');
    var protocol = existing?.apiProtocol ?? '';
    var enableThinking = existing?.enableThinking ?? false;

    // 模型编辑的持久控制器（与 models 下标一一对应）
    final models = <ModelInfo>[];
    final idCtrls = <TextEditingController>[];
    final ctxCtrls = <TextEditingController>[];
    final inCtrls = <TextEditingController>[];
    final outCtrls = <TextEditingController>[];
    void addModel([ModelInfo? seed]) {
      final m =
          seed ??
          ModelInfo(
            id: '',
            contextWindowK: 128,
            inputPrice: 0,
            outputPrice: 0,
            imageGeneration: false,
            imageEditing: false,
          );
      models.add(m);
      idCtrls.add(TextEditingController(text: m.id));
      ctxCtrls.add(
        TextEditingController(
          text: m.contextWindowK == 0 ? '' : '${m.contextWindowK}',
        ),
      );
      inCtrls.add(
        TextEditingController(text: m.inputPrice == 0 ? '' : '${m.inputPrice}'),
      );
      outCtrls.add(
        TextEditingController(
          text: m.outputPrice == 0 ? '' : '${m.outputPrice}',
        ),
      );
    }

    for (final m in existing?.models ?? const <ModelInfo>[]) {
      addModel(m);
    }
    if (models.isEmpty) addModel();
    var activeModel = existing?.activeModel ?? '';
    int? expandedIdx = existing == null ? 0 : null;
    var saving = false;
    String? saveError;

    await showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => Container(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.92,
        ),
        decoration: BoxDecoration(
          color: p.groupedBg,
          borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
        ),
        child: SafeArea(
          child: StatefulBuilder(
            builder: (ctx, setSheet) => SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    existing == null ? '添加供应商' : '编辑供应商',
                    style: const TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w600,
                      letterSpacing: -0.4,
                    ),
                  ),
                  const SizedBox(height: 12),
                  _field(nameCtrl, '名称'),
                  const SizedBox(height: 10),
                  Text('API 协议', style: TextStyle(fontSize: 13, color: p.ink2)),
                  const SizedBox(height: 6),
                  CupertinoSlidingSegmentedControl<String>(
                    groupValue: protocol,
                    children: const {
                      '': Padding(
                        padding: EdgeInsets.symmetric(vertical: 5),
                        child: Text('auto', style: TextStyle(fontSize: 12)),
                      ),
                      'openai': Padding(
                        padding: EdgeInsets.symmetric(vertical: 5),
                        child: Text('OpenAI', style: TextStyle(fontSize: 12)),
                      ),
                      'anthropic': Padding(
                        padding: EdgeInsets.symmetric(vertical: 5),
                        child: Text(
                          'Anthropic',
                          style: TextStyle(fontSize: 12),
                        ),
                      ),
                    },
                    onValueChanged: (v) => setSheet(() => protocol = v ?? ''),
                  ),
                  const SizedBox(height: 10),
                  _field(
                    urlCtrl,
                    'Base URL',
                    hint: 'https://api.deepseek.com/v1',
                  ),
                  const SizedBox(height: 10),
                  _field(keyCtrl, 'API Key', obscure: true),
                  const SizedBox(height: 8),
                  _capSwitch(
                    '默认启用深度思考',
                    enableThinking,
                    (value) => setSheet(() => enableThinking = value),
                  ),
                  const SizedBox(height: 12),
                  _RemoteModelPicker(
                    urlController: urlCtrl,
                    apiKeyController: keyCtrl,
                    apiProtocol: protocol,
                    existingModelIds: idCtrls
                        .map((controller) => controller.text.trim())
                        .where((id) => id.isNotEmpty)
                        .toList(),
                    onAdd: (modelIds) => setSheet(() {
                      if (models.length == 1 &&
                          idCtrls.first.text.trim().isEmpty) {
                        models.removeAt(0);
                        idCtrls.removeAt(0).dispose();
                        ctxCtrls.removeAt(0).dispose();
                        inCtrls.removeAt(0).dispose();
                        outCtrls.removeAt(0).dispose();
                      }
                      final existingIds = idCtrls
                          .map((controller) => controller.text.trim())
                          .toSet();
                      for (final modelId in modelIds) {
                        if (!existingIds.add(modelId)) continue;
                        addModel(ModelInfo(id: modelId, contextWindowK: 128));
                      }
                      if (activeModel.isEmpty && modelIds.isNotEmpty) {
                        activeModel = modelIds.first;
                      }
                      expandedIdx = models.isEmpty ? null : models.length - 1;
                      saveError = null;
                    }),
                  ),
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          '模型（逐模型设置能力与价格）',
                          style: TextStyle(fontSize: 13, color: p.ink2),
                        ),
                      ),
                      CupertinoButton(
                        padding: const EdgeInsets.all(4),
                        onPressed: () => setSheet(() {
                          addModel();
                          expandedIdx = models.length - 1;
                          saveError = null;
                        }),
                        minimumSize: Size(0, 0),
                        child: const Icon(
                          CupertinoIcons.add_circled,
                          size: 22,
                          color: iosBlue,
                        ),
                      ),
                    ],
                  ),
                  IosSection(
                    children: [
                      for (var i = 0; i < models.length; i++)
                        _modelCard(
                          setSheet: setSheet,
                          models: models,
                          idCtrls: idCtrls,
                          ctxCtrls: ctxCtrls,
                          inCtrls: inCtrls,
                          outCtrls: outCtrls,
                          i: i,
                          activeModel: activeModel,
                          expandedIdx: expandedIdx,
                          onExpand: (idx) => setSheet(() => expandedIdx = idx),
                          onSetDefault: () => setSheet(
                            () => activeModel = idCtrls[i].text.trim(),
                          ),
                          onDelete: () => setSheet(() {
                            models.removeAt(i);
                            idCtrls.removeAt(i).dispose();
                            ctxCtrls.removeAt(i).dispose();
                            inCtrls.removeAt(i).dispose();
                            outCtrls.removeAt(i).dispose();
                            expandedIdx = null;
                            saveError = null;
                          }),
                        ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  if (saveError != null) ...[
                    Text(
                      saveError!,
                      style: const TextStyle(fontSize: 13, color: iosRed),
                    ),
                    const SizedBox(height: 8),
                  ],
                  SizedBox(
                    width: double.infinity,
                    child: CupertinoButton.filled(
                      onPressed: saving
                          ? null
                          : () async {
                              final validModels = <ModelInfo>[];
                              for (var i = 0; i < models.length; i++) {
                                final id = idCtrls[i].text.trim();
                                if (id.isEmpty) continue;
                                validModels.add(
                                  ModelInfo(
                                    id: id,
                                    contextWindowK:
                                        int.tryParse(ctxCtrls[i].text.trim()) ??
                                        0,
                                    inputPrice:
                                        double.tryParse(
                                          inCtrls[i].text.trim(),
                                        ) ??
                                        0,
                                    outputPrice:
                                        double.tryParse(
                                          outCtrls[i].text.trim(),
                                        ) ??
                                        0,
                                    imageGeneration: models[i].imageGeneration,
                                    imageEditing: models[i].imageEditing,
                                  ),
                                );
                              }
                              if (validModels.isEmpty) {
                                setSheet(() {
                                  saveError = '请先添加模型并填写模型名称 / ID';
                                  expandedIdx = models.isEmpty ? null : 0;
                                });
                                return;
                              }
                              final entry = ProviderEntry(
                                id:
                                    existing?.id ??
                                    'p-${DateTime.now().millisecondsSinceEpoch}',
                                name: nameCtrl.text.trim().isEmpty
                                    ? '供应商'
                                    : nameCtrl.text.trim(),
                                baseUrl: urlCtrl.text.trim(),
                                apiKey: keyCtrl.text.trim(),
                                apiProtocol: protocol,
                                models: validModels,
                                activeModel:
                                    validModels.any((m) => m.id == activeModel)
                                    ? activeModel
                                    : (validModels.isEmpty
                                          ? ''
                                          : validModels.first.id),
                                temperature: existing?.temperature,
                                enableThinking: enableThinking,
                                imageGeneration: validModels.any(
                                  (m) => m.imageGeneration,
                                ),
                              );
                              setSheet(() {
                                saving = true;
                                saveError = null;
                              });
                              try {
                                await HarnessClient.instance.saveProvider(
                                  entry,
                                );
                                if (ctx.mounted) Navigator.pop(ctx);
                                await _load();
                                ref.read(providersProvider.notifier).refresh();
                              } catch (e) {
                                if (ctx.mounted) {
                                  setSheet(() => saveError = '保存失败：$e');
                                }
                              } finally {
                                if (ctx.mounted) setSheet(() => saving = false);
                              }
                            },
                      child: saving
                          ? const CupertinoActivityIndicator(
                              color: CupertinoColors.white,
                            )
                          : const Text(
                              '保存',
                              style: TextStyle(fontWeight: FontWeight.w600),
                            ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    nameCtrl.dispose();
    urlCtrl.dispose();
    keyCtrl.dispose();
    for (final controller in idCtrls) {
      controller.dispose();
    }
    for (final controller in ctxCtrls) {
      controller.dispose();
    }
    for (final controller in inCtrls) {
      controller.dispose();
    }
    for (final controller in outCtrls) {
      controller.dispose();
    }
  }

  /// 模型卡片：折叠显示摘要与能力徽章，展开后逐项编辑（移动端友好）。
  Widget _modelCard({
    required StateSetter setSheet,
    required List<ModelInfo> models,
    required List<TextEditingController> idCtrls,
    required List<TextEditingController> ctxCtrls,
    required List<TextEditingController> inCtrls,
    required List<TextEditingController> outCtrls,
    required int i,
    required String activeModel,
    required int? expandedIdx,
    required ValueChanged<int?> onExpand,
    required VoidCallback onSetDefault,
    required VoidCallback onDelete,
  }) {
    final p = DawnPalette.of(context);
    final m = models[i];
    final expanded = expandedIdx == i;
    final isDefault = m.id.isNotEmpty && m.id == activeModel;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // 折叠头
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => onExpand(expanded ? null : i),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Row(
              children: [
                Icon(
                  isDefault
                      ? CupertinoIcons.checkmark_circle_fill
                      : CupertinoIcons.circle,
                  size: 20,
                  color: isDefault ? iosGreen : p.separator,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        m.id.isEmpty ? '（未命名模型）' : m.id,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w500,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '上下文 ${m.contextWindowK}K · 入 ${m.inputPrice}/M · 出 ${m.outputPrice}/M',
                        style: TextStyle(fontSize: 11, color: p.ink2),
                      ),
                    ],
                  ),
                ),
                if (m.imageGeneration)
                  const Padding(
                    padding: EdgeInsets.only(left: 4),
                    child: Icon(
                      CupertinoIcons.paintbrush_fill,
                      size: 14,
                      color: iosPink,
                    ),
                  ),
                if (m.imageEditing)
                  const Padding(
                    padding: EdgeInsets.only(left: 4),
                    child: Icon(
                      CupertinoIcons.wand_stars,
                      size: 14,
                      color: iosPurple,
                    ),
                  ),
                const SizedBox(width: 6),
                Icon(
                  expanded
                      ? CupertinoIcons.chevron_up
                      : CupertinoIcons.chevron_down,
                  size: 14,
                  color: p.ink2,
                ),
              ],
            ),
          ),
        ),
        // 展开编辑区
        if (expanded)
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _miniField(
                  idCtrls[i],
                  '模型名称 / ID',
                  keyboardType: TextInputType.text,
                  onChanged: (value) =>
                      setSheet(() => models[i].id = value.trim()),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: _miniField(
                        ctxCtrls[i],
                        '上下文 (K)',
                        onChanged: (value) => setSheet(
                          () => models[i].contextWindowK =
                              int.tryParse(value.trim()) ?? 0,
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: _miniField(
                        inCtrls[i],
                        '输入价 /1M',
                        onChanged: (value) => setSheet(
                          () => models[i].inputPrice =
                              double.tryParse(value.trim()) ?? 0,
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: _miniField(
                        outCtrls[i],
                        '输出价 /1M',
                        onChanged: (value) => setSheet(
                          () => models[i].outputPrice =
                              double.tryParse(value.trim()) ?? 0,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                _capSwitch(
                  '支持图片生成',
                  m.imageGeneration,
                  (v) => setSheet(() => models[i].imageGeneration = v),
                ),
                _capSwitch(
                  '支持图片编辑（参考图）',
                  m.imageEditing,
                  (v) => setSheet(() => models[i].imageEditing = v),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    CupertinoButton(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 4,
                      ),
                      onPressed: onSetDefault,
                      minimumSize: Size(0, 0),
                      child: Text(
                        isDefault ? '已是默认 ✓' : '设为默认',
                        style: TextStyle(
                          fontSize: 13,
                          color: isDefault ? iosGreen : iosBlue,
                        ),
                      ),
                    ),
                    const Spacer(),
                    CupertinoButton(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 4,
                      ),
                      onPressed: onDelete,
                      minimumSize: Size(0, 0),
                      child: const Text(
                        '删除',
                        style: TextStyle(fontSize: 13, color: iosRed),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _capSwitch(String label, bool value, ValueChanged<bool> onChanged) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: const TextStyle(fontSize: 14, letterSpacing: -0.2),
            ),
          ),
          CupertinoSwitch(
            activeTrackColor: iosGreen,
            value: value,
            onChanged: onChanged,
          ),
        ],
      ),
    );
  }

  Widget _miniField(
    TextEditingController ctrl,
    String label, {
    TextInputType keyboardType = const TextInputType.numberWithOptions(
      decimal: true,
    ),
    ValueChanged<String>? onChanged,
  }) {
    final p = DawnPalette.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 10, color: p.ink2)),
        const SizedBox(height: 3),
        CupertinoTextField(
          controller: ctrl,
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          decoration: BoxDecoration(
            color: p.groupedBg,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: p.separator),
          ),
          style: TextStyle(fontSize: 12, color: p.ink),
          keyboardType: keyboardType,
          onChanged: onChanged,
        ),
      ],
    );
  }

  Widget _field(
    TextEditingController ctrl,
    String label, {
    String? hint,
    bool obscure = false,
  }) {
    final p = DawnPalette.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 13, color: p.ink2)),
        const SizedBox(height: 5),
        CupertinoTextField(
          controller: ctrl,
          obscureText: obscure,
          placeholder: hint,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: p.cardBg,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: p.separator),
          ),
          style: TextStyle(fontSize: 15, letterSpacing: -0.3, color: p.ink),
        ),
      ],
    );
  }
}

class _RemoteModelPicker extends StatefulWidget {
  const _RemoteModelPicker({
    required this.urlController,
    required this.apiKeyController,
    required this.apiProtocol,
    required this.existingModelIds,
    required this.onAdd,
  });

  final TextEditingController urlController;
  final TextEditingController apiKeyController;
  final String apiProtocol;
  final List<String> existingModelIds;
  final ValueChanged<List<String>> onAdd;

  @override
  State<_RemoteModelPicker> createState() => _RemoteModelPickerState();
}

class _RemoteModelPickerState extends State<_RemoteModelPicker> {
  Timer? _debounce;
  int _requestId = 0;
  List<String> _models = const [];
  bool _loading = false;
  String? _error;

  List<String> get _availableModels {
    final configured = widget.existingModelIds.toSet();
    return _models.where((model) => !configured.contains(model)).toList();
  }

  @override
  void initState() {
    super.initState();
    widget.urlController.addListener(_scheduleFetch);
    widget.apiKeyController.addListener(_scheduleFetch);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _scheduleFetch();
    });
  }

  @override
  void didUpdateWidget(covariant _RemoteModelPicker oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.urlController != widget.urlController) {
      oldWidget.urlController.removeListener(_scheduleFetch);
      widget.urlController.addListener(_scheduleFetch);
    }
    if (oldWidget.apiKeyController != widget.apiKeyController) {
      oldWidget.apiKeyController.removeListener(_scheduleFetch);
      widget.apiKeyController.addListener(_scheduleFetch);
    }
    if (oldWidget.apiProtocol != widget.apiProtocol) _scheduleFetch();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _requestId += 1;
    widget.urlController.removeListener(_scheduleFetch);
    widget.apiKeyController.removeListener(_scheduleFetch);
    super.dispose();
  }

  void _scheduleFetch() {
    if (!mounted) return;
    _debounce?.cancel();
    _requestId += 1;
    final ready =
        widget.urlController.text.trim().isNotEmpty &&
        widget.apiKeyController.text.trim().isNotEmpty;
    if (!ready) {
      if (mounted) {
        setState(() {
          _models = const [];
          _loading = false;
          _error = null;
        });
      }
      return;
    }
    if (mounted) {
      setState(() {
        _models = const [];
        _loading = false;
        _error = null;
      });
    }
    _debounce = Timer(const Duration(milliseconds: 700), _fetchModels);
  }

  Future<void> _fetchModels() async {
    _debounce?.cancel();
    _debounce = null;
    final baseUrl = widget.urlController.text.trim();
    final apiKey = widget.apiKeyController.text.trim();
    if (baseUrl.isEmpty || apiKey.isEmpty) return;

    final requestId = ++_requestId;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final models = await HarnessClient.instance.fetchProviderModels(
        baseUrl: baseUrl,
        apiKey: apiKey,
        apiProtocol: widget.apiProtocol,
      );
      if (!mounted || requestId != _requestId) return;
      setState(() {
        _models = models;
        _loading = false;
      });
    } catch (error) {
      if (!mounted || requestId != _requestId) return;
      setState(() {
        _models = const [];
        _loading = false;
        _error = error.toString();
      });
    }
  }

  Future<void> _showSelector() async {
    final available = _availableModels;
    if (available.isEmpty) return;
    final queryController = TextEditingController();
    final selected = <String>{};
    final result = await showCupertinoModalPopup<List<String>>(
      context: context,
      builder: (sheetContext) {
        final palette = DawnPalette.of(sheetContext);
        return StatefulBuilder(
          builder: (sheetContext, setSheet) {
            final query = queryController.text.trim().toLowerCase();
            final visible = query.isEmpty
                ? available
                : available
                      .where((model) => model.toLowerCase().contains(query))
                      .toList();
            return Container(
              height: MediaQuery.of(sheetContext).size.height * 0.72,
              decoration: BoxDecoration(
                color: palette.groupedBg,
                borderRadius: const BorderRadius.vertical(
                  top: Radius.circular(14),
                ),
              ),
              child: SafeArea(
                top: false,
                child: Column(
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            '选择远端模型',
                            style: TextStyle(
                              fontSize: 17,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(height: 10),
                          CupertinoSearchTextField(
                            controller: queryController,
                            placeholder: '模糊搜索模型名称',
                            onChanged: (_) => setSheet(() {}),
                          ),
                        ],
                      ),
                    ),
                    Container(height: 1, color: palette.separator),
                    Expanded(
                      child: visible.isEmpty
                          ? Center(
                              child: Text(
                                '没有匹配的模型',
                                style: TextStyle(color: palette.ink2),
                              ),
                            )
                          : ListView.builder(
                              itemCount: visible.length,
                              itemBuilder: (context, index) {
                                final model = visible[index];
                                final checked = selected.contains(model);
                                return GestureDetector(
                                  behavior: HitTestBehavior.opaque,
                                  onTap: () => setSheet(() {
                                    if (!selected.add(model)) {
                                      selected.remove(model);
                                    }
                                  }),
                                  child: Container(
                                    constraints: const BoxConstraints(
                                      minHeight: 48,
                                    ),
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 16,
                                      vertical: 10,
                                    ),
                                    decoration: BoxDecoration(
                                      border: Border(
                                        bottom: BorderSide(
                                          color: palette.separator,
                                          width: 0.5,
                                        ),
                                      ),
                                    ),
                                    child: Row(
                                      children: [
                                        Expanded(
                                          child: Text(
                                            model,
                                            maxLines: 2,
                                            overflow: TextOverflow.ellipsis,
                                            style: TextStyle(
                                              fontSize: 14,
                                              color: palette.ink,
                                            ),
                                          ),
                                        ),
                                        const SizedBox(width: 12),
                                        Icon(
                                          checked
                                              ? CupertinoIcons
                                                    .checkmark_square_fill
                                              : CupertinoIcons.square,
                                          size: 21,
                                          color: checked
                                              ? iosBlue
                                              : palette.ink2,
                                        ),
                                      ],
                                    ),
                                  ),
                                );
                              },
                            ),
                    ),
                    Container(height: 1, color: palette.separator),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 8, 16, 6),
                      child: Row(
                        children: [
                          CupertinoButton(
                            onPressed: () => Navigator.pop(sheetContext),
                            child: const Text('取消'),
                          ),
                          const Spacer(),
                          CupertinoButton.filled(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 18,
                              vertical: 9,
                            ),
                            onPressed: selected.isEmpty
                                ? null
                                : () => Navigator.pop(
                                    sheetContext,
                                    selected.toList()..sort(),
                                  ),
                            child: Text('添加所选 (${selected.length})'),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
    queryController.dispose();
    if (mounted && result != null && result.isNotEmpty) widget.onAdd(result);
  }

  @override
  Widget build(BuildContext context) {
    final palette = DawnPalette.of(context);
    final available = _availableModels;
    final ready =
        widget.urlController.text.trim().isNotEmpty &&
        widget.apiKeyController.text.trim().isNotEmpty;
    final status = !ready
        ? '填写 Base URL 和 API Key 后自动拉取'
        : _loading
        ? '正在拉取远端模型...'
        : _error != null
        ? '拉取失败：$_error'
        : _models.isEmpty
        ? '暂无远端模型'
        : available.isEmpty
        ? '拉取到的模型均已添加'
        : '已拉取 ${_models.length} 个模型，可添加 ${available.length} 个';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '从供应商选择模型（可多选）',
          style: TextStyle(fontSize: 13, color: palette.ink2),
        ),
        const SizedBox(height: 5),
        Row(
          children: [
            Expanded(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: available.isEmpty ? null : _showSelector,
                child: Container(
                  constraints: const BoxConstraints(minHeight: 42),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 9,
                  ),
                  decoration: BoxDecoration(
                    color: palette.cardBg,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: palette.separator),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          available.isEmpty
                              ? '选择远端模型'
                              : '选择远端模型（${available.length}）',
                          style: TextStyle(
                            fontSize: 14,
                            color: available.isEmpty
                                ? palette.ink2
                                : palette.ink,
                          ),
                        ),
                      ),
                      Icon(
                        CupertinoIcons.chevron_down,
                        size: 14,
                        color: palette.ink2,
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(width: 6),
            CupertinoButton(
              padding: const EdgeInsets.all(9),
              minimumSize: const Size(40, 40),
              onPressed: ready && !_loading ? _fetchModels : null,
              child: _loading
                  ? const CupertinoActivityIndicator(radius: 8)
                  : const Icon(CupertinoIcons.refresh, size: 20),
            ),
          ],
        ),
        const SizedBox(height: 5),
        Text(
          status,
          style: TextStyle(
            fontSize: 11,
            color: _error == null ? palette.ink2 : iosRed,
          ),
        ),
      ],
    );
  }
}

class _AgentsCard extends ConsumerStatefulWidget {
  const _AgentsCard();

  @override
  ConsumerState<_AgentsCard> createState() => _AgentsCardState();
}

class _AgentsCardState extends ConsumerState<_AgentsCard> {
  List<AgentDefinition>? _agents;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final agents = await HarnessClient.instance.listAgents();
      if (mounted) setState(() => _agents = agents);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    return IosSection(
      header: 'Agent 工作区',
      footer: '对话页新建会话时可绑定 Agent（人设 + 独立供应商/模型）',
      children: [
        if (_agents == null)
          const Padding(
            padding: EdgeInsets.all(16),
            child: CupertinoActivityIndicator(),
          )
        else if (_agents!.isEmpty)
          IosRow(
            icon: CupertinoIcons.person_crop_circle_badge_plus,
            iconColor: iosBlue,
            title: '新建 Agent',
            onTap: () => _editAgent(null),
          )
        else
          for (final a in _agents!)
            IosRow(
              icon: CupertinoIcons.person_fill,
              iconColor: iosTeal,
              title: '${a.icon.isEmpty ? '🤖' : a.icon} ${a.name}',
              subtitle: a.description.isEmpty ? a.systemPrompt : a.description,
              onTap: () => _editAgent(a),
            ),
      ],
    );
  }

  Future<void> _editAgent(AgentDefinition? existing) async {
    final p = DawnPalette.of(context);
    final providers = await HarnessClient.instance.listProviders();
    final providerList = (providers['providers'] as List?)?.cast<Map>() ?? [];
    final nameCtrl = TextEditingController(text: existing?.name ?? '');
    final iconCtrl = TextEditingController(
      text: existing?.icon.isEmpty == true ? '🤖' : existing?.icon ?? '🤖',
    );
    final descCtrl = TextEditingController(text: existing?.description ?? '');
    final promptCtrl = TextEditingController(
      text: existing?.systemPrompt ?? '',
    );
    String? providerId = existing?.providerId;

    if (!mounted) return;
    await showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => Container(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.9,
        ),
        decoration: BoxDecoration(
          color: p.groupedBg,
          borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
        ),
        child: SafeArea(
          child: StatefulBuilder(
            builder: (ctx, setSheet) => SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    existing == null ? '新建 Agent' : '编辑 Agent',
                    style: const TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w600,
                      letterSpacing: -0.4,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      SizedBox(
                        width: 60,
                        child: CupertinoTextField(
                          controller: iconCtrl,
                          textAlign: TextAlign.center,
                          padding: const EdgeInsets.symmetric(vertical: 10),
                          decoration: BoxDecoration(
                            color: p.cardBg,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: p.separator),
                          ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(child: _field(nameCtrl, '名称')),
                    ],
                  ),
                  const SizedBox(height: 10),
                  _field(descCtrl, '描述'),
                  const SizedBox(height: 10),
                  _field(promptCtrl, '人设（系统提示词）'),
                  const SizedBox(height: 12),
                  Text(
                    '绑定供应商（可选）',
                    style: TextStyle(fontSize: 13, color: p.ink2),
                  ),
                  const SizedBox(height: 6),
                  CupertinoSlidingSegmentedControl<String>(
                    groupValue: providerId ?? '',
                    children: {
                      '': const Padding(
                        padding: EdgeInsets.symmetric(vertical: 5),
                        child: Text('默认', style: TextStyle(fontSize: 12)),
                      ),
                      for (final p in providerList)
                        p['id'] as String: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 5),
                          child: Text(
                            (p['name'] as String?) ?? '',
                            style: const TextStyle(fontSize: 12),
                          ),
                        ),
                    },
                    onValueChanged: (v) => setSheet(
                      () => providerId = (v == null || v.isEmpty) ? null : v,
                    ),
                  ),
                  const SizedBox(height: 14),
                  SizedBox(
                    width: double.infinity,
                    child: CupertinoButton.filled(
                      onPressed: () async {
                        if (nameCtrl.text.trim().isEmpty) return;
                        await HarnessClient.instance.saveAgent(
                          AgentDefinition(
                            id: existing?.id ?? '',
                            name: nameCtrl.text.trim(),
                            icon: iconCtrl.text.trim(),
                            description: descCtrl.text.trim(),
                            systemPrompt: promptCtrl.text,
                            providerId: providerId,
                            modelId: existing?.modelId,
                            reasoningStrength:
                                existing?.reasoningStrength ?? 'medium',
                            skillIds: existing?.skillIds ?? const [],
                            allowedTools: existing?.allowedTools ?? const [],
                            deniedTools: existing?.deniedTools ?? const [],
                            memoryScopes:
                                existing?.memoryScopes ??
                                const ['user', 'agent', 'project'],
                            memoryWritePolicy:
                                existing?.memoryWritePolicy ??
                                const {
                                  'allowUserTraits': true,
                                  'allowAgentSkills': true,
                                  'allowSteps': true,
                                  'allowKnowledge': true,
                                },
                            autoReplyPolicy:
                                existing?.autoReplyPolicy ??
                                const {
                                  'enabled': false,
                                  'requireMention': true,
                                },
                            createdAt: existing?.createdAt ?? '',
                            updatedAt: existing?.updatedAt ?? '',
                          ),
                        );
                        if (ctx.mounted) Navigator.pop(ctx);
                        await _load();
                        ref.read(agentsProvider.notifier).refresh();
                      },
                      child: const Text(
                        '保存',
                        style: TextStyle(fontWeight: FontWeight.w600),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _field(TextEditingController ctrl, String label, {String? hint}) {
    final p = DawnPalette.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 13, color: p.ink2)),
        const SizedBox(height: 5),
        CupertinoTextField(
          controller: ctrl,
          placeholder: hint,
          maxLines: label.contains('人设') ? 3 : 1,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: p.cardBg,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: p.separator),
          ),
          style: TextStyle(fontSize: 15, letterSpacing: -0.3, color: p.ink),
        ),
      ],
    );
  }
}

class _AgentGroupsCard extends ConsumerWidget {
  const _AgentGroupsCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final agents = ref.watch(agentsProvider).value ?? const <AgentDefinition>[];
    final agentsById = {for (final agent in agents) agent.id: agent};
    return ref
        .watch(agentGroupsProvider)
        .when(
          loading: () => const IosSection(
            header: 'Agent 群组',
            children: [
              Padding(
                padding: EdgeInsets.all(16),
                child: CupertinoActivityIndicator(),
              ),
            ],
          ),
          error: (error, _) => IosSection(
            header: 'Agent 群组',
            children: [
              IosRow(
                icon: CupertinoIcons.exclamationmark_circle_fill,
                iconColor: iosRed,
                title: '群组加载失败',
                subtitle: '$error',
                onTap: () => ref.read(agentGroupsProvider.notifier).refresh(),
              ),
            ],
          ),
          data: (groups) => IosSection(
            header: 'Agent 群组',
            footer: 'AI 可通过 create_agent_group 创建群组；群组协作页可直接选择并发起讨论',
            children: groups.isEmpty
                ? const [
                    IosRow(
                      icon: CupertinoIcons.person_2_fill,
                      iconColor: iosIndigo,
                      title: '暂无群组',
                      subtitle: '在对话中让 AI 创建，创建后会自动出现在这里',
                    ),
                  ]
                : [
                    for (final group in groups)
                      IosRow(
                        icon: CupertinoIcons.person_2_fill,
                        iconColor: iosIndigo,
                        title:
                            '${group.icon.isEmpty ? '👥' : group.icon} ${group.name}',
                        subtitle: _groupSummary(group, agentsById),
                        onTap: () => _showActions(context, ref, group),
                      ),
                  ],
          ),
        );
  }

  String _groupSummary(
    AgentGroupDefinition group,
    Map<String, AgentDefinition> agentsById,
  ) {
    final coordinator =
        agentsById[group.coordinatorAgentId]?.name ?? group.coordinatorAgentId;
    final members = group.memberAgentIds
        .map((id) => agentsById[id]?.name ?? id)
        .where((name) => name.isNotEmpty)
        .join('、');
    return '协调者：$coordinator · 成员：$members';
  }

  void _showActions(
    BuildContext context,
    WidgetRef ref,
    AgentGroupDefinition group,
  ) {
    showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        title: Text(group.name),
        message: group.description.isEmpty ? null : Text(group.description),
        actions: [
          CupertinoActionSheetAction(
            isDestructiveAction: true,
            onPressed: () async {
              Navigator.pop(ctx);
              await HarnessClient.instance.deleteAgentGroup(group.id);
              await ref.read(agentGroupsProvider.notifier).refresh();
            },
            child: const Text('删除群组'),
          ),
        ],
        cancelButton: CupertinoActionSheetAction(
          onPressed: () => Navigator.pop(ctx),
          child: const Text('取消'),
        ),
      ),
    );
  }
}

// ================= 记忆 =================

class _MemoryCard extends ConsumerStatefulWidget {
  const _MemoryCard();

  @override
  ConsumerState<_MemoryCard> createState() => _MemoryCardState();
}

class _MemoryCardState extends ConsumerState<_MemoryCard> {
  final _queryCtrl = TextEditingController();
  List<dynamic>? _hits;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return IosSection(
      header: '长期记忆',
      footer: 'FTS5 全文检索（中文自动回退子串匹配）',
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 8),
          child: Row(
            children: [
              Expanded(
                child: CupertinoSearchTextField(
                  controller: _queryCtrl,
                  placeholder: '关键词检索',
                  onSubmitted: (_) => _search(),
                ),
              ),
              const SizedBox(width: 8),
              CupertinoButton(
                padding: const EdgeInsets.all(6),
                onPressed: () => _showAddDialog(context),
                minimumSize: Size(0, 0),
                child: const Icon(
                  CupertinoIcons.add_circled,
                  size: 22,
                  color: iosBlue,
                ),
              ),
            ],
          ),
        ),
        if (_hits != null)
          if (_hits!.isEmpty)
            IosRow(
              icon: CupertinoIcons.search,
              iconColor: p.ink2,
              title: '无匹配记忆',
            )
          else
            for (final h in _hits!)
              IosRow(
                icon: CupertinoIcons.sparkles,
                iconColor: iosPink,
                title: (h as Map)['content']?.toString() ?? '',
                onTap: () async {
                  final id = (h['id'] as num?)?.toInt() ?? 0;
                  await HarnessClient.instance.deleteMemory(id);
                  _search();
                },
              ),
      ],
    );
  }

  Future<void> _search() async {
    final query = _queryCtrl.text.trim();
    if (query.isEmpty) return;
    try {
      final result = await HarnessClient.instance.searchMemory(query);
      setState(() => _hits = result?['hits'] as List? ?? []);
    } catch (e) {
      setState(
        () => _hits = [
          {'content': '检索失败：$e'},
        ],
      );
    }
  }

  Future<void> _showAddDialog(BuildContext context) async {
    final ctrl = TextEditingController();
    await showCupertinoDialog<void>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: const Text('添加记忆'),
        content: Padding(
          padding: const EdgeInsets.only(top: 10),
          child: CupertinoTextField(
            controller: ctrl,
            maxLines: 3,
            autofocus: true,
          ),
        ),
        actions: [
          CupertinoDialogAction(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('取消'),
          ),
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () async {
              if (ctrl.text.isNotEmpty) {
                await HarnessClient.instance.addMemory(ctrl.text);
              }
              if (ctx.mounted) Navigator.pop(ctx);
              _search();
            },
            child: const Text('保存'),
          ),
        ],
      ),
    );
  }
}

// ================= MCP =================

class _McpCard extends ConsumerStatefulWidget {
  const _McpCard();

  @override
  ConsumerState<_McpCard> createState() => _McpCardState();
}

class _McpCardState extends ConsumerState<_McpCard> {
  dynamic _mcpState;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final state = await HarnessClient.instance.mcpList();
      if (mounted) setState(() => _mcpState = state);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final servers = _mcpState?['servers'] as List? ?? [];
    final tools = _mcpState?['tools'] as List? ?? [];
    return IosSection(
      header: 'MCP 服务',
      footer: '配置存于 settings.mcpServers；移动端仅远程传输可用',
      children: [
        IosRow(
          icon: CupertinoIcons.cube_box_fill,
          iconColor: iosOrange,
          title: '已连接 $servers 个 server',
          subtitle: '共 ${tools.length} 个工具',
          trailing: CupertinoButton(
            padding: const EdgeInsets.all(4),
            onPressed: _loading
                ? null
                : () async {
                    setState(() => _loading = true);
                    try {
                      final cfg = await HarnessClient.instance.getSetting(
                        'mcpServers',
                      );
                      await HarnessClient.instance.mcpReload(
                        (cfg?['value'] as List?) ?? [],
                      );
                      await _load();
                    } finally {
                      if (mounted) setState(() => _loading = false);
                    }
                  },
            minimumSize: Size(0, 0),
            child: _loading
                ? const CupertinoActivityIndicator()
                : const Text(
                    '重载',
                    style: TextStyle(fontSize: 14, color: iosBlue),
                  ),
          ),
        ),
        for (final t in tools.take(8))
          IosRow(
            icon: CupertinoIcons.wrench_fill,
            iconColor: iosTeal,
            title: '${(t as Map)['server']}/${t['name']}',
          ),
      ],
    );
  }
}

// ================= 高级（连接/关于）=================

class _AdvancedCard extends ConsumerStatefulWidget {
  const _AdvancedCard();

  @override
  ConsumerState<_AdvancedCard> createState() => _AdvancedCardState();
}

class _AdvancedCardState extends ConsumerState<_AdvancedCard> {
  @override
  Widget build(BuildContext context) {
    return const IosSection(
      header: '关于',
      footer: 'harness 以进程内 FFI 运行，随应用启动与退出，无需配置',
      children: [
        IosRow(
          icon: CupertinoIcons.info_circle_fill,
          iconColor: iosBlue,
          title: 'WorldBase Mobile',
          subtitle: 'Rust Harness v0.1 · 协议 1.0 · 进程内 FFI',
        ),
      ],
    );
  }
}

// ================= 用量统计 =================

class _UsageCard extends ConsumerStatefulWidget {
  const _UsageCard();

  @override
  ConsumerState<_UsageCard> createState() => _UsageCardState();
}

class _UsageCardState extends ConsumerState<_UsageCard> {
  UsageSummary? _summary;
  bool _expanded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final summary = await HarnessClient.instance.usageSummary(days: 30);
      if (mounted) setState(() => _summary = summary);
    } catch (_) {}
  }

  String _fmtTokens(int n) {
    if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}K';
    return '$n';
  }

  @override
  Widget build(BuildContext context) {
    final s = _summary;
    final p = DawnPalette.of(context);
    return IosSection(
      header: '用量（近 30 天）',
      footer: '每次对话按供应商模型单价（/1M tokens）记账',
      children: [
        if (s == null)
          const Padding(
            padding: EdgeInsets.all(16),
            child: CupertinoActivityIndicator(),
          )
        else ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
            child: Row(
              children: [
                _statBlock('成本', s.totalCost.toStringAsFixed(4), iosBlue),
                const SizedBox(width: 12),
                _statBlock(
                  '输入 tokens',
                  _fmtTokens(s.totalInputTokens),
                  iosGreen,
                ),
                const SizedBox(width: 12),
                _statBlock(
                  '输出 tokens',
                  _fmtTokens(s.totalOutputTokens),
                  iosOrange,
                ),
              ],
            ),
          ),
          if (s.daily.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
              child: SizedBox(height: 64, child: _DailyBars(daily: s.daily)),
            ),
          CupertinoButton(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            onPressed: () => setState(() => _expanded = !_expanded),
            minimumSize: Size(0, 0),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                _expanded ? '收起按模型明细 ▲' : '按模型明细 ▼',
                style: const TextStyle(fontSize: 13, color: iosBlue),
              ),
            ),
          ),
          if (_expanded)
            for (final m in s.byModel)
              IosRow(
                icon: CupertinoIcons.chart_bar_fill,
                iconColor: iosIndigo,
                title: m['model']?.toString() ?? '',
                subtitle:
                    '输入 ${_fmtTokens((m['inputTokens'] as num?)?.toInt() ?? 0)} · 输出 ${_fmtTokens((m['outputTokens'] as num?)?.toInt() ?? 0)}',
                trailing: Text(
                  '¥${((m['cost'] as num?)?.toDouble() ?? 0).toStringAsFixed(4)}',
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
          if (s.byModel.isEmpty && _expanded)
            IosRow(
              icon: CupertinoIcons.chart_bar,
              iconColor: p.ink2,
              title: '暂无用量记录',
            ),
        ],
      ],
    );
  }

  Widget _statBlock(String label, String value, Color color) {
    final p = DawnPalette.of(context);
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: TextStyle(fontSize: 11, color: p.ink2)),
            const SizedBox(height: 2),
            Text(
              value,
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                color: color,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 每日用量柱状图（纯自绘，无三方依赖）。
class _DailyBars extends StatelessWidget {
  const _DailyBars({required this.daily});

  final List<Map<String, dynamic>> daily;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    final days = daily.reversed.take(14).toList();
    final maxCost = days
        .map((d) => (d['cost'] as num?)?.toDouble() ?? 0)
        .fold(0.0000001, (a, b) => a > b ? a : b);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        for (final d in days)
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  FractionallySizedBox(
                    widthFactor: 1,
                    child: Container(
                      height:
                          54 *
                          (((d['cost'] as num?)?.toDouble() ?? 0) / maxCost)
                              .clamp(0.04, 1.0),
                      decoration: BoxDecoration(
                        color: iosBlue.withValues(alpha: 0.75),
                        borderRadius: BorderRadius.circular(3),
                      ),
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    (d['day'] as String).substring(5),
                    style: TextStyle(fontSize: 8, color: p.ink2),
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

// ================= 技能 =================

class _SkillsCard extends ConsumerStatefulWidget {
  const _SkillsCard();

  @override
  ConsumerState<_SkillsCard> createState() => _SkillsCardState();
}

class _SkillsCardState extends ConsumerState<_SkillsCard> {
  List<SkillDescriptor>? _skills;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final skills = await HarnessClient.instance.listSkills();
      if (mounted) setState(() => _skills = skills);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return IosSection(
      header: '技能',
      footer: '技能以 YAML 存于 harness，Agent 可调用',
      children: [
        if (_skills == null)
          const Padding(
            padding: EdgeInsets.all(16),
            child: CupertinoActivityIndicator(),
          )
        else if (_skills!.isEmpty)
          IosRow(
            icon: CupertinoIcons.sparkles,
            iconColor: p.ink2,
            title: '暂无技能，点按新建',
            onTap: () => _createSkill(context),
          )
        else
          for (final s in _skills!)
            IosRow(
              icon: CupertinoIcons.doc_text_fill,
              iconColor: iosOrange,
              title: s.name,
              subtitle: s.description,
              onTap: () => _showSkill(context, s),
            ),
        IosRow(
          icon: CupertinoIcons.add_circled,
          iconColor: iosBlue,
          title: '新建技能',
          onTap: () => _createSkill(context),
        ),
      ],
    );
  }

  void _showSkill(BuildContext context, SkillDescriptor skill) {
    final p = DawnPalette.of(context);
    showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => Container(
        decoration: BoxDecoration(
          color: p.groupedBg,
          borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
        ),
        child: SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 14, 20, 6),
                child: Text(
                  skill.name,
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              IosSection(
                children: [
                  IosRow(
                    icon: CupertinoIcons.doc_plaintext,
                    iconColor: iosBlue,
                    title: skill.description.isEmpty
                        ? '（无描述）'
                        : skill.description,
                    subtitle: skill.instructions,
                  ),
                  IosRow(
                    icon: CupertinoIcons.trash_fill,
                    iconColor: iosRed,
                    title: '删除技能',
                    onTap: () async {
                      await HarnessClient.instance.deleteSkill(skill.name);
                      if (ctx.mounted) Navigator.pop(ctx);
                      _load();
                    },
                  ),
                ],
              ),
              const SizedBox(height: 12),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _createSkill(BuildContext context) async {
    final nameCtrl = TextEditingController();
    final descCtrl = TextEditingController();
    final instrCtrl = TextEditingController();
    final whenCtrl = TextEditingController();
    final toolsCtrl = TextEditingController();
    final argsCtrl = TextEditingController();
    var skillContext = 'inline';
    var saving = false;
    String? error;

    List<SkillArgument> parseArguments(String raw) {
      final value = raw.trim();
      if (value.isEmpty) return const [];
      if (value.startsWith('[')) {
        final decoded = jsonDecode(value);
        if (decoded is! List) {
          throw const FormatException('参数 JSON 必须是数组');
        }
        return decoded
            .whereType<Map>()
            .map((item) => SkillArgument.fromJson(item.cast()))
            .where((argument) => argument.name.trim().isNotEmpty)
            .toList();
      }
      return value
          .split(RegExp(r'[,\n]'))
          .map((item) => item.trim())
          .where((item) => item.isNotEmpty)
          .map((name) => SkillArgument(name: name))
          .toList();
    }

    await showCupertinoDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialog) => CupertinoAlertDialog(
          title: const Text('新建技能（YAML）'),
          content: Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Column(
              children: [
                CupertinoTextField(
                  controller: nameCtrl,
                  placeholder: '名称（英文标识）',
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 8,
                  ),
                ),
                const SizedBox(height: 8),
                CupertinoTextField(
                  controller: descCtrl,
                  placeholder: '描述',
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 8,
                  ),
                ),
                const SizedBox(height: 8),
                CupertinoTextField(
                  controller: whenCtrl,
                  placeholder: '何时使用（可选）',
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 8,
                  ),
                ),
                const SizedBox(height: 8),
                CupertinoTextField(
                  controller: toolsCtrl,
                  placeholder: '允许工具（逗号分隔，可选）',
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 8,
                  ),
                ),
                const SizedBox(height: 8),
                CupertinoTextField(
                  controller: argsCtrl,
                  placeholder: '参数名（逗号分隔，或 JSON 数组）',
                  maxLines: 2,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 8,
                  ),
                ),
                const SizedBox(height: 8),
                CupertinoSlidingSegmentedControl<String>(
                  groupValue: skillContext,
                  children: const {
                    'inline': Padding(
                      padding: EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 5,
                      ),
                      child: Text('inline'),
                    ),
                    'fork': Padding(
                      padding: EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 5,
                      ),
                      child: Text('fork'),
                    ),
                  },
                  onValueChanged: (value) {
                    if (saving) return;
                    setDialog(() => skillContext = value ?? skillContext);
                  },
                ),
                const SizedBox(height: 8),
                CupertinoTextField(
                  controller: instrCtrl,
                  placeholder: '指令内容',
                  maxLines: 4,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 8,
                  ),
                ),
                if (error != null) ...[
                  const SizedBox(height: 6),
                  Text(
                    error!,
                    style: const TextStyle(fontSize: 12, color: iosRed),
                  ),
                ],
              ],
            ),
          ),
          actions: [
            CupertinoDialogAction(
              onPressed: saving ? null : () => Navigator.pop(ctx),
              child: const Text('取消'),
            ),
            CupertinoDialogAction(
              isDefaultAction: true,
              onPressed: saving
                  ? null
                  : () async {
                      if (nameCtrl.text.trim().isEmpty ||
                          instrCtrl.text.trim().isEmpty) {
                        setDialog(() => error = '名称和指令内容不能为空');
                        return;
                      }
                      List<SkillArgument> arguments;
                      try {
                        arguments = parseArguments(argsCtrl.text);
                      } catch (e) {
                        setDialog(() => error = '$e');
                        return;
                      }
                      setDialog(() {
                        saving = true;
                        error = null;
                      });
                      try {
                        await HarnessClient.instance.saveSkill(
                          nameCtrl.text.trim(),
                          descCtrl.text.trim(),
                          instrCtrl.text,
                          whenToUse: whenCtrl.text,
                          arguments: arguments,
                          allowedTools: toolsCtrl.text
                              .split(RegExp(r'[,\n]'))
                              .map((tool) => tool.trim())
                              .where((tool) => tool.isNotEmpty)
                              .toList(),
                          context: skillContext,
                        );
                        if (ctx.mounted) Navigator.pop(ctx);
                        _load();
                      } catch (e) {
                        if (ctx.mounted) {
                          setDialog(() {
                            saving = false;
                            error = '$e';
                          });
                        }
                      }
                    },
              child: const Text('保存'),
            ),
          ],
        ),
      ),
    );
  }
}

// ================= 定时任务 =================

class _SchedulesCard extends ConsumerStatefulWidget {
  const _SchedulesCard();

  @override
  ConsumerState<_SchedulesCard> createState() => _SchedulesCardState();
}

class _SchedulesCardState extends ConsumerState<_SchedulesCard> {
  List<ScheduleEntry>? _schedules;
  List<SkillDescriptor> _skills = const [];
  List<McpServerSnapshot> _mcpServers = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final schedules = await HarnessClient.instance.listSchedules();
      if (mounted) setState(() => _schedules = schedules);
    } catch (_) {}
    try {
      final skills = await HarnessClient.instance.listSkills();
      if (mounted) setState(() => _skills = skills);
    } catch (_) {}
    try {
      final state = await HarnessClient.instance.getMcpState();
      if (mounted) setState(() => _mcpServers = state.servers);
    } catch (_) {}
  }

  String _scheduleLabel(ScheduleEntry entry) {
    final schedule = entry.schedule;
    if (schedule == null || schedule.kind == 'cron') {
      return entry.cron.isEmpty ? '未设置' : 'cron ${entry.cron}';
    }
    switch (schedule.kind) {
      case 'once':
        return '一次性 ${schedule.runAt ?? '-'}';
      case 'interval':
        final start = schedule.startAt == null
            ? ''
            : ' · 起始 ${schedule.startAt}';
        return '每 ${schedule.everyMinutes ?? '-'} 分钟$start';
      case 'daily':
        return '每天 ${schedule.timeOfDay ?? '-'}';
      case 'weekly':
        final days = schedule.weekdays.isEmpty
            ? '-'
            : schedule.weekdays.join(',');
        return '每周 $days · ${schedule.timeOfDay ?? '-'}';
      case 'dates':
        return '指定日期 ${schedule.dates.length} 次';
      default:
        return schedule.kind;
    }
  }

  String _statusLabel(ScheduleEntry entry) {
    final status = entry.lastStatus.isEmpty ? 'idle' : entry.lastStatus;
    final enabled = entry.enabled ? '已启用' : '已停用';
    final next = entry.nextRunAt == null ? '' : ' · 下次 ${entry.nextRunAt}';
    final retry = entry.retryPolicy.maxRetries > 0
        ? ' · 重试 ${entry.retryPolicy.maxRetries} 次'
        : '';
    return '$enabled · $status$retry$next';
  }

  String _policyLabel(ScheduleEntry entry) {
    final skills = entry.selectedSkillIds.length;
    final mcp = entry.selectedMcpServerIds.length;
    if (skills == 0 && mcp == 0) return '';
    return ' · 技能 $skills · MCP $mcp';
  }

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return IosSection(
      header: '定时任务',
      footer: '移动端语义降级：iOS 后台触发受限，由系统补跑',
      children: [
        if (_schedules == null)
          const Padding(
            padding: EdgeInsets.all(16),
            child: CupertinoActivityIndicator(),
          )
        else if (_schedules!.isEmpty)
          IosRow(icon: CupertinoIcons.alarm, iconColor: p.ink2, title: '暂无任务')
        else
          for (final s in _schedules!)
            IosRow(
              icon: CupertinoIcons.alarm_fill,
              iconColor: s.enabled ? iosGreen : p.ink2,
              title: s.name,
              subtitle:
                  '${_scheduleLabel(s)} · ${_statusLabel(s)}${_policyLabel(s)}',
              onTap: () => _showActions(context, s),
            ),
        IosRow(
          icon: CupertinoIcons.add_circled,
          iconColor: iosBlue,
          title: '新建任务',
          onTap: () => _create(context),
        ),
      ],
    );
  }

  void _showActions(BuildContext context, ScheduleEntry s) {
    showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        title: Text(s.name),
        message: Text('${_scheduleLabel(s)}\n${_statusLabel(s)}\n任务：${s.task}'),
        actions: [
          CupertinoActionSheetAction(
            onPressed: () async {
              Navigator.pop(ctx);
              try {
                await HarnessClient.instance.updateSchedule(
                  s.id,
                  enabled: !s.enabled,
                );
                await _load();
              } catch (e) {
                if (context.mounted) _showError(context, e);
              }
            },
            child: Text(s.enabled ? '停用' : '启用'),
          ),
          CupertinoActionSheetAction(
            onPressed: () async {
              Navigator.pop(ctx);
              try {
                await HarnessClient.instance.runSchedule(s.id);
                if (context.mounted) {
                  _showMessage(context, '任务已开始运行');
                }
              } catch (e) {
                if (context.mounted) _showError(context, e);
              }
            },
            child: const Text('立即运行'),
          ),
          CupertinoActionSheetAction(
            onPressed: () {
              Navigator.pop(ctx);
              _edit(context, s);
            },
            child: const Text('编辑'),
          ),
          CupertinoActionSheetAction(
            isDestructiveAction: true,
            onPressed: () async {
              Navigator.pop(ctx);
              try {
                await HarnessClient.instance.deleteSchedule(s.id);
                await _load();
              } catch (e) {
                if (context.mounted) _showError(context, e);
              }
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

  void _showMessage(BuildContext context, String message) {
    showCupertinoDialog<void>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        content: Text(message),
        actions: [
          CupertinoDialogAction(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('好'),
          ),
        ],
      ),
    );
  }

  void _showError(BuildContext context, Object error) {
    showCupertinoDialog<void>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: const Text('操作失败'),
        content: Text('$error'),
        actions: [
          CupertinoDialogAction(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('好'),
          ),
        ],
      ),
    );
  }

  Future<void> _create(BuildContext context) => _edit(context, null);

  Future<void> _edit(BuildContext context, ScheduleEntry? existing) async {
    final nameCtrl = TextEditingController(text: existing?.name ?? '');
    final taskCtrl = TextEditingController(text: existing?.task ?? '');
    final schedule = existing?.schedule;
    var kind = schedule?.kind ?? 'cron';
    final cronCtrl = TextEditingController(
      text: schedule?.expression ?? existing?.cron ?? '0 9 * * 1-5',
    );
    final runAtCtrl = TextEditingController(text: schedule?.runAt ?? '');
    final everyMinutesCtrl = TextEditingController(
      text: schedule?.everyMinutes?.toString() ?? '60',
    );
    final startAtCtrl = TextEditingController(text: schedule?.startAt ?? '');
    final timeOfDayCtrl = TextEditingController(
      text: schedule?.timeOfDay ?? '09:00',
    );
    final weekdaysCtrl = TextEditingController(
      text: schedule?.weekdays.join(',') ?? '1,2,3,4,5',
    );
    final datesCtrl = TextEditingController(
      text: schedule?.dates.join('\n') ?? '',
    );
    final skillsCtrl = TextEditingController(
      text: existing?.selectedSkillIds.join(', ') ?? '',
    );
    final mcpCtrl = TextEditingController(
      text: existing?.selectedMcpServerIds.join(', ') ?? '',
    );
    final maxRetriesCtrl = TextEditingController(
      text: '${existing?.retryPolicy.maxRetries ?? 0}',
    );
    final retryDelayCtrl = TextEditingController(
      text: '${existing?.retryPolicy.retryDelayMinutes ?? 5}',
    );
    var enabled = existing?.enabled ?? true;
    var saving = false;
    String? error;

    List<String> parseStrings(String value) => value
        .split(RegExp(r'[,\n]'))
        .map((item) => item.trim())
        .where((item) => item.isNotEmpty)
        .toSet()
        .toList();
    List<int> parseInts(String value) => value
        .split(RegExp(r'[,\s]+'))
        .map((item) => int.tryParse(item))
        .whereType<int>()
        .toSet()
        .toList();

    ScheduledTaskSchedule buildSchedule() {
      switch (kind) {
        case 'once':
          return ScheduledTaskSchedule(
            kind: kind,
            runAt: runAtCtrl.text.trim(),
          );
        case 'interval':
          return ScheduledTaskSchedule(
            kind: kind,
            everyMinutes: int.tryParse(everyMinutesCtrl.text.trim()) ?? 0,
            startAt: startAtCtrl.text.trim().isEmpty
                ? null
                : startAtCtrl.text.trim(),
          );
        case 'daily':
          return ScheduledTaskSchedule(
            kind: kind,
            timeOfDay: timeOfDayCtrl.text.trim(),
          );
        case 'weekly':
          return ScheduledTaskSchedule(
            kind: kind,
            weekdays: parseInts(weekdaysCtrl.text),
            timeOfDay: timeOfDayCtrl.text.trim(),
          );
        case 'dates':
          return ScheduledTaskSchedule(
            kind: kind,
            dates: parseStrings(datesCtrl.text),
          );
        default:
          return ScheduledTaskSchedule(
            kind: 'cron',
            expression: cronCtrl.text.trim(),
          );
      }
    }

    await showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) {
        final p = DawnPalette.of(context);
        return Container(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(context).size.height * 0.92,
          ),
          decoration: BoxDecoration(
            color: p.groupedBg,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
          ),
          child: SafeArea(
            child: StatefulBuilder(
              builder: (ctx, setSheet) => SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      existing == null ? '新建定时任务' : '编辑定时任务',
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 12),
                    _scheduleField(nameCtrl, '名称', p),
                    const SizedBox(height: 10),
                    _scheduleField(taskCtrl, '任务 / Prompt', p, maxLines: 3),
                    const SizedBox(height: 10),
                    Text('调度模式', style: TextStyle(fontSize: 13, color: p.ink2)),
                    const SizedBox(height: 6),
                    CupertinoSlidingSegmentedControl<String>(
                      groupValue: kind,
                      children: const {
                        'cron': Padding(
                          padding: EdgeInsets.symmetric(
                            horizontal: 5,
                            vertical: 5,
                          ),
                          child: Text('cron', style: TextStyle(fontSize: 11)),
                        ),
                        'once': Padding(
                          padding: EdgeInsets.symmetric(
                            horizontal: 5,
                            vertical: 5,
                          ),
                          child: Text('一次', style: TextStyle(fontSize: 11)),
                        ),
                        'interval': Padding(
                          padding: EdgeInsets.symmetric(
                            horizontal: 5,
                            vertical: 5,
                          ),
                          child: Text('间隔', style: TextStyle(fontSize: 11)),
                        ),
                        'daily': Padding(
                          padding: EdgeInsets.symmetric(
                            horizontal: 5,
                            vertical: 5,
                          ),
                          child: Text('每日', style: TextStyle(fontSize: 11)),
                        ),
                        'weekly': Padding(
                          padding: EdgeInsets.symmetric(
                            horizontal: 5,
                            vertical: 5,
                          ),
                          child: Text('每周', style: TextStyle(fontSize: 11)),
                        ),
                        'dates': Padding(
                          padding: EdgeInsets.symmetric(
                            horizontal: 5,
                            vertical: 5,
                          ),
                          child: Text('日期', style: TextStyle(fontSize: 11)),
                        ),
                      },
                      onValueChanged: (value) {
                        if (!saving) setSheet(() => kind = value ?? kind);
                      },
                    ),
                    const SizedBox(height: 10),
                    if (kind == 'cron')
                      _scheduleField(
                        cronCtrl,
                        'Cron 表达式（5 段）',
                        p,
                        hint: '0 9 * * 1-5',
                      )
                    else if (kind == 'once')
                      _scheduleField(
                        runAtCtrl,
                        '运行时间（ISO 8601）',
                        p,
                        hint: '2026-09-05T09:00:00+08:00',
                      )
                    else if (kind == 'interval') ...[
                      _scheduleField(
                        everyMinutesCtrl,
                        '间隔分钟数',
                        p,
                        keyboardType: TextInputType.number,
                      ),
                      const SizedBox(height: 8),
                      _scheduleField(startAtCtrl, '开始时间（可选，ISO 8601）', p),
                    ] else if (kind == 'daily')
                      _scheduleField(
                        timeOfDayCtrl,
                        '每日时间（HH:mm）',
                        p,
                        hint: '09:00',
                      )
                    else if (kind == 'weekly') ...[
                      _scheduleField(
                        weekdaysCtrl,
                        '星期（ISO 1=周一，逗号分隔）',
                        p,
                        hint: '1,2,3,4,5',
                      ),
                      const SizedBox(height: 8),
                      _scheduleField(
                        timeOfDayCtrl,
                        '每周时间（HH:mm）',
                        p,
                        hint: '09:00',
                      ),
                    ] else
                      _scheduleField(
                        datesCtrl,
                        '运行日期（每行一个 ISO 8601）',
                        p,
                        maxLines: 4,
                      ),
                    const SizedBox(height: 10),
                    _scheduleSwitch(
                      '启用任务',
                      enabled,
                      (value) => setSheet(() => enabled = value),
                    ),
                    const SizedBox(height: 8),
                    _scheduleField(skillsCtrl, '选择技能 ID（逗号分隔，可选）', p),
                    if (_skills.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(
                          '可用技能：${_skills.map((skill) => skill.name).join(', ')}',
                          style: TextStyle(fontSize: 11, color: p.ink2),
                        ),
                      ),
                    const SizedBox(height: 8),
                    _scheduleField(mcpCtrl, '选择 MCP server ID（逗号分隔，可选）', p),
                    if (_mcpServers.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(
                          '可用 MCP：${_mcpServers.map((server) => server.id).join(', ')}',
                          style: TextStyle(fontSize: 11, color: p.ink2),
                        ),
                      ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        Expanded(
                          child: _scheduleField(
                            maxRetriesCtrl,
                            '最大重试次数',
                            p,
                            keyboardType: TextInputType.number,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: _scheduleField(
                            retryDelayCtrl,
                            '重试间隔（分钟）',
                            p,
                            keyboardType: TextInputType.number,
                          ),
                        ),
                      ],
                    ),
                    if (error != null) ...[
                      const SizedBox(height: 8),
                      Text(
                        error!,
                        style: const TextStyle(fontSize: 13, color: iosRed),
                      ),
                    ],
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: CupertinoButton(
                            onPressed: saving ? null : () => Navigator.pop(ctx),
                            child: const Text('取消'),
                          ),
                        ),
                        Expanded(
                          child: CupertinoButton.filled(
                            onPressed: saving
                                ? null
                                : () async {
                                    final name = nameCtrl.text.trim();
                                    final task = taskCtrl.text.trim();
                                    final schedule = buildSchedule();
                                    if (name.isEmpty || task.isEmpty) {
                                      setSheet(() => error = '名称和任务内容不能为空');
                                      return;
                                    }
                                    if (kind == 'cron' &&
                                        cronCtrl.text.trim().isEmpty) {
                                      setSheet(() => error = '请输入 cron 表达式');
                                      return;
                                    }
                                    setSheet(() {
                                      saving = true;
                                      error = null;
                                    });
                                    try {
                                      final retryPolicy =
                                          ScheduledTaskRetryPolicy(
                                            maxRetries:
                                                int.tryParse(
                                                  maxRetriesCtrl.text.trim(),
                                                ) ??
                                                0,
                                            retryDelayMinutes:
                                                int.tryParse(
                                                  retryDelayCtrl.text.trim(),
                                                ) ??
                                                5,
                                          );
                                      final skillIds = parseStrings(
                                        skillsCtrl.text,
                                      );
                                      final mcpIds = parseStrings(mcpCtrl.text);
                                      if (existing == null) {
                                        await HarnessClient.instance
                                            .createSchedule(
                                              name,
                                              kind == 'cron'
                                                  ? cronCtrl.text.trim()
                                                  : '',
                                              task,
                                              schedule: schedule,
                                              enabled: enabled,
                                              selectedSkillIds: skillIds,
                                              selectedMcpServerIds: mcpIds,
                                              retryPolicy: retryPolicy,
                                              createdBy: 'manual',
                                            );
                                      } else {
                                        await HarnessClient.instance
                                            .updateSchedule(
                                              existing.id,
                                              name: name,
                                              task: task,
                                              cron: kind == 'cron'
                                                  ? cronCtrl.text.trim()
                                                  : '',
                                              schedule: schedule,
                                              enabled: enabled,
                                              selectedSkillIds: skillIds,
                                              selectedMcpServerIds: mcpIds,
                                              retryPolicy: retryPolicy,
                                            );
                                      }
                                      if (ctx.mounted) Navigator.pop(ctx);
                                      await _load();
                                    } catch (e) {
                                      if (ctx.mounted) {
                                        setSheet(() {
                                          saving = false;
                                          error = '$e';
                                        });
                                      }
                                    }
                                  },
                            child: Text(existing == null ? '创建' : '保存'),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
    nameCtrl.dispose();
    taskCtrl.dispose();
    cronCtrl.dispose();
    runAtCtrl.dispose();
    everyMinutesCtrl.dispose();
    startAtCtrl.dispose();
    timeOfDayCtrl.dispose();
    weekdaysCtrl.dispose();
    datesCtrl.dispose();
    skillsCtrl.dispose();
    mcpCtrl.dispose();
    maxRetriesCtrl.dispose();
    retryDelayCtrl.dispose();
  }

  Widget _scheduleField(
    TextEditingController controller,
    String label,
    DawnPalette p, {
    String? hint,
    int maxLines = 1,
    TextInputType? keyboardType,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 13, color: p.ink2)),
        const SizedBox(height: 5),
        CupertinoTextField(
          controller: controller,
          placeholder: hint,
          maxLines: maxLines,
          keyboardType: keyboardType,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: p.cardBg,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: p.separator),
          ),
          style: TextStyle(fontSize: 14, color: p.ink),
        ),
      ],
    );
  }

  Widget _scheduleSwitch(
    String label,
    bool value,
    ValueChanged<bool> onChanged,
  ) {
    final p = DawnPalette.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Expanded(
            child: Text(label, style: TextStyle(fontSize: 14, color: p.ink)),
          ),
          CupertinoSwitch(
            activeTrackColor: iosGreen,
            value: value,
            onChanged: onChanged,
          ),
        ],
      ),
    );
  }
}
