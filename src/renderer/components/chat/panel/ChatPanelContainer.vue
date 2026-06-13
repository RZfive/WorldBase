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
const CONVERSATION_SIDEBAR_COLLAPSE_STORAGE_KEY = 'chat-conversation-sidebar-collapsed'

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

function openCollapsedSidebarConversation (item: typeof conversationSidebarItems.value[number]): void {
  loadConversation(item.id)
}

function getPreferredWorkspaceWidth (): number {
  return Math.max(
    MIN_DOCUMENT_WORKSPACE_WIDTH,
    Math.min(MAX_DOCUMENT_WORKSPACE_WIDTH, Math.round(documentWorkspaceWidth.value || MIN_DOCUMENT_WORKSPACE_WIDTH))
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
  [documentDockVisible, documentWorkspaceWidth, conversationSidebarCollapsed],
  ([visible], previousState) => {
    const previousVisible = previousState?.[0] ?? false
    void setWindowMinimumWidth(visible ? getRequiredWindowWidthForWorkspace() : DEFAULT_APP_WINDOW_MIN_WIDTH)
    if (visible && !previousVisible && !isOpeningDocumentWorkspace.value) {
      void ensureWindowFitsDocumentWorkspace()
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
      :aria-label="conversationSidebarCollapsed ? '对话列表已收起' : '对话列表'"
    >
      <template v-if="!conversationSidebarCollapsed">
        <ConversationSidebar
          :agent-items="agentSidebarItems"
          :group-items="groupSidebarItems"
          :conversation-items="conversationSidebarItems"
          :conversation-list-loaded="conversationsLoaded"
          @new-conversation="newConversation"
          @toggle-collapse="toggleConversationSidebar"
          @select-conversation="loadConversation"
          @open-agent="openAgentWorkspaceConversation"
          @open-group="openGroupWorkspaceConversation"
          @delete-conversation="deleteConversation"
          @rename-conversation="renameConversation"
        />
      </template>

      <div v-else class="conversation-sidebar-rail">
        <button
          class="conversation-sidebar-toggle collapsed"
          type="button"
          title="展开对话列表"
          aria-label="展开对话列表"
          @click="toggleConversationSidebar"
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M7.5 5L12.5 10L7.5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          class="conversation-sidebar-rail-action"
          type="button"
          title="新对话"
          aria-label="新对话"
          @click="newConversation"
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M10 4.5V15.5M4.5 10H15.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
        <div class="conversation-sidebar-rail-sections" aria-label="快速切换">
          <div class="conversation-sidebar-rail-group">
            <button
              class="conversation-sidebar-rail-section"
              :class="{ active: collapsedAgentActive }"
              type="button"
              title="Agent"
              aria-label="Agent"
              @click="openFirstCollapsedAgent"
            >
              <span class="conversation-sidebar-rail-icon">🤖</span>
              <span class="conversation-sidebar-rail-count">{{ agentSidebarItems.length }}</span>
            </button>
            <div class="conversation-sidebar-popover">
              <div class="conversation-sidebar-popover-head">
                <span>Agent</span>
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
              <div v-if="agentSidebarItems.length === 0" class="conversation-sidebar-popover-empty">暂无 Agent 会话</div>
            </div>
          </div>

          <div class="conversation-sidebar-rail-group">
            <button
              class="conversation-sidebar-rail-section"
              :class="{ active: collapsedGroupActive }"
              type="button"
              title="群组"
              aria-label="群组"
              @click="openFirstCollapsedGroup"
            >
              <span class="conversation-sidebar-rail-icon">👥</span>
              <span class="conversation-sidebar-rail-count">{{ groupSidebarItems.length }}</span>
            </button>
            <div class="conversation-sidebar-popover">
              <div class="conversation-sidebar-popover-head">
                <span>群组</span>
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
              <div v-if="groupSidebarItems.length === 0" class="conversation-sidebar-popover-empty">暂无群组会话</div>
            </div>
          </div>

          <div class="conversation-sidebar-rail-group">
            <button
              class="conversation-sidebar-rail-section"
              :class="{ active: collapsedConversationActive }"
              type="button"
              title="对话"
              aria-label="对话"
              @click="openFirstCollapsedConversation"
            >
              <span class="conversation-sidebar-rail-icon">💬</span>
              <span class="conversation-sidebar-rail-count">{{ conversationSidebarItems.length }}</span>
            </button>
            <div class="conversation-sidebar-popover">
              <div class="conversation-sidebar-popover-head">
                <span>对话</span>
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
              <div v-if="conversationSidebarItems.length === 0" class="conversation-sidebar-popover-empty">暂无普通对话</div>
            </div>
          </div>
        </div>
      </div>
    </aside>

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
}

.chat-panel-with-workspace .chat-main {
  min-width: var(--chat-main-protected-min-width, 640px);
  flex-shrink: 0;
}
</style>
