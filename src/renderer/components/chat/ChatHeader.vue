<script setup lang="ts">
import { computed } from 'vue'

interface ProviderOption {
  id: string
  name: string
  models: string[]
}

interface SkillItem {
  id: string
  name: string
}

const props = defineProps<{
  providers: ProviderOption[]
  activeProviderId: string
  selectedModel: string
  availableSkills: SkillItem[]
  activeSkillIds: Set<string>
  showSkillPicker: boolean
}>()

const emit = defineEmits<{
  (e: 'update:activeProviderId', providerId: string): void
  (e: 'update:selectedModel', model: string): void
  (e: 'toggleSkillPicker'): void
  (e: 'toggleSkill', skillId: string): void
}>()

const activeProvider = computed(() =>
  props.providers.find(provider => provider.id === props.activeProviderId) || null
)

function onProviderChange (event: Event) {
  emit('update:activeProviderId', (event.target as HTMLSelectElement).value)
}

function onModelChange (event: Event) {
  emit('update:selectedModel', (event.target as HTMLSelectElement).value)
}
</script>

<template>
  <div class="chat-header">
    <h2>💬 AI 对话</h2>
    <div class="header-controls">
      <div v-if="providers.length > 0" class="provider-selector">
        <select :value="activeProviderId" class="select-input" @change="onProviderChange">
          <option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
        </select>
        <select
          v-if="activeProvider?.models?.length"
          :value="selectedModel"
          class="select-input"
          @change="onModelChange"
        >
          <option v-for="model in (activeProvider?.models || [])" :key="model" :value="model">{{ model }}</option>
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
  border-bottom: 1px solid #27272a;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.chat-header h2 {
  margin: 0;
  font-size: 1.1em;
  white-space: nowrap;
}

.header-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.provider-selector {
  display: flex;
  gap: 8px;
}

.select-input {
  background: #27272a;
  border: 1px solid #3f3f46;
  border-radius: 6px;
  color: #e4e4e7;
  padding: 4px 8px;
  font-size: 0.8em;
  cursor: pointer;
}

.select-input:focus {
  outline: none;
  border-color: #3b82f6;
}

.skill-selector {
  position: relative;
}

.skill-toggle-btn {
  padding: 4px 12px;
  background: #27272a;
  border: 1px solid #3f3f46;
  border-radius: 6px;
  color: #a1a1aa;
  font-size: 0.8em;
  cursor: pointer;
  transition: all 0.12s;
  white-space: nowrap;
}

.skill-toggle-btn:hover {
  border-color: #6366f1;
  color: #e4e4e7;
}

.skill-toggle-btn.has-active {
  border-color: #6366f1;
  color: #c7d2fe;
  background: #1e1b4b40;
}

.skill-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 6px;
  min-width: 200px;
  background: #1e1e22;
  border: 1px solid #3f3f46;
  border-radius: 8px;
  padding: 6px;
  z-index: 50;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.skill-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.82em;
  color: #a1a1aa;
  transition: background 0.1s;
}

.skill-option:hover {
  background: #27272a;
  color: #e4e4e7;
}

.skill-option.selected {
  color: #c7d2fe;
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
