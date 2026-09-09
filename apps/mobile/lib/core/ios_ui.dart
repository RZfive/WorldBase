/// 共享设计系统（晨昏 2.0）：主题、分组列表、导航栏、聊天气泡、输入条。
///
/// 配色定稿方向 A「晨昏」：晨蓝 #5B6BE0 → 曦橙 #E8826B，薄雾蓝分组底。
/// 对话主页的流体玻璃材质在 core/glass.dart；本文件的组件服务于
/// 设置/应用/绘图等分组列表页与群组页（深浅色续接见 glass.dart 的 DawnPalette）。
library;

import 'dart:ui' show ImageFilter;

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'glass.dart';
import 'markdown_renderer.dart';
import 'providers.dart';

/// 晨蓝（晨昏主色，原 iOS 系统蓝 #007AFF 的替换）。
const Color iosBlue = Color(0xFF5B6BE0);
const Color iosGreen = Color(0xFF34C759);
const Color iosRed = Color(0xFFFF3B30);
const Color iosOrange = Color(0xFFFF9500);
const Color iosPurple = Color(0xFF9A6BD6);
const Color iosTeal = Color(0xFF30B0C7);
const Color iosIndigo = Color(0xFF5B6BE0);
const Color iosPink = Color(0xFFE8826B);

/// 曦橙（渐变副色）。
const Color dawnCoral = Color(0xFFE8826B);

/// 分组列表背景（薄雾蓝，原冷灰 #F2F2F7 的升温版）。
const Color iosGroupedBg = Color(0xFFEEF0F6);

/// 卡片背景。
const Color iosCardBg = Color(0xFFFFFFFF);

/// 分隔线。
const Color iosSeparator = Color(0xFFE3E5EE);

/// 主文字。
const Color iosLabel = Color(0xFF24252D);

/// 次级文字。
const Color iosSecondaryLabel = Color(0xFF6A6F85);

/// 助手气泡背景（晨昏雾白）。
const Color iosBubbleGray = Color(0xFFF7F8FC);

/// App 全局主题：iOS 观感的浅色 Material 容器（保留 Navigator 能力）。
ThemeData buildIosTheme() {
  final base = ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    platform: TargetPlatform.iOS,
    colorScheme: const ColorScheme.light(
      primary: iosBlue,
      onPrimary: Color(0xFFFFFFFF),
      surface: iosCardBg,
      onSurface: iosLabel,
    ),
  );
  return base.copyWith(
    scaffoldBackgroundColor: iosGroupedBg,
    pageTransitionsTheme: const PageTransitionsTheme(
      builders: {
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
      },
    ),
    textTheme: base.textTheme.apply(
      bodyColor: iosLabel,
      displayColor: iosLabel,
      fontFamilyFallback: const [
        'SF Pro Text',
        'SF Pro Display',
        'PingFang SC',
        'Helvetica Neue',
      ],
    ),
    dialogTheme: const DialogThemeData(
      backgroundColor: iosCardBg,
      surfaceTintColor: Colors.transparent,
    ),
    splashFactory: NoSplash.splashFactory,
  );
}

/// 晨昏深色主题：夜色蓝紫底,玻璃高光保留(对话主页的深色由 DawnPalette 驱动)。
ThemeData buildDawnDarkTheme() {
  final base = ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    platform: TargetPlatform.iOS,
    colorScheme: const ColorScheme.dark(
      primary: Color(0xFF8B96F0),
      onPrimary: Color(0xFF14161F),
      surface: Color(0xFF1C1E28),
      onSurface: Color(0xFFECEDF2),
    ),
  );
  return base.copyWith(
    scaffoldBackgroundColor: const Color(0xFF14161F),
    pageTransitionsTheme: const PageTransitionsTheme(
      builders: {
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
      },
    ),
    textTheme: base.textTheme.apply(
      bodyColor: const Color(0xFFECEDF2),
      displayColor: const Color(0xFFECEDF2),
      fontFamilyFallback: const [
        'SF Pro Text',
        'SF Pro Display',
        'PingFang SC',
        'Helvetica Neue',
      ],
    ),
    dialogTheme: const DialogThemeData(
      backgroundColor: Color(0xFF1C1E28),
      surfaceTintColor: Colors.transparent,
    ),
    splashFactory: NoSplash.splashFactory,
  );
}

/// iOS 紧凑导航栏（无标题文字，图标左右分布，44pt 高）。
class IosNavBar extends StatelessWidget {
  const IosNavBar({
    super.key,
    this.leading,
    this.actions = const [],
    this.bottom,
  });

  final Widget? leading;
  final List<Widget> actions;
  final Widget? bottom;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return ClipRect(
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 20, sigmaY: 20),
        child: Container(
          color: p.groupedBg.withValues(alpha: 0.82),
          child: Column(
            children: [
              SizedBox(
                height: 44,
                child: Row(
                  children: [
                    if (leading != null)
                      Padding(
                        padding: const EdgeInsets.only(left: 4),
                        child: leading!,
                      )
                    else
                      const SizedBox(width: 12),
                    const Spacer(),
                    ...actions.map(
                      (a) => Padding(
                        padding: const EdgeInsets.only(right: 6),
                        child: a,
                      ),
                    ),
                    const SizedBox(width: 6),
                  ],
                ),
              ),
              ?bottom,
            ],
          ),
        ),
      ),
    );
  }
}

/// 屏幕容器：iOS 分组背景。
class IosScreen extends StatelessWidget {
  const IosScreen({required this.child, this.navBar, super.key});

  final Widget child;
  final Widget? navBar;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: DawnPalette.of(context).groupedBg,
      drawer: null,
      body: Column(
        children: [
          if (navBar != null) SafeArea(bottom: false, child: navBar!),
          Expanded(child: child),
        ],
      ),
    );
  }
}

/// 内嵌分组卡片（inset grouped）+ 头部标题。
class IosSection extends StatelessWidget {
  const IosSection({
    required this.children,
    this.header,
    this.footer,
    super.key,
  });

  final List<Widget> children;
  final String? header;
  final String? footer;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (header != null)
          Padding(
            padding: const EdgeInsets.only(
              left: 20,
              right: 20,
              top: 14,
              bottom: 6,
            ),
            child: Text(
              header!,
              style: TextStyle(
                fontSize: 13,
                color: p.ink2,
                letterSpacing: -0.1,
              ),
            ),
          ),
        Container(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          decoration: BoxDecoration(
            color: p.cardBg,
            borderRadius: BorderRadius.circular(16),
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(children: _withSeparators(children, p)),
        ),
        if (footer != null)
          Padding(
            padding: const EdgeInsets.only(left: 20, right: 20, top: 6),
            child: Text(footer!, style: TextStyle(fontSize: 12, color: p.ink2)),
          ),
      ],
    );
  }

  List<Widget> _withSeparators(List<Widget> items, DawnPalette p) {
    final out = <Widget>[];
    for (var i = 0; i < items.length; i++) {
      out.add(items[i]);
      if (i != items.length - 1) {
        out.add(
          Padding(
            padding: const EdgeInsets.only(left: 56),
            child: Divider(height: 1, thickness: 0.5, color: p.separator),
          ),
        );
      }
    }
    return out;
  }
}

/// 设置行：彩色圆角图标块 + 标题/副标题 + 尾部。
class IosRow extends StatelessWidget {
  const IosRow({
    required this.icon,
    required this.iconColor,
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
    this.onLongPress,
    super.key,
  });

  final IconData icon;
  final Color iconColor;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return CupertinoButton(
      padding: EdgeInsets.zero,
      onPressed: onTap,
      minimumSize: Size(0, 0),
      child: GestureDetector(
        onLongPress: onLongPress,
        behavior: HitTestBehavior.opaque,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: Row(
            children: [
              Container(
                width: 30,
                height: 30,
                decoration: BoxDecoration(
                  color: iconColor,
                  borderRadius: BorderRadius.circular(7),
                ),
                child: Icon(icon, size: 17, color: const Color(0xFFFFFFFF)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: TextStyle(
                        fontSize: 16,
                        letterSpacing: -0.3,
                        color: p.ink,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (subtitle != null && subtitle!.isNotEmpty) ...[
                      const SizedBox(height: 1),
                      Text(
                        subtitle!,
                        style: TextStyle(fontSize: 12.5, color: p.ink2),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ],
                ),
              ),
              ?trailing,
            ],
          ),
        ),
      ),
    );
  }
}

/// iOS 风格导航图标按钮。
class IosIconButton extends StatelessWidget {
  const IosIconButton({
    required this.icon,
    required this.onPressed,
    this.tooltip,
    super.key,
  });

  final IconData icon;
  final VoidCallback? onPressed;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    return CupertinoButton(
      padding: const EdgeInsets.all(6),
      onPressed: onPressed,
      minimumSize: Size(0, 0),
      child: Icon(icon, size: 22, color: DawnPalette.of(context).indigo),
    );
  }
}

/// 连接状态徽标（右上角小圆点 + 文字）。
class ConnectionBadge extends ConsumerWidget {
  const ConnectionBadge({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(connectionProvider);
    final (color, label) = switch (state) {
      HarnessState.connected => (iosGreen, '已连接'),
      HarnessState.connecting => (iosOrange, '连接中'),
      HarnessState.disconnected => (iosRed, '未连接'),
    };
    return Container(
      margin: const EdgeInsets.only(right: 12),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 5),
          Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w500,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}

/// iOS Messages 风格聊天气泡。
class IosBubble extends StatelessWidget {
  const IosBubble({
    required this.text,
    required this.isUser,
    this.isStreaming = false,
    this.isGroup = false,
    this.member,
    this.onLongPress,
    super.key,
  });

  final String text;
  final bool isUser;
  final bool isStreaming;
  final bool isGroup;
  final String? member;
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
            top: 3,
            bottom: 3,
            left: isUser ? 56 : 8,
            right: isUser ? 8 : 56,
          ),
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 9),
          constraints: BoxConstraints(
            maxWidth:
                (MediaQuery.sizeOf(context).width * (isUser ? 0.86 : 0.96))
                    .clamp(260.0, 680.0),
          ),
          decoration: BoxDecoration(
            color: isUser ? null : p.cardBg,
            gradient: isUser
                ? const LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [
                      Color(0xFF5B6BE0),
                      Color(0xFF9A6BD6),
                      Color(0xFFE8826B),
                    ],
                  )
                : null,
            border: isUser ? null : Border.all(color: p.separator),
            borderRadius: BorderRadius.only(
              topLeft: const Radius.circular(21),
              topRight: const Radius.circular(21),
              bottomLeft: Radius.circular(isUser ? 21 : 8),
              bottomRight: Radius.circular(isUser ? 8 : 21),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (isGroup && member != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 2),
                  child: Text(
                    '@$member',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: p.indigo,
                    ),
                  ),
                ),
              MarkdownMessage(
                data: text.isEmpty && isStreaming ? '…' : text,
                isUser: isUser,
                isStreaming: isStreaming,
              ),
              if (isStreaming)
                const Padding(
                  padding: EdgeInsets.only(top: 4),
                  child: CupertinoActivityIndicator(radius: 7),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 工具调用卡片（iOS 通知样式）。
class IosToolCard extends StatelessWidget {
  const IosToolCard({
    required this.name,
    required this.text,
    this.isError = false,
    super.key,
  });

  final String name;
  final String text;
  final bool isError;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        constraints: const BoxConstraints(maxWidth: 300),
        decoration: BoxDecoration(
          color: p.cardBg,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: isError ? iosRed.withValues(alpha: 0.4) : p.separator,
          ),
          boxShadow: [
            BoxShadow(
              color: p.shadowColor.withValues(alpha: 0.12),
              blurRadius: 16,
              offset: const Offset(0, 6),
            ),
          ],
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              isError
                  ? CupertinoIcons.exclamationmark_circle_fill
                  : CupertinoIcons.wrench_fill,
              size: 15,
              color: isError ? iosRed : p.indigo,
            ),
            const SizedBox(width: 7),
            Flexible(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '工具 · $name',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      letterSpacing: -0.2,
                      color: p.ink,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(text, style: TextStyle(fontSize: 12, color: p.ink2)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// iOS 信息风格输入条（圆角输入 + 蓝色圆形发送键）。
class IosChatInputBar extends StatelessWidget {
  const IosChatInputBar({
    required this.controller,
    required this.onSend,
    this.hint = '信息',
    this.onSubmitted,
    this.onChanged,
    this.focusNode,
    this.leading,
    this.enabled = true,
    this.sendEnabled = true,
    super.key,
  });

  final TextEditingController controller;
  final VoidCallback onSend;
  final ValueChanged<String>? onSubmitted;
  final ValueChanged<String>? onChanged;
  final FocusNode? focusNode;
  final Widget? leading;
  final String hint;
  final bool enabled;
  final bool sendEnabled;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 6, 12, 8),
      decoration: BoxDecoration(
        color: p.groupedBg,
        border: Border(top: BorderSide(color: p.separator, width: 0.5)),
      ),
      child: SafeArea(
        top: false,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            if (leading != null) ...[
              SizedBox(width: 36, height: 36, child: Center(child: leading)),
              const SizedBox(width: 4),
            ],
            Expanded(
              child: CupertinoTextField(
                controller: controller,
                focusNode: focusNode,
                enabled: enabled,
                placeholder: hint,
                placeholderStyle: TextStyle(fontSize: 16, color: p.ink3),
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 9,
                ),
                decoration: BoxDecoration(
                  color: p.cardBg,
                  borderRadius: BorderRadius.circular(22),
                  border: Border.all(color: p.separator),
                ),
                style: TextStyle(
                  fontSize: 16,
                  letterSpacing: -0.3,
                  color: p.ink,
                ),
                onSubmitted: onSubmitted,
                onChanged: onChanged,
                minLines: 1,
                maxLines: 4,
              ),
            ),
            const SizedBox(width: 8),
            Opacity(
              opacity: sendEnabled ? 1 : 0.42,
              child: GestureDetector(
                onTap: sendEnabled ? onSend : null,
                child: Container(
                  width: 32,
                  height: 32,
                  decoration: const BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [Color(0xFF5B6BE0), Color(0xFFE8826B)],
                    ),
                  ),
                  child: const Icon(
                    CupertinoIcons.arrow_up,
                    size: 17,
                    color: Color(0xFFFFFFFF),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// iOS 主按钮。
class IosPrimaryButton extends StatelessWidget {
  const IosPrimaryButton({
    required this.label,
    required this.onPressed,
    this.icon,
    super.key,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return CupertinoButton.filled(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
      onPressed: onPressed,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[Icon(icon, size: 16), const SizedBox(width: 6)],
          Text(
            label,
            style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}

/// iOS 空态视图。
class IosEmptyHint extends StatelessWidget {
  const IosEmptyHint({
    required this.icon,
    required this.title,
    this.subtitle,
    super.key,
  });

  final IconData icon;
  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 52, color: p.ink3),
          const SizedBox(height: 12),
          Text(
            title,
            style: TextStyle(
              fontSize: 17,
              fontWeight: FontWeight.w600,
              letterSpacing: -0.4,
              color: p.ink,
            ),
          ),
          if (subtitle != null) ...[
            const SizedBox(height: 4),
            Text(
              subtitle!,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: p.ink2),
            ),
          ],
        ],
      ),
    );
  }
}

/// Cupertino 右滑返回路由。
PageRouteBuilder cupertinoRoute(Widget page) {
  return PageRouteBuilder(
    pageBuilder: (_, _, _) => page,
    transitionsBuilder: (_, animation, _, child) => SlideTransition(
      position: Tween(
        begin: const Offset(1, 0),
        end: Offset.zero,
      ).animate(CurvedAnimation(parent: animation, curve: Curves.easeOutCubic)),
      child: child,
    ),
    transitionDuration: const Duration(milliseconds: 320),
    reverseTransitionDuration: const Duration(milliseconds: 280),
  );
}

/// 抽屉/子页通用容器（分组底,跟随深浅色）。
class IosDrawer extends StatelessWidget {
  const IosDrawer({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Drawer(
      backgroundColor: DawnPalette.of(context).groupedBg,
      shape: const RoundedRectangleBorder(),
      child: child,
    );
  }
}
