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
    @context-consumed="emit('contextConsumed')"
    @open-web-link="(url) => emit('openWebLink', url)"
    @status-change="(status) => emit('statusChange', status)"
    @open-settings="(category, options) => emit('openSettings', category, options)"
  />
</template>