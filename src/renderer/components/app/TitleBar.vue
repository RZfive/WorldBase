<script setup lang="ts">
const emit = defineEmits<{
  (e: 'minimize'): void
  (e: 'maximize'): void
  (e: 'close'): void
}>()
</script>

<template>
  <div class="titlebar">
    <div class="titlebar-drag">
      <span class="titlebar-title">🌍 The World</span>
    </div>
    <div class="titlebar-controls">
      <button class="titlebar-btn minimize" @click="emit('minimize')" title="最小化">
        <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="1" fill="currentColor"/></svg>
      </button>
      <button class="titlebar-btn maximize" @click="emit('maximize')" title="最大化">
        <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1"/></svg>
      </button>
      <button class="titlebar-btn close" @click="emit('close')" title="关闭">
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 38px;
  background: rgba(15, 18, 24, 0.92);
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
  flex-shrink: 0;
  user-select: none;
}

.titlebar-drag {
  flex: 1;
  -webkit-app-region: drag;
  height: 100%;
  display: flex;
  align-items: center;
  padding-left: 16px;
}

.titlebar-title {
  font-size: 0.82em;
  color: #7dd3fc;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.titlebar-controls {
  display: flex;
  height: 100%;
  -webkit-app-region: no-drag;
}

.titlebar-btn {
  width: 46px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  transition: all 0.12s;
}

.titlebar-btn:hover { background: rgba(30, 41, 59, 0.65); color: #e2e8f0; }
.titlebar-btn.close:hover { background: #dc2626; color: #fff; }
</style>
