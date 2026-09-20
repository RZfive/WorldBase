/// 每日推荐(与桌面端 `daily-suggestion-types.ts` 对齐的移动端实现)。
///
/// 对话空态展示三类可点击卡片:
///  - `explore`:内置能力探索池,按 ISO 周轮换主题,始终可用。
///  - `daily`:开启后每天由模型生成一次,内容严格限定在用户勾选的类型内。
///  - `knowledge`:知识探索。每天一条来自内置题库的「随机知识」(不需要模型),
///    加上可选的模型来源:跨学科 / 工作领域 / 我想学的。
///
/// 本文件只放纯数据与纯函数(类型、静态池、偏好归一化、模型输出解析),
/// 不依赖 Flutter,便于单元测试;状态与持久化见 `daily_suggestions_provider.dart`。
library;

import 'dart:convert';

import 'knowledge_seeds.dart';

export 'knowledge_seeds.dart';

/// 知识来源(与桌面端 key 一致)。`random` 走本地题库,其余三种需要模型。
enum KnowledgeSource {
  random('random', '随机', '每天从内置题库抽一条有趣的知识,不需要模型。'),
  crossDiscipline('cross-discipline', '跨学科', '来自你工作之外的其他领域的一个概念、现象或故事。'),
  workDomain('work-domain', '工作领域', '你所在领域里大概率没深究过的一个原理或冷知识。'),
  interest('interest', '我想学的', '围绕你填写的兴趣主题,给一个能引出追问的切入点。');

  const KnowledgeSource(this.key, this.label, this.description);

  final String key;
  final String label;
  final String description;

  bool get needsModel => this != KnowledgeSource.random;

  static KnowledgeSource? fromKey(Object? value) {
    if (value is! String) return null;
    for (final source in values) {
      if (source.key == value) return source;
    }
    return null;
  }
}

/// 每天最多「换一个」随机知识的次数,与模型批次的「换一批」限额相互独立。
const int knowledgeShuffleLimit = 5;
const int knowledgeMaxInterests = 10;
const int knowledgeInterestMaxLength = 30;
const int knowledgeProfessionMaxLength = 60;

/// 知识探索偏好。默认只开随机来源:它不依赖模型,新装用户也能看到。
class KnowledgePreferences {
  const KnowledgePreferences({
    this.enabled = true,
    this.sources = const [KnowledgeSource.random],
    this.interests = const [],
    this.profession = '',
    this.countPerSource = 1,
  });

  final bool enabled;

  /// 永不为空;空列表回落为 `[random]`。
  final List<KnowledgeSource> sources;

  /// 我想学的主题,≤ 10 条、每条 ≤ 30 字。
  final List<String> interests;

  /// 职业 / 领域描述,≤ 60 字,可空。
  final String profession;

  /// 每个模型来源的条数(1 或 2);随机来源固定 1 条。
  final int countPerSource;

  /// 是否有任一需要模型的来源被勾选。
  bool get needsModel => enabled && sources.any((source) => source.needsModel);

  KnowledgePreferences copyWith({
    bool? enabled,
    List<KnowledgeSource>? sources,
    List<String>? interests,
    String? profession,
    int? countPerSource,
  }) => KnowledgePreferences(
    enabled: enabled ?? this.enabled,
    sources: sources ?? this.sources,
    interests: interests ?? this.interests,
    profession: profession ?? this.profession,
    countPerSource: countPerSource ?? this.countPerSource,
  );

  Map<String, dynamic> toJson() => {
    'enabled': enabled,
    'sources': sources.map((source) => source.key).toList(),
    'interests': interests,
    'profession': profession,
    'countPerSource': countPerSource,
  };

  /// 归一化:来源白名单、兴趣去重去空白并截断、职业截断、条数只允许 1/2。
  static KnowledgePreferences fromJson(Object? value) {
    final raw = value is Map ? value.cast<String, dynamic>() : const <String, dynamic>{};
    final rawSources = raw['sources'];
    final sources = <KnowledgeSource>[];
    if (rawSources is List) {
      for (final source in KnowledgeSource.values) {
        if (rawSources.contains(source.key)) sources.add(source);
      }
    } else {
      sources.add(KnowledgeSource.random);
    }
    final interests = <String>[];
    final seen = <String>{};
    final rawInterests = raw['interests'];
    if (rawInterests is List) {
      for (final item in rawInterests) {
        if (item is! String) continue;
        final next = _clipPlain(item, knowledgeInterestMaxLength);
        final key = next.toLowerCase();
        if (next.isEmpty || seen.contains(key)) continue;
        seen.add(key);
        interests.add(next);
        if (interests.length >= knowledgeMaxInterests) break;
      }
    }
    final rawProfession = raw['profession'];
    return KnowledgePreferences(
      enabled: raw['enabled'] is bool ? raw['enabled'] as bool : true,
      sources: sources.isEmpty ? const [KnowledgeSource.random] : List.unmodifiable(sources),
      interests: List.unmodifiable(interests),
      profession: rawProfession is String ? _clipPlain(rawProfession, knowledgeProfessionMaxLength) : '',
      countPerSource: raw['countPerSource'] == 2 ? 2 : 1,
    );
  }
}

/// 去首尾空白、压缩连续空白并硬截断(不加省略号,用于用户输入)。
String _clipPlain(String value, int max) {
  final trimmed = value.trim().replaceAll(RegExp(r'\s+'), ' ');
  return trimmed.length <= max ? trimmed : trimmed.substring(0, max);
}

/// 知识卡片的来源信息。
class KnowledgeMeta {
  const KnowledgeMeta({required this.source, this.discipline, this.seedId});

  final KnowledgeSource source;

  /// 随机来源为题库学科 key;模型来源为模型给出的学科标签(≤ 20 字)。
  final String? discipline;
  final String? seedId;

  /// 用于展示的学科名(key 翻成中文,模型文本原样)。
  String get disciplineLabel => discipline == null ? '' : knowledgeDisciplineLabel(discipline!);

  Map<String, dynamic> toJson() => {
    'source': source.key,
    'discipline': discipline,
    'seedId': seedId,
  };

  static KnowledgeMeta? fromJson(Object? value) {
    if (value is! Map) return null;
    final source = KnowledgeSource.fromKey(value['source']);
    if (source == null) return null;
    String? clean(Object? raw) {
      if (raw is! String) return null;
      final trimmed = raw.trim();
      return trimmed.isEmpty ? null : trimmed;
    }

    return KnowledgeMeta(source: source, discipline: clean(value['discipline']), seedId: clean(value['seedId']));
  }
}

/// 推荐类型(与桌面端 key 一致)。
enum SuggestionType {
  newIdea('new-idea'),
  improveProject('improve-project'),
  learnQuestion('learn-question'),
  automation('automation'),
  featureTip('feature-tip'),
  dataInsight('data-insight');

  const SuggestionType(this.key);

  final String key;

  static SuggestionType? fromKey(Object? value) {
    if (value is! String) return null;
    for (final type in values) {
      if (type.key == value) return type;
    }
    return null;
  }
}

/// 每种推荐类型的展示文案(标签 / 说明 / 用到的数据)。
class SuggestionTypeCopy {
  const SuggestionTypeCopy(this.label, this.description, this.uses);

  final String label;
  final String description;
  final String uses;
}

const Map<SuggestionType, SuggestionTypeCopy> suggestionTypeCopy = {
  SuggestionType.newIdea: SuggestionTypeCopy(
    '新项目想法',
    '基于你常聊的领域,提出可以今天开始的新项目或轻应用。',
    '近期会话主题',
  ),
  SuggestionType.improveProject: SuggestionTypeCopy(
    '现有项目改进',
    '为你的某个轻应用或近期工作提出具体改进点。',
    '轻应用列表、近期会话标题',
  ),
  SuggestionType.learnQuestion: SuggestionTypeCopy(
    '思考题',
    '围绕你最近的工作提出一个值得深入思考的问题。',
    '近期会话标题(脱敏)',
  ),
  SuggestionType.automation: SuggestionTypeCopy(
    '自动化建议',
    '把重复性工作交给定时任务或 Agent 群组。',
    '定时任务与群组使用情况',
  ),
  SuggestionType.featureTip: SuggestionTypeCopy(
    '产品能力提示',
    '带你试用一个还没用过的能力,如深度思考、文档解析、MCP。',
    '技能、MCP、文档使用记录',
  ),
  SuggestionType.dataInsight: SuggestionTypeCopy(
    '数据分析角度',
    '为你导入的文档或表格提出一个值得回答的问题。',
    '已导入文档列表',
  ),
};

/// 生成时机。
enum DailySuggestionTriggerKind { firstOpen, time }

class DailySuggestionTrigger {
  const DailySuggestionTrigger.firstOpen()
    : kind = DailySuggestionTriggerKind.firstOpen,
      timeOfDay = '09:00';

  const DailySuggestionTrigger.time(this.timeOfDay)
    : kind = DailySuggestionTriggerKind.time;

  final DailySuggestionTriggerKind kind;

  /// `HH:mm`,仅 [DailySuggestionTriggerKind.time] 有意义。
  final String timeOfDay;

  Map<String, dynamic> toJson() => {
    'kind': kind == DailySuggestionTriggerKind.time ? 'time' : 'first-open',
    if (kind == DailySuggestionTriggerKind.time) 'timeOfDay': timeOfDay,
  };
}

/// 上下文范围:控制哪些信息会发送给模型。
class DailySuggestionContextScope {
  const DailySuggestionContextScope({
    this.lightApps = true,
    this.conversationTitles = true,
    this.documents = false,
  });

  /// 轻应用名称列表。
  final bool lightApps;

  /// 最近 20 条会话的标题与更新时间,不含消息正文。
  final bool conversationTitles;

  /// 已导入文档的文件名与类型。默认关闭。
  final bool documents;

  DailySuggestionContextScope copyWith({
    bool? lightApps,
    bool? conversationTitles,
    bool? documents,
  }) => DailySuggestionContextScope(
    lightApps: lightApps ?? this.lightApps,
    conversationTitles: conversationTitles ?? this.conversationTitles,
    documents: documents ?? this.documents,
  );

  Map<String, dynamic> toJson() => {
    'lightApps': lightApps,
    'conversationTitles': conversationTitles,
    'documents': documents,
  };
}

/// 每日推荐偏好。默认关闭,开启后才会消耗模型调用。
class DailySuggestionPreferences {
  const DailySuggestionPreferences({
    this.enabled = false,
    this.types = defaultTypes,
    this.countPerType = 3,
    this.trigger = const DailySuggestionTrigger.firstOpen(),
    this.providerId,
    this.modelId,
    this.context = const DailySuggestionContextScope(),
    this.knowledge = const KnowledgePreferences(),
  });

  static const List<SuggestionType> defaultTypes = [
    SuggestionType.newIdea,
    SuggestionType.improveProject,
    SuggestionType.featureTip,
  ];
  static const List<int> countOptions = [2, 3, 5];

  final bool enabled;
  final List<SuggestionType> types;
  final int countPerType;
  final DailySuggestionTrigger trigger;
  final String? providerId;
  final String? modelId;
  final DailySuggestionContextScope context;
  final KnowledgePreferences knowledge;

  /// 任一需要模型的组(每日推荐,或知识探索的模型来源)处于开启状态。
  bool get needsModel => enabled || knowledge.needsModel;

  DailySuggestionPreferences copyWith({
    bool? enabled,
    List<SuggestionType>? types,
    int? countPerType,
    DailySuggestionTrigger? trigger,
    Object? providerId = _unset,
    Object? modelId = _unset,
    DailySuggestionContextScope? context,
    KnowledgePreferences? knowledge,
  }) => DailySuggestionPreferences(
    enabled: enabled ?? this.enabled,
    types: types ?? this.types,
    countPerType: countPerType ?? this.countPerType,
    trigger: trigger ?? this.trigger,
    providerId: identical(providerId, _unset)
        ? this.providerId
        : providerId as String?,
    modelId: identical(modelId, _unset) ? this.modelId : modelId as String?,
    context: context ?? this.context,
    knowledge: knowledge ?? this.knowledge,
  );

  Map<String, dynamic> toJson() => {
    'enabled': enabled,
    'types': types.map((type) => type.key).toList(),
    'countPerType': countPerType,
    'trigger': trigger.toJson(),
    'providerId': providerId,
    'modelId': modelId,
    'context': context.toJson(),
    'knowledge': knowledge.toJson(),
  };

  /// 将任意持久化值归一化为合法偏好;空类型列表回落到默认选择,
  /// 保证一次生成永远有目标类型。
  static DailySuggestionPreferences fromJson(Object? value) {
    final raw = value is Map ? value.cast<String, dynamic>() : const <String, dynamic>{};
    final rawTypes = raw['types'];
    final types = <SuggestionType>[];
    if (rawTypes is List) {
      for (final item in rawTypes) {
        final type = SuggestionType.fromKey(item);
        if (type != null && !types.contains(type)) types.add(type);
      }
    }
    final rawCount = raw['countPerType'];
    final countPerType = rawCount is num && countOptions.contains(rawCount.toInt())
        ? rawCount.toInt()
        : 3;
    var trigger = const DailySuggestionTrigger.firstOpen();
    final rawTrigger = raw['trigger'];
    if (rawTrigger is Map && rawTrigger['kind'] == 'time') {
      trigger = DailySuggestionTrigger.time(
        normalizeTimeOfDay(rawTrigger['timeOfDay']) ?? '09:00',
      );
    }
    final rawContext = raw['context'] is Map
        ? (raw['context'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    String? cleanId(Object? value) {
      if (value is! String) return null;
      final trimmed = value.trim();
      return trimmed.isEmpty ? null : trimmed;
    }

    return DailySuggestionPreferences(
      enabled: raw['enabled'] == true,
      types: types.isEmpty ? defaultTypes : List.unmodifiable(types),
      countPerType: countPerType,
      trigger: trigger,
      providerId: cleanId(raw['providerId']),
      modelId: cleanId(raw['modelId']),
      context: DailySuggestionContextScope(
        lightApps: rawContext['lightApps'] is bool
            ? rawContext['lightApps'] as bool
            : true,
        conversationTitles: rawContext['conversationTitles'] is bool
            ? rawContext['conversationTitles'] as bool
            : true,
        documents: rawContext['documents'] == true,
      ),
      knowledge: KnowledgePreferences.fromJson(raw['knowledge']),
    );
  }
}

const Object _unset = Object();

/// 校验并规范化 `HH:mm`。
String? normalizeTimeOfDay(Object? value) {
  if (value is! String) return null;
  final match = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(value.trim());
  if (match == null) return null;
  final hours = int.parse(match.group(1)!);
  final minutes = int.parse(match.group(2)!);
  if (hours > 23 || minutes > 59) return null;
  return '${hours.toString().padLeft(2, '0')}:${minutes.toString().padLeft(2, '0')}';
}

/// 点击卡片后要切换的运行场景(移动端只有深度思考可切换)。
class SuggestionScene {
  const SuggestionScene({this.enableThinking = false});

  final bool enableThinking;

  bool get isEmpty => !enableThinking;

  Map<String, dynamic> toJson() => {'enableThinking': enableThinking};

  static SuggestionScene? fromJson(Object? value) {
    if (value is! Map) return null;
    final scene = SuggestionScene(enableThinking: value['enableThinking'] == true);
    return scene.isEmpty ? null : scene;
  }
}

/// 一张建议卡片。
class WorkSuggestion {
  const WorkSuggestion({
    required this.id,
    required this.layer,
    required this.type,
    required this.title,
    required this.prompt,
    required this.source,
    this.description = '',
    this.scene,
    this.featureTag,
    this.knowledge,
    this.fresh = false,
  });

  final String id;

  /// `daily`、`explore` 或 `knowledge`。
  final String layer;

  /// 类型 key;能力探索卡为 `weekly-theme`,知识卡固定为 `knowledge`。
  final String type;
  final String title;
  final String description;
  final String prompt;
  final SuggestionScene? scene;

  /// `llm` 或 `static`。
  final String source;
  final String? featureTag;

  /// 知识卡片的来源信息;其他层为 null。
  final KnowledgeMeta? knowledge;

  /// 首次展示前为 true,用于「新」角标。
  final bool fresh;

  bool get isDaily => layer == 'daily';
  bool get isKnowledge => layer == 'knowledge';
  bool get isRandomKnowledge => isKnowledge && knowledge?.source == KnowledgeSource.random;

  WorkSuggestion copyWith({bool? fresh}) => WorkSuggestion(
    id: id,
    layer: layer,
    type: type,
    title: title,
    description: description,
    prompt: prompt,
    scene: scene,
    source: source,
    featureTag: featureTag,
    knowledge: knowledge,
    fresh: fresh ?? this.fresh,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'layer': layer,
    'type': type,
    'title': title,
    'description': description,
    'prompt': prompt,
    'scene': scene?.toJson(),
    'source': source,
    'featureTag': featureTag,
    'knowledge': knowledge?.toJson(),
    'fresh': fresh,
  };

  static WorkSuggestion? fromJson(Object? value) {
    if (value is! Map) return null;
    final raw = value.cast<String, dynamic>();
    final id = raw['id'];
    final title = raw['title'];
    final prompt = raw['prompt'];
    final layer = raw['layer'];
    final source = raw['source'];
    if (id is! String || id.isEmpty) return null;
    if (title is! String || title.isEmpty) return null;
    if (prompt is! String || prompt.isEmpty) return null;
    if (layer != 'daily' && layer != 'explore' && layer != 'knowledge') return null;
    if (source != 'llm' && source != 'static') return null;
    final knowledge = KnowledgeMeta.fromJson(raw['knowledge']);
    if (layer == 'knowledge' && knowledge == null) return null;
    return WorkSuggestion(
      id: id,
      layer: layer as String,
      type: raw['type'] is String ? raw['type'] as String : 'weekly-theme',
      title: title,
      description: raw['description'] is String ? raw['description'] as String : '',
      prompt: prompt,
      scene: SuggestionScene.fromJson(raw['scene']),
      source: source as String,
      featureTag: raw['featureTag'] is String ? raw['featureTag'] as String : null,
      knowledge: knowledge,
      fresh: raw['fresh'] == true,
    );
  }
}

/// 随机知识卡的 id 前缀;完整形式 `knowledge:<date>:<seedId>`,按日期区分,
/// 这样「不感兴趣」只隐藏今天这张,而不是把题目永久打入冷宫。
const String knowledgeStaticIdPrefix = 'knowledge:';

WorkSuggestion buildKnowledgeSeedSuggestion(KnowledgeSeed seed, String date) => WorkSuggestion(
  id: '$knowledgeStaticIdPrefix$date:${seed.id}',
  layer: 'knowledge',
  type: 'knowledge',
  title: seed.title,
  description: seed.description,
  prompt: seed.prompt,
  source: 'static',
  knowledge: KnowledgeMeta(
    source: KnowledgeSource.random,
    discipline: seed.discipline.key,
    seedId: seed.id,
  ),
);

/// 一天一批的生成结果。
class DailySuggestionBatch {
  const DailySuggestionBatch({
    required this.date,
    required this.status,
    required this.items,
    required this.generatedAt,
    this.error,
    this.manualRefreshCount = 0,
  });

  /// 本地日历日 `yyyy-MM-dd`。
  final String date;

  /// `ok` / `partial` / `failed`。
  final String status;
  final List<WorkSuggestion> items;
  final String generatedAt;
  final String? error;
  final int manualRefreshCount;

  DailySuggestionBatch copyWith({
    List<WorkSuggestion>? items,
    String? status,
    String? error,
    int? manualRefreshCount,
  }) => DailySuggestionBatch(
    date: date,
    status: status ?? this.status,
    items: items ?? this.items,
    generatedAt: generatedAt,
    error: error ?? this.error,
    manualRefreshCount: manualRefreshCount ?? this.manualRefreshCount,
  );

  Map<String, dynamic> toJson() => {
    'date': date,
    'status': status,
    'items': items.map((item) => item.toJson()).toList(),
    'generatedAt': generatedAt,
    'error': error,
    'manualRefreshCount': manualRefreshCount,
  };

  static DailySuggestionBatch? fromJson(Object? value) {
    if (value is! Map) return null;
    final raw = value.cast<String, dynamic>();
    final date = raw['date'];
    final status = raw['status'];
    if (date is! String || !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(date)) return null;
    if (status != 'ok' && status != 'partial' && status != 'failed') return null;
    final items = (raw['items'] is List ? raw['items'] as List : const [])
        .map(WorkSuggestion.fromJson)
        .whereType<WorkSuggestion>()
        .toList();
    final count = raw['manualRefreshCount'];
    return DailySuggestionBatch(
      date: date,
      status: status as String,
      items: items,
      generatedAt: raw['generatedAt'] is String ? raw['generatedAt'] as String : '',
      error: raw['error'] is String ? raw['error'] as String : null,
      manualRefreshCount: count is num ? count.toInt().clamp(0, 1 << 20).toInt() : 0,
    );
  }
}

/// 每天最多手动「换一批」次数;当天第一次生成不计入。
const int dailySuggestionManualRefreshLimit = 3;

/// 生成失败时,最多沿用最近几天内的成功批次。
const int dailySuggestionStaleBatchMaxAgeDays = 3;

/// 本地日历日 `yyyy-MM-dd`。
String formatLocalDate(DateTime date) {
  final y = date.year.toString().padLeft(4, '0');
  final m = date.month.toString().padLeft(2, '0');
  final d = date.day.toString().padLeft(2, '0');
  return '$y-$m-$d';
}

int daysBetweenLocalDates(String from, String to) {
  DateTime parse(String value) {
    final parts = value.split('-').map(int.parse).toList();
    return DateTime.utc(parts[0], parts[1], parts[2]);
  }

  return parse(to).difference(parse(from)).inDays;
}

// ---------------------------------------------------------------------------
// 内置能力探索池(移动端能力集)
// ---------------------------------------------------------------------------

class StaticSuggestionDefinition {
  const StaticSuggestionDefinition({
    required this.id,
    required this.featureTag,
    required this.title,
    required this.description,
    required this.prompt,
    required this.fallbackFor,
    this.scene,
  });

  final String id;
  final String featureTag;
  final String title;
  final String description;
  final String prompt;
  final SuggestionScene? scene;

  /// 当模型某类型条数不足时,可作为该类型的内置兜底。
  final List<SuggestionType> fallbackFor;
}

const Map<String, String> suggestionFeatureLabels = {
  'thinking': '深度思考',
  'skills': 'Skills',
  'mcp': 'MCP',
  'scheduled-tasks': '定时任务',
  'agent-groups': 'Agent 群组',
  'documents': '文档解析',
  'light-app': '轻应用',
  'data-analysis': '数据分析',
  'web-search': '联网搜索',
  'image-studio': '绘图工作室',
  'memory': '长期记忆',
};

const List<StaticSuggestionDefinition> staticSuggestions = [
  StaticSuggestionDefinition(
    id: 'light-app-todo',
    featureTag: 'light-app',
    title: '做一个属于自己的轻应用',
    description: '一句话需求直接生成可运行的小工具。',
    prompt: '帮我创建一个轻应用:记录每日待办并按标签筛选,支持勾选完成和本地保存。做完后直接打开给我看。',
    fallbackFor: [SuggestionType.newIdea],
  ),
  StaticSuggestionDefinition(
    id: 'think-first',
    featureTag: 'thinking',
    title: '开深度思考做一个难决定',
    description: '模型先推理再回答,适合权衡类问题。',
    prompt: '我在两个方案之间犹豫,请先用深度思考分别列出各自的优缺点、风险和适用场景,再给出你的推荐和理由。方案是:',
    scene: SuggestionScene(enableThinking: true),
    fallbackFor: [SuggestionType.learnQuestion, SuggestionType.featureTip],
  ),
  StaticSuggestionDefinition(
    id: 'doc-summary',
    featureTag: 'documents',
    title: '导入一份文档让我帮你读',
    description: '支持 PDF、Word、表格,可划选段落追问。',
    prompt: '我想导入一份文档并让你基于内容回答问题。请告诉我怎么用回形针导入文件,然后先给我一份要点摘要。',
    fallbackFor: [SuggestionType.featureTip, SuggestionType.dataInsight],
  ),
  StaticSuggestionDefinition(
    id: 'web-research',
    featureTag: 'web-search',
    title: '联网调研一个选型问题',
    description: '搜索并抓取网页,整理成对比表格。',
    prompt: '请联网调研:2026 年做一个中小型 SaaS 后端,选 Node.js、Go 还是 Rust 更合适?给出对比表格、推荐理由和来源链接。',
    fallbackFor: [SuggestionType.learnQuestion, SuggestionType.newIdea],
  ),
  StaticSuggestionDefinition(
    id: 'schedule-daily-brief',
    featureTag: 'scheduled-tasks',
    title: '每天早上自动给我一份简报',
    description: '定时任务按计划运行提示词并保留报告。',
    prompt: '帮我创建一个定时任务:每天早上 8 点搜索我关注领域的最新动态,整理成 5 条要点简报。领域是:',
    fallbackFor: [SuggestionType.automation],
  ),
  StaticSuggestionDefinition(
    id: 'agent-group-debate',
    featureTag: 'agent-groups',
    title: '让几个 Agent 帮我做一次评审',
    description: 'Agent 群组可以从不同角度并行讨论。',
    prompt: '请组建一个 Agent 群组对我的方案做评审:一个关注可行性,一个关注风险,一个关注成本,最后由协调者汇总成一份改进清单。方案是:',
    fallbackFor: [SuggestionType.automation, SuggestionType.featureTip],
  ),
  StaticSuggestionDefinition(
    id: 'skill-capture',
    featureTag: 'skills',
    title: '把常用流程沉淀成一个 Skill',
    description: 'Skill 是可复用的提示词包,一键注入对话。',
    prompt: '我经常需要写规范的周报。请帮我写一个 Skill,包含结构模板、语气要求和示例,并告诉我如何保存和启用它。',
    fallbackFor: [SuggestionType.featureTip],
  ),
  StaticSuggestionDefinition(
    id: 'mcp-connect',
    featureTag: 'mcp',
    title: '接入一个远程 MCP 服务',
    description: 'MCP 让模型能调用外部服务和数据。',
    prompt: '我想接入一个远程 MCP 服务来扩展你的能力。请推荐几个对个人用户最有用的 MCP 服务,并说明在设置里如何配置和验证连接。',
    fallbackFor: [SuggestionType.featureTip, SuggestionType.automation],
  ),
  StaticSuggestionDefinition(
    id: 'sheet-insight',
    featureTag: 'data-analysis',
    title: '分析一张表格里的趋势',
    description: '导入 Excel 或 CSV,直接问数据问题。',
    prompt: '我会导入一份表格数据,请先告诉我它有哪些列和多少行,然后找出最值得关注的 3 个趋势或异常并解释原因。',
    fallbackFor: [SuggestionType.dataInsight],
  ),
  StaticSuggestionDefinition(
    id: 'image-studio',
    featureTag: 'image-studio',
    title: '为一个想法生成几张概念图',
    description: '绘图工作室可以批量生成并管理图片。',
    prompt: '我有一个产品想法,请先帮我提炼视觉方向,再用绘图工作室生成 3 张不同风格的概念图。想法是:',
    fallbackFor: [SuggestionType.newIdea],
  ),
  StaticSuggestionDefinition(
    id: 'memory-profile',
    featureTag: 'memory',
    title: '让我记住你的偏好',
    description: '长期记忆会跨会话沿用你的习惯和背景。',
    prompt: '请记住我的以下偏好,之后的回答都按这些来:回答用中文、先给结论再展开、代码示例默认 TypeScript。另外我的背景是:',
    fallbackFor: [SuggestionType.featureTip],
  ),
  StaticSuggestionDefinition(
    id: 'reflect-week',
    featureTag: 'thinking',
    title: '复盘这一周做过的事',
    description: '用一个问题帮你看清重点与遗漏。',
    prompt: '请帮我做一次本周复盘:先问我 3 个关键问题,根据我的回答总结做得好的、没做到的,以及下周最值得投入的一件事。',
    scene: SuggestionScene(enableThinking: true),
    fallbackFor: [SuggestionType.learnQuestion],
  ),
];

/// 每周主题(按 ISO 周轮换,周一切换)。
class WeeklyTheme {
  const WeeklyTheme(this.id, this.label, this.itemIds);

  final String id;
  final String label;
  final List<String> itemIds;
}

const List<WeeklyTheme> weeklyThemes = [
  WeeklyTheme('build', '动手做', ['light-app-todo', 'think-first', 'doc-summary', 'web-research']),
  WeeklyTheme('automation', '自动化', ['schedule-daily-brief', 'agent-group-debate', 'skill-capture', 'mcp-connect']),
  WeeklyTheme('knowledge', '知识与分析', ['sheet-insight', 'doc-summary', 'web-research', 'reflect-week']),
  WeeklyTheme('extend', '扩展能力', ['image-studio', 'memory-profile', 'mcp-connect', 'think-first']),
];

/// ISO-8601 周数。
int isoWeekNumber(DateTime date) {
  final target = DateTime.utc(date.year, date.month, date.day);
  final dayNumber = target.weekday; // 1..7, Monday = 1
  final thursday = target.add(Duration(days: 4 - dayNumber));
  final yearStart = DateTime.utc(thursday.year, 1, 1);
  return ((thursday.difference(yearStart).inDays) / 7).floor() + 1;
}

WeeklyTheme resolveWeeklyTheme(DateTime date) {
  final index = (isoWeekNumber(date) + date.year) % weeklyThemes.length;
  return weeklyThemes[index];
}

WorkSuggestion buildStaticSuggestion(
  StaticSuggestionDefinition definition, {
  required String layer,
  required String type,
}) => WorkSuggestion(
  id: layer == 'explore' ? 'static:${definition.id}' : 'static:${definition.id}:$type',
  layer: layer,
  type: type,
  title: definition.title,
  description: definition.description,
  prompt: definition.prompt,
  scene: definition.scene,
  source: 'static',
  featureTag: definition.featureTag,
);

/// 本周主题的卡片在前,其余池内卡片在后,这样「不感兴趣」永远清不空列表。
({WeeklyTheme theme, List<WorkSuggestion> items}) buildExploreSuggestions(DateTime now) {
  final theme = resolveWeeklyTheme(now);
  final byId = {for (final item in staticSuggestions) item.id: item};
  final ordered = <StaticSuggestionDefinition>[];
  for (final id in theme.itemIds) {
    final definition = byId[id];
    if (definition != null && !ordered.contains(definition)) ordered.add(definition);
  }
  for (final definition in staticSuggestions) {
    if (!ordered.contains(definition)) ordered.add(definition);
  }
  return (
    theme: theme,
    items: ordered
        .map((definition) => buildStaticSuggestion(definition, layer: 'explore', type: 'weekly-theme'))
        .toList(),
  );
}

List<WorkSuggestion> staticFallbacksForType(SuggestionType type, Set<String> exclude) =>
    staticSuggestions
        .where((definition) => definition.fallbackFor.contains(type) && !exclude.contains(definition.id))
        .map((definition) => buildStaticSuggestion(definition, layer: 'daily', type: type.key))
        .toList();

// ---------------------------------------------------------------------------
// 模型输出解析
// ---------------------------------------------------------------------------

const int _titleMaxLength = 40;
const int _descriptionMaxLength = 120;
const int _promptMaxLength = 800;

String clipText(String value, int max) {
  final trimmed = value.trim().replaceAll(RegExp(r'\s+'), ' ');
  if (trimmed.length <= max) return trimmed;
  return '${trimmed.substring(0, max - 1)}…';
}

/// 从可能带有前后说明或代码围栏的回复中抽出第一个 JSON 数组。
List<dynamic>? extractJsonArray(String text) {
  final fenced = RegExp(r'```(?:json)?\s*([\s\S]*?)```', caseSensitive: false).firstMatch(text);
  for (final candidate in [fenced?.group(1), text]) {
    if (candidate == null) continue;
    final start = candidate.indexOf('[');
    final end = candidate.lastIndexOf(']');
    if (start < 0 || end <= start) continue;
    try {
      final parsed = jsonDecode(candidate.substring(start, end + 1));
      if (parsed is List) return parsed;
    } catch (_) {
      // 试下一个候选
    }
  }
  return null;
}

/// 校验一条模型输出。类型不在允许集合内的一律丢弃,模型无法扩大用户勾选的范围。
WorkSuggestion? normalizeLlmSuggestion(
  Object? value,
  Set<SuggestionType> allowedTypes, {
  required String date,
  required int index,
}) {
  if (value is! Map) return null;
  final raw = value.cast<String, dynamic>();
  final type = SuggestionType.fromKey(raw['type']);
  if (type == null || !allowedTypes.contains(type)) return null;
  final title = raw['title'] is String ? clipText(raw['title'] as String, _titleMaxLength) : '';
  final prompt = raw['prompt'] is String ? clipText(raw['prompt'] as String, _promptMaxLength) : '';
  if (title.isEmpty || prompt.isEmpty) return null;
  final description = raw['description'] is String
      ? clipText(raw['description'] as String, _descriptionMaxLength)
      : '';
  final rawScene = raw['scene'];
  final scene = rawScene is Map && rawScene['enableThinking'] == true
      ? const SuggestionScene(enableThinking: true)
      : null;
  return WorkSuggestion(
    id: 'llm:$date:$index:${DateTime.now().microsecondsSinceEpoch}',
    layer: 'daily',
    type: type.key,
    title: title,
    description: description,
    prompt: prompt,
    scene: scene,
    source: 'llm',
    fresh: true,
  );
}

const int _knowledgeDisciplineMaxLength = 20;

/// 校验一条模型输出的知识卡。来源不在用户勾选内的丢弃;`interest` 来源要求至少
/// 声明了一个兴趣;`random` 永远不由模型生成;任何 scene 一律忽略:
/// 知识卡开启的是一段对话,不是一个任务。
WorkSuggestion? normalizeKnowledgeSuggestion(
  Object? value,
  KnowledgePreferences preferences, {
  required String date,
  required int index,
}) {
  if (value is! Map) return null;
  final raw = value.cast<String, dynamic>();
  final source = KnowledgeSource.fromKey(raw['source']);
  if (source == null || source == KnowledgeSource.random || !preferences.sources.contains(source)) return null;
  if (source == KnowledgeSource.interest && preferences.interests.isEmpty) return null;
  final title = raw['title'] is String ? clipText(raw['title'] as String, _titleMaxLength) : '';
  final prompt = raw['prompt'] is String ? clipText(raw['prompt'] as String, _promptMaxLength) : '';
  if (title.isEmpty || prompt.isEmpty) return null;
  final description = raw['description'] is String
      ? clipText(raw['description'] as String, _descriptionMaxLength)
      : '';
  final discipline = raw['discipline'] is String
      ? clipText(raw['discipline'] as String, _knowledgeDisciplineMaxLength)
      : '';
  return WorkSuggestion(
    id: 'llm:$date:k$index:${DateTime.now().microsecondsSinceEpoch}',
    layer: 'knowledge',
    type: 'knowledge',
    title: title,
    description: description,
    prompt: prompt,
    source: 'llm',
    knowledge: KnowledgeMeta(source: source, discipline: discipline.isEmpty ? null : discipline),
    fresh: true,
  );
}

/// 知识卡片是好奇心钩子,不是任务:标题必须是一个问题或反直觉的事实,
/// 与用户工作相关只是加分项。
const Map<KnowledgeSource, String> _knowledgeSourceInstructions = {
  KnowledgeSource.crossDiscipline:
      "Pick one intriguing concept, phenomenon or historical episode from a discipline DIFFERENT from the user's work (never software engineering itself). The title must be a question or a counter-intuitive fact. It does not have to relate to the user's work; if a natural link exists, mention it in the description in one clause, but never force one.",
  KnowledgeSource.workDomain:
      "Infer the user's field from their apps, conversation titles and profession, then pick a concept, principle or piece of lore from that field the user has most likely never dug into. Curiosity first; it need not be immediately applicable.",
  KnowledgeSource.interest:
      "Stay strictly within one of the user's declared interests and offer an entry point that is accessible but not shallow, one that invites a chain of follow-up questions.",
};

/// 组装知识探索提示词。与每日推荐的提示词分开请求,互不影响。
String buildKnowledgePrompt(
  DailySuggestionPreferences preferences,
  DailySuggestionContext context, {
  KnowledgeSeed? todaySeed,
  Map<KnowledgeSource, int> dismissStreaks = const {},
}) {
  final knowledge = preferences.knowledge;
  final sources = knowledge.sources.where((source) => source.needsModel).toList();
  final workClause = knowledge.profession.isEmpty
      ? ''
      : ' If there is a surprising link to what I do (${clipText(knowledge.profession, knowledgeProfessionMaxLength)}), mention it in passing.';
  final lines = <String>[
    'You write a few short "curiosity hooks" for a user of WorldBase Mobile, an AI workspace app. Each hook is a card the user can tap to start a relaxed conversation with the assistant about an idea, phenomenon or story they probably never dug into. The goal is to make them curious, not to make them productive.',
    'Write every title, description and prompt in Simplified Chinese.',
    '',
    '## About the user',
    'Profession / field: ${knowledge.profession.isEmpty ? 'not stated' : clipText(knowledge.profession, knowledgeProfessionMaxLength)}.',
    'Declared interests: ${knowledge.interests.isEmpty ? 'none' : knowledge.interests.map((item) => clipText(item, knowledgeInterestMaxLength)).join(', ')}.',
    if (context.lightAppNames.isNotEmpty)
      'Lightweight apps: ${context.lightAppNames.take(20).map((name) => clipText(name, 40)).join(', ')}.',
    if (context.conversationTitles.isNotEmpty) 'Recent conversation titles (newest first):',
    for (final title in context.conversationTitles.take(20)) '- ${clipText(title, 80)}',
    if (todaySeed != null && knowledge.sources.contains(KnowledgeSource.random))
      'Already shown today from the built-in pool: a card about "${todaySeed.discipline.key}". Avoid that discipline.',
    '',
    '## What to generate',
    'Produce exactly ${knowledge.countPerSource} item(s) for EACH of the following sources, and nothing for any other source:',
    for (final source in sources)
      if (source != KnowledgeSource.interest || knowledge.interests.isNotEmpty)
        '- "${source.key}": ${_knowledgeSourceInstructions[source]}${(dismissStreaks[source] ?? 0) >= 3 ? ' The user has recently dismissed several items from this source; take a clearly different angle.' : ''}',
    '',
    '## Output format',
    'Reply with a JSON array only, no prose, no code fence. Each element:',
    '{"source": "<one of the sources above>", "discipline": "<discipline or topic, <= 20 characters>", "title": "<= 20 characters; a question or a counter-intuitive fact, never a dictionary headword", "description": "one sentence that deepens the hook or names an unexpected connection", "prompt": "the full message the user would send to the assistant"}',
    'The prompt must follow this shape, adapted to the topic: "I\'m curious about X. Start with an everyday analogy for what it is, then tell me the most counter-intuitive thing about it. Afterwards give me three directions I could ask about next and I\'ll pick one.$workClause Don\'t open with a definition."',
    'Rules: interesting first, useful second; never invent facts; avoid software engineering as the subject for cross-discipline; do not repeat the same topic across items.',
  ];
  return lines.join('\n');
}

/// 按来源限额裁剪模型返回的知识卡;不做内置补齐(随机卡就是兜底)。
List<WorkSuggestion> assembleKnowledgeItems(List<WorkSuggestion> llmItems, KnowledgePreferences preferences) {
  final perSource = <KnowledgeSource, int>{};
  final items = <WorkSuggestion>[];
  for (final item in llmItems) {
    final source = item.knowledge?.source;
    if (source == null) continue;
    final count = perSource[source] ?? 0;
    if (count >= preferences.countPerSource) continue;
    perSource[source] = count + 1;
    items.add(item);
  }
  return items;
}

const Map<SuggestionType, String> _typeInstructions = {
  SuggestionType.newIdea:
      'Propose a concrete new project or lightweight app the user could start today, matched to the topics visible in their context. The prompt must ask the assistant to build or plan it.',
  SuggestionType.improveProject:
      'Propose a specific improvement to one of the listed lightweight apps or a recent piece of work (name it). The prompt must describe the change to make.',
  SuggestionType.learnQuestion:
      'Ask a reflective or technical question that helps the user think about their recent work, then have the prompt ask the assistant to explore that question together with the user.',
  SuggestionType.automation:
      'Suggest something recurring or long-running the user could hand to a scheduled task or an agent group. The prompt must ask the assistant to set that automation up.',
  SuggestionType.featureTip:
      'Teach one product capability the user seems not to have used yet (deep thinking, document parsing, skills, MCP servers, scheduled tasks, agent groups, web search, image studio, long-term memory). The prompt must exercise that capability.',
  SuggestionType.dataInsight:
      'Suggest a data question worth answering about one of the listed documents or spreadsheets (name it). The prompt must ask the assistant to inspect that data and report findings.',
};

/// 生成上下文(已按偏好过滤)。
class DailySuggestionContext {
  const DailySuggestionContext({
    this.lightAppNames = const [],
    this.conversationTitles = const [],
    this.documentNames = const [],
    this.skillNames = const [],
    this.mcpServerNames = const [],
    this.scheduleCount = 0,
    this.agentGroupCount = 0,
  });

  final List<String> lightAppNames;
  final List<String> conversationTitles;
  final List<String> documentNames;
  final List<String> skillNames;
  final List<String> mcpServerNames;
  final int scheduleCount;
  final int agentGroupCount;
}

/// 组装提示词。每个勾选类型一段独立指令;未勾选的类型明确禁止输出。
String buildDailySuggestionPrompt(
  DailySuggestionPreferences preferences,
  DailySuggestionContext context, {
  Map<SuggestionType, int> dismissStreaks = const {},
}) {
  final lines = <String>[
    'You generate a short list of actionable daily suggestions for a user of WorldBase Mobile, an AI workspace app that can chat with deep thinking, build lightweight apps, parse and discuss documents and spreadsheets, search the web, use skills and remote MCP servers, run scheduled tasks and agent groups, generate images, and keep long-term memory.',
    'Write every title, description and prompt in Simplified Chinese.',
    '',
    '## User context',
    context.lightAppNames.isEmpty
        ? 'Lightweight apps: none.'
        : 'Lightweight apps: ${context.lightAppNames.take(20).map((name) => clipText(name, 40)).join(', ')}.',
    if (context.conversationTitles.isNotEmpty) 'Recent conversation titles (newest first):',
    for (final title in context.conversationTitles.take(20)) '- ${clipText(title, 80)}',
    if (context.conversationTitles.isEmpty) 'Recent conversations: none listed.',
    context.documentNames.isEmpty
        ? 'Imported documents: none listed.'
        : 'Imported documents: ${context.documentNames.take(15).map((name) => clipText(name, 60)).join(', ')}.',
    'Installed skills: ${context.skillNames.isEmpty ? 'none' : context.skillNames.take(15).map((name) => clipText(name, 40)).join(', ')}.',
    'Configured MCP servers: ${context.mcpServerNames.isEmpty ? 'none' : context.mcpServerNames.take(15).map((name) => clipText(name, 40)).join(', ')}.',
    'Scheduled tasks: ${context.scheduleCount}. Agent groups: ${context.agentGroupCount}.',
    '',
    '## What to generate',
    'Produce exactly ${preferences.countPerType} items for EACH of the following types, and nothing for any other type:',
    for (final type in preferences.types)
      '- "${type.key}": ${_typeInstructions[type]}${(dismissStreaks[type] ?? 0) >= 3 ? ' The user has recently dismissed several items of this type; take a clearly different angle.' : ''}',
    '',
    '## Output format',
    'Reply with a JSON array only, no prose, no code fence. Each element:',
    '{"type": "<one of the types above>", "title": "<= 20 characters, imperative, specific", "description": "one sentence on why it is worth doing", "prompt": "the full message the user would send to the assistant to start this work; concrete and self-contained", "scene": {"enableThinking": true|false}}',
    'Rules: set enableThinking true only for questions that benefit from step-by-step reasoning; never invent apps, documents, tools or data that are not in the context; avoid repeating the same idea across types.',
  ];
  return lines.join('\n');
}

/// 按类型限额、并用内置卡片补齐不足的类型。
({List<WorkSuggestion> items, String status}) assembleDailyBatch(
  List<WorkSuggestion> llmItems,
  DailySuggestionPreferences preferences,
) {
  final grouped = <SuggestionType, List<WorkSuggestion>>{
    for (final type in preferences.types) type: <WorkSuggestion>[],
  };
  for (final item in llmItems) {
    final type = SuggestionType.fromKey(item.type);
    final bucket = type == null ? null : grouped[type];
    if (bucket != null && bucket.length < preferences.countPerType) bucket.add(item);
  }
  var usedFallback = false;
  final usedStaticIds = <String>{};
  for (final type in preferences.types) {
    final bucket = grouped[type]!;
    if (bucket.length >= preferences.countPerType) continue;
    for (final fallback in staticFallbacksForType(type, usedStaticIds)) {
      if (bucket.length >= preferences.countPerType) break;
      bucket.add(fallback);
      usedStaticIds.add(fallback.id.split(':')[1]);
      usedFallback = true;
    }
  }
  final items = [for (final type in preferences.types) ...grouped[type]!];
  final llmCount = items.where((item) => item.source == 'llm').length;
  return (
    items: items,
    status: llmCount == 0 ? 'failed' : (usedFallback ? 'partial' : 'ok'),
  );
}
