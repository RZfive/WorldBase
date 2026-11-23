<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { roomLocalWorkerName, type LocalAgentProfile, type RoomLocalWorker, type RoomLocalWorkspace } from '../../../../shared/local-agent-types'

const props = defineProps<{
  groupId: string
  workers: RoomLocalWorker[]
  taskDirectory?: string | null
  targetProjectId?: string | null
}>()
const emit = defineEmits<{
  (event: 'close'): void
  (event: 'joined', agentName: string): void
  (event: 'selectFolder', folder: { rootPath: string; rootName?: string }): void
}>()

const { t } = useI18n()
const titleId = useId()
const descriptionId = useId()
const dialogRef = ref<HTMLDialogElement | null>(null)
const roleInput = ref<HTMLInputElement | null>(null)
const agents = ref<LocalAgentProfile[]>([])
const workspace = ref<RoomLocalWorkspace | null>(null)
const selectedId = ref('')
const role = ref('')
const instructions = ref('')
const exitAfterTask = ref(false)
const discovering = ref(false)
const loadingWorkspace = ref(false)
const pickingFolder = ref(false)
const joining = ref(false)
const removingId = ref('')
const agentError = ref('')
const workerError = ref('')
const workspaceError = ref('')
let active = true
let workspaceRequest = 0

const availableAgents = computed(() => [...agents.value].sort((left, right) => Number(right.available) - Number(left.available)))
const busy = computed(() => joining.value || pickingFolder.value || Boolean(removingId.value))
const canJoin = computed(() => Boolean(workspace.value && role.value.trim() && !/[@＠]/u.test(role.value) && agents.value.some(agent => {
  return agent.agentId === selectedId.value && agent.available
})) && !discovering.value && !loadingWorkspace.value && !busy.value)
const workspaceLabel = computed(() => {
  if (workspace.value?.source === 'task') return t('chatUi.roomTaskWorkspace')
  if (workspace.value?.source === 'project') return t('chatUi.roomProjectWorkspace')
  return t('chatUi.roomDefaultWorkspace')
})

function desktopApi () {
  if (!window.electronAPI) throw new Error(t('chatUi.roomLocalAgentDesktopOnly'))
  return window.electronAPI
}

async function discover () {
  if (discovering.value) return
  discovering.value = true
  agentError.value = ''
  try {
    agents.value = await desktopApi().discoverLocalAgents()
    const selectable = agents.value.filter(agent => agent.available)
    if (!selectable.some(agent => agent.agentId === selectedId.value)) selectedId.value = selectable[0]?.agentId || ''
  } catch (error) {
    agentError.value = error instanceof Error ? error.message : String(error)
  } finally {
    discovering.value = false
  }
}

async function loadWorkspace () {
  const request = ++workspaceRequest
  loadingWorkspace.value = true
  workspaceError.value = ''
  try {
    const resolved = await desktopApi().getRoomLocalWorkspace(props.groupId, props.taskDirectory, props.targetProjectId)
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

async function chooseWorkspace () {
  pickingFolder.value = true
  try {
    const folder = await desktopApi().pickFolderWorkspace()
    if (active && !folder.canceled && folder.rootPath) emit('selectFolder', { rootPath: folder.rootPath, rootName: folder.rootName })
  } catch (error) {
    workspaceError.value = error instanceof Error ? error.message : String(error)
  } finally {
    pickingFolder.value = false
  }
}

async function join () {
  if (!canJoin.value) return
  joining.value = true
  agentError.value = ''
  try {
    const { worker } = await desktopApi().inviteRoomLocalWorker(selectedId.value, props.groupId, {
      role: role.value,
      instructions: instructions.value,
      exitAfterTask: exitAfterTask.value
    })
    if (!active) return
    emit('joined', roomLocalWorkerName(worker))
    role.value = ''
    instructions.value = ''
    await nextTick()
    roleInput.value?.focus()
  } catch (error) {
    agentError.value = error instanceof Error ? error.message : String(error)
  } finally {
    joining.value = false
  }
}

function close () {
  if (!busy.value) emit('close')
}

async function removeWorker (worker: RoomLocalWorker) {
  if (busy.value) return
  removingId.value = worker.id
  workerError.value = ''
  try {
    await desktopApi().removeRoomLocalWorker(props.groupId, worker.id)
  } catch (error) {
    workerError.value = error instanceof Error ? error.message : String(error)
  } finally {
    removingId.value = ''
  }
}

watch(() => [props.taskDirectory, props.targetProjectId], loadWorkspace, { immediate: true })
onMounted(() => {
  dialogRef.value?.showModal()
  void discover()
})
onBeforeUnmount(() => {
  active = false
  workspaceRequest += 1
  dialogRef.value?.close()
})
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialogRef" class="room-agent-dialog" :aria-labelledby="titleId" :aria-describedby="descriptionId" @cancel.prevent="close" @click.self="close">
      <form class="room-agent-surface" @submit.prevent="join">
        <header class="room-agent-header">
          <span class="room-agent-icon header-icon" aria-hidden="true">
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2.5"/><path d="M8 21h8m-4-4v4M7 9l2 2-2 2m5 0h4"/></svg>
          </span>
          <div>
            <h2 :id="titleId">{{ $t('chatUi.roomInviteLocalAgent') }}</h2>
            <p :id="descriptionId">{{ $t('chatUi.roomInviteLocalAgentHint') }}</p>
          </div>
          <button class="room-agent-close" type="button" :aria-label="$t('common.close')" :disabled="busy" @click="close">×</button>
        </header>

        <div class="room-agent-body">
          <section class="room-agent-workspace">
            <div class="room-agent-section-head">
              <strong>{{ workspaceLabel }}</strong>
              <button class="room-agent-link" type="button" :disabled="busy" @click="chooseWorkspace">{{ $t('chatUi.roomChangeWorkspace') }}</button>
            </div>
            <code v-if="workspace" class="room-agent-path" :title="workspace.path">{{ workspace.path }}</code>
            <p v-else-if="loadingWorkspace" class="room-agent-note" role="status">{{ $t('common.loading') }}</p>
            <p v-if="workspaceError" class="room-agent-error" role="alert">{{ workspaceError }}</p>
          </section>

          <div class="room-agent-section-head">
            <strong>{{ $t('chatUi.roomDiscoveredAgents') }}</strong>
            <button class="room-agent-link" type="button" :disabled="discovering || busy" @click="discover">{{ $t('chatUi.roomRefreshLocalAgents') }}</button>
          </div>
          <p v-if="discovering" class="room-agent-note" role="status">{{ $t('chatUi.roomDiscoveringLocalAgents') }}</p>
          <p v-else-if="!agents.some(agent => agent.available) && !agentError" class="room-agent-note" role="status">{{ $t('chatUi.roomNoLocalAgents') }}</p>
          <div class="room-agent-list" role="radiogroup" :aria-label="$t('chatUi.roomDiscoveredAgents')" :aria-busy="discovering">
            <label
              v-for="agent in availableAgents"
              :key="agent.agentId"
              class="room-agent-row"
              :class="{ selected: selectedId === agent.agentId, unavailable: !agent.available }"
            >
              <span class="room-agent-icon" :data-kind="agent.kind" aria-hidden="true">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 7 5 5-5 5m8 0h6"/></svg>
              </span>
              <span class="room-agent-name">
                <strong>{{ agent.name }}</strong>
                <small>{{ agent.version || $t(agent.available ? 'chatUi.roomAgentInstalled' : 'settings.agentWorkspace.localAgentNotFound') }}</small>
              </span>
              <input v-model="selectedId" type="radio" name="room-local-agent" :value="agent.agentId" :disabled="!agent.available || busy || discovering" />
            </label>
          </div>
          <fieldset v-if="selectedId" class="room-worker-fields" :disabled="busy">
            <label class="room-worker-label">
              <strong>{{ $t('chatUi.roomWorkerRole') }}</strong>
              <input ref="roleInput" v-model="role" maxlength="48" required :placeholder="$t('chatUi.roomWorkerRolePlaceholder')" />
            </label>
            <label class="room-worker-label">
              <strong>{{ $t('chatUi.roomWorkerInstructions') }}</strong>
              <textarea v-model="instructions" rows="2" maxlength="2000" :placeholder="$t('chatUi.roomWorkerInstructionsPlaceholder')" />
            </label>
            <label class="room-worker-option">
              <input v-model="exitAfterTask" type="checkbox" />{{ $t('chatUi.roomWorkerAutoExit') }}
            </label>
          </fieldset>
          <p v-if="agentError" class="room-agent-error" role="alert">{{ agentError }}</p>

          <section v-if="props.workers.length || workerError" class="room-worker-roster">
            <div class="room-agent-section-head"><strong>{{ $t('chatUi.roomWorkerRoster', { count: props.workers.length }) }}</strong></div>
            <div v-for="worker in props.workers" :key="worker.id" class="room-worker-row">
              <span class="room-agent-name">
                <strong>{{ roomLocalWorkerName(worker) }}</strong>
                <small>{{ agents.find(agent => agent.kind === worker.kind)?.name || worker.kind }} · {{ $t(worker.exitAfterTask ? 'chatUi.roomWorkerAutoExit' : 'chatUi.roomWorkerStays') }}</small>
              </span>
              <button class="room-agent-link worker-remove" type="button" :disabled="busy" @click="removeWorker(worker)">{{ $t(removingId === worker.id ? 'common.loading' : 'chatUi.roomWorkerLeave') }}</button>
            </div>
            <p v-if="workerError" class="room-agent-error" role="alert">{{ workerError }}</p>
          </section>
        </div>

        <footer class="room-agent-actions">
          <button type="button" :disabled="busy" @click="close">{{ $t('common.close') }}</button>
          <button class="room-agent-join" type="submit" :disabled="!canJoin">{{ $t(joining ? 'chatUi.roomJoiningLocalAgent' : 'chatUi.roomWorkerAdd') }}</button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.room-agent-dialog {
  position: fixed;
  inset: 0;
  width: min(470px, calc(100vw - 32px));
  height: fit-content;
  max-height: calc(100dvh - 32px);
  margin: auto;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--app-border-strong);
  border-radius: 20px;
  background: var(--app-panel-strong);
  color: var(--app-text);
  box-shadow: 0 24px 80px rgb(10 16 32 / 28%);
}

.room-agent-dialog::backdrop {
  background: transparent;
}

.room-agent-surface { display: flex; flex-direction: column; max-height: calc(100dvh - 34px); }
.room-agent-header { display: grid; grid-template-columns: auto 1fr auto; align-items: start; gap: 12px; padding: 20px 20px 15px; }
.room-agent-header h2 { margin: 1px 0 4px; color: var(--app-text-strong); font-size: 17px; line-height: 1.3; }
.room-agent-header p { margin: 0; color: var(--app-text-muted); font-size: 12px; line-height: 1.5; }
.room-agent-icon { display: grid; place-items: center; width: 33px; height: 33px; border-radius: 9px; background: var(--app-accent-soft); color: var(--app-accent-strong); }
.header-icon { width: 42px; height: 42px; border-radius: 13px; }
.room-agent-icon[data-kind='claude'] { color: var(--app-warning); background: color-mix(in srgb, var(--app-warning) 13%, var(--app-panel)); }
.room-agent-icon[data-kind='opencode'] { color: var(--app-text); background: var(--app-panel-muted); }
.room-agent-close { width: 28px; height: 28px; border: 0; border-radius: 8px; background: transparent; color: var(--app-text-muted); font-size: 21px; line-height: 1; cursor: pointer; }
.room-agent-close:hover { background: var(--app-panel-muted); }
.room-agent-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 20px 18px; }
.room-agent-workspace { padding: 10px 12px; margin-bottom: 16px; border: 1px solid var(--app-border); border-radius: 11px; background: var(--app-panel-subtle); }
.room-agent-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; font-size: 12px; }
.room-agent-link { padding: 3px 0; border: 0; background: transparent; color: var(--app-accent-strong); font: inherit; cursor: pointer; white-space: nowrap; }
.room-agent-link:hover:not(:disabled) { text-decoration: underline; }
.room-agent-path { display: block; color: var(--app-text-muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; user-select: text; }
.room-agent-list { display: grid; gap: 6px; }
.room-agent-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--app-border); border-radius: 11px; background: var(--app-panel); cursor: pointer; }
.room-agent-row:has(input:not(:disabled)):hover { background: var(--app-panel-subtle); }
.room-agent-row.selected { border-color: color-mix(in srgb, var(--app-accent) 58%, var(--app-border)); background: color-mix(in srgb, var(--app-accent-soft) 52%, var(--app-panel)); }
.room-agent-row.unavailable { opacity: 0.58; cursor: default; }
.room-agent-row input { width: 15px; height: 15px; margin: 0 2px; accent-color: var(--app-accent); }
.room-agent-name { display: grid; gap: 2px; min-width: 0; font-size: 13px; }
.room-agent-name small { overflow: hidden; color: var(--app-text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.room-worker-fields { display: grid; gap: 10px; min-width: 0; margin: 14px 0 0; padding: 0; border: 0; }
.room-worker-label { display: grid; gap: 5px; font-size: 12px; }
.room-worker-label input, .room-worker-label textarea { box-sizing: border-box; width: 100%; padding: 7px 9px; border: 1px solid var(--app-border); border-radius: 9px; background: var(--app-panel); color: var(--app-text); font: inherit; }
.room-worker-label textarea { resize: vertical; }
.room-worker-option { display: flex; align-items: center; gap: 6px; color: var(--app-text-muted); font-size: 12px; }
.room-worker-option input { margin: 0; accent-color: var(--app-accent); }
.room-worker-roster { margin-top: 15px; padding-top: 11px; border-top: 1px solid var(--app-border); }
.room-worker-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 0; }
.worker-remove { color: var(--app-danger); font-size: 12px; }
.room-agent-note, .room-agent-error { margin: 6px 0; color: var(--app-text-muted); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.room-agent-error { color: var(--app-danger); }
.room-agent-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--app-border); }
.room-agent-actions button { min-height: 34px; padding: 0 13px; border: 1px solid var(--app-border-strong); border-radius: 9px; background: var(--app-panel); color: var(--app-text); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.room-agent-actions button:hover:not(:disabled) { background: var(--app-panel-muted); }
.room-agent-actions .room-agent-join { border-color: transparent; background: var(--app-accent); color: var(--app-on-accent); }
.room-agent-actions .room-agent-join:hover:not(:disabled) { background: var(--app-accent-strong); }
.room-agent-dialog button:disabled { opacity: 0.55; cursor: not-allowed; }
.room-agent-dialog :focus-visible { outline: 2px solid var(--app-accent); outline-offset: 2px; }
</style>
