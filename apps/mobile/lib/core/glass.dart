/// 晨昏 2.0 · 流体玻璃材质系统。
///
/// 设计稿:docs/design/mobile-ui-directions.html(方向 A 配色 × iOS 26 Liquid Glass)。
/// - 三层玻璃规格:L1 浮岛(顶栏/输入条/抽屉)、L2 气泡、L3 内容(chips/工具卡)。
/// - 透镜感三要素:悬浮投影 + 顶部内高光描边 + 135° 斜向 sheen。
/// - 深浅两套 token:深色不是反色,玻璃换暗底、高光保留。
///
/// 性能约定:消息列表里的气泡用 [frostedBox](半透明填充,无 BackdropFilter),
/// 只有少量悬浮件(顶栏、输入胶囊、抽屉、chips)使用真 BackdropFilter。
library;

import 'dart:ui' show ImageFilter;

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart' show Colors, Theme;

/// 晨昏色板(一套亮色一套暗色,通过 [DawnPalette.of] 取用)。
class DawnPalette {
  const DawnPalette._({
    required this.isDark,
    required this.bgGradient,
    required this.ink,
    required this.ink2,
    required this.ink3,
    required this.indigo,
    required this.coral,
    required this.glassFill1,
    required this.glassFill2,
    required this.glassFill3,
    required this.glassBorder,
    required this.glassHighlight,
    required this.shadowColor,
    required this.userBubbleGradient,
    required this.aiBubbleFill,
    required this.aiBubbleBorder,
    required this.drawerFill,
    required this.groupedBg,
    required this.cardBg,
    required this.separator,
    required this.codeInlineBg,
    required this.tableHeadBg,
  });

  factory DawnPalette.of(BuildContext context) {
    // 走 Theme 亮度(而非平台亮度),跟随 MaterialApp 解析后的主题:
    // ThemeMode.system 时即系统深浅色,也兼容未来的手动覆盖。
    final dark = Theme.of(context).brightness == Brightness.dark;
    return dark ? const DawnPalette._dark() : const DawnPalette._light();
  }

  final bool isDark;

  /// 晨昏背景渐变(4 站,168° 近似:晨雾蓝 → 薄紫 → 曦光桃 → 暖橙)。
  final List<Color> bgGradient;
  final Color ink;
  final Color ink2;
  final Color ink3;
  final Color indigo;
  final Color coral;

  /// 三层玻璃填充/描边/内高光。
  final Color glassFill1;
  final Color glassFill2;
  final Color glassFill3;
  final Color glassBorder;
  final Color glassHighlight;
  final Color shadowColor;

  /// 用户气泡渐变(晨蓝 → 薄紫 → 曦橙)。
  final List<Color> userBubbleGradient;

  /// AI 气泡(列表内免 blur 的半透明填充)。
  final Color aiBubbleFill;
  final Color aiBubbleBorder;

  /// 抽屉玻璃填充。
  final Color drawerFill;

  /// 分组列表页中性色(设置/应用/绘图等子页全局生效)。
  final Color groupedBg;
  final Color cardBg;
  final Color separator;

  /// Markdown 行内代码底色 / 表头底色。
  final Color codeInlineBg;
  final Color tableHeadBg;

  const DawnPalette._light()
      : this._(
          isDark: false,
          bgGradient: const [
            Color(0xFFE0E7F6),
            Color(0xFFEBE8F2),
            Color(0xFFF8E9DF),
            Color(0xFFF5E0D6),
          ],
          ink: const Color(0xFF24252D),
          ink2: const Color(0xFF6A6F85),
          ink3: const Color(0xFF9A9EB2),
          indigo: const Color(0xFF5B6BE0),
          coral: const Color(0xFFE8826B),
          glassFill1: const Color(0x85FFFFFF),
          glassFill2: const Color(0x70FFFFFF),
          glassFill3: const Color(0x61FFFFFF),
          glassBorder: const Color(0xADFFFFFF),
          glassHighlight: const Color(0xF2FFFFFF),
          shadowColor: const Color(0x386068B4),
          userBubbleGradient: const [Color(0xFF5B6BE0), Color(0xFF9A6BD6), Color(0xFFE8826B)],
          aiBubbleFill: const Color(0x70FFFFFF),
          aiBubbleBorder: const Color(0x94FFFFFF),
          drawerFill: const Color(0xADF0F2FA),
          groupedBg: const Color(0xFFEEF0F6),
          cardBg: const Color(0xFFFFFFFF),
          separator: const Color(0xFFE3E5EE),
          codeInlineBg: const Color(0xFFE5E7EB),
          tableHeadBg: const Color(0xFFF2F2F7),
        );

  const DawnPalette._dark()
      : this._(
          isDark: true,
          // 夜间整体压暗、色温转蓝紫,曦橙只留在强调件上。
          bgGradient: const [
            Color(0xFF14161F),
            Color(0xFF1A1928),
            Color(0xFF231E2C),
            Color(0xFF292028),
          ],
          ink: const Color(0xFFECEDF2),
          ink2: const Color(0xFF9CA0B4),
          ink3: const Color(0xFF6E7286),
          indigo: const Color(0xFF8B96F0),
          coral: const Color(0xFFE89A82),
          glassFill1: const Color(0x8C12141E),
          glassFill2: const Color(0x7312141E),
          glassFill3: const Color(0x6112141E),
          glassBorder: const Color(0x2EFFFFFF),
          glassHighlight: const Color(0x33FFFFFF),
          shadowColor: const Color(0x66000000),
          userBubbleGradient: const [Color(0xFF6B7BE8), Color(0xFF9A6BD6), Color(0xFFE8826B)],
          aiBubbleFill: const Color(0x73181A26),
          aiBubbleBorder: const Color(0x2EFFFFFF),
          drawerFill: const Color(0xC2141620),
          groupedBg: const Color(0xFF14161F),
          cardBg: const Color(0xFF1F2129),
          separator: const Color(0xFF2E3038),
          codeInlineBg: const Color(0x1FFFFFFF),
          tableHeadBg: const Color(0x14FFFFFF),
        );
}

/// 玻璃层级:L1 浮岛 / L2 气泡 / L3 内容。
enum GlassLevel { l1, l2, l3 }

/// 流体玻璃容器:悬浮投影 + BackdropFilter + 内高光描边 + 斜向 sheen。
class GlassContainer extends StatelessWidget {
  const GlassContainer({
    required this.child,
    this.level = GlassLevel.l2,
    this.padding,
    this.radius = 20,
    this.fill,
    this.showSheen = true,
    this.showShadow = true,
    this.onTap,
    super.key,
  });

  final Widget child;
  final GlassLevel level;
  final EdgeInsetsGeometry? padding;
  final double radius;

  /// 覆盖默认填充色（如抽屉需要更实的玻璃底）。
  final Color? fill;
  final bool showSheen;
  final bool showShadow;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    final (levelFill, blur, shadow) = switch (level) {
      GlassLevel.l1 => (p.glassFill1, 24.0, 0.34),
      GlassLevel.l2 => (p.glassFill2, 16.0, 0.24),
      GlassLevel.l3 => (p.glassFill3, 12.0, 0.16),
    };
    final fill = this.fill ?? levelFill;

    Widget glass = ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: blur, sigmaY: blur),
        child: Container(
          padding: padding,
          decoration: BoxDecoration(
            color: fill,
            borderRadius: BorderRadius.circular(radius),
            border: Border.all(color: p.glassBorder, width: 1),
          ),
          child: Stack(
            children: [
              // 135° 斜向 sheen + 顶部内高光:透镜曲面感。
              if (showSheen)
                Positioned.fill(
                  child: IgnorePointer(
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(radius),
                        gradient: LinearGradient(
                          begin: Alignment.topLeft,
                          end: Alignment.bottomRight,
                          colors: [p.glassHighlight, const Color(0x00FFFFFF)],
                          stops: const [0.0, 0.45],
                        ),
                      ),
                    ),
                  ),
                ),
              child,
            ],
          ),
        ),
      ),
    );

    if (showShadow) {
      glass = Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(radius),
          boxShadow: [
            BoxShadow(
              color: p.shadowColor.withValues(alpha: shadow),
              blurRadius: level == GlassLevel.l1 ? 24 : 16,
              offset: Offset(0, level == GlassLevel.l1 ? 10 : 6),
            ),
          ],
        ),
        child: glass,
      );
    }

    if (onTap != null) {
      return GestureDetector(behavior: HitTestBehavior.opaque, onTap: onTap, child: glass);
    }
    return glass;
  }
}

/// 晨昏背景:168° 渐变的天空。
class DawnBackground extends StatelessWidget {
  const DawnBackground({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return Container(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: p.bgGradient,
          stops: const [0.0, 0.38, 0.76, 1.0],
        ),
      ),
      child: child,
    );
  }
}

/// 呼吸 Orb:AI 的存在感。思考时呼吸,静止时微光。
class DawnOrb extends StatefulWidget {
  const DawnOrb({this.size = 22, this.animate = true, super.key});

  final double size;
  final bool animate;

  @override
  State<DawnOrb> createState() => _DawnOrbState();
}

class _DawnOrbState extends State<DawnOrb> with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 4500));
    if (widget.animate) _ctrl.repeat(reverse: true);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return AnimatedBuilder(
      animation: _ctrl,
      builder: (context, _) {
        final t = widget.animate ? _ctrl.value : 0.0;
        final scale = 1.0 + 0.045 * t;
        final glow = 0.4 + 0.25 * t;
        return Transform.scale(
          scale: scale,
          child: Container(
            width: widget.size,
            height: widget.size,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: SweepGradient(
                colors: [p.indigo, const Color(0xFFB078D8), p.coral, p.indigo],
                transform: const GradientRotation(3.6),
              ),
              boxShadow: [
                BoxShadow(
                  color: Color.lerp(p.indigo, p.coral, 0.5)!.withValues(alpha: glow),
                  blurRadius: widget.size * (0.55 + 0.35 * t),
                  spreadRadius: widget.size * 0.06,
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

/// 流式光标:一道渐变的"光",而不是灰色转圈。
class LightCursor extends StatefulWidget {
  const LightCursor({super.key});

  @override
  State<LightCursor> createState() => _LightCursorState();
}

class _LightCursorState extends State<LightCursor> with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 1100))
      ..repeat(reverse: true);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return FadeTransition(
      opacity: Tween(begin: 0.25, end: 1.0).animate(_ctrl),
      child: Container(
        width: 2.5,
        height: 14,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(1.5),
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [p.indigo, p.coral],
          ),
          boxShadow: [BoxShadow(color: p.indigo.withValues(alpha: 0.7), blurRadius: 7)],
        ),
      ),
    );
  }
}

/// 开关 pill(深度思考 / 联网搜索)。
class GlassToggle extends StatelessWidget {
  const GlassToggle({
    required this.icon,
    required this.label,
    required this.on,
    required this.onTap,
    super.key,
  });

  final IconData icon;
  final String label;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    final color = on ? p.indigo : p.ink2;
    return GlassContainer(
      level: GlassLevel.l3,
      radius: 99,
      onTap: onTap,
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: color),
          const SizedBox(width: 5),
          Text(label,
              style: TextStyle(fontSize: 11, color: color, fontWeight: on ? FontWeight.w600 : FontWeight.w400)),
        ],
      ),
    );
  }
}

/// 渐变圆形发送键。
class DawnSendButton extends StatelessWidget {
  const DawnSendButton({required this.onTap, super.key});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 32,
        height: 32,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [p.indigo, p.coral],
          ),
          boxShadow: [
            BoxShadow(color: p.indigo.withValues(alpha: 0.45), blurRadius: 12, offset: const Offset(0, 4)),
          ],
          border: Border.all(color: p.glassHighlight, width: 1),
        ),
        child: const Icon(CupertinoIcons.arrow_up, size: 17, color: Colors.white),
      ),
    );
  }
}

/// 按小时取问候语(空态用)。
String dawnGreeting() {
  final h = DateTime.now().hour;
  if (h >= 5 && h < 11) return '早上好。';
  if (h >= 11 && h < 14) return '中午好。';
  if (h >= 14 && h < 18) return '下午好。';
  if (h >= 18 && h < 23) return '晚上好。';
  return '夜深了。';
}
