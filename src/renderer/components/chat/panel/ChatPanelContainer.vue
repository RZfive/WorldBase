<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ConversationSidebar from '../layout/ConversationSidebar.vue'
import MessageList from '../messages/MessageList.vue'
import ChatInput from '../layout/ChatInput.vue'
import ChatHeader from '../layout/ChatHeader.vue'
import DocumentWorkspace from '../layout/DocumentWorkspace.vue'
import FolderWorkspace from '../layout/FolderWorkspace.vue'
import PinnedTodoPanel from '../layout/PinnedTodoPanel.vue'
import AskUserPanel from '../layout/AskUserPanel.vue'
import AuthPermissionPanel from '../layout/AuthPermissionPanel.vue'
import SudoPasswordPanel from '../layout/SudoPasswordPanel.vue'
import LongTermGoalPanel from '../layout/LongTermGoalPanel.vue'
import { useChatPanel } from './useChatPanel'
import type { ChatPanelEmit, ChatPanelProps } from './types'

const props = defineProps<ChatPanelProps>()
const emit = defineEmits<ChatPanelEmit>()
const { t } = useI18n()

const DEFAULT_APP_WINDOW_MIN_WIDTH = 800
const CONVERSATION_SIDEBAR_WIDTH = 280
const CONVERSATION_SIDEBAR_COLLAPSED_WIDTH = 64
const MIN_CHAT_MAIN_WIDTH = 640
const DOCUMENT_WORKSPACE_LIST_WIDTH = 260
const DOCUMENT_WORKSPACE_PREVIEW_MIN_WIDTH = DOCUMENT_WORKSPACE_LIST_WIDTH * 2
const DOCUMENT_WORKSPACE_RESIZE_HANDLE_WIDTH = 12
const MIN_DOCUMENT_WORKSPACE_WIDTH = DOCUMENT_WORKSPACE_LIST_WIDTH + DOCUMENT_WORKSPACE_PREVIEW_MIN_WIDTH + DOCUMENT_WORKSPACE_RESIZE_HANDLE_WIDTH
const MAX_DOCUMENT_WORKSPACE_WIDTH = 1280
const WORKSPACE_OPEN_ANIMATION_DURATION_MS = 240

const {
  activeProviderId,
  activeSkillIds,
  activeTodoItems,
  agentSelectorValue,
  agentSidebarItems,
  availableChannelBindings,
  availableSkills,
  conversationsLoaded,
  conversationSidebarItems,
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
  handleModelSelectionChange,
  handleProviderSelectionChange,
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
  providers,
  providerDefaultTemperature,
  conversationTemperature,
  reasoningStrength,
  renameConversation,
  removeFile,
  removeImage,
  resumeLongTermGoal,
  runLongTermGoalNow,
  archiveLongTermGoal,
  saveLongTermGoalPatch,
  respondToAuthRequest,
  respondToSudoPasswordRequest,
  respondToAskUserRequest,
  selectedChannelBindingId,
  selectedModel,
  selectAllSkills,
  sendMessage,
  sendLongTermGoalMessage,
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
  createConversationHistory,
  goalAutoOpenRunId,
  clearGoalAutoOpenRunId,
  shouldUseConversationProviderOverride,
  showSkillPicker,
  stopCurrentStream,
  togglePlanMode,
  toggleSkill,
  clearSkills,
  updateDocumentWorkspaceState,
  updateFolderWorkspaceState,
  uploadFeedback,
  addAttachments
} = useChatPanel(props, {
  onContextConsumed: () => emit('contextConsumed')
})

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

onMounted(() => {
  measureChatHeader()
  const el = chatHeaderRef.value?.$el
  if (el && typeof ResizeObserver !== 'undefined') {
    headerResizeObserver = new ResizeObserver(() => measureChatHeader())
    headerResizeObserver.observe(el)
  }
})

onBeforeUnmount(() => {
  headerResizeObserver?.disconnect()
  headerResizeObserver = null
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
const collapsedAgentActive = computed(() => agentSidebarItems.value.some(item => item.isActive))
const collapsedGroupActive = computed(() => groupSidebarItems.value.some(item => item.isActive))
const collapsedLongTermGoalActive = computed(() => longTermGoalSidebarItems.value.some(item => item.isActive))
const collapsedConversationActive = computed(() => conversationSidebarItems.value.some(item => item.isActive))

function toggleConversationSidebar (): void {
  conversationSidebarCollapsed.value = !conversationSidebarCollapsed.value
}

function openFirstCollapsedAgent (): void {
  const item = agentSidebarItems.value.find(entry => entry.isActive) || agentSidebarItems.value[0]
  if (item) openAgentWorkspaceConversation(item.id)
}

function openFirstCollapsedGroup (): void {
  const item = groupSidebarItems.value.find(entry => entry.isActive) || groupSidebarItems.value[0]
  if (item) openGroupWorkspaceConversation(item.id)
}

function openFirstCollapsedLongTermGoal (): void {
  const item = longTermGoalSidebarItems.value.find(entry => entry.isActive) || longTermGoalSidebarItems.value[0]
  if (item) {
    void openLongTermGoal(item.id)
    return
  }
  void createLongTermGoal()
}

function openFirstCollapsedConversation (): void {
  const item = conversationSidebarItems.value.find(entry => entry.isActive) || conversationSidebarItems.value[0]
  if (item) loadConversation(item.id)
}

function openCollapsedSidebarAgent (item: typeof agentSidebarItems.value[number]): void {
  openAgentWorkspaceConversation(item.id)
}

function openCollapsedSidebarGroup (item: typeof groupSidebarItems.value[number]): void {
  openGroupWorkspaceConversation(item.id)
}

function openCollapsedSidebarLongTermGoal (item: typeof longTermGoalSidebarItems.value[number]): void {
  void openLongTermGoal(item.id)
}

function deleteLongTermGoalById (goalId: string): void {
  const goal = currentLongTermGoal.value?.id === goalId
    ? currentLongTermGoal.value
    : longTermGoalSnapshot.value?.goals.find(item => item.id === goalId) || null
  const title = goal?.title || longTermGoalSidebarItems.value.find(item => item.id === goalId)?.title || goalId
  const ok = window.confirm(t('chatUi.deleteLongTermGoalConfirm', { title }))
  if (!ok) return
  void deleteLongTermGoal(goal || goalId)
}

function openCollapsedSidebarConversation (item: typeof conversationSidebarItems.value[number]): void {
  loadConversation(item.id)
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
      <template v-if="!conversationSidebarCollapsed">
        <ConversationSidebar
          :agent-items="agentSidebarItems"
          :group-items="groupSidebarItems"
          :long-term-goal-items="longTermGoalSidebarItems"
          :conversation-items="conversationSidebarItems"
          :conversation-list-loaded="conversationsLoaded"
          @new-conversation="newConversation"
          @new-long-term-goal="createLongTermGoal"
          @toggle-collapse="toggleConversationSidebar"
          @select-conversation="loadConversation"
          @open-agent="openAgentWorkspaceConversation"
          @open-group="openGroupWorkspaceConversation"
          @open-long-term-goal="openLongTermGoal"
          @delete-long-term-goal="deleteLongTermGoalById"
          @delete-conversation="deleteConversation"
          @rename-conversation="renameConversation"
        />
      </template>

      <div v-else class="conversation-sidebar-rail">
        <button
          class="conversation-sidebar-toggle collapsed"
          type="button"
          :title="$t('chatUi.expandConversationList')"
          :aria-label="$t('chatUi.expandConversationList')"
          @click="toggleConversationSidebar"
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M7.5 5L12.5 10L7.5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          class="conversation-sidebar-rail-action"
          type="button"
          :title="$t('chatUi.newConversation')"
          :aria-label="$t('chatUi.newConversation')"
          @click="newConversation"
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M10 4.5V15.5M4.5 10H15.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
        <div class="conversation-sidebar-rail-sections" :aria-label="$t('chatUi.quickSwitch')">
          <div class="conversation-sidebar-rail-group">
            <button
              class="conversation-sidebar-rail-section"
              :class="{ active: collapsedAgentActive }"
              type="button"
              :title="$t('chatUi.agentSectionHint')"
              :aria-label="$t('chatUi.agentSectionHint')"
              @click="openFirstCollapsedAgent"
            >
              <span class="conversation-sidebar-rail-icon">🤖</span>
              <span class="conversation-sidebar-rail-count">{{ agentSidebarItems.length }}</span>
            </button>
            <div class="conversation-sidebar-popover">
              <div class="conversation-sidebar-popover-head">
                <span>{{ $t('chatUi.agentSectionHint') }}</span>
                <span>{{ agentSidebarItems.length }}</span>
              </div>
              <button
                v-for="item in agentSidebarItems"
                :key="`rail-agent-${item.id}`"
                class="conversation-sidebar-popover-item"
                :class="{ active: item.isActive, streaming: item.isStreaming, waitingAuth: item.pendingAuthCount > 0 }"
                type="button"
                @click="openCollapsedSidebarAgent(item)"
              >
                <span class="conversation-sidebar-popover-icon">{{ item.icon }}</span>
                <span class="conversation-sidebar-popover-copy">
                  <span class="conversation-sidebar-popover-title">{{ item.title }}</span>
                  <span class="conversation-sidebar-popover-subtitle">{{ item.subtitle }}</span>
                </span>
              </button>
              <div v-if="agentSidebarItems.length === 0" class="conversation-sidebar-popover-empty">{{ $t('chatUi.noAgentConversations') }}</div>
            </div>
          </div>

          <div class="conversation-sidebar-rail-group">
            <button
              class="conversation-sidebar-rail-section"
              :class="{ active: collapsedGroupActive }"
              type="button"
              :title="$t('chatUi.groups')"
              :aria-label="$t('chatUi.groups')"
              @click="openFirstCollapsedGroup"
            >
              <span class="conversation-sidebar-rail-icon">👥</span>
              <span class="conversation-sidebar-rail-count">{{ groupSidebarItems.length }}</span>
            </button>
            <div class="conversation-sidebar-popover">
              <div class="conversation-sidebar-popover-head">
                <span>{{ $t('chatUi.groups') }}</span>
                <span>{{ groupSidebarItems.length }}</span>
              </div>
              <button
                v-for="item in groupSidebarItems"
                :key="`rail-group-${item.id}`"
                class="conversation-sidebar-popover-item"
                :class="{ active: item.isActive, streaming: item.isStreaming, waitingAuth: item.pendingAuthCount > 0 }"
                type="button"
                @click="openCollapsedSidebarGroup(item)"
              >
                <span class="conversation-sidebar-popover-icon">{{ item.icon }}</span>
                <span class="conversation-sidebar-popover-copy">
                  <span class="conversation-sidebar-popover-title">{{ item.title }}</span>
                  <span class="conversation-sidebar-popover-subtitle">{{ item.subtitle }}</span>
                </span>
              </button>
              <div v-if="groupSidebarItems.length === 0" class="conversation-sidebar-popover-empty">{{ $t('chatUi.noGroupConversations') }}</div>
            </div>
          </div>

          <div class="conversation-sidebar-rail-group">
            <button
              class="conversation-sidebar-rail-section"
              :class="{ active: collapsedLongTermGoalActive }"
              type="button"
              :title="$t('chatUi.longTermGoals')"
              :aria-label="$t('chatUi.longTermGoals')"
              @click="openFirstCollapsedLongTermGoal"
            >
              <span class="conversation-sidebar-rail-icon">◎</span>
              <span class="conversation-sidebar-rail-count">{{ longTermGoalSidebarItems.length }}</span>
            </button>
            <div class="conversation-sidebar-popover">
              <div class="conversation-sidebar-popover-head">
                <span>{{ $t('chatUi.longTermGoals') }}</span>
                <span>{{ longTermGoalSidebarItems.length }}</span>
              </div>
              <button
                v-for="item in longTermGoalSidebarItems"
                :key="`rail-goal-${item.id}`"
                class="conversation-sidebar-popover-item"
                :class="{ active: item.isActive, streaming: item.isStreaming, waitingAuth: item.pendingAuthCount > 0 }"
                type="button"
                @click="openCollapsedSidebarLongTermGoal(item)"
              >
                <span class="conversation-sidebar-popover-icon">{{ item.icon }}</span>
                <span class="conversation-sidebar-popover-copy">
                  <span class="conversation-sidebar-popover-title">{{ item.title }}</span>
                  <span class="conversation-sidebar-popover-subtitle">{{ item.subtitle }}</span>
                </span>
              </button>
              <button v-if="longTermGoalSidebarItems.length === 0" class="conversation-sidebar-popover-item" type="button" @click="() => createLongTermGoal()">
                <span class="conversation-sidebar-popover-icon">＋</span>
                <span class="conversation-sidebar-popover-copy">
                  <span class="conversation-sidebar-popover-title">{{ $t('chatUi.newLongTermGoal') }}</span>
                  <span class="conversation-sidebar-popover-subtitle">{{ $t('chatUi.longTermGoalSectionHint') }}</span>
                </span>
              </button>
            </div>
          </div>

          <div class="conversation-sidebar-rail-group">
            <button
              class="conversation-sidebar-rail-section"
              :class="{ active: collapsedConversationActive }"
              type="button"
              :title="$t('chatUi.conversations')"
              :aria-label="$t('chatUi.conversations')"
              @click="openFirstCollapsedConversation"
            >
              <span class="conversation-sidebar-rail-icon">💬</span>
              <span class="conversation-sidebar-rail-count">{{ conversationSidebarItems.length }}</span>
            </button>
            <div class="conversation-sidebar-popover">
              <div class="conversation-sidebar-popover-head">
                <span>{{ $t('chatUi.conversations') }}</span>
                <span>{{ conversationSidebarItems.length }}</span>
              </div>
              <button
                v-for="item in conversationSidebarItems"
                :key="`rail-conversation-${item.id}`"
                class="conversation-sidebar-popover-item"
                :class="{ active: item.isActive, streaming: item.isStreaming, waitingAuth: item.pendingAuthCount > 0 }"
                type="button"
                @click="openCollapsedSidebarConversation(item)"
              >
                <span class="conversation-sidebar-popover-icon">{{ item.icon }}</span>
                <span class="conversation-sidebar-popover-copy">
                  <span class="conversation-sidebar-popover-title">{{ item.title }}</span>
                  <span class="conversation-sidebar-popover-subtitle">{{ item.subtitle }}</span>
                </span>
              </button>
              <div v-if="conversationSidebarItems.length === 0" class="conversation-sidebar-popover-empty">{{ $t('chatUi.noRegularConversations') }}</div>
            </div>
          </div>
        </div>
      </div>
    </aside>

    <div
      :class="['chat-panel', { 'chat-panel-with-workspace': documentDockVisible || folderWorkspaceVisible }]"
      :style="{ '--chat-main-protected-min-width': `${MIN_CHAT_MAIN_WIDTH}px` }"
    >
      <div class="chat-main" :style="{ '--chat-header-height': `${chatHeaderHeight}px` }">
        <LongTermGoalPanel
          v-if="currentLongTermGoal"
          :goal="currentLongTermGoal"
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
            :available-skills="availableSkills"
            :active-skill-ids="activeSkillIds"
            :show-skill-picker="showSkillPicker"
            :providers="providers"
            :active-provider-id="activeProviderId"
            :selected-model="selectedModel"
            :show-provider-selector="shouldUseConversationProviderOverride"
            @update:selected-channel-binding-id="handleChannelBindingSelectionChange"
            @update:active-provider-id="handleProviderSelectionChange"
            @update:selected-model="handleModelSelectionChange"
            @toggle-skill-picker="showSkillPicker = !showSkillPicker"
            @select-all-skills="selectAllSkills"
            @clear-skills="clearSkills"
            @toggle-skill="toggleSkill"
          />

          <MessageList
            :key="currentConversationId || 'draft'"
            :messages="messages"
            :is-loading="isLoading"
            :file-preview="filePreview"
            :assistant-icon="currentAssistantIcon"
            :assistant-name="currentAssistantName"
            @respond-auth="respondToAuthRequest"
            @respond-sudo-password="respondToSudoPasswordRequest"
            @open-link="(url) => emit('openWebLink', url)"
          />

          <PinnedTodoPanel
            v-if="activeTodoItems.length > 0"
            :items="activeTodoItems"
            :is-loading="isLoading"
          />

          <AskUserPanel
            v-if="currentAskUserRequest"
            :request="currentAskUserRequest"
            @submit="(requestId, answers) => respondToAskUserRequest(requestId, answers)"
            @cancel="(requestId) => respondToAskUserRequest(requestId, null)"
          />

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

          <ChatInput
            v-model="inputText"
            :is-loading="isLoading"
            :pending-auth-count="currentPendingAuthCount"
            :pending-images="pendingImages"
            :pending-files="pendingFiles"
            :is-uploading-files="isUploadingFiles"
            :upload-feedback="uploadFeedback"
            :document-dock-visible="documentDockVisible"
            :folder-workspace-visible="folderWorkspaceVisible"
            :reasoning-strength="reasoningStrength"
            :temperature="conversationTemperature"
            :provider-default-temperature="providerDefaultTemperature"
            :auth-mode="currentAuthMode"
            :plan-mode-active="planModeActive"
            :available-agents="nonDefaultAgents"
            :selected-agent-id="agentSelectorValue"
            :group-mention-hints="groupMentionHints"
            :is-group-conversation="isGroupConversation"
            :is-new-conversation="!currentConversationId"
            @send="sendMessage"
            @stop="stopCurrentStream"
            @add-attachments="addAttachments"
            @remove-image="removeImage"
            @remove-file="removeFile"
            @update:reasoning-strength="handleReasoningStrengthChange"
            @update:temperature="handleTemperatureChange"
            @toggle-document-dock="toggleDocumentWorkspace"
            @toggle-folder-workspace="toggleFolderWorkspace"
            @update:auth-mode="handleAuthModeChange"
            @toggle-plan-mode="togglePlanMode"
            @update:selected-agent-id="handleAgentSelectionChange"
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
  width: 280px;
  flex: 0 0 280px;
  min-width: 0;
  display: flex;
  transition: width 0.22s ease, flex-basis 0.22s ease;
}

.conversation-sidebar-shell.collapsed {
  width: 64px;
  flex-basis: 64px;
}

.conversation-sidebar-toggle,
.conversation-sidebar-rail-action,
.conversation-sidebar-rail-section {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--app-border) 84%, transparent);
  background: color-mix(in srgb, var(--app-panel) 92%, transparent);
  color: var(--app-text-muted);
  cursor: pointer;
  transition: background 0.18s ease, border-color 0.18s ease, color 0.18s ease, transform 0.18s ease;
}

.conversation-sidebar-toggle:hover,
.conversation-sidebar-rail-action:hover,
.conversation-sidebar-rail-section:hover {
  border-color: color-mix(in srgb, var(--app-accent) 32%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 42%, var(--app-panel));
  color: var(--app-text);
}

.conversation-sidebar-toggle svg,
.conversation-sidebar-rail-action svg {
  width: 18px;
  height: 18px;
}

.conversation-sidebar-rail {
  width: 100%;
  border-right: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel) 92%, transparent);
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  overflow: visible;
}

.conversation-sidebar-rail-action {
  color: #ffffff;
  border-color: transparent;
  background: var(--app-accent);
}

.conversation-sidebar-rail-action:hover {
  color: #ffffff;
  background: var(--app-accent-strong);
}

.conversation-sidebar-rail-sections {
  width: 100%;
  margin-top: 6px;
  padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 72%, transparent);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.conversation-sidebar-rail-group {
  position: relative;
  width: 100%;
  display: flex;
  justify-content: center;
}

.conversation-sidebar-rail-group::after {
  content: '';
  position: absolute;
  left: 100%;
  top: -12px;
  bottom: -12px;
  width: 22px;
}

.conversation-sidebar-rail-section {
  position: relative;
  background: transparent;
}

.conversation-sidebar-rail-section.active {
  border-color: color-mix(in srgb, var(--app-accent) 42%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 58%, transparent);
  color: var(--app-text-strong);
}

.conversation-sidebar-rail-icon {
  width: 1.2em;
  min-width: 0;
  overflow: hidden;
  text-align: center;
  line-height: 1;
}

.conversation-sidebar-rail-count {
  position: absolute;
  right: -3px;
  top: -5px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--app-panel-strong);
  border: 1px solid var(--app-border);
  color: var(--app-text-muted);
  font-size: 0.6rem;
  font-weight: 800;
  line-height: 14px;
  box-sizing: border-box;
}

.conversation-sidebar-popover {
  position: absolute;
  left: calc(100% + 10px);
  top: -8px;
  z-index: 30;
  width: 288px;
  max-height: min(460px, calc(100vh - 90px));
  padding: 10px;
  border-radius: 16px;
  border: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel) 94%, transparent);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.14);
  -webkit-backdrop-filter: blur(14px) saturate(120%);
  backdrop-filter: blur(14px) saturate(120%);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateX(-4px);
  transition: opacity 0.16s ease, visibility 0.16s ease, transform 0.16s ease;
  overflow-y: auto;
}

.conversation-sidebar-rail-group:hover .conversation-sidebar-popover,
.conversation-sidebar-rail-group:focus-within .conversation-sidebar-popover {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: translateX(0);
}

.conversation-sidebar-popover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 4px 8px;
  color: var(--app-text-muted);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.conversation-sidebar-popover-item {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--app-text);
  cursor: pointer;
  text-align: left;
}

.conversation-sidebar-popover-item:hover {
  background: color-mix(in srgb, var(--app-panel-muted) 62%, transparent);
}

.conversation-sidebar-popover-item.active {
  background: color-mix(in srgb, var(--app-accent-soft) 52%, transparent);
}

.conversation-sidebar-popover-icon {
  width: 30px;
  height: 30px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--app-border) 76%, transparent);
  background: color-mix(in srgb, var(--app-panel-muted) 66%, transparent);
}

.conversation-sidebar-popover-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.conversation-sidebar-popover-title,
.conversation-sidebar-popover-subtitle {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-sidebar-popover-title {
  color: var(--app-text-strong);
  font-size: 0.82rem;
  font-weight: 700;
}

.conversation-sidebar-popover-subtitle {
  color: var(--app-text-muted);
  font-size: 0.72rem;
}

.conversation-sidebar-popover-empty {
  padding: 12px 8px;
  color: var(--app-text-faint);
  font-size: 0.76rem;
  text-align: center;
}

.chat-panel {
  --chat-message-gutter: clamp(32px, 7vw, 128px);
  --chat-message-track-max: 980px;
  --chat-user-message-max: 680px;
  --chat-user-bubble-max: 540px;
  --chat-event-card-max: 100%;
  --chat-input-overlap: clamp(44px, 7vh, 72px);
  display: flex;
  flex-direction: row;
  flex: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
  overflow: hidden;
}

.chat-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  position: relative;
}

.chat-panel-with-workspace .chat-main {
  min-width: var(--chat-main-protected-min-width, 640px);
  flex-shrink: 0;
}
</style>
