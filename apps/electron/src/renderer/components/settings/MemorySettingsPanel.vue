<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderMarkdown } from '../chat/markdown'
import { semanticMemoryPhase } from '../../utils/memory-index-state.js'
import { hasAdditionalMemoryDetails } from '../../utils/memory-card-content.js'
import type { MemoryEmbeddingSettings, MemoryIndexStatus } from '../../../shared/agent-workspace-types.js'

/**
 * User-level shared memory is owned by the Rust harness. This panel keeps the
 * configuration, curation, and compaction controls in one calm workspace so
 * users can understand what is saved and what an AI maintenance run changes.
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
  models: string[]
  activeModel: string
  embeddingModels?: ProviderEmbeddingModelRow[]
}

type ProviderWithEmbeddingCatalog = { id: string; name: string; baseUrl: string; models?: string[]; activeModel?: string; embeddingModels?: ProviderEmbeddingModelRow[] }

interface MemoryCompactionStatusLite {
  status: 'idle' | 'running' | 'completed' | 'failed'
  stage: string
  detail?: string
  error?: string
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
const savedEmbeddingSettings = ref<MemoryEmbeddingSettings | null>(null)
const memoryIndexStatus = ref<MemoryIndexStatus | null>(null)
const memoryIndexError = ref('')
const retryingIndex = ref(false)
let unmounted = false
let indexStatusLoading = false
let indexStatusTimer: ReturnType<typeof setInterval> | null = null
const providers = ref<AIProviderLite[]>([])
const statusMessage = ref('')

const embeddingProviders = computed(() => providers.value.filter(provider => (provider.embeddingModels || []).length > 0))
const chatProviders = computed(() => providers.value.filter(provider => provider.models.length > 0))
const compactionModels = computed(() => providers.value.find(provider => provider.id === compactionProviderId.value)?.models || [])
const compactionModelPlaceholder = computed(() => {
  if (!compactionProviderId.value) return t('settings.memory.compactModelFollowDefault')
  const activeModel = providers.value.find(provider => provider.id === compactionProviderId.value)?.activeModel
  return activeModel ? `${t('settings.memory.compactModelProviderDefault')}：${activeModel}` : t('settings.memory.compactModelProviderDefault')
})
const selectedProvider = computed(() => providers.value.find(provider => provider.id === selectedProviderId.value))
const selectedEmbeddingModels = computed(() => selectedProvider.value?.embeddingModels || [])
const selectedModelMeta = computed(() => selectedEmbeddingModels.value.find(model => model.id === selectedModelId.value))
const semanticMemoryState = computed(() => {
  const phase = semanticMemoryPhase({
    enabled: embeddingEnabled.value,
    providerId: selectedProviderId.value || undefined,
    modelId: selectedModelId.value || undefined
  }, savedEmbeddingSettings.value, memoryIndexStatus.value)
  const labels = {
    disabled: 'semanticDisabled', unconfigured: 'semanticSetupNeeded', ready: 'semanticReady',
    unsaved: 'semanticUnsaved', unknown: 'semanticUnknown', waiting: 'semanticWaiting',
    indexing: 'semanticIndexing', failed: 'semanticFailed', empty: 'semanticEmpty'
  }
  return {
    label: t(`settings.memory.${labels[phase]}`),
    detail: selectedModelId.value ? `${selectedProvider.value?.name || selectedProviderId.value} · ${selectedModelId.value}` : '',
    tone: phase === 'ready' ? 'success' : phase === 'disabled' ? 'muted' : 'warning'
  }
})

async function loadMemoryIndexStatus () {
  if (!window.electronAPI?.getMemoryIndexStatus || indexStatusLoading) return
  indexStatusLoading = true
  try {
    memoryIndexStatus.value = await window.electronAPI.getMemoryIndexStatus()
    memoryIndexError.value = ''
  } catch (error) {
    memoryIndexStatus.value = null
    memoryIndexError.value = (error as Error).message
  } finally {
    indexStatusLoading = false
  }
}

async function retryMemoryIndex () {
  if (!window.electronAPI?.retryMemoryIndex || retryingIndex.value) return
  retryingIndex.value = true
  try {
    memoryIndexStatus.value = await window.electronAPI.retryMemoryIndex()
    memoryIndexError.value = ''
  } catch (error) {
    memoryIndexError.value = (error as Error).message
  } finally {
    retryingIndex.value = false
  }
}

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
const loadingMemory = ref(false)
let memoryLoadRequest = 0
const savingMemory = ref(false)
const memoryCompactionStatus = ref<MemoryCompactionStatusLite | null>(null)
const memoryCompactionStarting = ref(false)
const compactionProviderId = ref('')
const compactionModelId = ref('')
const savingCompactionModel = ref(false)
const memoryCompacting = computed(() => memoryCompactionStarting.value || memoryCompactionStatus.value?.status === 'running')
const displayedPinnedCount = computed(() => memoryEntries.value.filter(entry => entry.pinned).length)
const hasMemoryScopeFilter = computed(() => memoryScopeId.value.trim().length > 0)
const memoryScopeFilterText = computed(() => {
  if (!hasMemoryScopeFilter.value) return t('settings.memory.allScopes')
  return `${memoryScopeLabel(memoryScopeType.value)} / ${memoryScopeId.value.trim()}`
})
const memoryCompactionProgress = computed(() => {
  const status = memoryCompactionStatus.value
  if (!status?.totalChunks) return 0
  return Math.min(100, Math.round((status.completedChunks / status.totalChunks) * 100))
})
const memoryCompactionProgressText = computed(() => {
  const status = memoryCompactionStatus.value
  if (status?.status === 'running') {
    const detail = status.detail ? ` · ${status.detail}` : ''
    return `${status.stage}${detail}`
  }
  if (memoryCompactionStarting.value) return t('settings.memory.compactStarting')
  return ''
})
const memoryCompactionErrorText = computed(() => {
  const status = memoryCompactionStatus.value
  if (status?.status !== 'failed') return ''
  return status.detail || status.error || status.stage
})
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

function clearStatus () {
  statusMessage.value = ''
}

function parseMemoryTags (value: string): string[] {
  return value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean)
}

// ---------- memory entries: CRUD ----------
async function loadMemory () {
  if (!window.electronAPI?.listMemory) return
  const requestId = ++memoryLoadRequest
  loadingMemory.value = true
  try {
    const entries = await window.electronAPI.listMemory({
      query: memoryQuery.value.trim() || undefined,
      scopeType: memoryScopeId.value.trim() ? memoryScopeType.value : undefined,
      scopeId: memoryScopeId.value.trim() || undefined,
      limit: 50
    })
    if (requestId === memoryLoadRequest) memoryEntries.value = entries
  } catch (error) {
    if (requestId === memoryLoadRequest) setStatus(t('settings.memory.loadFailed', { message: (error as Error).message }))
  } finally {
    if (requestId === memoryLoadRequest) loadingMemory.value = false
  }
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

// Markdown for details is parsed only after the disclosure is opened, so a
// long list does not pay the marked/KaTeX cost for every collapsed card.
const expandedMemoryDetails = reactive<Record<string, boolean>>({})

function onMemoryDetailsToggle (entry: MemoryEntry, event: Event) {
  expandedMemoryDetails[entry.id] = (event.target as HTMLDetailsElement).open
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
  try {
    memoryCompactionStatus.value = await window.electronAPI.getMemoryCompactionStatus()
  } catch (error) {
    setStatus(t('settings.memory.compactFailed', { message: (error as Error).message }))
  }
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

// ---------- compaction model selection ----------
async function loadCompactionModelSettings () {
  if (!window.electronAPI?.getMemoryCompactionSettings) return
  try {
    const settings = await window.electronAPI.getMemoryCompactionSettings()
    compactionProviderId.value = settings.providerId || ''
    compactionModelId.value = settings.modelId || ''
  } catch (error) {
    setStatus(t('settings.memory.compactFailed', { message: (error as Error).message }))
  }
}

function onCompactionProviderChanged () {
  // Empty model id means "use the provider's current model" main-side.
  compactionModelId.value = ''
}

async function saveCompactionModelSettings () {
  if (!window.electronAPI?.saveMemoryCompactionSettings || savingCompactionModel.value) return
  savingCompactionModel.value = true
  try {
    const saved = await window.electronAPI.saveMemoryCompactionSettings({
      providerId: compactionProviderId.value || undefined,
      modelId: compactionModelId.value || undefined
    })
    compactionProviderId.value = saved.providerId || ''
    compactionModelId.value = saved.modelId || ''
    setStatus(t('settings.memory.compactModelSaved'))
  } catch (error) {
    setStatus(t('settings.memory.compactFailed', { message: (error as Error).message }))
  } finally {
    savingCompactionModel.value = false
  }
}

// ---------- embedding settings ----------
async function loadEmbeddingSettings () {
  if (!window.electronAPI?.getMemoryEmbeddingSettings) return
  loadingEmbedding.value = true
  try {
    const settings = await window.electronAPI.getMemoryEmbeddingSettings()
    savedEmbeddingSettings.value = settings
    embeddingEnabled.value = settings.enabled === true
    selectedProviderId.value = settings.providerId || ''
    selectedModelId.value = settings.modelId || ''
  } catch (error) {
    setStatus(t('settings.memory.embeddingSaveFailed', { message: (error as Error).message }))
  } finally {
    loadingEmbedding.value = false
  }
}

async function loadProviders () {
  if (!window.electronAPI?.getProviders) return
  try {
    const config = await window.electronAPI.getProviders()
    providers.value = config.providers.map((provider: ProviderWithEmbeddingCatalog) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      models: [...(provider.models || [])],
      activeModel: provider.activeModel || '',
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
    // Same cleanup for the compaction-model selection; an emptied selection
    // means "follow the active chat model" on the main-process side.
    if (compactionProviderId.value && !providers.value.some(provider => provider.id === compactionProviderId.value)) {
      compactionProviderId.value = ''
      compactionModelId.value = ''
    }
    if (compactionProviderId.value && compactionModelId.value && !compactionModels.value.includes(compactionModelId.value)) {
      compactionModelId.value = ''
    }
  } catch (error) {
    setStatus(t('settings.memory.embeddingSaveFailed', { message: (error as Error).message }))
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
    savedEmbeddingSettings.value = saved
    await loadMemoryIndexStatus()
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
  await Promise.all([loadEmbeddingSettings(), loadProviders(), loadMemory(), loadCompactionModelSettings(), syncMemoryCompactionStatus()])
  if (unmounted) return
  await loadMemoryIndexStatus()
  if (unmounted) return
  indexStatusTimer = setInterval(() => { void loadMemoryIndexStatus() }, 3000)
  if (window.electronAPI?.onMemoryCompactionStatusChanged) {
    memoryCompactionCleanup = window.electronAPI.onMemoryCompactionStatusChanged((status) => {
      memoryCompactionStatus.value = status
    })
  }
})

onUnmounted(() => {
  unmounted = true
  if (indexStatusTimer) clearInterval(indexStatusTimer)
  memoryCompactionCleanup?.()
  memoryCompactionCleanup = null
})
</script>

<template>
  <div class="memory-settings">
    <header class="memory-header">
      <div class="memory-header-copy">
        <span class="memory-eyebrow">{{ $t('settings.memory.headerEyebrow') }}</span>
        <h2>{{ $t('settings.memory.title') }}</h2>
        <p>{{ $t('settings.memory.description') }}</p>
      </div>
      <button
        class="icon-btn header-refresh"
        type="button"
        :title="$t('settings.memory.query')"
        :aria-label="$t('settings.memory.query')"
        :disabled="loadingMemory"
        @click="loadMemory"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-4.1L3 9" /><path d="M3 4v5h5" /><path d="M4 13a8 8 0 0 0 14.9 4.1L21 15" /><path d="M21 20v-5h-5" /></svg>
      </button>
    </header>

    <div v-if="statusMessage" class="memory-feedback" role="status">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v4" /><path d="M12 16h.01" /></svg>
      <span>{{ statusMessage }}</span>
      <button class="feedback-close" type="button" :aria-label="$t('common.close')" @click="clearStatus">×</button>
    </div>

    <section class="memory-overview" :aria-label="$t('settings.memory.overviewAriaLabel')">
      <article class="overview-card">
        <span class="overview-icon entries" aria-hidden="true">
          <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M8 9h8M8 13h8M8 17h5" /></svg>
        </span>
        <div>
          <span>{{ $t('settings.memory.overviewEntries') }}</span>
          <strong>{{ memoryEntries.length }}</strong>
        </div>
      </article>
      <article class="overview-card">
        <span class="overview-icon pinned" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="m15 4 5 5-3 1-4 4v4l-2 2-2-2v-4l-4-4-3-1 5-5z" /><path d="M11 18v4" /></svg>
        </span>
        <div>
          <span>{{ $t('settings.memory.overviewPinned') }}</span>
          <strong>{{ displayedPinnedCount }}</strong>
        </div>
      </article>
      <article class="overview-card overview-card--semantic">
        <span class="overview-icon semantic" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" /><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" /><path d="M12 5v13" /></svg>
        </span>
        <div>
          <span>{{ $t('settings.memory.overviewSemantic') }}</span>
          <strong :class="`state-${semanticMemoryState.tone}`">{{ semanticMemoryState.label }}</strong>
          <small v-if="semanticMemoryState.detail">{{ semanticMemoryState.detail }}</small>
        </div>
      </article>
    </section>

    <section class="memory-section memory-section--semantic">
      <div class="section-heading">
        <span class="section-icon section-icon--semantic" aria-hidden="true">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.5 2.5" /><path d="M12 4V2M20 12h2M12 22v-2M2 12h2" /></svg>
        </span>
        <div>
          <h3>{{ $t('settings.memory.embeddingTitle') }}</h3>
          <p>{{ $t('settings.memory.embeddingDescription') }}</p>
        </div>
        <span :class="['section-state', `state-${semanticMemoryState.tone}`]">{{ semanticMemoryState.label }}</span>
      </div>

      <div class="semantic-controls">
        <button
          :class="['semantic-toggle', { on: embeddingEnabled }]"
          type="button"
          role="switch"
          :aria-checked="embeddingEnabled"
          @click="embeddingEnabled = !embeddingEnabled"
        >
          <span class="semantic-toggle-copy">
            <strong>{{ $t('settings.memory.embeddingToggle') }}</strong>
            <small>{{ $t('settings.memory.embeddingToggleHint') }}</small>
          </span>
          <span class="toggle-track" aria-hidden="true"><span /></span>
        </button>

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

          <div class="embedding-options-row">
            <span v-if="selectedModelMeta" class="model-meta">
              {{ $t('settings.memory.embeddingModelMeta', { dimensions: selectedModelMeta.dimensions ?? '—', distance: selectedModelMeta.distance || 'cosine' }) }}
            </span>
            <button
              class="ghost-btn"
              type="button"
              :disabled="!selectedProviderId || !selectedModelId || embeddingTestState?.running"
              @click="testEmbeddingConnection"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 12.5 10 15l7-7" /><circle cx="12" cy="12" r="9" /></svg>
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
        </template>

        <div class="semantic-footer-row">
          <div class="semantic-index-summary" aria-live="polite">
            <p v-if="memoryIndexStatus">{{ $t('settings.memory.indexProgress', {
              indexed: memoryIndexStatus.documents.indexed,
              total: memoryIndexStatus.documents.total,
              queued: memoryIndexStatus.documents.queued,
              failed: memoryIndexStatus.documents.failed
            }) }}</p>
            <p v-if="memoryIndexError || memoryIndexStatus?.lastError" class="embedding-test-result error">{{ memoryIndexError || memoryIndexStatus?.lastError }}</p>
            <button v-if="memoryIndexStatus?.state === 'failed'" class="ghost-btn" type="button" :disabled="retryingIndex" @click="retryMemoryIndex">{{ $t('settings.memory.retryIndex') }}</button>
          </div>
          <button class="primary-btn" type="button" :disabled="savingEmbedding || loadingEmbedding" @click="saveEmbeddingSettings">
            {{ savingEmbedding ? $t('common.saving') : $t('common.save') }}
          </button>
        </div>

        <aside class="privacy-note">
          <span class="privacy-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6z" /><path d="M12 9v3" /><path d="M12 16h.01" /></svg>
          </span>
          <p>{{ $t('settings.memory.embeddingPrivacy') }}</p>
        </aside>
      </div>
    </section>

    <section class="memory-section memory-section--entries">
      <div class="section-heading entries-heading">
        <span class="section-icon section-icon--entries" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M6 3h9l3 3v15H6z" /><path d="M15 3v4h4M9 11h6M9 15h6" /></svg>
        </span>
        <div>
          <h3>{{ $t('settings.memory.entryTitle') }}</h3>
          <p>{{ $t('settings.memory.entryDescription') }}</p>
        </div>
        <div class="section-actions">
          <button :class="['ghost-btn', 'compact-action', { active: addingMemory }]" type="button" @click="toggleMemoryCreator">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            {{ addingMemory ? $t('settings.memory.collapseAdd') : $t('settings.memory.manualAdd') }}
          </button>
          <button class="ghost-btn compact-action compact-action--ai" type="button" :disabled="memoryCompacting" @click="compactMemory">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 14 8l5 2-5 2-2 5-2-5-5-2 5-2z" /><path d="m18 16 1 2 2 1-2 1-1 2-1-2-2-1 2-1z" /></svg>
            {{ memoryCompacting ? $t('settings.memory.compacting') : $t('settings.memory.aiCompact') }}
          </button>
        </div>
      </div>

      <div class="compact-model-bar">
        <div class="compact-model-copy">
          <strong>{{ $t('settings.memory.compactModelTitle') }}</strong>
          <p>{{ $t('settings.memory.compactModelDescription') }}</p>
        </div>
        <div class="compact-model-controls">
          <select v-model="compactionProviderId" class="input compact-model-select" :disabled="savingCompactionModel" @change="onCompactionProviderChanged">
            <option value="">{{ $t('settings.memory.compactModelFollowDefault') }}</option>
            <option v-for="provider in chatProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
          </select>
          <select v-model="compactionModelId" class="input compact-model-select" :disabled="savingCompactionModel || !compactionProviderId">
            <option value="">{{ compactionModelPlaceholder }}</option>
            <option v-for="model in compactionModels" :key="model" :value="model">{{ model }}</option>
          </select>
          <button class="ghost-btn compact-model-save" type="button" :disabled="savingCompactionModel" @click="saveCompactionModelSettings">
            {{ savingCompactionModel ? $t('common.saving') : $t('common.save') }}
          </button>
        </div>
      </div>

      <div class="memory-toolbar">
        <label class="memory-search-wrap">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
          <input
            v-model="memoryQuery"
            class="input memory-search"
            type="search"
            :placeholder="$t('settings.memory.searchPlaceholder')"
            @keyup.enter="loadMemory"
          >
        </label>
        <button class="primary-btn search-submit" type="button" :disabled="loadingMemory" @click="loadMemory">
          {{ loadingMemory ? $t('common.loading') : $t('settings.memory.query') }}
        </button>
        <button :class="['ghost-btn', 'filter-btn', { active: showMemoryFilters }]" type="button" @click="showMemoryFilters = !showMemoryFilters">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
          {{ $t('settings.memory.filter') }}
        </button>
        <span :class="['memory-filter-pill', { active: hasMemoryScopeFilter }]">{{ memoryScopeFilterText }}</span>
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
        <div class="filter-actions">
          <button class="ghost-btn" type="button" :disabled="!hasMemoryScopeFilter" @click="clearMemoryScopeFilter">{{ $t('settings.memory.all') }}</button>
          <button class="primary-btn" type="button" :disabled="loadingMemory" @click="loadMemory">{{ $t('settings.memory.query') }}</button>
        </div>
      </div>

      <form v-if="addingMemory" class="memory-create-card" @submit.prevent="saveManualMemory">
        <div class="create-card-heading">
          <div>
            <h4>{{ $t('settings.memory.manualAdd') }}</h4>
            <p>{{ $t('settings.memory.entryDescription') }}</p>
          </div>
          <button class="icon-btn" type="button" :aria-label="$t('common.close')" @click="addingMemory = false">×</button>
        </div>
        <div class="memory-create-grid">
          <label class="memory-create-title">
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
            <textarea v-model="draftMemory.summary" class="textarea" rows="2" :placeholder="$t('settings.memory.summaryPlaceholder')"></textarea>
          </label>
          <label class="memory-create-summary">
            <span>{{ $t('settings.memory.details') }}</span>
            <textarea v-model="draftMemory.details" class="textarea" rows="3" :placeholder="$t('settings.memory.detailsPlaceholder')"></textarea>
          </label>
          <label class="memory-create-tags">
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

      <div v-if="memoryCompacting" class="memory-progress" role="status">
        <span class="progress-spinner" aria-hidden="true" />
        <div class="progress-copy">
          <strong>{{ memoryCompactionProgressText }}</strong>
          <span v-if="memoryCompactionStatus?.totalChunks">{{ memoryCompactionStatus.completedChunks }} / {{ memoryCompactionStatus.totalChunks }}</span>
        </div>
        <div class="progress-track" aria-hidden="true"><span :style="{ width: `${memoryCompactionProgress}%` }" /></div>
      </div>

      <div v-else-if="memoryCompactionErrorText" class="memory-progress memory-progress--error" role="alert">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
        <span>{{ memoryCompactionErrorText }}</span>
      </div>

      <div v-if="loadingMemory" class="memory-loading" aria-live="polite">
        <span class="progress-spinner" aria-hidden="true" />
        {{ $t('common.loading') }}
      </div>

      <div v-else-if="memoryEntries.length === 0" class="memory-empty">
        <span class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M6 3h9l3 3v15H6z" /><path d="M15 3v4h4M9 12h6M9 16h4" /></svg>
        </span>
        <strong>{{ $t('settings.memory.noMatches') }}</strong>
        <button class="ghost-btn" type="button" @click="addingMemory = true">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          {{ $t('settings.memory.manualAdd') }}
        </button>
      </div>

      <div v-else class="memory-list">
        <article
          v-for="entry in memoryEntries"
          :key="entry.id"
          :class="['memory-card', `memory-card--${entry.memoryType}`, { 'is-pinned': entry.pinned }]"
        >
          <div class="memory-card-head">
            <div class="memory-card-title-wrap">
              <span class="memory-kind-icon" aria-hidden="true">
                <svg v-if="entry.memoryType === 'user_trait'" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M4 21c.8-4 3.4-6 8-6s7.2 2 8 6" /></svg>
                <svg v-else-if="entry.memoryType === 'agent_skill'" viewBox="0 0 24 24"><path d="m12 3 2.2 5.6L20 11l-5.8 2.4L12 19l-2.2-5.6L4 11l5.8-2.4z" /></svg>
                <svg v-else-if="entry.memoryType === 'step'" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></svg>
                <svg v-else viewBox="0 0 24 24"><path d="M6 3h9l3 3v15H6z" /><path d="M15 3v4h4M9 12h6M9 16h6" /></svg>
              </span>
              <div class="memory-card-heading">
                <div class="memory-title-row">
                  <h4>{{ entry.title }}</h4>
                  <span v-if="entry.pinned" class="pin-badge">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5-3 1-4 4v4l-2 2-2-2v-4l-4-4-3-1 5-5z" /></svg>
                    {{ $t('settings.memory.entryPinned') }}
                  </span>
                </div>
                <div class="memory-meta">
                  <span class="type-badge">{{ memoryTypeLabel(entry.memoryType) }}</span>
                  <span class="scope-badge">{{ memoryScopeLabel(entry.scopeType) }}</span>
                  <span class="scope-id">{{ entry.scopeId }}</span>
                </div>
              </div>
            </div>
            <div class="memory-actions">
              <button
                :class="['card-icon-btn', { active: entry.pinned }]"
                type="button"
                :title="entry.pinned ? $t('settings.memory.unpin') : $t('settings.memory.pin')"
                :aria-label="entry.pinned ? $t('settings.memory.unpin') : $t('settings.memory.pin')"
                @click="toggleMemoryPinned(entry)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5-3 1-4 4v4l-2 2-2-2v-4l-4-4-3-1 5-5z" /><path d="M11 18v3" /></svg>
              </button>
              <button
                class="card-icon-btn danger"
                type="button"
                :title="$t('common.delete')"
                :aria-label="$t('common.delete')"
                @click="removeMemory(entry)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M9 7l1-3h4l1 3M6 7l1 13h10l1-13" /></svg>
              </button>
            </div>
          </div>
          <p class="memory-summary">{{ entry.summary }}</p>
          <details v-if="hasAdditionalMemoryDetails(entry)" class="memory-details" @toggle="onMemoryDetailsToggle(entry, $event)">
            <summary>{{ $t('settings.memory.detailsLabel') }}</summary>
            <div
              v-if="expandedMemoryDetails[entry.id]"
              class="markdown-body memory-details-body"
              tabindex="0"
              v-html="renderMarkdown(entry.details || '')"
            ></div>
          </details>
          <details v-if="entry.sourceText?.trim() || entry.sourceConversationId" class="memory-source">
            <summary>{{ $t(entry.sourceText?.trim() ? 'settings.memory.sourceText' : 'settings.memory.sourceInfo') }}</summary>
            <pre v-if="entry.sourceText?.trim()" tabindex="0">{{ entry.sourceText }}</pre>
            <small v-else class="memory-source-missing">{{ $t('settings.memory.sourceUnavailable') }}</small>
            <small v-if="entry.sourceConversationId">{{ $t('settings.memory.sourceConversation') }}: {{ entry.sourceConversationId }}</small>
          </details>
          <div v-if="entry.tags.length" class="memory-tags">
            <span v-for="tag in entry.tags" :key="tag"># {{ tag }}</span>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* Source excerpts stay plain escaped text. Details go through the shared
   renderMarkdown pipeline (tag/attr whitelist, no script or mermaid execution),
   so legacy Markdown in stored details renders instead of leaking as syntax. */
.memory-source,
.memory-details {
  margin: 0;
  color: var(--app-text-muted);
  font-size: 0.76rem;
  line-height: 1.52;
}

.memory-source summary,
.memory-details summary {
  cursor: pointer;
  padding: 4px 0;
}

.memory-source summary:focus-visible,
.memory-details summary:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
  border-radius: 4px;
}

.memory-source pre {
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
}

.memory-details-body {
  max-height: 300px;
  margin-top: 6px;
  padding: 8px 10px;
  overflow: auto;
  overflow-wrap: anywhere;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  color: var(--app-text);
  font-size: 0.8rem;
  line-height: 1.55;
}

.memory-details-body :deep(pre) {
  max-width: 100%;
}

.memory-source small {
  display: block;
  margin: 4px 0;
  opacity: 0.8;
  overflow-wrap: anywhere;
}
.semantic-index-summary p { margin: 0; }
.semantic-index-summary { font-size: 12px; overflow-wrap: anywhere; }

.memory-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 20px clamp(16px, 2.5vw, 32px) 28px;
  overflow-y: auto;
  color: var(--app-text);
  background:
    radial-gradient(circle at 100% 0%, color-mix(in srgb, var(--app-accent) 8%, transparent), transparent 29%),
    var(--app-main-surface);
}

.memory-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.memory-header-copy {
  min-width: 0;
}

.memory-eyebrow {
  display: block;
  margin-bottom: 3px;
  color: var(--app-accent);
  font-size: 0.68rem;
  font-weight: 760;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.memory-header h2 {
  margin: 0;
  color: var(--app-text-strong);
  font-size: clamp(1.18rem, 1.6vw, 1.4rem);
  letter-spacing: -0.025em;
}

.memory-header p {
  max-width: 680px;
  margin: 4px 0 0;
  color: var(--app-text-muted);
  font-size: 0.82rem;
  line-height: 1.55;
}

.icon-btn,
.card-icon-btn,
.feedback-close {
  display: inline-grid;
  place-items: center;
  border: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
  color: var(--app-text-soft);
  cursor: pointer;
  transition: border-color var(--duration-fast), background var(--duration-fast), color var(--duration-fast), transform var(--duration-fast);
}

.icon-btn {
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  border-radius: 10px;
}

.icon-btn svg,
.card-icon-btn svg,
.memory-feedback svg,
.ghost-btn svg,
.empty-icon svg,
.overview-icon svg,
.section-icon svg,
.privacy-icon svg,
.memory-search-wrap svg,
.pin-badge svg,
.memory-kind-icon svg,
.memory-progress > svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.icon-btn:hover:not(:disabled),
.card-icon-btn:hover,
.feedback-close:hover {
  border-color: color-mix(in srgb, var(--app-accent) 48%, var(--app-border));
  background: var(--app-accent-soft);
  color: var(--app-accent-strong);
}

.icon-btn:active,
.card-icon-btn:active,
.feedback-close:active {
  transform: translateY(1px);
}

.icon-btn:disabled {
  cursor: wait;
  opacity: 0.6;
}

.icon-btn:focus-visible,
.card-icon-btn:focus-visible,
.feedback-close:focus-visible,
.ghost-btn:focus-visible,
.primary-btn:focus-visible,
.semantic-toggle:focus-visible {
  outline: 2px solid var(--app-accent-strong);
  outline-offset: 2px;
}

.memory-feedback {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 34%, var(--app-border));
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-accent-soft) 72%, var(--app-panel));
  color: var(--app-text-soft);
  font-size: 0.82rem;
  line-height: 1.45;
}

.memory-feedback > svg {
  color: var(--app-accent);
}

.feedback-close {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 7px;
  background: transparent;
  font-size: 1rem;
  line-height: 1;
}

.memory-overview {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.overview-card {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 9px 12px;
  border: 1px solid var(--app-border);
  border-radius: 13px;
  background: linear-gradient(145deg, color-mix(in srgb, var(--app-panel) 96%, transparent), var(--app-panel-subtle));
  box-shadow: var(--shadow-1);
}

.overview-icon {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  flex: 0 0 auto;
  border-radius: 10px;
}

.overview-icon.entries {
  background: color-mix(in srgb, var(--app-accent) 16%, transparent);
  color: var(--app-accent-strong);
}

.overview-icon.pinned {
  background: color-mix(in srgb, var(--app-warning) 16%, transparent);
  color: var(--app-warning);
}

.overview-icon.semantic {
  background: color-mix(in srgb, var(--app-success) 15%, transparent);
  color: var(--app-success);
}

.overview-card div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.overview-card span:not(.overview-icon) {
  color: var(--app-text-muted);
  font-size: 0.74rem;
}

.overview-card strong {
  overflow: hidden;
  color: var(--app-text-strong);
  font-size: 1.02rem;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.overview-card small {
  overflow: hidden;
  color: var(--app-text-faint);
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.overview-card--semantic strong {
  font-size: 0.85rem;
}

.state-success { color: var(--app-success) !important; }
.state-warning { color: var(--app-warning) !important; }
.state-muted { color: var(--app-text-faint) !important; }

.memory-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: clamp(12px, 1.5vw, 16px);
  border: 1px solid var(--app-border);
  border-radius: 16px;
  background: linear-gradient(145deg, var(--app-panel), color-mix(in srgb, var(--app-panel-subtle) 70%, var(--app-panel)));
  box-shadow: var(--shadow-1);
}

.section-heading {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.section-heading > div:not(.section-actions) {
  min-width: 0;
}

.section-heading h3,
.create-card-heading h4 {
  margin: 0;
  color: var(--app-text-strong);
  font-size: 0.98rem;
  letter-spacing: -0.01em;
}

.section-heading p,
.create-card-heading p {
  margin: 4px 0 0;
  color: var(--app-text-muted);
  font-size: 0.79rem;
  line-height: 1.55;
}

.section-icon {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  flex: 0 0 auto;
  border: 1px solid var(--app-border);
  border-radius: 10px;
}

.section-icon--semantic {
  color: var(--app-accent-strong);
  background: var(--app-accent-soft);
}

.section-icon--entries {
  color: var(--app-success);
  background: var(--app-success-soft);
}

.section-state {
  align-self: center;
  margin-left: auto;
  padding: 5px 8px;
  border: 1px solid currentColor;
  border-radius: var(--radius-pill);
  font-size: 0.72rem;
  font-weight: 650;
  white-space: nowrap;
}

.semantic-controls {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.semantic-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-panel-subtle);
  color: var(--app-text);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--duration-base), background var(--duration-base);
}

.semantic-toggle:hover,
.semantic-toggle.on {
  border-color: color-mix(in srgb, var(--app-accent) 48%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent-soft) 55%, var(--app-panel-subtle));
}

.semantic-toggle-copy {
  display: grid;
  gap: 4px;
}

.semantic-toggle-copy strong {
  color: var(--app-text-strong);
  font-size: 0.86rem;
}

.semantic-toggle-copy small {
  max-width: 620px;
  color: var(--app-text-muted);
  font-size: 0.75rem;
  line-height: 1.45;
}

.toggle-track {
  position: relative;
  width: 42px;
  height: 24px;
  flex: 0 0 auto;
  border: 1px solid var(--app-border-strong);
  border-radius: var(--radius-pill);
  background: var(--app-panel);
  transition: background var(--duration-base), border-color var(--duration-base);
}

.toggle-track span {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--app-text-faint);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.24);
  transition: transform var(--duration-base), background var(--duration-base);
}

.semantic-toggle.on .toggle-track {
  border-color: var(--app-accent);
  background: var(--app-accent);
}

.semantic-toggle.on .toggle-track span {
  transform: translateX(18px);
  background: var(--app-on-accent);
}

.embedding-grid,
.memory-create-grid {
  display: grid;
  gap: 12px;
}

.embedding-grid {
  grid-template-columns: minmax(160px, 0.9fr) minmax(190px, 1.1fr);
}

.embedding-grid label,
.memory-filter-row label,
.memory-create-grid label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  color: var(--app-text-soft);
  font-size: 0.76rem;
  font-weight: 590;
}

.embedding-grid label > span,
.memory-filter-row label > span,
.memory-create-grid label > span {
  color: var(--app-text-muted);
}

.input,
.textarea {
  width: 100%;
  border: 1px solid var(--app-input-border);
  border-radius: 10px;
  outline: none;
  background: var(--app-input-bg);
  color: var(--app-text);
  font: inherit;
  transition: border-color var(--duration-fast), box-shadow var(--duration-fast), background var(--duration-fast);
}

.input {
  min-height: 36px;
  padding: 0 10px;
}

.textarea {
  min-height: 66px;
  padding: 9px 10px;
  line-height: 1.5;
  resize: vertical;
}

.input:focus,
.textarea:focus {
  border-color: var(--app-accent);
  background: color-mix(in srgb, var(--app-input-bg) 82%, var(--app-accent-soft));
  box-shadow: 0 0 0 3px var(--app-accent-glow);
}

.embedding-options-row,
.semantic-footer-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.model-meta {
  display: inline-flex;
  width: fit-content;
  max-width: 100%;
  padding: 5px 9px;
  border: 1px solid var(--app-border);
  border-radius: var(--radius-pill);
  background: var(--app-panel-subtle);
  color: var(--app-text-muted);
  font-size: 0.74rem;
  white-space: nowrap;
}

.semantic-footer-row {
  justify-content: space-between;
}

.semantic-index-summary {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 4px 12px;
}

.embedding-test-result {
  font-size: 0.77rem;
  line-height: 1.4;
}

.embedding-test-result.ok { color: var(--app-success); }
.embedding-test-result.error { color: var(--app-danger); }

.privacy-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--app-warning) 24%, var(--app-border));
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-warning-soft) 45%, var(--app-panel-subtle));
}

.privacy-icon {
  display: grid;
  width: 20px;
  height: 20px;
  place-items: center;
  flex: 0 0 auto;
  border-radius: 7px;
  background: color-mix(in srgb, var(--app-warning) 15%, transparent);
  color: var(--app-warning);
}

.privacy-icon svg {
  width: 13px;
  height: 13px;
}

.privacy-note p {
  margin: 0;
  color: var(--app-text-muted);
  font-size: 0.72rem;
  line-height: 1.5;
}

.action-row {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.ghost-btn,
.primary-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid var(--app-border-strong);
  border-radius: 10px;
  background: var(--app-panel-subtle);
  color: var(--app-text-soft);
  cursor: pointer;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  white-space: nowrap;
  transition: background var(--duration-fast), border-color var(--duration-fast), color var(--duration-fast), transform var(--duration-fast);
}

.ghost-btn:hover:not(:disabled),
.ghost-btn.active {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
  background: var(--app-accent-soft);
  color: var(--app-accent-strong);
}

.primary-btn {
  border-color: var(--app-accent);
  background: linear-gradient(135deg, var(--app-accent), var(--app-accent-strong));
  color: var(--app-on-accent);
  box-shadow: 0 5px 14px var(--app-accent-glow);
}

.primary-btn:hover:not(:disabled) {
  border-color: var(--app-accent-strong);
  filter: brightness(1.08);
}

.ghost-btn:active:not(:disabled),
.primary-btn:active:not(:disabled) {
  transform: translateY(1px);
}

.ghost-btn:disabled,
.primary-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
  box-shadow: none;
}

.entries-heading {
  align-items: center;
}

.section-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.compact-action--ai {
  border-color: color-mix(in srgb, var(--app-warning) 34%, var(--app-border));
  color: color-mix(in srgb, var(--app-warning) 88%, var(--app-text));
}

.compact-action--ai:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--app-warning) 62%, var(--app-border));
  background: var(--app-warning-soft);
  color: var(--app-warning);
}

/* The heading wrapper is the flex item that must be allowed to shrink; its
   nowrap title would otherwise push the card past its grid column. */
.memory-card-heading {
  min-width: 0;
}

.compact-model-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-panel-subtle);
}

.compact-model-copy {
  min-width: 0;
  flex: 1 1 260px;
}

.compact-model-copy strong {
  display: block;
  color: var(--app-text-strong);
  font-size: 0.8rem;
}

.compact-model-copy p {
  margin: 2px 0 0;
  color: var(--app-text-muted);
  font-size: 0.72rem;
  line-height: 1.45;
}

.compact-model-controls {
  display: flex;
  flex: 2 1 420px;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.compact-model-select {
  flex: 1 1 0;
  min-width: 0;
}

.compact-model-save {
  flex: 0 0 auto;
}

.memory-toolbar {
  display: grid;
  grid-template-columns: minmax(200px, 1fr) auto auto auto;
  align-items: center;
  gap: 8px;
}

.memory-search-wrap {
  position: relative;
  display: block;
  min-width: 0;
}

.memory-search-wrap svg {
  position: absolute;
  top: 50%;
  left: 11px;
  color: var(--app-text-faint);
  pointer-events: none;
  transform: translateY(-50%);
}

.memory-search {
  padding-left: 35px;
}

.filter-btn svg,
.compact-action svg,
.memory-empty .ghost-btn svg {
  width: 15px;
  height: 15px;
}

.memory-filter-pill {
  display: inline-flex;
  align-items: center;
  max-width: 240px;
  min-height: 34px;
  padding: 0 10px;
  overflow: hidden;
  border: 1px solid var(--app-border);
  border-radius: var(--radius-pill);
  background: var(--app-panel-subtle);
  color: var(--app-text-faint);
  font-size: 0.73rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.memory-filter-pill.active {
  border-color: color-mix(in srgb, var(--app-accent) 38%, var(--app-border));
  background: var(--app-accent-soft);
  color: var(--app-accent-strong);
}

.memory-filter-row {
  display: grid;
  grid-template-columns: minmax(140px, 0.6fr) minmax(220px, 1.25fr) auto;
  align-items: end;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-panel-subtle);
}

.filter-actions {
  display: flex;
  gap: 8px;
}

.memory-create-card {
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 30%, var(--app-border));
  border-radius: 15px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--app-accent-soft) 35%, var(--app-panel)), var(--app-panel-subtle));
}

.create-card-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.memory-create-grid {
  grid-template-columns: minmax(180px, 1.2fr) minmax(120px, 0.7fr) minmax(120px, 0.7fr) minmax(150px, 1fr);
}

.memory-create-title {
  grid-column: span 1;
}

.memory-create-summary {
  grid-column: 1 / -1;
}

.memory-create-tags {
  min-width: 0;
}

.memory-pin-row {
  align-self: end;
  min-height: 36px;
  flex-direction: row !important;
  align-items: center;
  gap: 8px !important;
  padding: 0 2px;
  cursor: pointer;
}

.memory-pin-row input {
  accent-color: var(--app-accent);
}

.memory-create-actions {
  margin-top: 14px;
}

.memory-progress {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 10px 12px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 32%, var(--app-border));
  border-radius: 13px;
  background: color-mix(in srgb, var(--app-accent-soft) 54%, var(--app-panel-subtle));
}

.progress-copy {
  display: flex;
  min-width: 0;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.progress-copy strong {
  overflow: hidden;
  color: var(--app-text-soft);
  font-size: 0.79rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress-copy span {
  color: var(--app-text-faint);
  font-size: 0.73rem;
  white-space: nowrap;
}

.progress-track {
  grid-column: 1 / -1;
  height: 4px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--app-border-strong) 70%, transparent);
}

.progress-track span {
  display: block;
  height: 100%;
  min-width: 4%;
  border-radius: inherit;
  background: var(--app-sig);
  transition: width 220ms var(--ease-out);
}

.progress-spinner {
  display: inline-block;
  width: 17px;
  height: 17px;
  border: 2px solid color-mix(in srgb, var(--app-accent) 25%, transparent);
  border-top-color: var(--app-accent-strong);
  border-radius: 50%;
  animation: memory-spin 0.8s linear infinite;
}

.memory-progress--error {
  display: flex;
  color: var(--app-danger);
  border-color: color-mix(in srgb, var(--app-danger) 36%, var(--app-border));
  background: var(--app-danger-soft);
  font-size: 0.78rem;
  line-height: 1.45;
}

.memory-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-height: 128px;
  color: var(--app-text-muted);
  font-size: 0.82rem;
}

.memory-empty {
  display: flex;
  flex-direction: column;
  min-height: 190px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 22px;
  border: 1px dashed var(--app-border-strong);
  border-radius: 15px;
  background: var(--app-panel-subtle);
  color: var(--app-text-muted);
  text-align: center;
}

.memory-empty strong {
  color: var(--app-text-soft);
  font-size: 0.86rem;
  font-weight: 600;
}

.empty-icon {
  display: grid;
  width: 40px;
  height: 40px;
  margin-bottom: 2px;
  place-items: center;
  border-radius: 13px;
  background: var(--app-accent-soft);
  color: var(--app-accent-strong);
}

.memory-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.memory-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-panel-subtle);
  transition: border-color var(--duration-base), background var(--duration-base), transform var(--duration-base), box-shadow var(--duration-base);
}

.memory-card:hover {
  border-color: color-mix(in srgb, var(--app-accent) 36%, var(--app-border));
  background: color-mix(in srgb, var(--app-panel-subtle) 65%, var(--app-accent-soft));
  box-shadow: var(--shadow-1);
  transform: translateY(-1px);
}

.memory-card.is-pinned {
  border-color: color-mix(in srgb, var(--app-warning) 34%, var(--app-border));
}

.memory-card-head,
.memory-card-title-wrap,
.memory-title-row,
.memory-meta,
.memory-actions,
.memory-tags {
  display: flex;
}

.memory-card-head {
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.memory-card-title-wrap {
  min-width: 0;
  align-items: flex-start;
  gap: 10px;
}

.memory-kind-icon {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  flex: 0 0 auto;
  border-radius: 10px;
  background: var(--app-accent-soft);
  color: var(--app-accent-strong);
}

.memory-card--user_trait .memory-kind-icon {
  background: color-mix(in srgb, #ec4899 16%, transparent);
  color: #ec4899;
}

.memory-card--agent_skill .memory-kind-icon {
  background: color-mix(in srgb, #8b5cf6 18%, transparent);
  color: #a78bfa;
}

.memory-card--step .memory-kind-icon {
  background: var(--app-success-soft);
  color: var(--app-success);
}

.memory-title-row {
  min-width: 0;
  align-items: center;
  gap: 7px;
}

.memory-title-row h4 {
  overflow: hidden;
  margin: 0;
  color: var(--app-text-strong);
  font-size: 0.88rem;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pin-badge,
.type-badge,
.scope-badge,
.scope-id {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  border-radius: var(--radius-pill);
  font-size: 0.68rem;
  line-height: 1.4;
  white-space: nowrap;
}

.pin-badge {
  gap: 3px;
  color: var(--app-warning);
}

.pin-badge svg {
  width: 12px;
  height: 12px;
}

.memory-meta {
  min-width: 0;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
  overflow: hidden;
}

.type-badge,
.scope-badge {
  padding: 2px 6px;
  border: 1px solid var(--app-border);
  background: var(--app-panel);
  color: var(--app-text-muted);
}

.scope-badge {
  color: var(--app-accent-strong);
}

.scope-id {
  overflow: hidden;
  color: var(--app-text-faint);
  text-overflow: ellipsis;
}

.memory-actions {
  gap: 5px;
  flex: 0 0 auto;
}

.card-icon-btn {
  width: 29px;
  height: 29px;
  border-radius: 9px;
}

.card-icon-btn.active {
  border-color: color-mix(in srgb, var(--app-warning) 55%, var(--app-border));
  background: var(--app-warning-soft);
  color: var(--app-warning);
}

.card-icon-btn.danger:hover {
  border-color: color-mix(in srgb, var(--app-danger) 55%, var(--app-border));
  background: var(--app-danger-soft);
  color: var(--app-danger);
}

.memory-summary {
  margin: 0;
  overflow-wrap: anywhere;
}

.memory-summary {
  color: var(--app-text);
  font-size: 0.82rem;
  line-height: 1.58;
}

.memory-tags {
  flex-wrap: wrap;
  gap: 5px;
  margin-top: auto;
}

.memory-tags span {
  max-width: 100%;
  overflow: hidden;
  padding: 3px 7px;
  border-radius: var(--radius-pill);
  background: var(--app-panel);
  color: var(--app-text-faint);
  font-size: 0.68rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes memory-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 1100px) {
  .memory-create-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .memory-create-summary {
    grid-column: 1 / -1;
  }
}

@media (max-width: 820px) {
  .memory-settings {
    padding: 22px 18px 28px;
  }

  .memory-overview,
  .memory-list {
    grid-template-columns: 1fr;
  }

  .memory-toolbar {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }

  .memory-filter-pill {
    grid-column: 1 / -1;
    max-width: none;
    width: fit-content;
  }

  .compact-model-bar {
    flex-direction: column;
    align-items: stretch;
  }

  .compact-model-controls {
    flex-wrap: wrap;
  }

  .compact-model-select {
    flex: 1 1 160px;
  }

  .memory-filter-row {
    grid-template-columns: 1fr 1fr;
  }

  .filter-actions {
    grid-column: 1 / -1;
    justify-content: flex-end;
  }
}

@media (max-width: 620px) {
  .memory-header,
  .entries-heading {
    align-items: flex-start;
  }

  .section-heading {
    flex-wrap: wrap;
  }

  .section-state {
    margin-left: 46px;
  }

  .section-actions {
    width: 100%;
    margin-left: 46px;
    flex-wrap: wrap;
  }

  .memory-toolbar {
    grid-template-columns: 1fr 1fr;
  }

  .memory-search-wrap {
    grid-column: 1 / -1;
  }

  .memory-filter-row,
  .memory-create-grid {
    grid-template-columns: 1fr;
  }

  .filter-actions {
    grid-column: auto;
    justify-content: stretch;
  }

  .filter-actions > * {
    flex: 1;
  }

  .memory-create-summary {
    grid-column: auto;
  }

  .progress-copy {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
  }
}
</style>
