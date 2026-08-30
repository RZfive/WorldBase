import 'dart:convert';
import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/harness_client.dart';
import '../../core/ios_ui.dart';
import '../common/model_picker.dart';

/// 绘图 Studio：生成 / 编辑 / 图库 三个并列功能（顶部分段切换），参数对齐桌面端。
class StudioTab extends ConsumerStatefulWidget {
  const StudioTab({super.key});

  @override
  ConsumerState<StudioTab> createState() => _StudioTabState();
}

class _StudioTabState extends ConsumerState<StudioTab> {
  final _promptCtrl = TextEditingController();
  final _negativeCtrl = TextEditingController();
  final _searchCtrl = TextEditingController();
  int _view = 0; // 0 生成 | 1 编辑 | 2 图库
  String _aspect = '1:1';
  String _resolution = '1K';
  String _quality = 'auto';
  String _format = 'png';
  int _n = 1;
  ImageEntry? _editSource;
  bool _generating = false;
  List<ImageEntry> _gallery = [];
  String _search = '';
  String? _providerId; // null = 默认
  String? _model;
  String _providerName = '';

  static const _aspects = ['1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4'];
  static const _resolutions = ['1K', '2K', '4K'];
  static const _qualities = ['auto', 'low', 'medium', 'high'];
  static const _formats = ['png', 'jpeg', 'webp'];

  @override
  void initState() {
    super.initState();
    _loadGallery();
  }

  Future<void> _loadGallery() async {
    try {
      final images = await HarnessClient.instance
          .studioList(search: _search.isEmpty ? null : _search);
      if (mounted) setState(() => _gallery = images);
    } catch (_) {}
  }

  Future<void> _runGenerate({required bool editMode}) async {
    final prompt = _promptCtrl.text.trim();
    if (prompt.isEmpty || _generating) return;
    if (editMode && _editSource == null) {
      _toast('请先选择参考图');
      return;
    }
    setState(() => _generating = true);
    try {
      String? inputB64;
      if (editMode) {
        final client = HttpClient();
        final req = await client
            .getUrl(Uri.parse('${HarnessClient.instance.httpBase}/studio/${_editSource!.id}'));
        final resp = await req.close();
        final bytes = await resp.fold<List<int>>([], (a, b) => a..addAll(b));
        client.close();
        inputB64 = base64Encode(bytes);
      }
      final streamId = await HarnessClient.instance.studioGenerate(
        prompt: prompt,
        mode: editMode ? 'edit' : 'generate',
        negativePrompt: _negativeCtrl.text.trim(),
        aspect: _aspect,
        resolution: _resolution,
        quality: _quality,
        format: _format,
        n: editMode ? 1 : _n,
        inputImageB64: inputB64,
        providerId: _providerId,
        model: _model,
      );
      final sub = HarnessClient.instance.subscribeStream(streamId).listen((frame) {
        if (frame.kind == 'image_ready') {
          _loadGallery();
        } else if (frame.kind == 'done' || frame.kind == 'error') {
          if (mounted) setState(() => _generating = false);
          if (frame.kind == 'error' && mounted) _toast('失败：${frame.data['message']}');
        }
      });
      Future.delayed(const Duration(minutes: 3), () => sub.cancel());
    } catch (e) {
      if (mounted) {
        setState(() => _generating = false);
        _toast('失败：$e');
      }
    }
  }

  void _toast(String message) {
    if (!mounted) return;
    showCupertinoDialog<void>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: const Text('Studio'),
        content: Text(message),
        actions: [
          CupertinoDialogAction(isDefaultAction: true, onPressed: () => Navigator.pop(ctx),
              child: const Text('好')),
        ],
      ),
    );
  }

  void _pickEditSource() {
    showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => Container(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.6),
        decoration: const BoxDecoration(
          color: iosGroupedBg,
          borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
        ),
        child: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Padding(
                padding: EdgeInsets.fromLTRB(20, 14, 20, 6),
                child: Text('选择参考图（从图库）',
                    style: TextStyle(fontSize: 13, color: iosSecondaryLabel)),
              ),
              Expanded(
                child: GridView.builder(
                  padding: const EdgeInsets.all(12),
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: 3, crossAxisSpacing: 8, mainAxisSpacing: 8),
                  itemCount: _gallery.length,
                  itemBuilder: (ctx, i) => GestureDetector(
                    onTap: () {
                      setState(() => _editSource = _gallery[i]);
                      Navigator.pop(ctx);
                    },
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: Image.network(
                        '${HarnessClient.instance.httpBase}/studio/${_gallery[i].id}',
                        fit: BoxFit.cover,
                        errorBuilder: (ctx, e, _) => const ColoredBox(color: Color(0xFFE5E5EA)),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _showImageDetail(ImageEntry entry) {
    final tagCtrl = TextEditingController(text: entry.tags.join(', '));
    final folderCtrl = TextEditingController(text: entry.folder);
    showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => Container(
        decoration: const BoxDecoration(
          color: iosGroupedBg,
          borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
        ),
        child: SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: Image.network(
                    '${HarnessClient.instance.httpBase}/studio/${entry.id}',
                    fit: BoxFit.contain,
                    height: 260,
                    errorBuilder: (ctx, e, _) => const SizedBox(
                        height: 120, child: Center(child: Icon(CupertinoIcons.photo))),
                  ),
                ),
                const SizedBox(height: 10),
                Text(entry.prompt,
                    style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
                Text('${entry.createdAt} · ${entry.model}',
                    style: const TextStyle(fontSize: 11, color: iosSecondaryLabel)),
                const SizedBox(height: 10),
                Row(children: [
                  Expanded(child: _sheetField(folderCtrl, '文件夹')),
                  const SizedBox(width: 8),
                  Expanded(child: _sheetField(tagCtrl, '标签（逗号分隔）')),
                ]),
                const SizedBox(height: 10),
                Row(children: [
                  Expanded(
                    child: CupertinoButton.filled(
                      onPressed: () async {
                        await HarnessClient.instance.studioTag(
                            entry.id,
                            folderCtrl.text.trim(),
                            tagCtrl.text
                                .split(',')
                                .map((t) => t.trim())
                                .where((t) => t.isNotEmpty)
                                .toList());
                        if (ctx.mounted) Navigator.pop(ctx);
                        _loadGallery();
                      },
                      child: const Text('保存'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  CupertinoButton(
                    color: iosRed,
                    onPressed: () async {
                      await HarnessClient.instance.studioDelete(entry.id);
                      if (ctx.mounted) Navigator.pop(ctx);
                      _loadGallery();
                    },
                    child: const Text('删除'),
                  ),
                ]),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _sheetField(TextEditingController ctrl, String label) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(fontSize: 11, color: iosSecondaryLabel)),
        const SizedBox(height: 4),
        CupertinoTextField(
          controller: ctrl,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            color: iosCardBg,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: iosSeparator),
          ),
          style: const TextStyle(fontSize: 13),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return IosScreen(
      navBar: IosNavBar(
        actions: [
          ModelPickerChip(
            label: _model == null || _model!.isEmpty
                ? (_providerName.isEmpty ? '默认模型' : '$_providerName · 默认')
                : '$_providerName · $_model',
            onTap: () => showModelPickerSheet(
              context,
              title: '生图供应商与模型',
              imageOnly: true,
              selectedProviderId: _providerId,
              selectedModel: _model,
              onSelected: (pid, model, pname) => setState(() {
                _providerId = pid;
                _model = model;
                _providerName = pname ?? '';
              }),
            ),
          ),
          if (_view == 2)
            IosIconButton(icon: CupertinoIcons.refresh, onPressed: _loadGallery),
        ],
        bottom: Padding(
          padding: const EdgeInsets.fromLTRB(16, 2, 16, 8),
          child: CupertinoSlidingSegmentedControl<int>(
            groupValue: _view,
            children: const {
              0: Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('生成', style: TextStyle(fontSize: 13))),
              1: Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('编辑', style: TextStyle(fontSize: 13))),
              2: Padding(padding: EdgeInsets.symmetric(vertical: 5), child: Text('图库', style: TextStyle(fontSize: 13))),
            },
            onValueChanged: (v) => setState(() => _view = v ?? 0),
          ),
        ),
      ),
      child: _view == 0
          ? _buildGenerateView()
          : _view == 1
              ? _buildEditView()
              : _buildLibraryView(),
    );
  }

  // ---------- 生成 ----------

  Widget _buildGenerateView() {
    return ListView(
      padding: const EdgeInsets.fromLTRB(0, 4, 0, 20),
      children: [
        IosSection(
          header: '生成参数',
          children: [
            Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  CupertinoTextField(
                    controller: _promptCtrl,
                    maxLines: 3,
                    minLines: 2,
                    placeholder: '描述你想要的图像…',
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: iosGroupedBg,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: iosSeparator),
                    ),
                    style: const TextStyle(fontSize: 15, letterSpacing: -0.3),
                  ),
                  const SizedBox(height: 10),
                  CupertinoTextField(
                    controller: _negativeCtrl,
                    placeholder: '负向提示词（不希望出现的元素）',
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: iosGroupedBg,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: iosSeparator),
                    ),
                    style: const TextStyle(fontSize: 13),
                  ),
                  const SizedBox(height: 12),
                  _paramRow('比例', _aspects, _aspect, (v) => setState(() => _aspect = v)),
                  const SizedBox(height: 8),
                  _paramRow('分辨率', _resolutions, _resolution, (v) => setState(() => _resolution = v)),
                  const SizedBox(height: 8),
                  _paramRow('质量', _qualities, _quality, (v) => setState(() => _quality = v)),
                  const SizedBox(height: 8),
                  _paramRow('格式', _formats, _format, (v) => setState(() => _format = v)),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      const Text('数量', style: TextStyle(fontSize: 12, color: iosSecondaryLabel)),
                      const SizedBox(width: 8),
                      for (var i = 1; i <= 4; i++)
                        Padding(
                          padding: const EdgeInsets.only(right: 6),
                          child: GestureDetector(
                            onTap: () => setState(() => _n = i),
                            child: Container(
                              width: 30,
                              height: 30,
                              alignment: Alignment.center,
                              decoration: BoxDecoration(
                                color: _n == i ? iosBlue : iosGroupedBg,
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: Text('$i',
                                  style: TextStyle(
                                      fontSize: 14,
                                      fontWeight: FontWeight.w600,
                                      color: _n == i ? const Color(0xFFFFFFFF) : iosLabel)),
                            ),
                          ),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: SizedBox(
            width: double.infinity,
            child: CupertinoButton.filled(
              onPressed: _generating ? null : () => _runGenerate(editMode: false),
              child: _generating
                  ? const CupertinoActivityIndicator(color: Color(0xFFFFFFFF))
                  : const Row(mainAxisSize: MainAxisSize.min, children: [
                      Icon(CupertinoIcons.sparkles, size: 15),
                      SizedBox(width: 6),
                      Text('开始生成', style: TextStyle(fontWeight: FontWeight.w600)),
                    ]),
            ),
          ),
        ),
      ],
    );
  }

  // ---------- 编辑 ----------

  Widget _buildEditView() {
    return ListView(
      padding: const EdgeInsets.fromLTRB(0, 4, 0, 20),
      children: [
        IosSection(
          header: '编辑参数',
          children: [
            Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  GestureDetector(
                    onTap: _pickEditSource,
                    child: Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: iosGroupedBg,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: iosSeparator),
                      ),
                      child: Row(
                        children: [
                          if (_editSource != null)
                            ClipRRect(
                              borderRadius: BorderRadius.circular(6),
                              child: Image.network(
                                '${HarnessClient.instance.httpBase}/studio/${_editSource!.id}',
                                width: 52, height: 52, fit: BoxFit.cover,
                                errorBuilder: (ctx, e, _) =>
                                    const SizedBox(width: 52, height: 52),
                              ),
                            )
                          else
                            const Icon(CupertinoIcons.photo_on_rectangle,
                                size: 32, color: iosSecondaryLabel),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                                _editSource == null
                                    ? '点按从图库选择参考图'
                                    : _editSource!.prompt,
                                style: const TextStyle(fontSize: 13),
                                overflow: TextOverflow.ellipsis),
                          ),
                          const Icon(CupertinoIcons.chevron_forward,
                              size: 14, color: iosSecondaryLabel),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  CupertinoTextField(
                    controller: _promptCtrl,
                    maxLines: 3,
                    minLines: 2,
                    placeholder: '描述如何修改这张图…',
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: iosGroupedBg,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: iosSeparator),
                    ),
                    style: const TextStyle(fontSize: 15, letterSpacing: -0.3),
                  ),
                  const SizedBox(height: 12),
                  _paramRow('比例', _aspects, _aspect, (v) => setState(() => _aspect = v)),
                  const SizedBox(height: 8),
                  _paramRow('质量', _qualities, _quality, (v) => setState(() => _quality = v)),
                  const SizedBox(height: 8),
                  _paramRow('格式', _formats, _format, (v) => setState(() => _format = v)),
                ],
              ),
            ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: SizedBox(
            width: double.infinity,
            child: CupertinoButton.filled(
              onPressed: _generating ? null : () => _runGenerate(editMode: true),
              child: _generating
                  ? const CupertinoActivityIndicator(color: Color(0xFFFFFFFF))
                  : const Row(mainAxisSize: MainAxisSize.min, children: [
                      Icon(CupertinoIcons.wand_stars, size: 15),
                      SizedBox(width: 6),
                      Text('开始编辑', style: TextStyle(fontWeight: FontWeight.w600)),
                    ]),
            ),
          ),
        ),
      ],
    );
  }

  // ---------- 图库 ----------

  Widget _buildLibraryView() {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 6),
          child: Row(
            children: [
              Expanded(
                child: CupertinoSearchTextField(
                  controller: _searchCtrl,
                  placeholder: '搜索提示词',
                  onSubmitted: (v) {
                    _search = v;
                    _loadGallery();
                  },
                ),
              ),
              const SizedBox(width: 8),
              Text('${_gallery.length} 张',
                  style: const TextStyle(fontSize: 12, color: iosSecondaryLabel)),
            ],
          ),
        ),
        Expanded(
          child: _gallery.isEmpty
              ? const IosEmptyHint(
                  icon: CupertinoIcons.photo_on_rectangle,
                  title: '还没有图像',
                  subtitle: '去「生成」或「编辑」创作一张吧',
                )
              : GridView.builder(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 2,
                    crossAxisSpacing: 10,
                    mainAxisSpacing: 10,
                    childAspectRatio: 0.85,
                  ),
                  itemCount: _gallery.length,
                  itemBuilder: (ctx, i) => _ImageCard(
                    entry: _gallery[i],
                    onOpen: () => _showImageDetail(_gallery[i]),
                    onDelete: () async {
                      await HarnessClient.instance.studioDelete(_gallery[i].id);
                      _loadGallery();
                    },
                  ),
                ),
        ),
      ],
    );
  }

  Widget _paramRow(String label, List<String> options, String current, ValueChanged<String> onChanged) {
    // 窄屏（手机）下分段控件会溢出，改用可换行的选择芯片
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontSize: 12, color: iosSecondaryLabel)),
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final o in options)
                GestureDetector(
                  onTap: () => onChanged(o),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    decoration: BoxDecoration(
                      color: current == o ? iosBlue : iosGroupedBg,
                      borderRadius: BorderRadius.circular(8),
                      border: current == o ? null : Border.all(color: iosSeparator),
                    ),
                    child: Text(
                      o,
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: current == o ? FontWeight.w600 : FontWeight.w400,
                        color: current == o ? const Color(0xFFFFFFFF) : iosLabel,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

}

class _ImageCard extends StatelessWidget {
  const _ImageCard({required this.entry, required this.onOpen, required this.onDelete});

  final ImageEntry entry;
  final VoidCallback onOpen;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onOpen,
      child: Container(
        decoration: BoxDecoration(
          color: iosCardBg,
          borderRadius: BorderRadius.circular(14),
          boxShadow: const [
            BoxShadow(color: Color(0x14000000), blurRadius: 10, offset: Offset(0, 3)),
          ],
        ),
        clipBehavior: Clip.antiAlias,
        child: Stack(
          fit: StackFit.expand,
          children: [
            Image.network(
              '${HarnessClient.instance.httpBase}/studio/${entry.id}',
              fit: BoxFit.contain,
              errorBuilder: (ctx, e, _) => const Center(
                  child: Icon(CupertinoIcons.photo, size: 30, color: Color(0xFFC7C7CC))),
            ),
            Positioned(
              top: 6,
              right: 6,
              child: GestureDetector(
                onTap: onDelete,
                child: Container(
                  width: 24,
                  height: 24,
                  decoration: BoxDecoration(
                    color: const Color(0xCC000000),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Icon(CupertinoIcons.xmark, size: 12, color: Color(0xFFFFFFFF)),
                ),
              ),
            ),
            if (entry.tags.isNotEmpty)
              Positioned(
                left: 6,
                top: 6,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: iosBlue.withValues(alpha: 0.85),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(entry.tags.first,
                      style: const TextStyle(fontSize: 9, color: Color(0xFFFFFFFF))),
                ),
              ),
            Positioned(
              left: 8,
              right: 8,
              bottom: 6,
              child: Text(
                entry.prompt,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                    fontSize: 10.5,
                    color: iosLabel,
                    fontWeight: FontWeight.w500,
                    shadows: [Shadow(blurRadius: 6, color: Color(0x66FFFFFF))]),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
