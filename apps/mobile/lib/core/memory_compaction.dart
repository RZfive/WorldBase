import 'dart:async';
import 'dart:convert';

import 'harness_client.dart';

/// AI 长期记忆整理：纯函数（分批 / 序列化 / 解析净化 / 合并）与编排逻辑。
/// 移植自桌面端 main-process/ai/memory-compaction*.ts，分批大小、净化规则
/// 与提示词保持一致。扫描与应用走 harness RPC（Rust 是唯一记忆属主），
/// AI 计划构建通过一次性会话完成（禁工具、低温、关思考、无记忆召回）。

const int memoryCompactionChunkSize = 40;
const Duration memoryCompactionChunkTimeout = Duration(seconds: 180);

/// 白名单哨兵：不匹配任何真实工具，使该次运行没有任何可用工具。
const String _noToolsSentinel = '__memory_compaction_no_tools__';

const String _compactionSystemPrompt = '''
你是 WorldBase 的长期记忆整理器。你的任务是压缩整理 Agent、项目和频道记忆。
只允许基于输入 JSON 中的记忆做判断，不得编造新事实，不得引用输入外的 ID。
删除标准：空壳内容、Markdown 标题/表格碎片、无复用价值碎片。不要因为知识与软件工程无关、或当前任务用不上而删除它；低频或看起来无关的内容可能对用户长期重要。
用户个人事实（user scope）不会出现在输入中，也不得试图删除、合并或改写它们。
合并标准：同一 scope 且同一 type 下语义重复或高度近似的记忆。跨 scope 或跨 type 不要合并。
置顶 pinned=true 的记忆受保护：不得放入 deleteIds，也不要合并或改写它们。
updates 用来改写仍有价值但表达松散的记忆，让 title/summary 更短、更准确，不得改变原意。
输出严格 JSON，不要 Markdown，不要解释。格式：
{"deleteIds":["id"],"mergeGroups":[{"ids":["id1","id2"],"targetId":"id1","title":"短标题","summary":"合并后的完整事实","details":"可选详情","tags":["tag"]}],"updates":[{"id":"id","title":"短标题","summary":"整理后的事实","details":"可选详情","tags":["tag"],"importance":0.8,"confidence":0.8}]}
''';

// ---------- 纯函数（对齐 memory-compaction-plan.ts，保持可单测） ----------

String? extractJsonObjectCandidate(String value) {
  final trimmed = value.trim();
  if (trimmed.isEmpty) return null;
  final fenced = RegExp(
    r'```(?:json)?\s*([\s\S]*?)```',
    caseSensitive: false,
  ).firstMatch(trimmed);
  final fencedBody = fenced?.group(1)?.trim();
  final candidate = fencedBody != null && fencedBody.isNotEmpty
      ? fencedBody
      : trimmed;
  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    return candidate;
  }
  final start = candidate.indexOf('{');
  final end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return candidate.substring(start, end + 1);
  }
  return null;
}

List<String> sanitizeMemoryPlanIdList(Object? value, Set<String> allowedIds) {
  if (value is! List) return const [];
  final result = <String>[];
  final seen = <String>{};
  for (final item in value) {
    final id = item is String ? item.trim() : '';
    if (id.isEmpty || !allowedIds.contains(id) || seen.contains(id)) continue;
    seen.add(id);
    result.add(id);
  }
  return result;
}

String? sanitizeMemoryPlanText(Object? value, int maxChars) {
  if (value is! String) return null;
  final normalized = value.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (normalized.isEmpty) return null;
  return normalized.length > maxChars
      ? normalized.substring(0, maxChars)
      : normalized;
}

List<String>? sanitizeMemoryPlanTags(Object? value) {
  if (value is! List) return null;
  final result = <String>[];
  final seen = <String>{};
  for (final item in value) {
    final tag = item is String ? item.trim() : '';
    if (tag.isEmpty || seen.contains(tag)) continue;
    seen.add(tag);
    result.add(tag.length > 40 ? tag.substring(0, 40) : tag);
    if (result.length >= 12) break;
  }
  return result;
}

double? sanitizeMemoryPlanNumber(Object? value) {
  if (value is! num) return null;
  return value.clamp(0.0, 1.0).toDouble();
}

/// 模型输出的一行预览，用于错误信息。
String modelOutputPreview(String rawText) {
  final normalized = rawText.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (normalized.isEmpty) return '（模型返回为空）';
  return normalized.length > 160
      ? '${normalized.substring(0, 160)}…'
      : normalized;
}

/// 解析模型输出为压缩计划。只接受本批输入中出现过的 ID；推理模型的
/// `<think>` 段与 Markdown 围栏都会被剥掉（对齐桌面端解析规则）。
Map<String, dynamic> parseMemoryCompactionPlan(
  String rawText,
  List<WorkspaceMemoryEntry> chunkEntries,
) {
  final allowedIds = chunkEntries.map((entry) => entry.id).toSet();
  final withoutThinking = rawText
      .replaceAll(
        RegExp(r'<think>[\s\S]*?</think>', caseSensitive: false),
        '',
      )
      .trim();
  final candidate = extractJsonObjectCandidate(withoutThinking);
  if (candidate == null) {
    throw FormatException(
      '记忆整理返回了无法解析的内容：${modelOutputPreview(rawText)}',
    );
  }
  final Object? decoded;
  try {
    decoded = jsonDecode(candidate);
  } on FormatException {
    throw FormatException(
      '记忆整理返回了无法解析的内容：${modelOutputPreview(rawText)}',
    );
  }
  if (decoded is! Map) {
    throw FormatException(
      '记忆整理返回了无法解析的内容：${modelOutputPreview(rawText)}',
    );
  }
  final parsed = decoded.cast<String, dynamic>();

  final mergeGroups = <Map<String, dynamic>>[];
  for (final rawGroup in parsed['mergeGroups'] as List? ?? const []) {
    if (rawGroup is! Map) continue;
    final group = rawGroup.cast<String, dynamic>();
    final ids = sanitizeMemoryPlanIdList(group['ids'], allowedIds);
    if (ids.length < 2) continue;
    final rawTarget = group['targetId'];
    final targetId =
        rawTarget is String && allowedIds.contains(rawTarget.trim())
        ? rawTarget.trim()
        : null;
    mergeGroups.add({
      'ids': ids,
      'targetId': ?targetId,
      'title': ?sanitizeMemoryPlanText(group['title'], 80),
      'summary': ?sanitizeMemoryPlanText(group['summary'], 420),
      'details': ?sanitizeMemoryPlanText(group['details'], 1200),
      'tags': ?sanitizeMemoryPlanTags(group['tags']),
    });
  }

  final updates = <Map<String, dynamic>>[];
  for (final rawUpdate in parsed['updates'] as List? ?? const []) {
    if (rawUpdate is! Map) continue;
    final update = rawUpdate.cast<String, dynamic>();
    final id = update['id'] is String ? (update['id'] as String).trim() : '';
    if (id.isEmpty || !allowedIds.contains(id)) continue;
    updates.add({
      'id': id,
      'title': ?sanitizeMemoryPlanText(update['title'], 80),
      'summary': ?sanitizeMemoryPlanText(update['summary'], 420),
      'details': ?sanitizeMemoryPlanText(update['details'], 1200),
      'tags': ?sanitizeMemoryPlanTags(update['tags']),
      'importance': ?sanitizeMemoryPlanNumber(update['importance']),
      'confidence': ?sanitizeMemoryPlanNumber(update['confidence']),
    });
  }

  return {
    'deleteIds': sanitizeMemoryPlanIdList(parsed['deleteIds'], allowedIds),
    'mergeGroups': mergeGroups,
    'updates': updates,
  };
}

Map<String, dynamic> mergeMemoryCompactionPlans(
  List<Map<String, dynamic>> plans,
) {
  final deleteIds = <String>{};
  final mergeGroups = <Map<String, dynamic>>[];
  final updates = <Map<String, dynamic>>[];
  for (final plan in plans) {
    deleteIds.addAll(
      ((plan['deleteIds'] as List?) ?? const []).whereType<String>(),
    );
    mergeGroups.addAll(
      ((plan['mergeGroups'] as List?) ?? const [])
          .whereType<Map>()
          .map((group) => group.cast<String, dynamic>()),
    );
    updates.addAll(
      ((plan['updates'] as List?) ?? const [])
          .whereType<Map>()
          .map((update) => update.cast<String, dynamic>()),
    );
  }
  return {
    'deleteIds': deleteIds.toList(),
    'mergeGroups': mergeGroups,
    'updates': updates,
  };
}

String _truncate(String value, int maxChars) => value.length > maxChars
    ? value.substring(0, maxChars)
    : value;

Map<String, dynamic> serializeMemoryEntryForAi(WorkspaceMemoryEntry entry) => {
  'id': entry.id,
  'scope': '${entry.scopeType}/${entry.scopeId}',
  'type': entry.memoryType,
  'pinned': entry.pinned,
  'title': _truncate(entry.title, 90),
  'summary': _truncate(entry.summary, 240),
  if (entry.details != null && entry.details!.trim().isNotEmpty)
    'details': _truncate(entry.details!, 320),
  'tags': entry.tags.take(10).toList(),
  'importance': double.parse(entry.importance.toStringAsFixed(2)),
  'confidence': double.parse(entry.confidence.toStringAsFixed(2)),
  if (entry.lastUsedAt != null && entry.lastUsedAt!.isNotEmpty)
    'lastUsedAt': entry.lastUsedAt,
  if (entry.updatedAt.isNotEmpty) 'updatedAt': entry.updatedAt,
};

/// 同 scope + 同 type 的记忆聚成一批；单批超过 [memoryCompactionChunkSize]
/// 先切（对齐桌面端分批策略，让合并判断只看同组记忆）。
List<List<WorkspaceMemoryEntry>> chunkMemoryEntriesForAiCompaction(
  List<WorkspaceMemoryEntry> entries,
) {
  final sorted = [...entries]..sort((left, right) {
    final leftGroup =
        '${left.scopeType}/${left.scopeId}/${left.memoryType}';
    final rightGroup =
        '${right.scopeType}/${right.scopeId}/${right.memoryType}';
    if (leftGroup != rightGroup) return leftGroup.compareTo(rightGroup);
    return '${left.title} ${left.summary}'.compareTo(
      '${right.title} ${right.summary}',
    );
  });
  final chunks = <List<WorkspaceMemoryEntry>>[];
  var current = <WorkspaceMemoryEntry>[];
  var currentGroup = '';
  for (final entry in sorted) {
    final group = '${entry.scopeType}/${entry.scopeId}/${entry.memoryType}';
    if (current.isNotEmpty &&
        (current.length >= memoryCompactionChunkSize ||
            group != currentGroup)) {
      chunks.add(current);
      current = <WorkspaceMemoryEntry>[];
    }
    currentGroup = group;
    current.add(entry);
  }
  if (current.isNotEmpty) chunks.add(current);
  return chunks;
}

// ---------- 编排 ----------

typedef MemoryCompactionProgress =
    void Function({
      required String stage,
      String? detail,
      required int totalChunks,
      required int completedChunks,
    });

/// 一次性模型补全：临时会话 + chat.send（禁工具、关思考、低温、无记忆召回），
/// done 后取最终文本并删除会话。桌面端等价物是 engine.chat。
Future<String> completeOnce(
  HarnessClient client, {
  required String systemPrompt,
  required String userPrompt,
  String? providerId,
  String? modelId,
}) async {
  final conversation = await client.createConversation('记忆整理');
  StreamSubscription<EventFrame>? sub;
  try {
    final streamId = await client.sendChat(
      conversation.id,
      userPrompt,
      providerId: providerId,
      model: modelId,
      enableThinking: false,
      reasoningEffort: 'low',
      temperature: 0.1,
      systemPromptSections: [systemPrompt],
      // 白名单哨兵：本批请求不允许任何工具调用。
      allowedToolNames: const [_noToolsSentinel],
      memoryScopes: const [],
    );
    final completer = Completer<String>();
    final buffer = StringBuffer();
    var finalText = '';
    sub = client.subscribeStream(streamId).listen((frame) {
      switch (frame.kind) {
        case 'delta':
          buffer.write(frame.data['text'] as String? ?? '');
        case 'assistant_message':
          finalText = frame.data['content'] as String? ?? '';
        case 'done':
          if (!completer.isCompleted) {
            completer.complete(
              finalText.isNotEmpty ? finalText : buffer.toString(),
            );
          }
        case 'error':
          if (!completer.isCompleted) {
            completer.completeError(
              frame.data['message']?.toString() ?? '记忆整理请求失败',
            );
          }
      }
    }, onError: (Object error) {
      if (!completer.isCompleted) completer.completeError(error);
    }, onDone: () {
      if (!completer.isCompleted) {
        completer.complete(
          finalText.isNotEmpty ? finalText : buffer.toString(),
        );
      }
    });
    return await completer.future.timeout(memoryCompactionChunkTimeout);
  } finally {
    await sub?.cancel();
    try {
      await client.deleteConversation(conversation.id);
    } catch (_) {}
  }
}

Future<Map<String, dynamic>> _requestPlanChunk(
  HarnessClient client,
  List<WorkspaceMemoryEntry> chunkEntries, {
  String? providerId,
  String? modelId,
}) async {
  final userPrompt = [
    '请整理这一批记忆。',
    const JsonEncoder.withIndent(
      '',
    ).convert(chunkEntries.map(serializeMemoryEntryForAi).toList()),
  ].join('\n\n');
  final text = await completeOnce(
    client,
    systemPrompt: _compactionSystemPrompt,
    userPrompt: userPrompt,
    providerId: providerId,
    modelId: modelId,
  );
  if (text.isEmpty) {
    throw const FormatException('记忆整理：模型返回为空');
  }
  return parseMemoryCompactionPlan(text, chunkEntries);
}

/// 单批失败重试一次；个别批次的坏响应不能拖垮整轮整理（对齐桌面端）。
Future<Map<String, dynamic>> _requestPlanChunkWithRetry(
  HarnessClient client,
  List<WorkspaceMemoryEntry> chunkEntries, {
  String? providerId,
  String? modelId,
}) async {
  try {
    return await _requestPlanChunk(
      client,
      chunkEntries,
      providerId: providerId,
      modelId: modelId,
    );
  } catch (_) {
    return await _requestPlanChunk(
      client,
      chunkEntries,
      providerId: providerId,
      modelId: modelId,
    );
  }
}

/// 运行一次完整整理：扫描 → 分批 AI 生成计划 → 合并 → 应用。
/// 返回 Rust 的 MemoryCompactionResult（scanned/deleted/removedUseless/
/// merged/updated/retained/groups）。user 作用域的个人事实不进入 AI 输入。
Future<Map<String, dynamic>> runMemoryCompaction(
  HarnessClient client, {
  String? providerId,
  String? modelId,
  MemoryCompactionProgress? onProgress,
}) async {
  void report(String stage, String detail, int totalChunks, int completed) {
    onProgress?.call(
      stage: stage,
      detail: detail,
      totalChunks: totalChunks,
      completedChunks: completed,
    );
  }

  report('正在扫描', '读取全部记忆…', 0, 0);
  final entries = await client.listWorkspaceMemories(limit: 50000);
  final planEntries = entries.where((entry) => entry.scopeType != 'user').toList();
  final chunks = chunkMemoryEntriesForAiCompaction(planEntries);
  report(
    planEntries.isEmpty ? '没有可整理的记忆' : '准备分析',
    planEntries.isEmpty ? '' : '共 ${entries.length} 条，分 ${chunks.length} 批',
    chunks.length,
    0,
  );

  final plans = <Map<String, dynamic>>[];
  for (var index = 0; index < chunks.length; index++) {
    report('分析中', '第 ${index + 1}/${chunks.length} 批', chunks.length, index);
    plans.add(
      await _requestPlanChunkWithRetry(
        client,
        chunks[index],
        providerId: providerId,
        modelId: modelId,
      ),
    );
    report(
      '分析中',
      '第 ${index + 1}/${chunks.length} 批完成',
      chunks.length,
      index + 1,
    );
  }

  report('应用计划', '写入整理结果…', chunks.length, chunks.length);
  return client.compactWorkspaceMemories(mergeMemoryCompactionPlans(plans));
}
