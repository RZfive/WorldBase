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
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10001;
}

.confirm-box {
  background: #1e1e22;
  border: 1px solid #3f3f46;
  border-radius: 16px;
  padding: 28px;
  width: 380px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

.confirm-box p {
  margin: 0 0 20px;
  font-size: 0.92em;
  color: #e4e4e7;
  line-height: 1.5;
}

.confirm-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.confirm-btn {
  padding: 8px 18px;
  background: #27272a;
  border: 1px solid #3f3f46;
  border-radius: 10px;
  color: #e4e4e7;
  font-size: 0.85em;
  cursor: pointer;
  transition: all 0.12s;
}

.confirm-btn:hover { background: #3f3f46; }
.confirm-btn.danger { background: #dc2626; border-color: #dc2626; color: #fff; }
.confirm-btn.danger:hover { background: #b91c1c; }
</style>
