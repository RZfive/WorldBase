<script setup lang="ts">
const props = defineProps<{
  visible: boolean
  message: string
}>()

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()
</script>

<template>
  <Teleport to="body">
    <div v-if="props.visible" class="confirm-overlay" @click.self="emit('cancel')">
      <div class="confirm-box">
        <p>{{ props.message }}</p>
        <div class="confirm-actions">
          <button class="confirm-btn danger" @click="emit('confirm')">确认删除</button>
          <button class="confirm-btn" @click="emit('cancel')">取消</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(15, 23, 42, 0.34);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10001;
  backdrop-filter: blur(10px);
}

.confirm-box {
  background: var(--app-panel-strong);
  border: 1px solid var(--app-border-strong);
  border-radius: 16px;
  padding: 28px;
  width: 380px;
  box-shadow: var(--app-shadow);
}

.confirm-box p {
  margin: 0 0 20px;
  font-size: 0.92em;
  color: var(--app-text);
  line-height: 1.5;
}

.confirm-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.confirm-btn {
  padding: 8px 18px;
  background: var(--app-panel-muted);
  border: 1px solid var(--app-border);
  border-radius: 10px;
  color: var(--app-text);
  font-size: 0.85em;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}

.confirm-btn:hover {
  background: var(--app-accent-soft);
  border-color: var(--app-accent-glow);
  color: var(--app-text-strong);
}

.confirm-btn.danger {
  background: var(--app-danger);
  border-color: var(--app-danger);
  color: #fff;
}

.confirm-btn.danger:hover {
  filter: brightness(0.92);
}
</style>
