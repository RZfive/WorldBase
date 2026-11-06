import 'package:flutter/cupertino.dart';

import '../../core/glass.dart';
import '../../core/harness_client.dart';
import '../../core/ios_ui.dart';
import 'settings_tab.dart';

/// 只读应用目录：直接展示 Rust `application.list` 的结果。
///
/// 移动端不提供启用/禁用、授权或审计入口；这些管理操作仍由 Electron 桌面端
/// 持有，避免移动端出现第二份可执行目录。
class ApplicationCatalogPage extends StatefulWidget {
  const ApplicationCatalogPage({super.key});

  @override
  State<ApplicationCatalogPage> createState() => _ApplicationCatalogPageState();
}

class _ApplicationCatalogPageState extends State<ApplicationCatalogPage> {
  List<ApplicationCatalogEntry>? _applications;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _applications = null;
        _error = null;
      });
    }
    try {
      final result = await HarnessClient.instance.call('application.list', {});
      final applications = _parseApplications(result);
      if (!mounted) return;
      setState(() => _applications = applications);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return SettingsSubPage(
      title: '应用 / Applications',
      child: ListView(
        padding: const EdgeInsets.only(top: 4, bottom: 24),
        children: [
          if (_applications == null && _error == null)
            const IosSection(
              header: '应用目录',
              children: [
                Padding(
                  padding: EdgeInsets.all(24),
                  child: Center(child: CupertinoActivityIndicator(radius: 10)),
                ),
              ],
            )
          else if (_error != null)
            IosSection(
              header: '应用目录',
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        '加载失败',
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        '$_error',
                        style: TextStyle(fontSize: 12.5, color: p.ink2),
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 10),
                      CupertinoButton(
                        padding: EdgeInsets.zero,
                        minimumSize: Size.zero,
                        onPressed: _load,
                        child: const Text(
                          '重试',
                          style: TextStyle(fontSize: 14, color: iosBlue),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            )
          else if (_applications!.isEmpty)
            const IosSection(
              header: '应用目录',
              children: [
                IosRow(
                  icon: CupertinoIcons.square_stack,
                  iconColor: iosOrange,
                  title: '暂无应用',
                  subtitle: 'Rust 目录尚未注册任何应用',
                ),
              ],
            )
          else
            for (final application in _applications!)
              _ApplicationSection(application: application),
          const SizedBox(height: 14),
          const IosSection(
            header: '只读目录',
            children: [
              IosRow(
                icon: CupertinoIcons.lock_fill,
                iconColor: iosOrange,
                title: '管理仅在桌面端',
                subtitle: '启用 / 禁用、授权与审计请使用桌面端设置',
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ApplicationSection extends StatelessWidget {
  const _ApplicationSection({required this.application});

  final ApplicationCatalogEntry application;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: IosSection(
        header: application.name,
        footer: '${application.appId} · v${application.version}',
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _Badge(
                  label: application.trustLabel,
                  color: application.trustColor(p),
                ),
                _Badge(
                  label: application.enabled ? '已启用' : '已禁用',
                  color: application.enabled ? iosGreen : p.ink2,
                ),
                _Badge(
                  label: '健康：${application.healthLabel}',
                  color: application.healthColor,
                ),
                if (application.runtimeLabel.isNotEmpty)
                  _Badge(
                    label: application.runtimeLabel,
                    color: p.ink2,
                  ),
              ],
            ),
          ),
          if (application.healthDetail != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: Text(
                application.healthDetail!,
                style: TextStyle(fontSize: 12, color: p.ink2),
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          for (final capability in application.capabilities)
            _CapabilityRow(capability: capability),
          if (application.capabilities.isEmpty)
            const IosRow(
              icon: CupertinoIcons.wrench,
              iconColor: iosOrange,
              title: '暂无能力',
              subtitle: '该应用没有声明可调用的 capability',
            ),
        ],
      ),
    );
  }
}

class _CapabilityRow extends StatelessWidget {
  const _CapabilityRow({required this.capability});

  final ApplicationCapability capability;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    final riskColor = capability.riskColor;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 30,
            height: 30,
            decoration: BoxDecoration(
              color: riskColor.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(7),
            ),
            child: Icon(CupertinoIcons.wrench_fill, size: 16, color: riskColor),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  capability.title,
                  style: TextStyle(
                    fontSize: 15,
                    letterSpacing: -0.3,
                    color: p.ink,
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                if (capability.description.isNotEmpty) ...[
                  const SizedBox(height: 1),
                  Text(
                    capability.description,
                    style: TextStyle(fontSize: 12, color: p.ink2),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
                const SizedBox(height: 6),
                Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  children: [
                    _Badge(
                      label: '风险：${capability.riskLabel}',
                      color: riskColor,
                    ),
                    _Badge(
                      label: '状态：${capability.availabilityLabel}',
                      color: capability.availabilityColor(p),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11.5,
          fontWeight: FontWeight.w500,
          color: color,
        ),
      ),
    );
  }
}

/// Rust `ApplicationRecord` 的只读投影。未知字段被忽略，缺失字段使用安全默认值，
/// 便于旧版 harness 与新增元数据共存。
class ApplicationCatalogEntry {
  const ApplicationCatalogEntry({
    required this.appId,
    required this.name,
    required this.version,
    required this.trustLevel,
    required this.enabled,
    required this.healthStatus,
    required this.healthDetail,
    required this.runtimeKind,
    required this.capabilities,
  });

  final String appId;
  final String name;
  final String version;
  final String trustLevel;
  final bool enabled;
  final String healthStatus;
  final String? healthDetail;
  final String runtimeKind;
  final List<ApplicationCapability> capabilities;

  static ApplicationCatalogEntry? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final json = raw.cast<String, dynamic>();
    final appId = _string(json, ['appId', 'app_id', 'id']);
    if (appId.isEmpty) return null;
    final health = json['health'] is Map
        ? (json['health'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    final rawCapabilities = json['capabilities'];
    final capabilities = rawCapabilities is List
        ? rawCapabilities
              .map(ApplicationCapability.fromJson)
              .whereType<ApplicationCapability>()
              .toList()
        : const <ApplicationCapability>[];
    return ApplicationCatalogEntry(
      appId: appId,
      name: _string(json, ['name'], fallback: appId),
      version: _string(json, ['version']),
      trustLevel: _string(json, ['trustLevel', 'trust_level'], fallback: 'untrusted'),
      enabled: json['enabled'] as bool? ?? false,
      healthStatus: _string(health, ['status'], fallback: 'unknown'),
      healthDetail: _optionalString(health, ['detail']),
      runtimeKind: _string(json, ['runtimeKind', 'runtime_kind']),
      capabilities: capabilities,
    );
  }

  String get trustLabel => switch (trustLevel) {
    'builtin' => '内置',
    'verified' => '已验证',
    'community' => '社区',
    'untrusted' => '未信任',
    _ => trustLevel.isEmpty ? '未知' : trustLevel,
  };

  Color trustColor(DawnPalette palette) => switch (trustLevel) {
    'builtin' => iosGreen,
    'verified' => iosBlue,
    'community' => iosOrange,
    _ => palette.ink2,
  };

  String get healthLabel => switch (healthStatus) {
    'ready' => '就绪',
    'starting' => '启动中',
    'failed' => '失败',
    'unavailable' => '不可用',
    'unknown' || '' => '未知',
    _ => healthStatus,
  };

  Color get healthColor => switch (healthStatus) {
    'ready' => iosGreen,
    'starting' => iosOrange,
    'failed' || 'unavailable' => iosRed,
    _ => iosOrange,
  };

  String get runtimeLabel => switch (runtimeKind) {
    'host_service' => '内置服务',
    'managed_project' => '托管项目',
    'mcp_server' => 'MCP',
    'electron_host' => '桌面宿主',
    'plugin' => '插件',
    _ => runtimeKind,
  };
}

class ApplicationCapability {
  const ApplicationCapability({
    required this.capabilityId,
    required this.title,
    required this.description,
    required this.risk,
    required this.availability,
  });

  final String capabilityId;
  final String title;
  final String description;
  final String risk;
  final String availability;

  static ApplicationCapability? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final json = raw.cast<String, dynamic>();
    final capabilityId = _string(json, [
      'capabilityId',
      'capability_id',
      'toolName',
      'tool_name',
      'id',
    ]);
    final title = _string(json, ['title', 'name'], fallback: capabilityId);
    if (capabilityId.isEmpty && title.isEmpty) return null;
    return ApplicationCapability(
      capabilityId: capabilityId,
      title: title.isEmpty ? capabilityId : title,
      description: _string(json, ['description']),
      risk: _string(json, ['risk'], fallback: 'read'),
      availability: _string(json, ['availability'], fallback: 'available'),
    );
  }

  String get riskLabel => switch (risk) {
    'read' => '只读',
    'write_reversible' => '可撤销写入',
    'write_destructive' => '破坏性写入',
    'external_effect' => '外部影响',
    _ => risk.isEmpty ? '未知' : risk,
  };

  Color get riskColor => switch (risk) {
    'read' => iosGreen,
    'write_reversible' => iosOrange,
    'write_destructive' => iosRed,
    'external_effect' => iosPurple,
    _ => iosOrange,
  };

  String get availabilityLabel => switch (availability) {
    'available' => '可用',
    'disabled' => '已禁用',
    'unavailable' => '不可用',
    'starting' => '启动中',
    _ => availability.isEmpty ? '未知' : availability,
  };

  Color availabilityColor(DawnPalette palette) => switch (availability) {
    'available' => iosGreen,
    'starting' => iosOrange,
    'unavailable' => iosRed,
    'disabled' => palette.ink2,
    _ => palette.ink2,
  };
}

List<ApplicationCatalogEntry> _parseApplications(Object? result) {
  Object? raw = result;
  if (result is Map) {
    raw = result['applications'] ?? result['items'] ?? result['apps'];
  }
  if (raw is! List) return const [];
  return raw
      .map(ApplicationCatalogEntry.fromJson)
      .whereType<ApplicationCatalogEntry>()
      .toList();
}

String _string(
  Map<String, dynamic> json,
  List<String> keys, {
  String fallback = '',
}) {
  for (final key in keys) {
    final value = json[key];
    if (value is String && value.trim().isNotEmpty) return value.trim();
  }
  return fallback;
}

String? _optionalString(Map<String, dynamic> json, List<String> keys) {
  for (final key in keys) {
    final value = json[key];
    if (value is String && value.trim().isNotEmpty) return value.trim();
  }
  return null;
}
