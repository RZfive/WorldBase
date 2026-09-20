/// 随机知识题库(与桌面端 `knowledge-seeds.ts` 及 zh-CN 文案对齐)。
///
/// 每条题目是一个「好奇心钩子」:标题是一个问题或反直觉的事实,描述加深悬念,
/// prompt 用统一的讨论模板打开一段对话而不是一个任务。移动端只有简体中文,
/// 文案直接内置;`id` 一旦发布不可改,本地 30 天历史按它去重。
library;

/// 学科(与桌面端 key 一致,附中文标签)。
enum KnowledgeDiscipline {
  math('math', '数学'),
  physics('physics', '物理'),
  economics('economics', '经济学'),
  psychology('psychology', '心理学'),
  design('design', '设计'),
  history('history', '历史'),
  biology('biology', '生物'),
  philosophy('philosophy', '哲学'),
  linguistics('linguistics', '语言学'),
  management('management', '管理'),
  statistics('statistics', '统计'),
  systems('systems', '系统科学');

  const KnowledgeDiscipline(this.key, this.label);

  final String key;
  final String label;

  static KnowledgeDiscipline? fromKey(Object? value) {
    if (value is! String) return null;
    for (final discipline in values) {
      if (discipline.key == value) return discipline;
    }
    return null;
  }
}

/// 学科 key → 中文标签;模型自己写的学科(非 key)原样返回。
String knowledgeDisciplineLabel(String discipline) =>
    KnowledgeDiscipline.fromKey(discipline)?.label ?? discipline;

class KnowledgeSeed {
  const KnowledgeSeed({
    required this.id,
    required this.discipline,
    required this.title,
    required this.description,
    required this.topic,
  });

  final String id;
  final KnowledgeDiscipline discipline;
  final String title;
  final String description;

  /// 讨论模板里的「X」。
  final String topic;

  /// 统一讨论模板:先类比、再反直觉之处、最后给三个追问方向。
  String get prompt =>
      '我对「$topic」有点好奇。先用一个日常类比给我讲讲它是什么，然后告诉我一个关于它最反直觉的地方。'
      '讲完后给我三个可以继续追问的方向，我选一个我们接着聊。不要一上来就下定义。';
}

/// 文案于 2026-09-19 与桌面端 zh-CN 校对一致。
const List<KnowledgeSeed> knowledgeSeeds = [
  KnowledgeSeed(
    id: 'math-birthday-paradox',
    discipline: KnowledgeDiscipline.math,
    title: '23 个人里就有一半概率两人同一天生日？',
    description: '直觉说要 183 个人，数学说 23 个就够了。',
    topic: '生日悖论',
  ),
  KnowledgeSeed(
    id: 'math-benford-law',
    discipline: KnowledgeDiscipline.math,
    title: '为什么真实账本里以 1 开头的数字最多？',
    description: '税务机关靠这条规律抓假账，河流长度和股价也逃不掉。',
    topic: '本福特定律',
  ),
  KnowledgeSeed(
    id: 'math-monty-hall',
    discipline: KnowledgeDiscipline.math,
    title: '主持人开了一扇空门，你该换门吗？',
    description: '连数学家都曾集体答错的题，换门后胜率翻倍。',
    topic: '三门问题',
  ),
  KnowledgeSeed(
    id: 'physics-why-sky-blue',
    discipline: KnowledgeDiscipline.physics,
    title: '天空是蓝的，那为什么日落是红的？',
    description: '同一束阳光、同一片空气，只是走的路更长了。',
    topic: '瑞利散射与天空的颜色',
  ),
  KnowledgeSeed(
    id: 'physics-entropy-arrow',
    discipline: KnowledgeDiscipline.physics,
    title: '为什么打碎的杯子不会自己拼回去？',
    description: '物理定律本身不分过去和未来，但世界只往一个方向走。',
    topic: '熵与时间之箭',
  ),
  KnowledgeSeed(
    id: 'physics-ice-floats',
    discipline: KnowledgeDiscipline.physics,
    title: '几乎所有东西冷了都会变重，为什么冰会浮？',
    description: '如果水不这么反常，湖泊会从底部开始结冰，鱼就活不过冬天。',
    topic: '水的反常膨胀',
  ),
  KnowledgeSeed(
    id: 'econ-opportunity-cost',
    discipline: KnowledgeDiscipline.economics,
    title: '「免费」的东西为什么往往最贵？',
    description: '机会成本：你没做的那件事才是真正的价格。',
    topic: '机会成本',
  ),
  KnowledgeSeed(
    id: 'econ-winners-curse',
    discipline: KnowledgeDiscipline.economics,
    title: '拍卖赢了反而是坏消息？',
    description: '出价最高的人，往往是估价错得最离谱的那个。',
    topic: '赢者诅咒',
  ),
  KnowledgeSeed(
    id: 'econ-lemons-market',
    discipline: KnowledgeDiscipline.economics,
    title: '为什么二手车市场里好车反而卖不掉？',
    description: '一篇曾被三家期刊退稿的论文，后来拿了诺贝尔奖。',
    topic: '柠檬市场与信息不对称',
  ),
  KnowledgeSeed(
    id: 'psych-hick-law',
    discipline: KnowledgeDiscipline.psychology,
    title: '选项越多，人反而越不想选',
    description: '菜单上 30 道菜为什么不如 8 道菜卖得好。',
    topic: '希克定律与选择过载',
  ),
  KnowledgeSeed(
    id: 'psych-peak-end-rule',
    discipline: KnowledgeDiscipline.psychology,
    title: '为什么更痛苦但更长的体验，回忆起来反而更好？',
    description: '记忆只记住高峰和结尾，中间发生了什么几乎不算数。',
    topic: '峰终定律',
  ),
  KnowledgeSeed(
    id: 'psych-dunning-kruger',
    discipline: KnowledgeDiscipline.psychology,
    title: '为什么最不懂的人最自信？',
    description: '识别自己无知所需要的能力，恰恰就是那份缺失的能力。',
    topic: '邓宁-克鲁格效应',
  ),
  KnowledgeSeed(
    id: 'design-golden-ratio-myth',
    discipline: KnowledgeDiscipline.design,
    title: '黄金比例真的藏在帕特农神庙和鹦鹉螺里吗？',
    description: '一个流传了几百年的设计传说，证据比想象中薄弱得多。',
    topic: '黄金比例的神话与真相',
  ),
  KnowledgeSeed(
    id: 'design-norman-door',
    discipline: KnowledgeDiscipline.design,
    title: '为什么有些门你总是推错方向？',
    description: '这不是你的错，是门的错。这类门有一个专门的名字。',
    topic: '诺曼门与可供性设计',
  ),
  KnowledgeSeed(
    id: 'design-fitts-law',
    discipline: KnowledgeDiscipline.design,
    title: '为什么屏幕角落是最容易点中的地方？',
    description: '一个 1954 年的公式，决定了今天每个菜单该放在哪里。',
    topic: '费茨定律',
  ),
  KnowledgeSeed(
    id: 'hist-longitude-prize',
    discipline: KnowledgeDiscipline.history,
    title: '18 世纪英国为「怎么知道船在哪」悬赏了一笔巨款',
    description: '最后赢的不是天文学家，是一个自学成才的钟表匠。',
    topic: '经度之战与哈里森的航海钟',
  ),
  KnowledgeSeed(
    id: 'hist-qwerty-layout',
    discipline: KnowledgeDiscipline.history,
    title: '键盘上的字母为什么是这个顺序？',
    description: '「为了让人打得慢」的说法流传甚广，但真相更曲折。',
    topic: 'QWERTY 键盘布局的由来',
  ),
  KnowledgeSeed(
    id: 'hist-roman-concrete',
    discipline: KnowledgeDiscipline.history,
    title: '两千年前的罗马混凝土为什么比现代的更耐久？',
    description: '海水泡了两千年反而更结实，秘密直到最近几年才被解开。',
    topic: '罗马混凝土的自愈之谜',
  ),
  KnowledgeSeed(
    id: 'bio-hex-honeycomb',
    discipline: KnowledgeDiscipline.biology,
    title: '蜂巢为什么是六边形，不是圆形或方形？',
    description: '蜜蜂没学过几何，却做出了用蜡最少的方案。',
    topic: '蜂巢猜想',
  ),
  KnowledgeSeed(
    id: 'bio-immune-memory',
    discipline: KnowledgeDiscipline.biology,
    title: '身体是怎么「记住」一种它只见过一次的病毒的？',
    description: '一套没有中央指挥的系统，却能保存几十年的记忆。',
    topic: '免疫记忆',
  ),
  KnowledgeSeed(
    id: 'bio-ant-colony-routing',
    discipline: KnowledgeDiscipline.biology,
    title: '蚂蚁没有地图，怎么总能找到最短路线？',
    description: '每只蚂蚁都很笨，但一群蚂蚁解决了一个 NP 难问题。',
    topic: '蚁群算法与涌现',
  ),
  KnowledgeSeed(
    id: 'phil-ship-of-theseus',
    discipline: KnowledgeDiscipline.philosophy,
    title: '一艘船的木板全换过一遍，它还是原来那艘船吗？',
    description: '两千年前的问题，今天的每一次系统重构都在重问。',
    topic: '忒修斯之船',
  ),
  KnowledgeSeed(
    id: 'phil-occams-razor',
    discipline: KnowledgeDiscipline.philosophy,
    title: '「越简单的解释越可能是对的」这句话本身对吗？',
    description: '奥卡姆剃刀被引用了七百年，但它从来不是一条定律。',
    topic: '奥卡姆剃刀',
  ),
  KnowledgeSeed(
    id: 'phil-trolley-problem',
    discipline: KnowledgeDiscipline.philosophy,
    title: '拉一下杆救五个人、牺牲一个人，你会拉吗？',
    description: '换成把一个人推下天桥，大多数人的答案就变了。为什么？',
    topic: '电车难题',
  ),
  KnowledgeSeed(
    id: 'ling-color-words-order',
    discipline: KnowledgeDiscipline.linguistics,
    title: '为什么全世界的语言都先有「红」，最后才有「蓝」？',
    description: '荷马史诗里的大海是「酒色」的，古人可能真的看不到蓝。',
    topic: '颜色词的普遍演化顺序',
  ),
  KnowledgeSeed(
    id: 'ling-zipf-law',
    discipline: KnowledgeDiscipline.linguistics,
    title: '任何语言里最常用的词，都恰好是第二常用词的两倍？',
    description: '一条没人设计的规律，从英语到城市人口都服从它。',
    topic: '齐夫定律',
  ),
  KnowledgeSeed(
    id: 'ling-untranslatable-words',
    discipline: KnowledgeDiscipline.linguistics,
    title: '有些词真的无法翻译，还是我们只是懒得解释？',
    description: '「hygge」「侘寂」「saudade」背后是文化，还是营销？',
    topic: '不可译词与语言相对论',
  ),
  KnowledgeSeed(
    id: 'mgmt-brooks-law',
    discipline: KnowledgeDiscipline.management,
    title: '项目延期了，为什么加人反而更慢？',
    description: '九个女人也不能一个月生出孩子。1975 年的书，今天依然被违反。',
    topic: '布鲁克斯定律',
  ),
  KnowledgeSeed(
    id: 'mgmt-parkinson-law',
    discipline: KnowledgeDiscipline.management,
    title: '为什么给一周的活总要花满一周？',
    description: '工作会膨胀到填满所有可用时间。这条定律最初是在嘲讽英国官僚。',
    topic: '帕金森定律',
  ),
  KnowledgeSeed(
    id: 'mgmt-goodhart-law',
    discipline: KnowledgeDiscipline.management,
    title: '一个指标一旦变成目标，它就不再是好指标',
    description: '殖民时期印度悬赏眼镜蛇，结果人们开始养眼镜蛇。',
    topic: '古德哈特定律',
  ),
  KnowledgeSeed(
    id: 'stat-simpsons-paradox',
    discipline: KnowledgeDiscipline.statistics,
    title: '每个科室的治愈率都更高，总体治愈率却更低？',
    description: '同一份数据，分开看和合起来看结论完全相反。',
    topic: '辛普森悖论',
  ),
  KnowledgeSeed(
    id: 'stat-survivorship-bias',
    discipline: KnowledgeDiscipline.statistics,
    title: '二战时该给飞机哪里加装甲？弹孔最多的地方不对',
    description: '能飞回来的飞机告诉你的，恰恰是哪里挨打没关系。',
    topic: '幸存者偏差',
  ),
  KnowledgeSeed(
    id: 'stat-regression-to-mean',
    discipline: KnowledgeDiscipline.statistics,
    title: '为什么表扬之后表现变差，批评之后反而变好？',
    description: '飞行教官坚信批评有效，其实只是运气在回归平均。',
    topic: '均值回归',
  ),
  KnowledgeSeed(
    id: 'sys-littles-law',
    discipline: KnowledgeDiscipline.systems,
    title: '排队的人数、等待时间和通过速度，为什么只能定两个？',
    description: '一个 1961 年的公式，超市收银台和服务器并发都逃不掉。',
    topic: '利特尔法则',
  ),
  KnowledgeSeed(
    id: 'sys-braess-paradox',
    discipline: KnowledgeDiscipline.systems,
    title: '多修一条路，为什么全城反而更堵了？',
    description: '首尔拆掉一条高速公路之后，交通变好了。',
    topic: '布雷斯悖论',
  ),
  KnowledgeSeed(
    id: 'sys-cobra-effect',
    discipline: KnowledgeDiscipline.systems,
    title: '为什么好心的激励政策常常适得其反？',
    description: '河内悬赏老鼠尾巴，结果满城都是没尾巴的活老鼠。',
    topic: '眼镜蛇效应与反常激励',
  ),
];

final Map<String, KnowledgeSeed> _seedById = {for (final seed in knowledgeSeeds) seed.id: seed};

KnowledgeSeed? knowledgeSeedById(String id) => _seedById[id];

/// 最近这些天内出现过的题目在新一轮抽签中被排除。
const int knowledgeSeedReuseDays = 30;
const int _knowledgeSeedReuseDaysRelaxed = 14;

/// FNV-1a 32 位:跨平台、跨运行稳定(`Object.hashCode` 与 `Random` 都不是)。
int hashString(String value) {
  var hash = 0x811c9dc5;
  for (final unit in value.codeUnits) {
    hash ^= unit;
    hash = (hash * 0x01000193) & 0xFFFFFFFF;
  }
  return hash;
}

class KnowledgeSeedHistoryEntry {
  const KnowledgeSeedHistoryEntry({required this.seedId, required this.date});

  final String seedId;

  /// 本地日历日 `yyyy-MM-dd`。
  final String date;

  Map<String, dynamic> toJson() => {'seedId': seedId, 'date': date};

  static KnowledgeSeedHistoryEntry? fromJson(Object? value) {
    if (value is! Map) return null;
    final seedId = value['seedId'];
    final date = value['date'];
    if (seedId is! String || seedId.trim().isEmpty) return null;
    if (date is! String || !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(date)) return null;
    return KnowledgeSeedHistoryEntry(seedId: seedId.trim(), date: date);
  }
}

int _daysBetween(String from, String to) {
  DateTime parse(String value) {
    final parts = value.split('-').map(int.parse).toList();
    return DateTime.utc(parts[0], parts[1], parts[2]);
  }

  return parse(to).difference(parse(from)).inDays;
}

/// 抽出 `date` 这一天的题目。同一组 (date, salt, history, attempt) 结果固定,
/// 所以当天反复打开看到的是同一张;salt 按安装随机,不同用户同一天不会抽到同一条。
/// 近期出现过的题目被排除;池子抽干时先放宽到 14 天,再不够就不排除。
KnowledgeSeed drawKnowledgeSeed(
  String date,
  String salt,
  List<KnowledgeSeedHistoryEntry> history, {
  int attempt = 0,
}) {
  for (final window in [knowledgeSeedReuseDays, _knowledgeSeedReuseDaysRelaxed, 0]) {
    final excluded = <String>{
      for (final entry in history)
        if (window != 0 && _daysBetween(entry.date, date) < window) entry.seedId,
    };
    final candidates = knowledgeSeeds.where((seed) => !excluded.contains(seed.id)).toList();
    if (candidates.isEmpty) continue;
    return candidates[hashString('$date|$salt|$attempt') % candidates.length];
  }
  return knowledgeSeeds.first;
}
