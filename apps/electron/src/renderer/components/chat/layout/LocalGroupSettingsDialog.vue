<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentGroupDefinition } from '../../../../shared/agent-workspace-types'
import {
  roomLocalWorkerName,
  type LocalAgentProfile,
  type RoomLocalWorker,
  type RoomLocalWorkspace
} from '../../../../shared/local-agent-types'
import type { AIExecutionAuthMode } from '../panel/types'
import { useDrawerDismiss } from './use-drawer-dismiss'

const props = defineProps<{
  open: boolean
  group: AgentGroupDefinition | null
  authMode: AIExecutionAuthMode
  workers?: RoomLocalWorker[]
  taskDirectory?: string | null
  targetProjectId?: string | null
  running?: boolean
  loading?: boolean
  loadError?: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'auth-mode-change', value: AIExecutionAuthMode): void
  (e: 'changed', group: AgentGroupDefinition): void
}>()

const { t } = useI18n()
// The drawer has no backdrop — the chat beside it stays usable — so a press
// that starts and ends outside of it (or Escape) is what folds it away.
const drawerEl = ref<HTMLElement | null>(null)
useDrawerDismiss(drawerEl, () => props.open, () => emit('close'))
const workspace = ref<RoomLocalWorkspace | null>(null)
const profiles = ref<LocalAgentProfile[]>([])
const selectedAgentId = ref('')
const role = ref('')
const instructions = ref('')
const exitAfterTask = ref(false)
const loadingWorkspace = ref(false)
const discovering = ref(false)
const joining = ref(false)
const pickingFolder = ref(false)
const removingWorkerId = ref('')
const workspaceError = ref('')
const agentError = ref('')
const feedback = ref('')
let active = true
let workspaceRequest = 0

const workerCount = computed(() => props.workers?.length || 0)
const availableProfiles = computed(() => (
  [...profiles.value].sort((left, right) => Number(right.available) - Number(left.available))
))
const selectedProfile = computed(() => (
  profiles.value.find(profile => profile.agentId === selectedAgentId.value) || null
))
const busy = computed(() => (
  loadingWorkspace.value
  || discovering.value
  || joining.value
  || pickingFolder.value
  || Boolean(removingWorkerId.value)
))
const canJoin = computed(() => Boolean(
  workspace.value?.source === 'group'
  && selectedProfile.value?.available
  && role.value.trim()
  && !/[@＠]/u.test(role.value)
  && !props.running
  && !busy.value
))
const workspaceLabel = computed(() => {
  if (workspace.value?.source === 'group') return t('localGroupSettings.folderSourceGroup')
  if (workspace.value?.source === 'task') return t('localGroupSettings.folderSourceTask')
  if (workspace.value?.source === 'project') return t('localGroupSettings.folderSourceProject')
  if (workspace.value?.source === 'room') return t('localGroupSettings.folderSourceRoom')
  return ''
})

async function desktopApi () {
  if (!window.electronAPI) throw new Error(t('chatUi.roomLocalAgentDesktopOnly'))
  return window.electronAPI
}

async function loadWorkspace (): Promise<void> {
  if (!props.group) return
  const request = ++workspaceRequest
  loadingWorkspace.value = true
  workspaceError.value = ''
  try {
    const resolved = await (await desktopApi()).getRoomLocalWorkspace(
      props.group.id,
      props.taskDirectory,
      props.targetProjectId
    )
    if (request === workspaceRequest) workspace.value = resolved
  } catch (error) {
    if (request === workspaceRequest) {
      workspace.value = null
      workspaceError.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (request === workspaceRequest) loadingWorkspace.value = false
  }
}

async function chooseWorkspace (): Promise<void> {
  if (!props.group || props.running || pickingFolder.value) return
  pickingFolder.value = true
  workspaceError.value = ''
  feedback.value = ''
  try {
    const folder = await (await desktopApi()).pickFolderWorkspace()
    if (!active || folder.canceled || !folder.rootPath) return
    const group = await (await desktopApi()).setRoomLocalWorkspace(
      props.group.id,
      folder.rootPath,
      folder.rootName
    )
    if (!active) return
    workspace.value = group.workspaceRoot
      ? { path: group.workspaceRoot, source: 'group' }
      : workspace.value
    feedback.value = t('localGroupSettings.workspaceChanged')
    emit('changed', group)
  } catch (error) {
    workspaceError.value = error instanceof Error ? error.message : String(error)
  } finally {
    pickingFolder.value = false
  }
}

async function discoverAgents (): Promise<void> {
  if (discovering.value) return
  discovering.value = true
  agentError.value = ''
  try {
    profiles.value = await (await desktopApi()).discoverLocalAgents()
    const available = profiles.value.filter(profile => profile.available)
    if (!available.some(profile => profile.agentId === selectedAgentId.value)) {
      selectedAgentId.value = available[0]?.agentId || ''
    }
  } catch (error) {
    agentError.value = error instanceof Error ? error.message : String(error)
  } finally {
    discovering.value = false
  }
}

async function joinAgent (): Promise<void> {
  if (!props.group || !canJoin.value) return
  joining.value = true
  agentError.value = ''
  feedback.value = ''
  try {
    const { worker, group } = await (await desktopApi()).inviteRoomLocalWorker(
      selectedAgentId.value,
      props.group.id,
      {
        role: role.value.trim(),
        instructions: instructions.value.trim(),
        exitAfterTask: exitAfterTask.value
      }
    )
    if (!active) return
    feedback.value = t('localGroupSettings.agentJoined', { name: roomLocalWorkerName(worker) })
    role.value = ''
    instructions.value = ''
    emit('changed', group)
  } catch (error) {
    agentError.value = error instanceof Error ? error.message : String(error)
  } finally {
    joining.value = false
  }
}

async function removeWorker (worker: RoomLocalWorker): Promise<void> {
  if (!props.group || props.running || busy.value) return
  removingWorkerId.value = worker.id
  agentError.value = ''
  feedback.value = ''
  try {
    const { group } = await (await desktopApi()).removeRoomLocalWorker(props.group.id, worker.id)
    if (!active) return
    feedback.value = t('localGroupSettings.agentRemoved', { name: roomLocalWorkerName(worker) })
    emit('changed', group)
  } catch (error) {
    agentError.value = error instanceof Error ? error.message : String(error)
  } finally {
    removingWorkerId.value = ''
  }
}

function setAuthMode (value: AIExecutionAuthMode): void {
  if (props.authMode === value) return
  emit('auth-mode-change', value)
}

function seed (): void {
  if (!props.open || !props.group) return
  feedback.value = ''
  agentError.value = ''
  workspaceError.value = ''
  void loadWorkspace()
  void discoverAgents()
}

watch(() => props.open, (open) => {
  if (open) seed()
}, { immediate: true })

watch(() => props.group?.id, () => {
  if (props.open) seed()
})

watch(() => [props.taskDirectory, props.targetProjectId], () => {
  if (props.open) void loadWorkspace()
})

onBeforeUnmount(() => {
  active = false
  workspaceRequest += 1
})
</script>

<template>
  <!--
    Right-hand settings drawer. It renders in place: the chat panel's drawer
    slot parks it under the title row, flush with the panel's right edge, so
    it never covers the title. Everything here is about how it looks.
  -->
  <Transition name="group-drawer">
    <section
      v-if="open"
      ref="drawerEl"
      class="local-group-settings-drawer"
      role="dialog"
      aria-modal="false"
      :aria-label="$t('localGroupSettings.title')"
    >
      <header class="local-group-settings-head">
        <div>
          <span class="local-group-settings-icon" aria-hidden="true">{{ group?.icon || '🧩' }}</span>
          <div>
            <strong>{{ $t('localGroupSettings.title') }}</strong>
            <small v-if="group">{{ group.name }}</small>
          </div>
        </div>
        <button type="button" :aria-label="$t('common.close')" @click="emit('close')">✕</button>
      </header>

      <div v-if="group" class="local-group-settings-body">
        <div class="local-group-settings-summary">
          <span>{{ $t('onlineGroups.agentCount', { count: group.memberAgentIds.length + workerCount }) }}</span>
          <span>{{ $t('localGroupSettings.roundLimit', { count: group.maxRounds }) }}</span>
        </div>

        <p v-if="running" class="local-group-settings-running" role="status">
          {{ $t('localGroupSettings.runningHint') }}
        </p>

        <section class="local-group-settings-section">
          <div class="local-group-settings-section-head">
            <h3>{{ $t('localGroupSettings.workingFolder') }}</h3>
            <button
              type="button"
              class="local-group-settings-link"
              :disabled="running || pickingFolder || loadingWorkspace"
              @click="chooseWorkspace"
            >
              {{ pickingFolder
                ? $t('localGroupSettings.changingFolder')
                : (workspace ? $t('localGroupSettings.switchFolder') : $t('localGroupSettings.chooseFolder')) }}
            </button>
          </div>
          <p class="local-group-settings-hint">{{ $t('localGroupSettings.workingFolderHint') }}</p>
          <div class="local-group-settings-workspace">
            <span v-if="loadingWorkspace">{{ $t('common.loading') }}</span>
            <template v-else-if="workspace">
              <code :title="workspace.path">{{ workspace.path }}</code>
              <small>{{ workspaceLabel }}</small>
            </template>
            <span v-else>{{ $t('localGroupSettings.noFolder') }}</span>
          </div>
          <p
            v-if="workspace && workspace.source !== 'group' && !loadingWorkspace"
            class="local-group-settings-note"
          >
            {{ $t('localGroupSettings.folderRequired') }}
          </p>
          <p v-if="workspaceError" class="local-group-settings-error" role="alert">{{ workspaceError }}</p>
        </section>

        <section class="local-group-settings-section">
          <h3>{{ $t('localGroupSettings.authorization') }}</h3>
          <p class="local-group-settings-hint">{{ $t('localGroupSettings.authorizationHint') }}</p>
          <div class="local-group-settings-auth" role="radiogroup" :aria-label="$t('localGroupSettings.authorization')">
            <button
              type="button"
              :class="{ active: authMode === 'auto' }"
              :aria-pressed="authMode === 'auto'"
              @click="setAuthMode('auto')"
            >
              <strong>{{ $t('localGroupSettings.authAuto') }}</strong>
              <span>{{ $t('localGroupSettings.authAutoHint') }}</span>
            </button>
            <button
              type="button"
              :class="{ active: authMode === 'strict' }"
              :aria-pressed="authMode === 'strict'"
              @click="setAuthMode('strict')"
            >
              <strong>{{ $t('localGroupSettings.authStrict') }}</strong>
              <span>{{ $t('localGroupSettings.authStrictHint') }}</span>
            </button>
          </div>
        </section>

        <section class="local-group-settings-section">
          <div class="local-group-settings-section-head">
            <h3>{{ $t('localGroupSettings.inviteAgent') }}</h3>
            <button
              type="button"
              class="local-group-settings-link"
              :disabled="discovering || busy"
              @click="discoverAgents"
            >
              {{ $t('localGroupSettings.refresh') }}
            </button>
          </div>
          <p class="local-group-settings-hint">{{ $t('localGroupSettings.inviteAgentHint') }}</p>

          <p v-if="discovering" class="local-group-settings-note" role="status">
            {{ $t('localGroupSettings.discovering') }}
          </p>
          <p v-else-if="!availableProfiles.some(profile => profile.available)" class="local-group-settings-note">
            {{ $t('localGroupSettings.noAgents') }}
          </p>
          <div v-else class="local-group-settings-agent-list" role="radiogroup" :aria-label="$t('localGroupSettings.installedAgents')">
            <label
              v-for="profile in availableProfiles"
              :key="profile.agentId"
              class="local-group-settings-agent"
              :class="{ selected: selectedAgentId === profile.agentId, unavailable: !profile.available }"
            >
              <span class="local-group-settings-agent-icon" aria-hidden="true">⌘</span>
              <span>
                <strong>{{ profile.name }}</strong>
                <small>{{ profile.version || $t(profile.available ? 'chatUi.roomAgentInstalled' : 'settings.agentWorkspace.localAgentNotFound') }}</small>
              </span>
              <input
                v-model="selectedAgentId"
                type="radio"
                name="local-group-settings-agent"
                :value="profile.agentId"
                :disabled="!profile.available || busy || running"
              />
            </label>
          </div>

          <div v-if="selectedAgentId" class="local-group-settings-invite-form">
            <label>
              <span>{{ $t('localGroupSettings.role') }}</span>
              <input
                v-model="role"
                maxlength="48"
                :disabled="busy || running"
                :placeholder="$t('localGroupSettings.rolePlaceholder')"
              />
            </label>
            <label>
              <span>{{ $t('localGroupSettings.instructions') }}</span>
              <textarea
                v-model="instructions"
                rows="2"
                maxlength="2000"
                :disabled="busy || running"
                :placeholder="$t('localGroupSettings.instructionsPlaceholder')"
              />
            </label>
            <label class="local-group-settings-checkbox">
              <input v-model="exitAfterTask" type="checkbox" :disabled="busy || running" />
              {{ $t('localGroupSettings.exitAfterTask') }}
            </label>
            <button
              type="button"
              class="local-group-settings-primary"
              :disabled="!canJoin"
              @click="joinAgent"
            >
              {{ joining ? $t('localGroupSettings.adding') : $t('localGroupSettings.addAgent') }}
            </button>
          </div>
          <p v-if="agentError" class="local-group-settings-error" role="alert">{{ agentError }}</p>
          <p v-if="feedback" class="local-group-settings-success" role="status">{{ feedback }}</p>

          <div class="local-group-settings-workers">
            <h4>{{ $t('localGroupSettings.currentAgents', { count: workerCount }) }}</h4>
            <p v-if="workerCount === 0" class="local-group-settings-note">
              {{ $t('localGroupSettings.noCurrentAgents') }}
            </p>
            <div
              v-for="worker in workers || []"
              :key="worker.id"
              class="local-group-settings-worker"
            >
              <span class="local-group-settings-agent-icon" aria-hidden="true">⌘</span>
              <span>
                <strong>{{ roomLocalWorkerName(worker) }}</strong>
                <small>{{ worker.kind }} · {{ $t(worker.exitAfterTask ? 'chatUi.roomWorkerAutoExit' : 'chatUi.roomWorkerStays') }}</small>
              </span>
              <button
                type="button"
                class="local-group-settings-link"
                :disabled="busy || running"
                @click="removeWorker(worker)"
              >
                {{ removingWorkerId === worker.id ? $t('common.loading') : $t('localGroupSettings.remove') }}
              </button>
            </div>
          </div>
        </section>
      </div>

      <div v-else class="local-group-settings-body local-group-settings-state-body">
        <p v-if="loading" role="status">{{ $t('common.loading') }}</p>
        <p v-else class="local-group-settings-error" role="alert">
          {{ loadError || $t('localGroupSettings.groupUnavailable') }}
        </p>
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
.local-group-settings-drawer {
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
.local-group-settings-state-body {
  align-items: center;
  justify-content: center;
  text-align: center;
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
.local-group-settings-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 14px 11px 18px;
  border-bottom: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel) 96%, transparent);
}
.local-group-settings-head > div {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.local-group-settings-head > div > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}
.local-group-settings-head strong {
  font-size: 0.84rem;
}
.local-group-settings-head small {
  overflow: hidden;
  color: var(--app-text-faint);
  font-size: 0.64rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.local-group-settings-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 27px;
  height: 27px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-accent-soft) 62%, transparent);
  font-size: 14px;
}
.local-group-settings-head > button {
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
.local-group-settings-body {
  display: flex;
  /* Only the body scrolls; the head with its close button stays put. */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  flex-direction: column;
  gap: 16px;
  padding: 14px 18px 18px;
}
.local-group-settings-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.local-group-settings-summary span {
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--app-panel-muted);
  color: var(--app-text-faint);
  font-size: 0.66rem;
}
.local-group-settings-running {
  margin: 0;
  padding: 7px 9px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-warning, #b78022) 10%, transparent);
  color: var(--app-text-muted);
  font-size: 0.68rem;
}
.local-group-settings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.local-group-settings-section h3,
.local-group-settings-workers h4 {
  margin: 0;
  color: var(--app-text-muted);
  font-size: 0.75rem;
}
.local-group-settings-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.local-group-settings-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--app-accent-strong);
  cursor: pointer;
  font: inherit;
  font-size: 0.68rem;
}
.local-group-settings-link:disabled {
  opacity: 0.45;
  cursor: default;
}
.local-group-settings-hint,
.local-group-settings-note {
  margin: 0;
  color: var(--app-text-faint);
  font-size: 0.67rem;
  line-height: 1.45;
}
.local-group-settings-workspace {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 7px 9px;
  border: 1px solid var(--app-border);
  border-radius: 9px;
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
  font-size: 0.68rem;
}
.local-group-settings-workspace code {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--app-text);
  font-size: 0.66rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.local-group-settings-workspace small {
  flex: 0 0 auto;
  color: var(--app-text-faint);
  font-size: 0.62rem;
}
.local-group-settings-auth {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.local-group-settings-auth button {
  display: flex;
  min-height: 62px;
  flex-direction: column;
  gap: 4px;
  padding: 9px 10px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.local-group-settings-auth button.active {
  border-color: color-mix(in srgb, var(--app-accent) 48%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 58%, var(--app-panel));
  color: var(--app-text);
}
.local-group-settings-auth strong {
  font-size: 0.7rem;
}
.local-group-settings-auth span {
  color: var(--app-text-faint);
  font-size: 0.62rem;
  line-height: 1.4;
}
.local-group-settings-agent-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.local-group-settings-agent,
.local-group-settings-worker {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 9px;
  border: 1px solid var(--app-border);
  border-radius: 9px;
  background: var(--app-panel-muted);
}
.local-group-settings-agent {
  cursor: pointer;
}
.local-group-settings-agent.selected {
  border-color: color-mix(in srgb, var(--app-accent) 48%, var(--app-border));
  background: var(--app-accent-soft);
}
.local-group-settings-agent.unavailable {
  opacity: 0.48;
  cursor: default;
}
.local-group-settings-agent-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 25px;
  height: 25px;
  border-radius: 8px;
  background: var(--app-panel);
  color: var(--app-accent-strong);
  font-size: 0.72rem;
  font-weight: 800;
}
.local-group-settings-agent > span:nth-child(2),
.local-group-settings-worker > span:nth-child(2) {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}
.local-group-settings-agent strong,
.local-group-settings-worker strong {
  overflow: hidden;
  color: var(--app-text);
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.local-group-settings-agent small,
.local-group-settings-worker small {
  overflow: hidden;
  color: var(--app-text-faint);
  font-size: 0.62rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.local-group-settings-agent input {
  accent-color: var(--app-accent);
}
.local-group-settings-invite-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 2px;
  padding: 10px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel-muted);
}
.local-group-settings-invite-form label:not(.local-group-settings-checkbox) {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--app-text-faint);
  font-size: 0.65rem;
}
.local-group-settings-invite-form input:not([type='checkbox']),
.local-group-settings-invite-form textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 7px 8px;
  border: 1px solid var(--app-border);
  border-radius: 7px;
  outline: none;
  background: var(--app-panel);
  color: var(--app-text);
  font: inherit;
  font-size: 0.7rem;
}
.local-group-settings-invite-form input:focus,
.local-group-settings-invite-form textarea:focus {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
}
.local-group-settings-invite-form textarea {
  resize: vertical;
}
.local-group-settings-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--app-text-muted);
  font-size: 0.66rem;
}
.local-group-settings-primary {
  align-self: flex-end;
  padding: 7px 13px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 54%, var(--app-border));
  border-radius: 8px;
  background: var(--app-accent);
  color: var(--app-accent-contrast, #fff);
  cursor: pointer;
  font: inherit;
  font-size: 0.7rem;
  font-weight: 650;
}
.local-group-settings-primary:disabled {
  opacity: 0.42;
  cursor: default;
}
.local-group-settings-error,
.local-group-settings-success {
  margin: 0;
  font-size: 0.66rem;
  line-height: 1.4;
}
.local-group-settings-error {
  color: var(--app-danger, #d33d49);
}
.local-group-settings-success {
  color: var(--app-success, #2f7a4a);
}
.local-group-settings-workers {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
  padding-top: 10px;
  border-top: 1px solid var(--app-border);
}
</style>
