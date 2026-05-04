<script setup lang="ts">
import { computed, watch } from 'vue'
import ConversationSidebar from '../layout/ConversationSidebar.vue'
import MessageList from '../messages/MessageList.vue'
import ChatInput from '../layout/ChatInput.vue'
import ChatHeader from '../layout/ChatHeader.vue'
import DocumentDock from '../layout/DocumentDock.vue'
import PinnedTodoPanel from '../layout/PinnedTodoPanel.vue'
import { useChatPanel } from './useChatPanel'
import type { ChatPanelEmit, ChatPanelProps } from './types'

const props = defineProps<ChatPanelProps>()
const emit = defineEmits<ChatPanelEmit>()

const {
  activeProviderId,
  activeSkillIds,
  activeTodoItems,
  agentSelectorValue,
  agentSidebarItems,
  availableChannelBindings,
  availableSkills,
  conversationSidebarItems,
  currentAuthMode,
  currentContextDetail,
  currentContextLabel,
  currentConversationId,
  currentPendingAuthCount,
  deleteConversation,
  documentDockVisible,
  filePreview,
  groupMentionHints,
  groupSidebarItems,
  handleAgentSelectionChange,
  handleAuthModeChange,
  handleChannelBindingSelectionChange,
  handleModelSelectionChange,
  handleProviderSelectionChange,
  handleReasoningStrengthChange,
  inputText,
  insertDocumentTag,
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
  reasoningStrength,
  removeFile,
  removeImage,
  respondToAuthRequest,
  respondToSudoPasswordRequest,
  selectedChannelBindingId,
  selectedModel,
  sendMessage,
  shouldUseConversationProviderOverride,
  showSkillPicker,
  stopCurrentStream,
  togglePlanMode,
  toggleSkill,
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

watch(
  chatSurfaceStatus,
  (status) => {
    emit('statusChange', status)
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
      @new-conversation="newConversation"
      @select-conversation="loadConversation"
      @open-agent="openAgentWorkspaceConversation"
      @open-group="openGroupWorkspaceConversation"
      @delete-conversation="deleteConversation"
    />

    <div class="chat-panel">
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

      <DocumentDock
        :visible="documentDockVisible"
        @close="documentDockVisible = false"
        @selections-changed="() => {}"
        @insert-selection-tag="insertDocumentTag"
      />

      <ChatInput
        v-model="inputText"
        :is-loading="isLoading"
        :pending-auth-count="currentPendingAuthCount"
        :pending-images="pendingImages"
        :pending-files="pendingFiles"
        :is-uploading-files="isUploadingFiles"
        :upload-feedback="uploadFeedback"
        :available-skills="availableSkills"
        :active-skill-ids="activeSkillIds"
        :document-dock-visible="documentDockVisible"
        :reasoning-strength="reasoningStrength"
        :auth-mode="currentAuthMode"
        :plan-mode-active="planModeActive"
        :providers="providers"
        :active-provider-id="activeProviderId"
        :selected-model="selectedModel"
        :show-provider-selector="shouldUseConversationProviderOverride"
        :available-agents="nonDefaultAgents"
        :selected-agent-id="agentSelectorValue"
        :group-mention-hints="groupMentionHints"
        :is-new-conversation="!currentConversationId"
        @send="sendMessage"
        @stop="stopCurrentStream"
        @add-attachments="addAttachments"
        @remove-image="removeImage"
        @remove-file="removeFile"
        @update:reasoning-strength="handleReasoningStrengthChange"
        @toggle-skill="toggleSkill"
        @toggle-document-dock="documentDockVisible = !documentDockVisible"
        @update:auth-mode="handleAuthModeChange"
        @toggle-plan-mode="togglePlanMode"
        @update:active-provider-id="handleProviderSelectionChange"
        @update:selected-model="handleModelSelectionChange"
        @update:selected-agent-id="handleAgentSelectionChange"
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
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
}
</style>