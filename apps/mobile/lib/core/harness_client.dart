/// WorldBase 进程内 Harness 客户端（WebSocket JSON-RPC）——完整协议面。
///
/// 对接 mobile FFI 在同一应用进程内开放的 loopback WS/HTTP transport：
/// - initialize 握手 + 移动端 capabilities（排除 subprocess/port_binding/webhook）
/// - 会话/消息/分叉编辑、供应商、Agent、群组（5 模式/黑板/HITL 注入）、
///   Studio 生图、技能、定时任务、记忆、MCP、设置
/// - 流式事件（seq 排序）+ 断线重连 chat.resume 续传
/// - 权限询问（permission_request → chat.respond）
/// - 宿主反向请求（host_request：ask_user / page_automation → host.respond）
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:web_socket_channel/web_socket_channel.dart';

/// Replaces malformed UTF-16 before a Dart string crosses the JSON-RPC wire.
/// Valid surrogate pairs are preserved as their Unicode scalar value.
String sanitizeUtf16ForTransport(String value) {
  final output = StringBuffer();
  final units = value.codeUnits;
  for (var index = 0; index < units.length; index++) {
    final unit = units[index];
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      if (index + 1 < units.length) {
        final low = units[index + 1];
        if (low >= 0xDC00 && low <= 0xDFFF) {
          final scalar = 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00);
          output.writeCharCode(scalar);
          index++;
          continue;
        }
      }
      output.writeCharCode(0xFFFD);
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      output.writeCharCode(0xFFFD);
    } else {
      output.writeCharCode(unit);
    }
  }
  return output.toString();
}

/// Recursively sanitizes every string value and map key in an RPC payload.
Object? sanitizeJsonForTransport(Object? value) {
  if (value is String) return sanitizeUtf16ForTransport(value);
  if (value is List) {
    return value.map<Object?>(sanitizeJsonForTransport).toList();
  }
  if (value is Map) {
    final output = <Object?, Object?>{};
    for (final entry in value.entries) {
      final key = entry.key is String
          ? sanitizeUtf16ForTransport(entry.key as String)
          : entry.key;
      output[key] = sanitizeJsonForTransport(entry.value);
    }
    return output;
  }
  return value;
}

/// Builds the flattened `chat.send` contract shared by the UI and tests.
Map<String, dynamic> buildChatSendParams({
  required String conversationId,
  required String text,
  String? providerId,
  String? model,
  bool enableThinking = false,
  String? reasoningEffort,
  double? temperature,
  bool? webSearch,
  List<Map<String, dynamic>> contentParts = const [],
}) {
  final params = <String, dynamic>{
    'conversationId': conversationId,
    'text': text,
    'providerId': ?providerId,
    if (model != null && model.isNotEmpty) 'model': model,
    'enableThinking': enableThinking,
    if (enableThinking &&
        reasoningEffort != null &&
        reasoningEffort.trim().isNotEmpty)
      'reasoningEffort': reasoningEffort.trim(),
    if (temperature != null) 'temperature': temperature.clamp(0, 2),
    if (contentParts.isNotEmpty) 'contentParts': contentParts,
  };
  if (webSearch == true) {
    params['systemPromptSections'] = <String>[
      '联网搜索已开启：涉及外部信息时优先调用 web_search；必要时再调用 fetch_webpage。',
    ];
  } else if (webSearch == false) {
    params['deniedToolNames'] = <String>[
      'web_search',
      'fetch_webpage',
      'web_fetch',
    ];
  }
  return params;
}

/// 事件帧（对齐 protocol::event::EventFrame，camelCase）。
class EventFrame {
  EventFrame({
    required this.streamId,
    required this.seq,
    required this.ts,
    required this.kind,
    required this.data,
  });

  final String streamId;
  final int seq;
  final String ts;
  final String kind;
  final Map<String, dynamic> data;

  static EventFrame fromJson(Map<String, dynamic> json) => EventFrame(
    // Accept snake_case aliases while talking to an older app-server
    // build; current Rust emits camelCase via serde(rename_all).
    streamId: (json['streamId'] ?? json['stream_id']) as String? ?? '',
    seq: (json['seq'] as num?)?.toInt() ?? 0,
    ts: json['ts'] as String? ?? '',
    kind: (json['kind'] ?? json['type']) as String? ?? 'notice',
    data: json,
  );
}

class ToolDescriptor {
  ToolDescriptor({
    required this.name,
    required this.description,
    required this.domain,
    this.inputSchema = const <String, dynamic>{},
    this.permission = 'allow',
  });
  final String name;
  final String description;
  final String domain;

  /// JSON Schema advertised by Rust for direct tool callers and UI tooling.
  /// Keep this instead of projecting descriptors down to name/description;
  /// otherwise Flutter cannot construct valid `tool.call` arguments from the
  /// same contract Electron presents to the model.
  final Map<String, dynamic> inputSchema;
  final String permission;

  static ToolDescriptor fromJson(Map<String, dynamic> j) => ToolDescriptor(
    name: j['name'] as String,
    description: j['description'] as String? ?? '',
    domain: j['domain'] as String? ?? 'core',
    inputSchema: _readObject(j['inputSchema'] ?? j['input_schema']),
    permission: j['permission'] as String? ?? 'allow',
  );

  static Map<String, dynamic> _readObject(Object? value) {
    if (value is Map) return value.cast<String, dynamic>();
    return const <String, dynamic>{};
  }

  Map<String, dynamic> toJson() => {
    'name': name,
    'description': description,
    'domain': domain,
    'inputSchema': inputSchema,
    'permission': permission,
  };
}

/// A structured preview descriptor shared by Electron's document workbench
/// and the Rust JSON-RPC document APIs.
///
/// These fields intentionally remain strings instead of Dart enums.  The
/// renderer currently advertises `pdf`, `html`, and `structured`, but keeping
/// an unknown future value lossless lets an older Flutter build continue to
/// display the artifact's text fallback.
class DocumentRenderPreview {
  const DocumentRenderPreview({
    required this.kind,
    required this.source,
    required this.status,
    required this.generatedAt,
    this.mimeType,
    this.assetPath,
    this.error,
  });

  final String kind;
  final String source;
  final String status;
  final String? mimeType;
  final String? assetPath;
  final String? error;
  final String generatedAt;

  bool get isReady => status == 'ready';

  static DocumentRenderPreview fromJson(
    Map<String, dynamic> json,
  ) => DocumentRenderPreview(
    kind: json['kind'] as String? ?? 'structured',
    source: json['source'] as String? ?? 'fallback',
    status: json['status'] as String? ?? 'unavailable',
    mimeType: json['mimeType'] as String? ?? json['mime_type'] as String?,
    assetPath: json['assetPath'] as String? ?? json['asset_path'] as String?,
    error: json['error'] as String?,
    generatedAt: (json['generatedAt'] ?? json['generated_at']) as String? ?? '',
  );

  Map<String, dynamic> toJson() => {
    'kind': kind,
    'source': source,
    'status': status,
    'mimeType': ?mimeType,
    'assetPath': ?assetPath,
    'error': ?error,
    'generatedAt': generatedAt,
  };
}

/// One logical unit in a parsed document (paragraph, table row, slide, etc.).
class DocumentNode {
  const DocumentNode({
    required this.id,
    required this.type,
    required this.text,
    required this.level,
    required this.pageIndex,
    this.children = const [],
    this.meta = const <String, dynamic>{},
  });

  final String id;
  final String type;
  final String text;
  final int level;
  final int pageIndex;
  final List<DocumentNode> children;
  final Map<String, dynamic> meta;

  static DocumentNode fromJson(Map<String, dynamic> json) => DocumentNode(
    id: json['id'] as String? ?? '',
    type: json['type'] as String? ?? 'paragraph',
    text: json['text'] as String? ?? '',
    level: ((json['level'] ?? 0) as num?)?.toInt() ?? 0,
    pageIndex:
        ((json['pageIndex'] ?? json['page_index'] ?? 0) as num?)?.toInt() ?? 0,
    children:
        (json['children'] as List?)
            ?.whereType<Map>()
            .map((child) => fromJson(child.cast<String, dynamic>()))
            .toList() ??
        const [],
    meta: (json['meta'] as Map?)?.cast<String, dynamic>() ?? const {},
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'type': type,
    'text': text,
    'level': level,
    'pageIndex': pageIndex,
    if (children.isNotEmpty)
      'children': children.map((child) => child.toJson()).toList(),
    if (meta.isNotEmpty) 'meta': meta,
  };
}

/// A complete imported document artifact.
class DocumentArtifact {
  const DocumentArtifact({
    required this.id,
    required this.filePath,
    required this.fileName,
    required this.fileSize,
    required this.fileType,
    required this.plainText,
    required this.nodes,
    required this.importedAt,
    this.render,
    this.parsed,
  });

  final String id;
  final String filePath;
  final String fileName;
  final int fileSize;
  final String fileType;
  final String plainText;
  final List<DocumentNode> nodes;
  final DocumentRenderPreview? render;
  final String importedAt;

  /// Rust keeps the parser-native payload here.  Electron's DTO does not
  /// expose it, so this remains optional for cross-client compatibility.
  final Object? parsed;

  static DocumentArtifact fromJson(Map<String, dynamic> json) {
    final parsed = json['parsed'];
    final rawNodes =
        json['nodes'] ??
        (parsed is Map ? parsed['nodes'] ?? parsed['items'] : null);
    return DocumentArtifact(
      id:
          (json['id'] ?? json['artifactId'] ?? json['artifact_id'])
              as String? ??
          '',
      filePath:
          (json['filePath'] ?? json['file_path'] ?? json['path']) as String? ??
          '',
      fileName:
          (json['fileName'] ?? json['file_name']) as String? ?? 'document',
      fileSize:
          ((json['fileSize'] ?? json['file_size'] ?? 0) as num?)?.toInt() ?? 0,
      fileType:
          (json['fileType'] ?? json['file_type'] ?? json['kind']) as String? ??
          'unknown',
      plainText:
          (json['plainText'] ?? json['plain_text'] ?? json['text'])
              as String? ??
          '',
      nodes:
          (rawNodes as List?)
              ?.whereType<Map>()
              .map(
                (node) => DocumentNode.fromJson(node.cast<String, dynamic>()),
              )
              .toList() ??
          const [],
      render: json['render'] is Map
          ? DocumentRenderPreview.fromJson(
              (json['render'] as Map).cast<String, dynamic>(),
            )
          : null,
      importedAt: (json['importedAt'] ?? json['imported_at']) as String? ?? '',
      parsed: parsed,
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'filePath': filePath,
    'fileName': fileName,
    'fileSize': fileSize,
    'fileType': fileType,
    'plainText': plainText,
    'nodes': nodes.map((node) => node.toJson()).toList(),
    'render': ?render?.toJson(),
    'importedAt': importedAt,
    'parsed': ?parsed,
  };
}

/// Lightweight document entry returned by `doc.list`.
class DocumentSummary {
  const DocumentSummary({
    required this.id,
    required this.filePath,
    required this.fileName,
    required this.fileType,
    required this.fileSize,
    required this.nodeCount,
    required this.selectionCount,
    required this.importedAt,
  });

  final String id;
  final String filePath;
  final String fileName;
  final String fileType;
  final int fileSize;
  final int nodeCount;
  final int selectionCount;
  final String importedAt;

  static DocumentSummary fromJson(Map<String, dynamic> json) => DocumentSummary(
    id:
        (json['id'] ?? json['artifactId'] ?? json['artifact_id']) as String? ??
        '',
    filePath:
        (json['filePath'] ?? json['file_path'] ?? json['path']) as String? ??
        '',
    fileName: (json['fileName'] ?? json['file_name']) as String? ?? 'document',
    fileType:
        (json['fileType'] ?? json['file_type'] ?? json['kind']) as String? ??
        'unknown',
    fileSize:
        ((json['fileSize'] ?? json['file_size'] ?? 0) as num?)?.toInt() ?? 0,
    nodeCount:
        ((json['nodeCount'] ?? json['node_count'] ?? 0) as num?)?.toInt() ?? 0,
    selectionCount:
        ((json['selectionCount'] ?? json['selection_count'] ?? 0) as num?)
            ?.toInt() ??
        0,
    importedAt: (json['importedAt'] ?? json['imported_at']) as String? ?? '',
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'filePath': filePath,
    'fileName': fileName,
    'fileType': fileType,
    'fileSize': fileSize,
    'nodeCount': nodeCount,
    'selectionCount': selectionCount,
    'importedAt': importedAt,
  };
}

/// Binary render asset returned by `doc.preview.read`.
class DocumentRenderAsset {
  const DocumentRenderAsset({required this.mimeType, required this.bytes});

  final String mimeType;
  final Uint8List bytes;

  static DocumentRenderAsset fromJson(Map<String, dynamic> json) {
    final bytes = _decodeDocumentBytes(json['bytes'] ?? json['data']);
    if (bytes == null) {
      throw const FormatException('doc.preview.read returned invalid bytes');
    }
    return DocumentRenderAsset(
      mimeType:
          (json['mimeType'] ?? json['mime_type']) as String? ??
          'application/octet-stream',
      bytes: bytes,
    );
  }
}

/// Source fingerprint used to prevent edits against a changed source file.
class DocumentEditSourceState {
  const DocumentEditSourceState({
    required this.sha256,
    required this.size,
    required this.mtimeMs,
  });

  final String sha256;
  final int size;
  final double mtimeMs;

  static DocumentEditSourceState fromJson(Map<String, dynamic> json) =>
      DocumentEditSourceState(
        sha256: json['sha256'] as String? ?? '',
        size: ((json['size'] ?? 0) as num?)?.toInt() ?? 0,
        mtimeMs:
            ((json['mtimeMs'] ?? json['mtime_ms'] ?? 0) as num?)?.toDouble() ??
            0,
      );

  Map<String, dynamic> toJson() => {
    'sha256': sha256,
    'size': size,
    'mtimeMs': mtimeMs,
  };
}

/// Structured result for opening an original file.  Mobile hosts do not have
/// Electron's `shell.openPath`, so Rust/Flutter may report `supported: false`
/// while still returning a stable result instead of throwing a platform error.
class DocumentOpenResult {
  const DocumentOpenResult({
    required this.success,
    this.supported = true,
    this.error,
  });

  final bool success;
  final bool supported;
  final String? error;

  static DocumentOpenResult fromJson(Object? value) {
    if (value is bool) return DocumentOpenResult(success: value);
    if (value is! Map) {
      throw const FormatException('doc.openOriginal returned invalid data');
    }
    final json = value.cast<String, dynamic>();
    return DocumentOpenResult(
      success: json['success'] == true || json['ok'] == true,
      supported: json['supported'] as bool? ?? true,
      error: json['error'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
    'success': success,
    'supported': supported,
    'error': ?error,
  };
}

Uint8List? _decodeDocumentBytes(Object? value) {
  if (value is Uint8List) return value;
  if (value is List) {
    final ints = <int>[];
    for (final item in value) {
      if (item is! num || item < 0 || item > 255) return null;
      ints.add(item.toInt());
    }
    return Uint8List.fromList(ints);
  }
  if (value is String) {
    var encoded = value;
    final comma = encoded.indexOf(',');
    if (encoded.startsWith('data:') && comma >= 0) {
      encoded = encoded.substring(comma + 1);
    }
    try {
      return base64Decode(encoded);
    } on FormatException {
      return null;
    }
  }
  return null;
}

/// A document preview selection shared by Electron's document workbench and
/// the Rust-backed Flutter client.
///
/// Rust persists these regions beside the imported artifact so a mobile
/// reconnect does not lose the labels or excerpts that the user attached to a
/// document.  Accept both camelCase (current protocol) and snake_case keys so
/// this model remains usable with an older harness build during an upgrade.
class DocumentSelection {
  const DocumentSelection({
    required this.id,
    required this.artifactId,
    required this.nodeIds,
    required this.label,
    required this.color,
    this.excerpt,
    this.createdAt = '',
  });

  final String id;
  final String artifactId;
  final List<String> nodeIds;
  final String label;
  final String color;
  final String? excerpt;
  final String createdAt;

  static DocumentSelection fromJson(Map<String, dynamic> json) {
    final nodeIds = (json['nodeIds'] ?? json['node_ids']) as List?;
    return DocumentSelection(
      id:
          (json['id'] ?? json['regionId'] ?? json['region_id']) as String? ??
          '',
      artifactId: (json['artifactId'] ?? json['artifact_id']) as String? ?? '',
      nodeIds: nodeIds?.whereType<String>().toList() ?? const [],
      label: json['label'] as String? ?? '',
      color: json['color'] as String? ?? '',
      excerpt: json['excerpt'] as String?,
      createdAt: (json['createdAt'] ?? json['created_at']) as String? ?? '',
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'artifactId': artifactId,
    'nodeIds': nodeIds,
    'label': label,
    'color': color,
    'excerpt': ?excerpt,
    'createdAt': createdAt,
  };
}

class ConversationMeta {
  ConversationMeta({
    required this.id,
    required this.title,
    required this.updatedAt,
    this.messageCount = 0,
    this.agentId,
    this.forkedFrom,
    this.forkDepth = 0,
  });
  final String id;
  final String title;
  final String updatedAt;
  final int messageCount;
  final String? agentId;
  final String? forkedFrom;
  final int forkDepth;

  /// Rust-native group transcripts use one stable parent conversation. Member
  /// execution conversations carry an Agent ID and are filtered server-side.
  String? get groupId =>
      id.startsWith('group-') && agentId == null ? id.substring(6) : null;
  bool get isGroup => groupId != null;

  static ConversationMeta fromJson(Map<String, dynamic> j) => ConversationMeta(
    id: j['id'] as String,
    title: j['title'] as String? ?? '',
    updatedAt: j['updatedAt'] as String? ?? '',
    messageCount: (j['messageCount'] as num?)?.toInt() ?? 0,
    agentId: j['agentId'] as String?,
    forkedFrom: j['forkedFromConversationId'] as String?,
    forkDepth: (j['forkDepth'] as num?)?.toInt() ?? 0,
  );
}

/// 会话消息（harness 落库行，含分叉锚点 id）。
class ChatMessage {
  ChatMessage({
    required this.id,
    required this.role,
    required this.content,
    this.parts = const [],
    this.toolCalls = const [],
    this.toolResults = const [],
  });
  final int id;
  final String role;
  final String content;
  final List<Map<String, dynamic>> parts;
  final List<dynamic> toolCalls;
  final List<dynamic> toolResults;
  bool get isTool => toolCalls.isNotEmpty || toolResults.isNotEmpty;

  static ChatMessage fromJson(Map<String, dynamic> j) => ChatMessage(
    id: (j['id'] as num?)?.toInt() ?? 0,
    role: j['role'] as String? ?? 'user',
    content: j['content'] as String? ?? '',
    parts: (j['parts'] as List? ?? const [])
        .whereType<Map>()
        .map((part) => part.cast<String, dynamic>())
        .toList(),
    toolCalls: j['toolCalls'] as List? ?? const [],
    toolResults: j['toolResults'] as List? ?? const [],
  );
}

/// 模型信息：上下文窗口(K) + 单价（/1M tokens）+ 生图/编辑能力。
class ModelInfo {
  ModelInfo({
    required this.id,
    this.contextWindowK = 0,
    this.inputPrice = 0,
    this.outputPrice = 0,
    this.imageGeneration = false,
    this.imageEditing = false,
  });
  String id;
  int contextWindowK;
  double inputPrice;
  double outputPrice;
  bool imageGeneration;
  bool imageEditing;

  Map<String, dynamic> toJson() => {
    'id': id,
    'contextWindowK': contextWindowK,
    'inputPrice': inputPrice,
    'outputPrice': outputPrice,
    'imageGeneration': imageGeneration,
    'imageEditing': imageEditing,
  };

  static ModelInfo fromJson(Map<String, dynamic> j) => ModelInfo(
    id: j['id'] as String,
    contextWindowK: (j['contextWindowK'] as num?)?.toInt() ?? 0,
    inputPrice: (j['inputPrice'] as num?)?.toDouble() ?? 0,
    outputPrice: (j['outputPrice'] as num?)?.toDouble() ?? 0,
    imageGeneration: j['imageGeneration'] as bool? ?? false,
    imageEditing: j['imageEditing'] as bool? ?? false,
  );
}

class ProviderEntry {
  ProviderEntry({
    required this.id,
    required this.name,
    this.baseUrl = '',
    this.apiKey = '',
    this.apiProtocol = '',
    this.models = const [],
    this.activeModel = '',
    this.temperature,
    this.enableThinking = false,
    this.imageGeneration = false,
  });
  String id;
  String name;
  String baseUrl;
  String apiKey;
  String apiProtocol;
  List<ModelInfo> models;
  String activeModel;
  double? temperature;
  bool enableThinking;
  bool imageGeneration;

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'baseUrl': baseUrl,
    'apiKey': apiKey,
    'apiProtocol': apiProtocol,
    'models': models.map((m) => m.toJson()).toList(),
    'activeModel': activeModel,
    'temperature': temperature,
    'enableThinking': enableThinking,
    'imageGeneration': imageGeneration,
  };

  static ProviderEntry fromJson(Map<String, dynamic> j) => ProviderEntry(
    id: j['id'] as String,
    name: j['name'] as String? ?? '',
    baseUrl: j['baseUrl'] as String? ?? '',
    apiKey: j['apiKey'] as String? ?? '',
    apiProtocol: j['apiProtocol'] as String? ?? '',
    models:
        (j['models'] as List?)
            ?.map((e) => ModelInfo.fromJson((e as Map).cast<String, dynamic>()))
            .toList() ??
        [],
    activeModel: j['activeModel'] as String? ?? '',
    temperature: (j['temperature'] as num?)?.toDouble(),
    enableThinking: j['enableThinking'] as bool? ?? false,
    imageGeneration: j['imageGeneration'] as bool? ?? false,
  );
}

class AgentDefinition {
  AgentDefinition({
    required this.id,
    required this.name,
    this.icon = '',
    this.description = '',
    this.systemPrompt = '',
    this.providerId,
    this.modelId,
    this.reasoningStrength = 'medium',
    this.skillIds = const [],
    this.allowedTools = const [],
    this.deniedTools = const [],
    this.memoryScopes = const ['user', 'agent', 'project'],
    this.memoryWritePolicy = const {
      'allowUserTraits': true,
      'allowAgentSkills': true,
      'allowSteps': true,
      'allowKnowledge': true,
    },
    this.autoReplyPolicy = const {'enabled': false, 'requireMention': true},
    this.createdAt = '',
    this.updatedAt = '',
  });
  String id;
  String name;
  String icon;
  String description;
  String systemPrompt;
  String? providerId;
  String? modelId;
  String reasoningStrength;
  List<String> skillIds;
  List<String> allowedTools;
  List<String> deniedTools;
  List<String> memoryScopes;
  Map<String, dynamic> memoryWritePolicy;
  Map<String, dynamic> autoReplyPolicy;
  String createdAt;
  String updatedAt;

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'icon': icon,
    'description': description,
    'systemPrompt': systemPrompt,
    'providerId': providerId,
    'modelId': modelId,
    'reasoningStrength': reasoningStrength,
    'skillIds': skillIds,
    'allowedTools': allowedTools,
    'deniedTools': deniedTools,
    'memoryScopes': memoryScopes,
    'memoryWritePolicy': memoryWritePolicy,
    'autoReplyPolicy': autoReplyPolicy,
    if (createdAt.isNotEmpty) 'createdAt': createdAt,
    if (updatedAt.isNotEmpty) 'updatedAt': updatedAt,
  };

  static AgentDefinition fromJson(Map<String, dynamic> j) => AgentDefinition(
    id: j['id'] as String,
    name: j['name'] as String? ?? '',
    icon: j['icon'] as String? ?? '',
    description: j['description'] as String? ?? '',
    systemPrompt: j['systemPrompt'] as String? ?? '',
    providerId: j['providerId'] as String?,
    modelId: j['modelId'] as String?,
    reasoningStrength: j['reasoningStrength'] as String? ?? 'medium',
    skillIds: (j['skillIds'] as List?)?.whereType<String>().toList() ?? [],
    allowedTools:
        (j['allowedTools'] as List?)?.whereType<String>().toList() ?? [],
    deniedTools:
        (j['deniedTools'] as List?)?.whereType<String>().toList() ?? [],
    memoryScopes:
        (j['memoryScopes'] as List?)?.whereType<String>().toList() ??
        const ['user', 'agent', 'project'],
    memoryWritePolicy:
        (j['memoryWritePolicy'] as Map?)?.cast<String, dynamic>() ??
        const {
          'allowUserTraits': true,
          'allowAgentSkills': true,
          'allowSteps': true,
          'allowKnowledge': true,
        },
    autoReplyPolicy:
        (j['autoReplyPolicy'] as Map?)?.cast<String, dynamic>() ??
        const {'enabled': false, 'requireMention': true},
    createdAt: j['createdAt'] as String? ?? '',
    updatedAt: j['updatedAt'] as String? ?? '',
  );
}

/// 持久化 Agent 群组定义，对齐 Electron Agent Workspace。
class AgentGroupDefinition {
  AgentGroupDefinition({
    required this.id,
    required this.name,
    required this.coordinatorAgentId,
    required this.memberAgentIds,
    this.icon = '',
    this.description = '',
    this.maxRounds = 2,
    this.maxParallelWorkers = 2,
    this.sharedMemoryScopes = const ['group'],
    this.visibility = 'summary_only',
    this.createdAt = '',
    this.updatedAt = '',
  });

  final String id;
  final String name;
  final String icon;
  final String description;
  final String coordinatorAgentId;
  final List<String> memberAgentIds;
  final int maxRounds;
  final int maxParallelWorkers;
  final List<String> sharedMemoryScopes;
  final String visibility;
  final String createdAt;
  final String updatedAt;

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    if (icon.isNotEmpty) 'icon': icon,
    'description': description,
    'coordinatorAgentId': coordinatorAgentId,
    'memberAgentIds': memberAgentIds,
    'maxRounds': maxRounds,
    'maxParallelWorkers': maxParallelWorkers,
    'sharedMemoryScopes': sharedMemoryScopes,
    'visibility': visibility,
    if (createdAt.isNotEmpty) 'createdAt': createdAt,
    if (updatedAt.isNotEmpty) 'updatedAt': updatedAt,
  };

  static AgentGroupDefinition fromJson(Map<String, dynamic> j) =>
      AgentGroupDefinition(
        id: j['id'] as String? ?? '',
        name: j['name'] as String? ?? '',
        icon: j['icon'] as String? ?? '',
        description: j['description'] as String? ?? '',
        coordinatorAgentId: j['coordinatorAgentId'] as String? ?? '',
        memberAgentIds:
            (j['memberAgentIds'] as List?)?.whereType<String>().toList() ?? [],
        maxRounds: (j['maxRounds'] as num?)?.toInt() ?? 2,
        maxParallelWorkers: (j['maxParallelWorkers'] as num?)?.toInt() ?? 2,
        sharedMemoryScopes:
            (j['sharedMemoryScopes'] as List?)?.whereType<String>().toList() ??
            const ['group'],
        visibility: j['visibility'] as String? ?? 'summary_only',
        createdAt: j['createdAt'] as String? ?? '',
        updatedAt: j['updatedAt'] as String? ?? '',
      );
}

class ImageEntry {
  ImageEntry({
    required this.id,
    required this.prompt,
    required this.file,
    required this.createdAt,
    this.model = '',
    this.folder = '',
    this.tags = const [],
    this.providerId,
    this.negativePrompt = '',
    this.mode = 'generate',
    this.aspect,
    this.resolution,
    this.quality,
    this.format,
    this.width,
    this.height,
  });
  final String id;
  final String prompt;
  final String file;
  final String createdAt;
  final String model;
  final String folder;
  final List<String> tags;
  final String? providerId;
  final String negativePrompt;
  final String mode;
  final String? aspect;
  final String? resolution;
  final String? quality;
  final String? format;
  final int? width;
  final int? height;

  static Map<String, dynamic> _meta(Map<String, dynamic> j) =>
      (j['meta'] as Map?)?.cast<String, dynamic>() ?? const {};

  static String _string(
    Map<String, dynamic> j,
    String key,
    Map<String, dynamic> meta,
    String metaKey,
  ) => (j[key] ?? meta[metaKey]) as String? ?? '';

  static int? _int(Map<String, dynamic> source, String key) =>
      (source[key] as num?)?.toInt();

  static ImageEntry fromJson(Map<String, dynamic> j) => ImageEntry(
    id: j['id'] as String,
    prompt: j['prompt'] as String? ?? '',
    file: j['file'] as String? ?? '',
    createdAt: j['createdAt'] as String? ?? '',
    model: j['model'] as String? ?? '',
    folder: j['folder'] as String? ?? '',
    tags: (j['tags'] as List?)?.map((e) => e as String).toList() ?? [],
    providerId: j['providerId'] as String?,
    negativePrompt: _string(j, 'negativePrompt', _meta(j), 'negativePrompt'),
    mode: _string(j, 'mode', _meta(j), 'mode').toLowerCase(),
    aspect: (j['aspect'] ?? _meta(j)['aspect']) as String?,
    resolution: (j['resolution'] ?? _meta(j)['resolution']) as String?,
    quality: (j['quality'] ?? _meta(j)['quality']) as String?,
    format: (j['format'] ?? _meta(j)['format']) as String?,
    width: _int(j, 'width') ?? _int(_meta(j), 'width'),
    height: _int(j, 'height') ?? _int(_meta(j), 'height'),
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'prompt': prompt,
    'file': file,
    'createdAt': createdAt,
    'model': model,
    'folder': folder,
    'tags': tags,
    'providerId': ?providerId,
    'negativePrompt': negativePrompt,
    'mode': mode,
    'aspect': ?aspect,
    'resolution': ?resolution,
    'quality': ?quality,
    'format': ?format,
    'width': ?width,
    'height': ?height,
  };
}

/// 轻应用（Agent 生成的单页应用）。
class LightApp {
  LightApp({required this.id, required this.name, required this.createdAt});
  final String id;
  final String name;
  final String createdAt;
  static LightApp fromJson(Map<String, dynamic> j) => LightApp(
    id: j['id'] as String,
    name: j['name'] as String? ?? '',
    createdAt: j['createdAt'] as String? ?? '',
  );
}

/// 绘图任务（对齐 Electron 的 ImageStudioTask 队列记录）。
class StudioTask {
  StudioTask({
    required this.id,
    required this.status,
    required this.createdAt,
    required this.request,
    required this.label,
    this.createdByAgent = false,
    this.error,
    this.entries = const [],
  });
  final String id;
  final String status;
  final int createdAt;
  final Map<String, dynamic> request;
  final String label;
  final bool createdByAgent;
  final String? error;
  final List<ImageEntry> entries;

  StudioTask copyWith({
    String? status,
    String? error,
    List<ImageEntry>? entries,
    bool clearError = false,
  }) => StudioTask(
    id: id,
    status: status ?? this.status,
    createdAt: createdAt,
    request: request,
    label: label,
    createdByAgent: createdByAgent,
    error: clearError ? null : (error ?? this.error),
    entries: entries ?? this.entries,
  );

  static StudioTask fromJson(Map<String, dynamic> j) {
    final request = (j['request'] as Map?)?.cast<String, dynamic>() ?? {};
    final createdAt = (j['createdAt'] as num?)?.toInt() ?? 0;
    return StudioTask(
      id: j['id'] as String? ?? '',
      status: j['status'] as String? ?? 'queued',
      createdAt: createdAt,
      request: request,
      label: j['label'] as String? ?? request['prompt'] as String? ?? '',
      createdByAgent: j['createdByAgent'] == true,
      error: j['error'] as String?,
      entries:
          (j['entries'] as List?)
              ?.map(
                (e) => ImageEntry.fromJson((e as Map).cast<String, dynamic>()),
              )
              .toList() ??
          const [],
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'status': status,
    'createdAt': createdAt,
    'request': request,
    'label': label,
    if (createdByAgent) 'createdByAgent': true,
    if (error != null) 'error': error,
    if (entries.isNotEmpty)
      'entries': entries.map((entry) => entry.toJson()).toList(),
  };
}

/// 用量汇总。
class UsageSummary {
  UsageSummary({
    required this.daily,
    required this.byModel,
    required this.totalCost,
    required this.totalInputTokens,
    required this.totalOutputTokens,
  });
  final List<Map<String, dynamic>> daily;
  final List<Map<String, dynamic>> byModel;
  final double totalCost;
  final int totalInputTokens;
  final int totalOutputTokens;

  static UsageSummary fromJson(Map<String, dynamic> j) => UsageSummary(
    daily:
        (j['daily'] as List?)
            ?.map((e) => (e as Map).cast<String, dynamic>())
            .toList() ??
        [],
    byModel:
        (j['byModel'] as List?)
            ?.map((e) => (e as Map).cast<String, dynamic>())
            .toList() ??
        [],
    totalCost: (j['totalCost'] as num?)?.toDouble() ?? 0,
    totalInputTokens: (j['totalInputTokens'] as num?)?.toInt() ?? 0,
    totalOutputTokens: (j['totalOutputTokens'] as num?)?.toInt() ?? 0,
  );
}

class GroupSession {
  GroupSession({
    required this.id,
    required this.topic,
    required this.mode,
    required this.members,
    required this.status,
    this.coordinator,
    this.conversationId = '',
    this.board = const {},
    this.rounds = const [],
    this.createdAt = '',
    this.maxParallelWorkers = 2,
    this.boardUpdates = const [],
    this.pendingInjections = const [],
    this.activeMemberIds = const [],
  });
  final String id;
  final String topic;
  final String mode;
  final List<dynamic> members;
  final String status;
  final String? coordinator;
  final String conversationId;
  final Map<String, dynamic> board;
  final List<dynamic> rounds;
  final String createdAt;
  final int maxParallelWorkers;
  final List<dynamic> boardUpdates;
  final List<dynamic> pendingInjections;
  final List<String> activeMemberIds;

  List<Map<String, dynamic>> get normalizedMembers => members
      .whereType<Map>()
      .map((member) => member.cast<String, dynamic>())
      .toList(growable: false);

  List<String> get memberNames => normalizedMembers
      .map((member) => member['name'] as String? ?? '')
      .where((name) => name.isNotEmpty)
      .toList(growable: false);

  List<String> mentionedMemberIds(String text) {
    final result = <String>[];
    for (final member in normalizedMembers) {
      final name = member['name'] as String? ?? '';
      if (name.isEmpty) continue;
      final mention = RegExp(
        '@${RegExp.escape(name)}(?=\$|[\\s,，。.!！？;；:：])',
        caseSensitive: false,
      );
      if (!mention.hasMatch(text)) continue;
      final agentId = member['agentId'] as String?;
      result.add(agentId == null || agentId.isEmpty ? name : agentId);
    }
    return result;
  }

  static GroupSession fromJson(Map<String, dynamic> j) => GroupSession(
    id: j['id'] as String,
    topic: j['topic'] as String? ?? '',
    mode: j['mode'] as String? ?? 'discussion',
    members: j['members'] as List? ?? [],
    status: j['status'] as String? ?? 'open',
    coordinator: j['coordinator'] as String?,
    conversationId:
        j['conversationId'] as String? ?? 'group-${j['id'] as String}',
    board: (j['board'] as Map?)?.cast<String, dynamic>() ?? {},
    rounds: j['rounds'] as List? ?? [],
    createdAt: (j['createdAt'] ?? j['created_at']) as String? ?? '',
    maxParallelWorkers:
        ((j['maxParallelWorkers'] ?? j['max_parallel_workers']) as num?)
            ?.toInt() ??
        2,
    boardUpdates:
        j['boardUpdates'] as List? ?? j['board_updates'] as List? ?? [],
    pendingInjections:
        j['pendingInjections'] as List? ??
        j['pending_injections'] as List? ??
        [],
    activeMemberIds:
        (j['activeMemberIds'] as List? ?? j['active_member_ids'] as List?)
            ?.whereType<String>()
            .toList() ??
        const [],
  );
}

class SkillArgument {
  const SkillArgument({
    required this.name,
    this.description = '',
    this.required = false,
  });

  final String name;
  final String description;
  final bool required;

  static SkillArgument fromJson(Map<String, dynamic> j) => SkillArgument(
    name: j['name'] as String? ?? '',
    description: j['description'] as String? ?? '',
    required: j['required'] as bool? ?? false,
  );

  Map<String, dynamic> toJson() => {
    'name': name,
    'description': description,
    'required': required,
  };
}

class SkillDescriptor {
  SkillDescriptor({
    required this.name,
    required this.description,
    required this.instructions,
    this.whenToUse,
    this.arguments = const [],
    this.allowedTools = const [],
    this.context = 'inline',
    this.path = '',
  });
  final String name;
  final String description;
  final String instructions;
  final String? whenToUse;
  final List<SkillArgument> arguments;
  final List<String> allowedTools;
  final String context;
  final String path;

  static SkillDescriptor fromJson(Map<String, dynamic> j) => SkillDescriptor(
    name: j['name'] as String? ?? '',
    description: j['description'] as String? ?? '',
    instructions: j['instructions'] as String? ?? '',
    whenToUse: (j['whenToUse'] ?? j['when_to_use']) as String?,
    arguments:
        (j['arguments'] as List?)
            ?.whereType<Map>()
            .map((argument) => SkillArgument.fromJson(argument.cast()))
            .toList() ??
        const [],
    allowedTools:
        (j['allowedTools'] as List? ?? j['allowed_tools'] as List?)
            ?.whereType<String>()
            .toList() ??
        const [],
    context: j['context'] as String? ?? 'inline',
    path: j['path'] as String? ?? '',
  );

  Map<String, dynamic> toJson() => {
    'name': name,
    'description': description,
    if (whenToUse != null && whenToUse!.isNotEmpty) 'whenToUse': whenToUse,
    if (arguments.isNotEmpty)
      'arguments': arguments.map((argument) => argument.toJson()).toList(),
    if (allowedTools.isNotEmpty) 'allowedTools': allowedTools,
    'context': context,
    'instructions': instructions,
    if (path.isNotEmpty) 'path': path,
  };
}

/// Structured cadence used by Electron scheduled tasks. Legacy cron entries
/// are represented with `kind == 'cron'` and [expression] populated.
class ScheduledTaskSchedule {
  const ScheduledTaskSchedule({
    required this.kind,
    this.runAt,
    this.everyMinutes,
    this.startAt,
    this.timeOfDay,
    this.weekdays = const [],
    this.dates = const [],
    this.expression,
  });

  final String kind;
  final String? runAt;
  final int? everyMinutes;
  final String? startAt;
  final String? timeOfDay;
  final List<int> weekdays;
  final List<String> dates;
  final String? expression;

  bool get isLegacyCron => kind == 'cron';

  static ScheduledTaskSchedule? tryParse(Object? value) {
    if (value is! Map) return null;
    final j = value.cast<String, dynamic>();
    final kind =
        (j['kind'] ?? j['scheduleKind'] ?? j['schedule_kind']) as String? ?? '';
    if (kind.isEmpty) return null;
    final weekdays =
        (j['weekdays'] as List?)
            ?.whereType<num>()
            .map((day) => day.toInt())
            .toList() ??
        const <int>[];
    final dates =
        (j['dates'] as List?)?.whereType<String>().toList() ?? const <String>[];
    return ScheduledTaskSchedule(
      kind: kind,
      runAt: j['runAt'] as String? ?? j['run_at'] as String?,
      everyMinutes: ((j['everyMinutes'] ?? j['every_minutes']) as num?)
          ?.toInt(),
      startAt: j['startAt'] as String? ?? j['start_at'] as String?,
      timeOfDay: j['timeOfDay'] as String? ?? j['time_of_day'] as String?,
      weekdays: weekdays,
      dates: dates,
      expression: j['expression'] as String? ?? j['cron'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
    'kind': kind,
    if (runAt != null) 'runAt': runAt,
    if (everyMinutes != null) 'everyMinutes': everyMinutes,
    if (startAt != null) 'startAt': startAt,
    if (timeOfDay != null) 'timeOfDay': timeOfDay,
    if (weekdays.isNotEmpty) 'weekdays': weekdays,
    if (dates.isNotEmpty) 'dates': dates,
    if (expression != null) 'expression': expression,
  };
}

class ScheduledTaskRetryPolicy {
  const ScheduledTaskRetryPolicy({
    this.maxRetries = 0,
    this.retryDelayMinutes = 5,
  });

  final int maxRetries;
  final int retryDelayMinutes;

  static ScheduledTaskRetryPolicy fromJson(Object? value) {
    if (value is! Map) return const ScheduledTaskRetryPolicy();
    final j = value.cast<String, dynamic>();
    return ScheduledTaskRetryPolicy(
      maxRetries: ((j['maxRetries'] ?? j['max_retries']) as num?)?.toInt() ?? 0,
      retryDelayMinutes:
          ((j['retryDelayMinutes'] ?? j['retry_delay_minutes']) as num?)
              ?.toInt() ??
          5,
    );
  }

  Map<String, dynamic> toJson() => {
    'maxRetries': maxRetries,
    'retryDelayMinutes': retryDelayMinutes,
  };
}

class ScheduleEntry {
  ScheduleEntry({
    required this.id,
    required this.name,
    required this.cron,
    required this.task,
    required this.enabled,
    this.nextRunAt,
    this.lastRunAt,
    this.schedule,
    this.selectedSkillIds = const [],
    this.selectedMcpServerIds = const [],
    this.retryPolicy = const ScheduledTaskRetryPolicy(),
    this.retryScheduledAt,
    this.retryAttempt = 0,
    this.createdBy = 'manual',
    this.createdAt = '',
    this.updatedAt = '',
    this.lastStatus = 'idle',
  });
  final String id;
  final String name;
  final String cron;
  final String task;
  final bool enabled;
  final String? nextRunAt;
  final String? lastRunAt;
  final ScheduledTaskSchedule? schedule;
  final List<String> selectedSkillIds;
  final List<String> selectedMcpServerIds;
  final ScheduledTaskRetryPolicy retryPolicy;
  final String? retryScheduledAt;
  final int retryAttempt;
  final String createdBy;
  final String createdAt;
  final String updatedAt;
  final String lastStatus;

  String get title => name;
  String get prompt => task;

  static ScheduleEntry fromJson(Map<String, dynamic> j) => ScheduleEntry(
    id: j['id'] as String? ?? '',
    name: (j['name'] ?? j['title']) as String? ?? '',
    cron: j['cron'] as String? ?? '',
    task: (j['task'] ?? j['prompt']) as String? ?? '',
    enabled: j['enabled'] as bool? ?? true,
    nextRunAt: (j['nextRunAt'] ?? j['next_run_at']) as String?,
    lastRunAt: (j['lastRunAt'] ?? j['last_run_at']) as String?,
    schedule: ScheduledTaskSchedule.tryParse(j['schedule']),
    selectedSkillIds:
        (j['selectedSkillIds'] as List? ?? j['selected_skill_ids'] as List?)
            ?.whereType<String>()
            .toList() ??
        const [],
    selectedMcpServerIds:
        (j['selectedMcpServerIds'] as List? ??
                j['selected_mcp_server_ids'] as List?)
            ?.whereType<String>()
            .toList() ??
        const [],
    retryPolicy: ScheduledTaskRetryPolicy.fromJson(
      j['retryPolicy'] ?? j['retry_policy'],
    ),
    retryScheduledAt:
        (j['retryScheduledAt'] ?? j['retry_scheduled_at']) as String?,
    retryAttempt:
        ((j['retryAttempt'] ?? j['retry_attempt']) as num?)?.toInt() ?? 0,
    createdBy: (j['createdBy'] ?? j['created_by']) as String? ?? 'manual',
    createdAt: (j['createdAt'] ?? j['created_at']) as String? ?? '',
    updatedAt: (j['updatedAt'] ?? j['updated_at']) as String? ?? '',
    lastStatus: (j['lastStatus'] ?? j['last_status']) as String? ?? 'idle',
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'cron': cron,
    'task': task,
    'enabled': enabled,
    if (lastRunAt != null) 'lastRunAt': lastRunAt,
    if (nextRunAt != null) 'nextRunAt': nextRunAt,
    if (schedule != null) 'schedule': schedule!.toJson(),
    'selectedSkillIds': selectedSkillIds,
    'selectedMcpServerIds': selectedMcpServerIds,
    'retryPolicy': retryPolicy.toJson(),
    if (retryScheduledAt != null) 'retryScheduledAt': retryScheduledAt,
    'retryAttempt': retryAttempt,
    'createdBy': createdBy,
    if (createdAt.isNotEmpty) 'createdAt': createdAt,
    if (updatedAt.isNotEmpty) 'updatedAt': updatedAt,
    'lastStatus': lastStatus,
  };
}

/// Durable MCP configuration. Flutter keeps Electron's settings shape
/// (`id` + `command`/`url`), while Rust also accepts the compact `target`
/// shape used by direct harness callers.
class McpServerConfig {
  const McpServerConfig({
    required this.id,
    required this.name,
    this.enabled = true,
    this.transport = 'stdio',
    this.command = '',
    this.args = const [],
    this.cwd = '',
    this.env = const {},
    this.url = '',
    this.headers = const {},
    this.timeoutMs = 15000,
  });

  final String id;
  final String name;
  final bool enabled;
  final String transport;
  final String command;
  final List<String> args;
  final String cwd;
  final Map<String, String> env;
  final String url;
  final Map<String, String> headers;
  final int timeoutMs;

  static Map<String, String> _stringMap(Object? value) {
    if (value is! Map) return const <String, String>{};
    return value.map<String, String>(
      (key, value) => MapEntry(key.toString(), value.toString()),
    );
  }

  static McpServerConfig fromJson(Map<String, dynamic> j) {
    final id = (j['id'] ?? j['serverId'] ?? j['name']) as String? ?? '';
    final transport = j['transport'] as String? ?? 'stdio';
    final target = j['target'] as String? ?? '';
    final command =
        j['command'] as String? ?? (transport == 'stdio' ? target : '');
    final url = j['url'] as String? ?? (transport != 'stdio' ? target : '');
    return McpServerConfig(
      id: id,
      name:
          (j['displayName'] ?? j['display_name'] ?? j['name']) as String? ?? id,
      enabled: j['enabled'] as bool? ?? true,
      transport: transport,
      command: command,
      args: (j['args'] as List?)?.whereType<String>().toList() ?? const [],
      cwd: j['cwd'] as String? ?? '',
      env: _stringMap(j['env']),
      url: url,
      headers: _stringMap(j['headers']),
      timeoutMs:
          ((j['timeoutMs'] ?? j['timeout_ms']) as num?)?.toInt() ?? 15000,
    );
  }

  /// Settings shape consumed by `settings.set` and `mcp.reload`.
  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'enabled': enabled,
    'transport': transport,
    'command': command,
    'args': args,
    'cwd': cwd,
    'env': env,
    'url': url,
    'headers': headers,
    'timeoutMs': timeoutMs,
  };
}

class McpTool {
  const McpTool({
    required this.server,
    required this.name,
    this.serverName = '',
    this.description = '',
    this.inputSchema = const {},
  });

  final String server;
  final String serverName;
  final String name;
  final String description;
  final Map<String, dynamic> inputSchema;

  static McpTool fromJson(Map<String, dynamic> j) => McpTool(
    server: (j['server'] ?? j['serverId'] ?? j['server_id']) as String? ?? '',
    serverName: j['serverName'] as String? ?? '',
    name: j['name'] as String? ?? '',
    description: j['description'] as String? ?? '',
    inputSchema: (j['inputSchema'] ?? j['input_schema']) is Map
        ? ((j['inputSchema'] ?? j['input_schema']) as Map)
              .cast<String, dynamic>()
        : const {},
  );

  Map<String, dynamic> toJson() => {
    'server': server,
    'serverName': serverName,
    'name': name,
    'description': description,
    'inputSchema': inputSchema,
  };
}

class McpToolSummary {
  const McpToolSummary({
    required this.name,
    this.localName = '',
    this.description = '',
    this.inputSchema = const {},
  });

  final String name;
  final String localName;
  final String description;
  final Map<String, dynamic> inputSchema;

  static McpToolSummary fromJson(Map<String, dynamic> j) => McpToolSummary(
    name: j['name'] as String? ?? '',
    localName: (j['localName'] ?? j['local_name']) as String? ?? '',
    description: j['description'] as String? ?? '',
    inputSchema: (j['inputSchema'] ?? j['input_schema']) is Map
        ? ((j['inputSchema'] ?? j['input_schema']) as Map)
              .cast<String, dynamic>()
        : const {},
  );
}

class McpResourceSummary {
  const McpResourceSummary({
    required this.uri,
    required this.name,
    this.description,
    this.mimeType,
  });

  final String uri;
  final String name;
  final String? description;
  final String? mimeType;

  static McpResourceSummary fromJson(Map<String, dynamic> j) =>
      McpResourceSummary(
        uri: j['uri'] as String? ?? '',
        name: j['name'] as String? ?? '',
        description: j['description'] as String?,
        mimeType: (j['mimeType'] ?? j['mime_type']) as String?,
      );
}

class McpPromptArgumentSummary {
  const McpPromptArgumentSummary({
    required this.name,
    this.description,
    this.required,
  });

  final String name;
  final String? description;
  final bool? required;

  static McpPromptArgumentSummary fromJson(Map<String, dynamic> j) =>
      McpPromptArgumentSummary(
        name: j['name'] as String? ?? '',
        description: j['description'] as String?,
        required: j['required'] as bool?,
      );
}

class McpPromptSummary {
  const McpPromptSummary({
    required this.name,
    this.description = '',
    this.arguments = const [],
  });

  final String name;
  final String description;
  final List<McpPromptArgumentSummary> arguments;

  static McpPromptSummary fromJson(Map<String, dynamic> j) => McpPromptSummary(
    name: j['name'] as String? ?? '',
    description: j['description'] as String? ?? '',
    arguments:
        (j['arguments'] as List?)
            ?.whereType<Map>()
            .map(
              (argument) => McpPromptArgumentSummary.fromJson(argument.cast()),
            )
            .toList() ??
        const [],
  );
}

class McpCapabilities {
  const McpCapabilities({
    this.tools = false,
    this.resources = false,
    this.prompts = false,
  });

  final bool tools;
  final bool resources;
  final bool prompts;

  static McpCapabilities fromJson(Object? value) {
    if (value is! Map) return const McpCapabilities();
    return McpCapabilities(
      tools: value['tools'] as bool? ?? false,
      resources: value['resources'] as bool? ?? false,
      prompts: value['prompts'] as bool? ?? false,
    );
  }
}

class McpServerSnapshot {
  const McpServerSnapshot({
    required this.id,
    required this.name,
    required this.enabled,
    required this.transport,
    required this.status,
    this.error,
    this.updatedAt,
    this.tools = const [],
    this.resources = const [],
    this.prompts = const [],
    this.capabilities = const McpCapabilities(),
  });

  final String id;
  final String name;
  final bool enabled;
  final String transport;
  final String status;
  final String? error;
  final String? updatedAt;
  final List<McpToolSummary> tools;
  final List<McpResourceSummary> resources;
  final List<McpPromptSummary> prompts;
  final McpCapabilities capabilities;

  static McpServerSnapshot fromJson(Map<String, dynamic> j) =>
      McpServerSnapshot(
        id: j['id'] as String? ?? '',
        name: j['name'] as String? ?? '',
        enabled: j['enabled'] as bool? ?? false,
        transport: j['transport'] as String? ?? '',
        status: j['status'] as String? ?? 'disconnected',
        error: j['error'] as String?,
        updatedAt: (j['updatedAt'] ?? j['updated_at']) as String?,
        tools:
            (j['tools'] as List?)
                ?.whereType<Map>()
                .map((tool) => McpToolSummary.fromJson(tool.cast()))
                .toList() ??
            const [],
        resources:
            (j['resources'] as List?)
                ?.whereType<Map>()
                .map((resource) => McpResourceSummary.fromJson(resource.cast()))
                .toList() ??
            const [],
        prompts:
            (j['prompts'] as List?)
                ?.whereType<Map>()
                .map((prompt) => McpPromptSummary.fromJson(prompt.cast()))
                .toList() ??
            const [],
        capabilities: McpCapabilities.fromJson(j['capabilities']),
      );
}

class McpStateSnapshot {
  const McpStateSnapshot({required this.servers, required this.updatedAt});

  final List<McpServerSnapshot> servers;
  final String updatedAt;

  static McpStateSnapshot fromJson(Map<String, dynamic> j) => McpStateSnapshot(
    servers:
        (j['servers'] as List?)
            ?.whereType<Map>()
            .map((server) => McpServerSnapshot.fromJson(server.cast()))
            .toList() ??
        const [],
    updatedAt: (j['updatedAt'] ?? j['updated_at']) as String? ?? '',
  );
}

class McpListResult {
  const McpListResult({required this.servers, required this.tools});

  final List<String> servers;
  final List<McpTool> tools;

  static McpListResult fromJson(Map<String, dynamic> j) => McpListResult(
    servers: (j['servers'] as List?)?.whereType<String>().toList() ?? const [],
    tools:
        (j['tools'] as List?)
            ?.whereType<Map>()
            .map((tool) => McpTool.fromJson(tool.cast()))
            .toList() ??
        const [],
  );
}

enum HarnessState { disconnected, connecting, connected }

class PendingPermission {
  PendingPermission({
    required this.streamId,
    required this.requestId,
    required this.toolName,
    required this.argsSummary,
  });
  final String streamId;
  final String requestId;
  final String toolName;
  final String argsSummary;
}

/// 宿主反向请求（ask_user / page_automation / document.openOriginal）。
class HostRequest {
  HostRequest({
    required this.streamId,
    required this.requestId,
    required this.kind,
    required this.payload,
  });
  final String streamId;
  final String requestId;
  final String kind; // ask_user / page_automation / document.openOriginal
  final Map<String, dynamic> payload;
}

/// Web 快捷方式（轻应用）。
class WebApp {
  WebApp({required this.name, required this.url});
  final String name;
  final String url;
  Map<String, dynamic> toJson() => {'name': name, 'url': url};
  static WebApp fromJson(Map<String, dynamic> j) =>
      WebApp(name: j['name'] as String, url: j['url'] as String);
}

/// Harness WS 客户端（单例）。
class HarnessClient {
  HarnessClient._();

  static final HarnessClient instance = HarnessClient._();

  WebSocketChannel? _channel;
  int _nextId = 1;
  final Map<String, Completer<dynamic>> _pending = {};
  final Map<String, StreamController<EventFrame>> _streams = {};
  // A stream can start emitting before the chat/studio RPC future resolves and
  // the caller has a chance to attach a listener. Keep a small per-stream
  // backlog until subscribeStream installs one; otherwise fast mock/image
  // runs lose their terminal event (and the UI stays busy forever).
  final Map<String, List<EventFrame>> _streamBacklog = {};
  final Map<String, int> _lastSeq = {};
  final Set<String> _activeStudioStreams = {};
  final _stateCtrl = StreamController<HarnessState>.broadcast();
  final _permissionsCtrl = StreamController<PendingPermission>.broadcast();
  final _hostRequestsCtrl = StreamController<HostRequest>.broadcast();
  final _allFramesCtrl = StreamController<EventFrame>.broadcast();
  final _studioTasksChangedCtrl = StreamController<void>.broadcast();
  Future<void> _studioTaskWriteQueue = Future<void>.value();

  String _host = '127.0.0.1';
  int _port = 19527;
  String _authToken = '';
  bool _handshaked = false;
  bool _disposed = false;
  Timer? _reconnectTimer;

  Stream<HarnessState> get stateStream => _stateCtrl.stream;
  HarnessState get state => _channel != null && _handshaked
      ? HarnessState.connected
      : HarnessState.disconnected;
  Stream<EventFrame> get events => _allFramesCtrl.stream;
  Stream<PendingPermission> get permissionRequests => _permissionsCtrl.stream;
  Stream<HostRequest> get hostRequests => _hostRequestsCtrl.stream;
  Stream<void> get studioTasksChanged => _studioTasksChangedCtrl.stream;
  bool isStudioStreamActive(String streamId) =>
      _activeStudioStreams.contains(streamId);
  String get host => _host;
  int get port => _port;

  void configure({
    required String host,
    required int port,
    required String authToken,
  }) {
    if (authToken.isEmpty) {
      throw ArgumentError.value(authToken, 'authToken', 'must not be empty');
    }
    _host = host;
    _port = port;
    _authToken = authToken;
  }

  Uri resourceUri(String path) => Uri(
    scheme: 'http',
    host: _host,
    port: _port,
    path: path.startsWith('/') ? path : '/$path',
    queryParameters: {'token': _authToken},
  );

  Future<void> connect() async {
    if (_channel != null) return;
    _disposed = false;
    _stateCtrl.add(HarnessState.connecting);
    final url = Uri(
      scheme: 'ws',
      host: _host,
      port: _port,
      path: '/ws',
      queryParameters: {'token': _authToken},
    );
    try {
      final channel = WebSocketChannel.connect(url);
      await channel.ready.timeout(const Duration(seconds: 5));
      _channel = channel;
      channel.stream.listen(
        _onMessage,
        onDone: _onDisconnected,
        onError: (_) => _onDisconnected(),
      );
      await _handshake();
      _stateCtrl.add(HarnessState.connected);
    } catch (e) {
      _channel = null;
      _stateCtrl.add(HarnessState.disconnected);
      rethrow;
    }
  }

  Future<void> _handshake() async {
    await call('initialize', {
      'protocolVersion': '1.0',
      'capabilities': {
        'platform': 'mobile',
        // The mobile app mounts GlobalDialogHost and can answer permission
        // requests. Without this flag ask-permission tools are rejected before
        // execution, which made image tools appear to hang without queueing.
        'features': [
          'lightweight_runtime',
          'webview_automation',
          'interactive',
        ],
        'excludes': ['subprocess', 'port_binding', 'webhook_receiver'],
      },
    });
    _handshaked = true;
  }

  void _onDisconnected() {
    _channel = null;
    _handshaked = false;
    _failAllPending(Exception('harness connection closed'));
    _stateCtrl.add(HarnessState.disconnected);
    if (_disposed) return;
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(const Duration(seconds: 2), () async {
      try {
        await connect();
        await _resumeAll();
      } catch (_) {}
    });
  }

  Future<void> _resumeAll() async {
    for (final entry in _lastSeq.entries) {
      try {
        final result = await call('chat.resume', {
          'streamId': entry.key,
          'afterSeq': entry.value,
        });
        final events = result?['events'] as List?;
        if (events != null) {
          for (final e in events) {
            _dispatchFrame(
              EventFrame.fromJson((e as Map).cast<String, dynamic>()),
            );
          }
        }
      } catch (_) {}
    }
  }

  void _onMessage(dynamic raw) {
    final msg = jsonDecode(raw as String) as Map<String, dynamic>;
    if (msg.containsKey('id') &&
        (msg.containsKey('result') || msg.containsKey('error'))) {
      final id = msg['id'];
      final completer = id == null ? null : _pending.remove(id.toString());
      if (msg.containsKey('error')) {
        final error = Exception(msg['error']?['message'] ?? 'rpc error');
        if (completer != null) {
          completer.completeError(error);
        } else {
          // Parse/invalid-request responses use id=null because the server
          // cannot correlate them. They invalidate the in-flight batch rather
          // than leaving every caller blocked until its timeout.
          _failAllPending(error);
        }
      } else {
        completer?.complete(msg['result']);
      }
      return;
    }
    if (msg['method'] == 'event') {
      final frame = EventFrame.fromJson(
        (msg['params'] as Map).cast<String, dynamic>(),
      );
      _dispatchFrame(frame);
    }
  }

  void _dispatchFrame(EventFrame frame) {
    final last = _lastSeq[frame.streamId] ?? -1;
    // Resume/reconnect may replay a frame already delivered live. Ignore
    // duplicates before forwarding to UI/global listeners.
    if (frame.seq <= last) return;
    _lastSeq[frame.streamId] = frame.seq;

    final stream = _streams[frame.streamId];
    if (stream != null && stream.hasListener && !stream.isClosed) {
      stream.add(frame);
    } else {
      final backlog = _streamBacklog.putIfAbsent(
        frame.streamId,
        () => <EventFrame>[],
      );
      // A bounded guard protects the client if a caller never subscribes to a
      // long-running stream. Terminal frames are retained until subscription.
      if (backlog.length >= 256) backlog.removeAt(0);
      backlog.add(frame);
    }
    _allFramesCtrl.add(frame);

    if (frame.kind == 'permission_request') {
      _permissionsCtrl.add(
        PendingPermission(
          streamId: frame.streamId,
          requestId: frame.data['requestId'] as String? ?? '',
          toolName: frame.data['toolName'] as String? ?? '',
          argsSummary: frame.data['argsSummary'] as String? ?? '',
        ),
      );
    } else if (frame.kind == 'host_request') {
      _hostRequestsCtrl.add(
        HostRequest(
          streamId: frame.streamId,
          requestId: frame.data['requestId'] as String? ?? '',
          kind: frame.data['requestKind'] as String? ?? '',
          payload:
              (frame.data['payload'] as Map?)?.cast<String, dynamic>() ?? {},
        ),
      );
    }
  }

  Future<void> respondPermission(String requestId, bool allow) =>
      call('chat.respond', {'requestId': requestId, 'allow': allow});

  /// 应答宿主反向请求（ask_user 答案 / 页面自动化结果）。
  Future<void> respondHost(String requestId, dynamic result) =>
      call('host.respond', {'requestId': requestId, 'result': result});

  Future<dynamic> call(String method, Map<String, dynamic> params) async {
    final channel = _channel;
    if (channel == null) throw Exception('not connected');
    final id = _nextId++;
    final completer = Completer<dynamic>();
    _pending['$id'] = completer;
    channel.sink.add(
      jsonEncode(
        sanitizeJsonForTransport({
          'jsonrpc': '2.0',
          'id': id,
          'method': method,
          'params': params,
        }),
      ),
    );
    try {
      return await completer.future.timeout(const Duration(seconds: 60));
    } finally {
      if (identical(_pending['$id'], completer)) {
        _pending.remove('$id');
      }
    }
  }

  void _failAllPending(Object error) {
    final pending = _pending.values.toList();
    _pending.clear();
    for (final completer in pending) {
      if (!completer.isCompleted) completer.completeError(error);
    }
  }

  Stream<EventFrame> subscribeStream(String streamId) {
    _streams[streamId]?.close();
    late final StreamController<EventFrame> ctrl;
    ctrl = StreamController<EventFrame>.broadcast(
      onListen: () {
        // `onListen` runs after listen() is attached, so replaying here is
        // safe for a broadcast controller (adding before a listener would be
        // silently dropped).
        final pending = _streamBacklog.remove(streamId);
        if (pending == null) return;
        for (final frame in pending) {
          if (!ctrl.isClosed) ctrl.add(frame);
        }
      },
    );
    _streams[streamId] = ctrl;
    return ctrl.stream;
  }

  // ---------- 会话 ----------

  Future<List<ConversationMeta>> listConversations() async {
    final result = await call('conversation.list', {'limit': 100});
    final list = result?['conversations'] as List? ?? [];
    return list
        .map(
          (e) => ConversationMeta.fromJson((e as Map).cast<String, dynamic>()),
        )
        .toList();
  }

  Future<ConversationMeta> createConversation(
    String title, {
    String? agentId,
  }) async {
    final result = await call('conversation.create', {
      'title': title,
      'agentId': ?agentId,
    });
    return ConversationMeta.fromJson((result as Map).cast<String, dynamic>());
  }

  Future<List<ChatMessage>> listMessages(String conversationId) async {
    final result = await call('conversation.messages', {'id': conversationId});
    final list = result?['messages'] as List? ?? [];
    return list
        .map((e) => ChatMessage.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
  }

  Future<void> deleteConversation(String id) =>
      call('conversation.delete', {'id': id});
  Future<void> renameConversation(String id, String title) =>
      call('conversation.rename', {'id': id, 'title': title});

  /// Start a chat run.
  ///
  /// Rust flattens [ChatRunContext] into `chat.send`, so reasoning controls
  /// are sent as `reasoningEffort` (rather than a nested `context` object).
  /// [webSearch] is translated to the same context contract: enabled runs
  /// receive an explicit instruction, disabled runs deny every built-in web tool.
  Future<String> sendChat(
    String conversationId,
    String text, {
    String? providerId,
    String? model,
    bool enableThinking = false,
    String? reasoningEffort,
    double? temperature,
    bool? webSearch,
    List<Map<String, dynamic>> contentParts = const [],
  }) async {
    final params = buildChatSendParams(
      conversationId: conversationId,
      text: text,
      providerId: providerId,
      model: model,
      enableThinking: enableThinking,
      reasoningEffort: reasoningEffort,
      temperature: temperature,
      webSearch: webSearch,
      contentParts: contentParts,
    );
    final result = await call('chat.send', params);
    final streamId = _readStreamId(result, method: 'chat.send');
    // Do not overwrite a sequence received in the tiny RPC/notification race.
    _lastSeq.putIfAbsent(streamId, () => -1);
    return streamId;
  }

  Future<Map<String, dynamic>> parseDocumentFile(String path) async {
    final result = await call('doc.parse', {'path': path});
    return (result as Map).cast<String, dynamic>();
  }

  /// Import a document through the shared document-workbench contract.
  ///
  /// Electron wraps the artifact in `{ artifact }`, while early Rust builds
  /// returned the artifact object directly.  Accept both forms during the
  /// migration so an app update does not have to be deployed atomically with
  /// the bundled harness binary.
  Future<DocumentArtifact> importDocument(String path) async {
    final result = await call('doc.import', {'path': path});
    final artifact = _unwrapDocumentArtifact(result);
    if (artifact == null) {
      throw const FormatException('doc.import missing artifact');
    }
    return DocumentArtifact.fromJson(artifact);
  }

  /// List imported document summaries.  Rust tool-compatible builds may
  /// return `{ documents, selections }`, whereas the Electron preload API
  /// returns the summary array directly.
  Future<List<DocumentSummary>> listDocuments() async {
    final result = await call('doc.list', {});
    final list = _documentListFromResult(result);
    return list.map(DocumentSummary.fromJson).toList(growable: false);
  }

  /// Fetch one imported artifact by id.  A missing artifact is represented by
  /// `null`, matching Electron's `document:get` IPC handler.
  Future<DocumentArtifact?> getDocument(String artifactId) async {
    final result = await call('doc.get', {'artifactId': artifactId});
    final artifact = _unwrapDocumentArtifact(result);
    return artifact == null ? null : DocumentArtifact.fromJson(artifact);
  }

  /// Ensure a preview is available and return the hydrated artifact, if one
  /// exists.  The Rust response can be either a direct artifact or an
  /// `{ artifact }` wrapper; a `{ render }` wrapper is also accepted for
  /// lightweight preview-only implementations.
  Future<DocumentArtifact?> ensureDocumentRenderPreview(
    String artifactId,
  ) async {
    final result = await call('doc.preview.ensure', {'artifactId': artifactId});
    final artifact = _unwrapDocumentArtifact(result);
    if (artifact != null) return DocumentArtifact.fromJson(artifact);
    if (result is Map && result['render'] is Map) {
      final current = await getDocument(artifactId);
      if (current == null) return null;
      return DocumentArtifact.fromJson({
        ...current.toJson(),
        'render': result['render'],
      });
    }
    return null;
  }

  /// Read the bytes for an ensured preview.  JSON-RPC transports commonly
  /// encode `Vec<u8>` as an integer list, while a bridge may use base64; both
  /// representations are accepted here.
  Future<DocumentRenderAsset?> getDocumentRenderData(String artifactId) async {
    final result = await call('doc.preview.read', {'artifactId': artifactId});
    if (result == null) return null;
    final payload = result is Map && result['asset'] is Map
        ? (result['asset'] as Map).cast<String, dynamic>()
        : result;
    if (payload is! Map) {
      throw const FormatException('doc.preview.read returned invalid data');
    }
    return DocumentRenderAsset.fromJson(payload.cast<String, dynamic>());
  }

  /// Ask the host to open an original document.  A desktop Rust host may
  /// delegate to its shell and return `{ success: true }`; mobile hosts are
  /// expected to return `{ success: false, supported: false }` because they
  /// do not expose Electron's `shell.openPath` capability.
  Future<DocumentOpenResult> openDocumentOriginal(String artifactId) async {
    final result = await call('doc.openOriginal', {'artifactId': artifactId});
    return DocumentOpenResult.fromJson(result);
  }

  /// Remove an imported artifact and its associated selections.  Accept both
  /// Electron's bare boolean and Rust's explicit `{ removed }` response.
  Future<bool> removeDocument(String artifactId) async {
    final result = await call('doc.remove', {'artifactId': artifactId});
    if (result is bool) return result;
    if (result is Map) {
      final json = result.cast<String, dynamic>();
      final removed = json['removed'] ?? json['deleted'] ?? json['success'];
      if (removed is bool) return removed;
    }
    throw const FormatException('doc.remove returned invalid data');
  }

  /// Read the source fingerprint used by document editors to reject writes
  /// against a file changed by another process.
  Future<DocumentEditSourceState> getDocumentEditSourceState(
    String artifactId,
  ) async {
    final result = await call('doc.editSource', {'artifactId': artifactId});
    if (result is! Map) {
      throw const FormatException('doc.editSource returned invalid data');
    }
    return DocumentEditSourceState.fromJson(result.cast<String, dynamic>());
  }

  /// Aliases matching the Electron preload names.  Keeping these alongside
  /// the `get*` names makes callers portable without leaking transport method
  /// names into widgets.
  Future<DocumentArtifact?> getDocumentPreview(String artifactId) =>
      ensureDocumentRenderPreview(artifactId);

  Future<DocumentRenderAsset?> readDocumentPreview(String artifactId) =>
      getDocumentRenderData(artifactId);

  List<Map<String, dynamic>> _documentListFromResult(Object? result) {
    final raw = result is List
        ? result
        : result is Map
        ? (result['documents'] ?? result['items'] ?? const [])
        : const [];
    if (raw is! List) {
      throw const FormatException('doc.list returned invalid documents');
    }
    return raw
        .whereType<Map>()
        .map((entry) => entry.cast<String, dynamic>())
        .toList(growable: false);
  }

  Map<String, dynamic>? _unwrapDocumentArtifact(Object? result) {
    if (result == null) return null;
    if (result is! Map) return null;
    final json = result.cast<String, dynamic>();
    final nested = json['artifact'];
    if (nested is Map) return nested.cast<String, dynamic>();
    // `{ document: { ... } }` is used by one older app-server prototype.
    final document = json['document'];
    if (document is Map) return document.cast<String, dynamic>();
    // A render-only / status response is not an artifact.
    if (json.containsKey('render') &&
        !json.containsKey('id') &&
        !json.containsKey('artifactId')) {
      return null;
    }
    return json;
  }

  /// List Rust-persisted document selections. When [artifactId] is supplied,
  /// only regions attached to that artifact are returned; omitted and empty
  /// values have the same unrestricted semantics as Electron's
  /// `getDocumentSelections` backing store.
  Future<List<DocumentSelection>> listDocumentSelections({
    String? artifactId,
  }) async {
    final result = await call('doc.selection.list', {
      'artifactId': ?artifactId,
    });
    final list = result is List
        ? result
        : result is Map
        ? result['selections'] as List? ?? const []
        : const [];
    return list
        .whereType<Map>()
        .map(
          (entry) => DocumentSelection.fromJson(entry.cast<String, dynamic>()),
        )
        .toList();
  }

  /// Alias matching Electron's preload API for callers that already use the
  /// document workbench naming.
  Future<List<DocumentSelection>> getDocumentSelections(String artifactId) =>
      listDocumentSelections(artifactId: artifactId);

  /// Create a durable selection on an imported document artifact.
  Future<DocumentSelection> createDocumentSelection({
    required String artifactId,
    List<String> nodeIds = const [],
    String label = '未命名选区',
    String color = '#3b82f6',
    String? excerpt,
  }) async {
    final result = await call('doc.selection.create', {
      'artifactId': artifactId,
      'nodeIds': nodeIds,
      'label': label,
      'color': color,
      'excerpt': ?excerpt,
    });
    if (result is! Map) {
      throw const FormatException('doc.selection.create missing selection');
    }
    return DocumentSelection.fromJson(result.cast<String, dynamic>());
  }

  /// Update the user-visible label of a selection. Unknown IDs return null,
  /// matching Electron's `DocumentStore.updateSelectionLabel` behavior.
  Future<DocumentSelection?> updateDocumentSelectionLabel(
    String regionId,
    String label,
  ) async {
    final result = await call('doc.selection.update', {
      'id': regionId,
      'label': label,
    });
    if (result == null) return null;
    if (result is! Map) {
      throw const FormatException('doc.selection.update returned invalid data');
    }
    return DocumentSelection.fromJson(result.cast<String, dynamic>());
  }

  /// Remove one selection, returning false when the region ID is unknown.
  Future<bool> removeDocumentSelection(String regionId) async {
    final result = await call('doc.selection.remove', {'id': regionId});
    if (result is bool) return result;
    throw const FormatException('doc.selection.remove returned invalid data');
  }

  /// Build the prompt envelope used when selected document text is injected
  /// into an agent request. Omitted [regionIds] includes every persisted
  /// selection; an explicitly empty list produces an empty prompt.
  Future<String> buildDocumentSelectionsPrompt([
    List<String>? regionIds,
  ]) async {
    final result = await call('doc.selection.prompt', {
      'regionIds': ?regionIds,
    });
    if (result is String) return result;
    throw const FormatException('doc.selection.prompt returned invalid data');
  }

  String _readStreamId(dynamic result, {required String method}) {
    if (result is Map) {
      final value = result['streamId'] ?? result['stream_id'];
      if (value is String && value.trim().isNotEmpty) return value;
    }
    throw FormatException('$method response missing streamId');
  }

  Future<void> abortChat({String? streamId, String? conversationId}) => call(
    'chat.abort',
    {'streamId': ?streamId, 'conversationId': ?conversationId},
  );

  /// 分叉/编辑重发。mode: fork（安全分叉）| inplace（截断原会话）。
  Future<Map<String, dynamic>> forkConversation(
    String conversationId,
    int messageId, {
    String? newText,
    String mode = 'fork',
  }) async {
    final result = await call('conversation.fork', {
      'conversationId': conversationId,
      'messageId': messageId,
      'mode': mode,
      'newText': ?newText,
    });
    return (result as Map).cast<String, dynamic>();
  }

  // ---------- 供应商 ----------

  Future<Map<String, dynamic>> listProviders() async {
    final result = await call('provider.list', {});
    if (result is! Map) return {};
    // Rust returns {providers: {providers: [...], activeProviderId: ...}}.
    // Keep accepting the legacy flat/list shape so an already-running older
    // harness cannot crash the model picker with a List-as-Map cast.
    final nested = result['providers'];
    if (nested is Map) return nested.cast<String, dynamic>();
    if (nested is List) {
      return <String, dynamic>{
        'providers': nested,
        if (result['activeProviderId'] != null)
          'activeProviderId': result['activeProviderId'],
      };
    }
    return result.cast<String, dynamic>();
  }

  Future<List<String>> fetchProviderModels({
    required String baseUrl,
    required String apiKey,
    String apiProtocol = '',
  }) async {
    final result = await call('provider.fetchModels', {
      'baseUrl': baseUrl,
      'apiKey': apiKey,
      'apiProtocol': apiProtocol,
    });
    final models = result is Map ? result['models'] as List? : null;
    return (models ?? const [])
        .whereType<String>()
        .map((model) => model.trim())
        .where((model) => model.isNotEmpty)
        .toSet()
        .toList()
      ..sort();
  }

  Future<Map<String, dynamic>> saveProvider(ProviderEntry entry) async {
    final r = await call('provider.save', {'provider': entry.toJson()});
    return (r as Map).cast<String, dynamic>();
  }

  Future<Map<String, dynamic>> deleteProvider(String id) async {
    final r = await call('provider.delete', {'id': id});
    return (r as Map).cast<String, dynamic>();
  }

  Future<Map<String, dynamic>> setActiveProvider(String id) async {
    final r = await call('provider.setActive', {'id': id});
    return (r as Map).cast<String, dynamic>();
  }

  // ---------- Agent ----------

  Future<List<AgentDefinition>> listAgents() async {
    final result = await call('agent.list', {});
    final list = result?['agents'] as List? ?? [];
    return list
        .map(
          (e) => AgentDefinition.fromJson((e as Map).cast<String, dynamic>()),
        )
        .toList();
  }

  Future<AgentDefinition> saveAgent(AgentDefinition agent) async {
    final result = await call('agent.save', {'agent': agent.toJson()});
    return AgentDefinition.fromJson(
      (result?['agent'] as Map).cast<String, dynamic>(),
    );
  }

  Future<void> deleteAgent(String id) => call('agent.delete', {'id': id});

  Future<List<AgentGroupDefinition>> listAgentGroups() async {
    final result = await call('agentGroup.list', {});
    final list = result?['groups'] as List? ?? [];
    return list
        .map(
          (e) =>
              AgentGroupDefinition.fromJson((e as Map).cast<String, dynamic>()),
        )
        .toList();
  }

  Future<AgentGroupDefinition> saveAgentGroup(
    AgentGroupDefinition group,
  ) async {
    final result = await call('agentGroup.save', {'group': group.toJson()});
    return AgentGroupDefinition.fromJson(
      (result?['group'] as Map).cast<String, dynamic>(),
    );
  }

  Future<void> deleteAgentGroup(String id) =>
      call('agentGroup.delete', {'id': id});

  // ---------- Studio ----------

  /// 生图/改图全参数（对齐桌面 ImageStudio），支持供应商/模型选择。
  Future<String> studioGenerate({
    required String prompt,
    String mode = 'generate',
    String? negativePrompt,
    String? aspect,
    String? resolution,
    String? quality,
    String? format,
    String? size,
    int n = 1,
    String? inputImageB64,
    List<String> inputImages = const [],
    String? folder,
    List<String> tags = const [],
    String? providerId,
    String? model,
  }) async {
    final result = await call('studio.generate', {
      'prompt': prompt,
      'mode': mode,
      if (negativePrompt != null && negativePrompt.isNotEmpty)
        'negativePrompt': negativePrompt,
      'aspect': ?aspect,
      'resolution': ?resolution,
      'quality': ?quality,
      'format': ?format,
      'size': ?size,
      'n': n,
      'providerId': ?providerId,
      if (model != null && model.isNotEmpty) 'model': model,
      'inputImageB64': ?inputImageB64,
      if (inputImages.isNotEmpty) 'inputImages': inputImages,
      if (folder != null && folder.isNotEmpty) 'folder': folder,
      if (tags.isNotEmpty) 'tags': tags,
    });
    final streamId = _readStreamId(result, method: 'studio.generate');
    _activeStudioStreams.add(streamId);
    return streamId;
  }

  Future<List<ImageEntry>> studioList({
    String? folder,
    String? tag,
    String? search,
  }) async {
    final result = await call('studio.list', {
      'limit': 120,
      if (folder != null && folder.isNotEmpty) 'folder': folder,
      if (tag != null && tag.isNotEmpty) 'tag': tag,
      if (search != null && search.isNotEmpty) 'search': search,
    });
    final list = result?['images'] as List? ?? [];
    return list
        .map((e) => ImageEntry.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
  }

  Future<String> optimizeStudioPrompt({
    required String prompt,
    bool isNegative = false,
    String? providerId,
    String? model,
  }) async {
    final result = await call('studio.prompt.optimize', {
      'prompt': prompt,
      'isNegative': isNegative,
      'providerId': ?providerId,
      if (model != null && model.isNotEmpty) 'model': model,
    });
    if (result is Map && result['ok'] == false) {
      throw StateError(result['error'] as String? ?? '提示词优化失败');
    }
    final optimized = result?['optimizedPrompt'] as String?;
    if (optimized == null || optimized.trim().isEmpty) {
      throw StateError('提示词优化返回为空');
    }
    return optimized.trim();
  }

  Future<void> studioTag(String id, String folder, List<String> tags) =>
      call('studio.tag', {'id': id, 'folder': folder, 'tags': tags});

  Future<void> studioDelete(String id) => call('studio.delete', {'id': id});

  Future<List<String>> studioListFolders() async {
    final result = await call('studio.folder', {'action': 'list'});
    return _decodeStudioFolderNames(result);
  }

  Future<List<String>> studioCreateFolder(String name) async {
    final result = await call('studio.folder', {
      'action': 'create',
      'name': name,
    });
    return _decodeStudioFolderNames(result);
  }

  Future<List<String>> studioRenameFolder(
    String oldName,
    String newName,
  ) async {
    await call('studio.folder', {
      'action': 'rename',
      'oldName': oldName,
      'newName': newName,
    });
    return studioListFolders();
  }

  Future<List<String>> studioDeleteFolder(String name) async {
    await call('studio.folder', {'action': 'delete', 'name': name});
    return studioListFolders();
  }

  List<String> _decodeStudioFolderNames(dynamic result) {
    final list = result is Map ? result['folders'] as List? : null;
    return (list ?? const [])
        .map((item) => item is Map ? item['name'] : item)
        .whereType<String>()
        .map((name) => name.trim())
        .where((name) => name.isNotEmpty)
        .toSet()
        .toList()
      ..sort();
  }

  Future<List<StudioTask>> loadStudioTasks() async {
    final result = await call('studio.tasks.load', {});
    final list = result?['tasks'] as List? ?? [];
    return list
        .map((e) => StudioTask.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
  }

  Future<void> saveStudioTasks(List<StudioTask> tasks) {
    final snapshot = tasks.map((task) => task.toJson()).toList();
    _studioTaskWriteQueue = _studioTaskWriteQueue
        .catchError((_) {})
        .then((_) => call('studio.tasks.save', {'tasks': snapshot}));
    return _studioTaskWriteQueue;
  }

  Future<void> mutateStudioTasks(
    List<StudioTask> Function(List<StudioTask> current) mutate,
  ) {
    _studioTaskWriteQueue = _studioTaskWriteQueue.catchError((_) {}).then((
      _,
    ) async {
      final result = await call('studio.tasks.load', {});
      final list = result?['tasks'] as List? ?? [];
      final current = list
          .map(
            (item) =>
                StudioTask.fromJson((item as Map).cast<String, dynamic>()),
          )
          .toList();
      final next = mutate(current);
      await call('studio.tasks.save', {
        'tasks': next.map((task) => task.toJson()).toList(),
      });
    });
    return _studioTaskWriteQueue;
  }

  Future<List<Map<String, dynamic>>> drainStudioTasks() async {
    final result = await call('studio.tasks.drain', {});
    final list = result?['tasks'] as List? ?? [];
    return list.map((e) => (e as Map).cast<String, dynamic>()).toList();
  }

  void notifyStudioTasksChanged() => _studioTasksChangedCtrl.add(null);

  void markStudioStreamFinished(String streamId) {
    _activeStudioStreams.remove(streamId);
  }

  // ---------- 轻应用（Agent 生成的单页应用）----------

  Future<List<LightApp>> listLightApps() async {
    final result = await call('lightapp.list', {});
    final list = result?['apps'] as List? ?? [];
    return list
        .map((e) => LightApp.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
  }

  Future<void> deleteLightApp(String id) => call('lightapp.delete', {'id': id});

  // ---------- 用量 ----------

  Future<UsageSummary> usageSummary({int days = 30}) async {
    final result = await call('usage.summary', {'days': days});
    return UsageSummary.fromJson((result as Map).cast<String, dynamic>());
  }

  // ---------- 群组 ----------

  Future<GroupSession> groupCreate({
    required String topic,
    required String mode,
    required List<Map<String, String>> members,
    String? coordinator,
    String? sessionId,
    int maxParallelWorkers = 2,
  }) async {
    final result = await call('group.create', {
      'topic': topic,
      'mode': mode,
      'members': members,
      'coordinator': ?coordinator,
      'sessionId': ?sessionId,
      'maxParallelWorkers': maxParallelWorkers,
    });
    return GroupSession.fromJson((result as Map).cast<String, dynamic>());
  }

  Future<GroupSession> groupGet(String id) async {
    final result = await call('group.get', {'id': id});
    return GroupSession.fromJson((result as Map).cast<String, dynamic>());
  }

  Future<String> groupMessage(
    String id,
    String text, {
    List<String> memberIds = const [],
  }) async {
    final result = await call('group.message', {
      'id': id,
      'text': text,
      if (memberIds.isNotEmpty) 'memberIds': memberIds,
    });
    final streamId = result is Map
        ? (result['streamId'] ?? result['stream_id']) as String?
        : null;
    final resolved = streamId == null || streamId.isEmpty ? id : streamId;
    _lastSeq.putIfAbsent(resolved, () => -1);
    return resolved;
  }

  Future<void> groupInject(String id, String content) =>
      call('group.inject', {'id': id, 'content': content});

  Future<dynamic> groupBoardUpdate(
    String id,
    String field,
    String op,
    String value,
  ) => call('group.board.update', {
    'id': id,
    'field': field,
    'op': op,
    'value': value,
  });

  // ---------- 技能 ----------

  Future<List<SkillDescriptor>> listSkills() async {
    final result = await call('skill.list', {});
    final list = result?['skills'] as List? ?? [];
    return list
        .map(
          (e) => SkillDescriptor.fromJson((e as Map).cast<String, dynamic>()),
        )
        .toList();
  }

  Future<void> saveSkill(
    String name,
    String description,
    String instructions, {
    String? whenToUse,
    List<SkillArgument> arguments = const [],
    List<String> allowedTools = const [],
    String context = 'inline',
  }) => call('skill.save', {
    'name': name,
    'description': description,
    'instructions': instructions,
    if (whenToUse != null && whenToUse.trim().isNotEmpty)
      'whenToUse': whenToUse.trim(),
    if (arguments.isNotEmpty)
      'arguments': arguments.map((argument) => argument.toJson()).toList(),
    if (allowedTools.isNotEmpty)
      'allowedTools': allowedTools
          .map((tool) => tool.trim())
          .where((tool) => tool.isNotEmpty)
          .toSet()
          .toList(),
    if (context == 'fork') 'context': 'fork',
  });

  Future<void> deleteSkill(String name) => call('skill.delete', {'name': name});

  Future<dynamic> runSkill(
    String name, {
    Map<String, dynamic> arguments = const {},
  }) => call('skill.run', {
    'name': name,
    if (arguments.isNotEmpty) 'arguments': arguments,
  });

  // ---------- 定时任务 ----------

  Future<List<ScheduleEntry>> listSchedules() async {
    final result = await call('schedule.list', {});
    final list = result?['schedules'] as List? ?? [];
    return list
        .map((e) => ScheduleEntry.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
  }

  Future<dynamic> createSchedule(
    String name,
    String cron,
    String task, {
    ScheduledTaskSchedule? schedule,
    bool enabled = true,
    List<String> selectedSkillIds = const [],
    List<String> selectedMcpServerIds = const [],
    ScheduledTaskRetryPolicy? retryPolicy,
    String? createdBy,
  }) {
    final params = <String, dynamic>{
      'name': name,
      'cron': cron,
      'task': task,
      'enabled': enabled,
      if (schedule != null) 'schedule': schedule.toJson(),
      if (selectedSkillIds.isNotEmpty) 'selectedSkillIds': selectedSkillIds,
      if (selectedMcpServerIds.isNotEmpty)
        'selectedMcpServerIds': selectedMcpServerIds,
      if (retryPolicy != null) 'retryPolicy': retryPolicy.toJson(),
      if (createdBy != null && createdBy.trim().isNotEmpty)
        'createdBy': createdBy.trim(),
    };
    return call('schedule.create', params);
  }

  Future<ScheduleEntry> updateSchedule(
    String id, {
    String? name,
    String? task,
    String? cron,
    ScheduledTaskSchedule? schedule,
    bool? enabled,
    List<String>? selectedSkillIds,
    List<String>? selectedMcpServerIds,
    ScheduledTaskRetryPolicy? retryPolicy,
    String? createdBy,
  }) async {
    final params = <String, dynamic>{
      'id': id,
      'name': ?name,
      'task': ?task,
      'cron': ?cron,
      if (schedule != null) 'schedule': schedule.toJson(),
      'enabled': ?enabled,
      'selectedSkillIds': ?selectedSkillIds,
      'selectedMcpServerIds': ?selectedMcpServerIds,
      if (retryPolicy != null) 'retryPolicy': retryPolicy.toJson(),
      'createdBy': ?createdBy,
    };
    final result = await call('schedule.update', params);
    final entry = result is Map ? result['entry'] : null;
    if (entry is! Map) throw FormatException('schedule.update missing entry');
    return ScheduleEntry.fromJson(entry.cast<String, dynamic>());
  }

  Future<String> runSchedule(String id) async {
    final result = await call('schedule.run', {'id': id});
    if (result is! Map) throw FormatException('schedule.run missing streamId');
    final streamId = (result['streamId'] ?? result['stream_id']) as String?;
    if (streamId == null || streamId.isEmpty) {
      throw FormatException('schedule.run missing streamId');
    }
    _lastSeq.putIfAbsent(streamId, () => -1);
    return streamId;
  }

  Future<void> deleteSchedule(String id) => call('schedule.delete', {'id': id});

  // ---------- 记忆 ----------

  Future<dynamic> searchMemory(String query, {int limit = 10}) =>
      call('memory.search', {'query': query, 'limit': limit});

  Future<void> addMemory(String content, {List<String> tags = const []}) =>
      call('memory.add', {'content': content, 'tags': tags});

  Future<void> deleteMemory(int id) => call('memory.delete', {'id': id});

  // ---------- MCP ----------

  Future<dynamic> mcpList() => call('mcp.list', {});
  Future<dynamic> mcpReload(List<dynamic> servers) =>
      call('mcp.reload', {'servers': servers});

  Future<dynamic> reloadMcpServers(Iterable<McpServerConfig> servers) =>
      mcpReload(servers.map((server) => server.toJson()).toList());

  /// Typed legacy catalog returned by `mcp.list` (server IDs plus discovered
  /// direct-call tools). Kept alongside [mcpList] for old settings screens.
  Future<McpListResult> mcpListTyped() async {
    final result = await mcpList();
    if (result is! Map) {
      return const McpListResult(servers: [], tools: []);
    }
    return McpListResult.fromJson(result.cast<String, dynamic>());
  }

  /// Full Rust/Electron-compatible MCP settings snapshot.
  Future<McpStateSnapshot> getMcpState() async {
    final result = await call('mcp.status', {});
    return McpStateSnapshot.fromJson((result as Map).cast<String, dynamic>());
  }

  /// Rediscover one server, or every enabled server when [serverId] is null.
  /// A server ID returns [McpServerSnapshot]; an omitted ID returns a state
  /// snapshot, matching Electron's RustHarnessClient contract.
  Future<dynamic> refreshMcpServer({String? serverId}) async {
    final result = await call('mcp.refresh', {'serverId': ?serverId});
    if (result is! Map) return result;
    final map = result.cast<String, dynamic>();
    if (map.containsKey('servers')) return McpStateSnapshot.fromJson(map);
    return McpServerSnapshot.fromJson(map);
  }

  Future<McpServerSnapshot> disconnectMcpServer(String serverId) async {
    final result = await call('mcp.disconnect', {'serverId': serverId});
    return McpServerSnapshot.fromJson((result as Map).cast<String, dynamic>());
  }

  Future<dynamic> callMcp(
    String server,
    String tool, {
    Map<String, dynamic> arguments = const {},
  }) => call('mcp.call', {
    'server': server,
    'tool': tool,
    'arguments': arguments,
  });

  // ---------- 设置 ----------

  Future<dynamic> getSetting(String key) => call('settings.get', {'key': key});
  Future<void> setSetting(String key, dynamic value) =>
      call('settings.set', {'key': key, 'value': value});

  Future<List<ToolDescriptor>> listTools() async {
    final result = await call('tool.list', {});
    final list = result?['tools'] as List? ?? [];
    return list
        .map((e) => ToolDescriptor.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
  }

  void dispose() {
    _disposed = true;
    _reconnectTimer?.cancel();
    _failAllPending(Exception('harness client disposed'));
    _channel?.sink.close();
    _channel = null;
  }
}
