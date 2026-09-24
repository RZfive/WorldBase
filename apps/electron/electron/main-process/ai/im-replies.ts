import { randomUUID } from 'node:crypto'
import type { MessageContent } from '../../../src/main/ai-engine/providers/openai-provider.js'
import type { AgentDefinition, ChannelBinding, ChannelEvent } from '../../../src/shared/agent-workspace-types.js'
import { mainState } from '../state.js'
import { getLastUserMessageText, getMessageText } from '../chat-message-utils.js'
import { resolveAgentRuntimeContext } from './agent-context.js'
import { buildDirectGroupReplyPromptSection, parseGroupRouting, resolveDirectGroupReplyRoute } from './group-deliberation.js'
import { buildNativeRustGroupDeliberation } from './native-rust-group-deliberation.js'
import { startSelectedRustHarness } from './selected-execution-engine.js'
import type { RustChatOptions } from '../rust-harness-client.js'

export async function generateImGatewayReply (binding: ChannelBinding, event: ChannelEvent): Promise<string | null> {
  // Rust is the only execution backend.
  const rustHarness = await startSelectedRustHarness()
  if (!rustHarness) return null

  const userLabel = event.senderName || event.senderId || 'external user'
  const messages: Array<{ role: string; content: MessageContent }> = [
    {
      role: 'user',
      content: [
        `来自 ${binding.connectorType} / ${event.channelId}${event.threadId ? ` / ${event.threadId}` : ''}`,
        `发送者：${userLabel}`,
        '',
        event.text
      ].join('\n')
    }
  ]
  const runtimeContext = await resolveAgentRuntimeContext({
    messages,
    agentId: binding.defaultAgentId,
    groupId: binding.boundGroupId,
    channelBindingId: binding.id,
    requestedTargetProjectId: binding.targetProjectId || undefined
  })
  const groupRouting = runtimeContext.group
    ? parseGroupRouting(runtimeContext.group, getLastUserMessageText(messages))
    : null
  const directGroupReply = resolveDirectGroupReplyRoute(runtimeContext.group, messages, groupRouting)
  const groupDeliberation = runtimeContext.group && !directGroupReply
    ? await buildNativeImGroupDeliberation({
        binding,
        event,
        messages,
        planner: rustHarness,
        group: runtimeContext.group,
        routing: groupRouting || parseGroupRouting(runtimeContext.group, getLastUserMessageText(messages)),
        targetProjectId: runtimeContext.effectiveTargetProjectId,
        enableThinking: runtimeContext.providerConfig?.enableThinking,
        reasoningEffort: runtimeContext.providerConfig?.reasoningEffort,
        temperature: runtimeContext.providerConfig?.temperature,
        activeSkillContents: runtimeContext.activeSkillContents,
        systemPromptSections: runtimeContext.systemPromptSections,
        runtimeMemoryScopes: runtimeContext.memoryScopes,
        runtimeMemoryEmbedding: runtimeContext.memoryEmbedding
      })
    : { promptSection: null, transcript: null }

  const requestOptions = {
    agentId: runtimeContext.agent?.id || binding.defaultAgentId,
    targetProjectId: runtimeContext.effectiveTargetProjectId,
    providerConfig: runtimeContext.providerConfig,
    activeSkillContents: runtimeContext.activeSkillContents,
    systemPromptSections: [
      ...runtimeContext.systemPromptSections,
      '## IM reply instructions\nReply concisely for the external chat. Do not mention internal routing unless the user asked.',
      ...(directGroupReply ? [buildDirectGroupReplyPromptSection(directGroupReply)] : []),
      ...(groupDeliberation.promptSection ? [groupDeliberation.promptSection] : [])
    ],
    allowedToolNames: runtimeContext.allowedToolNames,
    deniedToolNames: runtimeContext.deniedToolNames
  }
  const response = await rustHarness.chat(messages, requestOptions)
  const reply = getMessageText(response.content).trim()

  // Memory is Rust-owned: ingest through harness RPC (design §12).
  if (reply && mainState.rustHarness) {
    try {
      await mainState.rustHarness.ingestMemory({
        agent: runtimeContext.agent,
        scopes: runtimeContext.memoryScopes,
        userMessages: [event.text],
        finalAssistantText: reply,
        toolNames: [],
        sourceConversationId: binding.boundConversationId,
        sourceSessionId: `im_${binding.id}_${event.messageId}`
      })
    } catch (memoryError) {
      console.error('[im] Failed to ingest memory:', memoryError)
    }
  }

  return reply || null
}

async function buildNativeImGroupDeliberation (input: {
  binding: ChannelBinding
  event: ChannelEvent
  messages: Array<{ role: string; content: MessageContent }>
  planner: NonNullable<typeof mainState.rustHarnessEngine>
  group: NonNullable<Awaited<ReturnType<typeof resolveAgentRuntimeContext>>['group']>
  routing: NonNullable<ReturnType<typeof parseGroupRouting>>
  targetProjectId: string | null
  enableThinking?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  temperature?: number
  activeSkillContents: string[]
  systemPromptSections: string[]
  runtimeMemoryScopes: NonNullable<RustChatOptions['memoryScopes']>
  runtimeMemoryEmbedding?: RustChatOptions['memoryEmbedding']
}) {
  const client = mainState.rustHarness
  if (!client) throw new Error('Rust harness client is not initialized.')
  const groupAgentIds = Array.from(new Set([
    input.group.coordinatorAgentId,
    ...input.group.memberAgentIds
  ]))
  const agents = groupAgentIds
    .map(id => mainState.agentStore?.get(id))
    .filter((agent): agent is AgentDefinition => Boolean(agent))
  // Each Rust member receives its own synced persona. Keep only shared
  // channel/group/memory context so the coordinator persona does not leak
  // into other members' native runs.
  const sharedSections = input.systemPromptSections.filter(section => !section.startsWith('## Active custom agent'))
  return await buildNativeRustGroupDeliberation({
    client,
    planner: input.planner,
    group: input.group,
    agents,
    messages: input.messages,
    routing: input.routing,
    sessionId: `im-rust-group-${input.binding.id}-${input.event.messageId}-${randomUUID()}`,
    context: {
      targetProjectId: input.targetProjectId,
      enableThinking: input.enableThinking,
      reasoningEffort: input.reasoningEffort,
      temperature: input.temperature,
      systemPromptSections: sharedSections,
      activeSkillContents: input.activeSkillContents,
      memoryScopes: input.runtimeMemoryScopes,
      memoryQuery: getLastUserMessageText(input.messages),
      memoryEmbedding: input.runtimeMemoryEmbedding
    }
  })
}

