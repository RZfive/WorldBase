<script setup lang="ts">
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'error' }>
}>()
</script>

<template>
  <div class="message-event-card error-event-card" role="alert">
    <div class="error-title">执行出错</div>
    <div class="error-message">{{ props.block.message }}</div>
  </div>
</template>

<style scoped>
.message-event-card {
  width: min(100%, var(--chat-event-card-max, 1080px));
  border-radius: 18px;
  overflow: hidden;
}

.error-event-card {
  padding: 14px 16px;
  border: 1px solid rgba(239, 68, 68, 0.28);
  background: linear-gradient(180deg, rgba(254, 242, 242, 0.96), rgba(254, 226, 226, 0.92));
  box-shadow: 0 12px 30px rgba(127, 29, 29, 0.08);
}

.error-title {
  font-size: 0.84rem;
  font-weight: 700;
  color: #b91c1c;
}

.error-message {
  margin-top: 6px;
  font-size: 0.78rem;
  line-height: 1.55;
  color: #7f1d1d;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
