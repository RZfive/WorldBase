import { randomUUID } from 'node:crypto'
import type { MessageContent } from '../../../src/main/ai-harness/contracts.js'
import type { AgentDefinition, ChannelBinding, ChannelEvent } from '../../../src/shared/agent-workspace-types.js'
import { mainState } from '../state.js'
import { getMessageText } from '../chat-message-utils.js'
import { resolveAgentRuntimeContext } from './agent-context.js'
import { formatRoomReplies, runNativeRoom } from './native-rust-room.js'
import { startSelectedRustHarness } from './selected-execution-engine.js'

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
  const group = runtimeContext.group
  if (group) {
    const client = mainState.rustHarness
    if (!client) throw new Error('Rust harness client is not initialized.')
    const replies = await runNativeRoom({
      client,
      hostTools: rustHarness,
      group,
      agents: [group.coordinatorAgentId, ...group.memberAgentIds]
        .map(id => mainState.agentStore?.get(id))
        .filter((agent): agent is AgentDefinition => Boolean(agent)),
      messages,
      sessionId: `im-rust-room-${binding.id}-${event.messageId}-${randomUUID()}`,
      context: {
        authMode: 'strict',
        targetProjectId: runtimeContext.effectiveTargetProjectId,
        enableThinking: runtimeContext.providerConfig?.enableThinking,
        reasoningEffort: runtimeContext.providerConfig?.reasoningEffort,
        temperature: runtimeContext.providerConfig?.temperature,
        systemPromptSections: [
          ...runtimeContext.systemPromptSections.filter(section => !section.startsWith('## Active custom agent')),
          '## IM reply instructions\nReply concisely for the external chat as yourself.'
        ],
        memoryScopes: runtimeContext.memoryScopes,
        memoryEmbedding: runtimeContext.memoryEmbedding
      }
    })
    return formatRoomReplies(replies) || null
  }

  const requestOptions = {
    agentId: runtimeContext.agent?.id || binding.defaultAgentId,
    targetProjectId: runtimeContext.effectiveTargetProjectId,
    providerConfig: runtimeContext.providerConfig,
    activeSkillContents: runtimeContext.activeSkillContents,
    systemPromptSections: [
      ...runtimeContext.systemPromptSections,
      '## IM reply instructions\nReply concisely for the external chat. Do not mention internal routing unless the user asked.'
    ],
    allowedToolNames: runtimeContext.allowedToolNames,
    deniedToolNames: runtimeContext.deniedToolNames,
    memoryScopes: runtimeContext.memoryScopes,
    memoryEmbedding: runtimeContext.memoryEmbedding
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

