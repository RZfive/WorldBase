import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/glass.dart';
import '../../core/harness_client.dart';
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
    return SettingsSubPage(title: '模型供应商', child: ListView(children: const [_ProvidersCard()]));
  }
}

/// Agent 工作区子页（对齐桌面 agent-workspace 分区：Agent / 记忆）。
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
                0: Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('Agent', style: TextStyle(fontSize: 13))),
                1: Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('记忆', style: TextStyle(fontSize: 13))),
              },
              onValueChanged: (v) => setState(() => _tab = v ?? 0),
            ),
          ),
          Expanded(
            child: _tab == 0
                ? ListView(children: const [_AgentsCard()])
                : ListView(children: const [_MemoryCard()]),
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
    return SettingsSubPage(title: '用量统计', child: ListView(children: const [_UsageCard()]));
  }
}

/// 技能子页。
class SkillsPage extends StatelessWidget {
  const SkillsPage({super.key});

  @override
  Widget build(BuildContext context) {
    return SettingsSubPage(title: '技能', child: ListView(children: const [_SkillsCard()]));
  }
}

/// 定时任务子页。
class SchedulesPage extends StatelessWidget {
  const SchedulesPage({super.key});

  @override
  Widget build(BuildContext context) {
    return SettingsSubPage(title: '定时任务', child: ListView(children: const [_SchedulesCard()]));
  }
}

/// MCP 子页。
class McpPage extends StatelessWidget {
  const McpPage({super.key});

  @override
  Widget build(BuildContext context) {
    return SettingsSubPage(title: 'MCP 服务', child: ListView(children: const [_McpCard()]));
  }
}

/// 通用与关于子页。
class AdvancedPage extends StatelessWidget {
  const AdvancedPage({super.key});

  @override
  Widget build(BuildContext context) {
    return SettingsSubPage(
      title: '通用与关于',
      child: ListView(
        children: const [
          _AdvancedCard(),
          SizedBox(height: 14),
        ],
      ),
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
    return list.map((e) => ProviderEntry.fromJson((e as Map).cast<String, dynamic>())).toList();
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

    // 模型编辑的持久控制器（与 models 下标一一对应）
    final models = <ModelInfo>[];
    final idCtrls = <TextEditingController>[];
    final ctxCtrls = <TextEditingController>[];
    final inCtrls = <TextEditingController>[];
    final outCtrls = <TextEditingController>[];
    void addModel([ModelInfo? seed]) {
      final m = seed ??
          ModelInfo(
              id: '',
              contextWindowK: 128,
              inputPrice: 0,
              outputPrice: 0,
              imageGeneration: false,
              imageEditing: false);
      models.add(m);
      idCtrls.add(TextEditingController(text: m.id));
      ctxCtrls.add(TextEditingController(text: m.contextWindowK == 0 ? '' : '${m.contextWindowK}'));
      inCtrls.add(TextEditingController(text: m.inputPrice == 0 ? '' : '${m.inputPrice}'));
      outCtrls.add(TextEditingController(text: m.outputPrice == 0 ? '' : '${m.outputPrice}'));
    }

    for (final m in existing?.models ?? const <ModelInfo>[]) {
      addModel(m);
    }
    if (models.isEmpty) addModel();
    var activeModel = existing?.activeModel ?? '';
    int? expandedIdx;

    await showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => Container(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.92),
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
                  Text(existing == null ? '添加供应商' : '编辑供应商',
                      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600, letterSpacing: -0.4)),
                  const SizedBox(height: 12),
                  _field(nameCtrl, '名称'),
                  const SizedBox(height: 10),
                  Text('API 协议', style: TextStyle(fontSize: 13, color: p.ink2)),
                  const SizedBox(height: 6),
                  CupertinoSlidingSegmentedControl<String>(
                    groupValue: protocol,
                    children: const {
                      '': Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('auto', style: TextStyle(fontSize: 12))),
                      'openai': Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('OpenAI', style: TextStyle(fontSize: 12))),
                      'anthropic': Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('Anthropic', style: TextStyle(fontSize: 12))),
                    },
                    onValueChanged: (v) => setSheet(() => protocol = v ?? ''),
                  ),
                  const SizedBox(height: 10),
                  _field(urlCtrl, 'Base URL', hint: 'https://api.deepseek.com/v1'),
                  const SizedBox(height: 10),
                  _field(keyCtrl, 'API Key', obscure: true),
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      Expanded(
                        child: Text('模型（逐模型设置能力与价格）',
                            style: TextStyle(fontSize: 13, color: p.ink2)),
                      ),
                      CupertinoButton(
                        minSize: 0,
                        padding: const EdgeInsets.all(4),
                        onPressed: () => setSheet(() => addModel()),
                        child: const Icon(CupertinoIcons.add_circled, size: 22, color: iosBlue),
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
                          onSetDefault: () => setSheet(() => activeModel = models[i].id),
                          onDelete: () => setSheet(() {
                            models.removeAt(i);
                            idCtrls.removeAt(i);
                            ctxCtrls.removeAt(i);
                            inCtrls.removeAt(i);
                            outCtrls.removeAt(i);
                          }),
                        ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  SizedBox(
                    width: double.infinity,
                    child: CupertinoButton.filled(
                      onPressed: () async {
                        final validModels = models
                            .map((m) => m..id = m.id.trim())
                            .where((m) => m.id.isNotEmpty)
                            .toList();
                        final entry = ProviderEntry(
                          id: existing?.id ?? 'p-${DateTime.now().millisecondsSinceEpoch}',
                          name: nameCtrl.text.trim().isEmpty ? '供应商' : nameCtrl.text.trim(),
                          baseUrl: urlCtrl.text.trim(),
                          apiKey: keyCtrl.text.trim(),
                          apiProtocol: protocol,
                          models: validModels,
                          activeModel: validModels.any((m) => m.id == activeModel)
                              ? activeModel
                              : (validModels.isEmpty ? '' : validModels.first.id),
                          imageGeneration: validModels.any((m) => m.imageGeneration),
                        );
                        await HarnessClient.instance.saveProvider(entry);
                        if (ctx.mounted) Navigator.pop(ctx);
                        await _load();
                        ref.read(providersProvider.notifier).refresh();
                      },
                      child: const Text('保存', style: TextStyle(fontWeight: FontWeight.w600)),
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
                  isDefault ? CupertinoIcons.checkmark_circle_fill : CupertinoIcons.circle,
                  size: 20,
                  color: isDefault ? iosGreen : p.separator,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(m.id.isEmpty ? '（未命名模型）' : m.id,
                          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500),
                          maxLines: 1, overflow: TextOverflow.ellipsis),
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
                    child: Icon(CupertinoIcons.paintbrush_fill, size: 14, color: iosPink),
                  ),
                if (m.imageEditing)
                  const Padding(
                    padding: EdgeInsets.only(left: 4),
                    child: Icon(CupertinoIcons.wand_stars, size: 14, color: iosPurple),
                  ),
                const SizedBox(width: 6),
                Icon(expanded ? CupertinoIcons.chevron_up : CupertinoIcons.chevron_down,
                    size: 14, color: p.ink2),
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
                _miniField(idCtrls[i], '模型 ID'),
                const SizedBox(height: 8),
                Row(children: [
                  Expanded(child: _miniField(ctxCtrls[i], '上下文 (K)')),
                  const SizedBox(width: 6),
                  Expanded(child: _miniField(inCtrls[i], '输入价 /1M')),
                  const SizedBox(width: 6),
                  Expanded(child: _miniField(outCtrls[i], '输出价 /1M')),
                ]),
                const SizedBox(height: 10),
                _capSwitch('支持图片生成', m.imageGeneration,
                    (v) => setSheet(() => models[i].imageGeneration = v)),
                _capSwitch('支持图片编辑（参考图）', m.imageEditing,
                    (v) => setSheet(() => models[i].imageEditing = v)),
                const SizedBox(height: 8),
                Row(children: [
                  CupertinoButton(
                    minSize: 0,
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    onPressed: onSetDefault,
                    child: Text(isDefault ? '已是默认 ✓' : '设为默认',
                        style: TextStyle(
                            fontSize: 13, color: isDefault ? iosGreen : iosBlue)),
                  ),
                  const Spacer(),
                  CupertinoButton(
                    minSize: 0,
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    onPressed: onDelete,
                    child: const Text('删除',
                        style: TextStyle(fontSize: 13, color: iosRed)),
                  ),
                ]),
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
          Expanded(child: Text(label, style: const TextStyle(fontSize: 14, letterSpacing: -0.2))),
          CupertinoSwitch(activeColor: iosGreen, value: value, onChanged: onChanged),
        ],
      ),
    );
  }

  Widget _miniField(TextEditingController ctrl, String label) {
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
          keyboardType: TextInputType.numberWithOptions(decimal: true),
        ),
      ],
    );
  }

  Widget _field(TextEditingController ctrl, String label, {String? hint, bool obscure = false}) {
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
          const Padding(padding: EdgeInsets.all(16), child: CupertinoActivityIndicator())
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
    final iconCtrl = TextEditingController(text: existing?.icon.isEmpty == true ? '🤖' : existing?.icon ?? '🤖');
    final descCtrl = TextEditingController(text: existing?.description ?? '');
    final promptCtrl = TextEditingController(text: existing?.systemPrompt ?? '');
    String? providerId = existing?.providerId;

    await showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => Container(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.9),
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
                  Text(existing == null ? '新建 Agent' : '编辑 Agent',
                      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600, letterSpacing: -0.4)),
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
                  Text('绑定供应商（可选）', style: TextStyle(fontSize: 13, color: p.ink2)),
                  const SizedBox(height: 6),
                  CupertinoSlidingSegmentedControl<String>(
                    groupValue: providerId ?? '',
                    children: {
                      '': const Padding(
                          padding: EdgeInsets.symmetric(vertical: 5),
                          child: Text('默认', style: TextStyle(fontSize: 12))),
                      for (final p in providerList)
                        p['id'] as String: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 5),
                          child: Text((p['name'] as String?) ?? '',
                              style: const TextStyle(fontSize: 12)),
                        ),
                    },
                    onValueChanged: (v) =>
                        setSheet(() => providerId = (v == null || v.isEmpty) ? null : v),
                  ),
                  const SizedBox(height: 14),
                  SizedBox(
                    width: double.infinity,
                    child: CupertinoButton.filled(
                      onPressed: () async {
                        if (nameCtrl.text.trim().isEmpty) return;
                        await HarnessClient.instance.saveAgent(AgentDefinition(
                          id: existing?.id ?? '',
                          name: nameCtrl.text.trim(),
                          icon: iconCtrl.text.trim(),
                          description: descCtrl.text.trim(),
                          systemPrompt: promptCtrl.text,
                          providerId: providerId,
                          modelId: existing?.modelId,
                        ));
                        if (ctx.mounted) Navigator.pop(ctx);
                        await _load();
                        ref.read(agentsProvider.notifier).refresh();
                      },
                      child: const Text('保存', style: TextStyle(fontWeight: FontWeight.w600)),
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
                minSize: 0,
                padding: const EdgeInsets.all(6),
                onPressed: () => _showAddDialog(context),
                child: const Icon(CupertinoIcons.add_circled, size: 22, color: iosBlue),
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
      setState(() => _hits = [
            {'content': '检索失败：$e'}
          ]);
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
          child: CupertinoTextField(controller: ctrl, maxLines: 3, autofocus: true),
        ),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
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
            minSize: 0,
            padding: const EdgeInsets.all(4),
            onPressed: _loading
                ? null
                : () async {
                    setState(() => _loading = true);
                    try {
                      final cfg = await HarnessClient.instance.getSetting('mcpServers');
                      await HarnessClient.instance.mcpReload((cfg?['value'] as List?) ?? []);
                      await _load();
                    } finally {
                      if (mounted) setState(() => _loading = false);
                    }
                  },
            child: _loading
                ? const CupertinoActivityIndicator()
                : const Text('重载', style: TextStyle(fontSize: 14, color: iosBlue)),
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
          const Padding(padding: EdgeInsets.all(16), child: CupertinoActivityIndicator())
        else ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
            child: Row(
              children: [
                _statBlock('成本', s.totalCost.toStringAsFixed(4), iosBlue),
                const SizedBox(width: 12),
                _statBlock('输入 tokens', _fmtTokens(s.totalInputTokens), iosGreen),
                const SizedBox(width: 12),
                _statBlock('输出 tokens', _fmtTokens(s.totalOutputTokens), iosOrange),
              ],
            ),
          ),
          if (s.daily.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
              child: SizedBox(height: 64, child: _DailyBars(daily: s.daily)),
            ),
          CupertinoButton(
            minSize: 0,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            onPressed: () => setState(() => _expanded = !_expanded),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(_expanded ? '收起按模型明细 ▲' : '按模型明细 ▼',
                  style: const TextStyle(fontSize: 13, color: iosBlue)),
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
                trailing: Text('¥${((m['cost'] as num?)?.toDouble() ?? 0).toStringAsFixed(4)}',
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
              ),
          if (s.byModel.isEmpty && _expanded)
            IosRow(
                icon: CupertinoIcons.chart_bar,
                iconColor: p.ink2,
                title: '暂无用量记录'),
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
            Text(value,
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: color)),
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
                      height: 54 *
                          (((d['cost'] as num?)?.toDouble() ?? 0) / maxCost).clamp(0.04, 1.0),
                      decoration: BoxDecoration(
                        color: iosBlue.withValues(alpha: 0.75),
                        borderRadius: BorderRadius.circular(3),
                      ),
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text((d['day'] as String).substring(5),
                      style: TextStyle(fontSize: 8, color: p.ink2),
                      overflow: TextOverflow.ellipsis),
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
          const Padding(padding: EdgeInsets.all(16), child: CupertinoActivityIndicator())
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
                child: Text(skill.name,
                    style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
              ),
              IosSection(
                children: [
                  IosRow(
                    icon: CupertinoIcons.doc_plaintext,
                    iconColor: iosBlue,
                    title: skill.description.isEmpty ? '（无描述）' : skill.description,
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
    await showCupertinoDialog<void>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: const Text('新建技能（YAML）'),
        content: Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Column(children: [
            CupertinoTextField(
                controller: nameCtrl,
                placeholder: '名称（英文标识）',
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8)),
            const SizedBox(height: 8),
            CupertinoTextField(
                controller: descCtrl,
                placeholder: '描述',
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8)),
            const SizedBox(height: 8),
            CupertinoTextField(
                controller: instrCtrl,
                placeholder: '指令内容',
                maxLines: 3,
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8)),
          ]),
        ),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () async {
              if (nameCtrl.text.trim().isEmpty || instrCtrl.text.isEmpty) return;
              await HarnessClient.instance
                  .saveSkill(nameCtrl.text.trim(), descCtrl.text.trim(), instrCtrl.text);
              if (ctx.mounted) Navigator.pop(ctx);
              _load();
            },
            child: const Text('保存'),
          ),
        ],
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
  }

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return IosSection(
      header: '定时任务',
      footer: '移动端语义降级：iOS 后台触发受限，由系统补跑',
      children: [
        if (_schedules == null)
          const Padding(padding: EdgeInsets.all(16), child: CupertinoActivityIndicator())
        else if (_schedules!.isEmpty)
          IosRow(
            icon: CupertinoIcons.alarm,
            iconColor: p.ink2,
            title: '暂无任务',
          )
        else
          for (final s in _schedules!)
            IosRow(
              icon: CupertinoIcons.alarm_fill,
              iconColor: s.enabled ? iosGreen : p.ink2,
              title: s.name,
              subtitle: '${s.cron} · 下次 ${s.nextRunAt ?? '-'}',
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
        message: Text('${s.cron}\n任务：${s.task}'),
        actions: [
          CupertinoActionSheetAction(
            isDestructiveAction: true,
            onPressed: () async {
              Navigator.pop(ctx);
              await HarnessClient.instance.deleteSchedule(s.id);
              _load();
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

  Future<void> _create(BuildContext context) async {
    final nameCtrl = TextEditingController();
    final cronCtrl = TextEditingController(text: '0 9 * * 1-5');
    final taskCtrl = TextEditingController();
    await showCupertinoDialog<void>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: const Text('新建定时任务'),
        content: Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Column(children: [
            CupertinoTextField(
                controller: nameCtrl,
                placeholder: '名称',
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8)),
            const SizedBox(height: 8),
            CupertinoTextField(
                controller: cronCtrl,
                placeholder: 'cron（5 段）',
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8)),
            const SizedBox(height: 8),
            CupertinoTextField(
                controller: taskCtrl,
                placeholder: '任务描述',
                maxLines: 2,
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8)),
          ]),
        ),
        actions: [
          CupertinoDialogAction(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () async {
              if (nameCtrl.text.isEmpty || taskCtrl.text.isEmpty) return;
              try {
                await HarnessClient.instance
                    .createSchedule(nameCtrl.text, cronCtrl.text, taskCtrl.text);
              } catch (e) {
                if (ctx.mounted) {
                  showCupertinoDialog<void>(
                    context: ctx,
                    builder: (d) => CupertinoAlertDialog(
                      title: const Text('创建失败'),
                      content: Text('$e'),
                      actions: [
                        CupertinoDialogAction(
                            onPressed: () => Navigator.pop(d), child: const Text('好')),
                      ],
                    ),
                  );
                }
              }
              if (ctx.mounted) Navigator.pop(ctx);
              _load();
            },
            child: const Text('创建'),
          ),
        ],
      ),
    );
  }
}
