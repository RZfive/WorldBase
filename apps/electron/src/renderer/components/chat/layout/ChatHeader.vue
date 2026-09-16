<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ProviderModelDropdown from './ProviderModelDropdown.vue'
import ProviderDropdown from './ProviderDropdown.vue'

interface ChannelBindingOption {
  id: string
  connectorType: string
  externalChannelId: string
}

interface ProviderItem {
  id: string
  name: string
  models: string[]
}

interface AgentOption {
  id: string
  name: string
  icon?: string
}

type ReasoningStrength = 'low' | 'medium' | 'high' | 'max'

const props = defineProps<{
  contextLabel: string
  contextDetail: string
  availableChannelBindings: ChannelBindingOption[]
  selectedChannelBindingId: string
  providers?: ProviderItem[]
  activeProviderId?: string
  selectedModel?: string
  showProviderSelector?: boolean
  reasoningStrength?: ReasoningStrength
  temperature?: number | null
  providerDefaultTemperature?: number
  isGroupConversation?: boolean
  /** New-conversation agent switcher, pinned next to the agent name (design v1.7). */
  showAgentSelector?: boolean
  availableAgents?: AgentOption[]
  selectedAgentId?: string
}>()

const emit = defineEmits<{
  (e: 'update:selected-channel-binding-id', channelBindingId: string): void
  (e: 'selectProviderModel', selection: { providerId: string; model: string }): void
  (e: 'update:reasoning-strength', value: ReasoningStrength): void
  (e: 'update:temperature', value: number | null): void
  (e: 'update:selected-agent-id', id: string): void
}>()

function onChannelBindingChange (event: Event) {
  emit('update:selected-channel-binding-id', (event.target as HTMLSelectElement).value)
}

const showAgentPicker = computed(() => Boolean(
  props.showAgentSelector &&
  props.availableAgents &&
  props.availableAgents.length > 0
))

// The trigger reads the selected agent (falling back to the default agent
// label) instead of a static prompt, so the header states who will answer.
const { t } = useI18n()
const agentPickerLabel = computed(() => {
  if (props.selectedAgentId) {
    const found = (props.availableAgents || []).find(agent => agent.id === props.selectedAgentId)
    if (found) return (found.icon ? found.icon + ' ' : '') + found.name
  }
  return t('chatUi.defaultAgent')
})
</script>

<template>
  <div class="chat-header">
    <div class="chat-header-copy">
      <h2 :title="contextLabel">{{ contextLabel }}</h2>
      <template v-if="showAgentPicker">
        <span class="header-meta-separator" aria-hidden="true">·</span>
        <div class="header-agent-picker">
          <ProviderDropdown
            :model-value="selectedAgentId || ''"
            :options="[{ value: '', label: $t('chatUi.defaultAgent') }, ...(availableAgents || []).map(a => ({ value: a.id, label: (a.icon ? a.icon + ' ' : '') + a.name }))]"
            :title="agentPickerLabel"
            @update:model-value="emit('update:selected-agent-id', $event)"
          />
        </div>
      </template>
      <template v-else-if="contextDetail">
        <span class="header-meta-separator" aria-hidden="true">·</span>
        <p :title="contextDetail">{{ contextDetail }}</p>
      </template>
    </div>

    <div class="header-controls">
      <div v-if="availableChannelBindings.length > 0" class="channel-binding-selector">
        <select :value="selectedChannelBindingId" class="select-input" @change="onChannelBindingChange">
          <option value="">{{ $t('chatUi.noImBinding') }}</option>
          <option v-for="binding in availableChannelBindings" :key="binding.id" :value="binding.id">
            {{ binding.connectorType }} · {{ binding.externalChannelId }}
          </option>
        </select>
      </div>

      <!-- Provider switch capsule on the far side of the header (design v1.7). -->
      <div v-if="showProviderSelector && providers && providers.length > 0" class="header-model-picker">
        <ProviderModelDropdown
          :providers="providers"
          :active-provider-id="activeProviderId"
          :selected-model="selectedModel"
          :title="$t('chatUi.providerModelTitle')"
          :show-tuning="true"
          :reasoning-strength="reasoningStrength"
          :temperature="temperature"
          :provider-default-temperature="providerDefaultTemperature"
          :is-group-conversation="isGroupConversation"
          @select="emit('selectProviderModel', $event)"
          @update:reasoning-strength="emit('update:reasoning-strength', $event)"
          @update:temperature="emit('update:temperature', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-header {
  /*
   * --app-panel is rgba(...0.92) — not fully opaque, so message text bled
   * through the "solid" region. Use --app-chat-canvas: the opaque flatten of
   * --app-main-surface over --app-shell-bg, i.e. the exact solid color the
   * semi-transparent message-list canvas reads as. The header fully occludes
   * scrolling text while colour-matching the text-area background (raw
   * --app-shell-bg is bluer than the canvas and caused a visible tint seam).
   */
  --chat-header-solid: var(--app-chat-canvas);
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 12;
  height: 49px;
  min-height: 49px;
  padding: 0 15px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  /*
   * No backdrop blur. The header is a solid panel surface across the top
   * (where the controls live, so they stay readable) that fades to transparent
   * toward the bottom edge, with a hairline seam (design v1.7 chat head).
   */
  background: var(--chat-header-solid);
}

.chat-header::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: color-mix(in srgb, var(--app-border) 55%, transparent);
  pointer-events: none;
}

.chat-header h2 {
  flex: 0 1 auto;
  min-width: 0;
  margin: 0;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--app-text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-header-copy {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.chat-header-copy p {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  color: var(--app-text-soft);
  font-size: 0.82rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-meta-separator {
  flex: 0 0 auto;
  color: var(--app-text-muted);
  font-size: 0.82rem;
  opacity: 0.7;
}

.header-model-picker {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  max-width: min(420px, 44vw);
  min-width: 0;
}

.header-model-picker :deep(.provider-model-trigger) {
  height: 24px;
  max-width: 100%;
  padding: 0 10px 0 20px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-panel-strong) 72%, transparent);
  color: var(--app-text-muted);
  font-size: 0.68rem;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  letter-spacing: 0.02em;
  box-shadow: none;
}

/* Signature dot in front of the model pill (design v1.7 chat head). */
.header-model-picker :deep(.provider-model-trigger)::before {
  content: '';
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--app-sig);
}

.header-model-picker :deep(.provider-model-trigger:hover:not(:disabled)),
.header-model-picker :deep(.provider-model-trigger.open),
.header-model-picker :deep(.provider-model-trigger:focus) {
  border-color: color-mix(in srgb, var(--app-accent) 40%, var(--app-border));
  background: var(--app-panel-strong);
  color: var(--app-text-strong);
  box-shadow: none;
}

.header-model-picker :deep(.provider-model-trigger) {
  position: relative;
}

.header-model-picker :deep(.provider-model-value) {
  max-width: 100%;
}

.header-controls {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* New-conversation agent switcher, sitting next to the agent name (design v1.7). */
.header-agent-picker {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  min-width: 0;
  max-width: min(240px, 28vw);
}

.header-agent-picker :deep(.provider-dropdown-trigger) {
  height: 24px;
  max-width: 100%;
  padding: 0 9px;
  gap: 5px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-panel-strong) 72%, transparent);
  color: var(--app-text-muted);
  font-size: 0.68rem;
  box-shadow: none;
}

.header-agent-picker :deep(.provider-dropdown-trigger:hover:not(:disabled)),
.header-agent-picker :deep(.provider-dropdown-trigger.open),
.header-agent-picker :deep(.provider-dropdown-trigger:focus) {
  border-color: color-mix(in srgb, var(--app-accent) 40%, var(--app-border));
  background: var(--app-panel-strong);
  color: var(--app-text-strong);
}

.header-agent-picker :deep(.provider-dropdown-title) {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- header「更多」settings menu (design v1.7 P2) ---- */
/* (moved into ProviderModelDropdown's tuning section) */

.channel-binding-selector,
.auth-mode-selector {
  display: flex;
  align-items: center;
  min-width: 0;
}

.select-input {
  max-width: min(220px, 24vw);
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
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 10px;
  background: color-mix(in srgb, var(--app-panel-strong) 72%, transparent);
  border: 1px solid var(--app-border);
  border-radius: 999px;
  color: var(--app-text-muted);
  font-size: 0.68rem;
  cursor: pointer;
  transition: all 0.12s;
  white-space: nowrap;
}

.skill-spark {
  color: var(--app-accent-strong);
  font-size: 0.7rem;
}

.skill-toggle-btn:hover {
  border-color: color-mix(in srgb, var(--app-accent) 40%, var(--app-border));
  color: var(--app-text);
}

.skill-toggle-btn.has-active {
  border-color: color-mix(in srgb, var(--app-accent) 40%, var(--app-border));
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
  width: 13px;
  height: 13px;
  border-radius: 4px;
  border: 1px solid var(--app-border-strong);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--app-on-accent);
}

.skill-check.on {
  border-color: transparent;
  background: var(--app-accent);
}

.skill-check svg {
  width: 10px;
  height: 10px;
}

.skill-option-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
