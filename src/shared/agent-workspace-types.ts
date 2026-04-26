export type AgentReasoningStrength = 'low' | 'medium' | 'high' | 'max'

export type AgentMemoryScope = 'user' | 'agent' | 'project' | 'group' | 'channel'

export type MemoryType = 'user_trait' | 'agent_skill' | 'step' | 'knowledge'

export type ConnectorType = 'feishu' | 'wecom' | 'slack' | 'discord' | 'telegram' | 'custom'

export interface AgentMemoryWritePolicy {
  allowUserTraits: boolean
  allowAgentSkills: boolean
  allowSteps: boolean
  allowKnowledge: boolean
}

export interface AgentAutoReplyPolicy {
  enabled: boolean
  requireMention: boolean
}

export interface AgentDefinition {
  id: string
  name: string
  icon?: string
  description: string
  systemPrompt: string
  providerId?: string
  modelId?: string
  reasoningStrength?: AgentReasoningStrength
  skillIds: string[]
  allowedTools?: string[]
  deniedTools?: string[]
  memoryScopes: AgentMemoryScope[]
  memoryWritePolicy: AgentMemoryWritePolicy
  autoReplyPolicy?: AgentAutoReplyPolicy
  createdAt: string
  updatedAt: string
}

export interface AgentGroupDefinition {
  id: string
  name: string
  icon?: string
  description?: string
  coordinatorAgentId: string
  memberAgentIds: string[]
  maxRounds: number
  maxParallelWorkers: number
  sharedMemoryScopes: Array<'group' | 'project' | 'channel'>
  visibility: 'summary_only' | 'expandable_internal_transcript'
  createdAt: string
  updatedAt: string
}

export interface AgentGroupTranscriptEntry {
  id: string
  round: number
  agentId: string
  agentName: string
  content: string
}

export interface AgentGroupTranscript {
  groupId: string
  groupName: string
  visibility: AgentGroupDefinition['visibility']
  roundCount: number
  entryCount: number
  summary: string
  entries: AgentGroupTranscriptEntry[]
}

export interface AgentGroupProgressStep {
  at: string
  stage: string
  detail?: string
}

export interface AgentGroupProgressItem {
  id: string
  agentId: string
  agentName: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  currentRound: number
  completedRounds: number
  totalRounds: number
  stage: string
  detail?: string
  summary?: string
  updatedAt: string
  progress: AgentGroupProgressStep[]
}

export interface AgentGroupProgressSnapshot {
  groupId: string
  groupName: string
  status: 'running' | 'completed' | 'failed'
  activeRound: number
  totalRounds: number
  maxParallelWorkers: number
  queuedCount: number
  runningCount: number
  completedCount: number
  failedCount: number
  items: AgentGroupProgressItem[]
}

export interface SharedBoardTask {
  id: string
  title: string
  ownerAgentId?: string
  status: 'todo' | 'running' | 'blocked' | 'done'
  summary?: string
}

export interface SharedBoard {
  goal: string
  assumptions: string[]
  tasks: SharedBoardTask[]
  decisions: string[]
  evidenceRefs: string[]
  openQuestions: string[]
}

export interface MemoryEntry {
  id: string
  scopeType: AgentMemoryScope
  scopeId: string
  memoryType: MemoryType
  title: string
  summary: string
  details?: string
  tags: string[]
  sourceConversationId?: string
  sourceSessionId?: string
  sourceMessageIds?: string[]
  importance: number
  confidence: number
  pinned: boolean
  lastUsedAt?: string
  createdAt: string
  updatedAt: string
}

export interface MemorySearchScope {
  scopeType: AgentMemoryScope
  scopeId: string
}

export interface MemoryPromptContext {
  sections: string[]
  entries: MemoryEntry[]
}

export interface ConnectorDefinition {
  id: ConnectorType
  name: string
  description: string
  supportsThreads: boolean
  supportsMentions: boolean
  supportsAttachments: boolean
}

export interface ChannelBinding {
  id: string
  connectorType: ConnectorType
  externalChannelId: string
  externalThreadId?: string
  boundConversationId?: string
  boundGroupId?: string
  defaultAgentId?: string
  targetProjectId?: string | null
  autoReply: boolean
  requireApprovalForRiskyTools: boolean
  createdAt: string
  updatedAt: string
}

export interface ChannelEventAttachment {
  name: string
  mimeType: string
  localPath?: string
}

export interface ChannelEvent {
  connectorType: ConnectorType
  channelId: string
  threadId?: string
  messageId: string
  senderId: string
  senderName?: string
  text: string
  attachments?: ChannelEventAttachment[]
  mentions?: string[]
  createdAt: string
}