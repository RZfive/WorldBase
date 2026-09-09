import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_highlight/flutter_highlight.dart';
import 'package:markdown/markdown.dart' as md;

import 'package:worldbase_mobile/core/markdown_renderer.dart';

void main() {
  md.Document document() => md.Document(
    extensionSet: md.ExtensionSet.gitHubFlavored,
    blockSyntaxes: const [DisplayMathBlockSyntax(), SafeHtmlBlockSyntax()],
    inlineSyntaxes: [
      InlineMathSyntax(),
      HighlightInlineSyntax(),
      RawHtmlInlineSyntax(),
    ],
    encodeHtml: false,
  );

  test('parses desktop-compatible inline math and highlight syntax', () {
    final nodes = document().parse('speed ==fast== and \$x^2\$ and \\(y\\)');
    final tags = <String>[];
    void visit(md.Node node) {
      if (node is md.Element) {
        tags.add(node.tag);
        node.children?.forEach(visit);
      }
    }

    for (final node in nodes) {
      visit(node);
    }
    expect(tags, containsAll(<String>['mark', 'math']));
    expect(tags.where((tag) => tag == 'math').length, 2);
  });

  test('marks inline double-dollar math as display mode', () {
    final nodes = document().parse(r'before $$x^2$$ after');
    final math = nodes
        .expand((node) => node is md.Element ? node.children ?? [node] : [node])
        .whereType<md.Element>()
        .firstWhere((element) => element.tag == 'math');
    expect(math.attributes['display'], 'true');
  });

  test('does not parse escaped dollar math', () {
    final nodes = document().parse(r'keep \$x\$ as text');
    final mathNodes = <md.Element>[];
    void visit(md.Node node) {
      if (node is md.Element) {
        if (node.tag == 'math') mathNodes.add(node);
        node.children?.forEach(visit);
      }
    }

    nodes.forEach(visit);
    expect(mathNodes, isEmpty);
    expect(nodes.map((node) => node.textContent).join(), r'keep $x$ as text');
  });

  test('parses display math without consuming following markdown', () {
    final nodes = document().parse(r'''before

$$
x^2 + y^2
$$

after''');
    final elements = nodes.whereType<md.Element>().toList();
    expect(elements.any((element) => element.tag == 'math-block'), isTrue);
    expect(
      elements.any(
        (element) =>
            element.tag == 'p' && element.textContent.contains('after'),
      ),
      isTrue,
    );
  });

  test('keeps math-looking text inside fenced code as code', () {
    final nodes = document().parse(r'''```dart
	final value = $x$;
```''');
    final pre = nodes.whereType<md.Element>().singleWhere(
      (element) => element.tag == 'pre',
    );
    expect(pre.textContent, contains(r'$x'));
    expect(pre.textContent, isNot(contains('math')));
  });

  test('keeps Mermaid fenced blocks identifiable for the renderer', () {
    final nodes = document().parse(
      '```mermaid\nflowchart TD\n  A[Start] --> B[Done]\n```',
    );
    final pre = nodes.whereType<md.Element>().singleWhere(
      (element) => element.tag == 'pre',
    );
    final code = pre.children!.whereType<md.Element>().single;
    expect(code.attributes['class'], 'language-mermaid');
    expect(code.textContent, contains('flowchart TD'));
  });

  test('bundles the Mermaid runtime as a local asset', () async {
    final script = await rootBundle.loadString('assets/mermaid.min.js');
    expect(script, contains('globalThis["mermaid"]'));
    expect(script.length, greaterThan(1000000));

    final host = await rootBundle.loadString('assets/mermaid_host.html');
    expect(host, contains('src="mermaid.min.js"'));
    expect(host, contains('worldbaseRenderMermaid'));
    expect(host, contains('window.MermaidStatus'));
    expect(host, contains('generation'));
  });

  test('parses safe raw HTML void elements without stalling', () {
    final nodes = document().parse(
      'before<br>after<wbr><img src="https://example.com/a.png" alt="a">',
    );
    final tags = <String>[];
    void visit(md.Node node) {
      if (node is md.Element) {
        tags.add(node.tag);
        node.children?.forEach(visit);
      }
    }

    nodes.forEach(visit);
    expect(tags, containsAll(<String>['br', 'wbr', 'img']));
  });

  test('keeps GFM footnote anchors in the parsed document', () {
    final nodes = document().parse('reference[^note]\n\n[^note]: details');
    final links = <md.Element>[];
    void visit(md.Node node) {
      if (node is md.Element) {
        if (node.tag == 'a') links.add(node);
        node.children?.forEach(visit);
      }
    }

    nodes.forEach(visit);
    expect(
      links.map((link) => link.attributes['href']),
      containsAll(<String>['#fn-note', '#fnref-note']),
    );
  });

  testWidgets('renders common GFM blocks', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MarkdownMessage(
            data:
                '- [x] done\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n[^note]: detail\nref[^note]',
            isUser: false,
          ),
        ),
      ),
    );
    expect(find.text('done'), findsOneWidget);
    expect(find.text('1'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('keeps links and emphasis interactive inside list items', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MarkdownMessage(
            data: '- [link](https://example.com) and **bold**',
            isUser: false,
          ),
        ),
      ),
    );
    var foundRecognizer = false;
    for (final richText in tester.widgetList<RichText>(find.byType(RichText))) {
      bool hasRecognizer(InlineSpan span) {
        if (span is TextSpan && span.recognizer != null) return true;
        return span is TextSpan &&
            (span.children ?? const <InlineSpan>[]).any(hasRecognizer);
      }

      if (hasRecognizer(richText.text)) {
        foundRecognizer = true;
        break;
      }
    }
    expect(foundRecognizer, isTrue);
    expect(find.textContaining('bold'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('renders fenced code and Mermaid fallback without exceptions', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MarkdownMessage(
            data: '```mermaid\nflowchart TD\n  A[Start] --> B[Done]\n```',
            isUser: false,
            isStreaming: true,
          ),
        ),
      ),
    );
    expect(find.byType(HighlightView), findsOneWidget);
    expect(
      tester.widget<HighlightView>(find.byType(HighlightView)).source,
      contains('flowchart TD'),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('shows Mermaid source when WebView is unavailable', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MermaidDiagramCard(
            code: 'flowchart TD\n  A[Start] --> B[Done]',
            isUser: false,
          ),
        ),
      ),
    );
    expect(find.byType(HighlightView), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('falls back to plaintext without an unknown language badge', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MarkdownMessage(
            data: '```not-a-real-language\nraw text\n```',
            isUser: false,
          ),
        ),
      ),
    );
    expect(find.text('NOT-A-REAL-LANGUAGE'), findsNothing);
    expect(find.byType(HighlightView), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('renders inline and display math without exceptions', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MarkdownMessage(
            data: r'''inline $x^2$ and ==highlight==

$$
y = mx + b
$$''',
            isUser: false,
          ),
        ),
      ),
    );
    expect(find.byType(MarkdownMessage), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('renders safe inline HTML styles without exceptions', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MarkdownMessage(
            data: '<u>underlined</u> <kbd>Ctrl</kbd> <s>old</s>',
            isUser: false,
          ),
        ),
      ),
    );
    expect(find.textContaining('underlined'), findsOneWidget);
    expect(find.textContaining('Ctrl'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('keeps nested formatting inside highlight and HTML spans', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MarkdownMessage(
            data:
                '==**bold** and [link](https://example.com)==\n\n<u>**underlined**</u>',
            isUser: false,
          ),
        ),
      ),
    );
    expect(find.textContaining('bold'), findsOneWidget);
    expect(find.textContaining('underlined'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('applies safe inline HTML text styles', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MarkdownMessage(
            data:
                '<b>bold</b> <i>italic</i> <sub>2</sub> <span style="color:#ff0000;font-weight:bold">styled</span>',
            isUser: false,
          ),
        ),
      ),
    );
    expect(find.textContaining('styled'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('supports display math delimiters inside a paragraph', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MarkdownMessage(data: r'before $$x^2$$ after', isUser: false),
        ),
      ),
    );
    expect(find.byType(MarkdownMessage), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
