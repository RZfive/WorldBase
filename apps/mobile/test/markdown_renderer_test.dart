import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:markdown/markdown.dart' as md;

import 'package:worldbase_mobile/core/markdown_renderer.dart';

void main() {
  md.Document document() => md.Document(
    extensionSet: md.ExtensionSet.gitHubFlavored,
    blockSyntaxes: const [DisplayMathBlockSyntax()],
    inlineSyntaxes: [InlineMathSyntax(), HighlightInlineSyntax()],
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

  testWidgets('renders fenced code and Mermaid fallback without exceptions', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MarkdownMessage(
            data: '```dart\nfinal answer = 42;\n```',
            isUser: false,
          ),
        ),
      ),
    );
    expect(find.text('DART'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('falls back to plaintext for an unknown code language', (
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
    expect(find.text('NOT-A-REAL-LANGUAGE'), findsOneWidget);
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
}
