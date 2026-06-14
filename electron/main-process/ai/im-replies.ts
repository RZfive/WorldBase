import type { MessageContent } from '../../../src/main/ai-engine/providers/openai-provider.js'
import type { ChannelBinding, ChannelEvent } from '../../../src/shared/agent-workspace-types.js'
import { mainState } from '../state.js'
import { getMessageText } from '../chat-message-utils.js'
import { resolveAgentRuntimeContext } from './agent-context.js'
import { buildDirectGroupReplyPromptSection, buildGroupDeliberationSection, parseGroupRouting, resolveDirectGroupReplyRoute } from './group-deliberation.js'

export async function generateImGatewayReply (binding: ChannelBinding, event: ChannelEvent): Promise<string | null> {
  if (!mainState.aiEngine) return null

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
  const runtimeContext = resolveAgentRuntimeContext({
    messages,
    agentId: binding.defaultAgentId,
    groupId: binding.boundGroupId,
    channelBindingId: binding.id,
    requestedTargetProjectId: binding.targetProjectId || undefined
  })
  const groupRouting = runtimeContext.group
    ? parseGroupRouting(runtimeContext.group, event.text)
    : null
  const directGroupReply = resolveDirectGroupReplyRoute(runtimeContext.group, messages, groupRouting)
  const groupDeliberation = runtimeContext.group && !directGroupReply
    ? await buildGroupDeliberationSection({
        messages,
        group: runtimeContext.group,
        routing: groupRouting || undefined,
        channelBinding: runtimeContext.channelBinding,
        targetProjectId: runtimeContext.effectiveTargetProjectId,
        fallbackReasoningStrength: runtimeContext.agent?.reasoningStrength || 'medium'
      })
    : { promptSection: null, transcript: null }

  const response = await mainState.aiEngine.chat(messages, {
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
  })
  const reply = getMessageText(response.content).trim()

  if (reply && mainState.memoryEngine) {
    try {
      mainState.memoryEngine.ingestSessionMemory({
        agent: runtimeContext.agent,
        group: runtimeContext.group,
        channelBinding: runtimeContext.channelBinding,
        userMessages: [event.text],
        finalAssistantText: reply,
        toolNames: [],
        targetProjectId: runtimeContext.effectiveTargetProjectId,
        sourceConversationId: binding.boundConversationId,
        sourceSessionId: `im_${binding.id}_${event.messageId}`,
        userId: event.senderId || 'external-user',
        enabledScopeTypes: runtimeContext.agent?.memoryScopes
      })
    } catch (memoryError) {
      console.error('[im] Failed to ingest memory:', memoryError)
    }
  }

  return reply || null
}
