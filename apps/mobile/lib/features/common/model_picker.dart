import 'package:flutter/cupertino.dart';

import '../../core/glass.dart';
import '../../core/ios_ui.dart';
import '../../core/providers.dart';

/// 供应商/模型快速切换弹层。
///
/// [imageOnly] 为 true 时仅列出具备生图/编辑能力的供应商与模型（绘图用）；
/// [imageMode] 可进一步限定为 `generate` 或 `edit`，避免把仅支持编辑的
/// 模型提交到生成接口（反之亦然）。
/// 选中后回调 (providerId, model, providerName)，providerId 为 null 表示默认。
Future<void> showModelPickerSheet(
  BuildContext context, {
  required void Function(String? providerId, String? model, String? providerName) onSelected,
  String? selectedProviderId,
  String? selectedModel,
  bool imageOnly = false,
  String? imageMode,
  String title = '选择供应商与模型',
}) async {
  Map<String, dynamic> config;
  try {
    config = await HarnessClient.instance.listProviders();
  } catch (error) {
    if (!context.mounted) return;
    await showCupertinoDialog<void>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: const Text('无法加载模型'),
        content: Text('$error'),
        actions: [
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () => Navigator.pop(ctx),
            child: const Text('好'),
          ),
        ],
      ),
    );
    return;
  }
  final list = (config['providers'] as List? ?? [])
      .map((e) => ProviderEntry.fromJson((e as Map).cast<String, dynamic>()))
      .toList();

  bool supportsImage(ModelInfo model) {
    if (imageMode == 'generate') return model.imageGeneration;
    if (imageMode == 'edit') return model.imageEditing;
    return model.imageGeneration || model.imageEditing;
  }

  bool providerHasImageCapability(ProviderEntry provider) {
    if (imageMode == 'generate') return provider.imageGeneration;
    // ProviderEntry has no separate edit flag; a model-level marker is the
    // authoritative signal for edit mode when models are configured.
    return provider.imageGeneration;
  }

  if (!context.mounted) return;
  final pal = DawnPalette.of(context);
  showCupertinoModalPopup<void>(
    context: context,
    builder: (ctx) => Container(
      constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.75),
      decoration: BoxDecoration(
        color: pal.groupedBg,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
      ),
      child: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
          children: [
            Text(title,
                style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700, letterSpacing: -0.5)),
            const SizedBox(height: 10),
            IosSection(
              header: '默认',
              children: [
                IosRow(
                  icon: CupertinoIcons.sparkles,
                  iconColor: pal.ink2,
                  title: selectedProviderId == null ? '默认供应商 ✓' : '默认供应商',
                  subtitle: '使用供应商设置里的默认配置',
                  onTap: () {
                    onSelected(null, null, null);
                    Navigator.pop(ctx);
                  },
                ),
              ],
            ),
            for (final p in list) ...[
              const SizedBox(height: 10),
              IosSection(
                header: '${p.name}${p.apiProtocol.isEmpty ? '' : ' · ${p.apiProtocol}'}',
                children: [
                  if (p.models.isEmpty && (!imageOnly || providerHasImageCapability(p)))
                    IosRow(
                      icon: imageOnly
                          ? CupertinoIcons.paintbrush_fill
                          : CupertinoIcons.exclamationmark_circle,
                      iconColor: imageOnly ? iosBlue : pal.ink2,
                      title: imageOnly ? '使用供应商默认生图模型' : '该供应商没有配置模型',
                      subtitle: imageOnly ? '由供应商自动选择图片模型' : null,
                      onTap: imageOnly
                          ? () {
                              onSelected(p.id, null, p.name);
                              Navigator.pop(ctx);
                            }
                          : null,
                  )
                  else if (p.models.isEmpty)
                    IosRow(
                      icon: CupertinoIcons.exclamationmark_circle,
                      iconColor: pal.ink2,
                      title: '该供应商未标记生图能力',
                    )
                  else
                    for (final m in p.models.where((m) =>
                        !imageOnly || supportsImage(m)))
                      IosRow(
                        icon: m.imageEditing
                            ? CupertinoIcons.wand_stars
                            : (m.imageGeneration
                                ? CupertinoIcons.paintbrush_fill
                                : CupertinoIcons.circle_fill),
                        iconColor: m.imageEditing ? iosPurple : iosBlue,
                        title: m.id == selectedModel && p.id == selectedProviderId
                            ? '${m.id} ✓'
                            : m.id,
                        subtitle: [
                          if (m.contextWindowK > 0) '上下文 ${m.contextWindowK}K',
                          if (m.imageGeneration) '生图',
                          if (m.imageEditing) '编辑',
                        ].join(' · '),
                        onTap: () {
                          onSelected(p.id, m.id, p.name);
                          Navigator.pop(ctx);
                        },
                      ),
                  if (imageOnly &&
                      p.models.isNotEmpty &&
                      !p.models.any(supportsImage))
                    IosRow(
                      icon: CupertinoIcons.exclamationmark_circle,
                      iconColor: pal.ink2,
                      title: '该供应商没有图片模型',
                      subtitle: '请在“我的 → 供应商”中标记生图/编辑能力',
                    ),
                ],
              ),
            ],
            const SizedBox(height: 12),
          ],
        ),
      ),
    ),
  );
}

/// 当前选择的展示芯片（对话页 / 绘图页共用）。
class ModelPickerChip extends StatelessWidget {
  const ModelPickerChip({required this.label, required this.onTap, super.key});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: p.cardBg,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: p.separator),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: Text(label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, color: p.ink2)),
            ),
            const SizedBox(width: 4),
            Icon(CupertinoIcons.chevron_down, size: 12, color: p.ink2),
          ],
        ),
      ),
    );
  }
}
