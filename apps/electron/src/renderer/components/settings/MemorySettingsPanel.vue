<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * Top-level Memory settings. Memory is user-level shared data owned by the
 * Rust harness (design §15) — it deliberately lives outside the Agent
 * workspace. This panel offers:
 *  1. Semantic memory (embedding) configuration: provider/model selection
 *     declared under Model Providers, a main-process connection probe, and
 *     the remote-embedding privacy notice.
 *  2. Memory entry management: search, manual add, pin, delete, AI
 *     compaction — all through the shared memory store.
 */

const { t } = useI18n()

interface ProviderEmbeddingModelRow {
  id: string
  dimensions?: number
  distance?: 'cosine' | 'dot' | 'l2'
  enabled?: boolean
}

interface AIProviderLite {
  id: string
  name: string
  baseUrl: string
  embeddingModels?: ProviderEmbeddingModelRow[]
}

type ProviderWithEmbeddingCatalog = { id: string; name: string; baseUrl: string; embeddingModels?: ProviderEmbeddingModelRow[] }

interface MemoryCompactionStatusLite {
  status: string
  stage: string
  detail?: string
  scanned: number
  totalChunks: number
  completedChunks: number
}

const embeddingEnabled = ref(false)
const selectedProviderId = ref('')
const selectedModelId = ref('')
const loadingEmbedding = ref(false)
const savingEmbedding = ref(false)
const embeddingTestState = ref<{ running: boolean; ok?: boolean; dimensions?: number; latencyMs?: number; error?: string } | null>(null)
const providers = ref<AIProviderLite[]>([])
const statusMessage = ref('')

const embeddingProviders = computed(() => providers.value.filter(provider => (provider.embeddingModels || []).length > 0))
const selectedProvider = computed(() => providers.value.find(provider => provider.id === selectedProviderId.value))
const selectedEmbeddingModels = computed(() => selectedProvider.value?.embeddingModels || [])
const selectedModelMeta = computed(() => selectedEmbeddingModels.value.find(model => model.id === selectedModelId.value))

// ---------- memory entries ----------
const memoryScopeOptions: Array<{ value: AgentMemoryScope; labelKey: string }> = [
  { value: 'user', labelKey: 'settings.memory.scopeUser' },
  { value: 'agent', labelKey: 'settings.memory.scopeAgent' },
  { value: 'project', labelKey: 'settings.memory.scopeProject' },
  { value: 'group', labelKey: 'settings.memory.scopeGroup' },
  { value: 'channel', labelKey: 'settings.memory.scopeChannel' }
]
const memoryTypeOptions: Array<{ value: MemoryType; labelKey: string }> = [
  { value: 'knowledge', labelKey: 'settings.memory.typeKnowledge' },
  { value: 'user_trait', labelKey: 'settings.memory.typeUserTrait' },
  { value: 'agent_skill', labelKey: 'settings.memory.typeAgentSkill' },
  { value: 'step', labelKey: 'settings.memory.typeStep' }
]

const memoryEntries = ref<MemoryEntry[]>([])
const memoryQuery = ref('')
const memoryScopeType = ref<AgentMemoryScope>('user')
const memoryScopeId = ref('')
const showMemoryFilters = ref(false)
const addingMemory = ref(false)
const savingMemory = ref(false)
const memoryCompactionStatus = ref<MemoryCompactionStatusLite | null>(null)
const memoryCompactionStarting = ref(false)
const memoryCompacting = computed(() => memoryCompactionStarting.value || memoryCompactionStatus.value?.status === 'running')
let memoryCompactionCleanup: (() => void) | null = null

const draftMemory = reactive({
  title: '',
  summary: '',
  details: '',
  tagsText: '',
  scopeType: 'user' as AgentMemoryScope,
  scopeId: 'local-user',
  memoryType: 'knowledge' as MemoryType,
  pinned: false
})

const hasMemoryScopeFilter = computed(() => memoryScopeId.value.trim().length > 0)
const memoryScopeFilterText = computed(() => {
  if (!hasMemoryScopeFilter.value) return t('settings.memory.allScopes')
  return `${memoryScopeLabel(memoryScopeType.value)} / ${memoryScopeId.value.trim()}`
})
const memoryCompactionProgressText = computed(() => {
  const status = memoryCompactionStatus.value
  if (!status || status.status !== 'running') return ''
  const detail = status.detail ? ` · ${status.detail}` : ''
  return `${status.stage}${detail}`
})

function memoryScopeLabel (value: AgentMemoryScope): string {
  const option = memoryScopeOptions.find(item => item.value === value)
  return option ? t(option.labelKey) : value
}

function memoryTypeLabel (value: MemoryType): string {
  const option = memoryTypeOptions.find(item => item.value === value)
  return option ? t(option.labelKey) : value
}

function setStatus (message: string) {
  statusMessage.value = message
}

function parseMemoryTags (value: string): string[] {
  return value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean)
}

// ---------- memory entries: CRUD ----------
async function loadMemory () {
  if (!window.electronAPI?.listMemory) return
  memoryEntries.value = await window.electronAPI.listMemory({
    query: memoryQuery.value || undefined,
    scopeType: memoryScopeId.value ? memoryScopeType.value : undefined,
    scopeId: memoryScopeId.value || undefined,
    limit: 50
  })
}

function clearMemoryScopeFilter () {
  memoryScopeId.value = ''
  void loadMemory()
}

function resetMemoryDraft () {
  draftMemory.title = ''
  draftMemory.summary = ''
  draftMemory.details = ''
  draftMemory.tagsText = ''
  draftMemory.scopeType = 'user'
  draftMemory.scopeId = 'local-user'
  draftMemory.memoryType = 'knowledge'
  draftMemory.pinned = false
}

function toggleMemoryCreator () {
  addingMemory.value = !addingMemory.value
}

async function saveManualMemory () {
  if (!window.electronAPI?.saveMemory || savingMemory.value) return
  const title = draftMemory.title.trim()
  const summary = draftMemory.summary.trim()
  const scopeId = draftMemory.scopeId.trim()
  if (!title) {
    setStatus(t('settings.memory.requiredTitle'))
    return
  }
  if (!summary) {
    setStatus(t('settings.memory.requiredSummary'))
    return
  }
  savingMemory.value = true
  try {
    await window.electronAPI.saveMemory({
      title,
      summary,
      details: draftMemory.details.trim() || undefined,
      tags: parseMemoryTags(draftMemory.tagsText),
      scopeType: draftMemory.scopeType,
      scopeId: scopeId || 'local-user',
      memoryType: draftMemory.memoryType,
      pinned: draftMemory.pinned,
      importance: draftMemory.pinned ? 0.85 : 0.7,
      confidence: 1
    })
    addingMemory.value = false
    await loadMemory()
    setStatus(t('settings.memory.memoryAdded'))
    resetMemoryDraft()
  } catch (error) {
    setStatus(t('settings.memory.memoryAddFailed', { message: (error as Error).message }))
  } finally {
    savingMemory.value = false
  }
}

async function toggleMemoryPinned (entry: MemoryEntry) {
  if (!window.electronAPI?.pinMemory) return
  try {
    await window.electronAPI.pinMemory(entry.id, !entry.pinned)
    await loadMemory()
  } catch (error) {
    setStatus(t('settings.memory.pinFailed', { message: (error as Error).message }))
  }
}

async function removeMemory (entry: MemoryEntry) {
  if (!window.electronAPI?.deleteMemory) return
  if (!window.confirm(t('settings.memory.deleteConfirm'))) return
  try {
    await window.electronAPI.deleteMemory(entry.id)
    await loadMemory()
  } catch (error) {
    setStatus(t('settings.memory.deleteFailed', { message: (error as Error).message }))
  }
}

// ---------- memory entries: compaction ----------
function formatMemoryCompactionResult (result: { scanned: number; removedUseless: number; merged: number; updated: number; retained: number }): string {
  return t('settings.memory.compactCompleted', {
    scanned: result.scanned,
    removed: result.removedUseless,
    merged: result.merged,
    updated: result.updated,
    retained: result.retained
  })
}

async function syncMemoryCompactionStatus () {
  if (!window.electronAPI?.getMemoryCompactionStatus) return
  memoryCompactionStatus.value = await window.electronAPI.getMemoryCompactionStatus()
}

async function compactMemory () {
  if (!window.electronAPI?.compactMemory || memoryCompacting.value) return
  if (!window.confirm(t('settings.memory.compactConfirm'))) return

  memoryCompactionStarting.value = true
  try {
    const result = await window.electronAPI.compactMemory()
    await loadMemory()
    setStatus(formatMemoryCompactionResult(result))
  } catch (err) {
    setStatus(t('settings.memory.compactFailed', { message: (err as Error).message }))
  } finally {
    memoryCompactionStarting.value = false
    void syncMemoryCompactionStatus()
  }
}

// ---------- embedding settings ----------
async function loadEmbeddingSettings () {
  if (!window.electronAPI?.getMemoryEmbeddingSettings) return
  loadingEmbedding.value = true
  try {
    const settings = await window.electronAPI.getMemoryEmbeddingSettings()
    embeddingEnabled.value = settings.enabled === true
    selectedProviderId.value = settings.providerId || ''
    selectedModelId.value = settings.modelId || ''
  } finally {
    loadingEmbedding.value = false
  }
}

async function loadProviders () {
  if (!window.electronAPI?.getProviders) return
  const config = await window.electronAPI.getProviders()
  providers.value = config.providers.map((provider: ProviderWithEmbeddingCatalog) => ({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    embeddingModels: (provider.embeddingModels || []).map(row => ({ ...row }))
  }))
  // Dangling selection (provider/model deleted) falls back to empty.
  if (selectedProviderId.value && !embeddingProviders.value.some(provider => provider.id === selectedProviderId.value)) {
    selectedProviderId.value = ''
    selectedModelId.value = ''
  }
  if (selectedProviderId.value && selectedModelId.value && !selectedEmbeddingModels.value.some(model => model.id === selectedModelId.value)) {
    selectedModelId.value = ''
  }
}

function onProviderChanged () {
  selectedModelId.value = ''
  embeddingTestState.value = null
}

async function saveEmbeddingSettings () {
  if (!window.electronAPI?.saveMemoryEmbeddingSettings || savingEmbedding.value) return
  if (embeddingEnabled.value && (!selectedProviderId.value || !selectedModelId.value)) {
    setStatus(t('settings.memory.embeddingModelEmpty'))
    return
  }
  savingEmbedding.value = true
  try {
    const saved = await window.electronAPI.saveMemoryEmbeddingSettings({
      enabled: embeddingEnabled.value,
      providerId: selectedProviderId.value || undefined,
      modelId: selectedModelId.value || undefined
    })
    embeddingEnabled.value = saved.enabled === true
    setStatus(t('common.saved'))
  } catch (error) {
    setStatus(t('settings.memory.embeddingSaveFailed', { message: (error as Error).message }))
  } finally {
    savingEmbedding.value = false
  }
}

async function testEmbeddingConnection () {
  if (!window.electronAPI?.testEmbeddingModel || !selectedProviderId.value || !selectedModelId.value) return
  embeddingTestState.value = { running: true }
  try {
    const result = await window.electronAPI.testEmbeddingModel({
      providerId: selectedProviderId.value,
      modelId: selectedModelId.value
    })
    embeddingTestState.value = { running: false, ...result }
  } catch (err) {
    embeddingTestState.value = { running: false, ok: false, error: (err as Error).message }
  }
}

onMounted(async () => {
  await Promise.all([loadEmbeddingSettings(), loadProviders(), loadMemory(), syncMemoryCompactionStatus()])
  if (window.electronAPI?.onMemoryCompactionStatusChanged) {
    memoryCompactionCleanup = window.electronAPI.onMemoryCompactionStatusChanged((status) => {
      memoryCompactionStatus.value = status
    })
  }
})

onUnmounted(() => {
  memoryCompactionCleanup?.()
  memoryCompactionCleanup = null
})
</script>

<template>
  <div class="memory-settings">
    <header class="memory-header">
      <div>
        <h2>{{ $t('settings.memory.title') }}</h2>
        <p>{{ $t('settings.memory.description') }}</p>
      </div>
      <span v-if="statusMessage" class="status-chip">{{ statusMessage }}</span>
    </header>

    <!-- Semantic memory (embedding) -->
    <section class="memory-section">
      <h3>{{ $t('settings.memory.embeddingTitle') }}</h3>
      <p class="section-hint">{{ $t('settings.memory.embeddingDescription') }}</p>

      <div class="pp-toggle-row" @click.prevent="embeddingEnabled = !embeddingEnabled">
        <label>{{ $t('settings.memory.embeddingToggle') }}</label>
        <span :class="['pp-toggle', { on: embeddingEnabled }]"><span class="pp-toggle-thumb" /></span>
      </div>
      <p class="section-hint small">{{ $t('settings.memory.embeddingToggleHint') }}</p>

      <template v-if="embeddingEnabled">
        <div class="embedding-grid">
          <label>
            <span>{{ $t('settings.memory.embeddingProvider') }}</span>
            <select v-model="selectedProviderId" class="input" :disabled="loadingEmbedding" @change="onProviderChanged">
              <option value="" disabled>{{ $t('settings.memory.embeddingProviderPlaceholder') }}</option>
              <option v-for="provider in embeddingProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
            </select>
          </label>
          <label>
            <span>{{ $t('settings.memory.embeddingModel') }}</span>
            <select v-model="selectedModelId" class="input" :disabled="loadingEmbedding || !selectedProviderId">
              <option value="" disabled>{{ selectedProviderId ? $t('settings.memory.embeddingModelEmpty') : $t('settings.memory.embeddingModelPlaceholder') }}</option>
              <option v-for="model in selectedEmbeddingModels" :key="model.id" :value="model.id">{{ model.id }}</option>
            </select>
          </label>
        </div>

        <p v-if="selectedModelMeta" class="section-hint">
          {{ $t('settings.memory.embeddingModelMeta', { dimensions: selectedModelMeta.dimensions ?? '—', distance: selectedModelMeta.distance || 'cosine' }) }}
        </p>

        <div class="embedding-test-row">
          <button
            class="ghost-btn"
            type="button"
            :disabled="!selectedProviderId || !selectedModelId || embeddingTestState?.running"
            @click="testEmbeddingConnection"
          >
            {{ embeddingTestState?.running ? $t('settings.memory.embeddingTesting') : $t('settings.memory.embeddingTestButton') }}
          </button>
          <span
            v-if="embeddingTestState && !embeddingTestState.running"
            :class="['embedding-test-result', embeddingTestState.ok ? 'ok' : 'error']"
          >
            {{ embeddingTestState.ok
              ? $t('settings.memory.embeddingTestOk', { dimensions: embeddingTestState.dimensions, latency: embeddingTestState.latencyMs })
              : $t('settings.memory.embeddingTestFailed', { message: embeddingTestState.error || '' }) }}
          </span>
        </div>

        <div class="privacy-note">
          <strong>{{ $t('settings.memory.embeddingPrivacyTitle') }}</strong>
          <p>{{ $t('settings.memory.embeddingPrivacy') }}</p>
        </div>
      </template>

      <div class="action-row">
        <button class="primary-btn" type="button" :disabled="savingEmbedding || loadingEmbedding" @click="saveEmbeddingSettings">
          {{ savingEmbedding ? $t('common.saving') : $t('common.save') }}
        </button>
      </div>
    </section>

    <!-- Memory entries -->
    <section class="memory-section">
      <h3>{{ $t('settings.memory.entryTitle') }}</h3>
      <p class="section-hint">{{ $t('settings.memory.entryDescription') }}</p>

      <div class="memory-toolbar">
        <input
          v-model="memoryQuery"
          class="input memory-search"
          type="search"
          :placeholder="$t('settings.memory.searchPlaceholder')"
          @keyup.enter="loadMemory"
        >
        <span :class="['memory-filter-pill', { active: hasMemoryScopeFilter }]">{{ memoryScopeFilterText }}</span>
        <button class="primary-btn" type="button" @click="loadMemory">{{ $t('settings.memory.query') }}</button>
        <button :class="['ghost-btn', { active: showMemoryFilters }]" type="button" @click="showMemoryFilters = !showMemoryFilters">{{ $t('settings.memory.filter') }}</button>
        <button class="ghost-btn" type="button" @click="toggleMemoryCreator">{{ addingMemory ? $t('settings.memory.collapseAdd') : $t('settings.memory.manualAdd') }}</button>
        <button class="ghost-btn" :disabled="memoryCompacting" @click="compactMemory">
          {{ memoryCompacting ? $t('settings.memory.compacting') : $t('settings.memory.aiCompact') }}
        </button>
      </div>

      <div v-if="showMemoryFilters" class="memory-filter-row">
        <label>
          <span>{{ $t('settings.memory.scope') }}</span>
          <select v-model="memoryScopeType" class="input memory-scope-select">
            <option v-for="option in memoryScopeOptions" :key="option.value" :value="option.value">{{ $t(option.labelKey) }}</option>
          </select>
        </label>
        <label>
          <span>{{ $t('settings.memory.scopeId') }}</span>
          <input v-model="memoryScopeId" class="input memory-scope-id" placeholder="local-user / agent_xxx / project_xxx" @keyup.enter="loadMemory">
        </label>
        <button class="ghost-btn" type="button" :disabled="!hasMemoryScopeFilter" @click="clearMemoryScopeFilter">{{ $t('settings.memory.all') }}</button>
      </div>

      <form v-if="addingMemory" class="memory-create-card" @submit.prevent="saveManualMemory">
        <div class="memory-create-grid">
          <label>
            <span>{{ $t('settings.memory.memoryTitle') }}</span>
            <input v-model="draftMemory.title" class="input" :placeholder="$t('settings.memory.memoryTitlePlaceholder')">
          </label>
          <label>
            <span>{{ $t('settings.memory.type') }}</span>
            <select v-model="draftMemory.memoryType" class="input">
              <option v-for="option in memoryTypeOptions" :key="option.value" :value="option.value">{{ $t(option.labelKey) }}</option>
            </select>
          </label>
          <label>
            <span>{{ $t('settings.memory.scope') }}</span>
            <select v-model="draftMemory.scopeType" class="input">
              <option v-for="option in memoryScopeOptions" :key="option.value" :value="option.value">{{ $t(option.labelKey) }}</option>
            </select>
          </label>
          <label>
            <span>{{ $t('settings.memory.scopeId') }}</span>
            <input v-model="draftMemory.scopeId" class="input" placeholder="local-user / agent_xxx / project_xxx">
          </label>
          <label class="memory-create-summary">
            <span>{{ $t('settings.memory.summary') }}</span>
            <textarea v-model="draftMemory.summary" class="textarea" rows="2" :placeholder="$t('settings.memory.summaryPlaceholder')" />
          </label>
          <label class="memory-create-summary">
            <span>{{ $t('settings.memory.details') }}</span>
            <textarea v-model="draftMemory.details" class="textarea" rows="3" :placeholder="$t('settings.memory.detailsPlaceholder')" />
          </label>
          <label>
            <span>{{ $t('settings.memory.tags') }}</span>
            <input v-model="draftMemory.tagsText" class="input" :placeholder="$t('settings.memory.tagsPlaceholder')">
          </label>
          <label class="check-row memory-pin-row">
            <input v-model="draftMemory.pinned" type="checkbox">
            <span>{{ $t('settings.memory.pin') }}</span>
          </label>
        </div>
        <div class="action-row memory-create-actions">
          <button class="primary-btn" type="submit" :disabled="savingMemory">{{ savingMemory ? $t('common.saving') : $t('settings.memory.saveEntry') }}</button>
          <button class="ghost-btn" type="button" @click="addingMemory = false">{{ $t('common.cancel') }}</button>
        </div>
      </form>

      <div v-if="memoryCompactionProgressText" class="memory-progress" role="status">
        <span>{{ memoryCompactionProgressText }}</span>
      </div>

      <div class="memory-list">
        <div v-if="memoryEntries.length === 0" class="memory-empty">
          {{ $t('settings.memory.noMatches') }}
        </div>
        <article v-for="entry in memoryEntries" :key="entry.id" class="memory-card">
          <div class="memory-card-head">
            <div>
              <strong>{{ entry.title }}<span v-if="entry.pinned" class="pin-badge"> · {{ $t('settings.memory.entryPinned') }}</span></strong>
              <span>{{ memoryTypeLabel(entry.memoryType) }} · {{ memoryScopeLabel(entry.scopeType) }} / {{ entry.scopeId }}</span>
            </div>
            <div class="memory-actions">
              <button class="ghost-btn small" @click="toggleMemoryPinned(entry)">{{ entry.pinned ? $t('settings.memory.unpin') : $t('settings.memory.pin') }}</button>
              <button class="ghost-btn small danger" @click="removeMemory(entry)">{{ $t('common.delete') }}</button>
            </div>
          </div>
          <p>{{ entry.summary }}</p>
          <p v-if="entry.details" class="memory-details">{{ entry.details }}</p>
          <small>{{ entry.tags.join(', ') }}</small>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.memory-settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  min-height: 0;
  padding: 20px 28px;
  overflow-y: auto;
  color: var(--app-text);
}

.memory-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.memory-header h2 {
  margin: 0 0 6px;
  font-size: 1.05rem;
}

.memory-header p {
  margin: 0;
  color: var(--app-text-soft);
  font-size: 0.9rem;
}

.status-chip {
  padding: 6px 10px;
  border-radius: 999px;
  background: var(--app-accent-soft);
  color: var(--app-accent);
  font-size: 0.8rem;
  white-space: nowrap;
}

.memory-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-panel);
}

.memory-section h3 {
  margin: 0;
  font-size: 0.95rem;
}

.section-hint {
  margin: 0;
  color: var(--app-text-soft);
  font-size: 0.84rem;
  line-height: 1.5;
}

.section-hint.small {
  font-size: 0.78rem;
}

.ghost-btn,
.primary-btn {
  border: 1px solid var(--app-border);
  background: var(--app-panel);
  color: var(--app-text);
  border-radius: 10px;
  padding: 8px 12px;
  cursor: pointer;
}

.primary-btn {
  background: var(--app-accent-soft);
  border-color: var(--app-accent);
  color: var(--app-accent);
}

.ghost-btn.active {
  background: var(--app-accent-soft);
  border-color: color-mix(in srgb, var(--app-accent) 58%, var(--app-border));
  color: var(--app-accent);
}

.ghost-btn:disabled,
.primary-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ghost-btn.small {
  padding: 5px 8px;
  font-size: 0.8rem;
}

.ghost-btn.danger {
  color: #ef4444;
}

.action-row {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.pp-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
}

.pp-toggle-row label {
  font-size: 0.9rem;
}

.pp-toggle {
  position: relative;
  width: 38px;
  height: 22px;
  border-radius: 999px;
  background: var(--app-border);
  transition: background 0.18s ease;
  flex-shrink: 0;
}

.pp-toggle.on {
  background: var(--app-accent);
}

.pp-toggle-thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.18s ease;
}

.pp-toggle.on .pp-toggle-thumb {
  transform: translateX(16px);
}

.embedding-grid {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) minmax(200px, 1.2fr);
  gap: 10px;
}

.embedding-grid label,
.memory-filter-row label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.82rem;
}

.embedding-grid label span,
.memory-filter-row label span {
  color: var(--app-text-soft);
  font-size: 0.78rem;
}

.embedding-test-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.embedding-test-result {
  font-size: 0.8rem;
}

.embedding-test-result.ok {
  color: var(--app-success, #2e9e5b);
}

.embedding-test-result.error {
  color: var(--app-danger, #d64545);
  word-break: break-all;
}

.privacy-note {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, #f59e0b 38%, var(--app-border));
  border-radius: 10px;
  background: color-mix(in srgb, #f59e0b 10%, transparent);
}

.privacy-note strong {
  font-size: 0.82rem;
}

.privacy-note p {
  margin: 0;
  color: var(--app-text-soft);
  font-size: 0.8rem;
  line-height: 1.55;
}

.memory-toolbar {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto auto auto auto auto;
  align-items: center;
  gap: 8px;
}

.memory-filter-pill {
  display: inline-flex;
  align-items: center;
  max-width: 220px;
  min-height: 34px;
  padding: 0 10px;
  border: 1px solid var(--app-border);
  border-radius: 999px;
  background: var(--app-main-surface);
  color: var(--app-text-soft);
  font-size: 0.8rem;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.memory-filter-pill.active {
  border-color: color-mix(in srgb, var(--app-accent) 38%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 48%, var(--app-main-surface));
  color: var(--app-accent);
}

.memory-filter-row {
  display: grid;
  grid-template-columns: minmax(118px, 160px) minmax(220px, 320px) auto;
  align-items: end;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-main-surface);
}

.memory-search,
.memory-scope-id,
.memory-scope-select {
  min-width: 0;
}

.memory-create-card {
  padding: 12px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-main-surface);
}

.memory-create-grid {
  display: grid;
  grid-template-columns: minmax(180px, 1.2fr) minmax(120px, 0.65fr) minmax(120px, 0.65fr) minmax(150px, 1fr);
  gap: 10px;
}

.memory-create-grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.82rem;
}

.memory-create-grid label span {
  color: var(--app-text-soft);
  font-size: 0.78rem;
}

.memory-create-summary {
  grid-column: 1 / -1;
}

.memory-pin-row {
  align-self: end;
  min-height: 38px;
  flex-direction: row !important;
  align-items: center;
  gap: 6px;
}

.memory-create-actions {
  justify-content: flex-end;
  margin-top: 10px;
}

.memory-progress {
  display: flex;
  align-items: center;
  min-height: 34px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 26%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 38%, transparent);
  color: var(--app-text-soft);
  font-size: 0.82rem;
}

.memory-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.memory-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 96px;
  border: 1px dashed var(--app-border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-main-surface) 68%, transparent);
  color: var(--app-text-soft);
  font-size: 0.86rem;
}

.memory-card {
  border: 1px solid var(--app-border);
  border-radius: 12px;
  padding: 12px;
  background: var(--app-main-surface);
}

.memory-card-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.memory-card-head span,
.memory-card small {
  display: block;
  margin-top: 4px;
  color: var(--app-text-soft);
}

.memory-card p {
  margin: 10px 0 0;
  color: var(--app-text);
}

.memory-card .memory-details {
  margin-top: 6px;
  color: var(--app-text-soft);
  font-size: 0.82rem;
  line-height: 1.5;
  white-space: pre-wrap;
}

.memory-actions {
  display: flex;
  gap: 8px;
}

.pin-badge {
  color: var(--app-accent);
}

.textarea {
  min-height: 60px;
  resize: vertical;
}

@media (max-width: 1100px) {
  .memory-filter-row,
  .memory-create-grid {
    grid-template-columns: 1fr 1fr;
  }

  .memory-create-summary {
    grid-column: 1 / -1;
  }
}
</style>
