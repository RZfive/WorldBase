<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ConversationSidebar from '../layout/ConversationSidebar.vue'
import MessageList from '../messages/MessageList.vue'
import ChatInput from '../layout/ChatInput.vue'
import ChatHeader from '../layout/ChatHeader.vue'
import DocumentWorkspace from '../layout/DocumentWorkspace.vue'
import PinnedTodoPanel from '../layout/PinnedTodoPanel.vue'
import { useChatPanel } from './useChatPanel'
import type { ChatPanelEmit, ChatPanelProps } from './types'

const props = defineProps<ChatPanelProps>()
const emit = defineEmits<ChatPanelEmit>()

const DEFAULT_APP_WINDOW_MIN_WIDTH = 800
const CONVERSATION_SIDEBAR_WIDTH = 252
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
  currentAuthMode,
  currentContextDetail,
  currentContextLabel,
  currentConversationId,
  currentPendingAuthCount,
  deleteConversation,
  documentDockVisible,
  documentWorkspaceActiveFilePath,
  documentWorkspaceDocuments,
  documentWorkspaceWidth,
  filePreview,
  groupMentionHints,
  groupSidebarItems,
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
  messages,
  newConversation,
  nonDefaultAgents,
  openAgentWorkspaceConversation,
  openGroupWorkspaceConversation,
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
  respondToAuthRequest,
  respondToSudoPasswordRequest,
  selectedChannelBindingId,
  selectedModel,
  selectAllSkills,
  sendMessage,
  shouldUseConversationProviderOverride,
  showSkillPicker,
  stopCurrentStream,
  togglePlanMode,
  toggleSkill,
  clearSkills,
  updateDocumentWorkspaceState,
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
const chatWindowWidthBeforeWorkspace = ref<number | null>(null)

function getPreferredWorkspaceWidth (): number {
  return Math.max(
    MIN_DOCUMENT_WORKSPACE_WIDTH,
    Math.min(MAX_DOCUMENT_WORKSPACE_WIDTH, Math.round(documentWorkspaceWidth.value || MIN_DOCUMENT_WORKSPACE_WIDTH))
  )
}

function getRequiredWindowWidthForWorkspace (): number {
  return CONVERSATION_SIDEBAR_WIDTH + MIN_CHAT_MAIN_WIDTH + getPreferredWorkspaceWidth()
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

async function ensureWindowFitsDocumentWorkspace (options?: { animate?: boolean }): Promise<void> {
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

async function openDocumentWorkspace (): Promise<void> {
  if (documentDockVisible.value || isOpeningDocumentWorkspace.value || isClosingDocumentWorkspace.value) return

  isOpeningDocumentWorkspace.value = true

  try {
    chatWindowWidthBeforeWorkspace.value = await getCurrentWindowWidth()
    await ensureWindowFitsDocumentWorkspace({ animate: true })
    await setWindowMinimumWidth(getRequiredWindowWidthForWorkspace())
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

watch(
  chatSurfaceStatus,
  (status) => {
    emit('statusChange', status)
  },
  { immediate: true }
)

watch(
  [documentDockVisible, documentWorkspaceWidth],
  ([visible], previousState) => {
    const previousVisible = previousState?.[0] ?? false
    void setWindowMinimumWidth(visible ? getRequiredWindowWidthForWorkspace() : DEFAULT_APP_WINDOW_MIN_WIDTH)
    if (visible && !previousVisible && !isOpeningDocumentWorkspace.value) {
      void ensureWindowFitsDocumentWorkspace()
    }
  },
  { immediate: true }
)
</script>

<template>
  <div class="chat-layout">
    <ConversationSidebar
      :agent-items="agentSidebarItems"
      :group-items="groupSidebarItems"
      :conversation-items="conversationSidebarItems"
      :conversation-list-loaded="conversationsLoaded"
      @new-conversation="newConversation"
      @select-conversation="loadConversation"
      @open-agent="openAgentWorkspaceConversation"
      @open-group="openGroupWorkspaceConversation"
      @delete-conversation="deleteConversation"
      @rename-conversation="renameConversation"
    />

    <div
      :class="['chat-panel', { 'chat-panel-with-workspace': documentDockVisible }]"
      :style="{ '--chat-main-protected-min-width': `${MIN_CHAT_MAIN_WIDTH}px` }"
    >
      <div class="chat-main">
        <ChatHeader
          :context-label="currentContextLabel"
          :context-detail="currentContextDetail"
          :available-channel-bindings="availableChannelBindings"
          :selected-channel-binding-id="selectedChannelBindingId"
          :available-skills="availableSkills"
          :active-skill-ids="activeSkillIds"
          :show-skill-picker="showSkillPicker"
          @update:selected-channel-binding-id="handleChannelBindingSelectionChange"
          @toggle-skill-picker="showSkillPicker = !showSkillPicker"
          @select-all-skills="selectAllSkills"
          @clear-skills="clearSkills"
          @toggle-skill="toggleSkill"
        />

        <PinnedTodoPanel
          v-if="activeTodoItems.length > 0"
          :items="activeTodoItems"
          :is-loading="isLoading"
        />

        <MessageList
          :key="currentConversationId || 'draft'"
          :messages="messages"
          :is-loading="isLoading"
          :file-preview="filePreview"
          @respond-auth="respondToAuthRequest"
          @respond-sudo-password="respondToSudoPasswordRequest"
          @open-link="(url) => emit('openWebLink', url)"
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
          :reasoning-strength="reasoningStrength"
          :temperature="conversationTemperature"
          :provider-default-temperature="providerDefaultTemperature"
          :auth-mode="currentAuthMode"
          :plan-mode-active="planModeActive"
          :providers="providers"
          :active-provider-id="activeProviderId"
          :selected-model="selectedModel"
          :show-provider-selector="shouldUseConversationProviderOverride"
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
          @update:auth-mode="handleAuthModeChange"
          @toggle-plan-mode="togglePlanMode"
          @update:active-provider-id="handleProviderSelectionChange"
          @update:selected-model="handleModelSelectionChange"
          @update:selected-agent-id="handleAgentSelectionChange"
        />
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
    </div>
  </div>
</template>

<style scoped>
.chat-layout {
  display: flex;
  height: 100%;
}

.chat-panel {
  --chat-message-gutter: clamp(18px, 2.4vw, 40px);
  --chat-message-track-max: 1480px;
  --chat-message-column-max: 1120px;
  --chat-event-card-max: 1080px;
  --chat-bubble-max: 1120px;
  --chat-avatar-size: 40px;
  --chat-avatar-gap: 14px;
  --chat-avatar-footprint: calc(var(--chat-avatar-size) + var(--chat-avatar-gap));
  --chat-dual-avatar-footprint: calc(var(--chat-avatar-footprint) * 2);
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
}

.chat-panel-with-workspace .chat-main {
  min-width: var(--chat-main-protected-min-width, 640px);
  flex-shrink: 0;
}
</style>
