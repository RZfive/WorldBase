<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  OnlineGroup,
  OnlineGroupIdentity
} from '../../../../shared/online-group-types.js'
import { useDrawerDismiss } from './use-drawer-dismiss'

const props = defineProps<{
  open: boolean
  group: OnlineGroup | null
  identity: OnlineGroupIdentity | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved'): void
  (e: 'delete-group'): void
  (e: 'leave-group'): void
}>()

const { t } = useI18n()
// The drawer has no backdrop — the chat beside it stays usable — so a press
// that starts and ends outside of it (or Escape) is what folds it away.
const drawerEl = ref<HTMLElement | null>(null)
const isOpen = computed(() => props.open && Boolean(props.group))
useDrawerDismiss(drawerEl, () => isOpen.value, () => emit('close'))
const saving = ref(false)
const error = ref('')
const form = reactive({
  name: '',
  icon: '🌐',
  description: ''
})

const canEdit = computed(() => Boolean(
  props.group
  && props.identity
  && (props.group.ownerPeerId === props.identity.instanceId || props.group.accessRole === 'admin')
))
const isOwner = computed(() => props.group?.ownerPeerId === props.identity?.instanceId)
const humanCount = computed(() => props.group?.members.filter(member => member.kind === 'human').length || 0)
const agentCount = computed(() => props.group?.members.filter(member => member.kind === 'agent').length || 0)
const changed = computed(() => Boolean(
  props.group
  && (form.name !== props.group.name
    || form.icon !== (props.group.icon || '🌐')
    || form.description !== props.group.description)
))

function seed (): void {
  if (!props.group) return
  form.name = props.group.name
  form.icon = props.group.icon || '🌐'
  form.description = props.group.description
  error.value = ''
}

watch(() => props.open, (open) => {
  if (open) seed()
}, { immediate: true })

watch(() => props.group?.id, () => {
  if (props.open) seed()
})

async function save (): Promise<void> {
  if (!props.group || !canEdit.value || saving.value) return
  if (!form.name.trim()) {
    error.value = t('onlineGroups.nameRequired')
    return
  }
  saving.value = true
  error.value = ''
  try {
    await window.electronAPI!.updateOnlineGroup(props.group.id, {
      name: form.name.trim(),
      icon: form.icon.trim() || '🌐',
      description: form.description.trim()
    })
    emit('saved')
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <!--
    Right-hand settings drawer, the counterpart of the three-dot button. It
    renders in place: the chat panel's drawer slot parks it under the title
    row, flush with the panel's right edge, so it never covers the title.
  -->
  <Transition name="group-drawer">
    <section
      v-if="props.open && props.group"
      ref="drawerEl"
      class="group-settings-drawer"
      role="dialog"
      aria-modal="false"
      :aria-label="$t('onlineGroups.groupSettings')"
    >
      <header class="group-settings-head">
        <div>
          <span class="group-settings-icon" aria-hidden="true">{{ form.icon || '🌐' }}</span>
          <strong>{{ $t('onlineGroups.groupSettings') }}</strong>
        </div>
        <button type="button" :aria-label="$t('common.close')" @click="emit('close')">✕</button>
      </header>

      <div class="group-settings-body">
        <div class="group-settings-summary">
          <span>{{ $t('onlineGroups.humanCount', { count: humanCount }) }}</span>
          <span>{{ $t('onlineGroups.agentCount', { count: agentCount }) }}</span>
          <span>{{ $t('onlineGroups.ownerName', { name: props.group.ownerName }) }}</span>
        </div>

        <section class="group-settings-section">
          <h3>{{ $t('onlineGroups.groupContent') }}</h3>
          <div class="group-settings-form">
            <div class="group-settings-row">
              <label class="group-settings-field compact">
                <span>{{ $t('onlineGroups.icon') }}</span>
                <input v-model="form.icon" maxlength="16" :disabled="!canEdit" />
              </label>
              <label class="group-settings-field">
                <span>{{ $t('onlineGroups.groupName') }}</span>
                <input v-model="form.name" maxlength="80" :disabled="!canEdit" />
              </label>
            </div>
            <label class="group-settings-field">
              <span>{{ $t('onlineGroups.description') }}</span>
              <textarea v-model="form.description" rows="3" maxlength="1000" :disabled="!canEdit" />
            </label>
          </div>
          <p v-if="error" class="group-settings-error">{{ error }}</p>
          <div v-if="canEdit" class="group-settings-save">
            <button type="button" class="primary" :disabled="saving || !changed" @click="save">
              {{ saving ? $t('onlineGroups.syncing') : $t('onlineGroups.saveChanges') }}
            </button>
          </div>
        </section>

        <section class="group-settings-danger">
          <h3>{{ $t('onlineGroups.groupManagement') }}</h3>
          <button v-if="isOwner" type="button" class="danger" @click="emit('delete-group')">
            {{ $t('onlineGroups.deleteGroup') }}
          </button>
          <button v-else type="button" @click="emit('leave-group')">
            {{ $t('onlineGroups.leave') }}
          </button>
        </section>
      </div>
    </section>
  </Transition>
</template>

<style scoped>
/*
 * Right-hand drawer. Its slot in the chat panel fixes where it sits; the look
 * is decided here. The canvas is laid under the panel tint because
 * --app-panel is ~92% alpha: without the opaque base, chat text scrolled
 * behind the drawer would ghost through it.
 */
.group-settings-drawer {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  border-left: 1px solid color-mix(in srgb, var(--app-border-strong) 76%, transparent);
  background-color: var(--app-chat-canvas);
  background-image: linear-gradient(var(--app-panel), var(--app-panel));
  box-shadow: -18px 0 48px rgba(5, 13, 23, 0.28);
  color: var(--app-text);
  /* The slot around the drawer lets clicks through to the chat; the drawer takes them back. */
  pointer-events: auto;
}
@media (prefers-reduced-motion: no-preference) {
  .group-drawer-enter-active {
    transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease;
  }
  .group-drawer-leave-active {
    transition: transform 0.18s ease-in, opacity 0.16s ease;
  }
  .group-drawer-enter-from,
  .group-drawer-leave-to {
    opacity: 0;
    transform: translateX(32px);
  }
}
.group-settings-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 14px 11px 18px;
  border-bottom: 1px solid var(--app-border);
}
.group-settings-head > div {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.group-settings-head strong {
  font-size: 0.84rem;
}
.group-settings-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 25px;
  height: 25px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-accent-soft) 62%, transparent);
  font-size: 14px;
}
.group-settings-head button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 0.72rem;
}
.group-settings-body {
  display: flex;
  /* Only the body scrolls; the head with its close button stays put. */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  flex-direction: column;
  gap: 15px;
  padding: 14px 18px 18px;
}
.group-settings-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.group-settings-summary span {
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-faint);
  font-size: 0.66rem;
}
.group-settings-section,
.group-settings-danger {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.group-settings-section h3,
.group-settings-danger h3 {
  margin: 0;
  font-size: 0.75rem;
  color: var(--app-text-muted);
}
.group-settings-form {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.group-settings-row {
  display: flex;
  gap: 8px;
}
.group-settings-field {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.group-settings-field.compact {
  flex: 0 0 64px;
}
.group-settings-field > span {
  color: var(--app-text-faint);
  font-size: 0.66rem;
}
.group-settings-field input,
.group-settings-field textarea {
  width: 100%;
  padding: 8px 9px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  outline: none;
  background: var(--app-input-bg);
  color: var(--app-text);
  font: inherit;
  font-size: 0.78rem;
}
.group-settings-field input:focus,
.group-settings-field textarea:focus {
  border-color: color-mix(in srgb, var(--app-accent-strong) 48%, var(--app-border));
}
.group-settings-field input:disabled,
.group-settings-field textarea:disabled {
  opacity: 0.72;
  cursor: default;
}
.group-settings-field textarea {
  resize: vertical;
  line-height: 1.5;
}
.group-settings-error {
  margin: 0;
  color: var(--app-danger);
  font-size: 0.7rem;
}
.group-settings-save {
  display: flex;
  justify-content: flex-end;
}
.group-settings-save button,
.group-settings-danger button {
  padding: 7px 11px;
  border: 1px solid var(--app-border-strong);
  border-radius: 8px;
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: 0.72rem;
}
.group-settings-save button.primary {
  border-color: var(--app-accent-strong);
  background: var(--app-accent-strong);
  color: var(--app-accent-contrast, #fff);
}
.group-settings-save button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.group-settings-danger {
  padding-top: 14px;
  border-top: 1px solid var(--app-border);
}
.group-settings-danger button {
  align-self: flex-start;
}
.group-settings-danger button.danger {
  color: var(--app-danger);
}
</style>
