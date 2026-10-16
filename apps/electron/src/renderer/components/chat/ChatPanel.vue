<script setup lang="ts">
import ChatPanelContainer from './panel/ChatPanelContainer.vue'
import type { ChatPanelEmit, ChatPanelProps } from './panel/types'

const props = defineProps<ChatPanelProps>()
const emit = defineEmits<ChatPanelEmit>()
</script>

<template>
  <ChatPanelContainer
    :project-context="props.projectContext"
    :active-page-context="props.activePageContext"
    :active-terminal-context="props.activeTerminalContext"
    :workspace-tab-request="props.workspaceTabRequest"
    :workspace-tab-control-request="props.workspaceTabControlRequest"
    @context-consumed="emit('contextConsumed')"
    @current-conversation-change="conversationId => emit('currentConversationChange', conversationId)"
    @workspace-tab-request-consumed="emit('workspaceTabRequestConsumed')"
    @workspace-tab-control-result="response => emit('workspaceTabControlResult', response)"
    @page-surface-change="surface => emit('pageSurfaceChange', surface)"
    @terminal-surface-change="surface => emit('terminalSurfaceChange', surface)"
    @open-web-link="(url) => emit('openWebLink', url)"
    @status-change="(status) => emit('statusChange', status)"
    @open-settings="(category, options) => emit('openSettings', category, options)"
  />
</template>
