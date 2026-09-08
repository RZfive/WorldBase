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

  test('Skill round-trip preserves Node metadata and argument contracts', () {
    final skill = SkillDescriptor(
      name: 'release-helper',
      description: 'Prepare a release',
      whenToUse: 'When a release is requested',
      arguments: const [
        SkillArgument(
          name: 'channel',
          description: 'Release channel',
          required: true,
        ),
      ],
      allowedTools: const ['read_file', 'write_file'],
      context: 'fork',
      instructions: 'Release to \${channel}.',
      path: '/skills/release-helper.yaml',
    );

    final restored = SkillDescriptor.fromJson(skill.toJson());

    expect(restored.whenToUse, 'When a release is requested');
    expect(restored.arguments.single.name, 'channel');
    expect(restored.arguments.single.required, isTrue);
    expect(restored.allowedTools, ['read_file', 'write_file']);
    expect(restored.context, 'fork');
    expect(restored.path, '/skills/release-helper.yaml');
  });

  test('Schedule round-trip preserves structured cadence and retry state', () {
    final schedule = ScheduleEntry(
      id: 'morning-report',
      name: 'Morning report',
      cron: '',
      task: 'Summarize yesterday',
      enabled: true,
      schedule: const ScheduledTaskSchedule(
        kind: 'weekly',
        weekdays: [1, 3, 5],
        timeOfDay: '09:00',
      ),
      selectedSkillIds: const ['daily-report'],
      selectedMcpServerIds: const ['notion'],
      retryPolicy: ScheduledTaskRetryPolicy(
        maxRetries: 2,
        retryDelayMinutes: 15,
      ),
      retryScheduledAt: '2026-09-05T09:15:00Z',
      retryAttempt: 1,
      createdBy: 'ai',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-05T09:00:00Z',
      lastStatus: 'retrying',
    );

    final restored = ScheduleEntry.fromJson(schedule.toJson());

    expect(restored.title, 'Morning report');
    expect(restored.prompt, 'Summarize yesterday');
    expect(restored.schedule?.kind, 'weekly');
    expect(restored.schedule?.weekdays, [1, 3, 5]);
    expect(restored.schedule?.timeOfDay, '09:00');
    expect(restored.selectedSkillIds, ['daily-report']);
    expect(restored.selectedMcpServerIds, ['notion']);
    expect(restored.retryPolicy.maxRetries, 2);
    expect(restored.retryPolicy.retryDelayMinutes, 15);
    expect(restored.retryAttempt, 1);
    expect(restored.createdBy, 'ai');
    expect(restored.lastStatus, 'retrying');
  });

  test(
    'Schedule parser accepts Electron title/prompt and snake_case fields',
    () {
      final schedule = ScheduleEntry.fromJson({
        'id': 'interval-task',
        'title': 'Interval task',
        'prompt': 'Run checks',
        'enabled': true,
        'schedule': {
          'kind': 'interval',
          'everyMinutes': 30,
          'startAt': '2026-09-05T10:00:00Z',
        },
        'selected_skill_ids': ['checks'],
        'retry_policy': {'max_retries': 1, 'retry_delay_minutes': 7},
        'last_status': 'running',
      });

      expect(schedule.name, 'Interval task');
      expect(schedule.task, 'Run checks');
      expect(schedule.schedule?.everyMinutes, 30);
      expect(schedule.schedule?.startAt, '2026-09-05T10:00:00Z');
      expect(schedule.selectedSkillIds, ['checks']);
      expect(schedule.retryPolicy.retryDelayMinutes, 7);
      expect(schedule.lastStatus, 'running');
    },
  );

  test('MCP snapshots preserve settings and discovery metadata', () {
    final config = McpServerConfig(
      id: 'notion',
      name: 'Notion',
      enabled: true,
      transport: 'streamable-http',
      url: 'https://mcp.example.test',
      headers: const {'Authorization': 'Bearer token'},
    );
    final restoredConfig = McpServerConfig.fromJson(config.toJson());
    expect(restoredConfig.id, 'notion');
    expect(restoredConfig.name, 'Notion');
    expect(restoredConfig.url, 'https://mcp.example.test');
    expect(restoredConfig.headers['Authorization'], 'Bearer token');

    final snapshot = McpStateSnapshot.fromJson({
      'updatedAt': '2026-09-05T00:00:00Z',
      'servers': [
        {
          'id': 'notion',
          'name': 'Notion',
          'enabled': true,
          'transport': 'streamable-http',
          'status': 'connected',
          'tools': [
            {
              'name': 'search',
              'localName': 'mcp__notion__search__abc123',
              'description': 'Search pages',
              'inputSchema': {'type': 'object'},
            },
          ],
          'resources': [
            {'uri': 'notion://home', 'name': 'Home', 'mimeType': 'text/plain'},
          ],
          'prompts': [
            {
              'name': 'summarize',
              'description': 'Summarize a page',
              'arguments': [
                {'name': 'uri', 'required': true},
              ],
            },
          ],
          'capabilities': {'tools': true, 'resources': true, 'prompts': true},
        },
      ],
    });

    expect(
      snapshot.servers.single.tools.single.localName,
      'mcp__notion__search__abc123',
    );
    expect(snapshot.servers.single.resources.single.mimeType, 'text/plain');
    expect(
      snapshot.servers.single.prompts.single.arguments.single.required,
      isTrue,
    );
    expect(snapshot.servers.single.capabilities.prompts, isTrue);
  });

  test('Group session preserves native board and injection state', () {
    final session = GroupSession.fromJson({
      'id': 'group-1',
      'topic': 'Release',
      'mode': 'discussion',
      'status': 'running',
      'createdAt': '2026-09-05T00:00:00Z',
      'maxParallelWorkers': 3,
      'members': [],
      'board': {'goal': 'Ship safely'},
      'boardUpdates': [
        {'field': 'goal', 'op': 'set'},
      ],
      'pendingInjections': [
        {
          'content': 'Check rollback',
          'targetAgentIds': ['reviewer'],
        },
      ],
      'activeMemberIds': ['reviewer'],
    });

    expect(session.createdAt, '2026-09-05T00:00:00Z');
    expect(session.maxParallelWorkers, 3);
    expect(session.board['goal'], 'Ship safely');
    expect(session.boardUpdates.single['field'], 'goal');
    expect(session.pendingInjections.single['content'], 'Check rollback');
    expect(session.activeMemberIds, ['reviewer']);
  });
}
