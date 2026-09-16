<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ConversationSidebar from '../layout/ConversationSidebar.vue'
import SidebarIcon from '../layout/SidebarIcon.vue'
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
const sidebarTotalCount = computed(() => (
  agentSidebarItems.value.length +
  groupSidebarItems.value.length +
  longTermGoalSidebarItems.value.length +
  conversationSidebarItems.value.length
))

// The collapsed capsule shows which list owns the active conversation
// (design v1.7: the capsule is a context marker, not a quick-switch rail —
// expanding the list is the switching surface).
const collapsedCapsuleIcon = computed(() => {
  if (agentSidebarItems.value.some(item => item.isActive)) return 'robot'
  if (groupSidebarItems.value.some(item => item.isActive)) return 'people'
  if (longTermGoalSidebarItems.value.some(item => item.isActive)) return 'target'
  return 'bubble'
})

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

      <div
        v-else
        class="conversation-sidebar-capsule"
        role="button"
        :tabindex="0"
        :aria-label="$t('chatUi.expandConversationList')"
        @click="toggleConversationSidebar"
        @keydown.enter.prevent="toggleConversationSidebar"
        @keydown.space.prevent="toggleConversationSidebar"
      >
        <span class="conversation-capsule-btn" aria-hidden="true">
          <SidebarIcon name="panel" :size="14" />
        </span>
        <span class="conversation-capsule-av" aria-hidden="true">
          <SidebarIcon :name="collapsedCapsuleIcon" :size="12" />
        </span>
        <span class="conversation-capsule-n" aria-hidden="true">{{ sidebarTotalCount }}</span>
        <span class="conversation-capsule-tip" aria-hidden="true">{{ $t('chatUi.expandConversationList') }} · ⌘\</span>
      </div>
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
          />

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
   click restores the list. */
.conversation-sidebar-capsule {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 22;
  width: 36px;
  padding: 8px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  border-radius: 999px;
  border: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-chat-list-raised) 58%, transparent);
  box-shadow: var(--shadow-2);
  color: var(--app-text-muted);
  cursor: pointer;
  user-select: none;
  transition: border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
  animation: conversation-capsule-in 0.22s var(--ease-out);
}

@keyframes conversation-capsule-in {
  from {
    opacity: 0;
    transform: translateY(-50%) translateX(-6px);
  }
}

.conversation-sidebar-capsule:hover,
.conversation-sidebar-capsule:focus-visible {
  border: 1.5px solid var(--app-accent);
  background: color-mix(in srgb, var(--app-chat-list-raised) 90%, transparent);
  box-shadow: var(--shadow-3), 0 0 0 3px var(--app-accent-soft);
  color: var(--app-accent-strong);
  outline: none;
}

.conversation-capsule-btn {
  width: 26px;
  height: 26px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--app-text-soft);
}

.conversation-sidebar-capsule:hover .conversation-capsule-btn,
.conversation-sidebar-capsule:focus-visible .conversation-capsule-btn {
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

.conversation-capsule-n {
  font-size: 0.56rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-text-faint);
}

.conversation-capsule-tip {
  position: absolute;
  left: calc(100% + 9px);
  top: 50%;
  z-index: 23;
  white-space: nowrap;
  font-size: 0.68rem;
  color: var(--app-text-strong);
  background: color-mix(in srgb, var(--app-panel-strong) 96%, transparent);
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 4px 9px;
  box-shadow: var(--shadow-2);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateY(-50%) translateX(-4px);
  transition: opacity 0.16s ease, transform 0.16s var(--ease-out), visibility 0.16s ease;
}

.conversation-sidebar-capsule:hover .conversation-capsule-tip,
.conversation-sidebar-capsule:focus-visible .conversation-capsule-tip {
  opacity: 1;
  visibility: visible;
  transform: translateY(-50%) translateX(0);
}

@media (prefers-reduced-motion: reduce) {
  .conversation-sidebar-capsule {
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
