import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:worldbase_mobile/core/chat_attachments.dart';

void main() {
  test('builds the Electron-compatible uploaded file prompt', () {
    const attachment = ChatAttachment(
      id: 'file-1',
      name: 'report.md',
      fileType: 'md',
      size: 42,
      promptContent: '# Result\nPassed',
    );

    final prompt = buildChatUploadedFilesPrompt(const [attachment]);

    expect(prompt, contains('【用户附件：report.md】'));
    expect(prompt, contains('文件类型：MD'));
    expect(prompt, contains('# Result\nPassed'));
    expect(prompt, endsWith('【附件结束】'));
  });

  test('restores compact files and images from persisted chat content', () {
    const file = ChatAttachment(
      id: 'file-1',
      name: 'notes.txt',
      fileType: 'txt',
      size: 12,
      promptContent: 'private attachment body',
    );
    final imageUrl =
        'data:image/png;base64,${base64Encode(Uint8List.fromList([1, 2, 3]))}';
    final projection = projectChatAttachments(
      '请总结\n\n${buildChatUploadedFilesPrompt(const [file])}',
      [
        {
          'type': 'image_url',
          'image_url': {'url': imageUrl},
        },
      ],
    );

    expect(projection.text, '请总结');
    expect(projection.text, isNot(contains('private attachment body')));
    expect(projection.attachments, hasLength(2));
    expect(projection.attachments.first.name, 'notes.txt');
    expect(projection.attachments.last.isImage, isTrue);
  });

  test('matches Electron attachment detection and content limits', () {
    expect(isSupportedChatTextAttachment('Dockerfile'), isTrue);
    expect(isSupportedChatTextAttachment('code.tsx'), isTrue);
    expect(isChatDocumentAttachment('slides.pptx'), isTrue);
    expect(isChatImageAttachment('photo.WEBP'), isTrue);
    expect(looksLikeChatText(Uint8List.fromList(utf8.encode('hello'))), isTrue);
    expect(looksLikeChatText(Uint8List.fromList([0, 1, 2])), isFalse);
    expect(
      trimChatAttachmentContent(
        'x' * (maxChatAttachmentContentLength + 1),
      ).length,
      maxChatAttachmentContentLength,
    );
  });

  test('keeps signed remote assistant image URLs renderable', () {
    final projection = projectChatAttachments('', [
      {
        'type': 'image_url',
        'image_url': {'url': 'https://images.example.test/output.png?sig=1'},
      },
    ]);

    expect(projection.attachments, hasLength(1));
    expect(projection.attachments.single.isImage, isTrue);
    expect(
      projection.attachments.single.dataUrl,
      'https://images.example.test/output.png?sig=1',
    );
  });
}
