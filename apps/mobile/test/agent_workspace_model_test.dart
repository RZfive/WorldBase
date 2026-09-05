import 'package:flutter_test/flutter_test.dart';
import 'package:worldbase_mobile/core/harness_client.dart';

void main() {
  test('Agent round-trip preserves AI-created workspace policies', () {
    final agent = AgentDefinition(
      id: 'researcher',
      name: '研究员',
      systemPrompt: '负责事实核验',
      reasoningStrength: 'high',
      skillIds: const ['web-research'],
      allowedTools: const ['web_search'],
      deniedTools: const ['execute_command'],
      memoryScopes: const ['user', 'agent', 'group'],
      memoryWritePolicy: const {
        'allowUserTraits': false,
        'allowAgentSkills': true,
        'allowSteps': true,
        'allowKnowledge': true,
      },
      autoReplyPolicy: const {'enabled': true, 'requireMention': false},
    );

    final restored = AgentDefinition.fromJson(agent.toJson());

    expect(restored.reasoningStrength, 'high');
    expect(restored.skillIds, ['web-research']);
    expect(restored.allowedTools, ['web_search']);
    expect(restored.deniedTools, ['execute_command']);
    expect(restored.memoryScopes, ['user', 'agent', 'group']);
    expect(restored.memoryWritePolicy['allowUserTraits'], isFalse);
    expect(restored.autoReplyPolicy['enabled'], isTrue);
  });

  test('Agent group round-trip preserves the Electron workspace fields', () {
    final group = AgentGroupDefinition(
      id: 'product-team',
      name: '产品群聊',
      icon: 'team',
      description: '产品、研发和评审协作',
      coordinatorAgentId: 'product-agent',
      memberAgentIds: const [
        'product-agent',
        'engineer-agent',
        'reviewer-agent',
      ],
      maxRounds: 3,
      maxParallelWorkers: 2,
      sharedMemoryScopes: const ['group', 'project'],
      visibility: 'expandable_internal_transcript',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T01:00:00Z',
    );

    final restored = AgentGroupDefinition.fromJson(group.toJson());

    expect(restored.id, group.id);
    expect(restored.coordinatorAgentId, group.coordinatorAgentId);
    expect(restored.memberAgentIds, group.memberAgentIds);
    expect(restored.maxRounds, 3);
    expect(restored.maxParallelWorkers, 2);
    expect(restored.sharedMemoryScopes, ['group', 'project']);
    expect(restored.visibility, 'expandable_internal_transcript');
  });

  test('Group session resolves typed mentions to durable Agent ids', () {
    final session = GroupSession.fromJson({
      'id': 'group-session',
      'topic': '产品讨论',
      'mode': 'discussion',
      'status': 'open',
      'members': [
        {'name': '工程', 'agentId': 'short-engineer-agent'},
        {'name': '产品经理', 'agentId': 'product-agent'},
        {'name': '工程师', 'agentId': 'engineer-agent'},
        {'name': '临时评审'},
      ],
    });

    expect(session.memberNames, ['工程', '产品经理', '工程师', '临时评审']);
    expect(session.mentionedMemberIds('@工程师 请检查实现，@临时评审 看风险'), [
      'engineer-agent',
      '临时评审',
    ]);
    expect(session.mentionedMemberIds('请全员讨论'), isEmpty);
  });

  test('Only the shared group transcript is recognized as a group chat', () {
    final transcript = ConversationMeta(
      id: 'group-product-team',
      title: '产品群聊',
      updatedAt: '2026-09-03T00:00:00Z',
    );
    final internalMemberRun = ConversationMeta(
      id: 'group-product-team-engineer',
      title: 'Native group: 工程师',
      updatedAt: '2026-09-03T00:00:00Z',
      agentId: 'engineer',
    );
    final ordinary = ConversationMeta(
      id: 'conversation-1',
      title: '普通对话',
      updatedAt: '2026-09-03T00:00:00Z',
    );

    expect(transcript.groupId, 'product-team');
    expect(transcript.isGroup, isTrue);
    expect(internalMemberRun.groupId, isNull);
    expect(ordinary.isGroup, isFalse);
  });

  test('Provider round-trip preserves Electron model temperature', () {
    final provider = ProviderEntry(
      id: 'openai',
      name: 'OpenAI',
      temperature: 0.7,
      enableThinking: true,
      models: [ModelInfo(id: 'gpt-test')],
    );

    final restored = ProviderEntry.fromJson(provider.toJson());

    expect(restored.temperature, 0.7);
    expect(restored.enableThinking, isTrue);
  });
}
