<script setup lang="ts">
const props = withDefaults(defineProps<{
  title?: string
  icon?: string
  subtitle?: string
  isMaximized?: boolean
}>(), {
  title: 'The World',
  icon: '🌍',
  subtitle: '',
  isMaximized: false
})

const emit = defineEmits<{
  (e: 'minimize'): void
  (e: 'maximize'): void
  (e: 'close'): void
}>()
</script>

<template>
  <div class="titlebar">
    <div class="titlebar-controls">
      <button class="titlebar-traffic close" @click="emit('close')" title="关闭">
        <span class="titlebar-traffic-glyph">×</span>
      </button>
      <button class="titlebar-traffic minimize" @click="emit('minimize')" title="最小化">
        <span class="titlebar-traffic-glyph">−</span>
      </button>
      <button class="titlebar-traffic maximize" @click="emit('maximize')" :title="props.isMaximized ? '还原' : '最大化'">
        <span class="titlebar-traffic-glyph">{{ props.isMaximized ? '▣' : '+' }}</span>
      </button>
    </div>

    <div class="titlebar-drag">
      <div class="titlebar-brand">
        <span class="titlebar-icon">{{ props.icon }}</span>
        <div class="titlebar-copy">
          <span class="titlebar-title">{{ props.title }}</span>
          <span v-if="props.subtitle" class="titlebar-subtitle">{{ props.subtitle }}</span>
        </div>
      </div>
    </div>

    <div class="titlebar-balance"></div>
  </div>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 46px;
  padding: 0 14px;
  box-sizing: border-box;
  background:
    linear-gradient(180deg, rgba(10, 16, 24, 0.98), rgba(8, 12, 18, 0.92));
  border-bottom: 1px solid rgba(148, 163, 184, 0.1);
  flex-shrink: 0;
  user-select: none;
  gap: 12px;
}

.titlebar-drag {
  flex: 1;
  -webkit-app-region: drag;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.titlebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.titlebar-icon {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
  font-size: 1em;
}

.titlebar-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.titlebar-title {
  font-size: 0.83em;
  color: #f8fafc;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.titlebar-subtitle {
  font-size: 0.68em;
  color: #7dd3fc;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.titlebar-controls {
  display: flex;
  gap: 8px;
  align-items: center;
  -webkit-app-region: no-drag;
}

.titlebar-balance {
  width: 74px;
  flex-shrink: 0;
}

.titlebar-traffic {
  width: 13px;
  height: 13px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  position: relative;
}

.titlebar-traffic.close { background: #ff5f57; }
.titlebar-traffic.minimize { background: #febc2e; }
.titlebar-traffic.maximize { background: #28c840; }

.titlebar-traffic-glyph {
  opacity: 0;
  font-size: 0.6em;
  line-height: 1;
  color: rgba(15, 23, 42, 0.78);
  transform: translateY(-0.5px);
  transition: opacity 0.12s ease;
}

.titlebar-controls:hover .titlebar-traffic-glyph {
  opacity: 1;
}
</style>
