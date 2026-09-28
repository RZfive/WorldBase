export type AgentReasoningStrength = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export type AgentMemoryScope = 'user' | 'agent' | 'project' | 'group' | 'channel'

export type MemoryType = 'user_trait' | 'agent_skill' | 'step' | 'knowledge'

export type ConnectorType = 'feishu' | 'wechat' | 'wecom' | 'slack' | 'discord' | 'telegram' | 'custom'

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

export type AgentGroupCollaborationMode = 'coordinator_only' | 'targeted' | 'discussion' | 'coordinator_decides' | 'mentioned_agent_decides'

export type AgentGroupCollaborationPhase = 'planning' | 'executing' | 'completed'

export interface AgentGroupParticipant {
  agentId: string
  agentName: string
}

export interface AgentGroupCollaborationPlan {
  groupId: string
  groupName: string
  mode: AgentGroupCollaborationMode
  phase: AgentGroupCollaborationPhase
  planner: AgentGroupParticipant
  reportToName: string
  originalRequest: string
  normalizedRequest: string
  reason: string
  round?: number
  mentionedParticipants: AgentGroupParticipant[]
  candidateParticipants: AgentGroupParticipant[]
  invitedParticipants: AgentGroupParticipant[]
  updatedAt: string
}

export interface AgentGroupTranscriptToolCall {
  name: string
  /** Short human-readable summary of args/result, truncated. */
  summary: string
  status: 'completed' | 'failed'
}

export interface AgentGroupTranscriptEntry {
  id: string
  round: number
  agentId: string
  agentName: string
  content: string
  /** R8 · tool calls this member made while producing the entry. */
  toolCalls?: AgentGroupTranscriptToolCall[]
  /** R1 · peer messages this member sent/received while producing the entry. */
  peerMessages?: Array<{ toAgentName: string; request: string; response: string }>
  /** R6 · true if this entry is a direct reply to the user. */
  directReply?: boolean
  /** R2 · board fields this entry touched. */
  boardFields?: SharedBoardUpdate['field'][]
}

export interface AgentGroupTranscript {
  groupId: string
  groupName: string
  request: string
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
  request: string
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

export interface AgentSidechatSession {
  id: string
  groupId: string
  groupName: string
  agentId: string
  agentName: string
  mode: 'user_targeted' | 'coordinator_assigned' | 'group_deliberation' | 'peer_message' | 'direct_reply'
  initiatedByName: string
  reportToName: string
  request: string
  response: string
  status: 'running' | 'completed' | 'failed'
  round: number
  updatedAt: string
  error?: string
  progress: AgentGroupProgressStep[]
}

/**
 * R1 · A point-to-point message between two agents within a group session.
 * Carried by the GroupMessageBus. `fromAgentId` -> `toAgentId`, synchronous
 * request/response with a timeout. The bus records every envelope so the
 * transcript can replay who consulted whom.
 */
export interface AgentGroupMessage {
  id: string
  groupId: string
  fromAgentId: string
  fromAgentName: string
  toAgentId: string
  toAgentName: string
  request: string
  response: string
  status: 'pending' | 'completed' | 'failed' | 'timeout' | 'rejected'
  round: number
  createdAt: string
  resolvedAt?: string
  error?: string
}

/**
 * R2 · A field-level update to the shared board. Every write produces one of
 * these and is appended to an audit log; the board itself is merged field by
 * field so concurrent writers don't clobber each other's unrelated fields.
 */
export interface SharedBoardUpdate {
  id: string
  groupId: string
  agentId: string
  agentName: string
  field: 'goal' | 'assumptions' | 'tasks' | 'decisions' | 'evidenceRefs' | 'openQuestions'
  /** How the field should be applied. */
  op: 'set' | 'add' | 'update' | 'remove'
  /** Payload - shape depends on field+op (task objects for tasks, strings otherwise). */
  payload: unknown
  reason?: string
  at: string
}

/** R2 · A snapshot of the board plus its recent audit log, for UI rendering. */
export interface SharedBoardSnapshot {
  groupId: string
  groupName: string
  board: SharedBoard
  /** Recent updates, newest last. */
  recentUpdates: SharedBoardUpdate[]
  updatedAt: string
}

/**
 * R6 · A member's direct reply to the user, surfaced into the main conversation
 * stream instead of being relayed by the coordinator.
 */
export interface AgentGroupDirectReply {
  id: string
  groupId: string
  groupName: string
  agentId: string
  agentName: string
  /** The user-visible text the member wants to say directly. */
  content: string
  round: number
  /** True when the coordinator explicitly endorsed/forwarded this reply. */
  endorsed: boolean
  at: string
}

/** R5 · A user clarification injected mid-deliberation. */
export interface AgentGroupUserInjection {
  id: string
  groupId: string
  groupName: string
  content: string
  /** Agents that should receive the injection; empty = all active members. */
  targetAgentIds: string[]
  round: number
  at: string
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
  /** Lifecycle gate: only `active` entries participate in recall. */
  status?: MemoryEntryStatus
  /** Privacy hint; `sensitive` entries stay out of cross-scope recall. */
  sensitivity?: MemorySensitivity
  /** How many conversations/user confirmations back this entry. */
  evidenceCount?: number
  lastConfirmedAt?: string
  /** Expiry for phase-bound preferences; null means durable. */
  expiresAt?: string
}

export type MemoryEntryStatus = 'active' | 'pending_confirmation' | 'superseded' | 'deleted'

export type MemorySensitivity = 'normal' | 'sensitive'

export type EmbeddingDistanceMetric = 'cosine' | 'dot' | 'l2'

export type EmbeddingDocumentSourceType = 'memory' | 'conversation_summary' | 'decision' | 'chunk'

export type EmbeddingDocumentStatus = 'queued' | 'indexing' | 'indexed' | 'failed'

export type EmbeddingJobStatus = 'queued' | 'running' | 'succeeded' | 'retry' | 'failed' | 'canceled'

export type EmbeddingGenerationStatus = 'building' | 'active' | 'retired' | 'failed'

/**
 * An embedding model declared under a provider. Availability lives in the
 * provider config; Memory Settings picks which one is current. The model
 * itself is never bundled or downloaded — vectors come from the provider API.
 */
export interface ProviderEmbeddingModel {
  id: string
  /** Optional until first health probe pins the real dimension. */
  dimensions?: number
  maxInputTokens?: number
  distance?: EmbeddingDistanceMetric
  normalized?: boolean
  /** Input template prefix, e.g. `query: ` / `passage: `. Versioned via generation. */
  queryPrefix?: string
  documentPrefix?: string
  enabled?: boolean
}

/** Global "which embedding model does memory use right now" selection. */
export interface MemoryEmbeddingSettings {
  enabled: boolean
  providerId?: string
  modelId?: string
}

/**
 * Which chat model runs the AI memory-compaction plan. Empty ids mean
 * "follow the active chat provider/model" instead of a dedicated pick.
 */
export interface MemoryCompactionSettings {
  providerId?: string
  modelId?: string
}

/**
 * Per-request embedding runtime config handed from the host to the Rust
 * harness. Model selection and credentials stay with the host's Memory
 * Settings; the harness only acts as the provider API adapter (design §12/§17).
 */
export interface MemoryEmbeddingRuntimeConfig {
  providerId: string
  baseUrl: string
  apiKey: string
  modelId: string
  dimensions?: number
  distance?: EmbeddingDistanceMetric
  normalized?: boolean
  queryPrefix?: string
  documentPrefix?: string
}

/** Fingerprint of the embedding model backing one vector space. */
export interface EmbeddingModelDescriptor {
  providerId: string
  modelId: string
  modelRevision?: string
  dimensions: number
  distance: EmbeddingDistanceMetric
  normalized: boolean
  preprocessVersion: string
  queryPrefix?: string
  documentPrefix?: string
}

export interface EmbeddingHealth {
  ok: boolean
  dimensions?: number
  latencyMs?: number
  error?: string
}

export interface EmbeddingGenerationInfo {
  id: string
  providerId: string
  modelId: string
  modelRevision?: string
  dimensions: number
  distanceMetric: EmbeddingDistanceMetric
  normalized: boolean
  preprocessVersion: string
  indexPath: string
  status: EmbeddingGenerationStatus
  totalDocuments: number
  indexedDocuments: number
  failedDocuments: number
  createdAt: string
  activatedAt?: string
}

/** Renderer-facing snapshot of the semantic index pipeline. */
export interface MemoryIndexStatus {
  /** Master switch from Memory Settings. */
  embeddingEnabled: boolean
  /** True when provider+model resolve to a usable remote embedding service. */
  configured: boolean
  /** True when the sqlite-vec extension loaded in this runtime. */
  vectorAvailable: boolean
  providerId?: string
  modelId?: string
  dimensions?: number
  generation: EmbeddingGenerationInfo | null
  queue: { queued: number; running: number; failed: number }
  vectorDbPath: string | null
}

export interface MemorySearchScope {
  scopeType: AgentMemoryScope
  scopeId: string
}

export interface MemoryCompactionPlan {
  deleteIds?: string[]
  mergeGroups?: Array<{
    ids: string[]
    targetId?: string
    title?: string
    summary?: string
    details?: string
    tags?: string[]
  }>
  updates?: Array<{
    id: string
    title?: string
    summary?: string
    details?: string
    tags?: string[]
    importance?: number
    confidence?: number
  }>
}

export interface MemoryCompactionResult {
  scanned: number
  deleted: number
  removedUseless: number
  merged: number
  updated: number
  retained: number
  groups: Array<{
    targetId: string
    mergedIds: string[]
    title: string
  }>
}

export interface MemoryCompactionStatus {
  id: string | null
  status: 'idle' | 'running' | 'completed' | 'failed'
  stage: string
  detail?: string
  scanned: number
  totalChunks: number
  completedChunks: number
  startedAt?: string
  updatedAt: string
  finishedAt?: string
  result?: MemoryCompactionResult
  error?: string
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
  incomingWebhookPath: string
  credentialFields: Array<{
    key: keyof Pick<ChannelBinding, 'incomingSecret' | 'outgoingWebhookUrl' | 'appId' | 'appSecret' | 'verificationToken' | 'encryptKey' | 'botUserId'>
    label: string
    secret?: boolean
    placeholder?: string
  }>
}

export interface ChannelBinding {
  id: string
  connectorType: ConnectorType
  name?: string
  externalChannelId: string
  externalThreadId?: string
  boundConversationId?: string
  boundGroupId?: string
  defaultAgentId?: string
  targetProjectId?: string | null
  incomingSecret?: string
  outgoingWebhookUrl?: string
  appId?: string
  appSecret?: string
  verificationToken?: string
  encryptKey?: string
  botUserId?: string
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
