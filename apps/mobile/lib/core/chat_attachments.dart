import 'dart:convert';
import 'dart:typed_data';

const maxChatFileAttachmentBytes = 10 * 1024 * 1024;
const maxChatImageAttachmentBytes = 20 * 1024 * 1024;
const maxChatAttachmentContentLength = 100000;

const chatDocumentExtensions = {
  'pdf',
  'xlsx',
  'xls',
  'docx',
  'doc',
  'pptx',
  'ppt',
};

const chatImageExtensions = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'};

const chatTextAttachmentExtensions = {
  'txt',
  'md',
  'mdx',
  'markdown',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'csv',
  'tsv',
  'log',
  'sql',
  'graphql',
  'gql',
  'xml',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'vue',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'py',
  'rb',
  'php',
  'java',
  'kt',
  'go',
  'rs',
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hpp',
  'cs',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'cmd',
  'env',
  'properties',
  'gitignore',
  'editorconfig',
  'npmrc',
  'pnpmfile',
  'npmignore',
};

const chatTextAttachmentFileNames = {
  '.env',
  '.gitignore',
  '.npmrc',
  '.npmignore',
  '.editorconfig',
  'dockerfile',
  'makefile',
  'readme',
  'license',
  'procfile',
};

String chatAttachmentExtension(String fileName) {
  final name = fileName.toLowerCase();
  final dot = name.lastIndexOf('.');
  return dot >= 0 && dot < name.length - 1 ? name.substring(dot + 1) : '';
}

bool isChatImageAttachment(String fileName) =>
    chatImageExtensions.contains(chatAttachmentExtension(fileName));

bool isChatDocumentAttachment(String fileName) =>
    chatDocumentExtensions.contains(chatAttachmentExtension(fileName));

bool isSupportedChatTextAttachment(String fileName) {
  final normalized = fileName.toLowerCase();
  return chatTextAttachmentFileNames.contains(normalized) ||
      chatTextAttachmentExtensions.contains(chatAttachmentExtension(fileName));
}

bool looksLikeChatText(Uint8List bytes) {
  final length = bytes.length.clamp(0, 4096);
  if (length == 0) return true;
  var suspicious = 0;
  for (var i = 0; i < length; i++) {
    final byte = bytes[i];
    if (byte == 0) return false;
    if (byte < 32 && byte != 9 && byte != 10 && byte != 13) suspicious++;
  }
  return suspicious / length < 0.05;
}

String decodeChatTextAttachment(Uint8List bytes) {
  var content = utf8.decode(bytes, allowMalformed: true);
  if (content.startsWith('\uFEFF')) content = content.substring(1);
  return trimChatAttachmentContent(content);
}

String trimChatAttachmentContent(String content) =>
    content.length <= maxChatAttachmentContentLength
    ? content
    : content.substring(0, maxChatAttachmentContentLength);

String chatAttachmentFileType(String fileName) {
  final normalized = fileName.toLowerCase();
  if (chatTextAttachmentFileNames.contains(normalized)) {
    return normalized.replaceFirst(RegExp(r'^\.'), '').isEmpty
        ? 'text'
        : normalized.replaceFirst(RegExp(r'^\.'), '');
  }
  final extension = chatAttachmentExtension(fileName);
  return extension.isEmpty ? 'text' : extension;
}

String chatImageMimeType(String fileName) {
  return switch (chatAttachmentExtension(fileName)) {
    'jpg' || 'jpeg' => 'image/jpeg',
    'gif' => 'image/gif',
    'webp' => 'image/webp',
    'bmp' => 'image/bmp',
    'svg' => 'image/svg+xml',
    _ => 'image/png',
  };
}

String formatChatAttachmentSize(int size) {
  if (size < 1024) return '$size B';
  if (size < 1024 * 1024) return '${(size / 1024).toStringAsFixed(1)} KB';
  return '${(size / 1024 / 1024).toStringAsFixed(1)} MB';
}

class ChatAttachment {
  const ChatAttachment({
    required this.id,
    required this.name,
    required this.fileType,
    required this.size,
    this.promptContent = '',
    this.imageData,
    String? dataUrl,
  }) : _dataUrl = dataUrl;

  final String id;
  final String name;
  final String fileType;
  final int size;
  final String promptContent;
  final Uint8List? imageData;
  final String? _dataUrl;

  bool get isImage =>
      imageData != null ||
      _dataUrl?.startsWith('data:image/') == true ||
      _dataUrl?.startsWith('https://') == true ||
      _dataUrl?.startsWith('http://') == true;
  String? get dataUrl =>
      _dataUrl ??
      (imageData == null
          ? null
          : 'data:${chatImageMimeType(name)};base64,${base64Encode(imageData!)}');
  String get sizeLabel =>
      size > 0 ? formatChatAttachmentSize(size) : fileType.toUpperCase();

  Uint8List? get imageBytes {
    if (imageData != null) return imageData;
    final value = _dataUrl;
    if (value == null) return null;
    final comma = value.indexOf(',');
    if (comma < 0) return null;
    try {
      return base64Decode(value.substring(comma + 1));
    } catch (_) {
      return null;
    }
  }
}

String buildChatUploadedFilesPrompt(List<ChatAttachment> attachments) {
  return attachments
      .where((attachment) => !attachment.isImage)
      .map(
        (attachment) =>
            '【用户附件：${attachment.name}】\n'
            '文件类型：${attachment.fileType.toUpperCase()}\n'
            '文件内容如下：\n${attachment.promptContent}\n'
            '【附件结束】',
      )
      .join('\n\n');
}

class ChatAttachmentProjection {
  const ChatAttachmentProjection({
    required this.text,
    required this.attachments,
  });

  final String text;
  final List<ChatAttachment> attachments;
}

final _uploadedFileBlockPattern = RegExp(
  r'【用户附件：([^\n】]+)】\r?\n文件类型：([^\r\n]+)\r?\n文件内容如下：\r?\n[\s\S]*?\r?\n【附件结束】',
);

ChatAttachmentProjection projectChatAttachments(
  String content,
  List<Map<String, dynamic>> contentParts,
) {
  final attachments = <ChatAttachment>[];
  var index = 0;
  for (final match in _uploadedFileBlockPattern.allMatches(content)) {
    attachments.add(
      ChatAttachment(
        id: 'history-file-${index++}',
        name: match.group(1)?.trim() ?? '附件',
        fileType: match.group(2)?.trim().toLowerCase() ?? 'file',
        size: 0,
      ),
    );
  }
  for (final part in contentParts) {
    if (part['type'] != 'image_url') continue;
    final image = part['image_url'] ?? part['imageUrl'];
    final url = image is Map ? image['url'] as String? : null;
    if (url == null ||
        !(url.startsWith('data:image/') ||
            url.startsWith('https://') ||
            url.startsWith('http://'))) {
      continue;
    }
    final mimeEnd = url.indexOf(';');
    final type = url.startsWith('data:image/') && mimeEnd > 11
        ? url.substring(11, mimeEnd)
        : 'image';
    attachments.add(
      ChatAttachment(
        id: 'history-image-${index++}',
        name: '图片附件',
        fileType: type,
        size: 0,
        dataUrl: url,
      ),
    );
  }
  final displayText = content
      .replaceAll(_uploadedFileBlockPattern, '')
      .replaceAll(RegExp(r'\n{3,}'), '\n\n')
      .trim();
  return ChatAttachmentProjection(text: displayText, attachments: attachments);
}
