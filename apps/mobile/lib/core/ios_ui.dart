/// iOS 设计系统：主题、分组列表、导航栏、聊天气泡、输入条等共享组件。
/// 视觉对齐 Apple HIG：浅色分组列表（iOS 设置 App 风格）、SF 尺寸节奏、
/// 系统蓝 #007AFF、iOS Messages 气泡。
library;

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'harness_client.dart';
import 'providers.dart';

/// iOS 系统蓝。
const Color iosBlue = Color(0xFF007AFF);
const Color iosGreen = Color(0xFF34C759);
const Color iosRed = Color(0xFFFF3B30);
const Color iosOrange = Color(0xFFFF9500);
const Color iosPurple = Color(0xFFAF52DE);
const Color iosTeal = Color(0xFF30B0C7);
const Color iosIndigo = Color(0xFF5856D6);
const Color iosPink = Color(0xFFFF2D55);

/// 分组列表背景（iOS Settings 同款）。
const Color iosGroupedBg = Color(0xFFF2F2F7);
/// 卡片背景。
const Color iosCardBg = Color(0xFFFFFFFF);
/// 分隔线。
const Color iosSeparator = Color(0xFFE5E5EA);
/// 主文字。
const Color iosLabel = Color(0xFF000000);
/// 次级文字。
const Color iosSecondaryLabel = Color(0xFF8E8E93);
/// 助手气泡背景（iOS Messages 灰）。
const Color iosBubbleGray = Color(0xFFE9E9EB);

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
      builders: {TargetPlatform.iOS: CupertinoPageTransitionsBuilder(), TargetPlatform.macOS: CupertinoPageTransitionsBuilder()},
    ),
    textTheme: base.textTheme.apply(
      bodyColor: iosLabel,
      displayColor: iosLabel,
      fontFamilyFallback: const ['SF Pro Text', 'SF Pro Display', 'PingFang SC', 'Helvetica Neue'],
    ),
    dialogTheme: const DialogThemeData(backgroundColor: iosCardBg, surfaceTintColor: Colors.transparent),
    splashFactory: NoSplash.splashFactory,
  );
}

/// iOS 紧凑导航栏（无标题文字，图标左右分布，44pt 高）。
class IosNavBar extends StatelessWidget {
  const IosNavBar({super.key, this.leading, this.actions = const [], this.bottom});

  final Widget? leading;
  final List<Widget> actions;
  final Widget? bottom;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: iosGroupedBg.withValues(alpha: 0.94),
      child: Column(
        children: [
          SizedBox(
            height: 44,
            child: Row(
              children: [
                if (leading != null)
                  Padding(padding: const EdgeInsets.only(left: 4), child: leading!)
                else
                  const SizedBox(width: 12),
                const Spacer(),
                ...actions.map((a) => Padding(padding: const EdgeInsets.only(right: 6), child: a)),
                const SizedBox(width: 6),
              ],
            ),
          ),
          if (bottom != null) bottom!,
        ],
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
      backgroundColor: iosGroupedBg,
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
  const IosSection({required this.children, this.header, this.footer, super.key});

  final List<Widget> children;
  final String? header;
  final String? footer;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (header != null)
          Padding(
            padding: const EdgeInsets.only(left: 20, right: 20, top: 14, bottom: 6),
            child: Text(header!,
                style: const TextStyle(fontSize: 13, color: iosSecondaryLabel, letterSpacing: -0.1)),
          ),
        Container(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          decoration: BoxDecoration(
            color: iosCardBg,
            borderRadius: BorderRadius.circular(12),
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(children: _withSeparators(children)),
        ),
        if (footer != null)
          Padding(
            padding: const EdgeInsets.only(left: 20, right: 20, top: 6),
            child: Text(footer!, style: const TextStyle(fontSize: 12, color: iosSecondaryLabel)),
          ),
      ],
    );
  }

  List<Widget> _withSeparators(List<Widget> items) {
    final out = <Widget>[];
    for (var i = 0; i < items.length; i++) {
      out.add(items[i]);
      if (i != items.length - 1) {
        out.add(const Padding(
          padding: EdgeInsets.only(left: 56),
          child: Divider(height: 1, thickness: 0.5, color: iosSeparator),
        ));
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
    return CupertinoButton(
      padding: EdgeInsets.zero,
      onPressed: onTap,
      minSize: 0,
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
                    Text(title,
                        style: const TextStyle(fontSize: 16, letterSpacing: -0.3),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis),
                    if (subtitle != null && subtitle!.isNotEmpty) ...[
                      const SizedBox(height: 1),
                      Text(subtitle!,
                          style: const TextStyle(fontSize: 12.5, color: iosSecondaryLabel),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis),
                    ],
                  ],
                ),
              ),
              if (trailing != null) trailing!,
            ],
          ),
        ),
      ),
    );
  }
}

/// iOS 风格导航图标按钮。
class IosIconButton extends StatelessWidget {
  const IosIconButton({required this.icon, required this.onPressed, this.tooltip, super.key});

  final IconData icon;
  final VoidCallback? onPressed;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    return CupertinoButton(
      padding: const EdgeInsets.all(6),
      minSize: 0,
      onPressed: onPressed,
      child: Icon(icon, size: 22, color: iosBlue),
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
          Container(width: 7, height: 7, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          const SizedBox(width: 5),
          Text(label, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: color)),
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
          constraints: const BoxConstraints(maxWidth: 290),
          decoration: BoxDecoration(
            color: isUser ? iosBlue : iosBubbleGray,
            borderRadius: BorderRadius.only(
              topLeft: const Radius.circular(18),
              topRight: const Radius.circular(18),
              bottomLeft: Radius.circular(isUser ? 18 : 5),
              bottomRight: Radius.circular(isUser ? 5 : 18),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (isGroup && member != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 2),
                  child: Text('@$member',
                      style: const TextStyle(
                          fontSize: 12, fontWeight: FontWeight.w600, color: iosBlue)),
                ),
              Text(
                text.isEmpty && isStreaming ? '…' : text,
                style: TextStyle(
                  fontSize: 16.5,
                  height: 1.32,
                  letterSpacing: -0.3,
                  color: isUser ? const Color(0xFFFFFFFF) : iosLabel,
                ),
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
  const IosToolCard({required this.name, required this.text, this.isError = false, super.key});

  final String name;
  final String text;
  final bool isError;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        constraints: const BoxConstraints(maxWidth: 300),
        decoration: BoxDecoration(
          color: const Color(0xFFFFFFFF),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: isError ? iosRed.withValues(alpha: 0.4) : iosSeparator),
          boxShadow: [
            BoxShadow(
              color: const Color(0x14000000),
              blurRadius: 8,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              isError ? CupertinoIcons.exclamationmark_circle_fill : CupertinoIcons.wrench_fill,
              size: 15,
              color: isError ? iosRed : iosBlue,
            ),
            const SizedBox(width: 7),
            Flexible(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('工具 · $name',
                      style: const TextStyle(
                          fontSize: 12, fontWeight: FontWeight.w600, letterSpacing: -0.2)),
                  const SizedBox(height: 2),
                  Text(text, style: const TextStyle(fontSize: 12, color: iosSecondaryLabel)),
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
    super.key,
  });

  final TextEditingController controller;
  final VoidCallback onSend;
  final ValueChanged<String>? onSubmitted;
  final String hint;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 6, 10, 6),
      decoration: const BoxDecoration(
        color: iosGroupedBg,
        border: Border(top: BorderSide(color: iosSeparator, width: 0.5)),
      ),
      child: SafeArea(
        top: false,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: CupertinoTextField(
                controller: controller,
                placeholder: hint,
                padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 8),
                decoration: BoxDecoration(
                  color: iosCardBg,
                  borderRadius: BorderRadius.circular(18),
                  border: Border.all(color: iosSeparator),
                ),
                style: const TextStyle(fontSize: 16, letterSpacing: -0.3, color: iosLabel),
                onSubmitted: onSubmitted,
                minLines: 1,
                maxLines: 4,
              ),
            ),
            const SizedBox(width: 8),
            GestureDetector(
              onTap: onSend,
              child: Container(
                width: 32,
                height: 32,
                decoration: const BoxDecoration(color: iosBlue, shape: BoxShape.circle),
                child: const Icon(CupertinoIcons.arrow_up, size: 18, color: Color(0xFFFFFFFF)),
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
  const IosPrimaryButton({required this.label, required this.onPressed, this.icon, super.key});

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
          Text(label, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}

/// 底部 Tab 栏（CupertinoTabBar）。
class IosTabBar extends StatelessWidget {
  const IosTabBar({required this.currentIndex, required this.onTap, super.key});

  final int currentIndex;
  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) {
    return CupertinoTabBar(
      currentIndex: currentIndex,
      onTap: onTap,
      backgroundColor: const Color(0xF9F9F9F9),
      activeColor: iosBlue,
      inactiveColor: iosSecondaryLabel,
      height: 52,
      items: const [
        BottomNavigationBarItem(
            icon: Icon(CupertinoIcons.chat_bubble, size: 24), label: '对话'),
        BottomNavigationBarItem(
            icon: Icon(CupertinoIcons.square_grid_2x2, size: 24), label: '应用'),
        BottomNavigationBarItem(
            icon: Icon(CupertinoIcons.star_fill, size: 24), label: '绘图'),
        BottomNavigationBarItem(
            icon: Icon(CupertinoIcons.person_crop_circle, size: 24), label: '我的'),
      ],
    );
  }
}

/// iOS 空态视图。
class IosEmptyHint extends StatelessWidget {
  const IosEmptyHint({required this.icon, required this.title, this.subtitle, super.key});

  final IconData icon;
  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 52, color: const Color(0xFFC7C7CC)),
          const SizedBox(height: 12),
          Text(title,
              style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600, letterSpacing: -0.4)),
          if (subtitle != null) ...[
            const SizedBox(height: 4),
            Text(subtitle!, textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 13, color: iosSecondaryLabel)),
          ],
        ],
      ),
    );
  }
}

/// Cupertino 右滑返回路由。
PageRouteBuilder cupertinoRoute(Widget page) {
  return PageRouteBuilder(
    pageBuilder: (_, __, ___) => page,
    transitionsBuilder: (_, animation, __, child) => SlideTransition(
      position: Tween(begin: const Offset(1, 0), end: Offset.zero)
          .animate(CurvedAnimation(parent: animation, curve: Curves.easeOutCubic)),
      child: child,
    ),
    transitionDuration: const Duration(milliseconds: 320),
    reverseTransitionDuration: const Duration(milliseconds: 280),
  );
}

/// Drawer 白色化容器（会话抽屉用）。
class IosDrawer extends StatelessWidget {
  const IosDrawer({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Drawer(
      backgroundColor: iosGroupedBg,
      shape: const RoundedRectangleBorder(),
      child: child,
    );
  }
}
