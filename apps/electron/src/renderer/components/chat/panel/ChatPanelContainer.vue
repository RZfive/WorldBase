<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ConversationSidebar from '../layout/ConversationSidebar.vue'
import ConversationOrganizeDialog from '../layout/ConversationOrganizeDialog.vue'
import { loadConversationGroupingMode, resolveTimeBucket, type SidebarProjectInfo } from '../layout/useConversationSidebarGrouping'
import type { ConversationGroupingMode } from '../layout/ConversationSidebar.types'
import SidebarIcon from '../layout/SidebarIcon.vue'
import MessageList from '../messages/MessageList.vue'
import EmptyStateSuggestions from '../messages/EmptyStateSuggestions.vue'
import ChatInput from '../layout/ChatInput.vue'
import ChatHeader from '../layout/ChatHeader.vue'
import QuickAskPopover from '../layout/QuickAskPopover.vue'
import { generateId } from './message-blocks'
import WorkspacePanel from '../../workspace/WorkspacePanel.vue'
import PinnedTodoPanel from '../layout/PinnedTodoPanel.vue'
import AskUserPanel from '../layout/AskUserPanel.vue'
import AuthPermissionPanel from '../layout/AuthPermissionPanel.vue'
import SudoPasswordPanel from '../layout/SudoPasswordPanel.vue'
import LongTermGoalPanel from '../layout/LongTermGoalPanel.vue'
import { useChatPanel } from './useChatPanel'
import { createAttentionAccordion, type AttentionPanelId } from './attention-accordion'
import {
  dailySuggestionSnapshot,
  dismissDailySuggestion,
  ensureDailySuggestionSubscription,
  knowledgeShuffling,
  loadDailySuggestions,
  markDailySuggestionsSeen,
  recordDailySuggestionPick,
  refreshKnowledgeSuggestionCard,
  shuffleKnowledgeSuggestion
} from './suggestion-state'
import type { WorkSuggestion } from '../../../../shared/daily-suggestion-types.js'
import { getRecommendedProviderTemplate } from '../../../../shared/provider-templates.js'
import { resolveModelStrength } from '../../../../shared/reasoning-effort'
import type { ChatPanelEmit, ChatPanelProps, SidebarConversationItem } from './types'
import type { AnnotationAnchor, MessageAnnotationLocator, QuickAskMode, QuickAskPopoverState } from '../types'
import {
  activateWorkspaceTab,
  applyWorkspaceControlToSnapshot,
  buildCurrentFolderWorkspaceState,
  buildWorkspaceTabSummaries,
  buildWorkspaceTabSummary,
  ensureWorkspaceTab,
  findWorkspaceTabs,
  getActiveWorkspaceTab,
  getDocumentTabFilePath,
  getDocumentTabs,
  getWorkspaceDocumentDraft,
  hydrateWorkspaceSnapshot,
  openWorkspaceTabInSnapshot,
  removeWorkspaceTab,
  stageWorkspaceDocumentDraft,
  workspaceBrowserSurfaces,
  workspaceStore,
  workspaceTerminalSurfaces
} from '../../workspace/workspace-store'
import { createWorkspaceTabId, getWorkspaceTabDefinition, type WorkspaceTabInstance } from '../../workspace/tab-registry'
import { resolveWorkRunContext } from './work-run-context'
import type {
  WorkspaceTabControlRequest,
  WorkspaceTabControlRequestEnvelope,
  WorkspaceTabControlResponseEnvelope,
  WorkspaceTabControlResult
} from '../../../../shared/workspace-control-types.js'

const props = defineProps<ChatPanelProps>()
const emit = defineEmits<ChatPanelEmit>()
const { t } = useI18n()

const autoFocusedCodingDiffAt = new Map<string, number>()

const DEFAULT_APP_WINDOW_MIN_WIDTH = 800
const CONVERSATION_SIDEBAR_WIDTH = 224
const CONVERSATION_SIDEBAR_COLLAPSED_WIDTH = 0
const MIN_CHAT_MAIN_WIDTH = 640
/** Fallbacks when the active tab kind defines no explicit bounds. */
const MIN_WORKSPACE_WIDTH_FALLBACK = 792
const MAX_WORKSPACE_WIDTH_FALLBACK = 1320
const WORKSPACE_OPEN_ANIMATION_DURATION_MS = 240

const {
  activeGroupSessionId,
  activeProviderId,
  activeSkillIds,
  activeTodoItems,
  addSelectionQuoteToInput,
  agentSelectorValue,
  agentSidebarItems,
  availableChannelBindings,
  availableSkills,
  conversationsLoaded,
  conversationSidebarItems,
  conversationDetailError,
  conversationDetailState,
  createLongTermGoal,
  currentAuthMode,
  currentAskUserRequest,
  currentAssistantIcon,
  currentAssistantName,
  currentCodingDiff,
  currentCodingStatus,
  currentContextDetail,
  currentContextLabel,
  currentConversationId,
  targetProjectId,
  currentLongTermGoal,
  currentPendingAuthCount,
  currentPendingAuthRequest,
  currentPendingSudoPasswordCount,
  currentSudoPasswordRequest,
  deleteConversation,
  deleteLongTermGoal,
  filePreview,
  groupMentionHints,
  groupSidebarItems,
  longTermGoalSidebarItems,
  longTermGoalSnapshot,
  handleAgentSelectionChange,
  handleAuthModeChange,
  handleChannelBindingSelectionChange,
  handleProviderModelSelectionChange,
  handleReasoningStrengthChange,
  handleTemperatureChange,
  inputText,
  insertDocumentTag,
  isGroupConversation,
  isLoading,
  isUploadingFiles,
  loadConversation,
  openLongTermGoal,
  messages,
  newConversation,
  nonDefaultAgents,
  openAgentWorkspaceConversation,
  openGroupWorkspaceConversation,
  pauseLongTermGoal,
  pendingFiles,
  pendingImages,
  planModeActive,
  computerUseEnabled,
  computerUsePermissionGranted,
  providers,
  providersConfig,
  providerDefaultTemperature,
  conversationTemperature,
  reasoningStrength,
  renameConversation,
  removeFile,
  removeImage,
  removeMessageAnnotation,
  upsertAnnotationTurns,
  resumeLongTermGoal,
  runLongTermGoalNow,
  archiveLongTermGoal,
  saveLongTermGoalPatch,
  respondToAuthRequest,
  respondToSudoPasswordRequest,
  respondToAskUserRequest,
  cancelEditMessage,
  editUserMessage,
  editingMessageId,
  forkFromMessage,
  selectedChannelBindingId,
  selectedGroupId,
  selectedModel,
  selectAllSkills,
  sendMessage,
  sendLongTermGoalMessage,
  startLongTermGoalCreation,
  longTermGoalWorkspaceActive,
  startEditUserMessage,
  compactLongTermGoalMemory,
  deleteLongTermGoalMemory,
  applyLongTermGoalChangeSet,
  cancelLongTermGoalChangeSet,
  applyLongTermGoalCreation,
  cancelLongTermGoalCreation,
  resetLongTermGoalCreation,
  pendingCreationConfirm,
  answerLongTermGoalIntervention,
  streamingAdjust,
  streamingCreate,
  streamingRun,
  streamingReplan,
  memoryCompaction,
  createConversationHistory,
  goalAutoOpenRunId,
  clearGoalAutoOpenRunId,
  shouldUseConversationProviderOverride,
  showSkillPicker,
  stopCurrentStream,
  retryLastUserMessage,
  togglePlanMode,
  toggleComputerUse,
  toggleSkill,
  clearSkills,
  updateFolderWorkspaceState,
  updateWorkspaceTabState,
  getConversationProject,
  assignConversationProject,
  startProjectConversation,
  startBlankConversation,
  backgroundStreamMessages,
  updateBackgroundConversationWorkspace,
  uploadFeedback,
  addAttachments
} = useChatPanel(props, {
  onContextConsumed: () => emit('contextConsumed')
})

// Quick Q&A over a text selection: an inline popover anchored next to the
// text. The first answer creates the annotation; the popover stays open as a
// thread so the user can keep asking in 简略/详细 depth.
const quickAskState = ref<QuickAskPopoverState | null>(null)

// The strength control renders the shared resolver's view of the active
// model: gateway-declared levels narrowed by the user's allowed multi-pick,
// standard eight when undeclared. Switching models swaps the choices with
// the model.
const activeModelReasoningEfforts = computed<string[]>(() => {
  const provider = providersConfig.value.providers.find(item => item.id === activeProviderId.value)
  return resolveModelStrength(provider?.modelCapabilities?.[selectedModel.value], {
    current: reasoningStrength.value
  }).levels
})

function handleAddSelectionToContext (text: string): void {
  addSelectionQuoteToInput(text)
}

function handleOpenQuickAsk (payload: { text: string; locator?: MessageAnnotationLocator; messageId: string | null; messageIndex: number; anchor: AnnotationAnchor }): void {
  quickAskState.value = {
    mode: 'ask',
    text: payload.text,
    locator: payload.locator,
    messageId: payload.messageId,
    messageIndex: payload.messageIndex,
    anchor: payload.anchor,
    annotationId: null,
    turns: []
  }
}

function handleOpenAnnotationThread (payload: { messageId: string | null; messageIndex: number; annotationId: string; anchor: AnnotationAnchor }): void {
  let message = null as typeof messages.value[number] | null
  if (payload.messageId) {
    message = messages.value.find(item => item.id === payload.messageId) || null
  }
  if (!message && payload.messageIndex >= 0 && payload.messageIndex < messages.value.length) {
    message = messages.value[payload.messageIndex]
  }
  const annotation = message?.annotations?.find(item => item.id === payload.annotationId)
  if (!annotation) return
  quickAskState.value = {
    mode: 'thread',
    text: annotation.text,
    locator: annotation.locator,
    messageId: payload.messageId,
    messageIndex: payload.messageIndex,
    anchor: payload.anchor,
    annotationId: annotation.id,
    turns: annotation.turns.map(turn => ({ ...turn }))
  }
}

function handleCloseQuickAsk (): void {
  quickAskState.value = null
}

function handleQuickAskAsk (payload: { question: string; mode: QuickAskMode }): void {
  void handleQuickAskFlight(payload)
}

/** Owns one quickAsk flight: creates the annotation immediately with a
    pending turn (highlight + hover state appear at once), then fills in the
    answer. Dismissing the popover never cancels it. */
async function handleQuickAskFlight (payload: { question: string; mode: QuickAskMode }): Promise<void> {
  const state = quickAskState.value
  if (!state) return
  if (state.turns.some(turn => turn.status === 'generating')) return
  // Pending turns live in the in-memory message list; if the user switches
  // conversations mid-flight both the pending turn and this result are gone.
  const flightConversationId = currentConversationId.value

  const annotationId = state.annotationId || generateId()
  const pendingTurn = { question: payload.question, answer: '', mode: payload.mode, status: 'generating' as const, startedAt: Date.now() }
  const nextTurns = [...state.turns, pendingTurn]

  // In-memory only: persisted once the turn resolves.
  upsertAnnotationTurns({
    messageId: state.messageId,
    messageIndex: state.messageIndex,
    annotationId,
    text: state.text,
    locator: state.locator,
    turns: nextTurns
  }, false)
  quickAskState.value = { ...state, mode: 'thread', annotationId, turns: nextTurns }

  let result: { ok: boolean; answer?: string; error?: string }
  if (window.electronAPI?.quickAsk) {
    try {
      result = await window.electronAPI.quickAsk({
        question: pendingTurn.question,
        selection: state.text,
        mode: payload.mode,
        // Follow the provider/model the main conversation is using (the same
        // selection the header shows, agent-synced included). Empty values let
        // main resolve its default.
        providerId: activeProviderId.value || undefined,
        model: selectedModel.value || undefined,
        // Keep this one-shot completion on the session's config header:
        // models reject effort values outside their own set (glm-5.3-flash
        // only accepts low/high/max).
        reasoningStrength: reasoningStrength.value,
        temperature: conversationTemperature.value ?? undefined
      })
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : t('chatUi.quickAskFailed') }
    }
  } else {
    result = { ok: false, error: t('chatUi.quickAskUnsupported') }
  }

  const resolvedTurn = result.ok && result.answer
    ? { ...pendingTurn, answer: result.answer, status: 'done' as const }
    : { ...pendingTurn, status: 'error' as const, error: result.error || t('chatUi.quickAskFailed') }

  // Conversation switched while generating: the pending turn died with the old
  // message list, so drop the result instead of writing into the new one.
  if (currentConversationId.value !== flightConversationId) return

  const finalTurns = [...nextTurns.slice(0, -1), resolvedTurn]

  upsertAnnotationTurns({
    messageId: state.messageId,
    messageIndex: state.messageIndex,
    annotationId,
    text: state.text,
    locator: state.locator,
    turns: finalTurns
  }, true)
  // The popover may have been dismissed or re-anchored meanwhile.
  if (quickAskState.value?.annotationId === annotationId) {
    quickAskState.value = { ...quickAskState.value, turns: finalTurns }
  }
}

const chatSurfaceStatus = computed(() => ({
  contextLabel: currentContextLabel.value,
  contextDetail: currentContextDetail.value,
  isLoading: isLoading.value,
  pendingAuthCount: currentPendingAuthCount.value,
  activeTodoCount: activeTodoItems.value.length,
  primaryTaskTitle: activeTodoItems.value[0]?.title || null
}))
const isOpeningWorkspace = ref(false)
const isClosingWorkspace = ref(false)
const chatWindowWidthBeforeWorkspace = ref<number | null>(null)
const CONVERSATION_SIDEBAR_COLLAPSE_STORAGE_KEY = 'chat-conversation-sidebar-collapsed'

// The composer ref is also used by the shell to focus the textarea when a
// workspace surface asks for input. Keep the ref at the component boundary;
// layout sizing is intentionally handled by normal flex flow below.
const messageListRef = ref<{ scrollToBottom?: () => void } | null>(null)
const bottomDockRef = ref<HTMLElement | null>(null)
const inputCardInset = ref(0)
let bottomDockObserver: ResizeObserver | null = null
const chatInputRef = ref<{ $el?: HTMLElement } | null>(null)
let offPlanModeChanged: (() => void) | null = null

onMounted(() => {
  // Project index feeds the sidebar's project grouping and the "open project"
  // actions; it must exist before the first mode switch, not only when the
  // empty-state suggestions happen to render.
  void refreshProjectIndex()
  window.addEventListener('keydown', onSidebarShortcut)
  // Plan mode can also end from the model side (native exit_plan_mode); keep
  // the toggle truthful so the next turn does not silently re-enter planning.
  offPlanModeChanged = window.electronAPI?.onPlanModeChanged?.((active) => {
    planModeActive.value = active
  }) ?? null
})

// Attention-zone accordion: instead of stacking every pending capsule
// expanded — which pushed the pile arbitrarily far up the message list —
// exactly one panel shows its detail (highest-priority actionable request
// by default, or the one the user picked on its strip) and the rest stay
// collapsed. Any new request id surfaces again by clearing the pick.
const pendingAttentionPanels = computed<AttentionPanelId[]>(() => {
  const ids: AttentionPanelId[] = []
  if (currentPendingAuthRequest.value) ids.push('auth')
  if (currentSudoPasswordRequest.value) ids.push('sudo')
  if (currentAskUserRequest.value) ids.push('ask')
  if (activeTodoItems.value.length > 0) ids.push('todo')
  return ids
})
const attentionSignature = computed(() => [
  currentPendingAuthRequest.value?.requestId ?? '-',
  currentSudoPasswordRequest.value?.requestId ?? '-',
  currentAskUserRequest.value?.requestId ?? '-',
  activeTodoItems.value.length > 0 ? 'todo' : '-'
].join('|'))
const { expandedPanel: expandedAttentionPanel, togglePanel: toggleAttentionPanel } =
  createAttentionAccordion(
    () => pendingAttentionPanels.value,
    () => attentionSignature.value
  )



watch(
  bottomDockRef,
  (element) => {
    bottomDockObserver?.disconnect()
    bottomDockObserver = null
    if (!element || typeof ResizeObserver === 'undefined') return
    const measureInset = (): void => {
      const dockRect = element.getBoundingClientRect()
      const card = chatInputRef.value?.$el?.querySelector<HTMLElement>('.input-container')
      inputCardInset.value = card
        ? Math.max(0, Math.round(dockRect.bottom - card.getBoundingClientRect().top))
        : Math.round(dockRect.height)
    }
    measureInset()
    bottomDockObserver = new ResizeObserver(() => measureInset())
    bottomDockObserver.observe(element)
  },
  { flush: 'post' }
)

onBeforeUnmount(() => {
  bottomDockObserver?.disconnect()
  bottomDockObserver = null
  window.removeEventListener('keydown', onSidebarShortcut)
  offPlanModeChanged?.()
  offPlanModeChanged = null
  // The shell drops this component in pure-app view; stop advertising its
  // browser tab as the active automation page.
  emit('pageSurfaceChange', null)
})

function loadConversationSidebarCollapsed (): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(CONVERSATION_SIDEBAR_COLLAPSE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

const conversationSidebarCollapsed = ref(loadConversationSidebarCollapsed())
const conversationSidebarWidth = computed(() => conversationSidebarCollapsed.value
  ? CONVERSATION_SIDEBAR_COLLAPSED_WIDTH
  : CONVERSATION_SIDEBAR_WIDTH
)

// The collapsed capsule shows which list owns the active conversation
// (context marker icon); hovering it opens a compact quick-switch flyout —
// expanding the list remains the full switching surface.
const collapsedCapsuleIcon = computed(() => {
  if (agentSidebarItems.value.some(item => item.isActive)) return 'robot'
  if (groupSidebarItems.value.some(item => item.isActive)) return 'people'
  if (longTermGoalSidebarItems.value.some(item => item.isActive)) return 'target'
  return 'bubble'
})

type CapsuleFlyoutRowStatus = 'idle' | 'streaming' | 'auth' | 'unread'
type CapsuleFlyoutRow = { id: string; title: string; active: boolean; status: CapsuleFlyoutRowStatus }
type CapsuleFlyoutSection = {
  key: 'agents' | 'groups' | 'goals' | 'conversations'
  label: string
  rows: CapsuleFlyoutRow[]
}

// Compact quick-switch rows for the collapsed-capsule hover flyout: titles
// and status dots only — the expanded list is the full-detail surface.
const capsuleFlyoutSections = computed<CapsuleFlyoutSection[]>(() => {
  const statusOf = (item: { isStreaming: boolean; pendingAuthCount: number; unreadCount: number }): CapsuleFlyoutRowStatus => {
    if (item.pendingAuthCount > 0) return 'auth'
    if (item.isStreaming) return 'streaming'
    if (item.unreadCount > 0) return 'unread'
    return 'idle'
  }
  const sections: CapsuleFlyoutSection[] = []
  if (agentSidebarItems.value.length > 0) {
    sections.push({
      key: 'agents',
      label: 'Agent',
      rows: agentSidebarItems.value.map(item => ({ id: item.id, title: item.title, active: item.isActive, status: statusOf(item) }))
    })
  }
  if (groupSidebarItems.value.length > 0) {
    sections.push({
      key: 'groups',
      label: t('chatUi.groups'),
      rows: groupSidebarItems.value.map(item => ({ id: item.id, title: item.title, active: item.isActive, status: statusOf(item) }))
    })
  }
  if (longTermGoalSidebarItems.value.length > 0) {
    sections.push({
      key: 'goals',
      label: t('chatUi.longTermGoalsShort'),
      rows: longTermGoalSidebarItems.value.map(item => ({ id: item.id, title: item.title, active: item.isActive, status: statusOf(item) }))
    })
  }
  if (conversationSidebarItems.value.length > 0) {
    const mode = sidebarGroupingMode.value
    const toRows = (items: SidebarConversationItem[]) => items.map(item => ({ id: item.id, title: item.title, active: item.isActive, status: statusOf(item) }))
    if (mode === 'project') {
      // One flyout section per project (Launchpad, registered folder, or bare
      // workspace directory) + ungrouped/deleted, mirroring the expanded
      // sidebar. Map insertion order keeps each bucket in recency order.
      const known = new Map(projectIndex.value.map(project => [project.id, project]))
      const rootToProject = new Map(
        projectIndex.value.filter(project => project.rootPath).map(project => [project.rootPath as string, project])
      )
      const projectBuckets = new Map<string, { label: string; rows: CapsuleFlyoutRow[] }>()
      const wsBuckets = new Map<string, { label: string; rows: CapsuleFlyoutRow[] }>()
      const ungroupedRows: CapsuleFlyoutRow[] = []
      const deletedRows: CapsuleFlyoutRow[] = []
      for (const item of conversationSidebarItems.value) {
        const row: CapsuleFlyoutRow = { id: item.id, title: item.title, active: item.isActive, status: statusOf(item) }
        const rootProject = !item.projectId && item.workspaceRootPath
          ? rootToProject.get(item.workspaceRootPath)
          : undefined
        if (item.projectId && known.has(item.projectId)) {
          const project = known.get(item.projectId)!
          if (!projectBuckets.has(project.id)) projectBuckets.set(project.id, { label: project.name, rows: [] })
          projectBuckets.get(project.id)!.rows.push(row)
        } else if (rootProject) {
          if (!projectBuckets.has(rootProject.id)) projectBuckets.set(rootProject.id, { label: rootProject.name, rows: [] })
          projectBuckets.get(rootProject.id)!.rows.push(row)
        } else if (item.projectId) {
          deletedRows.push(row)
        } else if (item.workspaceRootPath) {
          const path = item.workspaceRootPath
          const label = item.workspaceRootName || path.split(/[\\/]/).filter(Boolean).pop() || path
          if (!wsBuckets.has(path)) wsBuckets.set(path, { label, rows: [] })
          wsBuckets.get(path)!.rows.push(row)
        } else {
          ungroupedRows.push(row)
        }
      }
      for (const bucket of [...projectBuckets.values(), ...wsBuckets.values()]) {
        if (bucket.rows.length > 0) sections.push({ key: 'conversations', label: bucket.label, rows: bucket.rows })
      }
      if (ungroupedRows.length > 0) sections.push({ key: 'conversations', label: t('chatUi.groupUngrouped'), rows: ungroupedRows })
      if (deletedRows.length > 0) sections.push({ key: 'conversations', label: t('chatUi.groupDeletedProjects'), rows: deletedRows })
    } else if (mode === 'time') {
      const buckets: Array<{ key: 'today' | 'yesterday' | 'last7Days' | 'last30Days' | 'older'; label: string }> = [
        { key: 'today', label: t('chatUi.groupToday') },
        { key: 'yesterday', label: t('chatUi.groupYesterday') },
        { key: 'last7Days', label: t('chatUi.groupLast7Days') },
        { key: 'last30Days', label: t('chatUi.groupLast30Days') },
        { key: 'older', label: t('chatUi.groupOlder') }
      ]
      for (const bucket of buckets) {
        const rows = toRows(conversationSidebarItems.value.filter(item => resolveTimeBucket(item.updatedAt || '') === bucket.key))
        if (rows.length > 0) sections.push({ key: 'conversations', label: bucket.label, rows })
      }
    } else {
      sections.push({
        key: 'conversations',
        label: t('appShell.chat'),
        rows: toRows(conversationSidebarItems.value)
      })
    }
  }
  return sections
})

const hasCapsuleFlyoutRows = computed(() => capsuleFlyoutSections.value.some(section => section.rows.length > 0))

function openCapsuleFlyoutRow (key: CapsuleFlyoutSection['key'], id: string): void {
  if (key === 'agents') void openAgentWorkspaceConversation(id)
  else if (key === 'groups') void openGroupWorkspaceConversation(id)
  else if (key === 'goals') void openLongTermGoal(id)
  else void loadConversation(id)
}

// ── Sidebar grouping (time / project / folders) ────────────────────────────
// The ConversationSidebar owns group rendering + collapse state; the shell
// mirrors the mode for the collapsed-capsule flyout and project联动 events.
const sidebarGroupingMode = ref<ConversationGroupingMode>(loadConversationGroupingMode())
const projectIndex = ref<SidebarProjectInfo[]>([])

function handleAssignConversationProject (conversationId: string, projectId: string | null): void {
  void assignConversationProject(conversationId, projectId)
}

async function refreshProjectIndex (): Promise<void> {
  const api = window.electronAPI
  if (!api?.listProjects) return
  try {
    const [projects, custom] = await Promise.all([
      api.listProjects(),
      api.listCustomProjects?.() ?? Promise.resolve([])
    ])
    const index: SidebarProjectInfo[] = []
    for (const project of projects) {
      const id = typeof project.id === 'string' ? project.id : ''
      if (!id) continue
      const name = typeof project.name === 'string' && project.name.trim() ? project.name : id
      // Web shortcuts are not code projects; exclude them from grouping (R3).
      if (project.kind !== 'web') index.push({ id, name })
    }
    for (const entry of custom) {
      if (!entry?.id || !entry.rootPath) continue
      index.push({ id: entry.id, name: entry.name || entry.rootPath, rootPath: entry.rootPath })
    }
    projectIndex.value = index
  } catch {
    /* keep previous index */
  }
}

async function handleNewConversationInProject (projectId: string, rootPath: string | null): Promise<void> {
  const name = projectIndex.value.find(project => project.id === projectId)?.name
  await startProjectConversation(projectId, name, { rootPath })
}

async function handleNewConversationInWorkspace (rootPath: string, name: string): Promise<void> {
  await startProjectConversation(null, name, { rootPath })
}

async function handleAddProjectFolder (): Promise<void> {
  const api = window.electronAPI
  if (!api?.pickFolderWorkspace || !api.addCustomProject) return
  try {
    const picked = await api.pickFolderWorkspace()
    if (picked.canceled || !picked.rootPath) return
    await api.addCustomProject(picked.rootPath, picked.rootName)
    await refreshProjectIndex()
  } catch {
    /* picker unavailable */
  }
}

function handleOpenProject (projectId: string): void {
  const name = projectIndex.value.find(project => project.id === projectId)?.name
  void openWorkspaceTab('project', { projectId, ...(name ? { name } : {}) })
}

// ── Folder-mode housekeeping: attach creation + AI organize ────────────────
const conversationSidebarRef = ref<InstanceType<typeof ConversationSidebar> | null>(null)

async function handleNewConversationInFolder (folderId: string): Promise<void> {
  const conversationId = await startBlankConversation()
  if (!conversationId) return
  await nextTick()
  conversationSidebarRef.value?.addConversationToFolder(conversationId, folderId)
}

interface OrganizeGroup {
  name: string
  isNew: boolean
  conversations: Array<{ id: string; title: string }>
}

const organizeState = reactive<{
  open: boolean
  loading: boolean
  stage: string
  progress: number | null
  error: string
  groups: OrganizeGroup[]
}>({ open: false, loading: false, stage: '', progress: null, error: '', groups: [] })

function handleOrganizeConversations (): void {
  const sidebar = conversationSidebarRef.value
  if (!sidebar || organizeState.loading) return
  const unfiled = sidebar.getUnfiledConversations()
  organizeState.groups = []
  organizeState.error = ''
  organizeState.stage = ''
  organizeState.progress = null
  organizeState.open = true
  if (unfiled.length === 0) return
  void runOrganizeConversations(unfiled)
}

const ORGANIZE_BATCH_SIZE = 300

async function runOrganizeConversations (unfiled: SidebarConversationItem[]): Promise<void> {
  const api = window.electronAPI
  if (!api?.chat) {
    organizeState.error = t('chatUi.organizeFailed')
    return
  }
  organizeState.loading = true
  const folders = conversationSidebarRef.value?.getFolderNames() ?? []
  const existingNames = new Set(folders.map(folder => folder.name.trim().toLowerCase()))
  const items = unfiled.map(item => ({ id: item.id, title: item.title, preview: item.subtitle }))
  const batches: typeof items[] = []
  for (let start = 0; start < items.length; start += ORGANIZE_BATCH_SIZE) {
    batches.push(items.slice(start, start + ORGANIZE_BATCH_SIZE))
  }
  // Every id lands in exactly one group across the whole run; later batches
  // reuse names already coined so the proposal doesn't fragment.
  const seen = new Set<string>()
  const accumulated: Array<{ name: string; ids: string[] }> = []
  let failure: Error | null = null

  for (let index = 0; index < batches.length; index++) {
    if (batches.length > 1) {
      organizeState.stage = t('chatUi.organizeStageBatch', { index: index + 1, total: batches.length })
      organizeState.progress = index / batches.length
    }
    try {
      const batchItems = batches[index]
      const titleOf = new Map(batchItems.map(item => [item.id, item.title]))
      const knownNames = [...folders.map(folder => folder.name), ...accumulated.map(group => group.name)]
      const system = [
        '你是对话整理助手。把每个会话分配到最合适的一个文件夹。',
        '优先使用「现有文件夹」；只有确实不合适时才新建文件夹，新文件夹不超过 5 个，名称简洁（2-8 个字）。',
        '「会话」列表中的每一个 id 都必须且只能出现在一个文件夹里。',
        '只输出 JSON，不要输出任何解释或代码块标记。格式：',
        '{"folders":[{"name":"文件夹名","ids":["会话id"]}]}'
      ].join('\n')
      const result = await api.chat([
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify({ folders: knownNames, conversations: batchItems }) }
      ])
      const text = typeof result?.content === 'string'
        ? result.content
        : Array.isArray(result?.content)
          ? result.content.filter(part => part.type === 'text').map(part => part.text || '').join('')
          : ''
      for (const group of parseOrganizeResponse(text, titleOf)) {
        const fresh = group.ids.filter(id => !seen.has(id))
        if (fresh.length === 0) continue
        fresh.forEach(id => seen.add(id))
        const merged = accumulated.find(entry => entry.name === group.name)
        if (merged) merged.ids.push(...fresh)
        else accumulated.push({ name: group.name, ids: fresh })
      }
    } catch (error) {
      // Keep the completed batches; the user can apply them or retry.
      failure = error instanceof Error ? error : new Error(String(error))
      break
    }
  }

  organizeState.loading = false
  organizeState.progress = null
  if (accumulated.length === 0 && failure) {
    organizeState.error = failure.message || t('chatUi.organizeFailed')
    return
  }
  if (failure) organizeState.error = t('chatUi.organizePartialError')
  if (accumulated.length === 0) return
  organizeState.groups = accumulated.map(group => ({
    name: group.name,
    isNew: !existingNames.has(group.name.trim().toLowerCase()),
    conversations: group.ids.map(id => ({ id, title: items.find(item => item.id === id)?.title || id }))
  }))
}

/** Tolerant parse: fenced JSON, {folders:[{name,ids}]} or a name→ids map. */
function parseOrganizeResponse (text: string, titleOf: Map<string, string>): Array<{ name: string; ids: string[] }> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(t('chatUi.organizeFailed'))
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown
  const rawGroups: Array<{ name?: unknown; ids?: unknown }> = []
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).folders)) {
    for (const entry of (parsed as Record<string, unknown>).folders as Array<unknown>) {
      if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).name === 'string') {
        rawGroups.push(entry as Record<string, unknown>)
      }
    }
  } else if (parsed && typeof parsed === 'object') {
    for (const [name, ids] of Object.entries(parsed as Record<string, unknown>)) {
      rawGroups.push({ name, ids })
    }
  }

  const seen = new Set<string>()
  const groups: Array<{ name: string; ids: string[] }> = []
  for (const group of rawGroups) {
    const name = typeof group.name === 'string' ? group.name.trim() : ''
    if (!name || !Array.isArray(group.ids)) continue
    const ids = group.ids
      .filter((id): id is string => typeof id === 'string' && titleOf.has(id))
      .filter(id => !seen.has(id))
    if (ids.length === 0) continue
    ids.forEach(id => seen.add(id))
    groups.push({ name, ids })
  }
  if (groups.length === 0) throw new Error(t('chatUi.organizeFailed'))
  return groups
}

function applyOrganizeGroups (groups: Array<{ name: string; conversations: Array<{ id: string }> }>): void {
  const sidebar = conversationSidebarRef.value
  if (sidebar) {
    for (const group of groups) {
      const folderId = sidebar.ensureFolder(group.name)
      if (!folderId) continue
      for (const conversation of group.conversations) {
        sidebar.addConversationToFolder(conversation.id, folderId)
      }
    }
  }
  organizeState.open = false
  organizeState.groups = []
}

function toggleConversationSidebar (): void {
  conversationSidebarCollapsed.value = !conversationSidebarCollapsed.value
}

// ⌘\ / Ctrl+\ toggles the conversation list, matching the hint on the
// capsule tooltip (design P3).
function onSidebarShortcut (event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key === '\\') {
    event.preventDefault()
    toggleConversationSidebar()
  }
}

// ── Daily suggestions (chat empty state) ─────────────────────────────────
// Cards resolve to a prompt plus a "scene": composer toggles that get applied
// before the text is filled or sent, so one click lands in a working setup.
const suggestionProjectNames = ref<Record<string, string>>({})
const suggestionRefreshing = ref(false)
const showEmptyStateSuggestions = computed(() => messages.value.length === 0 && !isGroupConversation.value)

async function loadSuggestionProjectNames (): Promise<void> {
  if (!window.electronAPI?.listProjects) return
  try {
    const projects = await window.electronAPI.listProjects()
    const names: Record<string, string> = {}
    for (const project of projects) {
      const id = typeof project.id === 'string' ? project.id : ''
      if (!id) continue
      names[id] = typeof project.name === 'string' && project.name.trim() ? project.name : id
    }
    suggestionProjectNames.value = names
  } catch {
    /* names fall back to ids */
  }
}

function focusComposer (): void {
  const textarea = chatInputRef.value?.$el?.querySelector<HTMLTextAreaElement>('textarea')
  textarea?.focus({ preventScroll: true })
}

async function applySuggestionScene (suggestion: WorkSuggestion): Promise<void> {
  const scene = suggestion.scene
  if (!scene) return
  if (scene.planMode && !planModeActive.value) await togglePlanMode()
  if (scene.computerUse && !computerUseEnabled.value) await toggleComputerUse()
  if (scene.authMode && currentAuthMode.value !== scene.authMode) await handleAuthModeChange(scene.authMode)
  if (scene.skillIds?.length) {
    const available = new Set(availableSkills.value.map(skill => skill.id))
    for (const skillId of scene.skillIds) {
      if (available.has(skillId) && !activeSkillIds.value.has(skillId)) toggleSkill(skillId)
    }
  }
}

async function pickSuggestion (suggestion: WorkSuggestion, payload: { prompt: string; projectName?: string }): Promise<void> {
  if (isLoading.value) return
  recordDailySuggestionPick(suggestion)
  await applySuggestionScene(suggestion)
  // Project targeting rides on the same [[project:...]] tag the composer already
  // understands, so the chip shows up and message-sender binds the conversation.
  const projectId = suggestion.scene?.targetProjectId
  const projectTag = projectId ? `[[project:${projectId}|${payload.projectName || projectId}]] ` : ''
  inputText.value = `${projectTag}${payload.prompt}`
  if (suggestion.sendMode === 'send') {
    await sendMessage()
    return
  }
  await nextTick()
  focusComposer()
}

function refreshDailySuggestions (): void {
  if (suggestionRefreshing.value || !window.electronAPI?.generateDailySuggestionsNow) return
  suggestionRefreshing.value = true
  window.electronAPI.generateDailySuggestionsNow()
    .then(snapshot => { dailySuggestionSnapshot.value = snapshot })
    .catch(() => { void loadDailySuggestions(true) })
    .finally(() => { suggestionRefreshing.value = false })
}

/** No provider configured at all: the empty state leads with a setup card. */
const providersMissing = computed(() => conversationsLoaded.value && providersConfig.value.providers.length === 0)

function openProviderSetup (mode: 'recommended' | 'browse'): void {
  emit('openSettings', 'providers', mode === 'recommended' ? { useProviderTemplate: getRecommendedProviderTemplate().id } : undefined)
}

watch(showEmptyStateSuggestions, (visible) => {
  if (!visible) return
  ensureDailySuggestionSubscription()
  void loadDailySuggestions()
  void loadSuggestionProjectNames()
}, { immediate: true })

function deleteLongTermGoalById (goalId: string): void {
  const goal = currentLongTermGoal.value?.id === goalId
    ? currentLongTermGoal.value
    : longTermGoalSnapshot.value?.goals.find(item => item.id === goalId) || null
  const title = goal?.title || longTermGoalSidebarItems.value.find(item => item.id === goalId)?.title || goalId
  const ok = window.confirm(t('chatUi.deleteLongTermGoalConfirm', { title }))
  if (!ok) return
  void deleteLongTermGoal(goal || goalId)
}

function getActiveWorkspaceTabKind (): string | null {
  return getActiveWorkspaceTab()?.kind ?? null
}

function getPreferredWorkspaceWidth (): number {
  const kind = getActiveWorkspaceTabKind()
  const definition = kind ? getWorkspaceTabDefinition(kind) : null
  const minWidth = definition?.minWidth ?? MIN_WORKSPACE_WIDTH_FALLBACK
  const maxWidth = definition?.maxWidth ?? MAX_WORKSPACE_WIDTH_FALLBACK
  return Math.max(
    minWidth,
    Math.min(maxWidth, Math.round(workspaceStore.width.value || minWidth))
  )
}

function getRequiredWindowWidthForWorkspace (): number {
  return conversationSidebarWidth.value + MIN_CHAT_MAIN_WIDTH + getPreferredWorkspaceWidth()
}

async function setWindowMinimumWidth (width: number): Promise<void> {
  if (!window.electronAPI?.setMinimumWindowWidth) return

  try {
    await window.electronAPI.setMinimumWindowWidth(width)
  } catch {
    // Ignore minimum-width sync failures and keep the current layout responsive.
  }
}

async function getCurrentWindowWidth (): Promise<number | null> {
  if (!window.electronAPI?.getWindowBounds) return null

  try {
    return (await window.electronAPI.getWindowBounds())?.width ?? null
  } catch {
    return null
  }
}

async function ensureWindowFitsWorkspace (options?: { animate?: boolean }): Promise<void> {
  if (!window.electronAPI?.ensureWindowWidth) return

  try {
    await window.electronAPI.ensureWindowWidth(
      getRequiredWindowWidthForWorkspace(),
      options?.animate
        ? { animate: true, durationMs: WORKSPACE_OPEN_ANIMATION_DURATION_MS }
        : undefined
    )
  } catch {
    // Ignore resize failures and keep the workspace available inside the current window.
  }
}

function resolveWorkspaceCloseTargetWidth (currentWidth: number | null): number {
  const storedWidth = chatWindowWidthBeforeWorkspace.value
  if (typeof storedWidth === 'number' && Number.isFinite(storedWidth)) {
    return Math.max(DEFAULT_APP_WINDOW_MIN_WIDTH, Math.round(storedWidth))
  }

  if (typeof currentWidth === 'number' && Number.isFinite(currentWidth)) {
    return Math.max(DEFAULT_APP_WINDOW_MIN_WIDTH, Math.round(currentWidth - getPreferredWorkspaceWidth()))
  }

  return DEFAULT_APP_WINDOW_MIN_WIDTH
}

async function animateWindowWidthRecovery (targetWidth: number): Promise<void> {
  if (!window.electronAPI?.ensureWindowWidth) return

  try {
    await window.electronAPI.ensureWindowWidth(targetWidth, {
      animate: true,
      allowShrink: true,
      durationMs: WORKSPACE_OPEN_ANIMATION_DURATION_MS
    })
  } catch {
    // Ignore shrink failures and keep the workspace closed.
  }
}

async function openWorkspace (): Promise<void> {
  if (workspaceStore.visible.value || isOpeningWorkspace.value || isClosingWorkspace.value) return

  isOpeningWorkspace.value = true

  try {
    chatWindowWidthBeforeWorkspace.value = await getCurrentWindowWidth()
    await ensureWindowFitsWorkspace({ animate: true })
    await setWindowMinimumWidth(getRequiredWindowWidthForWorkspace())
  } finally {
    workspaceStore.visible.value = true
    isOpeningWorkspace.value = false
  }
}

async function closeWorkspace (): Promise<void> {
  if (!workspaceStore.visible.value || isClosingWorkspace.value) return

  isClosingWorkspace.value = true
  const currentWindowWidth = await getCurrentWindowWidth()
  const targetWindowWidth = resolveWorkspaceCloseTargetWidth(currentWindowWidth)

  workspaceStore.visible.value = false

  try {
    await setWindowMinimumWidth(DEFAULT_APP_WINDOW_MIN_WIDTH)
    await animateWindowWidthRecovery(targetWindowWidth)
  } finally {
    chatWindowWidthBeforeWorkspace.value = null
    isClosingWorkspace.value = false
  }
}

async function toggleWorkspace (): Promise<void> {
  if (isOpeningWorkspace.value || isClosingWorkspace.value) return

  if (workspaceStore.visible.value) {
    await closeWorkspace()
    return
  }

  await openWorkspace()
}

function getFileNameFromPath (filePath: string): string {
  const segments = filePath.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] || filePath
}

/** Applies the kind's default width to a newly created tab, then reveals the panel. */
async function revealWorkspaceTab (result: ReturnType<typeof ensureWorkspaceTab>): Promise<void> {
  if (!result) return
  if (result.created) {
    const definition = getWorkspaceTabDefinition(result.tab.kind)
    const defaultWidth = definition?.defaultWidth
    if (typeof defaultWidth === 'number') {
      workspaceStore.width.value = Math.round(defaultWidth)
    }
  }
  await openWorkspace()
}

/**
 * Opens (or activates) a workspace tab of the given kind and reveals the
 * panel. Payload carries kind-specific state: `{ rootPath }` for folder,
 * `{ filePath }` for a single document tab, `{ url }` for a browser tab.
 * Entry point for both the add-tab menu and AI `open_workspace_tab` calls;
 * a payload-less document open routes through the file picker.
 */
function openCodingDiff (): void {
  const conversationId = currentConversationId.value
  if (!conversationId) return
  void openCodingWorkspaceTab(conversationId)
}

async function openCodingWorkspaceTab (conversationId: string): Promise<void> {
  if (!conversationId) return

  const existingTab = findWorkspaceTabs('coding-diff', { conversationId })[0]
  const emptyTab = existingTab
    ? null
    : workspaceStore.tabs.value.find(tab => {
        if (tab.kind !== 'coding-diff') return false
        const tabConversationId = tab.state?.conversationId
        return typeof tabConversationId !== 'string' || !tabConversationId.trim()
      }) || null
  const tabToActivate = existingTab || emptyTab

  if (tabToActivate) {
    if (emptyTab) {
      tabToActivate.state = { ...(tabToActivate.state || {}), conversationId }
    }
    activateWorkspaceTab(tabToActivate.id)
    if (emptyTab) updateWorkspaceTabState()
    await openWorkspace()
  } else {
    await revealWorkspaceTab(ensureWorkspaceTab('coding-diff', { conversationId }))
  }
}

function ensureCodingDiffTab (conversationId: string): void {
  if (!conversationId || findWorkspaceTabs('coding-diff', { conversationId }).length > 0) return
  const emptyTab = workspaceStore.tabs.value.find(tab => (
    tab.kind === 'coding-diff' && !tab.state?.conversationId
  ))
  if (emptyTab) {
    emptyTab.state = { ...(emptyTab.state || {}), conversationId }
    updateWorkspaceTabState()
    return
  }
  workspaceStore.tabs.value = [
    ...workspaceStore.tabs.value,
    {
      id: createWorkspaceTabId('coding-diff'),
      kind: 'coding-diff',
      state: { conversationId }
    }
  ]
}

function handleWorkspaceAddTab (kind: string): void {
  if (kind === 'coding-diff') {
    void openWorkspaceTab(kind, { conversationId: currentConversationId.value })
    return
  }

  void openWorkspaceTab(kind)
}

async function openWorkspaceTab (kind: string, payload?: Record<string, unknown>): Promise<void> {
  if (kind === 'coding-diff') {
    const payloadConversationId = typeof payload?.conversationId === 'string'
      ? payload.conversationId.trim()
      : ''
    const conversationId = payloadConversationId || currentConversationId.value
    if (!conversationId) return
    await openCodingWorkspaceTab(conversationId)
    return
  }

  if (kind === 'folder') {
    if (payload && typeof payload.rootPath === 'string' && payload.rootPath.trim()) {
      updateFolderWorkspaceState({
        rootPath: payload.rootPath,
        rootName: typeof payload.rootName === 'string' && payload.rootName.trim() ? payload.rootName : payload.rootPath,
        activeFilePath: typeof payload.activeFilePath === 'string' ? payload.activeFilePath : undefined
      })
    }
    await revealWorkspaceTab(ensureWorkspaceTab('folder'))
    return
  }

  if (kind === 'document') {
    const payloadFilePath = typeof payload?.filePath === 'string' ? payload.filePath.trim() : ''
    if (payloadFilePath) {
      const documentFileName = typeof payload?.fileName === 'string' && payload.fileName.trim()
        ? payload.fileName
        : getFileNameFromPath(payloadFilePath)
      const result = ensureWorkspaceTab('document', {
        filePath: payloadFilePath,
        fileName: documentFileName
      })
      // The tab strip shows the document name, not the generic kind title.
      if (result) result.tab.title = documentFileName
      await revealWorkspaceTab(result)
      return
    }
    if (!window.electronAPI?.pickDocumentFiles) return
    const { canceled, filePaths } = await window.electronAPI.pickDocumentFiles()
    if (canceled || filePaths.length === 0) return
    let lastResult: ReturnType<typeof ensureWorkspaceTab> = null
    for (const pickedPath of filePaths) {
      const result = ensureWorkspaceTab('document', {
        filePath: pickedPath,
        fileName: getFileNameFromPath(pickedPath)
      })
      if (result) result.tab.title = getFileNameFromPath(pickedPath)
      lastResult = result
    }
    await revealWorkspaceTab(lastResult)
    return
  }

  if (kind === 'browser') {
    const url = typeof payload?.url === 'string' && payload.url.trim() ? payload.url.trim() : 'about:blank'
    await revealWorkspaceTab(ensureWorkspaceTab('browser', { url, title: '' }))
    return
  }

  if (kind === 'terminal') {
    const cwd = typeof payload?.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : ''
    await revealWorkspaceTab(ensureWorkspaceTab('terminal', cwd ? { cwd } : undefined))
    return
  }

  if (kind === 'project') {
    const projectId = typeof payload?.projectId === 'string' ? payload.projectId.trim() : ''
    if (projectId) {
      const name = typeof payload?.name === 'string' && payload.name.trim() ? payload.name.trim() : ''
      const result = ensureWorkspaceTab('project', { projectId, ...(name ? { name } : {}) })
      if (result && name) result.tab.title = name
      await revealWorkspaceTab(result)
      // Auto-ownership (R3b): an unassigned conversation that opens a project
      // tab joins that project's sidebar group. Assigned ones stay put.
      const activeId = currentConversationId.value
      if (activeId && !getConversationProject(activeId)) {
        void assignConversationProject(activeId, projectId)
      }
      return
    }
    // No target project: let the user pick from the developed-app catalog.
    await openProjectPicker()
    return
  }

  await revealWorkspaceTab(ensureWorkspaceTab(kind, payload))
}

/** Extensions the document workbench renders as a rich document tab. */
const DOCUMENT_TAB_EXTENSIONS = new Set(['.md', '.markdown', '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt'])

function getFileExtension (filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() || ''
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

function isAbsoluteFilePath (filePath: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(filePath)
}

function joinFolderWorkspacePath (rootPath: string, relativePath: string): string {
  const normalizedRelative = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '')
  const trimmedRoot = rootPath.replace(/[\\/]+$/, '')
  if (!normalizedRelative || normalizedRelative === '.') return trimmedRoot
  return `${trimmedRoot}/${normalizedRelative}`
}

function isPathInsideRoot (filePath: string, rootPath: string): boolean {
  const normalizedFile = filePath.replace(/\\/g, '/')
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/[\\/]+$/, '')
  return normalizedFile.startsWith(`${normalizedRoot}/`)
}

/**
 * Opens a document written during the conversation in a workspace tab.
 * Entry point for written-file cards and file references clicked in message
 * text. Rich document types open a document tab; other files inside the
 * conversation's folder workspace open the folder tab positioned at the file.
 */
async function openChatDocument (rawPath: string): Promise<void> {
  const trimmed = rawPath.trim()
  if (!trimmed) return
  const folderState = buildCurrentFolderWorkspaceState()
  const rootPath = folderState?.rootPath?.trim() || ''
  const absolutePath = isAbsoluteFilePath(trimmed)
    ? trimmed.replace(/\\/g, '/')
    : rootPath ? joinFolderWorkspacePath(rootPath, trimmed) : ''
  if (!absolutePath) return

  if (DOCUMENT_TAB_EXTENSIONS.has(getFileExtension(absolutePath))) {
    await openWorkspaceTab('document', { filePath: absolutePath })
    return
  }
  const normalizedRoot = rootPath.replace(/[\\/]+$/, '')
  if (normalizedRoot && isPathInsideRoot(absolutePath, normalizedRoot)) {
    await openWorkspaceTab('folder', {
      rootPath,
      rootName: folderState?.rootName,
      activeFilePath: absolutePath.slice(normalizedRoot.length + 1)
    })
  }
}

interface ProjectPickerEntry {
  id: string
  name: string
  icon?: string
}

const projectPicker = reactive({
  visible: false,
  loading: false,
  error: '',
  purpose: 'open' as 'open' | 'coding',
  entries: [] as ProjectPickerEntry[]
})

function closeProjectPicker (): void {
  projectPicker.visible = false
  projectPicker.purpose = 'open'
}

async function openProjectPicker (purpose: 'open' | 'coding' = 'open'): Promise<void> {
  projectPicker.visible = true
  projectPicker.purpose = purpose
  projectPicker.error = ''
  if (projectPicker.entries.length > 0) return

  projectPicker.loading = true
  try {
    const projects = await window.electronAPI?.listProjects() || []
    projectPicker.entries = projects
      .filter(project => typeof project?.id === 'string' && project.id)
      .map(project => ({
        id: String(project.id),
        name: typeof project.name === 'string' && project.name.trim() ? project.name : String(project.id),
        icon: typeof project.icon === 'string' ? project.icon : undefined
      }))
    if (projectPicker.entries.length === 0) {
      projectPicker.error = t('chatUi.projectPickerEmpty')
    }
  } catch (error) {
    projectPicker.error = error instanceof Error ? error.message : String(error)
  } finally {
    projectPicker.loading = false
  }
}

function pickProject (entry: ProjectPickerEntry): void {
  const purpose = projectPicker.purpose
  projectPicker.visible = false
  projectPicker.purpose = 'open'
  if (purpose === 'coding') {
    targetProjectId.value = entry.id
    void openWorkspaceTab('project', { projectId: entry.id, name: entry.name })
    void sendMessage()
    return
  }
  void openWorkspaceTab('project', { projectId: entry.id, name: entry.name })
}

function getDocumentTabsForRunContext (): WorkspaceTabInstance[] {
  const tabs = getDocumentTabs()
  const activeTab = getActiveWorkspaceTab()
  if (activeTab?.kind !== 'document') return tabs
  const activeIndex = tabs.findIndex(tab => tab.id === activeTab.id)
  if (activeIndex <= 0) return tabs
  return [tabs[activeIndex], ...tabs.slice(0, activeIndex), ...tabs.slice(activeIndex + 1)]
}

function resolveChatRunContext () {
  const documentTabs = getDocumentTabsForRunContext().flatMap(tab => {
    const filePath = getDocumentTabFilePath(tab)
    if (!filePath) return []
    const fileName = typeof tab.state?.fileName === 'string' ? tab.state.fileName : undefined
    return [{ filePath, ...(fileName ? { fileName } : {}) }]
  })

  const activeTabKind = getActiveWorkspaceTab()?.kind ?? null
  return resolveWorkRunContext({
    text: inputText.value,
    targetProjectId: targetProjectId.value,
    folderRoot: buildCurrentFolderWorkspaceState()?.rootPath ?? null,
    activeFolderFilePath: activeTabKind === 'folder' ? workspaceStore.folderActiveFilePath.value : null,
    activeTabKind,
    documentTabs,
    attachmentPaths: pendingFiles.value
      .map(file => file.filePath)
      .filter((filePath): filePath is string => Boolean(filePath))
  })
}

function handleChatSend (): void {
  if (isLoading.value || isUploadingFiles.value) return

  const runContext = resolveChatRunContext()
  const folderRoot = buildCurrentFolderWorkspaceState()?.rootPath
  // The renderer only supplies a root hint for document-project coding. The
  // mode itself is chosen by the model through select_work_mode (or the
  // create_project/coding-tool fallback), never by this regex prefill.
  const codingWorkspaceRoot = !targetProjectId.value && !folderRoot
    ? runContext.coding.root
    : null
  void sendMessage(undefined, codingWorkspaceRoot ? { codingWorkspaceRoot } : undefined)
}

function closeWorkspaceTab (tabId: string): void {
  removeWorkspaceTab(tabId)
  if (workspaceStore.tabs.value.length === 0) {
    void closeWorkspace()
  }
}

function handleWorkspaceTabStateUpdate (tab: WorkspaceTabInstance, state: unknown): void {
  if (tab.kind === 'folder') {
    updateFolderWorkspaceState((state || null) as ConversationFolderWorkspaceState | null)
    return
  }
  tab.state = { ...(tab.state || {}), ...((state as Record<string, unknown> | null) || {}) }
  updateWorkspaceTabState()
}

function handleWorkspaceWidthUpdate (width: number): void {
  workspaceStore.width.value = width
}

function handleWorkspaceTabActivate (tabId: string): void {
  activateWorkspaceTab(tabId)
}

// The active browser tab doubles as the AI's "current page": its surface is
// forwarded to the app shell, which prefers embedded app pages over it.
const workspaceBrowserSurface = computed(() => {
  if (!workspaceStore.visible.value) return null
  const tab = getActiveWorkspaceTab()
  if (!tab || tab.kind !== 'browser') return null
  return workspaceBrowserSurfaces.get(tab.id) || null
})

watch(workspaceBrowserSurface, (surface) => {
  const tab = getActiveWorkspaceTab()
  if (surface && tab) {
    emit('pageSurfaceChange', {
      appId: `wsb-${tab.id}`,
      title: surface.title || surface.url,
      url: surface.url,
      handle: surface.handle
    })
    return
  }
  emit('pageSurfaceChange', null)
}, { immediate: true })

// The active terminal tab doubles as the AI's "current terminal": its session
// is forwarded to the app shell for the read/write_active_terminal tools.
const workspaceTerminalSurface = computed(() => {
  if (!workspaceStore.visible.value) return null
  const tab = getActiveWorkspaceTab()
  if (!tab || tab.kind !== 'terminal') return null
  return workspaceTerminalSurfaces.get(tab.id) || null
})

watch(workspaceTerminalSurface, (surface) => {
  if (surface) {
    emit('terminalSurfaceChange', { sessionId: surface.sessionId, cwd: surface.cwd })
    return
  }
  emit('terminalSurfaceChange', null)
}, { immediate: true })

// ── Per-conversation workspace isolation ────────────────────────────────────
// AI runs keep streaming while the user reads another conversation, and their
// workspace requests carry the owning conversation id. Only requests for the
// displayed conversation reach the live panel; everything else is applied to
// that conversation's stored snapshot (background stash + persistence
// context) so the tab shows up when the user returns — and the displayed
// conversation's workspace is never touched by another conversation's AI.

/**
 * Applies one AI workspace change to a background conversation's snapshot.
 * Returns the normalized snapshot (undefined once the strip emptied), or null
 * when the conversation has no renderer-side state left (the stream already
 * finished, or the run has no desktop conversation, e.g. scheduler tasks).
 */
function applyBackgroundWorkspaceChange (
  conversationId: string,
  apply: (state: ConversationWorkspaceState) => ConversationWorkspaceState | undefined
): ConversationWorkspaceState | undefined | null {
  const backgroundState = backgroundStreamMessages.get(conversationId)
  if (!backgroundState) return null

  const hydrated = hydrateWorkspaceSnapshot(backgroundState.workspace, {
    folderWorkspace: backgroundState.folderWorkspace,
    documentWorkspace: backgroundState.documentWorkspace
  })
  const next = apply(hydrated)
  const normalized = next && Array.isArray(next.tabs) && next.tabs.length > 0 ? next : undefined

  backgroundState.workspace = normalized
  // The legacy mirrors win over an empty workspace on restore; drop them when
  // the strip emptied so a stale folder binding cannot resurrect.
  if (!normalized) {
    backgroundState.folderWorkspace = undefined
    backgroundState.documentWorkspace = undefined
  }
  updateBackgroundConversationWorkspace(conversationId, normalized)
  return normalized
}

function handleBackgroundWorkspaceTabRequest (conversationId: string, kind: string, payload?: Record<string, unknown>): void {
  applyBackgroundWorkspaceChange(conversationId, state => {
    openWorkspaceTabInSnapshot(state, kind, payload)
    return state
  })
}

function handleBackgroundWorkspaceControl (conversationId: string, request: WorkspaceTabControlRequest): WorkspaceTabControlResult {
  let result: WorkspaceTabControlResult | null = null
  const outcome = applyBackgroundWorkspaceChange(conversationId, state => {
    const applied = applyWorkspaceControlToSnapshot(state, request)
    result = applied.result
    return applied.state
  })
  if (!result) {
    throw new Error(
      outcome === null
        ? `This window no longer holds conversation ${conversationId}'s workspace, so the tab action cannot be applied.`
        : `Workspace tab action "${request.action}" produced no result.`
    )
  }
  return result
}

// AI-originated requests arrive as a prop (seq-bumped) from the app shell and
// are consumed exactly once; `immediate` covers requests that landed while the
// chat shell was unmounted.
watch(
  () => props.workspaceTabRequest,
  (request) => {
    if (!request || typeof request.kind !== 'string') return
    if (request.conversationId && request.conversationId !== currentConversationId.value) {
      handleBackgroundWorkspaceTabRequest(request.conversationId, request.kind, request.payload)
    } else {
      void openWorkspaceTab(request.kind, request.payload)
    }
    emit('workspaceTabRequestConsumed')
  },
  { immediate: true }
)

// AI tab management (manage_workspace_tabs): `list` is a pure store read;
// activate/close reuse the same open/close paths as manual clicks so window
// width animation and last-tab panel collapse stay identical.
function resolveWorkspaceTabControlTarget (request: WorkspaceTabControlRequest): WorkspaceTabInstance | null {
  if (request.tabId) {
    return workspaceStore.tabs.value.find(tab => tab.id === request.tabId) || null
  }
  const match: Record<string, unknown> = {}
  if (request.url) match.url = request.url
  if (request.cwd) match.cwd = request.cwd
  if (request.filePath) match.filePath = request.filePath
  const matches = findWorkspaceTabs(request.kind, Object.keys(match).length > 0 ? match : undefined)
  return matches[0] ?? null
}

async function applyWorkspaceTabControl (request: WorkspaceTabControlRequest) {
  if (request.action === 'list') {
    return { ok: true, action: request.action, tabs: buildWorkspaceTabSummaries() }
  }

  const target = resolveWorkspaceTabControlTarget(request)
  if (!target) {
    const available = buildWorkspaceTabSummaries()
      .map(tab => `${tab.kind} id=${tab.id}${tab.title ? ` "${tab.title}"` : ''}`)
      .join('; ')
    throw new Error(
      `No matching workspace tab for action "${request.action}". Open tabs: ${available || 'none'}` +
      ' — call action "list" first, or open_workspace_tab to create one.'
    )
  }

  if (request.action === 'activate') {
    activateWorkspaceTab(target.id)
    await openWorkspace()
  } else {
    removeWorkspaceTab(target.id)
    if (workspaceStore.tabs.value.length === 0) await closeWorkspace()
  }

  return {
    ok: true,
    action: request.action,
    tab: buildWorkspaceTabSummary(target),
    tabs: buildWorkspaceTabSummaries()
  }
}

watch(
  () => props.workspaceTabControlRequest,
  async (request) => {
    if (!request?.envelope) return
    const { requestId } = request.envelope
    const control = request.envelope.request
    const backgroundId = control.conversationId && control.conversationId !== currentConversationId.value
      ? control.conversationId
      : null
    let response: WorkspaceTabControlResponseEnvelope
    if (backgroundId) {
      try {
        response = { requestId, ok: true, result: handleBackgroundWorkspaceControl(backgroundId, control) }
      } catch (error) {
        response = { requestId, ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    } else {
      try {
        response = { requestId, ok: true, result: await applyWorkspaceTabControl(request.envelope.request) }
      } catch (error) {
        response = { requestId, ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    emit('workspaceTabControlResult', response)
  },
  { immediate: true }
)

// The app shell scopes AI workspace requests by the displayed conversation;
// report every change so a request for a background conversation is not
// mistaken for one targeting the live panel.
watch(currentConversationId, (conversationId) => {
  emit('currentConversationChange', conversationId)
}, { immediate: true })

watch(isLoading, (loading, previous) => {
  if (!loading || previous) return
  const conversationId = currentConversationId.value
  if (!conversationId) return
  autoFocusedCodingDiffAt.delete(conversationId)
})

// The first diff of a run opens and focuses the bound diff tab; later diffs
// keep the user's current tab.
watch(currentCodingDiff, (diff) => {
  const conversationId = currentConversationId.value
  if (!isLoading.value || !conversationId || !diff?.files.length) return
  if (autoFocusedCodingDiffAt.has(conversationId)) return
  autoFocusedCodingDiffAt.set(conversationId, diff.updatedAt)
  ensureCodingDiffTab(conversationId)
  const diffTab = findWorkspaceTabs('coding-diff', { conversationId })[0]
  if (diffTab) activateWorkspaceTab(diffTab.id)
  void openWorkspace()
}, { flush: 'post' })

// A staged draft opens (or focuses) its document tab, which switches the tab
// into live draft preview via the workspace store mirror.
watch(
  () => props.workspaceDraftRequest,
  async (request) => {
    if (!request?.payload) return
    stageWorkspaceDocumentDraft(request.payload)
    await openWorkspaceTab('document', { filePath: request.payload.filePath })
    emit('workspaceDraftRequestConsumed')
  },
  { immediate: true }
)

// Draft notifications can be lost (window routing, harness restart). When a
// chat stream settles, re-pull pending drafts for every open document tab so
// the banner still appears without depending on the push event.
watch(isLoading, async (loading, previous) => {
  if (!previous || loading) return
  for (const tab of getDocumentTabs()) {
    const filePath = getDocumentTabFilePath(tab)
    if (!filePath || getWorkspaceDocumentDraft(filePath)) continue
    try {
      const record = await window.electronAPI?.getDocumentDraft?.(filePath)
      if (record && !getWorkspaceDocumentDraft(filePath)) {
        stageWorkspaceDocumentDraft(record)
      }
    } catch {
      // Harness unavailable or no draft for this path: leave the tab as is.
    }
  }
})

// Window sizing follows the panel: the minimum width tracks the active tab
// kind's bounds, and an opening (or activating) tab re-expands the window.
watch(
  [
    () => workspaceStore.visible.value,
    () => workspaceStore.activeTabId.value,
    () => workspaceStore.width.value,
    conversationSidebarCollapsed
  ],
  ([visible], previous) => {
    const wasVisible = Boolean(previous?.[0])
    const previousActiveTabId = previous?.[1]
    const activeTabId = workspaceStore.activeTabId.value
    void setWindowMinimumWidth(visible ? getRequiredWindowWidthForWorkspace() : DEFAULT_APP_WINDOW_MIN_WIDTH)
    if (visible && (!wasVisible || activeTabId !== previousActiveTabId) && !isOpeningWorkspace.value) {
      void ensureWindowFitsWorkspace()
    }
  },
  { immediate: true }
)

watch(
  conversationSidebarCollapsed,
  (collapsed) => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(CONVERSATION_SIDEBAR_COLLAPSE_STORAGE_KEY, collapsed ? 'true' : 'false')
    } catch {
      // Ignore local persistence failures.
    }
  }
)
</script>

<template>
  <div class="chat-layout">
    <aside
      :class="['conversation-sidebar-shell', { collapsed: conversationSidebarCollapsed }]"
      :aria-label="conversationSidebarCollapsed ? $t('chatUi.conversationListCollapsed') : $t('chatUi.conversationList')"
    >
      <Transition name="conv-morph">
        <ConversationSidebar
          v-if="!conversationSidebarCollapsed"
          key="conv-list"
          ref="conversationSidebarRef"
          :agent-items="agentSidebarItems"
          :group-items="groupSidebarItems"
          :long-term-goal-items="longTermGoalSidebarItems"
          :conversation-items="conversationSidebarItems"
          :conversation-list-loaded="conversationsLoaded"
          :project-items="projectIndex"
          :grouping-mode="sidebarGroupingMode"
          @new-conversation="newConversation"
          @new-long-term-goal="startLongTermGoalCreation"
          @toggle-collapse="toggleConversationSidebar"
          @select-conversation="loadConversation"
          @open-agent="openAgentWorkspaceConversation"
          @open-group="openGroupWorkspaceConversation"
          @open-long-term-goal="openLongTermGoal"
          @delete-long-term-goal="deleteLongTermGoalById"
          @delete-conversation="deleteConversation"
          @rename-conversation="renameConversation"
          @update:grouping-mode="sidebarGroupingMode = $event"
          @assign-conversation-project="handleAssignConversationProject"
          @new-conversation-in-project="handleNewConversationInProject"
          @new-conversation-in-workspace="handleNewConversationInWorkspace"
          @add-project-folder="handleAddProjectFolder"
          @open-project="handleOpenProject"
          @new-conversation-in-folder="handleNewConversationInFolder"
          @organize-conversations="handleOrganizeConversations"
        />


        <div v-else key="conv-capsule" class="conversation-sidebar-capsule-wrap">
          <div class="conversation-sidebar-capsule">
            <button
              class="conversation-capsule-btn"
              type="button"
              :aria-label="$t('chatUi.expandConversationList')"
              @click="toggleConversationSidebar"
            >
              <SidebarIcon name="panel" :size="14" />
            </button>
            <span class="conversation-capsule-av" aria-hidden="true">
              <SidebarIcon :name="collapsedCapsuleIcon" :size="12" />
            </span>
            <button
              class="conversation-capsule-new"
              type="button"
              :title="$t('chatUi.newConversation')"
              :aria-label="$t('chatUi.newConversation')"
              @click="newConversation"
            >
              <SidebarIcon name="plus" :size="13" />
            </button>
          </div>

          <div class="conversation-capsule-flyout" :aria-label="$t('chatUi.quickSwitch')">
          <div class="capsule-flyout-head" aria-hidden="true">{{ $t('chatUi.quickSwitch') }}</div>
          <div class="capsule-flyout-body">
            <section
              v-for="section in capsuleFlyoutSections"
              :key="section.key"
              class="capsule-flyout-section"
            >
              <div class="capsule-flyout-label" aria-hidden="true">{{ section.label }}</div>
              <button
                v-for="row in section.rows"
                :key="row.id"
                :class="['capsule-flyout-row', { active: row.active }]"
                type="button"
                :title="row.title"
                @click="openCapsuleFlyoutRow(section.key, row.id)"
              >
                <span :class="['capsule-flyout-dot', row.status]" aria-hidden="true"></span>
                <span class="capsule-flyout-title">{{ row.title }}</span>
              </button>
            </section>
            <div v-if="!hasCapsuleFlyoutRows" class="capsule-flyout-empty">{{ $t('chatUi.quickSwitchEmpty') }}</div>
          </div>
          <button class="capsule-flyout-foot" type="button" @click="toggleConversationSidebar">
            <span>{{ $t('chatUi.expandConversationList') }}</span>
            <kbd aria-hidden="true">⌘\</kbd>
          </button>
        </div>
        </div>
      </Transition>


        <ConversationOrganizeDialog
          :open="organizeState.open"
          :loading="organizeState.loading"
          :stage="organizeState.stage"
          :progress="organizeState.progress"
          :error="organizeState.error"
          :groups="organizeState.groups"
          @close="organizeState.open = false"
          @confirm="applyOrganizeGroups"
        />
    </aside>

    <div
      :class="['chat-panel', { 'chat-panel-with-workspace': workspaceStore.visible.value }]"
      :style="{ '--chat-main-protected-min-width': `${MIN_CHAT_MAIN_WIDTH}px` }"
    >
      <div
        class="chat-main"
        :style="{ '--chat-input-card-inset': `${inputCardInset}px` }"
      >
        <LongTermGoalPanel
          v-if="currentLongTermGoal || longTermGoalWorkspaceActive"
          :goal="currentLongTermGoal"
          :auto-open-create="longTermGoalWorkspaceActive && !currentLongTermGoal"
          :snapshot="longTermGoalSnapshot"
          :providers="providers"
          :active-provider-id="activeProviderId"
          :selected-model="selectedModel"
          :available-agents="nonDefaultAgents"
          :selected-agent-id="agentSelectorValue"
          :streaming-adjust="streamingAdjust"
          :streaming-create="streamingCreate"
          :streaming-run="streamingRun"
          :streaming-replan="streamingReplan"
          :memory-compaction="memoryCompaction"
          :create-conversation-history="createConversationHistory"
          :pending-creation-confirm="pendingCreationConfirm"
          :goal-auto-open-run-id="goalAutoOpenRunId"
          @create="createLongTermGoal"
          @run-now="runLongTermGoalNow"
          @pause="pauseLongTermGoal"
          @resume="resumeLongTermGoal"
          @archive="archiveLongTermGoal"
          @delete-goal="deleteLongTermGoal"
          @save-goal="saveLongTermGoalPatch"
          @send-message="sendLongTermGoalMessage"
          @compact-memory="compactLongTermGoalMemory"
          @delete-memory="deleteLongTermGoalMemory"
          @apply-change-set="applyLongTermGoalChangeSet"
          @cancel-change-set="cancelLongTermGoalChangeSet"
          @confirm-creation="applyLongTermGoalCreation"
          @cancel-creation="cancelLongTermGoalCreation"
          @reset-creation="resetLongTermGoalCreation"
          @answer-intervention="answerLongTermGoalIntervention"
          @update:selected-agent-id="handleAgentSelectionChange"
          @clear-auto-open-run="clearGoalAutoOpenRunId"
        />

        <template v-else>
          <ChatHeader
            :context-label="currentContextLabel"
            :context-detail="currentContextDetail"
            :available-channel-bindings="availableChannelBindings"
            :selected-channel-binding-id="selectedChannelBindingId"
            :providers="providers"
            :active-provider-id="activeProviderId"
            :selected-model="selectedModel"
            :show-provider-selector="shouldUseConversationProviderOverride"
            :reasoning-strength="reasoningStrength"
            :reasoning-effort-options="activeModelReasoningEfforts"
            :temperature="conversationTemperature"
            :provider-default-temperature="providerDefaultTemperature"
            :is-group-conversation="isGroupConversation"
            :show-agent-selector="!currentConversationId"
            :available-agents="nonDefaultAgents"
            :selected-agent-id="agentSelectorValue"
            :coding-status="currentCodingStatus"
            :coding-diff-file-count="currentCodingDiff?.files.length || 0"
            :coding-loading="isLoading"
            @update:selected-channel-binding-id="handleChannelBindingSelectionChange"
            @select-provider-model="handleProviderModelSelectionChange"
            @update:reasoning-strength="handleReasoningStrengthChange"
            @update:temperature="handleTemperatureChange"
            @update:selected-agent-id="handleAgentSelectionChange"
            @open-coding-diff="openCodingDiff"
            @cancel-coding="stopCurrentStream"
            @retry-coding="retryLastUserMessage"
          />

          <div v-if="conversationDetailState === 'loading'" class="conversation-detail-state">
            <div class="conversation-detail-spinner" aria-hidden="true" />
            <span>{{ $t('chatUi.loadingConversation') }}</span>
          </div>
          <div v-else-if="conversationDetailState === 'error'" class="conversation-detail-state error">
            <strong>{{ $t('chatUi.conversationLoadFailed') }}</strong>
            <span>{{ conversationDetailError }}</span>
          </div>
          <MessageList
            v-else
            ref="messageListRef"
            :key="currentConversationId || 'draft'"
            :messages="messages"
            :is-loading="isLoading"
            :file-preview="filePreview"
            :assistant-icon="currentAssistantIcon"
            :assistant-name="currentAssistantName"
            :editing-message-id="editingMessageId"
            :group-mode="isGroupConversation"
            @respond-auth="respondToAuthRequest"
            @respond-sudo-password="respondToSudoPasswordRequest"
            @open-link="(url) => emit('openWebLink', url)"
            @open-file-path="openChatDocument"
            @request-edit-message="startEditUserMessage"
            @fork-message="forkFromMessage"
            @submit-edit="(payload) => editUserMessage(payload.messageId, payload.text, payload.mode)"
            @cancel-edit="cancelEditMessage"
            @add-to-context="handleAddSelectionToContext"
            @open-quick-ask="handleOpenQuickAsk"
            @remove-message-annotation="removeMessageAnnotation"
            @open-annotation-thread="handleOpenAnnotationThread"
          >
            <template v-if="showEmptyStateSuggestions" #empty>
              <EmptyStateSuggestions
                :snapshot="dailySuggestionSnapshot"
                :refreshing="suggestionRefreshing"
                :shuffling="knowledgeShuffling"
                :project-names="suggestionProjectNames"
                :providers-missing="providersMissing"
                @pick="pickSuggestion"
                @dismiss="(item) => dismissDailySuggestion(item)"
                @refresh="refreshDailySuggestions"
                @refresh-card="(item) => refreshKnowledgeSuggestionCard(item.id)"
                @shuffle="shuffleKnowledgeSuggestion"
                @open-settings="emit('openSettings', 'daily-suggestions')"
                @setup-provider="openProviderSetup"
                @seen="markDailySuggestionsSeen"
              />
            </template>
          </MessageList>

          <div ref="bottomDockRef" class="chat-bottom-dock">
            <div class="chat-attention-zone" aria-live="polite">
            <!-- design v1.7 stacking priority: auth > ask > todo (auth on top). -->
            <AuthPermissionPanel
              v-if="currentPendingAuthRequest"
              :request="currentPendingAuthRequest"
              :pending-count="currentPendingAuthCount"
              :expanded="expandedAttentionPanel === 'auth'"
              @toggle="toggleAttentionPanel('auth')"
              @respond="respondToAuthRequest"
            />

            <SudoPasswordPanel
              v-if="currentSudoPasswordRequest"
              :request="currentSudoPasswordRequest"
              :pending-count="currentPendingSudoPasswordCount"
              :expanded="expandedAttentionPanel === 'sudo'"
              @toggle="toggleAttentionPanel('sudo')"
              @respond="respondToSudoPasswordRequest"
            />

            <AskUserPanel
              v-if="currentAskUserRequest"
              :request="currentAskUserRequest"
              :expanded="expandedAttentionPanel === 'ask'"
              @toggle="toggleAttentionPanel('ask')"
              @submit="(requestId, answers) => respondToAskUserRequest(requestId, answers)"
              @cancel="(requestId) => respondToAskUserRequest(requestId, null)"
            />

            <PinnedTodoPanel
              v-if="activeTodoItems.length > 0"
              :items="activeTodoItems"
              :is-loading="isLoading"
              :expanded="expandedAttentionPanel === 'todo'"
              @toggle="toggleAttentionPanel('todo')"
            />
          </div>

          <ChatInput
            ref="chatInputRef"
            v-model="inputText"
            :is-loading="isLoading"
            :pending-auth-count="currentPendingAuthCount"
            :pending-images="pendingImages"
            :pending-files="pendingFiles"
            :is-uploading-files="isUploadingFiles"
            :upload-feedback="uploadFeedback"
            :workspace-visible="workspaceStore.visible.value"
            :auth-mode="currentAuthMode"
            :plan-mode-active="planModeActive"
            :computer-use-enabled="computerUseEnabled"
            :computer-use-permission-granted="computerUsePermissionGranted"
            :available-skills="availableSkills"
            :active-skill-ids="activeSkillIds"
            :show-skill-picker="showSkillPicker"
            :selected-group-id="selectedGroupId"
            :active-group-session-id="activeGroupSessionId"
            :group-mention-hints="groupMentionHints"
            :is-group-conversation="isGroupConversation"
            @send="handleChatSend"
            @stop="stopCurrentStream"
            @add-attachments="addAttachments"
            @remove-image="removeImage"
            @remove-file="removeFile"
            @toggle-workspace="toggleWorkspace"
            @update:auth-mode="handleAuthModeChange"
            @toggle-plan-mode="togglePlanMode"
            @toggle-computer-use="toggleComputerUse"
            @toggle-skill-picker="showSkillPicker = !showSkillPicker"
            @select-all-skills="selectAllSkills"
            @clear-skills="clearSkills"
            @toggle-skill="toggleSkill"
          />
          </div>

          <QuickAskPopover
            :state="quickAskState"
            @close="handleCloseQuickAsk"
            @ask="handleQuickAskAsk"
          />

          <Teleport to="body">
            <div v-if="projectPicker.visible" class="project-picker-backdrop" @click="closeProjectPicker">
              <div class="project-picker" role="dialog" @click.stop>
                <p class="project-picker-title">
                  {{ projectPicker.purpose === 'coding'
                    ? $t('chatUi.projectPickerCodingTitle')
                    : $t('chatUi.projectPickerTitle') }}
                </p>
                <div v-if="projectPicker.loading" class="project-picker-hint">{{ $t('chatUi.projectPickerLoading') }}</div>
                <div v-else-if="projectPicker.error" class="project-picker-hint project-picker-error">{{ projectPicker.error }}</div>
                <div v-else class="project-picker-list">
                  <button
                    v-for="entry in projectPicker.entries"
                    :key="entry.id"
                    class="project-picker-option"
                    type="button"
                    @click="pickProject(entry)"
                  >
                    <span class="project-picker-icon">{{ entry.icon || '🧩' }}</span>
                    <span class="project-picker-name">{{ entry.name }}</span>
                  </button>
                </div>
                <button class="project-picker-close" type="button" @click="closeProjectPicker">
                  {{ $t('common.cancel') }}
                </button>
              </div>
            </div>
          </Teleport>
        </template>
      </div>

      <WorkspacePanel
        :visible="workspaceStore.visible.value"
        :tabs="workspaceStore.tabs.value"
        :active-tab-id="workspaceStore.activeTabId.value"
        :workspace-width="workspaceStore.width.value"
        @close="closeWorkspace"
        @close-tab="closeWorkspaceTab"
        @activate-tab="handleWorkspaceTabActivate"
        @add-tab="handleWorkspaceAddTab"
        @update-width="handleWorkspaceWidthUpdate"
        @insert-selection-tag="insertDocumentTag"
        @update-tab-state="handleWorkspaceTabStateUpdate"
      />
    </div>
  </div>
</template>

<style scoped>
.chat-layout {
  display: flex;
  height: 100%;
}

.conversation-sidebar-shell {
  position: relative;
  z-index: 20;
  width: 224px;
  flex: 0 0 224px;
  min-width: 0;
  display: flex;
  isolation: isolate;
  background: var(--app-chat-list-surface);
  transition: width 0.22s ease, flex-basis 0.22s ease;
  /*
   * Own compositing layer, same reason as .chat-header: while a conversation
   * streams, the message list repaints every flush and those GPU layer
   * rebuilds momentarily drop the unpromoted sidebar column behind the chat
   * canvas, flashing the conversation list. Pinning the column to its own
   * layer keeps its paint independent of the streaming repaints.
   */
  transform: translateZ(0);
}

.conversation-sidebar-shell.collapsed {
  width: 0;
  flex-basis: 0;
  overflow: visible;
}

/* ---- Collapsed state: floating glass capsule (design v1.7) ----
   The collapsed list occupies no column. A translucent vertical capsule
   hovers over the chat's left edge; hover turns the border solid accent,
   click restores the list. Hovering also opens a compact quick-switch
   flyout so conversations can be switched without expanding the rail. */
/* Positioning wrapper — must stay filter-free: a backdrop-filter here would
   become the flyout's backdrop root and its blur would sample nothing. */
.conversation-sidebar-capsule-wrap {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 22;
}

.conversation-sidebar-capsule {
  width: 36px;
  padding: 8px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  border-radius: 999px;
  border: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-chat-list-raised) 58%, transparent);
  backdrop-filter: blur(16px) saturate(150%);
  box-shadow: var(--shadow-2);
  color: var(--app-text-muted);
  user-select: none;
  transition: border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
}

/* ---- Collapse morph (conv-morph transition) ----
   The list squashes down onto the capsule's footprint and fades; the capsule
   grows out of the same spot. Origin 30px/50% is the capsule's center
   (left 12px + 36px/2, vertically centered). The leaving/entering list is
   pinned absolute at full 224px so the shell's 224→0 width collapse never
   reflows it — the scale transform does all the visible squashing. */
.conv-sidebar.conv-morph-leave-active,
.conv-sidebar.conv-morph-enter-active {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 224px;
  transform-origin: 30px 50%;
  pointer-events: none;
}

.conv-sidebar.conv-morph-leave-active {
  transition: opacity 0.2s ease, transform 0.24s var(--ease-out), border-radius 0.24s var(--ease-out);
}

.conv-sidebar.conv-morph-enter-active {
  transition: opacity 0.18s ease, transform 0.24s var(--ease-out), border-radius 0.24s var(--ease-out);
}

/* Corners round as it squashes — the rectangle literally becomes the capsule. */
.conv-sidebar.conv-morph-leave-to,
.conv-sidebar.conv-morph-enter-from {
  opacity: 0;
  transform: scale(0.16, 0.2);
  border-radius: 999px;
}

/* Capsule counterparty: slightly delayed so the list visibly lands first. */
.conversation-sidebar-capsule-wrap.conv-morph-enter-active {
  transition: opacity 0.16s ease 0.08s, transform 0.18s var(--ease-out) 0.08s;
}

.conversation-sidebar-capsule-wrap.conv-morph-enter-from {
  opacity: 0;
  transform: translateY(-50%) scale(0.5);
}

.conversation-sidebar-capsule-wrap.conv-morph-leave-active {
  transition: opacity 0.14s ease, transform 0.16s var(--ease-out);
}

.conversation-sidebar-capsule-wrap.conv-morph-leave-to {
  opacity: 0;
  transform: translateY(-50%) scale(0.5);
}

.conversation-sidebar-capsule-wrap:hover .conversation-sidebar-capsule,
.conversation-sidebar-capsule-wrap:focus-within .conversation-sidebar-capsule {
  border: 1.5px solid var(--app-accent);
  background: color-mix(in srgb, var(--app-chat-list-raised) 90%, transparent);
  box-shadow: var(--shadow-3), 0 0 0 3px var(--app-accent-soft);
  color: var(--app-accent-strong);
  outline: none;
}

.conversation-capsule-btn {
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--app-text-soft);
  cursor: pointer;
}

.conversation-sidebar-capsule-wrap:hover .conversation-capsule-btn,
.conversation-sidebar-capsule-wrap:focus-within .conversation-capsule-btn {
  color: var(--app-accent-strong);
}

.conversation-capsule-av {
  width: 22px;
  height: 22px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--app-accent-soft);
  color: var(--app-accent-strong);
}

.conversation-capsule-new {
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--app-text-faint);
  cursor: pointer;
  transition: color 0.16s ease, background 0.16s ease;
}

.conversation-capsule-new:hover {
  color: var(--app-accent-strong);
  background: color-mix(in srgb, var(--app-accent-soft) 55%, transparent);
}

/* ---- Capsule hover flyout: compact quick-switch list ----
   No overflow:hidden here — it would clip the hover bridge below. The
   body scrolls (and clips) on its own; the footer rounds its own corners.
   Sibling of the capsule (not its child) so its backdrop-filter samples
   the page behind instead of the capsule's backdrop root. */
.conversation-capsule-flyout {
  position: absolute;
  left: calc(100% + 10px);
  top: 50%;
  width: 236px;
  max-height: min(420px, 64vh);
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  border: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel-strong) 86%, transparent);
  backdrop-filter: blur(14px) saturate(130%);
  box-shadow: var(--shadow-3);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateY(-50%) translateX(-4px);
  transition: opacity 0.16s ease, transform 0.16s var(--ease-out), visibility 0.16s ease;
}

/* Invisible bridge so the pointer can travel the capsule→flyout gap
   without the flyout closing. */
.conversation-capsule-flyout::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -12px;
  width: 12px;
}

.conversation-sidebar-capsule-wrap:hover .conversation-capsule-flyout,
.conversation-sidebar-capsule-wrap:focus-within .conversation-capsule-flyout {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: translateY(-50%) translateX(0);
}

.capsule-flyout-head {
  padding: 10px 13px 6px;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--app-text-faint);
}

.capsule-flyout-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 6px 6px;
}

.capsule-flyout-section + .capsule-flyout-section {
  margin-top: 5px;
  padding-top: 5px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
}

.capsule-flyout-label {
  padding: 3px 7px;
  font-size: 0.58rem;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--app-text-faint);
}

.capsule-flyout-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 26px;
  padding: 3px 7px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text-soft);
  font: inherit;
  font-size: 0.74rem;
  text-align: left;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}

.capsule-flyout-row:hover {
  background: color-mix(in srgb, var(--app-panel-muted) 72%, transparent);
  color: var(--app-text);
}

.capsule-flyout-row.active {
  background: color-mix(in srgb, var(--app-accent-wash, color-mix(in srgb, var(--app-accent) 16%, transparent)) 60%, transparent);
  color: var(--app-text-strong);
  font-weight: 600;
}

.capsule-flyout-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.capsule-flyout-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--app-text-faint) 55%, transparent);
}

.capsule-flyout-dot.streaming {
  background: var(--app-accent-strong);
  animation: capsule-flyout-pulse 1.15s ease-in-out infinite;
}

.capsule-flyout-dot.auth {
  background: var(--app-warning-strong);
  animation: capsule-flyout-pulse 1.45s ease-in-out infinite;
}

.capsule-flyout-dot.unread {
  background: var(--app-warning-strong);
}

@keyframes capsule-flyout-pulse {
  0%, 100% { transform: scale(0.85); opacity: 0.72; }
  50% { transform: scale(1.15); opacity: 1; }
}

.capsule-flyout-empty {
  padding: 14px 10px 16px;
  font-size: 0.72rem;
  color: var(--app-text-muted);
  text-align: center;
}

.capsule-flyout-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 13px;
  border: none;
  border-top: 1px solid var(--app-border);
  border-radius: 0 0 13px 13px;
  background: color-mix(in srgb, var(--app-panel-muted) 50%, transparent);
  color: var(--app-text-muted);
  font: inherit;
  font-size: 0.68rem;
  cursor: pointer;
  transition: color 0.14s ease, background 0.14s ease;
}

.capsule-flyout-foot:hover {
  color: var(--app-accent-strong);
  background: color-mix(in srgb, var(--app-accent-soft) 26%, transparent);
}

.capsule-flyout-foot kbd {
  font-family: inherit;
  font-size: 0.62rem;
  color: var(--app-text-faint);
  border: 1px solid var(--app-border);
  border-radius: 5px;
  padding: 1px 5px;
}

@media (prefers-reduced-motion: reduce) {
  .conv-sidebar.conv-morph-enter-active,
  .conv-sidebar.conv-morph-leave-active,
  .conversation-sidebar-capsule-wrap.conv-morph-enter-active,
  .conversation-sidebar-capsule-wrap.conv-morph-leave-active {
    transition: opacity 0.15s ease;
  }

  .conv-sidebar.conv-morph-enter-from,
  .conv-sidebar.conv-morph-leave-to {
    transform: none;
  }

  .conversation-sidebar-capsule-wrap.conv-morph-enter-from,
  .conversation-sidebar-capsule-wrap.conv-morph-leave-to {
    transform: translateY(-50%);
  }

  .capsule-flyout-dot.streaming,
  .capsule-flyout-dot.auth {
    animation: none;
  }
}

.chat-panel {
  --chat-message-gutter: clamp(24px, 4vw, 64px);
  --chat-message-track-max: 980px;
  --chat-user-message-max: 680px;
  --chat-user-bubble-max: 540px;
  --chat-event-card-max: 100%;
  --chat-input-gutter: 16px;
  display: flex;
  flex-direction: row;
  flex: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
  overflow: hidden;
}


.chat-bottom-dock {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 7;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  pointer-events: none;
}

.chat-bottom-dock > * {
  pointer-events: auto;
}

.chat-attention-zone {
  /*
   * Attention panels used to be absolutely positioned above the composer.
   * That made their measured height and the scroll viewport disagree: a
   * streaming reflow could put message text behind the panels or the input.
   * Keep the zone in normal flow so an expanded request always consumes real
   * vertical space.
   */
  /* Attached to the composer: the whole bottom dock floats over the message
     list, and the list reserves the dock height as bottom padding. */
  position: relative;
  width: calc(100% - (var(--chat-input-gutter, 16px) * 2));
  max-height: min(42vh, 360px);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
  margin: 0 auto 8px;
  padding: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  pointer-events: none;
}

.chat-attention-zone > * {
  flex: 0 0 auto;
  width: 100%;
  pointer-events: auto;
}

.conversation-detail-state {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--app-text-muted);
  font-size: 0.84rem;
  padding: 24px;
  text-align: center;
}

.conversation-detail-state.error {
  color: var(--app-danger);
}

.conversation-detail-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid color-mix(in srgb, var(--app-accent) 24%, transparent);
  border-top-color: var(--app-accent);
  border-radius: 50%;
  animation: conversation-detail-spin 0.8s linear infinite;
}

@keyframes conversation-detail-spin {
  to { transform: rotate(360deg); }
}

.chat-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  position: relative;
  background: var(--app-chat-canvas);
  isolation: isolate;
}

.chat-main {
  min-width: var(--chat-main-protected-min-width, 640px);
  flex-shrink: 0;
}

.project-picker-backdrop {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.32);
}

.project-picker {
  width: min(360px, 86vw);
  max-height: min(420px, 70vh);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-panel);
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.24);
}

.project-picker-title {
  margin: 0;
  color: var(--app-text-strong);
  font-size: 0.9rem;
  font-weight: 700;
}

.project-picker-hint {
  color: var(--app-text-muted);
  font-size: 0.82rem;
  padding: 8px 2px;
}

.project-picker-error {
  overflow-wrap: anywhere;
}

.project-picker-list {
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}

.project-picker-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--app-text-strong);
  font-size: 0.86rem;
  text-align: left;
  cursor: pointer;
}

.project-picker-option:hover {
  background: var(--app-accent-soft);
}

.project-picker-icon {
  flex-shrink: 0;
}

.project-picker-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-picker-close {
  align-self: flex-end;
  padding: 7px 14px;
  border: 1px solid var(--app-border-strong);
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-strong);
  cursor: pointer;
}
</style>
