<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

interface MCPServerDraft {
  id: string
  name: string
  enabled: boolean
  transport: MCPTransportType
  command: string
  argsText: string
  cwd: string
  envText: string
  url: string
  headersText: string
  timeoutMs: number
}

const DEFAULT_TIMEOUT_MS = 15000
const FEEDBACK_DISPLAY_DURATION_MS = 2400
const { t, locale } = useI18n()

const servers = ref<MCPServerConfig[]>([])
const state = ref<MCPStateSnapshot>({ servers: [], updatedAt: new Date().toISOString() })
const selectedServerId = ref('')
const editing = ref(false)
const draft = ref<MCPServerDraft | null>(null)
const saving = ref(false)
const refreshing = ref(false)
const statusMessage = ref('')

let cleanupMcpState: (() => void) | null = null
let statusTimer: number | null = null

const stateMap = computed(() => {
  return state.value.servers.reduce<Record<string, MCPServerSnapshot>>((acc, item) => {
    acc[item.id] = item
    return acc
  }, {})
})

const selectedConfig = computed(() => {
  return servers.value.find(server => server.id === selectedServerId.value) || null
})

const selectedSnapshot = computed(() => {
  return stateMap.value[selectedServerId.value] || null
})

const serverCards = computed(() => {
  return servers.value.map(server => ({
    config: server,
    snapshot: stateMap.value[server.id] || null
  }))
})

const detailStats = computed(() => {
  const snapshot = selectedSnapshot.value
  return {
    tools: snapshot?.tools.length || 0,
    resources: snapshot?.resources.length || 0,
    prompts: snapshot?.prompts.length || 0
  }
})

// A server with a live (or in-flight) transport offers "disconnect"; any other
// state offers "connect" so the user can bring it back without editing config.
const selectedIsLive = computed(() => {
  const status = selectedSnapshot.value?.status
  return status === 'connected' || status === 'connecting'
})

const busy = computed(() => saving.value || refreshing.value)

onMounted(async () => {
  await loadData()
  if (window.electronAPI?.onMcpStateChanged) {
    cleanupMcpState = window.electronAPI.onMcpStateChanged((nextState) => {
      state.value = nextState
    })
  }
})

onUnmounted(() => {
  cleanupMcpState?.()
  if (statusTimer != null) {
    window.clearTimeout(statusTimer)
  }
})

function scheduleStatusClear () {
  if (statusTimer != null) {
    window.clearTimeout(statusTimer)
  }
  statusTimer = window.setTimeout(() => {
    statusMessage.value = ''
  }, FEEDBACK_DISPLAY_DURATION_MS)
}

function setStatus (message: string) {
  statusMessage.value = message
  scheduleStatusClear()
}

function statusLabel (value?: MCPServerSnapshot['status']): string {
  switch (value) {
    case 'connected': return t('settings.mcp.statusConnected')
    case 'connecting': return t('settings.mcp.statusConnecting')
    case 'error': return t('settings.mcp.statusError')
    default: return t('settings.mcp.statusDisconnected')
  }
}

function statusClass (value?: MCPServerSnapshot['status']): string {
  switch (value) {
    case 'connected': return 'is-connected'
    case 'connecting': return 'is-connecting'
    case 'error': return 'is-error'
    default: return 'is-disconnected'
  }
}

function sortServers () {
  servers.value = [...servers.value].sort((left, right) => left.name.localeCompare(right.name, locale.value))
}

function mergeServerSnapshot (snapshot: MCPServerSnapshot) {
  state.value = {
    ...state.value,
    updatedAt: new Date().toISOString(),
    servers: state.value.servers
      .filter(server => server.id !== snapshot.id)
      .concat(snapshot)
      .sort((left, right) => left.name.localeCompare(right.name, locale.value))
  }
}

function encodeArgs (args: string[]): string {
  return args.join('\n')
}

function parseArgs (value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean)
}

function encodeMap (value: Record<string, string>): string {
  return Object.entries(value)
    .map(([key, entry]) => `${key}=${entry}`)
    .join('\n')
}

function parseMap (value: string): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const separatorIndex = line.indexOf('=')
    const key = (separatorIndex >= 0 ? line.slice(0, separatorIndex) : line).trim()
    if (!key) continue
    const entry = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : ''
    normalized[key] = entry
  }
  return normalized
}

function buildDraft (server?: MCPServerConfig | null): MCPServerDraft {
  if (!server) {
    return {
      id: `mcp_${Date.now().toString(36)}`,
      name: '',
      enabled: true,
      transport: 'stdio',
      command: '',
      argsText: '',
      cwd: '',
      envText: '',
      url: '',
      headersText: '',
      timeoutMs: DEFAULT_TIMEOUT_MS
    }
  }

  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command,
    argsText: encodeArgs(server.args),
    cwd: server.cwd,
    envText: encodeMap(server.env),
    url: server.url,
    headersText: encodeMap(server.headers),
    timeoutMs: server.timeoutMs
  }
}

function materializeDraft (value: MCPServerDraft): MCPServerConfig {
  return {
    id: value.id,
    name: value.name.trim(),
    enabled: value.enabled,
    transport: value.transport,
    command: value.command.trim(),
    args: parseArgs(value.argsText),
    cwd: value.cwd.trim(),
    env: parseMap(value.envText),
    url: value.url.trim(),
    headers: parseMap(value.headersText),
    timeoutMs: Number.isFinite(Number(value.timeoutMs)) && Number(value.timeoutMs) >= 1000
      ? Math.floor(Number(value.timeoutMs))
      : DEFAULT_TIMEOUT_MS
  }
}

async function loadData () {
  if (!window.electronAPI?.getMcpServers || !window.electronAPI?.getMcpState) return

  try {
    const [savedServers, mcpState] = await Promise.all([
      window.electronAPI.getMcpServers(),
      window.electronAPI.getMcpState()
    ])

    servers.value = savedServers
    sortServers()
    state.value = mcpState
    if (servers.value.length > 0 && !servers.value.some(server => server.id === selectedServerId.value)) {
      selectedServerId.value = servers.value[0].id
    }
    if (servers.value.length === 0) {
      selectedServerId.value = ''
    }
  } catch (error) {
    setStatus(t('settings.mcp.loadFailed', { message: (error as Error).message }))
  }
}

function selectServer (serverId: string) {
  if (editing.value) return
  selectedServerId.value = serverId
}

function startAdd () {
  editing.value = true
  draft.value = buildDraft(null)
  selectedServerId.value = draft.value.id
}

function startEdit () {
  if (!selectedConfig.value) return
  editing.value = true
  draft.value = buildDraft(selectedConfig.value)
}

function cancelEdit () {
  if (draft.value && !servers.value.some(server => server.id === draft.value?.id)) {
    selectedServerId.value = servers.value[0]?.id || ''
  }
  editing.value = false
  draft.value = null
}

async function persistServers (successMessage: string): Promise<boolean> {
  if (!window.electronAPI?.saveMcpServers || !window.electronAPI?.getMcpState) return false

  saving.value = true
  try {
    await window.electronAPI.saveMcpServers(JSON.parse(JSON.stringify(servers.value)))
    state.value = await window.electronAPI.getMcpState()
    setStatus(successMessage)
    return true
  } catch (error) {
    setStatus(t('settings.mcp.saveFailed', { message: (error as Error).message }))
    return false
  } finally {
    saving.value = false
  }
}

/**
 * Flip the selected server's enabled flag directly from the detail header.
 * Saving runs the same path as the editor: the main process re-applies the
 * catalog, which disconnects a disabled server or (re)connects an enabled one.
 */
async function toggleSelectedEnabled () {
  const server = selectedConfig.value
  if (!server || busy.value) return

  const nextEnabled = !server.enabled
  servers.value = servers.value.map(item => item.id === server.id ? { ...item, enabled: nextEnabled } : item)
  const persisted = await persistServers(t(nextEnabled ? 'settings.mcp.enabledOne' : 'settings.mcp.disabledOne', { name: server.name }))
  if (!persisted) {
    servers.value = servers.value.map(item => item.id === server.id ? { ...item, enabled: server.enabled } : item)
  }
}

async function saveDraft () {
  if (!draft.value) return

  const nextServer = materializeDraft(draft.value)
  if (!nextServer.name) {
    setStatus(t('settings.mcp.requiredName'))
    return
  }
  if (nextServer.transport === 'stdio' && !nextServer.command) {
    setStatus(t('settings.mcp.requiredCommand'))
    return
  }
  if (nextServer.transport !== 'stdio' && !nextServer.url) {
    setStatus(t('settings.mcp.requiredUrl'))
    return
  }

  const index = servers.value.findIndex(server => server.id === nextServer.id)
  if (index >= 0) {
    servers.value[index] = nextServer
  } else {
    servers.value.push(nextServer)
  }

  sortServers()
  selectedServerId.value = nextServer.id
  editing.value = false
  draft.value = null
  await persistServers(t('settings.mcp.saved'))
}

async function deleteSelected () {
  const server = selectedConfig.value
  if (!server) return
  if (!window.confirm(t('settings.mcp.deleteConfirm', { name: server.name }))) return

  servers.value = servers.value.filter(item => item.id !== server.id)
  if (selectedServerId.value === server.id) {
    selectedServerId.value = servers.value[0]?.id || ''
  }
  editing.value = false
  draft.value = null
  await persistServers(t('settings.mcp.deleted'))
}

async function refreshSelected () {
  if (!window.electronAPI?.refreshMcpServer) return
  refreshing.value = true
  try {
    const serverId = editing.value ? draft.value?.id : selectedServerId.value
    const result = await window.electronAPI.refreshMcpServer(serverId || undefined)
    if ('servers' in result) {
      state.value = result
      setStatus(t('settings.mcp.refreshedAll'))
    } else {
      mergeServerSnapshot(result)
      setStatus(t('settings.mcp.refreshedOne', { name: result.name }))
    }
  } catch (error) {
    setStatus(t('settings.mcp.refreshFailed', { message: (error as Error).message }))
  } finally {
    refreshing.value = false
  }
}

/**
 * Reconnect the selected server without touching its saved config. Both
 * harnesses expose this as a per-server refresh, and both keep a failed
 * connection as an `error` snapshot instead of throwing, so surface that here.
 */
async function connectSelected () {
  const server = selectedConfig.value
  if (!window.electronAPI?.refreshMcpServer || !server || !server.enabled) return
  refreshing.value = true
  try {
    const result = await window.electronAPI.refreshMcpServer(server.id)
    if ('servers' in result) {
      state.value = result
    } else {
      mergeServerSnapshot(result)
    }
    const snapshot = stateMap.value[server.id]
    if (snapshot?.status === 'error') {
      setStatus(t('settings.mcp.connectFailed', { message: snapshot.error || t('settings.mcp.statusError') }))
    } else {
      setStatus(t('settings.mcp.connected', { name: server.name }))
    }
  } catch (error) {
    setStatus(t('settings.mcp.connectFailed', { message: (error as Error).message }))
  } finally {
    refreshing.value = false
  }
}

async function disconnectSelected () {
  if (!window.electronAPI?.disconnectMcpServer || !selectedConfig.value) return
  refreshing.value = true
  try {
    const snapshot = await window.electronAPI.disconnectMcpServer(selectedConfig.value.id)
    mergeServerSnapshot(snapshot)
    setStatus(t('settings.mcp.disconnected', { name: snapshot.name }))
  } catch (error) {
    setStatus(t('settings.mcp.disconnectFailed', { message: (error as Error).message }))
  } finally {
    refreshing.value = false
  }
}

function formatTimestamp (value?: string | null): string {
  if (!value) return t('settings.mcp.neverRefreshed')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(locale.value)
}
</script>

<template>
  <div class="mcp-root">
    <aside class="mcp-sidebar">
      <div class="mcp-sidebar-header">
        <div>
          <h3>{{ $t('settings.mcp.title') }}</h3>
        </div>
        <div class="mcp-sidebar-actions">
          <button class="ghost-btn" type="button" @click="refreshSelected" :disabled="refreshing">
            {{ refreshing ? $t('settings.mcp.refreshing') : $t('settings.mcp.refresh') }}
          </button>
          <button class="primary-btn" type="button" @click="startAdd">{{ $t('settings.mcp.add') }}</button>
        </div>
      </div>

      <div v-if="serverCards.length === 0" class="mcp-empty-list">
        {{ $t('settings.mcp.emptyList') }}
      </div>

      <button
        v-for="item in serverCards"
        :key="item.config.id"
        type="button"
        class="mcp-server-card"
        :class="{ active: selectedServerId === item.config.id }"
        @click="selectServer(item.config.id)"
      >
        <div class="mcp-server-card-top">
          <span class="mcp-status-dot" :class="statusClass(item.snapshot?.status)" />
          <div class="mcp-server-card-titles">
            <strong>{{ item.config.name }}</strong>
            <span>{{ item.config.transport }} · {{ item.config.enabled ? $t('settings.mcp.enabled') : $t('settings.mcp.disabled') }}</span>
          </div>
        </div>
        <div class="mcp-server-card-bottom">
          <span>{{ statusLabel(item.snapshot?.status) }}</span>
          <span>{{ $t('settings.mcp.toolsCount', { count: item.snapshot?.tools.length || 0 }) }}</span>
          <span>{{ $t('settings.mcp.resourcesCount', { count: item.snapshot?.resources.length || 0 }) }}</span>
          <span>{{ $t('settings.mcp.promptsCount', { count: item.snapshot?.prompts.length || 0 }) }}</span>
        </div>
      </button>
    </aside>

    <section class="mcp-main">
      <div class="mcp-main-header">
        <div>
          <h3>{{ editing ? (draft?.name || $t('settings.mcp.addTitle')) : (selectedConfig?.name || $t('settings.mcp.manageTitle')) }}</h3>
        </div>

        <div class="mcp-main-actions" v-if="!editing && selectedConfig">
          <button
            class="mcp-switch"
            type="button"
            role="switch"
            :aria-checked="selectedConfig.enabled"
            :aria-label="selectedConfig.enabled ? $t('settings.mcp.disableServer') : $t('settings.mcp.enableServer')"
            :title="selectedConfig.enabled ? $t('settings.mcp.disableServer') : $t('settings.mcp.enableServer')"
            :disabled="busy"
            @click="toggleSelectedEnabled"
          >
            <span class="mcp-switch-track" :class="{ on: selectedConfig.enabled }">
              <span class="mcp-switch-thumb" />
            </span>
            <span class="mcp-switch-label">{{ selectedConfig.enabled ? $t('settings.mcp.enabled') : $t('settings.mcp.disabled') }}</span>
          </button>
          <button class="ghost-btn" type="button" @click="startEdit">{{ $t('settings.mcp.edit') }}</button>
          <button
            v-if="selectedIsLive"
            class="ghost-btn"
            type="button"
            @click="disconnectSelected"
            :disabled="busy"
          >{{ $t('settings.mcp.disconnect') }}</button>
          <button
            v-else
            class="ghost-btn"
            type="button"
            @click="connectSelected"
            :disabled="busy || !selectedConfig.enabled"
            :title="selectedConfig.enabled ? '' : $t('settings.mcp.connectRequiresEnabled')"
          >{{ $t('settings.mcp.connect') }}</button>
          <button class="danger-btn" type="button" @click="deleteSelected" :disabled="busy">{{ $t('common.delete') }}</button>
        </div>
      </div>

      <p v-if="statusMessage" class="mcp-feedback">{{ statusMessage }}</p>

      <div v-if="editing && draft" class="mcp-editor-card">
        <div class="mcp-form-grid">
          <label class="mcp-field">
            <span>{{ $t('settings.mcp.name') }}</span>
            <input v-model="draft.name" type="text" :placeholder="$t('settings.mcp.namePlaceholder')" />
          </label>

          <label class="mcp-field">
            <span>{{ $t('settings.mcp.transport') }}</span>
            <select v-model="draft.transport">
              <option value="stdio">stdio</option>
              <option value="streamable-http">streamable-http</option>
              <option value="sse">sse</option>
            </select>
          </label>

          <label class="mcp-field checkbox-field">
            <input v-model="draft.enabled" type="checkbox" />
            <span>{{ $t('settings.mcp.enableServer') }}</span>
          </label>

          <label class="mcp-field">
            <span>{{ $t('settings.mcp.timeoutMs') }}</span>
            <input v-model.number="draft.timeoutMs" type="number" min="1000" step="1000" />
          </label>

          <template v-if="draft.transport === 'stdio'">
            <label class="mcp-field full-span">
              <span>{{ $t('settings.mcp.command') }}</span>
              <input v-model="draft.command" type="text" :placeholder="$t('settings.mcp.commandPlaceholder')" />
            </label>

            <label class="mcp-field full-span">
              <span>{{ $t('settings.mcp.cwd') }}</span>
              <input v-model="draft.cwd" type="text" :placeholder="$t('settings.mcp.cwdPlaceholder')" />
            </label>

            <label class="mcp-field full-span">
              <span>{{ $t('settings.mcp.args') }}</span>
              <textarea v-model="draft.argsText" rows="5" :placeholder="$t('settings.mcp.argsPlaceholder')" />
            </label>

            <label class="mcp-field full-span">
              <span>{{ $t('settings.mcp.env') }}</span>
              <textarea v-model="draft.envText" rows="5" :placeholder="$t('settings.mcp.envPlaceholder')" />
            </label>
          </template>

          <template v-else>
            <label class="mcp-field full-span">
              <span>{{ $t('settings.mcp.url') }}</span>
              <input v-model="draft.url" type="url" :placeholder="$t('settings.mcp.urlPlaceholder')" />
            </label>

            <label class="mcp-field full-span">
              <span>{{ $t('settings.mcp.headers') }}</span>
              <textarea v-model="draft.headersText" rows="5" :placeholder="$t('settings.mcp.headersPlaceholder')" />
            </label>
          </template>
        </div>

        <div class="mcp-editor-actions">
          <button class="ghost-btn" type="button" @click="cancelEdit">{{ $t('common.cancel') }}</button>
          <button class="primary-btn" type="button" @click="saveDraft" :disabled="saving">
            {{ saving ? $t('common.saving') : $t('settings.mcp.saveAndConnect') }}
          </button>
        </div>
      </div>

      <div v-else-if="selectedConfig" class="mcp-detail-grid">
        <section class="mcp-summary-card">
          <div class="mcp-summary-head">
            <div class="mcp-summary-title">
              <span class="mcp-pill" :class="statusClass(selectedSnapshot?.status)">
                {{ statusLabel(selectedSnapshot?.status) }}
              </span>
              <strong>{{ selectedConfig.name }}</strong>
            </div>
            <span class="mcp-updated-at">{{ $t('settings.mcp.lastRefresh', { time: formatTimestamp(selectedSnapshot?.updatedAt) }) }}</span>
          </div>

          <div class="mcp-summary-grid">
            <div class="mcp-metric">
              <span>{{ $t('settings.mcp.transport') }}</span>
              <strong>{{ selectedConfig.transport }}</strong>
            </div>
            <div class="mcp-metric">
              <span>{{ $t('settings.mcp.enabledStatus') }}</span>
              <strong>{{ selectedConfig.enabled ? $t('settings.mcp.enable') : $t('settings.mcp.disable') }}</strong>
            </div>
            <div class="mcp-metric">
              <span>{{ $t('settings.mcp.tools') }}</span>
              <strong>{{ detailStats.tools }}</strong>
            </div>
            <div class="mcp-metric">
              <span>{{ $t('settings.mcp.resources') }}</span>
              <strong>{{ detailStats.resources }}</strong>
            </div>
            <div class="mcp-metric">
              <span>{{ $t('settings.mcp.prompts') }}</span>
              <strong>{{ detailStats.prompts }}</strong>
            </div>
            <div class="mcp-metric">
              <span>{{ $t('settings.mcp.timeout') }}</span>
              <strong>{{ selectedConfig.timeoutMs }}ms</strong>
            </div>
          </div>

          <div class="mcp-config-preview">
            <span v-if="selectedConfig.transport === 'stdio'">
              <strong>{{ $t('settings.mcp.commandShort') }}</strong>
              <code>{{ selectedConfig.command || $t('settings.mcp.notSet') }}</code>
            </span>
            <span v-if="selectedConfig.transport === 'stdio'">
              <strong>{{ $t('settings.mcp.argsShort') }}</strong>
              <code>{{ selectedConfig.args.join(' ') || $t('settings.mcp.none') }}</code>
            </span>
            <span v-if="selectedConfig.transport !== 'stdio'">
              <strong>{{ $t('settings.mcp.urlShort') }}</strong>
              <code>{{ selectedConfig.url || $t('settings.mcp.notSet') }}</code>
            </span>
          </div>

          <div v-if="selectedSnapshot?.error" class="mcp-error-box">
            {{ selectedSnapshot.error }}
          </div>
        </section>

        <section class="mcp-list-card mcp-tools-card">
          <div class="mcp-list-card-head">
            <h4>{{ $t('settings.mcp.tools') }}</h4>
            <span>{{ detailStats.tools }}</span>
          </div>
          <div v-if="(selectedSnapshot?.tools.length || 0) === 0" class="mcp-empty-block">{{ $t('settings.mcp.emptyTools') }}</div>
          <div v-else class="mcp-entry-list">
            <div v-for="tool in selectedSnapshot?.tools || []" :key="tool.localName" class="mcp-entry mcp-tool-entry">
              <strong class="mcp-tool-name">{{ tool.name }}</strong>
              <code class="mcp-tool-local-name">{{ tool.localName }}</code>
              <p class="mcp-tool-description">{{ tool.description || $t('settings.mcp.noDescription') }}</p>
            </div>
          </div>
        </section>

        <section class="mcp-list-card">
          <div class="mcp-list-card-head">
            <h4>{{ $t('settings.mcp.resources') }}</h4>
            <span>{{ detailStats.resources }}</span>
          </div>
          <div v-if="(selectedSnapshot?.resources.length || 0) === 0" class="mcp-empty-block">{{ $t('settings.mcp.emptyResources') }}</div>
          <div v-else class="mcp-entry-list">
            <div v-for="resource in selectedSnapshot?.resources || []" :key="resource.uri" class="mcp-entry">
              <div class="mcp-entry-title-row">
                <strong>{{ resource.name }}</strong>
                <code>{{ resource.uri }}</code>
              </div>
              <p>{{ resource.description || resource.mimeType || $t('settings.mcp.noDescription') }}</p>
            </div>
          </div>
        </section>

        <section class="mcp-list-card">
          <div class="mcp-list-card-head">
            <h4>{{ $t('settings.mcp.prompts') }}</h4>
            <span>{{ detailStats.prompts }}</span>
          </div>
          <div v-if="(selectedSnapshot?.prompts.length || 0) === 0" class="mcp-empty-block">{{ $t('settings.mcp.emptyPrompts') }}</div>
          <div v-else class="mcp-entry-list">
            <div v-for="prompt in selectedSnapshot?.prompts || []" :key="prompt.name" class="mcp-entry">
              <div class="mcp-entry-title-row">
                <strong>{{ prompt.name }}</strong>
                <span>{{ $t('settings.mcp.argsCount', { count: prompt.arguments.length }) }}</span>
              </div>
              <p>{{ prompt.description || $t('settings.mcp.noDescription') }}</p>
              <div v-if="prompt.arguments.length > 0" class="mcp-arg-list">
                <span v-for="arg in prompt.arguments" :key="arg.name" class="mcp-arg-pill">
                  {{ arg.name }}<template v-if="arg.required">*</template>
                </span>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div v-else class="mcp-empty-main">
        {{ $t('settings.mcp.selectHint') }}
      </div>
    </section>
  </div>
</template>

<style scoped>
.mcp-root {
  display: flex;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background:
    radial-gradient(circle at top left, rgba(34, 197, 94, 0.08), transparent 28%),
    linear-gradient(180deg, var(--app-main-surface), var(--app-panel-subtle));
}

.mcp-root,
.mcp-root * {
  box-sizing: border-box;
}

.mcp-sidebar {
  width: clamp(260px, 28%, 300px);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 14px;
  border-right: 1px solid var(--app-border);
  overflow-y: auto;
}

.mcp-sidebar-header,
.mcp-main-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.mcp-sidebar-header > div:first-child,
.mcp-main-header > div:first-child {
  min-width: 0;
}

.mcp-sidebar-header h3,
.mcp-main-header h3,
.mcp-list-card-head h4,
.mcp-summary-head h4 {
  margin: 0;
  font-size: 1rem;
  color: var(--app-text);
}

.mcp-sidebar-header h3,
.mcp-main-header h3 {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mcp-sidebar-header p,
.mcp-main-header p,
.mcp-entry p,
.mcp-empty-list,
.mcp-empty-main,
.mcp-empty-block,
.mcp-server-card-titles span,
.mcp-server-card-bottom,
.mcp-updated-at,
.mcp-config-preview,
.mcp-metric span {
  margin: 4px 0 0;
  color: var(--app-text-soft);
  font-size: 0.82rem;
  line-height: 1.5;
}

.mcp-sidebar-actions,
.mcp-main-actions,
.mcp-editor-actions {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 8px;
}

.primary-btn,
.ghost-btn,
.danger-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  min-width: 52px;
  min-height: 32px;
  padding: 6px 10px;
  font-size: 0.82rem;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: transform 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}

.primary-btn {
  color: #f7fef9;
  background: linear-gradient(135deg, #16803c, #22c55e);
  border-color: transparent;
}

.ghost-btn {
  color: var(--app-text);
  background: rgba(255, 255, 255, 0.02);
}

.danger-btn {
  color: #b91c1c;
  background: rgba(185, 28, 28, 0.08);
  border-color: rgba(185, 28, 28, 0.18);
}

.primary-btn:hover,
.ghost-btn:hover,
.danger-btn:hover,
.mcp-server-card:hover {
  transform: translateY(-1px);
}

.primary-btn:disabled,
.ghost-btn:disabled,
.danger-btn:disabled {
  cursor: not-allowed;
  opacity: 0.65;
  transform: none;
}

.mcp-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  min-height: 32px;
  padding: 0 4px;
  border: none;
  background: transparent;
  color: var(--app-text-soft);
  font-size: 0.82rem;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}

.mcp-switch:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.mcp-switch-track {
  position: relative;
  width: 38px;
  height: 22px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid var(--app-border);
  transition: background 0.16s ease, border-color 0.16s ease;
}

.mcp-switch-track.on {
  background: #22c55e;
  border-color: transparent;
}

.mcp-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: transform 0.16s ease;
}

.mcp-switch-track.on .mcp-switch-thumb {
  transform: translateX(16px);
}

.mcp-switch-track.on + .mcp-switch-label {
  color: var(--app-text);
}

.mcp-server-card {
  width: 100%;
  min-width: 0;
  padding: 12px;
  border-radius: 16px;
  border: 1px solid var(--app-border);
  background: rgba(255, 255, 255, 0.03);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease, transform 0.12s ease;
}

.mcp-server-card.active {
  border-color: rgba(34, 197, 94, 0.45);
  background: rgba(34, 197, 94, 0.08);
}

.mcp-server-card-top,
.mcp-entry-title-row,
.mcp-list-card-head,
.mcp-summary-head {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.mcp-server-card-top {
  align-items: center;
}

.mcp-server-card-titles {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.mcp-server-card-titles strong,
.mcp-server-card-titles span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcp-server-card-bottom {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
}

.mcp-status-dot,
.mcp-pill::before {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  display: inline-block;
  flex-shrink: 0;
}

.mcp-status-dot.is-connected,
.mcp-pill.is-connected::before {
  background: #16a34a;
}

.mcp-status-dot.is-connecting,
.mcp-pill.is-connecting::before {
  background: #eab308;
}

.mcp-status-dot.is-error,
.mcp-pill.is-error::before {
  background: #dc2626;
}

.mcp-status-dot.is-disconnected,
.mcp-pill.is-disconnected::before {
  background: #64748b;
}

.mcp-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  overflow: hidden;
}

.mcp-feedback,
.mcp-error-box,
.mcp-empty-main,
.mcp-empty-list,
.mcp-empty-block,
.mcp-editor-card,
.mcp-summary-card,
.mcp-list-card {
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(10px);
}

.mcp-feedback,
.mcp-error-box,
.mcp-empty-main,
.mcp-empty-list,
.mcp-empty-block {
  padding: 12px 14px;
}

.mcp-feedback {
  margin: 0;
  color: #166534;
  background: rgba(34, 197, 94, 0.1);
  border-color: rgba(34, 197, 94, 0.2);
}

.mcp-editor-card,
.mcp-summary-card,
.mcp-list-card {
  padding: 14px;
  min-width: 0;
}

.mcp-editor-card {
  min-height: 0;
  overflow-y: auto;
}

.mcp-form-grid,
.mcp-detail-grid {
  display: grid;
  gap: 12px;
}

.mcp-form-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.mcp-detail-grid {
  flex: 1;
  min-width: 0;
  min-height: 0;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
  grid-template-rows: auto minmax(0, 1fr) minmax(0, 1fr);
  align-items: stretch;
}

.mcp-summary-card {
  grid-column: 1 / -1;
}

.mcp-list-card {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.mcp-tools-card {
  grid-row: 2 / 4;
}

.mcp-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 0.84rem;
  color: var(--app-text);
}

.mcp-field input,
.mcp-field select,
.mcp-field textarea {
  width: 100%;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--app-border);
  background: rgba(15, 23, 42, 0.28);
  color: var(--app-text);
  font: inherit;
}

.mcp-field textarea {
  resize: vertical;
}

.full-span {
  grid-column: 1 / -1;
}

.checkbox-field {
  justify-content: center;
  flex-direction: row;
  align-items: center;
  gap: 10px;
}

.checkbox-field input {
  width: auto;
}

.mcp-editor-actions {
  justify-content: flex-end;
  margin-top: 18px;
}

.mcp-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 9px;
  border-radius: 999px;
  font-size: 0.75rem;
  color: var(--app-text-soft);
  background: rgba(255, 255, 255, 0.05);
}

.mcp-summary-head {
  align-items: center;
  flex-wrap: wrap;
}

.mcp-summary-title {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.mcp-updated-at {
  min-width: 0;
  text-align: right;
  overflow-wrap: anywhere;
}

.mcp-summary-title strong {
  min-width: 0;
  color: var(--app-text);
  font-size: 0.95rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mcp-summary-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.mcp-metric {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
  padding: 6px 9px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.04);
}

.mcp-metric span {
  margin: 0;
  line-height: 1.2;
}

.mcp-metric strong,
.mcp-config-preview strong,
.mcp-entry strong {
  color: var(--app-text);
}

.mcp-config-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.mcp-config-preview span {
  min-width: 0;
  max-width: 100%;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.025);
}

.mcp-config-preview code {
  min-width: 0;
  color: var(--app-text-soft);
  font-size: 0.76rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mcp-error-box {
  margin-top: 10px;
  color: #b91c1c;
  background: rgba(185, 28, 28, 0.08);
  border-color: rgba(185, 28, 28, 0.18);
}

.mcp-entry {
  min-width: 0;
  padding: 12px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}

.mcp-list-card-head {
  flex: 0 0 auto;
  padding-bottom: 10px;
}

.mcp-entry-title-row {
  flex-wrap: wrap;
}

.mcp-entry-title-row strong,
.mcp-entry-title-row code {
  min-width: 0;
  max-width: 100%;
}

.mcp-entry-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding-right: 6px;
  scrollbar-width: thin;
  scrollbar-color: var(--app-scrollbar) transparent;
}

.mcp-entry-list::-webkit-scrollbar {
  width: 6px;
}

.mcp-entry-list::-webkit-scrollbar-track {
  background: transparent;
}

.mcp-entry-list::-webkit-scrollbar-thumb {
  background: var(--app-scrollbar);
  border-radius: 999px;
}

.mcp-entry-list .mcp-entry:first-child {
  border-top: none;
  padding-top: 0;
}

.mcp-tool-entry {
  display: grid;
  gap: 7px;
}

.mcp-tool-name {
  display: block;
  font-size: 0.95rem;
  line-height: 1.25;
  word-break: break-word;
}

.mcp-tool-local-name {
  display: block;
  width: fit-content;
  max-width: 100%;
}

.mcp-entry .mcp-tool-description {
  margin: 0;
}

.mcp-entry code {
  font-size: 0.72rem;
  color: var(--app-text-soft);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.mcp-entry p {
  overflow-wrap: anywhere;
}

.mcp-arg-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.mcp-arg-pill {
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(34, 197, 94, 0.08);
  color: var(--app-text-soft);
  font-size: 0.75rem;
}

@media (max-width: 1100px) {
  .mcp-root {
    flex-direction: column;
  }

  .mcp-sidebar {
    width: 100%;
    max-height: 34vh;
    border-right: none;
    border-bottom: 1px solid var(--app-border);
  }

  .mcp-main {
    overflow-y: auto;
  }

  .mcp-detail-grid,
  .mcp-form-grid,
  .mcp-summary-grid {
    grid-template-columns: 1fr;
  }

  .mcp-detail-grid {
    flex: 0 0 auto;
    grid-template-rows: none;
  }

  .mcp-tools-card {
    grid-row: auto;
  }

  .mcp-list-card {
    max-height: 360px;
  }
}
</style>
