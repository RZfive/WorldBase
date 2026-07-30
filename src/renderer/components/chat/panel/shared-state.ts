import { reactive, ref } from 'vue'
import type {
  AgentDefinition,
  AgentGroupDefinition,
  AIExecutionAuthMode,
  AskUserRequestPayload,
  AuthRequestPayload,
  BackgroundStreamState,
  ChannelBinding,
  ChatMessage,
  ConversationSummary,
  FilePreviewState,
  PendingAttachment,
  PendingImage,
  ProviderOption,
  ProvidersConfig,
  ReasoningStrength,
  SkillItem,
  SudoPasswordRequestPayload
} from './types'
import {
  DEFAULT_DOCUMENT_WORKSPACE_WIDTH,
  DEFAULT_FOLDER_WORKSPACE_WIDTH
} from './workspace-state'

export const DEFAULT_REASONING_STRENGTH: ReasoningStrength = 'max'

export const sharedChatPanelState = {
  messages: ref<ChatMessage[]>([]),
  inputText: ref(''),
  conversations: ref<ConversationSummary[]>([]),
  conversationsLoaded: ref(false),
  currentConversationId: ref<string | null>(null),
  targetProjectId: ref<string | null>(null),
  providers: ref<ProviderOption[]>([]),
  providersConfig: ref<ProvidersConfig>({
    providers: [],
    activeProviderId: '',
    enabledProviderIds: []
  }),
  activeProviderId: ref(''),
  selectedModel: ref(''),
  reasoningStrength: ref<ReasoningStrength>(DEFAULT_REASONING_STRENGTH),
  conversationTemperature: ref<number | null>(null),
  currentAuthMode: ref<AIExecutionAuthMode>('strict'),
  pendingImages: ref<PendingImage[]>([]),
  pendingFiles: ref<PendingAttachment[]>([]),
  isUploadingFiles: ref(false),
  uploadFeedback: ref(''),
  filePreview: ref<FilePreviewState>({
    active: false,
    filePath: '',
    lineCount: 0,
    added: 0,
    removed: 0
  }),
  availableSkills: ref<SkillItem[]>([]),
  activeSkillIds: ref<Set<string>>(new Set()),
  availableAgents: ref<AgentDefinition[]>([]),
  availableAgentGroups: ref<AgentGroupDefinition[]>([]),
  availableChannelBindings: ref<ChannelBinding[]>([]),
  longTermGoals: ref<LongTermGoalDefinition[]>([]),
  longTermGoalSnapshot: ref<LongTermGoalSnapshot | null>(null),
  selectedLongTermGoalId: ref<string | null>(null),
  selectedAgentId: ref(''),
  selectedGroupId: ref(''),
  selectedChannelBindingId: ref(''),
  showSkillPicker: ref(false),
  planModeActive: ref(false),
  syncingProviderOptions: ref(false),
  documentDockVisible: ref(false),
  documentWorkspaceDocuments: ref<ConversationDocumentReference[]>([]),
  documentWorkspaceActiveFilePath: ref<string | null>(null),
  documentWorkspaceWidth: ref(DEFAULT_DOCUMENT_WORKSPACE_WIDTH),
  folderWorkspaceVisible: ref(false),
  folderWorkspaceRootPath: ref<string | null>(null),
  folderWorkspaceRootName: ref<string | null>(null),
  folderWorkspaceActiveFilePath: ref<string | null>(null),
  folderWorkspaceWidth: ref(DEFAULT_FOLDER_WORKSPACE_WIDTH),
  streamingConversationIds: reactive(new Set<string>()),
  pendingAuthRequestsByConversation: reactive(new Map<string, AuthRequestPayload[]>()),
  pendingSudoPasswordRequestsByConversation: reactive(new Map<string, SudoPasswordRequestPayload[]>()),
  pendingAskUserRequestsByConversation: reactive(new Map<string, AskUserRequestPayload[]>()),
  unreadConversationIds: reactive(new Set<string>()),
  backgroundStreamMessages: new Map<string, BackgroundStreamState>(),
  activeCleanups: new Map<string, () => void>(),
  activeStreamSessionIds: new Map<string, string>(),
  conversationTargets: new Map<string, string | null>()
}

export const sharedChatPanelLifecycle = {
  providerChangeCleanup: null as (() => void) | null,
  authRequestCleanup: null as (() => void) | null,
  sudoPasswordRequestCleanup: null as (() => void) | null,
  askUserRequestCleanup: null as (() => void) | null,
  authResponseCleanup: null as (() => void) | null,
  authResolvedCleanup: null as (() => void) | null,
  skillsChangedCleanup: null as (() => void) | null,
  agentWorkspaceChangeCleanup: null as (() => void) | null,
  longTermGoalsCleanup: null as (() => void) | null,
  longTermGoalSnapshotCleanup: null as (() => void) | null,
  longTermGoalInterventionCleanup: null as (() => void) | null,
  longTermGoalRunProgressCleanup: null as (() => void) | null,
  bindingsReady: false,
  beforeUnloadCleanupRegistered: false
}

export function cleanupSharedChatPanelResources (): void {
  for (const cleanup of sharedChatPanelState.activeCleanups.values()) cleanup()
  sharedChatPanelState.activeCleanups.clear()
  sharedChatPanelState.activeStreamSessionIds.clear()

  const lifecycle = sharedChatPanelLifecycle
  lifecycle.providerChangeCleanup?.()
  lifecycle.authRequestCleanup?.()
  lifecycle.sudoPasswordRequestCleanup?.()
  lifecycle.askUserRequestCleanup?.()
  lifecycle.authResolvedCleanup?.()
  lifecycle.skillsChangedCleanup?.()
  lifecycle.agentWorkspaceChangeCleanup?.()
  lifecycle.longTermGoalsCleanup?.()
  lifecycle.longTermGoalSnapshotCleanup?.()
  lifecycle.longTermGoalInterventionCleanup?.()
  lifecycle.longTermGoalRunProgressCleanup?.()
  lifecycle.authResponseCleanup?.()

  lifecycle.providerChangeCleanup = null
  lifecycle.authRequestCleanup = null
  lifecycle.sudoPasswordRequestCleanup = null
  lifecycle.askUserRequestCleanup = null
  lifecycle.authResolvedCleanup = null
  lifecycle.skillsChangedCleanup = null
  lifecycle.agentWorkspaceChangeCleanup = null
  lifecycle.longTermGoalsCleanup = null
  lifecycle.longTermGoalSnapshotCleanup = null
  lifecycle.longTermGoalInterventionCleanup = null
  lifecycle.longTermGoalRunProgressCleanup = null
  lifecycle.authResponseCleanup = null
  lifecycle.bindingsReady = false
  lifecycle.beforeUnloadCleanupRegistered = false
}
