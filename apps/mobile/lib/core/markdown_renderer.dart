import 'dart:async';
import 'dart:convert';

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_highlight/flutter_highlight.dart';
import 'package:flutter_highlight/themes/atom-one-dark.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:highlight/languages/all.dart' as highlight_languages;
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'glass.dart';

/// Markdown renderer shared by one-to-one and group conversations.
///
/// The desktop renderer is based on marked and adds GFM, syntax highlighting,
/// KaTeX, footnotes, safe HTML, and Mermaid blocks. This widget keeps the same
/// document-level behavior on Flutter while using native Flutter widgets for
/// the parts that need interaction or accessibility.
class MarkdownMessage extends StatefulWidget {
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
  State<MarkdownMessage> createState() => _MarkdownMessageState();
}

class _MarkdownMessageState extends State<MarkdownMessage> {
  final GlobalKey _contentStartKey = GlobalKey();
  final GlobalKey _footnotesEndKey = GlobalKey();
  final Map<String, GlobalKey> _anchorKeys = <String, GlobalKey>{};
  final List<GestureRecognizer> _nestedLinkRecognizers = <GestureRecognizer>[];

  @override
  void dispose() {
    _disposeNestedLinkRecognizers();
    super.dispose();
  }

  void _disposeNestedLinkRecognizers() {
    for (final recognizer in _nestedLinkRecognizers) {
      recognizer.dispose();
    }
    _nestedLinkRecognizers.clear();
  }

  void _registerNestedLinkRecognizer(GestureRecognizer recognizer) {
    _nestedLinkRecognizers.add(recognizer);
  }

  GlobalKey _anchorKey(String id) {
    return _anchorKeys.putIfAbsent(id, GlobalKey.new);
  }

  @override
  Widget build(BuildContext context) {
    _disposeNestedLinkRecognizers();

    if (widget.data.isEmpty && widget.isStreaming) {
      return const Text('…');
    }
    if (widget.data.isEmpty) return const SizedBox.shrink();

    final p = DawnPalette.of(context);
    final foreground = widget.isUser ? Colors.white : p.ink;
    final muted = widget.isUser ? Colors.white70 : p.ink2;
    final accent = widget.isUser ? Colors.white : p.indigo;

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
          left: BorderSide(
            color: widget.isUser ? Colors.white70 : p.indigo,
            width: 3,
          ),
        ),
      ),
      blockquotePadding: const EdgeInsets.only(left: 12),
      code: TextStyle(
        fontFamily: 'monospace',
        fontSize: 13.5,
        height: 1.45,
        color: widget.isUser ? Colors.white : p.ink,
        backgroundColor: widget.isUser
            ? Colors.white24
            : p.codeInlineBg,
      ),
      codeblockDecoration: BoxDecoration(
        color: widget.isUser
            ? const Color(0xFF1F2937)
            : const Color(0xFF282C34),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: widget.isUser ? Colors.white24 : const Color(0xFF3F4652),
        ),
      ),
      codeblockPadding: const EdgeInsets.all(12),
      tableHead: TextStyle(fontWeight: FontWeight.w700, color: foreground),
      tableBody: TextStyle(fontSize: 14, height: 1.35, color: foreground),
      tableBorder: TableBorder.all(
        color: widget.isUser ? Colors.white38 : p.separator,
        width: 0.8,
      ),
      tableHeadCellsDecoration: BoxDecoration(
        color: widget.isUser ? Colors.white12 : p.tableHeadBg,
      ),
      tableCellsPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      tableHeadCellsPadding: const EdgeInsets.symmetric(
        horizontal: 8,
        vertical: 6,
      ),
      tablePadding: const EdgeInsets.symmetric(vertical: 6),
      horizontalRuleDecoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: widget.isUser ? Colors.white38 : p.separator),
        ),
      ),
      listIndent: 22,
      listBullet: TextStyle(fontSize: 16, color: foreground),
      checkbox: TextStyle(
        fontSize: 17,
        color: widget.isUser ? Colors.white : p.indigo,
      ),
      blockSpacing: 8,
      textScaler: MediaQuery.textScalerOf(context),
    );

    final builders = <String, MarkdownElementBuilder>{
      'pre': CodeBlockBuilder(
        isUser: widget.isUser,
        isStreaming: widget.isStreaming,
      ),
      'math': MathElementBuilder(foreground: foreground),
      'math-block': MathElementBuilder(foreground: foreground, block: true),
      'mark': InlineRichElementBuilder(
        tag: 'mark',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'u': InlineRichElementBuilder(
        tag: 'u',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'ins': InlineRichElementBuilder(
        tag: 'ins',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      's': InlineRichElementBuilder(
        tag: 's',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'kbd': InlineRichElementBuilder(
        tag: 'kbd',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'b': InlineRichElementBuilder(
        tag: 'b',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'i': InlineRichElementBuilder(
        tag: 'i',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'sub': InlineRichElementBuilder(
        tag: 'sub',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'small': InlineRichElementBuilder(
        tag: 'small',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'span': InlineRichElementBuilder(
        tag: 'span',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'a': InlineRichElementBuilder(
        tag: 'a',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'strong': InlineRichElementBuilder(
        tag: 'strong',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'em': InlineRichElementBuilder(
        tag: 'em',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'del': InlineRichElementBuilder(
        tag: 'del',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'code': InlineRichElementBuilder(
        tag: 'code',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'samp': InlineRichElementBuilder(
        tag: 'samp',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'var': InlineRichElementBuilder(
        tag: 'var',
        isUser: widget.isUser,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'footnote-anchor': FootnoteAnchorBuilder(anchorKey: _anchorKey),
      'li': FootnoteDefinitionBuilder(
        anchorKey: _anchorKey,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
      'sup': FootnoteReferenceBuilder(
        fallback: InlineRichElementBuilder(
          tag: 'sup',
          isUser: widget.isUser,
          foreground: foreground,
          accent: accent,
          onTapLink: _openLink,
          registerRecognizer: _registerNestedLinkRecognizer,
        ),
        anchorKey: _anchorKey,
        foreground: foreground,
        accent: accent,
        onTapLink: _openLink,
        registerRecognizer: _registerNestedLinkRecognizer,
      ),
    };
    for (final tag in _safeHtmlBlockTags) {
      if (!_markdownNativeBlockTags.contains(tag) &&
          !_markdownNativeTableInlineTags.contains(tag)) {
        builders.putIfAbsent(tag, () => SafeHtmlBlockBuilder(tag: tag));
      }
    }

    final markdown = MarkdownBody(
      data: widget.data,
      extensionSet: md.ExtensionSet.gitHubFlavored,
      blockSyntaxes: [DisplayMathBlockSyntax(), SafeHtmlBlockSyntax()],
      inlineSyntaxes: [
        InlineMathSyntax(),
        HighlightInlineSyntax(),
        RawHtmlInlineSyntax(),
      ],
      styleSheet: styleSheet,
      softLineBreak: true,
      builders: builders,
      checkboxBuilder: (checked) => Icon(
        checked ? CupertinoIcons.checkmark_square_fill : CupertinoIcons.square,
        size: 17,
        color: widget.isUser ? Colors.white : p.indigo,
      ),
      imageBuilder: (uri, title, alt) =>
          MarkdownImage(uri: uri, title: title, alt: alt),
      onTapLink: (text, href, title) => _openLink(href),
    );

    return Column(
      key: _contentStartKey,
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        markdown,
        SizedBox(key: _footnotesEndKey, height: 1),
      ],
    );
  }

  Future<void> _openLink(String? href) async {
    final uri = Uri.tryParse(href ?? '');
    if (uri == null) return;
    if (uri.scheme.isEmpty && uri.fragment.isNotEmpty) {
      final fragment = uri.fragment;
      String? decodedFragment;
      try {
        decodedFragment = Uri.decodeComponent(fragment);
      } on FormatException {
        decodedFragment = null;
      }
      final target =
          _anchorKeys[fragment] ??
          (decodedFragment == null ? null : _anchorKeys[decodedFragment]) ??
          (fragment.startsWith('fnref-')
              ? _contentStartKey
              : fragment.startsWith('fn-')
              ? _footnotesEndKey
              : null);
      final targetContext = target?.currentContext;
      if (targetContext != null) {
        await Scrollable.ensureVisible(
          targetContext,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
        );
      }
      return;
    }
    if (!const {'http', 'https', 'mailto'}.contains(uri.scheme.toLowerCase())) {
      return;
    }
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      // A missing platform URL handler should not interrupt message rendering.
    }
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

const Set<String> _safeHtmlBlockTags = <String>{
  'article',
  'aside',
  'blockquote',
  'caption',
  'code',
  'col',
  'colgroup',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
};

// These tags already have dedicated handling in flutter_markdown_plus. Adding
// a custom block builder for them would bypass table-cell/list construction.
const Set<String> _markdownNativeBlockTags = <String>{
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'thead',
  'tfoot',
  'tr',
  'ul',
  'hr',
};

const Set<String> _markdownNativeTableInlineTags = <String>{
  'caption',
  'col',
  'colgroup',
  'td',
  'th',
};

/// Parses allowed raw HTML blocks into ordinary Markdown AST nodes.
///
/// The stock HTML block syntax returns a text node, which would expose the
/// source markup in Flutter. This deliberately small parser strips the outer
/// tag and recursively parses its contents as inline Markdown. Unknown tags
/// are left to the package's normal safe text handling.
class SafeHtmlBlockSyntax extends md.BlockSyntax {
  const SafeHtmlBlockSyntax();

  @override
  RegExp get pattern => RegExp(
    '^ {0,3}<(?:(?:${_safeHtmlBlockTags.join('|')}))(?:\\s|>|/>)',
    caseSensitive: false,
  );

  @override
  md.Node? parse(md.BlockParser parser) {
    final first = parser.current.content;
    final opening = RegExp(
      r'^ {0,3}<([A-Za-z][A-Za-z0-9-]*)([^>]*)>',
      caseSensitive: false,
    ).firstMatch(first);
    if (opening == null) return null;
    final tag = opening.group(1)!.toLowerCase();
    if (!_safeHtmlBlockTags.contains(tag)) return null;

    final lines = <String>[];
    final tagPattern = RegExp(
      r'<(/?)' + RegExp.escape(tag) + r'\b[^>]*>',
      caseSensitive: false,
    );
    var depth = 0;
    while (!parser.isDone) {
      final line = parser.current.content;
      lines.add(line);
      for (final match in tagPattern.allMatches(line)) {
        final raw = match.group(0)!;
        if (match.group(1) == '/') {
          depth--;
        } else if (!raw.trimRight().endsWith('/>')) {
          depth++;
        }
      }
      parser.advance();
      if (tag == 'hr' || depth <= 0) break;
    }

    final firstBody = first.substring(opening.end);
    lines[0] = firstBody;
    var body = lines.join('\n').trim();
    body = body.replaceFirst(
      RegExp(r'</' + RegExp.escape(tag) + r'\s*>\s*$', caseSensitive: false),
      '',
    );
    if (tag == 'hr') return md.Element.empty('hr');
    if (opening.group(0)!.trimRight().endsWith('/>')) {
      return md.Element(tag, const <md.Node>[]);
    }
    return md.Element(tag, parser.document.parse(body));
  }
}

/// Inline math syntax for $...$, $$...$$, \\(...\\), and \\[...\\].
class InlineMathSyntax extends md.InlineSyntax {
  InlineMathSyntax() : super(r'\\\$\$|\\\$|\$\$|\\\[|\\\(|\$');

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final source = parser.source;
    final start = parser.pos;
    final candidate = source.substring(start);

    if (source[start] == '\\') {
      if (_isEscapedAt(source, start)) {
        parser.addNode(md.Text(source[start]));
        parser.consume(1);
        return false;
      }
      final escapedDollar = candidate.startsWith(r'\$$')
          ? r'$$'
          : candidate.startsWith(r'\$')
          ? r'$'
          : null;
      if (escapedDollar != null) {
        parser.addNode(md.Text(escapedDollar));
        parser.consume(escapedDollar.length + 1);
        return false;
      }
    }

    String? open;
    String? close;
    var display = false;
    if (candidate.startsWith(r'\[') && !_isEscapedAt(source, start)) {
      open = r'\[';
      close = r'\]';
      display = true;
    } else if (candidate.startsWith(r'\(') && !_isEscapedAt(source, start)) {
      open = r'\(';
      close = r'\)';
    } else if (candidate.startsWith(r'$$') && !_isEscapedAt(source, start)) {
      open = r'$$';
      close = r'$$';
      display = true;
    } else if (source[start] == r'$' &&
        !candidate.startsWith(r'$$') &&
        !_isEscapedAt(source, start)) {
      open = r'$';
      close = r'$';
    }

    if (open == null || close == null) {
      parser.addNode(md.Text(source[start]));
      parser.consume(1);
      return false;
    }
    final closeIndex = _findUnescapedToken(source, close, start + open.length);
    if (closeIndex == -1) {
      parser.addNode(md.Text(source[start]));
      parser.consume(1);
      return false;
    }
    final expression = source.substring(start + open.length, closeIndex);
    if (expression.trim().isEmpty ||
        (!display && open == r'$' && expression.contains('\n'))) {
      parser.addNode(md.Text(source[start]));
      parser.consume(1);
      return false;
    }
    parser.addNode(
      md.Element.empty('math')
        ..attributes['expression'] = expression
        ..attributes['display'] = display ? 'true' : 'false',
    );
    parser.consume(closeIndex + close.length - start);
    return false;
  }
}

/// Allows the desktop renderer's ==highlight== extension in inline text.
class HighlightInlineSyntax extends md.InlineSyntax {
  HighlightInlineSyntax() : super(r'=');

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final source = parser.source;
    final start = parser.pos;
    if (!source.startsWith('==', start) || _isEscapedAt(source, start)) {
      parser.addNode(md.Text(source[start]));
      parser.consume(1);
      return false;
    }
    final closeIndex = _findUnescapedToken(source, '==', start + 2);
    if (closeIndex == -1) {
      parser.addNode(md.Text(source[start]));
      parser.consume(1);
      return false;
    }
    final value = source.substring(start + 2, closeIndex);
    if (value.trim().isEmpty) {
      parser.addNode(md.Text(source[start]));
      parser.consume(1);
      return false;
    }
    parser.addNode(md.Element('mark', parser.document.parseInline(value)));
    parser.consume(closeIndex + 2 - start);
    return false;
  }
}

bool _isEscapedAt(String source, int index) {
  var slashes = 0;
  for (var i = index - 1; i >= 0 && source[i] == '\\'; i--) {
    slashes++;
  }
  return slashes.isOdd;
}

int _findUnescapedToken(String source, String token, int start) {
  var index = start;
  while (index < source.length) {
    final found = source.indexOf(token, index);
    if (found == -1) return -1;
    if (token == r'$' &&
        found + 1 < source.length &&
        source[found + 1] == r'$') {
      index = found + 2;
      continue;
    }
    if (!_isEscapedAt(source, found)) return found;
    index = found + 1;
  }
  return -1;
}

/// Parses the safe inline HTML subset that the desktop renderer keeps.
///
/// The markdown package intentionally leaves raw HTML as text. Matching a
/// complete paired tag here lets the native builder apply styles while still
/// recursively parsing Markdown inside the tag body. Unknown tags remain plain
/// text and are therefore never executed as HTML.
class RawHtmlInlineSyntax extends md.InlineSyntax {
  RawHtmlInlineSyntax()
    : super(
        r'<(a|b|strong|i|em|u|ins|s|del|mark|kbd|sub|sup|small|span|abbr|cite|dfn|q|time|code|samp|var)(\s+[^>]*)?>([\s\S]*?)</\1\s*>|<(img)(\s+[^>]*)?\s*/?>|<(br|wbr)\s*/?>',
        caseSensitive: false,
      );

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    void parseAttributes(md.Element element, String? rawAttributes) {
      if (rawAttributes == null) return;
      for (final attribute in RegExp(
        r'''([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))''',
      ).allMatches(rawAttributes)) {
        element.attributes[attribute.group(1)!.toLowerCase()] =
            attribute.group(2) ??
            attribute.group(3) ??
            attribute.group(4) ??
            '';
      }
    }

    final voidTag = match.group(6)?.toLowerCase();
    if (voidTag == 'br' || voidTag == 'wbr') {
      parser.addNode(md.Element.empty(voidTag!));
      return true;
    }

    if (match.group(4)?.toLowerCase() == 'img') {
      final element = md.Element.empty('img');
      parseAttributes(element, match.group(5));
      parser.addNode(element);
      return true;
    }

    final tag = match.group(1)?.toLowerCase();
    final body = match.group(3);
    if (tag == null || body == null) return false;
    final children = const {'code', 'samp', 'var'}.contains(tag)
        ? <md.Node>[md.Text(_decodeHtmlEntities(body))]
        : parser.document.parseInline(body);
    final element = md.Element(tag, children);
    parseAttributes(element, match.group(2));
    parser.addNode(element);
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
    return _mathWidget(expression, display, style, foreground);
  }
}

String _normalizeMathExpression(String expression) {
  final normalized = _decodeHtmlEntities(
    expression,
  ).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
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

String _decodeHtmlEntities(String value) {
  const named = <String, String>{
    'amp': '&',
    'apos': "'",
    'nbsp': '\u00a0',
    'quot': '"',
    'lt': '<',
    'gt': '>',
    'cent': '\u00a2',
    'pound': '\u00a3',
    'yen': '\u00a5',
    'euro': '\u20ac',
    'sect': '\u00a7',
    'copy': '\u00a9',
    'reg': '\u00ae',
    'plusmn': '\u00b1',
    'times': '\u00d7',
    'divide': '\u00f7',
    'minus': '\u2212',
    'le': '\u2264',
    'ge': '\u2265',
    'ne': '\u2260',
    'forall': '\u2200',
    'exists': '\u2203',
    'sum': '\u2211',
    'prod': '\u220f',
    'int': '\u222b',
    'alpha': '\u03b1',
    'beta': '\u03b2',
    'gamma': '\u03b3',
    'delta': '\u03b4',
    'epsilon': '\u03b5',
    'theta': '\u03b8',
    'lambda': '\u03bb',
    'mu': '\u03bc',
    'pi': '\u03c0',
    'sigma': '\u03c3',
    'phi': '\u03c6',
    'omega': '\u03c9',
  };
  return value.replaceAllMapped(
    RegExp(
      r'&(?:#([0-9]{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]+));',
      caseSensitive: false,
    ),
    (match) {
      final decimal = int.tryParse(match.group(1) ?? '');
      final hexadecimal = int.tryParse(match.group(2) ?? '', radix: 16);
      final codePoint = decimal ?? hexadecimal;
      if (codePoint != null && codePoint > 0 && codePoint <= 0x10ffff) {
        return String.fromCharCode(codePoint);
      }
      return named[match.group(3)?.toLowerCase()] ?? match.group(0)!;
    },
  );
}

/// Renders inline HTML extensions without flattening their child AST.
///
/// Returning a [Text.rich] here keeps nested emphasis, links, images, and
/// math widgets intact. The stock flutter_markdown builder cannot attach a
/// background/border to arbitrary HTML tags, so this small recursive span
/// builder provides the desktop renderer's most visible inline extensions.
class InlineRichElementBuilder extends MarkdownElementBuilder {
  InlineRichElementBuilder({
    required this.tag,
    required this.isUser,
    required this.foreground,
    required this.accent,
    this.onTapLink,
    this.registerRecognizer,
  });

  final String tag;
  final bool isUser;
  final Color foreground;
  final Color accent;
  final Future<void> Function(String? href)? onTapLink;
  final void Function(GestureRecognizer recognizer)? registerRecognizer;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final p = DawnPalette.of(context);
    final baseStyle =
        tag == 'code' && parentStyle != null && preferredStyle != null
        ? parentStyle.merge(preferredStyle)
        : parentStyle ?? preferredStyle ?? DefaultTextStyle.of(context).style;
    final elementStyle = _styleForElement(baseStyle, element, p);
    final spans = _inlineSpans(
      context,
      element.children ?? const <md.Node>[],
      elementStyle,
      p,
    );
    GestureRecognizer? rootRecognizer;
    if (tag == 'a') {
      final href = element.attributes['href'];
      rootRecognizer = TapGestureRecognizer()
        ..onTap = onTapLink == null ? null : () => onTapLink!(href);
      registerRecognizer?.call(rootRecognizer);
    }
    final linkedSpans = rootRecognizer == null
        ? spans
        : spans.map((span) => _withRecognizer(span, rootRecognizer!)).toList();
    final rich = Text.rich(
      TextSpan(style: elementStyle, children: linkedSpans),
      textScaler: MediaQuery.textScalerOf(context),
    );

    if (tag != 'kbd') return rich;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: isUser ? Colors.white24 : p.codeInlineBg,
        border: Border.all(color: isUser ? Colors.white54 : p.separator),
        borderRadius: BorderRadius.circular(5),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
        child: rich,
      ),
    );
  }

  InlineSpan _withRecognizer(InlineSpan span, GestureRecognizer recognizer) {
    if (span is! TextSpan) return span;
    return TextSpan(
      text: span.text,
      style: span.style,
      recognizer: span.recognizer ?? recognizer,
      semanticsLabel: span.semanticsLabel,
      children: span.children
          ?.map((child) => _withRecognizer(child, recognizer))
          .toList(),
    );
  }

  TextStyle _styleForTag(TextStyle style, String elementTag, DawnPalette p) {
    switch (elementTag) {
      case 'mark':
        return style.copyWith(
          color: isUser ? Colors.white : p.ink,
          backgroundColor: isUser
              ? const Color(0xFFFFD54F).withValues(alpha: 0.38)
              : const Color(0xFFFFD54F).withValues(alpha: 0.34),
        );
      case 'u':
      case 'ins':
        return style.copyWith(decoration: TextDecoration.underline);
      case 's':
      case 'del':
        return style.copyWith(decoration: TextDecoration.lineThrough);
      case 'b':
      case 'strong':
        return style.copyWith(fontWeight: FontWeight.w700);
      case 'i':
      case 'em':
        return style.copyWith(fontStyle: FontStyle.italic);
      case 'sub':
        return style.copyWith(
          fontSize: (style.fontSize ?? 16) * 0.8,
          fontFeatures: const [FontFeature.enable('subs')],
        );
      case 'sup':
        return style.copyWith(
          fontSize: (style.fontSize ?? 16) * 0.8,
          fontFeatures: const [FontFeature.enable('sups')],
        );
      case 'small':
        return style.copyWith(fontSize: (style.fontSize ?? 16) * 0.86);
      case 'summary':
        return style.copyWith(fontWeight: FontWeight.w700);
      case 'kbd':
        return style.copyWith(
          fontFamily: 'monospace',
          fontSize: (style.fontSize ?? 16) * 0.86,
        );
      case 'a':
        return style.copyWith(
          color: accent,
          decoration: TextDecoration.underline,
        );
      case 'code':
      case 'samp':
      case 'var':
        return style.copyWith(
          fontFamily: 'monospace',
          backgroundColor: isUser ? Colors.white24 : p.codeInlineBg,
        );
      default:
        return style;
    }
  }

  TextStyle _styleForElement(TextStyle style, md.Element element, DawnPalette p) {
    return _applyInlineStyle(
      _styleForTag(style, tag, p),
      element.attributes['style'],
    );
  }

  List<InlineSpan> _inlineSpans(
    BuildContext context,
    List<md.Node> nodes,
    TextStyle inherited,
    DawnPalette p,
  ) {
    final spans = <InlineSpan>[];
    for (final node in nodes) {
      if (node is md.Text) {
        spans.add(TextSpan(text: node.text, style: inherited));
        continue;
      }
      if (node is! md.Element) continue;

      final childStyle = _applyInlineStyle(
        _styleForNestedTag(inherited, node.tag, p),
        node.attributes['style'],
      );
      if (node.tag == 'br') {
        spans.add(TextSpan(text: '\n', style: inherited));
        continue;
      }
      if (node.tag == 'wbr') {
        continue;
      }
      if (node.tag == 'a') {
        final href = node.attributes['href'];
        final recognizer = TapGestureRecognizer()
          ..onTap = onTapLink == null ? null : () => onTapLink!(href);
        registerRecognizer?.call(recognizer);
        spans.add(
          TextSpan(
            style: childStyle,
            recognizer: recognizer,
            children: _inlineSpans(
              context,
              node.children ?? const <md.Node>[],
              childStyle,
              p,
            ),
          ),
        );
        continue;
      }
      if (node.tag == 'math' || node.tag == 'math-block') {
        final expression = node.attributes['expression'] ?? '';
        if (expression.trim().isNotEmpty) {
          spans.add(
            WidgetSpan(
              alignment: PlaceholderAlignment.baseline,
              baseline: TextBaseline.alphabetic,
              child: _mathWidget(
                expression,
                node.attributes['display'] == 'true',
                childStyle,
                foreground,
              ),
            ),
          );
        }
        continue;
      }
      if (node.tag == 'img') {
        final src = node.attributes['src'];
        final uri = src == null ? null : Uri.tryParse(src);
        if (uri != null) {
          spans.add(
            WidgetSpan(
              alignment: PlaceholderAlignment.middle,
              child: MarkdownImage(
                uri: uri,
                title: node.attributes['title'],
                alt: node.attributes['alt'],
              ),
            ),
          );
        }
        continue;
      }

      spans.addAll(
        _inlineSpans(context, node.children ?? const <md.Node>[], childStyle, p),
      );
    }
    return spans;
  }

  TextStyle _styleForNestedTag(TextStyle style, String elementTag, DawnPalette p) {
    switch (elementTag) {
      case 'b':
      case 'strong':
        return style.copyWith(fontWeight: FontWeight.w700);
      case 'i':
      case 'em':
        return style.copyWith(fontStyle: FontStyle.italic);
      case 'del':
      case 's':
        return style.copyWith(decoration: TextDecoration.lineThrough);
      case 'u':
      case 'ins':
        return style.copyWith(decoration: TextDecoration.underline);
      case 'sub':
        return style.copyWith(
          fontSize: (style.fontSize ?? 16) * 0.8,
          fontFeatures: const [FontFeature.enable('subs')],
        );
      case 'sup':
        return style.copyWith(
          fontSize: (style.fontSize ?? 16) * 0.8,
          fontFeatures: const [FontFeature.enable('sups')],
        );
      case 'small':
        return style.copyWith(fontSize: (style.fontSize ?? 16) * 0.86);
      case 'a':
        return style.copyWith(
          color: accent,
          decoration: TextDecoration.underline,
        );
      case 'mark':
        return _styleForTag(style, 'mark', p);
      case 'kbd':
        return _styleForTag(style, 'kbd', p);
      case 'code':
      case 'samp':
      case 'var':
        return style.copyWith(
          fontFamily: 'monospace',
          fontSize: (style.fontSize ?? 16) * 0.86,
          backgroundColor: isUser ? Colors.white24 : p.codeInlineBg,
        );
      default:
        return style;
    }
  }
}

class FootnoteAnchorBuilder extends MarkdownElementBuilder {
  FootnoteAnchorBuilder({required this.anchorKey});

  final GlobalKey Function(String id) anchorKey;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final id = element.attributes['id'];
    if (id == null || id.isEmpty) return const SizedBox.shrink();
    return SizedBox(key: anchorKey(id), width: 0, height: 0);
  }
}

class FootnoteDefinitionBuilder extends MarkdownElementBuilder {
  FootnoteDefinitionBuilder({
    required this.anchorKey,
    required this.foreground,
    required this.accent,
    this.onTapLink,
    this.registerRecognizer,
  });

  final GlobalKey Function(String id) anchorKey;
  final Color foreground;
  final Color accent;
  final Future<void> Function(String? href)? onTapLink;
  final void Function(GestureRecognizer recognizer)? registerRecognizer;

  // The markdown builder calls the active block builder for every text node.
  // Keep ordinary list-item text visible; links and nested formatting are
  // handled by their own recursive builders below.
  @override
  Widget? visitText(md.Text text, TextStyle? preferredStyle) {
    return Text(text.text, style: preferredStyle);
  }

  @override
  void visitElementBefore(md.Element element) {
    final id = element.attributes['id'];
    if (element.footnoteLabel == null || id == null || id.isEmpty) return;
    final children = element.children;
    if (children == null) return;
    final marker = md.Element.empty('footnote-anchor')..attributes['id'] = id;
    if (children.isEmpty) {
      children.add(marker);
      return;
    }
    final last = children.last;
    if (last is md.Element && last.children != null) {
      last.children!.add(marker);
    } else {
      children.add(marker);
    }
  }
}

class FootnoteReferenceBuilder extends MarkdownElementBuilder {
  FootnoteReferenceBuilder({
    required this.fallback,
    required this.anchorKey,
    required this.foreground,
    required this.accent,
    this.onTapLink,
    this.registerRecognizer,
  });

  final MarkdownElementBuilder fallback;
  final GlobalKey Function(String id) anchorKey;
  final Color foreground;
  final Color accent;
  final Future<void> Function(String? href)? onTapLink;
  final void Function(GestureRecognizer recognizer)? registerRecognizer;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final link = element.children?.whereType<md.Element>().firstWhere(
      (child) => child.tag == 'a',
      orElse: () => md.Element.empty('a'),
    );
    final href = link?.attributes['href'];
    final id = link?.attributes['id'];
    if (href == null || !href.startsWith('#fn-') || id == null || id.isEmpty) {
      return fallback.visitElementAfterWithContext(
        context,
        element,
        preferredStyle,
        parentStyle,
      );
    }

    final baseStyle =
        parentStyle ?? preferredStyle ?? DefaultTextStyle.of(context).style;
    final style = baseStyle.copyWith(
      color: accent,
      decoration: TextDecoration.underline,
      fontSize: (baseStyle.fontSize ?? 16) * 0.8,
      fontFeatures: const [FontFeature.enable('sups')],
    );
    final recognizer = TapGestureRecognizer()
      ..onTap = onTapLink == null ? null : () => onTapLink!(href);
    registerRecognizer?.call(recognizer);
    return KeyedSubtree(
      key: anchorKey(id),
      child: RichText(
        text: TextSpan(
          style: style,
          text: link!.textContent,
          recognizer: recognizer,
        ),
        textScaler: MediaQuery.textScalerOf(context),
      ),
    );
  }
}

class SafeHtmlBlockBuilder extends MarkdownElementBuilder {
  SafeHtmlBlockBuilder({required this.tag});

  final String tag;

  @override
  bool isBlockElement() =>
      !_markdownNativeBlockTags.contains(tag) &&
      !_markdownNativeTableInlineTags.contains(tag);

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    if (tag == 'hr') {
      return const Divider(height: 1);
    }
    // Returning null keeps the already-built child widgets, including nested
    // links, images, formatting, tables, and math expressions.
    return null;
  }
}

TextStyle _applyInlineStyle(TextStyle style, String? rawStyle) {
  if (rawStyle == null || rawStyle.trim().isEmpty) return style;
  var result = style;
  for (final declaration in rawStyle.split(';')) {
    final separator = declaration.indexOf(':');
    if (separator <= 0) continue;
    final property = declaration.substring(0, separator).trim().toLowerCase();
    final value = declaration.substring(separator + 1).trim();
    if (value.isEmpty ||
        RegExp(
          r'(?:expression|javascript:|vbscript:|@import|url\s*\()',
          caseSensitive: false,
        ).hasMatch(value)) {
      continue;
    }
    switch (property) {
      case 'color':
        final color = _parseCssColor(value);
        if (color != null) result = result.copyWith(color: color);
      case 'background':
      case 'background-color':
        final color = _parseCssColor(value);
        if (color != null) result = result.copyWith(backgroundColor: color);
      case 'font-weight':
        final normalized = value.toLowerCase();
        final weight = normalized == 'bold' || normalized == 'bolder'
            ? FontWeight.w700
            : normalized == 'normal' || normalized == 'lighter'
            ? FontWeight.w400
            : switch (int.tryParse(normalized)) {
                100 || 200 => FontWeight.w200,
                300 || 400 => FontWeight.w400,
                500 || 600 => FontWeight.w600,
                700 || 800 || 900 => FontWeight.w700,
                _ => null,
              };
        if (weight != null) result = result.copyWith(fontWeight: weight);
      case 'font-style':
        if (value.toLowerCase().contains('italic') ||
            value.toLowerCase().contains('oblique')) {
          result = result.copyWith(fontStyle: FontStyle.italic);
        }
      case 'text-decoration':
        final normalized = value.toLowerCase();
        final decorations = <TextDecoration>[
          if (normalized.contains('underline')) TextDecoration.underline,
          if (normalized.contains('line-through')) TextDecoration.lineThrough,
        ];
        if (decorations.isNotEmpty) {
          result = result.copyWith(
            decoration: TextDecoration.combine(decorations),
          );
        }
      case 'font-size':
        final match = RegExp(
          r'^([0-9]+(?:\.[0-9]+)?)\s*(px|pt|em|rem|%)?$',
          caseSensitive: false,
        ).firstMatch(value);
        if (match != null) {
          final amount = double.tryParse(match.group(1)!);
          if (amount != null) {
            final unit = match.group(2)?.toLowerCase();
            final base = style.fontSize ?? 16;
            final size = switch (unit) {
              'em' || 'rem' => base * amount,
              '%' => base * amount / 100,
              'pt' => amount * 96 / 72,
              _ => amount,
            };
            result = result.copyWith(fontSize: size);
          }
        }
    }
  }
  return result;
}

Color? _parseCssColor(String raw) {
  final value = raw.trim().toLowerCase();
  const named = <String, Color>{
    'black': Color(0xff000000),
    'white': Color(0xffffffff),
    'red': Color(0xffff0000),
    'green': Color(0xff008000),
    'blue': Color(0xff0000ff),
    'yellow': Color(0xffffff00),
    'gray': Color(0xff808080),
    'grey': Color(0xff808080),
    'orange': Color(0xffffa500),
    'purple': Color(0xff800080),
    'pink': Color(0xffffc0cb),
    'brown': Color(0xffa52a2a),
    'cyan': Color(0xff00ffff),
    'aqua': Color(0xff00ffff),
    'magenta': Color(0xffff00ff),
    'fuchsia': Color(0xffff00ff),
    'lime': Color(0xff00ff00),
    'navy': Color(0xff000080),
    'teal': Color(0xff008080),
    'olive': Color(0xff808000),
    'maroon': Color(0xff800000),
    'silver': Color(0xffc0c0c0),
    'transparent': Color(0x00000000),
  };
  final namedColor = named[value];
  if (namedColor != null) return namedColor;
  if (value.startsWith('#')) {
    final hex = value.substring(1);
    final normalized = switch (hex.length) {
      3 =>
        'ff${hex.split('').map((character) => '$character$character').join()}',
      4 =>
        '${hex[3]}${hex[3]}${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}',
      6 => 'ff$hex',
      // CSS writes eight-digit colors as #RRGGBBAA, while Flutter's integer
      // representation is 0xAARRGGBB.
      8 => '${hex.substring(6)}${hex.substring(0, 6)}',
      _ => '',
    };
    if (normalized.length == 8 &&
        RegExp(r'^[0-9a-f]{8}$').hasMatch(normalized)) {
      final parsed = int.tryParse(normalized, radix: 16);
      if (parsed != null) return Color(parsed);
    }
  }
  final function = RegExp(r'^(rgba?|hsla?)\((.*)\)$').firstMatch(value);
  if (function == null) return null;

  final name = function.group(1)!;
  final components = _splitCssFunctionArguments(function.group(2)!);
  if ((name == 'rgb' || name == 'rgba') &&
      (components.length == 3 || components.length == 4)) {
    final red = _parseCssRgbChannel(components[0]);
    final green = _parseCssRgbChannel(components[1]);
    final blue = _parseCssRgbChannel(components[2]);
    final alpha = components.length == 4 ? _parseCssAlpha(components[3]) : 1.0;
    if (red != null && green != null && blue != null && alpha != null) {
      return Color.fromARGB((alpha * 255).round(), red, green, blue);
    }
  }
  if ((name == 'hsl' || name == 'hsla') &&
      (components.length == 3 || components.length == 4)) {
    final hue = _parseCssHue(components[0]);
    final saturation = _parseCssPercentage(components[1]);
    final lightness = _parseCssPercentage(components[2]);
    final alpha = components.length == 4 ? _parseCssAlpha(components[3]) : 1.0;
    if (hue != null &&
        saturation != null &&
        lightness != null &&
        alpha != null) {
      return _hslToColor(hue, saturation, lightness, alpha);
    }
  }
  return null;
}

List<String> _splitCssFunctionArguments(String input) {
  final normalized = input.replaceAll('/', ' / ');
  return normalized
      .split(RegExp(r'[,\s]+'))
      .where((part) => part.isNotEmpty && part != '/')
      .toList(growable: false);
}

int? _parseCssRgbChannel(String raw) {
  final value = raw.trim();
  if (value.endsWith('%')) {
    final percentage = double.tryParse(value.substring(0, value.length - 1));
    return percentage == null
        ? null
        : (percentage.clamp(0, 100) * 2.55).round();
  }
  final number = double.tryParse(value);
  return number?.clamp(0, 255).round();
}

double? _parseCssAlpha(String raw) {
  final value = raw.trim();
  if (value.endsWith('%')) {
    final percentage = double.tryParse(value.substring(0, value.length - 1));
    return percentage == null ? null : (percentage / 100).clamp(0, 1);
  }
  final number = double.tryParse(value);
  return number?.clamp(0, 1);
}

double? _parseCssPercentage(String raw) {
  final value = raw.trim();
  if (!value.endsWith('%')) return null;
  final percentage = double.tryParse(value.substring(0, value.length - 1));
  return percentage == null ? null : (percentage / 100).clamp(0, 1);
}

double? _parseCssHue(String raw) {
  final value = raw.trim();
  final match = RegExp(r'^(-?[0-9.]+)(deg|grad|rad|turn)?$').firstMatch(value);
  if (match == null) return null;
  final amount = double.tryParse(match.group(1)!);
  if (amount == null) return null;
  final unit = match.group(2) ?? 'deg';
  final degrees = switch (unit) {
    'grad' => amount * 0.9,
    'rad' => amount * 180 / 3.141592653589793,
    'turn' => amount * 360,
    _ => amount,
  };
  return ((degrees % 360) + 360) % 360;
}

Color _hslToColor(
  double hue,
  double saturation,
  double lightness,
  double alpha,
) {
  final chroma = (1 - (2 * lightness - 1).abs()) * saturation;
  final x = chroma * (1 - ((hue / 60) % 2 - 1).abs());
  final match = switch (hue) {
    < 60 => (chroma, x, 0.0),
    < 120 => (x, chroma, 0.0),
    < 180 => (0.0, chroma, x),
    < 240 => (0.0, x, chroma),
    < 300 => (x, 0.0, chroma),
    _ => (chroma, 0.0, x),
  };
  final offset = lightness - chroma / 2;
  return Color.fromARGB(
    (alpha * 255).round(),
    ((match.$1 + offset) * 255).round(),
    ((match.$2 + offset) * 255).round(),
    ((match.$3 + offset) * 255).round(),
  );
}

Widget _mathWidget(
  String expression,
  bool display,
  TextStyle style,
  Color foreground,
) {
  final math = Math.tex(
    _normalizeMathExpression(expression),
    mathStyle: display ? MathStyle.display : MathStyle.text,
    textStyle: style.copyWith(color: foreground),
  );
  if (!display) return math;
  return SingleChildScrollView(
    scrollDirection: Axis.horizontal,
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: math,
  );
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
  final label = _isKnownHighlightLanguage(language) ? language : null;
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

bool _isKnownHighlightLanguage(String language) {
  if (language.isEmpty) return false;
  final normalized = language.toLowerCase();
  if (highlight_languages.allLanguages.containsKey(normalized)) return true;
  return highlight_languages.allLanguages.values.any(
    (mode) =>
        mode.aliases?.any((alias) => alias.toLowerCase() == normalized) ??
        false,
  );
}

class MarkdownImage extends StatelessWidget {
  const MarkdownImage({required this.uri, this.title, this.alt, super.key});

  final Uri uri;
  final String? title;
  final String? alt;

  @override
  Widget build(BuildContext context) {
    final fallbackColor = DawnPalette.of(context).ink2;
    final image = _buildImage(alt, fallbackColor);
    return GestureDetector(
      onTap: () => _showPreview(context, fallbackColor),
      child: _imageFrame(image),
    );
  }

  Widget _buildImage(String? fallbackAlt, Color fallbackColor) {
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
      return _unsupportedImage(fallbackAlt, fallbackColor);
    }
    return Image.network(
      uri.toString(),
      fit: BoxFit.contain,
      errorBuilder: (context, error, stackTrace) =>
          _unsupportedImage(fallbackAlt, fallbackColor),
      loadingBuilder: (context, child, progress) => progress == null
          ? child
          : const SizedBox(
              width: 32,
              height: 32,
              child: CupertinoActivityIndicator(),
            ),
    );
  }

  Future<void> _showPreview(BuildContext context, Color fallbackColor) async {
    await showDialog<void>(
      context: context,
      builder: (_) => Dialog(
        insetPadding: const EdgeInsets.all(12),
        child: InteractiveViewer(
          minScale: 0.5,
          maxScale: 4,
          child: _buildImage(alt, fallbackColor),
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

Widget _unsupportedImage(String? alt, Color color) {
  return Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Text(
      alt?.trim().isNotEmpty == true ? '[图片：$alt]' : '[图片不可用]',
      style: TextStyle(color: color, fontSize: 13),
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
  @override
  Widget build(BuildContext context) {
    final p = DawnPalette.of(context);
    // 深色模式下 AI 气泡是暗底:Mermaid 卡片同步入夜,避免一块白卡发光。
    final card = Container(
      width: double.infinity,
      height: 240,
      margin: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: widget.isUser ? const Color(0xFF1F2937) : p.cardBg,
        border: Border.all(
          color: widget.isUser ? Colors.white24 : p.separator,
        ),
        borderRadius: BorderRadius.circular(10),
      ),
      clipBehavior: Clip.antiAlias,
      child: _MermaidWebView(
        code: widget.code,
        isUser: widget.isUser,
        darkMode: p.isDark,
        fallback: _codeFallback(widget.code, 'mermaid', widget.isUser),
      ),
    );
    return GestureDetector(
      onTap: () => showDialog<void>(
        context: context,
        builder: (_) => MermaidPreviewDialog(
            code: widget.code, isUser: widget.isUser, darkMode: p.isDark),
      ),
      child: card,
    );
  }
}

class MermaidPreviewDialog extends StatefulWidget {
  const MermaidPreviewDialog({
    required this.code,
    required this.isUser,
    this.darkMode = false,
    super.key,
  });

  final String code;
  final bool isUser;
  final bool darkMode;

  @override
  State<MermaidPreviewDialog> createState() => _MermaidPreviewDialogState();
}

class _MermaidPreviewDialogState extends State<MermaidPreviewDialog> {
  @override
  Widget build(BuildContext context) {
    return Dialog(
      insetPadding: const EdgeInsets.all(12),
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.78,
        child: _MermaidWebView(
          code: widget.code,
          isUser: widget.isUser,
          darkMode: widget.darkMode,
          fallback: _codeFallback(widget.code, 'mermaid', widget.isUser),
        ),
      ),
    );
  }
}

const _mermaidHostAssetPath = 'assets/mermaid_host.html';
const _mermaidStatusChannel = 'MermaidStatus';

/// Hosts the same local Mermaid runtime for inline cards and the full-screen
/// preview. The host page owns the loading/error view; the JavaScript channel
/// is only used for lifecycle bookkeeping and must never gate the WebView.
class _MermaidWebView extends StatefulWidget {
  const _MermaidWebView({
    required this.code,
    required this.isUser,
    required this.fallback,
    this.darkMode = false,
  });

  final String code;
  final bool isUser;
  final Widget fallback;
  final bool darkMode;

  @override
  State<_MermaidWebView> createState() => _MermaidWebViewState();
}

class _MermaidWebViewState extends State<_MermaidWebView> {
  WebViewController? _controller;
  late final Future<void> _controllerReady;
  Timer? _renderTimeout;
  var _generation = 0;
  var _ready = false;
  var _failed = false;
  var _pageReady = false;
  var _assetLoaded = false;

  @override
  void initState() {
    super.initState();
    try {
      _controller = WebViewController();
      _controllerReady = _configureController();
    } catch (_) {
      // Widget tests and unsupported desktop targets do not register a WebView
      // platform. Keep Mermaid source visible there instead of throwing.
      _failed = true;
      _controllerReady = Future<void>.value();
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_loadDiagram());
    });
  }

  Future<void> _configureController() async {
    final controller = _controller;
    if (controller == null) return;
    await controller.setJavaScriptMode(JavaScriptMode.unrestricted);
    // NSViewWKWebView (macOS) does not implement this API. The host document
    // supplies the CSS background there; Android and iOS still get a native
    // background while the asset is loading.
    if (defaultTargetPlatform != TargetPlatform.macOS) {
      try {
        await controller.setBackgroundColor(
          widget.isUser || widget.darkMode ? const Color(0xFF1F2937) : Colors.white,
        );
      } catch (error) {
        // Keep rendering if a platform implementation omits this optional
        // appearance API.
        debugPrint('Mermaid WebView: background unavailable: $error');
      }
    }
    try {
      await controller.setOnConsoleMessage((message) {
        // Keep platform WebView failures diagnosable without exposing them in
        // the conversation UI. This is particularly useful for local asset
        // and JavaScript errors on WKWebView.
        debugPrint('Mermaid WebView ${message.level.name}: ${message.message}');
      });
    } catch (error) {
      // Older platform implementations may not expose console forwarding.
      debugPrint('Mermaid WebView: console unavailable: $error');
    }
    await controller.addJavaScriptChannel(
      _mermaidStatusChannel,
      onMessageReceived: (message) {
        if (!mounted) return;
        final status = message.message.toLowerCase();
        final separator = status.indexOf(':');
        final event = separator == -1 ? status : status.substring(0, separator);
        final token = separator == -1
            ? null
            : int.tryParse(status.substring(separator + 1));
        if (token != null && token != _generation) return;
        if (event == 'ok') {
          _renderTimeout?.cancel();
          setState(() {
            _ready = true;
            _failed = false;
          });
        } else if (event == 'error') {
          _renderTimeout?.cancel();
          setState(() {
            _ready = false;
            _failed = true;
          });
        }
      },
    );
    await controller.setNavigationDelegate(
      NavigationDelegate(
        onPageFinished: (_) {
          if (!mounted) return;
          _pageReady = true;
          if (_assetLoaded) unawaited(_renderDiagram(_generation));
        },
        onNavigationRequest: (request) {
          final uri = Uri.tryParse(request.url);
          // Mermaid diagrams are rendered entirely from the inline bundle.
          // Prevent links embedded in untrusted diagram text from leaving
          // this document or loading remote resources.
          // The host page and its script are loaded from the app bundle. The
          // exact bundle prefix differs between Android, iOS, and macOS, so
          // allow local file navigation while rejecting every network URL.
          return uri?.scheme == 'about' || uri?.scheme == 'file'
              ? NavigationDecision.navigate
              : NavigationDecision.prevent;
        },
        onWebResourceError: (_) {
          if (!mounted) return;
          _renderTimeout?.cancel();
          setState(() {
            _ready = false;
            _failed = true;
          });
        },
      ),
    );
  }

  @override
  void didUpdateWidget(covariant _MermaidWebView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.code != widget.code ||
        oldWidget.isUser != widget.isUser ||
        oldWidget.darkMode != widget.darkMode) {
      _loadDiagram();
    }
  }

  Future<void> _loadDiagram() async {
    final generation = ++_generation;
    if (_controller == null) return;
    _renderTimeout?.cancel();
    _pageReady = false;
    _assetLoaded = false;
    if (mounted && (_ready || _failed)) {
      setState(() {
        _ready = false;
        _failed = false;
      });
    }

    try {
      await _controllerReady;
      if (!mounted || generation != _generation) return;
      final controller = _controller;
      if (controller == null) return;
      await controller.loadFlutterAsset(_mermaidHostAssetPath);
      if (!mounted || generation != _generation) return;
      _assetLoaded = true;
      _renderTimeout = Timer(const Duration(seconds: 8), () {
        if (!mounted || generation != _generation || _ready) return;
        setState(() {
          _ready = false;
          _failed = true;
        });
      });
      if (_pageReady) unawaited(_renderDiagram(generation));
    } catch (error) {
      if (!mounted || generation != _generation) return;
      debugPrint('Mermaid WebView: asset load failed: $error');
      setState(() {
        _ready = false;
        _failed = true;
      });
    }
  }

  Future<void> _renderDiagram(int generation) async {
    if (!mounted || generation != _generation || !_pageReady || !_assetLoaded) {
      return;
    }
    final encoded = base64Encode(utf8.encode(widget.code));
    final dark = (widget.isUser || widget.darkMode) ? 'true' : 'false';
    try {
      final controller = _controller;
      if (controller == null) return;
      await controller.runJavaScript(
        "window.worldbaseRenderMermaid('$encoded', $dark, $generation);",
      );
    } catch (_) {
      if (!mounted || generation != _generation) return;
      _renderTimeout?.cancel();
      setState(() {
        _ready = false;
        _failed = true;
      });
    }
  }

  @override
  void dispose() {
    _renderTimeout?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (controller == null) return widget.fallback;

    // Keep the native view mounted from the first frame. Waiting for a Dart
    // callback before mounting it can deadlock platform views, and a missing
    // callback must not hide an SVG that was successfully rendered in HTML.
    return WebViewWidget(controller: controller);
  }
}
