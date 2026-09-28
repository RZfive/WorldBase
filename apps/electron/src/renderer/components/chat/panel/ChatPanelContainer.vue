<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ConversationSidebar from '../layout/ConversationSidebar.vue'
import SidebarIcon from '../layout/SidebarIcon.vue'
import MessageList from '../messages/MessageList.vue'
import EmptyStateSuggestions from '../messages/EmptyStateSuggestions.vue'
import ChatInput from '../layout/ChatInput.vue'
import ChatHeader from '../layout/ChatHeader.vue'
import QuickAskPopover from '../layout/QuickAskPopover.vue'
import { generateId } from './message-blocks'
import DocumentWorkspace from '../layout/DocumentWorkspace.vue'
import FolderWorkspace from '../layout/FolderWorkspace.vue'
import PinnedTodoPanel from '../layout/PinnedTodoPanel.vue'
import AskUserPanel from '../layout/AskUserPanel.vue'
import AuthPermissionPanel from '../layout/AuthPermissionPanel.vue'
import SudoPasswordPanel from '../layout/SudoPasswordPanel.vue'
import LongTermGoalPanel from '../layout/LongTermGoalPanel.vue'
import { useChatPanel } from './useChatPanel'
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
import type { ChatPanelEmit, ChatPanelProps } from './types'
import type { AnnotationAnchor, MessageAnnotationLocator, QuickAskMode, QuickAskPopoverState } from '../types'

const props = defineProps<ChatPanelProps>()
const emit = defineEmits<ChatPanelEmit>()
const { t } = useI18n()

const DEFAULT_APP_WINDOW_MIN_WIDTH = 800
const CONVERSATION_SIDEBAR_WIDTH = 224
const CONVERSATION_SIDEBAR_COLLAPSED_WIDTH = 0
const MIN_CHAT_MAIN_WIDTH = 640
const DOCUMENT_WORKSPACE_LIST_WIDTH = 260
const DOCUMENT_WORKSPACE_PREVIEW_MIN_WIDTH = DOCUMENT_WORKSPACE_LIST_WIDTH * 2
const DOCUMENT_WORKSPACE_RESIZE_HANDLE_WIDTH = 12
const MIN_DOCUMENT_WORKSPACE_WIDTH = DOCUMENT_WORKSPACE_LIST_WIDTH + DOCUMENT_WORKSPACE_PREVIEW_MIN_WIDTH + DOCUMENT_WORKSPACE_RESIZE_HANDLE_WIDTH
const MAX_DOCUMENT_WORKSPACE_WIDTH = 1280
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
  currentContextDetail,
  currentContextLabel,
  currentConversationId,
  currentLongTermGoal,
  currentPendingAuthCount,
  currentPendingAuthRequest,
  currentPendingSudoPasswordCount,
  currentSudoPasswordRequest,
  deleteConversation,
  deleteLongTermGoal,
  documentDockVisible,
  documentWorkspaceActiveFilePath,
  documentWorkspaceDocuments,
  documentWorkspaceWidth,
  folderWorkspaceActiveFilePath,
  folderWorkspaceRootName,
  folderWorkspaceRootPath,
  folderWorkspaceVisible,
  folderWorkspaceWidth,
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
  togglePlanMode,
  toggleComputerUse,
  toggleSkill,
  clearSkills,
  updateDocumentWorkspaceState,
  updateFolderWorkspaceState,
  uploadFeedback,
  addAttachments
} = useChatPanel(props, {
  onContextConsumed: () => emit('contextConsumed')
})

// Quick Q&A over a text selection: an inline popover anchored next to the
// text. The first answer creates the annotation; the popover stays open as a
// thread so the user can keep asking in 简略/详细 depth.
const quickAskState = ref<QuickAskPopoverState | null>(null)

// The strength control renders exactly the levels the active model declares
// (from the provider's /models metadata); undeclared models get the standard
// four. Switching models swaps the choices with the model.
const activeModelReasoningEfforts = computed<string[]>(() => {
  const provider = providersConfig.value.providers.find(item => item.id === activeProviderId.value)
  const declared = provider?.modelCapabilities?.[selectedModel.value]?.reasoningEfforts || []
  return declared.length > 0 ? declared : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
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
const isOpeningDocumentWorkspace = ref(false)
const isClosingDocumentWorkspace = ref(false)
const isOpeningFolderWorkspace = ref(false)
const isClosingFolderWorkspace = ref(false)
const chatWindowWidthBeforeWorkspace = ref<number | null>(null)
const CONVERSATION_SIDEBAR_COLLAPSE_STORAGE_KEY = 'chat-conversation-sidebar-collapsed'

// The ChatHeader floats as a frosted bar over the message list. Its height is
// dynamic (provider/skill controls render conditionally), so we measure it and
// expose it as a CSS token the MessageList uses for top padding — keeping the
// first message clear of the overlay without a hard divider line.
const chatHeaderRef = ref<{ $el?: HTMLElement } | null>(null)
const chatHeaderHeight = ref(0)
let headerResizeObserver: ResizeObserver | null = null

function measureChatHeader (): void {
  const el = chatHeaderRef.value?.$el
  if (!el) return
  chatHeaderHeight.value = el.offsetHeight
}

// The attention zone (design v1.7: auth / ask / todo) floats 6px above the
// input card. The card's height follows the textarea, the runtime bar and
// attachment previews, so measure it and expose it as a CSS token — same
// approach as the floating header above.
const chatInputRef = ref<{ $el?: HTMLElement } | null>(null)
const chatInputCardHeight = ref(0)
let inputCardResizeObserver: ResizeObserver | null = null
let observedInputCard: HTMLElement | null = null

function measureChatInputCard (): void {
  const card = chatInputRef.value?.$el?.querySelector<HTMLElement>('.input-container')
  if (!card) return
  if (inputCardResizeObserver && card !== observedInputCard) {
    inputCardResizeObserver.disconnect()
    observedInputCard = card
    inputCardResizeObserver.observe(card)
  }
  chatInputCardHeight.value = card.offsetHeight
}

onMounted(() => {
  measureChatHeader()
  const el = chatHeaderRef.value?.$el
  if (el && typeof ResizeObserver !== 'undefined') {
    headerResizeObserver = new ResizeObserver(() => measureChatHeader())
    headerResizeObserver.observe(el)
  }
  if (typeof ResizeObserver !== 'undefined') {
    inputCardResizeObserver = new ResizeObserver(() => {
      if (observedInputCard) chatInputCardHeight.value = observedInputCard.offsetHeight
    })
  }
  measureChatInputCard()
  window.addEventListener('keydown', onSidebarShortcut)
})

watch(chatInputRef, () => {
  measureChatInputCard()
}, { flush: 'post' })

onBeforeUnmount(() => {
  headerResizeObserver?.disconnect()
  headerResizeObserver = null
  inputCardResizeObserver?.disconnect()
  inputCardResizeObserver = null
  observedInputCard = null
  window.removeEventListener('keydown', onSidebarShortcut)
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
    sections.push({
      key: 'conversations',
      label: t('appShell.chat'),
      rows: conversationSidebarItems.value.map(item => ({ id: item.id, title: item.title, active: item.isActive, status: statusOf(item) }))
    })
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

function getPreferredWorkspaceWidth (kind: 'document' | 'folder' = 'document'): number {
  const preferredWidth = kind === 'folder' ? folderWorkspaceWidth.value : documentWorkspaceWidth.value
  return Math.max(
    MIN_DOCUMENT_WORKSPACE_WIDTH,
    Math.min(MAX_DOCUMENT_WORKSPACE_WIDTH, Math.round(preferredWidth || MIN_DOCUMENT_WORKSPACE_WIDTH))
  )
}

function getActiveWorkspaceKind (): 'document' | 'folder' | null {
  if (documentDockVisible.value) return 'document'
  if (folderWorkspaceVisible.value) return 'folder'
  return null
}

function getRequiredWindowWidthForWorkspace (kind: 'document' | 'folder' = getActiveWorkspaceKind() || 'document'): number {
  return conversationSidebarWidth.value + MIN_CHAT_MAIN_WIDTH + getPreferredWorkspaceWidth(kind)
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

async function ensureWindowFitsWorkspace (kind: 'document' | 'folder', options?: { animate?: boolean }): Promise<void> {
  if (!window.electronAPI?.ensureWindowWidth) return

  try {
    await window.electronAPI.ensureWindowWidth(
      getRequiredWindowWidthForWorkspace(kind),
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

async function openDocumentWorkspace (): Promise<void> {
  if (documentDockVisible.value || isOpeningDocumentWorkspace.value || isClosingDocumentWorkspace.value) return

  isOpeningDocumentWorkspace.value = true

  try {
    folderWorkspaceVisible.value = false
    chatWindowWidthBeforeWorkspace.value = await getCurrentWindowWidth()
    await ensureWindowFitsWorkspace('document', { animate: true })
    await setWindowMinimumWidth(getRequiredWindowWidthForWorkspace('document'))
  } finally {
    documentDockVisible.value = true
    isOpeningDocumentWorkspace.value = false
  }
}

async function closeDocumentWorkspace (): Promise<void> {
  if (!documentDockVisible.value || isClosingDocumentWorkspace.value) return

  isClosingDocumentWorkspace.value = true
  const currentWindowWidth = await getCurrentWindowWidth()
  const targetWindowWidth = resolveWorkspaceCloseTargetWidth(currentWindowWidth)

  documentDockVisible.value = false

  try {
    await setWindowMinimumWidth(DEFAULT_APP_WINDOW_MIN_WIDTH)
    await animateWindowWidthRecovery(targetWindowWidth)
  } finally {
    chatWindowWidthBeforeWorkspace.value = null
    isClosingDocumentWorkspace.value = false
  }
}

async function toggleDocumentWorkspace (): Promise<void> {
  if (isOpeningDocumentWorkspace.value || isClosingDocumentWorkspace.value) return

  if (documentDockVisible.value) {
    await closeDocumentWorkspace()
    return
  }

  await openDocumentWorkspace()
}

async function openFolderWorkspace (): Promise<void> {
  if (folderWorkspaceVisible.value || isOpeningFolderWorkspace.value || isClosingFolderWorkspace.value) return

  isOpeningFolderWorkspace.value = true

  try {
    documentDockVisible.value = false
    chatWindowWidthBeforeWorkspace.value = await getCurrentWindowWidth()
    await ensureWindowFitsWorkspace('folder', { animate: true })
    await setWindowMinimumWidth(getRequiredWindowWidthForWorkspace('folder'))
  } finally {
    folderWorkspaceVisible.value = true
    isOpeningFolderWorkspace.value = false
  }
}

async function closeFolderWorkspace (): Promise<void> {
  if (!folderWorkspaceVisible.value || isClosingFolderWorkspace.value) return

  isClosingFolderWorkspace.value = true
  const currentWindowWidth = await getCurrentWindowWidth()
  const targetWindowWidth = resolveWorkspaceCloseTargetWidth(currentWindowWidth)

  folderWorkspaceVisible.value = false

  try {
    await setWindowMinimumWidth(DEFAULT_APP_WINDOW_MIN_WIDTH)
    await animateWindowWidthRecovery(targetWindowWidth)
  } finally {
    chatWindowWidthBeforeWorkspace.value = null
    isClosingFolderWorkspace.value = false
  }
}

async function toggleFolderWorkspace (): Promise<void> {
  if (isOpeningFolderWorkspace.value || isClosingFolderWorkspace.value) return

  if (folderWorkspaceVisible.value) {
    await closeFolderWorkspace()
    return
  }

  await openFolderWorkspace()
}

watch(
  chatSurfaceStatus,
  (status) => {
    emit('statusChange', status)
  },
  { immediate: true }
)

watch(
  [documentDockVisible, folderWorkspaceVisible, documentWorkspaceWidth, folderWorkspaceWidth, conversationSidebarCollapsed],
  ([documentVisible, folderVisible], previousState) => {
    const visible = documentVisible || folderVisible
    const previousVisible = Boolean(previousState?.[0] || previousState?.[1])
    const kind = documentVisible ? 'document' : 'folder'
    void setWindowMinimumWidth(visible ? getRequiredWindowWidthForWorkspace(kind) : DEFAULT_APP_WINDOW_MIN_WIDTH)
    if (visible && !previousVisible && !isOpeningDocumentWorkspace.value && !isOpeningFolderWorkspace.value) {
      void ensureWindowFitsWorkspace(kind)
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
          :agent-items="agentSidebarItems"
          :group-items="groupSidebarItems"
          :long-term-goal-items="longTermGoalSidebarItems"
          :conversation-items="conversationSidebarItems"
          :conversation-list-loaded="conversationsLoaded"
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
    </aside>

    <div
      :class="['chat-panel', { 'chat-panel-with-workspace': documentDockVisible || folderWorkspaceVisible }]"
      :style="{ '--chat-main-protected-min-width': `${MIN_CHAT_MAIN_WIDTH}px` }"
    >
      <div
        class="chat-main"
        :style="{
          '--chat-header-height': `${chatHeaderHeight}px`,
          '--chat-input-card-height': chatInputCardHeight > 0 ? `${chatInputCardHeight}px` : undefined
        }"
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
            ref="chatHeaderRef"
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
            @update:selected-channel-binding-id="handleChannelBindingSelectionChange"
            @select-provider-model="handleProviderModelSelectionChange"
            @update:reasoning-strength="handleReasoningStrengthChange"
            @update:temperature="handleTemperatureChange"
            @update:selected-agent-id="handleAgentSelectionChange"
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

          <div class="chat-attention-zone" aria-live="polite">
            <!-- design v1.7 stacking priority: auth > ask > todo (auth on top). -->
            <AuthPermissionPanel
              v-if="currentPendingAuthRequest"
              :request="currentPendingAuthRequest"
              :pending-count="currentPendingAuthCount"
              @respond="respondToAuthRequest"
            />

            <SudoPasswordPanel
              v-if="currentSudoPasswordRequest"
              :request="currentSudoPasswordRequest"
              :pending-count="currentPendingSudoPasswordCount"
              @respond="respondToSudoPasswordRequest"
            />

            <AskUserPanel
              v-if="currentAskUserRequest"
              :request="currentAskUserRequest"
              @submit="(requestId, answers) => respondToAskUserRequest(requestId, answers)"
              @cancel="(requestId) => respondToAskUserRequest(requestId, null)"
            />

            <PinnedTodoPanel
              v-if="activeTodoItems.length > 0"
              :items="activeTodoItems"
              :is-loading="isLoading"
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
            :document-dock-visible="documentDockVisible"
            :folder-workspace-visible="folderWorkspaceVisible"
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
            @send="sendMessage"
            @stop="stopCurrentStream"
            @add-attachments="addAttachments"
            @remove-image="removeImage"
            @remove-file="removeFile"
            @toggle-document-dock="toggleDocumentWorkspace"
            @toggle-folder-workspace="toggleFolderWorkspace"
            @update:auth-mode="handleAuthModeChange"
            @toggle-plan-mode="togglePlanMode"
            @toggle-computer-use="toggleComputerUse"
            @toggle-skill-picker="showSkillPicker = !showSkillPicker"
            @select-all-skills="selectAllSkills"
            @clear-skills="clearSkills"
            @toggle-skill="toggleSkill"
          />

          <QuickAskPopover
            :state="quickAskState"
            @close="handleCloseQuickAsk"
            @ask="handleQuickAskAsk"
          />
        </template>
      </div>

      <DocumentWorkspace
        :visible="documentDockVisible"
        :workspace-documents="documentWorkspaceDocuments"
        :active-file-path="documentWorkspaceActiveFilePath"
        :workspace-width="documentWorkspaceWidth"
        @close="closeDocumentWorkspace"
        @insert-selection-tag="insertDocumentTag"
        @update-workspace="updateDocumentWorkspaceState"
      />

      <FolderWorkspace
        :visible="folderWorkspaceVisible"
        :root-path="folderWorkspaceRootPath"
        :root-name="folderWorkspaceRootName"
        :active-file-path="folderWorkspaceActiveFilePath"
        :workspace-width="folderWorkspaceWidth"
        @close="closeFolderWorkspace"
        @insert-selection-tag="insertDocumentTag"
        @update-workspace="updateFolderWorkspaceState"
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
  transition: width 0.22s ease, flex-basis 0.22s ease;
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
  --chat-input-overlap: clamp(52px, 7vh, 88px);
  --chat-input-gutter: 16px;
  display: flex;
  flex-direction: row;
  flex: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
  overflow: hidden;
}


.chat-attention-zone {
  position: absolute;
  left: 16px;
  right: 16px;
  /*
   * design v1.7: the capsules sit 6px above the input card. The card is
   * wrapped by .chat-input's 18px bottom padding, so the offset from the
   * panel bottom is measured-card-height + 24px — tracked via the
   * ResizeObserver-fed token instead of the old overlap guess that let the
   * capsules float inside the input box.
   */
  bottom: calc(var(--chat-input-card-height, 176px) + 24px);
  z-index: 8;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  max-height: min(52vh, 460px);
  pointer-events: none;
}

.chat-attention-zone > * {
  flex: 0 0 auto;
  width: 100%;
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
}

.chat-main {
  min-width: var(--chat-main-protected-min-width, 640px);
  flex-shrink: 0;
}
</style>
