import 'dart:convert';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_highlight/flutter_highlight.dart';
import 'package:flutter_highlight/themes/atom-one-dark.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'ios_ui.dart';

/// Markdown renderer shared by one-to-one and group conversations.
///
/// The desktop renderer is based on marked and adds GFM, syntax highlighting,
/// KaTeX, footnotes, safe HTML, and Mermaid blocks. This widget keeps the same
/// document-level behavior on Flutter while using native Flutter widgets for
/// the parts that need interaction or accessibility.
class MarkdownMessage extends StatelessWidget {
  const MarkdownMessage({
    required this.data,
    required this.isUser,
    this.isStreaming = false,
    super.key,
  });

  final String data;
  final bool isUser;
  final bool isStreaming;

  @override
  Widget build(BuildContext context) {
    if (data.isEmpty && isStreaming) {
      return const Text('…');
    }
    if (data.isEmpty) return const SizedBox.shrink();

    final foreground = isUser ? Colors.white : iosLabel;
    final muted = isUser ? Colors.white70 : iosSecondaryLabel;
    final accent = isUser ? Colors.white : iosBlue;

    final styleSheet = MarkdownStyleSheet(
      p: TextStyle(fontSize: 16.5, height: 1.32, color: foreground),
      a: TextStyle(color: accent, decoration: TextDecoration.underline),
      h1: TextStyle(
        fontSize: 20,
        height: 1.35,
        fontWeight: FontWeight.w700,
        color: foreground,
      ),
      h2: TextStyle(
        fontSize: 18.5,
        height: 1.35,
        fontWeight: FontWeight.w700,
        color: foreground,
      ),
      h3: TextStyle(
        fontSize: 17.5,
        height: 1.35,
        fontWeight: FontWeight.w700,
        color: foreground,
      ),
      h4: TextStyle(
        fontSize: 16.5,
        height: 1.35,
        fontWeight: FontWeight.w700,
        color: foreground,
      ),
      h5: TextStyle(
        fontSize: 16,
        height: 1.35,
        fontWeight: FontWeight.w700,
        color: foreground,
      ),
      h6: TextStyle(
        fontSize: 15.5,
        height: 1.35,
        fontWeight: FontWeight.w700,
        color: muted,
      ),
      em: TextStyle(fontStyle: FontStyle.italic, color: foreground),
      strong: TextStyle(fontWeight: FontWeight.w700, color: foreground),
      del: TextStyle(decoration: TextDecoration.lineThrough, color: muted),
      blockquote: TextStyle(fontSize: 16, height: 1.32, color: muted),
      blockquoteDecoration: BoxDecoration(
        border: Border(
          left: BorderSide(color: isUser ? Colors.white70 : iosBlue, width: 3),
        ),
      ),
      blockquotePadding: const EdgeInsets.only(left: 12),
      code: TextStyle(
        fontFamily: 'monospace',
        fontSize: 13.5,
        height: 1.45,
        color: isUser ? Colors.white : const Color(0xFF1F2937),
        backgroundColor: isUser ? Colors.white24 : const Color(0xFFE5E7EB),
      ),
      codeblockDecoration: BoxDecoration(
        color: isUser ? const Color(0xFF1F2937) : const Color(0xFF282C34),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: isUser ? Colors.white24 : const Color(0xFF3F4652),
        ),
      ),
      codeblockPadding: const EdgeInsets.all(12),
      tableHead: TextStyle(fontWeight: FontWeight.w700, color: foreground),
      tableBody: TextStyle(fontSize: 14, height: 1.35, color: foreground),
      tableBorder: TableBorder.all(
        color: isUser ? Colors.white38 : iosSeparator,
        width: 0.8,
      ),
      tableHeadCellsDecoration: BoxDecoration(
        color: isUser ? Colors.white12 : const Color(0xFFF2F2F7),
      ),
      tableCellsPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      tableHeadCellsPadding: const EdgeInsets.symmetric(
        horizontal: 8,
        vertical: 6,
      ),
      tablePadding: const EdgeInsets.symmetric(vertical: 6),
      horizontalRuleDecoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: isUser ? Colors.white38 : iosSeparator),
        ),
      ),
      listIndent: 22,
      listBullet: TextStyle(fontSize: 16, color: foreground),
      checkbox: TextStyle(fontSize: 17, color: isUser ? Colors.white : iosBlue),
      blockSpacing: 8,
      textScaler: MediaQuery.textScalerOf(context),
    );

    return MarkdownBody(
      data: data,
      extensionSet: md.ExtensionSet.gitHubFlavored,
      blockSyntaxes: [DisplayMathBlockSyntax()],
      inlineSyntaxes: [InlineMathSyntax(), HighlightInlineSyntax()],
      styleSheet: styleSheet,
      softLineBreak: true,
      builders: {
        'pre': CodeBlockBuilder(isUser: isUser, isStreaming: isStreaming),
        'math': MathElementBuilder(foreground: foreground),
        'math-block': MathElementBuilder(foreground: foreground, block: true),
        'mark': HighlightElementBuilder(isUser: isUser),
        'u': InlineStyleElementBuilder(
          style: const TextStyle(decoration: TextDecoration.underline),
        ),
        'ins': InlineStyleElementBuilder(
          style: const TextStyle(decoration: TextDecoration.underline),
        ),
        's': InlineStyleElementBuilder(
          style: const TextStyle(decoration: TextDecoration.lineThrough),
        ),
        'kbd': KbdElementBuilder(isUser: isUser),
      },
      checkboxBuilder: (checked) => Icon(
        checked ? CupertinoIcons.checkmark_square_fill : CupertinoIcons.square,
        size: 17,
        color: isUser ? Colors.white : iosBlue,
      ),
      imageBuilder: (uri, title, alt) =>
          MarkdownImage(uri: uri, title: title, alt: alt),
      onTapLink: (text, href, title) => _openLink(href),
    );
  }

  Future<void> _openLink(String? href) async {
    final uri = Uri.tryParse(href ?? '');
    if (uri == null || uri.fragment.isNotEmpty && uri.scheme.isEmpty) return;
    if (!const {'http', 'https', 'mailto'}.contains(uri.scheme.toLowerCase())) {
      return;
    }
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }
}

/// Parses standalone $$...$$ and \\[...\\] blocks before paragraph parsing.
class DisplayMathBlockSyntax extends md.BlockSyntax {
  const DisplayMathBlockSyntax();

  @override
  RegExp get pattern => RegExp(r'^ {0,3}(?:\$\$|\\\[)\s*$');

  @override
  md.Node? parse(md.BlockParser parser) {
    final opening = parser.current.content.trim();
    final close = opening == r'$$'
        ? RegExp(r'^ {0,3}\$\$\s*$')
        : RegExp(r'^ {0,3}\\\]\s*$');
    var offset = 1;
    final lines = <String>[];
    var foundClose = false;
    while (true) {
      final line = parser.peek(offset);
      if (line == null) break;
      if (close.hasMatch(line.content)) {
        foundClose = true;
        break;
      }
      lines.add(line.content);
      offset += 1;
    }
    if (!foundClose) return null;

    for (var i = 0; i <= offset; i++) {
      parser.advance();
    }
    return md.Element.empty('math-block')
      ..attributes['expression'] = lines.join('\n');
  }
}

/// Inline math syntax for $...$, $$...$$, \\(...\\), and \\[...\\].
class InlineMathSyntax extends md.InlineSyntax {
  InlineMathSyntax()
      : super(
          r'(?<!\\)\$\$([\s\S]+?)\$\$|(?<!\\)\\\[([\s\S]+?)\\\]|\\\(([^\n]+?)\\\)|(?<![\\$])\$((?:\\.|[^$\n])+?)\$(?!\$)',
        );

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final expression =
        match.group(1) ?? match.group(2) ?? match.group(3) ?? match.group(4);
    if (expression == null || expression.trim().isEmpty) return false;
    final display = match.group(1) != null || match.group(2) != null;
    parser.addNode(
      md.Element.empty('math')
        ..attributes['expression'] = expression
        ..attributes['display'] = display ? 'true' : 'false',
    );
    return true;
  }
}

/// Allows the desktop renderer's ==highlight== extension in inline text.
class HighlightInlineSyntax extends md.InlineSyntax {
  HighlightInlineSyntax() : super(r'(?<!\\)==([^\n]+?)==');

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final value = match.group(1);
    if (value == null || value.trim().isEmpty) return false;
    parser.addNode(md.Element('mark', parser.document.parseInline(value)));
    return true;
  }
}

class MathElementBuilder extends MarkdownElementBuilder {
  MathElementBuilder({required this.foreground, this.block = false});

  final Color foreground;
  final bool block;

  @override
  bool isBlockElement() => block;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final expression = element.attributes['expression'] ?? '';
    if (expression.trim().isEmpty) return null;
    final style =
        parentStyle ?? preferredStyle ?? DefaultTextStyle.of(context).style;
    final display = block || element.attributes['display'] == 'true';
    final math = Math.tex(
      _normalizeMathExpression(expression),
      mathStyle: display ? MathStyle.display : MathStyle.text,
      textStyle: style.copyWith(color: foreground),
    );
    if (!display) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 1),
        child: math,
      );
    }
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: math,
    );
  }
}

String _normalizeMathExpression(String expression) {
  final normalized = expression.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  return normalized
      .split('\n')
      .map((line) {
        final trimmed = line.trimRight();
        if (trimmed.endsWith(r'\') && !trimmed.endsWith(r'\\')) {
          return '$trimmed\\';
        }
        return line;
      })
      .join('\n');
}

class HighlightElementBuilder extends MarkdownElementBuilder {
  HighlightElementBuilder({required this.isUser});

  final bool isUser;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final text = element.textContent;
    return Container(
      decoration: BoxDecoration(
        color: isUser
            ? const Color(0xFFFFD54F).withValues(alpha: 0.38)
            : const Color(0xFFFFD54F).withValues(alpha: 0.34),
        borderRadius: BorderRadius.circular(4),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 1),
      child: Text(
        text,
        style:
            (parentStyle ??
                    preferredStyle ??
                    DefaultTextStyle.of(context).style)
                .copyWith(color: isUser ? Colors.white : iosLabel),
      ),
    );
  }
}

class InlineStyleElementBuilder extends MarkdownElementBuilder {
  InlineStyleElementBuilder({required this.style});

  final TextStyle style;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final textStyle =
        (parentStyle ?? preferredStyle ?? DefaultTextStyle.of(context).style)
            .merge(style);
    return Text(element.textContent, style: textStyle);
  }
}

class KbdElementBuilder extends MarkdownElementBuilder {
  KbdElementBuilder({required this.isUser});

  final bool isUser;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final textStyle =
        parentStyle ?? preferredStyle ?? DefaultTextStyle.of(context).style;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: isUser ? Colors.white24 : const Color(0xFFE5E7EB),
        border: Border.all(color: isUser ? Colors.white54 : iosSeparator),
        borderRadius: BorderRadius.circular(5),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
        child: Text(
          element.textContent,
          style: textStyle.copyWith(
            fontFamily: 'monospace',
            fontSize: (textStyle.fontSize ?? 16) * 0.86,
          ),
        ),
      ),
    );
  }
}

class CodeBlockBuilder extends MarkdownElementBuilder {
  CodeBlockBuilder({required this.isUser, required this.isStreaming});

  final bool isUser;
  final bool isStreaming;

  @override
  bool isBlockElement() => true;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final codeElement = element.children?.whereType<md.Element>().firstWhere(
      (child) => child.tag == 'code',
      orElse: () => md.Element.text('code', element.textContent),
    );
    final code = (codeElement?.textContent ?? element.textContent).replaceFirst(
      RegExp(r'\n$'),
      '',
    );
    final className = codeElement?.attributes['class'] ?? '';
    final language = className
        .replaceFirst(RegExp(r'^language-'), '')
        .trim()
        .toLowerCase();

    if (language == 'mermaid') {
      if (isStreaming) return _codeFallback(code, language, isUser);
      return MermaidDiagramCard(code: code, isUser: isUser);
    }

    return _codeFallback(code, language, isUser);
  }
}

Widget _codeFallback(String code, String language, bool isUser) {
  final label = language.isEmpty ? null : language;
  return Container(
    width: double.infinity,
    decoration: BoxDecoration(
      color: isUser ? const Color(0xFF1F2937) : const Color(0xFF282C34),
      borderRadius: BorderRadius.circular(10),
    ),
    clipBehavior: Clip.antiAlias,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (label != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 9, 12, 0),
            child: Text(
              label.toUpperCase(),
              style: const TextStyle(
                fontSize: 10,
                color: Color(0xFF9CA3AF),
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.all(12),
          child: HighlightView(
            code,
            language: language.isEmpty ? 'plaintext' : language,
            theme: atomOneDarkTheme,
            textStyle: const TextStyle(
              fontFamily: 'monospace',
              fontSize: 13.5,
              height: 1.45,
            ),
            padding: EdgeInsets.zero,
          ),
        ),
      ],
    ),
  );
}

class MarkdownImage extends StatelessWidget {
  const MarkdownImage({required this.uri, this.title, this.alt, super.key});

  final Uri uri;
  final String? title;
  final String? alt;

  @override
  Widget build(BuildContext context) {
    final image = _buildImage(alt);
    return GestureDetector(
      onTap: () => _showPreview(context),
      child: _imageFrame(image),
    );
  }

  Widget _buildImage(String? fallbackAlt) {
    final scheme = uri.scheme.toLowerCase();
    if (scheme == 'data') {
      final match = RegExp(
        r'^data:image/(?:png|gif|jpe?g|webp|bmp|x-icon);base64,([a-z0-9+/]+=*)$',
        caseSensitive: false,
      ).firstMatch(uri.toString());
      if (match != null) {
        try {
          return Image.memory(
            base64Decode(match.group(1)!),
            fit: BoxFit.contain,
          );
        } catch (_) {}
      }
    }
    if (scheme != 'http' && scheme != 'https') {
      return _unsupportedImage(fallbackAlt);
    }
    return Image.network(
      uri.toString(),
      fit: BoxFit.contain,
      errorBuilder: (context, error, stackTrace) =>
          _unsupportedImage(fallbackAlt),
      loadingBuilder: (context, child, progress) => progress == null
          ? child
          : const SizedBox(
              width: 32,
              height: 32,
              child: CupertinoActivityIndicator(),
            ),
    );
  }

  Future<void> _showPreview(BuildContext context) async {
    await showDialog<void>(
      context: context,
      builder: (_) => Dialog(
        insetPadding: const EdgeInsets.all(12),
        child: InteractiveViewer(
          minScale: 0.5,
          maxScale: 4,
          child: _buildImage(alt),
        ),
      ),
    );
  }
}

Widget _imageFrame(Widget image) {
  return Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520, maxHeight: 420),
        child: image,
      ),
    ),
  );
}

Widget _unsupportedImage(String? alt) {
  return Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Text(
      alt?.trim().isNotEmpty == true ? '[图片：$alt]' : '[图片不可用]',
      style: const TextStyle(color: iosSecondaryLabel, fontSize: 13),
    ),
  );
}

class MermaidDiagramCard extends StatefulWidget {
  const MermaidDiagramCard({
    required this.code,
    required this.isUser,
    super.key,
  });

  final String code;
  final bool isUser;

  @override
  State<MermaidDiagramCard> createState() => _MermaidDiagramCardState();
}

class _MermaidDiagramCardState extends State<MermaidDiagramCard> {
  late final WebViewController _controller;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(
        widget.isUser ? const Color(0xFF1F2937) : const Color(0xFFFFFFFF),
      )
      ..setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) {
            final uri = Uri.tryParse(request.url);
            final allowed =
                uri?.scheme == 'about' ||
                uri?.host == 'cdn.jsdelivr.net' ||
                uri?.host == 'fastly.jsdelivr.net';
            return allowed
                ? NavigationDecision.navigate
                : NavigationDecision.prevent;
          },
          onWebResourceError: (_) {
            if (mounted) setState(() => _failed = true);
          },
        ),
      )
      ..loadHtmlString(_mermaidHtml(widget.code, widget.isUser));
  }

  @override
  Widget build(BuildContext context) {
    final card = Container(
      width: double.infinity,
      height: 240,
      margin: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: widget.isUser ? const Color(0xFF1F2937) : Colors.white,
        border: Border.all(
          color: widget.isUser ? Colors.white24 : iosSeparator,
        ),
        borderRadius: BorderRadius.circular(10),
      ),
      clipBehavior: Clip.antiAlias,
      child: _failed
          ? _codeFallback(widget.code, 'mermaid', widget.isUser)
          : WebViewWidget(controller: _controller),
    );
    return GestureDetector(
      onTap: () => showDialog<void>(
        context: context,
        builder: (_) =>
            MermaidPreviewDialog(code: widget.code, isUser: widget.isUser),
      ),
      child: card,
    );
  }
}

class MermaidPreviewDialog extends StatefulWidget {
  const MermaidPreviewDialog({
    required this.code,
    required this.isUser,
    super.key,
  });

  final String code;
  final bool isUser;

  @override
  State<MermaidPreviewDialog> createState() => _MermaidPreviewDialogState();
}

class _MermaidPreviewDialogState extends State<MermaidPreviewDialog> {
  late final WebViewController _controller;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(
        widget.isUser ? const Color(0xFF1F2937) : Colors.white,
      )
      ..setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) {
            final uri = Uri.tryParse(request.url);
            final allowed =
                uri?.scheme == 'about' ||
                uri?.host == 'cdn.jsdelivr.net' ||
                uri?.host == 'fastly.jsdelivr.net';
            return allowed
                ? NavigationDecision.navigate
                : NavigationDecision.prevent;
          },
        ),
      )
      ..loadHtmlString(_mermaidHtml(widget.code, widget.isUser));
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      insetPadding: const EdgeInsets.all(12),
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.78,
        child: WebViewWidget(controller: _controller),
      ),
    );
  }
}

String _mermaidHtml(String code, bool dark) {
  final encoded = base64Encode(utf8.encode(code));
  final theme = dark ? 'base' : 'default';
  return '''<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<style>html,body{margin:0;padding:0;background:${dark ? '#1f2937' : '#ffffff'};overflow:auto;}#diagram{padding:12px;display:flex;justify-content:center;min-width:max-content;}svg{max-width:none;height:auto;}</style>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script></head>
<body><div id="diagram"></div><script>
(() => { const code = decodeURIComponent(escape(atob('$encoded'))); const target = document.getElementById('diagram'); target.textContent = code; if (typeof mermaid === 'undefined') return; mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'$theme'}); mermaid.render('worldbase-mermaid', code).then(({svg}) => target.innerHTML = svg).catch(() => target.textContent = code); })();
</script></body></html>''';
}
