<script setup lang="ts">
import { computed } from 'vue'

interface SkillItem {
  id: string
  name: string
}

interface ChannelBindingOption {
  id: string
  connectorType: string
  externalChannelId: string
}

const props = defineProps<{
  contextLabel: string
  contextDetail: string
  availableChannelBindings: ChannelBindingOption[]
  selectedChannelBindingId: string
  availableSkills: SkillItem[]
  activeSkillIds: Set<string>
  showSkillPicker: boolean
}>()

const emit = defineEmits<{
  (e: 'update:selected-channel-binding-id', channelBindingId: string): void
  (e: 'toggleSkillPicker'): void
  (e: 'selectAllSkills'): void
  (e: 'clearSkills'): void
  (e: 'toggleSkill', skillId: string): void
}>()

function onChannelBindingChange (event: Event) {
  emit('update:selected-channel-binding-id', (event.target as HTMLSelectElement).value)
}

const allSkillsSelected = computed(() => {
  return props.availableSkills.length > 0 && props.activeSkillIds.size === props.availableSkills.length
})
</script>

<template>
  <div class="chat-header">
    <div class="chat-header-copy">
      <h2>{{ contextLabel }}</h2>
      <p>{{ contextDetail }}</p>
    </div>
    <div class="header-controls">
      <div v-if="availableChannelBindings.length > 0" class="channel-binding-selector">
        <select :value="selectedChannelBindingId" class="select-input" @change="onChannelBindingChange">
          <option value="">无 IM 绑定</option>
          <option v-for="binding in availableChannelBindings" :key="binding.id" :value="binding.id">
            {{ binding.connectorType }} · {{ binding.externalChannelId }}
          </option>
        </select>
      </div>

      <div v-if="availableSkills.length > 0" class="skill-selector">
        <button
          class="skill-toggle-btn"
          :class="{ 'has-active': activeSkillIds.size > 0 }"
          @click="emit('toggleSkillPicker')"
        >
          🧠 Skills{{ activeSkillIds.size > 0 ? ` (${activeSkillIds.size})` : '' }}
        </button>
        <div v-if="showSkillPicker" class="skill-dropdown">
          <div class="skill-dropdown-actions">
            <button type="button" class="skill-dropdown-action" :disabled="allSkillsSelected" @click="emit('selectAllSkills')">全选</button>
            <button type="button" class="skill-dropdown-action" :disabled="activeSkillIds.size === 0" @click="emit('clearSkills')">清空</button>
          </div>
          <div
            v-for="skill in availableSkills"
            :key="skill.id"
            :class="['skill-option', { selected: activeSkillIds.has(skill.id) }]"
            @click="emit('toggleSkill', skill.id)"
          >
            <span class="skill-check">{{ activeSkillIds.has(skill.id) ? '✅' : '⬜' }}</span>
            <span class="skill-option-name">{{ skill.name }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-header {
  padding: 12px 24px;
  border-bottom: 1px solid var(--app-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.chat-header h2 {
  margin: 0;
  font-size: 1.1em;
  color: var(--app-text-strong);
}

.chat-header-copy {
  min-width: 0;
}

.chat-header-copy p {
  margin: 4px 0 0;
  color: var(--app-text-soft);
  font-size: 0.82rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.channel-binding-selector,
.auth-mode-selector {
  display: flex;
  align-items: center;
}

.select-input {
  background: var(--app-input-bg);
  border: 1px solid var(--app-input-border);
  border-radius: 6px;
  color: var(--app-text);
  padding: 4px 8px;
  font-size: 0.8em;
  cursor: pointer;
}

.select-input option {
  background: var(--app-input-bg);
  color: var(--app-text);
}

.select-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.select-input:focus {
  outline: none;
  border-color: var(--app-accent);
}


.skill-selector {
  position: relative;
}

.skill-toggle-btn {
  padding: 4px 12px;
  background: var(--app-input-bg);
  border: 1px solid var(--app-input-border);
  border-radius: 6px;
  color: var(--app-text-muted);
  font-size: 0.8em;
  cursor: pointer;
  transition: all 0.12s;
  white-space: nowrap;
}

.skill-toggle-btn:hover {
  border-color: var(--app-accent);
  color: var(--app-text);
}

.skill-toggle-btn.has-active {
  border-color: var(--app-accent);
  color: var(--app-text-strong);
  background: var(--app-accent-soft);
}

.skill-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 6px;
  min-width: 200px;
  max-width: min(320px, calc(100vw - 32px));
  max-height: min(420px, calc(100vh - 140px));
  overflow-y: auto;
  background: var(--app-panel);
  border: 1px solid var(--app-border-strong);
  border-radius: 8px;
  padding: 6px;
  z-index: 50;
  box-shadow: var(--app-shadow);
  backdrop-filter: blur(14px);
  overscroll-behavior: contain;
}

.skill-dropdown-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 4px 4px 8px;
}

.skill-dropdown-action {
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 0.76em;
  cursor: pointer;
}

.skill-dropdown-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.skill-dropdown-action:not(:disabled):hover {
  border-color: var(--app-accent);
  color: var(--app-text-strong);
}

.skill-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.82em;
  color: var(--app-text-muted);
  transition: background 0.1s;
}

.skill-option:hover {
  background: var(--app-panel-muted);
  color: var(--app-text);
}

.skill-option.selected {
  color: var(--app-text-strong);
  background: var(--app-accent-soft);
}

.skill-check {
  font-size: 0.9em;
}

.skill-option-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
