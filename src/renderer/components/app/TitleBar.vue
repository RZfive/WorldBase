<script setup lang="ts">
import { computed } from 'vue'

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

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    platform?: string
  }
}

const isWindows = computed(() => {
  if (typeof navigator === 'undefined') return false
  const platform = (navigator as NavigatorWithUserAgentData).userAgentData?.platform || navigator.platform || navigator.userAgent
  return /win/i.test(platform)
})
</script>

<template>
  <div class="titlebar" :class="{ windows: isWindows }">
    <div v-if="!isWindows" class="titlebar-controls traffic-controls">
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

    <div v-if="!isWindows" class="titlebar-balance"></div>

    <div v-else class="titlebar-controls windows-controls">
      <button class="titlebar-win-button" @click="emit('minimize')" title="最小化" aria-label="最小化">
        <span class="titlebar-win-glyph minimize"></span>
      </button>
      <button class="titlebar-win-button" @click="emit('maximize')" :title="props.isMaximized ? '还原' : '最大化'" :aria-label="props.isMaximized ? '还原' : '最大化'">
        <span class="titlebar-win-glyph" :class="props.isMaximized ? 'restore' : 'maximize'"></span>
      </button>
      <button class="titlebar-win-button close" @click="emit('close')" title="关闭" aria-label="关闭">
        <span class="titlebar-win-close">×</span>
      </button>
    </div>
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
  background: linear-gradient(180deg, var(--app-panel-strong), var(--app-panel));
  border-bottom: 1px solid var(--app-border);
  flex-shrink: 0;
  user-select: none;
  gap: 12px;
}

.titlebar.windows {
  height: 40px;
  padding: 0 0 0 12px;
  gap: 0;
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
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
  background: var(--app-panel-muted);
  box-shadow: inset 0 1px 0 var(--app-border);
  font-size: 1em;
}

.titlebar-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.titlebar-title {
  font-size: 0.83em;
  color: var(--app-text-strong);
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.titlebar-subtitle {
  font-size: 0.68em;
  color: var(--app-accent);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.titlebar-controls {
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
}

.traffic-controls {
  gap: 8px;
}

.windows-controls {
  align-self: stretch;
  margin-left: 12px;
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

.titlebar-win-button {
  width: 46px;
  height: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--app-text-strong);
  cursor: pointer;
  transition: background 0.14s ease;
}

.titlebar-win-button:hover {
  background: rgba(127, 127, 127, 0.16);
}

.titlebar-win-button.close:hover {
  background: #e81123;
  color: #ffffff;
}

.titlebar-win-glyph {
  position: relative;
  width: 10px;
  height: 10px;
  display: inline-block;
}

.titlebar-win-glyph.minimize::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 1px;
  border-top: 1.5px solid currentColor;
}

.titlebar-win-glyph.maximize::before {
  content: '';
  position: absolute;
  inset: 0;
  border: 1.5px solid currentColor;
}

.titlebar-win-glyph.restore::before,
.titlebar-win-glyph.restore::after {
  content: '';
  position: absolute;
  width: 8px;
  height: 8px;
  border: 1.5px solid currentColor;
  background: transparent;
}

.titlebar-win-glyph.restore::before {
  top: 0;
  right: 0;
}

.titlebar-win-glyph.restore::after {
  left: 0;
  bottom: 0;
  background: var(--app-panel);
}

.titlebar-win-close {
  font-size: 0.95rem;
  line-height: 1;
}
</style>
