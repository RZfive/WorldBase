<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ModelPricing } from '../../../main/ai-engine/cost-tracker'
import { resolveDefaultModelPricing } from '../../../main/ai-engine/cost-tracker'
import {
  PROVIDER_TEMPLATES,
  getProviderTemplate,
  getRecommendedProviderTemplate,
  looksLikeApiKey,
  type ProviderTemplate,
  type ProviderTemplateLinks
} from '../../../shared/provider-templates'
import MultiSelectDropdown from './MultiSelectDropdown.vue'

const props = defineProps<{
  /** Template id to open straight into "use this template"; consumed once. */
  useTemplate?: string | null
}>()

const emit = defineEmits<{
  (e: 'templateConsumed'): void
}>()

interface ModelPricingEntry {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
}

interface AIProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  /** '' = auto-detect (probe-based, cached in detectedApiProtocol). */
  apiProtocol?: '' | 'openai-chat' | 'openai-responses' | 'anthropic'
  /** Last successful probe-based detection result while apiProtocol is ''. */
  detectedApiProtocol?: 'openai-chat' | 'openai-responses' | 'anthropic'
  models: string[]
  modelContextWindows?: Record<string, number>
  modelPricing?: Record<string, ModelPricingEntry>
  modelCapabilities?: Record<string, { imageGeneration?: boolean; imageEditing?: boolean }>
  activeModel: string
  /** Embedding model catalog for semantic memory; separate from chat models. */
  embeddingModels?: ProviderEmbeddingModelRow[]
  enableThinking?: boolean
  temperature?: number
  /** Built-in template this provider was created from. */
  templateId?: string
  /** Snapshot of the template's website links at creation time. */
  links?: ProviderTemplateLinks
}

interface ProviderEmbeddingModelRow {
  id: string
  dimensions?: number
  maxInputTokens?: number
  distance?: 'cosine' | 'dot' | 'l2'
  normalized?: boolean
  queryPrefix?: string
  documentPrefix?: string
  enabled?: boolean
}

interface AIProvidersConfig {
  providers: AIProvider[]
  activeProviderId: string
  enabledProviderIds: string[]
}

interface CostSettings {
  modelPricing: Array<{ model: string } & ModelPricingEntry>
  budgetLimit: number | null
}

type PricingField = keyof ModelPricingEntry

const CONTEXT_WINDOW_UNIT = 1000
const CONTEXT_WINDOW_MILLION = 1_000_000
const DEFAULT_CONTEXT_WINDOW = 100000
const FEEDBACK_DISPLAY_DURATION_MS = 2200
const { t, te, locale } = useI18n()

const providers = ref<AIProvider[]>([])
const defaultProviderId = ref('')
const enabledProviderIds = ref<string[]>([])
const budgetLimit = ref('')
const saving = ref(false)
const statusMsg = ref('')
const showKey = ref<Record<string, boolean>>({})
const newModelInput = ref('')
const newEmbeddingModelInput = ref('')
const newEmbeddingDimensionsInput = ref('')
const embeddingTestState = ref<Record<string, { running: boolean; ok?: boolean; dimensions?: number; latencyMs?: number; error?: string }>>({})
const searchQuery = ref('')
const selectedProviderId = ref('')
const editing = ref(false)
const editDraft = ref<AIProvider | null>(null)
const remoteModels = ref<string[]>([])
const selectedRemoteModels = ref<string[]>([])
const remoteModelsLoading = ref(false)
const remoteModelsError = ref('')
let remoteModelsTimer: number | undefined
let remoteModelsRequestId = 0
const detectionBusy = ref(false)
const detectionFailed = ref(false)
const detectionStatusMessage = ref('')
let lastDetectionKey = ''

// ── Built-in templates ───────────────────────────────────────────────────
// Read-only, listed apart from the user's providers. "Use" copies one into a
// real provider whose only missing field is the API key.
const selectedTemplateId = ref('')
const selectedTemplate = computed(() => selectedTemplateId.value ? getProviderTemplate(selectedTemplateId.value) ?? null : null)
const recommendedTemplate = computed(() => getRecommendedProviderTemplate())
/** Set after "Get a key" opened the vendor site; the next window focus checks the clipboard. */
const awaitingKeyFromWeb = ref(false)
const clipboardKeyCandidate = ref('')
const ignoredClipboardKeys = new Set<string>()
const keyInputRef = ref<HTMLInputElement | null>(null)

const filteredTemplates = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  const list = [...PROVIDER_TEMPLATES].sort((a, b) => a.order - b.order)
  if (!query) return list
  return list.filter(template =>
    template.name.toLowerCase().includes(query)
    || template.baseUrl.toLowerCase().includes(query)
    || template.models.some(model => model.id.toLowerCase().includes(query))
  )
})

function templateTagline (template: ProviderTemplate): string {
  const key = `settings.provider.templates.${template.id}.tagline`
  return te(key) ? t(key) : ''
}

function templateUsageCount (templateId: string): number {
  return providers.value.filter(provider => provider.templateId === templateId).length
}

function editDraftTemplate (): ProviderTemplate | null {
  const id = editDraft.value?.templateId
  return id ? getProviderTemplate(id) ?? null : null
}

/** Address or protocol no longer match the template the provider came from. */
const driftedFromTemplate = computed(() => {
  const draft = editDraft.value
  const template = editDraftTemplate()
  if (!draft || !template) return false
  return draft.baseUrl.trim() !== template.baseUrl || (draft.apiProtocol || '') !== template.apiProtocol
})

const editKeyPlaceholder = computed(() => editDraftTemplate()?.apiKeyPlaceholder || 'sk-...')
const editLinks = computed<ProviderTemplateLinks | null>(() => editDraft.value?.links || editDraftTemplate()?.links || null)

function uniqueProviderName (base: string): string {
  const taken = new Set(providers.value.map(provider => provider.name.trim().toLowerCase()))
  if (!taken.has(base.trim().toLowerCase())) return base
  for (let index = 2; index < 100; index++) {
    const candidate = `${base} ${index}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${base} ${Date.now().toString(36)}`
}

function selectTemplate (id: string) {
  if (editing.value) return
  selectedTemplateId.value = id
  selectedProviderId.value = ''
}

/** Copy a template into a fresh provider draft; the user only has to paste a key. */
function useTemplate (template: ProviderTemplate) {
  if (editing.value) return
  const modelContextWindows: Record<string, number> = {}
  const modelPricing: Record<string, ModelPricingEntry> = {}
  const modelCapabilities: NonNullable<AIProvider['modelCapabilities']> = {}
  for (const model of template.models) {
    modelContextWindows[model.id] = model.contextWindow
    modelPricing[model.id] = clonePricing(model.pricing || getDefaultPricing(model.id))
    modelCapabilities[model.id] = {
      imageGeneration: model.capabilities?.imageGeneration === true,
      imageEditing: model.capabilities?.imageEditing === true
    }
  }
  const id = `${template.id}_${Date.now().toString(36)}`
  editDraft.value = {
    id,
    name: uniqueProviderName(template.name),
    baseUrl: template.baseUrl,
    apiKey: '',
    apiProtocol: template.apiProtocol,
    models: template.models.map(model => model.id),
    modelContextWindows,
    modelPricing,
    modelCapabilities,
    activeModel: template.defaultModel,
    enableThinking: false,
    templateId: template.id,
    links: { ...template.links }
  }
  selectedTemplateId.value = ''
  selectedProviderId.value = id
  editing.value = true
  newModelInput.value = ''
  resetRemoteModels()
  window.setTimeout(() => keyInputRef.value?.focus(), 0)
}

function restoreTemplateDefaults () {
  const draft = editDraft.value
  const template = editDraftTemplate()
  if (!draft || !template) return
  draft.baseUrl = template.baseUrl
  draft.apiProtocol = template.apiProtocol
  draft.links = { ...template.links }
}

async function openProviderLink (url: string | undefined, awaitKey = false) {
  if (!url || !window.electronAPI?.openExternalUrl) return
  try {
    const result = await window.electronAPI.openExternalUrl(url)
    if (!result.ok) {
      statusMsg.value = t('settings.provider.openExternalFailed')
      return
    }
    if (awaitKey) awaitingKeyFromWeb.value = true
  } catch {
    statusMsg.value = t('settings.provider.openExternalFailed')
  }
}

function openKeyPage () {
  const links = editLinks.value
  void openProviderLink(links?.apiKeys || links?.console || links?.homepage, true)
}

/** Back from the vendor site: offer to fill the key if the clipboard holds one. Never auto-fills. */
async function checkClipboardForKey () {
  if (!awaitingKeyFromWeb.value || !editing.value || !editDraft.value) return
  let text = ''
  try {
    text = (await navigator.clipboard?.readText?.()) || ''
  } catch {
    return
  }
  const candidate = text.trim()
  if (!candidate || ignoredClipboardKeys.has(candidate)) return
  if (!looksLikeApiKey(candidate, editDraftTemplate())) return
  if (editDraft.value.apiKey.trim() === candidate) return
  clipboardKeyCandidate.value = candidate
}

function fillClipboardKey () {
  if (!editDraft.value || !clipboardKeyCandidate.value) return
  editDraft.value.apiKey = clipboardKeyCandidate.value
  clipboardKeyCandidate.value = ''
  awaitingKeyFromWeb.value = false
}

function ignoreClipboardKey () {
  if (clipboardKeyCandidate.value) ignoredClipboardKeys.add(clipboardKeyCandidate.value)
  clipboardKeyCandidate.value = ''
}

function onWindowFocus () {
  void checkClipboardForKey()
}

watch(() => props.useTemplate, (id) => {
  if (!id) return
  const template = getProviderTemplate(id)
  if (template) {
    if (editing.value) cancelEdit()
    useTemplate(template)
  }
  emit('templateConsumed')
}, { immediate: true })

const filteredProviders = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return providers.value

  return providers.value.filter(provider => {
    return provider.name.toLowerCase().includes(query)
      || provider.baseUrl.toLowerCase().includes(query)
      || provider.models.some(model => model.toLowerCase().includes(query))
  })
})

const selectedProvider = computed(() => {
  return providers.value.find(provider => provider.id === selectedProviderId.value) ?? null
})

const editingProviderLabel = computed(() => {
  if (!editDraft.value) return t('settings.provider.addProvider')
  return providers.value.some(provider => provider.id === editDraft.value!.id)
    ? t('settings.provider.editProvider')
    : t('settings.provider.addProvider')
})

const remoteModelOptions = computed(() => {
  const configured = new Set(editDraft.value?.models ?? [])
  return remoteModels.value
    .filter(model => !configured.has(model))
    .map(model => ({ value: model, label: model }))
})

/** Trigger text for the remote-model picker; says so when every fetched model is already configured. */
const remoteModelsPlaceholder = computed(() => {
  if (remoteModelsLoading.value) return t('settings.provider.remoteModelsLoading')
  if (remoteModels.value.length > 0 && remoteModelOptions.value.length === 0) return t('settings.provider.remoteModelsAllAdded')
  return t('settings.provider.remoteModelsPlaceholder')
})

/** Select proxy with '' meaning "auto-detect via protocol probing". */
const editApiProtocol = computed<'' | 'openai-chat' | 'openai-responses' | 'anthropic'>({
  get: () => editDraft.value?.apiProtocol ?? '',
  set: (value) => {
    if (editDraft.value) {
      editDraft.value.apiProtocol = value
    }
  }
})

function protocolDisplayName (protocol: 'openai-chat' | 'openai-responses' | 'anthropic'): string {
  if (protocol === 'anthropic') return t('settings.provider.apiProtocolAnthropic')
  if (protocol === 'openai-responses') return t('settings.provider.apiProtocolOpenAIResponses')
  return t('settings.provider.apiProtocolOpenAIChat')
}

function providerProtocolLabel (provider: AIProvider): string {
  if (provider.apiProtocol === 'anthropic') return t('settings.provider.apiProtocolAnthropic')
  if (provider.apiProtocol === 'openai-responses') return t('settings.provider.apiProtocolOpenAIResponses')
  if (provider.apiProtocol === 'openai-chat') return t('settings.provider.apiProtocolOpenAIChat')
  if (provider.detectedApiProtocol) {
    return `${t('settings.provider.apiProtocolAuto')} · ${protocolDisplayName(provider.detectedApiProtocol)}`
  }
  return t('settings.provider.apiProtocolAuto')
}

onMounted(async () => {
  window.addEventListener('focus', onWindowFocus)
  await loadSettings()
})

onBeforeUnmount(() => {
  window.removeEventListener('focus', onWindowFocus)
  if (remoteModelsTimer !== undefined) window.clearTimeout(remoteModelsTimer)
  remoteModelsRequestId += 1
})

watch(
  () => [editDraft.value?.baseUrl.trim() ?? '', editDraft.value?.apiKey.trim() ?? '', editDraft.value?.apiProtocol ?? ''],
  ([baseUrl, apiKey]) => {
    if (remoteModelsTimer !== undefined) window.clearTimeout(remoteModelsTimer)
    remoteModelsRequestId += 1
    remoteModels.value = []
    selectedRemoteModels.value = []
    remoteModelsError.value = ''
    remoteModelsLoading.value = false
    if (!editing.value || !baseUrl || !apiKey) return
    remoteModelsTimer = window.setTimeout(() => void fetchRemoteModels(), 700)
  }
)

// A cached detection result is only valid for the exact endpoint + key it
// probed; clear it as soon as either changes. The opening transition (empty
// sentinel → loaded values) must not clear a pinned result.
watch(
  () => [editDraft.value?.baseUrl.trim() ?? '', editDraft.value?.apiKey.trim() ?? ''],
  ([baseUrl, apiKey], [prevBaseUrl, prevApiKey]) => {
    if (!prevBaseUrl && !prevApiKey) return
    if (baseUrl === prevBaseUrl && apiKey === prevApiKey) return
    if (editDraft.value) editDraft.value.detectedApiProtocol = undefined
    detectionBusy.value = false
    detectionFailed.value = false
    detectionStatusMessage.value = ''
    lastDetectionKey = ''
  }
)

async function fetchRemoteModels () {
  const draft = editDraft.value
  if (!draft?.baseUrl.trim() || !draft.apiKey.trim() || !window.electronAPI?.fetchProviderModels) return

  if (remoteModelsTimer !== undefined) {
    window.clearTimeout(remoteModelsTimer)
    remoteModelsTimer = undefined
  }
  const requestId = ++remoteModelsRequestId
  remoteModelsLoading.value = true
  remoteModelsError.value = ''
  try {
    const result = await window.electronAPI.fetchProviderModels({
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      apiProtocol: draft.apiProtocol || draft.detectedApiProtocol || ''
    })
    if (requestId !== remoteModelsRequestId) return
    remoteModels.value = result.models
    selectedRemoteModels.value = []
    // With models available the auto protocol can be probed and pinned.
    void runDetection('auto')
  } catch (err) {
    if (requestId !== remoteModelsRequestId) return
    remoteModels.value = []
    selectedRemoteModels.value = []
    remoteModelsError.value = (err as Error).message
  } finally {
    if (requestId === remoteModelsRequestId) remoteModelsLoading.value = false
  }
}

/**
 * Probe-based protocol detection: the Rust harness sends the minimal message
 * "hi" through Responses → Chat Completions → Anthropic and pins the first
 * protocol that answers correctly.
 */
async function runDetection (trigger: 'auto' | 'manual') {
  const draft = editDraft.value
  if (!draft || detectionBusy.value) return
  // Detection only applies to the auto mode; an explicit protocol wins.
  if (draft.apiProtocol) return
  if (!window.electronAPI?.detectProviderProtocol) {
    if (trigger === 'manual') {
      detectionFailed.value = true
      detectionStatusMessage.value = t('settings.provider.detectUnavailable')
    }
    return
  }
  const baseUrl = draft.baseUrl.trim()
  const apiKey = draft.apiKey.trim()
  const model = draft.activeModel || draft.models[0] || remoteModels.value[0] || ''
  if (trigger === 'manual' && (!baseUrl || !apiKey || !model)) {
    detectionFailed.value = true
    detectionStatusMessage.value = t('settings.provider.detectNeedsInput')
    return
  }
  if (!baseUrl || !apiKey || !model) return
  const key = `${baseUrl}|${apiKey}|${model}`
  if (trigger === 'auto' && key === lastDetectionKey) return
  lastDetectionKey = key

  detectionBusy.value = true
  detectionFailed.value = false
  detectionStatusMessage.value = ''
  try {
    const result = await window.electronAPI.detectProviderProtocol({ baseUrl, apiKey, model })
    if (result.protocol) {
      draft.detectedApiProtocol = result.protocol
      detectionStatusMessage.value = t('settings.provider.detectedAs', { protocol: protocolDisplayName(result.protocol) })
    } else {
      draft.detectedApiProtocol = undefined
      detectionFailed.value = true
      const failures = result.probes
        .filter(probe => !probe.ok && probe.error)
        .map(probe => `${protocolLabelShort(probe.protocol)}: ${probe.error}`)
        .join(' · ')
      detectionStatusMessage.value = t('settings.provider.detectFailed', { detail: failures || t('settings.provider.detectFailedNoDetail') })
    }
  } catch (err) {
    draft.detectedApiProtocol = undefined
    detectionFailed.value = true
    detectionStatusMessage.value = (err as Error).message
  } finally {
    detectionBusy.value = false
  }
}

function protocolLabelShort (protocol: string): string {
  if (protocol === 'anthropic') return 'Anthropic'
  if (protocol === 'openai-responses') return 'Responses'
  if (protocol === 'openai-chat') return 'Chat Completions'
  return protocol || '?'
}

function clonePricing (pricing?: Partial<ModelPricing> | Partial<ModelPricingEntry>): ModelPricingEntry {
  return {
    inputPerMillion: Number.isFinite(Number(pricing?.inputPerMillion)) ? Number(pricing?.inputPerMillion) : 0,
    outputPerMillion: Number.isFinite(Number(pricing?.outputPerMillion)) ? Number(pricing?.outputPerMillion) : 0,
    cacheReadPerMillion: Number.isFinite(Number(pricing?.cacheReadPerMillion)) ? Number(pricing?.cacheReadPerMillion) : 0
  }
}

function getDefaultPricing (model: string): ModelPricingEntry {
  return clonePricing(resolveDefaultModelPricing(model))
}

function buildPricingMap (settings: CostSettings): Record<string, ModelPricingEntry> {
  return settings.modelPricing.reduce<Record<string, ModelPricingEntry>>((acc, entry) => {
    if (!entry.model) return acc
    acc[entry.model] = clonePricing(entry)
    return acc
  }, {})
}

function hydrateProvider (provider: AIProvider, pricingMap: Record<string, ModelPricingEntry>): AIProvider {
  const modelPricing: Record<string, ModelPricingEntry> = {}
  const modelCapabilities: NonNullable<AIProvider['modelCapabilities']> = {}
  for (const model of provider.models) {
    modelPricing[model] = clonePricing(pricingMap[model] || provider.modelPricing?.[model] || getDefaultPricing(model))
    modelCapabilities[model] = {
      imageGeneration: provider.modelCapabilities?.[model]?.imageGeneration === true,
      imageEditing: provider.modelCapabilities?.[model]?.imageEditing === true
    }
  }

  return {
    ...provider,
    models: [...provider.models],
    modelContextWindows: { ...(provider.modelContextWindows || {}) },
    modelCapabilities,
    modelPricing,
    embeddingModels: (provider.embeddingModels || []).map(row => ({ ...row }))
  }
}

async function loadSettings () {
  if (!window.electronAPI?.getProviders || !window.electronAPI?.getCostSettings) return

  try {
    const [providersConfig, costSettings] = await Promise.all([
      window.electronAPI.getProviders(),
      window.electronAPI.getCostSettings()
    ])

    const pricingMap = buildPricingMap(costSettings)
    providers.value = providersConfig.providers.map(provider => hydrateProvider(provider, pricingMap))
    defaultProviderId.value = providersConfig.activeProviderId
    enabledProviderIds.value = [...providersConfig.enabledProviderIds]
    budgetLimit.value = costSettings.budgetLimit != null ? String(costSettings.budgetLimit) : ''

    if (providers.value.length > 0) {
      if (!selectedTemplateId.value && !editing.value && !providers.value.some(provider => provider.id === selectedProviderId.value)) {
        selectedProviderId.value = providers.value[0].id
      }
    } else if (!editing.value) {
      selectedProviderId.value = ''
    }
  } catch (err) {
    statusMsg.value = t('settings.provider.loadFailed', { message: (err as Error).message })
  }
}

function isEnabled (id: string): boolean {
  return enabledProviderIds.value.includes(id)
}

function isDefault (id: string): boolean {
  return defaultProviderId.value === id
}

function getOrderedEnabledIds (nextIds: string[]): string[] {
  return Array.from(new Set(nextIds.filter(id => providers.value.some(provider => provider.id === id))))
}

function selectProvider (id: string) {
  if (editing.value) return
  selectedTemplateId.value = ''
  selectedProviderId.value = id
}

function startAdd () {
  const id = 'provider_' + Date.now().toString(36)
  editDraft.value = {
    id,
    name: '',
    baseUrl: '',
    apiKey: '',
    models: [],
    modelContextWindows: {},
    modelPricing: {},
    modelCapabilities: {},
    embeddingModels: [],
    activeModel: '',
    enableThinking: false
  }
  selectedTemplateId.value = ''
  selectedProviderId.value = id
  editing.value = true
  newModelInput.value = ''
  resetRemoteModels()
}

function startEdit () {
  const provider = selectedProvider.value
  if (!provider) return

  const modelPricing: Record<string, ModelPricingEntry> = {}
  const modelCapabilities: NonNullable<AIProvider['modelCapabilities']> = {}
  for (const model of provider.models) {
    modelPricing[model] = clonePricing(provider.modelPricing?.[model] || getDefaultPricing(model))
    modelCapabilities[model] = {
      imageGeneration: provider.modelCapabilities?.[model]?.imageGeneration === true,
      imageEditing: provider.modelCapabilities?.[model]?.imageEditing === true
    }
  }

  editDraft.value = {
    ...provider,
    models: [...provider.models],
    modelContextWindows: { ...(provider.modelContextWindows || {}) },
    modelCapabilities,
    modelPricing,
    embeddingModels: (provider.embeddingModels || []).map(row => ({ ...row }))
  }
  editing.value = true
  newModelInput.value = ''
  newEmbeddingModelInput.value = ''
  resetRemoteModels()
}

function cancelEdit () {
  const draftId = editDraft.value?.id
  if (draftId && !providers.value.find(provider => provider.id === draftId)) {
    selectedProviderId.value = providers.value[0]?.id || ''
  }
  editDraft.value = null
  editing.value = false
  newModelInput.value = ''
  awaitingKeyFromWeb.value = false
  clipboardKeyCandidate.value = ''
  resetRemoteModels()
}

function addModelByName (model: string): boolean {
  if (!editDraft.value || !model) return false
  if (editDraft.value.models.includes(model)) {
    return false
  }

  editDraft.value.models.push(model)
  if (!editDraft.value.modelContextWindows) editDraft.value.modelContextWindows = {}
  if (!editDraft.value.modelPricing) editDraft.value.modelPricing = {}
  if (!editDraft.value.modelCapabilities) editDraft.value.modelCapabilities = {}
  editDraft.value.modelContextWindows[model] = DEFAULT_CONTEXT_WINDOW
  editDraft.value.modelPricing[model] = getDefaultPricing(model)
  editDraft.value.modelCapabilities[model] = { imageGeneration: false, imageEditing: false }
  if (!editDraft.value.activeModel) editDraft.value.activeModel = model
  return true
}

function addModel () {
  const model = newModelInput.value.trim()
  if (!model) return
  if (!addModelByName(model)) {
    statusMsg.value = t('settings.provider.modelExists')
    return
  }
  newModelInput.value = ''
  statusMsg.value = ''
}

function addSelectedRemoteModels () {
  let added = 0
  for (const model of selectedRemoteModels.value) {
    if (addModelByName(model)) added += 1
  }
  selectedRemoteModels.value = []
  statusMsg.value = added > 0 ? t('settings.provider.remoteModelsAdded', { count: added }) : ''
}

function resetRemoteModels () {
  if (remoteModelsTimer !== undefined) {
    window.clearTimeout(remoteModelsTimer)
    remoteModelsTimer = undefined
  }
  remoteModelsRequestId += 1
  remoteModels.value = []
  selectedRemoteModels.value = []
  remoteModelsLoading.value = false
  remoteModelsError.value = ''
}

function removeModel (index: number) {
  if (!editDraft.value) return

  const removed = editDraft.value.models.splice(index, 1)[0]
  if (editDraft.value.modelContextWindows) delete editDraft.value.modelContextWindows[removed]
  if (editDraft.value.modelPricing) delete editDraft.value.modelPricing[removed]
  if (editDraft.value.modelCapabilities) delete editDraft.value.modelCapabilities[removed]
  if (editDraft.value.activeModel === removed) {
    editDraft.value.activeModel = editDraft.value.models[0] || ''
  }
}

function getCtx (provider: AIProvider, model: string): number {
  const value = provider.modelContextWindows?.[model]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_CONTEXT_WINDOW
}

function getCtxInK (provider: AIProvider, model: string): number {
  return getCtx(provider, model) / CONTEXT_WINDOW_UNIT
}

function handleCtxInput (model: string, event: Event) {
  if (!editDraft.value) return
  const parsed = Number.parseFloat((event.target as HTMLInputElement).value)
  if (!editDraft.value.modelContextWindows) editDraft.value.modelContextWindows = {}
  editDraft.value.modelContextWindows[model] = Number.isFinite(parsed) && parsed > 0
    ? Math.round(parsed * CONTEXT_WINDOW_UNIT)
    : DEFAULT_CONTEXT_WINDOW
}

function getPricing (provider: AIProvider, model: string): ModelPricingEntry {
  return clonePricing(provider.modelPricing?.[model] || getDefaultPricing(model))
}

function getModelCapabilities (provider: AIProvider, model: string): { imageGeneration: boolean; imageEditing: boolean } {
  return {
    imageGeneration: provider.modelCapabilities?.[model]?.imageGeneration === true,
    imageEditing: provider.modelCapabilities?.[model]?.imageEditing === true
  }
}

function toggleModelCapability (model: string, field: 'imageGeneration' | 'imageEditing') {
  if (!editDraft.value) return
  if (!editDraft.value.modelCapabilities) editDraft.value.modelCapabilities = {}
  const current = getModelCapabilities(editDraft.value, model)
  const next = !current[field]
  editDraft.value.modelCapabilities[model] = {
    ...current,
    [field]: next,
    ...(field === 'imageGeneration' && !next ? { imageEditing: false } : {})
  }
}

function parsePricingNumber (value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function clampTemperature (value: number): number {
  return Math.min(Math.max(value, 0), 2)
}

function handleTemperatureSlider (event: Event) {
  if (!editDraft.value) return
  const value = Number.parseFloat((event.target as HTMLInputElement).value)
  editDraft.value.temperature = Number.isFinite(value) ? clampTemperature(value) : undefined
}

function handleTemperatureNumber (event: Event) {
  if (!editDraft.value) return
  const raw = (event.target as HTMLInputElement).value.trim()
  if (raw === '') {
    editDraft.value.temperature = undefined
    return
  }
  const value = Number.parseFloat(raw)
  editDraft.value.temperature = Number.isFinite(value) ? clampTemperature(value) : undefined
}

function clearTemperature () {
  if (editDraft.value) editDraft.value.temperature = undefined
}

function formatTemperature (value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : t('settings.provider.defaultTemperature')
}

function handlePricingInput (model: string, field: PricingField, event: Event) {
  if (!editDraft.value) return
  if (!editDraft.value.modelPricing) editDraft.value.modelPricing = {}

  editDraft.value.modelPricing[model] = {
    ...getPricing(editDraft.value, model),
    [field]: parsePricingNumber((event.target as HTMLInputElement).value)
  }
}

function syncPricingAcrossProviders (model: string, pricing: ModelPricingEntry) {
  for (const provider of providers.value) {
    if (!provider.models.includes(model)) continue
    if (!provider.modelPricing) provider.modelPricing = {}
    provider.modelPricing[model] = clonePricing(pricing)
  }
}

function parseBudgetLimit (): number | null {
  const parsed = Number.parseFloat(budgetLimit.value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function isDefaultPricing (model: string, pricing: ModelPricingEntry): boolean {
  const defaultPricing = getDefaultPricing(model)
  return pricing.inputPerMillion === defaultPricing.inputPerMillion
    && pricing.outputPerMillion === defaultPricing.outputPerMillion
    && pricing.cacheReadPerMillion === defaultPricing.cacheReadPerMillion
}

function buildPersistedCostSettings (): CostSettings {
  const pricingByModel = new Map<string, ModelPricingEntry>()

  for (const provider of providers.value) {
    for (const model of provider.models) {
      pricingByModel.set(model, getPricing(provider, model))
    }
  }

  return {
    modelPricing: Array.from(pricingByModel.entries())
      .map(([model, pricing]) => ({ model, ...clonePricing(pricing) }))
      .filter(entry => !isDefaultPricing(entry.model, entry))
      .sort((left, right) => left.model.localeCompare(right.model)),
    budgetLimit: parseBudgetLimit()
  }
}

async function saveAll (successMessage = t('settings.provider.saved')) {
  if (!window.electronAPI?.saveProviders || !window.electronAPI?.saveCostSettings) return

  saving.value = true
  statusMsg.value = ''

  try {
    const providerPayload = providers.value.map(({ modelPricing, ...provider }) => ({
      ...provider,
      models: [...provider.models],
      modelContextWindows: { ...(provider.modelContextWindows || {}) },
      embeddingModels: provider.embeddingModels ? [...provider.embeddingModels] : undefined
    }))

    await Promise.all([
      window.electronAPI.saveProviders(JSON.parse(JSON.stringify({
        providers: providerPayload,
        activeProviderId: defaultProviderId.value,
        enabledProviderIds: enabledProviderIds.value
      } satisfies AIProvidersConfig))),
      window.electronAPI.saveCostSettings(buildPersistedCostSettings())
    ])

    statusMsg.value = successMessage
  } catch (err) {
    statusMsg.value = t('common.saveFailed', { message: (err as Error).message })
  } finally {
    saving.value = false
    window.setTimeout(() => {
      statusMsg.value = ''
    }, FEEDBACK_DISPLAY_DURATION_MS)
  }
}

async function saveBudgetOnly () {
  await saveAll(t('settings.provider.budgetSaved'))
}

function addEmbeddingModel () {
  if (!editDraft.value) return
  const id = newEmbeddingModelInput.value.trim()
  if (!id) {
    statusMsg.value = t('settings.provider.embeddingIdRequired')
    return
  }
  if (!editDraft.value.embeddingModels) editDraft.value.embeddingModels = []
  if (editDraft.value.embeddingModels.some(row => row.id === id)) {
    statusMsg.value = t('settings.provider.embeddingIdDuplicate')
    return
  }
  const dimensions = Number.parseInt(newEmbeddingDimensionsInput.value, 10)
  editDraft.value.embeddingModels.push({
    id,
    ...(Number.isFinite(dimensions) && dimensions > 0 ? { dimensions } : {})
  })
  newEmbeddingModelInput.value = ''
  newEmbeddingDimensionsInput.value = ''
}

function removeEmbeddingModel (index: number) {
  if (!editDraft.value?.embeddingModels) return
  const removed = editDraft.value.embeddingModels.splice(index, 1)[0]
  if (removed) delete embeddingTestState.value[removed.id]
}

function handleEmbeddingDimensionsInput (id: string, event: Event) {
  if (!editDraft.value?.embeddingModels) return
  const row = editDraft.value.embeddingModels.find(item => item.id === id)
  if (!row) return
  const parsed = Number.parseInt((event.target as HTMLInputElement).value, 10)
  if (Number.isFinite(parsed) && parsed > 0) row.dimensions = parsed
  else delete row.dimensions
}

async function testEmbeddingModel (modelId: string) {
  const providerId = editDraft.value?.id
  if (!providerId || embeddingTestState.value[modelId]?.running) return
  embeddingTestState.value = {
    ...embeddingTestState.value,
    [modelId]: { running: true }
  }
  try {
    const result = await window.electronAPI?.testEmbeddingModel?.({ providerId, modelId })
    if (!result) {
      embeddingTestState.value = { ...embeddingTestState.value, [modelId]: { running: false, ok: false, error: 'IPC unavailable' } }
      return
    }
    embeddingTestState.value = {
      ...embeddingTestState.value,
      [modelId]: { running: false, ok: result.ok, dimensions: result.dimensions, latencyMs: result.latencyMs, error: result.error }
    }
  } catch (err) {
    embeddingTestState.value = {
      ...embeddingTestState.value,
      [modelId]: { running: false, ok: false, error: (err as Error).message }
    }
  }
}

async function saveEdit () {
  if (!editDraft.value) return

  const nextProvider = editDraft.value
  if (!nextProvider.name.trim()) {
    statusMsg.value = t('settings.provider.requiredName')
    return
  }
  if (!nextProvider.baseUrl.trim()) {
    statusMsg.value = t('settings.provider.requiredUrl')
    return
  }
  if (nextProvider.models.length === 0) {
    statusMsg.value = t('settings.provider.requiredModel')
    return
  }
  if (!nextProvider.models.includes(nextProvider.activeModel)) {
    nextProvider.activeModel = nextProvider.models[0]
  }
  if (!nextProvider.modelContextWindows) nextProvider.modelContextWindows = {}
  if (!nextProvider.modelPricing) nextProvider.modelPricing = {}
  if (!nextProvider.modelCapabilities) nextProvider.modelCapabilities = {}

  for (const model of nextProvider.models) {
    nextProvider.modelContextWindows[model] = getCtx(nextProvider, model)
    nextProvider.modelPricing[model] = getPricing(nextProvider, model)
    nextProvider.modelCapabilities[model] = getModelCapabilities(nextProvider, model)
  }

  const normalizedProvider: AIProvider = {
    ...nextProvider,
    models: [...nextProvider.models],
    modelContextWindows: { ...(nextProvider.modelContextWindows || {}) },
    modelCapabilities: Object.fromEntries(nextProvider.models.map(model => [model, getModelCapabilities(nextProvider, model)])),
    modelPricing: Object.fromEntries(nextProvider.models.map(model => [model, getPricing(nextProvider, model)])),
    embeddingModels: nextProvider.embeddingModels ? nextProvider.embeddingModels.map(row => ({ ...row })) : undefined
  }

  const index = providers.value.findIndex(provider => provider.id === normalizedProvider.id)
  if (index >= 0) providers.value[index] = normalizedProvider
  else providers.value.push(normalizedProvider)

  for (const model of normalizedProvider.models) {
    syncPricingAcrossProviders(model, getPricing(normalizedProvider, model))
  }

  if (!enabledProviderIds.value.includes(normalizedProvider.id)) {
    enabledProviderIds.value = getOrderedEnabledIds([...enabledProviderIds.value, normalizedProvider.id])
  }
  if (!defaultProviderId.value) defaultProviderId.value = normalizedProvider.id

  selectedProviderId.value = normalizedProvider.id
  editDraft.value = null
  editing.value = false
  newModelInput.value = ''
  awaitingKeyFromWeb.value = false
  clipboardKeyCandidate.value = ''
  resetRemoteModels()
  await saveAll()
}

async function deleteProvider (id: string) {
  providers.value = providers.value.filter(provider => provider.id !== id)
  enabledProviderIds.value = enabledProviderIds.value.filter(providerId => providerId !== id)

  if (defaultProviderId.value === id) {
    defaultProviderId.value = enabledProviderIds.value[0] || providers.value[0]?.id || ''
  }
  if (defaultProviderId.value && !enabledProviderIds.value.includes(defaultProviderId.value)) {
    enabledProviderIds.value = getOrderedEnabledIds([defaultProviderId.value, ...enabledProviderIds.value])
  }
  if (selectedProviderId.value === id) selectedProviderId.value = providers.value[0]?.id || ''

  editing.value = false
  editDraft.value = null
  await saveAll(t('settings.provider.deleted'))
}

async function toggleEnabled (id: string) {
  if (isEnabled(id)) {
    if (enabledProviderIds.value.length <= 1) {
      statusMsg.value = t('settings.provider.keepOneEnabled')
      return
    }
    enabledProviderIds.value = enabledProviderIds.value.filter(providerId => providerId !== id)
    if (defaultProviderId.value === id) {
      defaultProviderId.value = enabledProviderIds.value[0] || ''
    }
  } else {
    enabledProviderIds.value = getOrderedEnabledIds([...enabledProviderIds.value, id])
    if (!defaultProviderId.value) {
      defaultProviderId.value = id
    }
  }

  statusMsg.value = ''
  await saveAll(t('settings.provider.enabledUpdated'))
}

async function setDefault (id: string) {
  defaultProviderId.value = id
  if (!enabledProviderIds.value.includes(id)) {
    enabledProviderIds.value = getOrderedEnabledIds([id, ...enabledProviderIds.value])
  }
  await saveAll(t('settings.provider.defaultUpdated'))
}

function toggleKey (id: string) {
  showKey.value[id] = !showKey.value[id]
}

function maskKey (key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '••••••••'
  return key.substring(0, 4) + '••••' + key.substring(key.length - 4)
}

function formatPricing (value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0/M'
  const digits = value >= 1 ? 2 : 4
  return `$${value.toFixed(digits).replace(/\.?0+$/, '')}/M`
}

function formatContextWindow (value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return t('settings.provider.contextWindowK', { count: DEFAULT_CONTEXT_WINDOW / CONTEXT_WINDOW_UNIT })
  }
  if (value % CONTEXT_WINDOW_MILLION === 0) {
    return t('settings.provider.contextWindowM', { count: value / CONTEXT_WINDOW_MILLION })
  }
  if (value % CONTEXT_WINDOW_UNIT === 0) {
    return t('settings.provider.contextWindowK', { count: value / CONTEXT_WINDOW_UNIT })
  }
  return t('settings.provider.contextWindowTokens', { count: value.toLocaleString(locale.value) })
}
</script>

<template>
  <div class="pp-root">
    <div class="pp-list">
      <div class="pp-list-top">
        <input v-model="searchQuery" type="text" class="pp-search" :placeholder="$t('settings.provider.searchPlaceholder')" />
      </div>

      <div class="pp-providers">
        <div class="pp-group-label">{{ $t('settings.provider.sections.mine') }}</div>
        <button
          v-for="provider in filteredProviders"
          :key="provider.id"
          :class="['pp-item', { active: selectedProviderId === provider.id && !selectedTemplateId }]"
          @click="selectProvider(provider.id)"
        >
          <span class="pp-item-name">{{ provider.name || $t('settings.provider.unnamed') }}</span>
          <span class="pp-item-badges">
            <span v-if="provider.templateId" class="pp-template-badge" :title="$t('settings.provider.templates.badgeHint')">{{ $t('settings.provider.templates.badge') }}</span>
            <span v-if="isEnabled(provider.id)" class="pp-on-badge">{{ $t('settings.provider.on') }}</span>
            <span v-if="isDefault(provider.id)" class="pp-default-badge">{{ $t('settings.provider.default') }}</span>
          </span>
        </button>
        <p v-if="providers.length === 0" class="pp-group-empty">{{ $t('settings.provider.mineEmpty') }}</p>

        <div class="pp-group-label">{{ $t('settings.provider.sections.templates') }}</div>
        <div
          v-for="template in filteredTemplates"
          :key="template.id"
          :class="['pp-item', 'pp-item-template', { active: selectedTemplateId === template.id }]"
          role="button"
          tabindex="0"
          @click="selectTemplate(template.id)"
          @keydown.enter.prevent="selectTemplate(template.id)"
        >
          <span class="pp-item-name">{{ template.name }}</span>
          <span class="pp-item-badges">
            <span v-if="template.recommended" class="pp-default-badge">{{ $t('settings.provider.templates.recommended') }}</span>
            <button
              type="button"
              class="pp-use-btn"
              :disabled="editing"
              :title="templateUsageCount(template.id) > 0 ? $t('settings.provider.templates.alreadyCreated', { count: templateUsageCount(template.id) }) : ''"
              @click.stop="useTemplate(template)"
            >
              {{ $t('settings.provider.templates.use') }}
            </button>
          </span>
        </div>
      </div>

      <button class="pp-add-btn" :disabled="editing" @click="startAdd">{{ $t('settings.provider.customProvider') }}</button>
    </div>

    <div class="pp-detail">
      <div class="pp-detail-scroll">
        <section class="pp-global-card">
          <div class="pp-global-header">
            <div>
              <h3 class="pp-detail-title">{{ $t('settings.provider.title') }}</h3>
              <p class="pp-global-hint">{{ $t('settings.provider.description') }}</p>
            </div>
            <span v-if="saving" class="pp-saving">{{ $t('common.saving') }}</span>
          </div>

          <div class="pp-budget-row">
            <span class="pp-row-label">{{ $t('settings.provider.budgetLimit') }}</span>
            <div class="pp-budget-input-wrap">
              <span class="pp-budget-prefix">$</span>
              <input
                v-model="budgetLimit"
                type="number"
                step="0.01"
                min="0"
                :placeholder="$t('settings.provider.unlimited')"
                class="pp-budget-input"
                @change="saveBudgetOnly"
              >
            </div>
          </div>

          <p class="pp-global-note">{{ $t('settings.provider.pricingNote') }}</p>
        </section>

        <!-- Read-only template detail -->
        <template v-if="selectedTemplate && !editing">
          <div class="pp-detail-head">
            <h3 class="pp-section-title-main">
              {{ selectedTemplate.name }}
              <span class="pp-template-badge">{{ $t('settings.provider.templates.badge') }}</span>
              <span v-if="selectedTemplate.recommended" class="pp-default-badge">{{ $t('settings.provider.templates.recommended') }}</span>
            </h3>
            <button class="pp-btn-primary pp-btn-small" type="button" @click="useTemplate(selectedTemplate)">{{ $t('settings.provider.templates.useThis') }}</button>
          </div>
          <p v-if="templateTagline(selectedTemplate)" class="pp-hint">{{ templateTagline(selectedTemplate) }}</p>
          <p class="pp-hint">{{ $t('settings.provider.templates.readOnlyHint') }}</p>

          <div class="pp-separator" />

          <div class="pp-row">
            <span class="pp-row-label">{{ $t('settings.provider.apiUrl') }}</span>
            <span class="pp-row-value">{{ selectedTemplate.baseUrl }}</span>
          </div>

          <div class="pp-separator" />

          <div class="pp-row">
            <span class="pp-row-label">{{ $t('settings.provider.apiProtocol') }}</span>
            <span class="pp-row-value">{{ protocolDisplayName(selectedTemplate.apiProtocol) }}</span>
          </div>

          <div class="pp-separator" />

          <div class="pp-section-label">{{ $t('settings.provider.models') }} <small>{{ selectedTemplate.models.length }}</small></div>
          <div v-for="model in selectedTemplate.models" :key="model.id" class="pp-model-view-row">
            <div class="pp-model-view-main">
              <span class="pp-model-view-name">{{ model.id }}</span>
              <div class="pp-model-view-meta">
                <span>{{ formatContextWindow(model.contextWindow) }}</span>
                <template v-if="model.pricing">
                  <span>{{ $t('settings.provider.inputMeta', { price: formatPricing(model.pricing.inputPerMillion) }) }}</span>
                  <span>{{ $t('settings.provider.outputMeta', { price: formatPricing(model.pricing.outputPerMillion) }) }}</span>
                  <span>{{ $t('settings.provider.cacheMeta', { price: formatPricing(model.pricing.cacheReadPerMillion) }) }}</span>
                </template>
              </div>
            </div>
            <span v-if="model.id === selectedTemplate.defaultModel" class="pp-default-badge">{{ $t('settings.provider.default') }}</span>
          </div>

          <div class="pp-separator" />

          <div class="pp-row">
            <span class="pp-row-label">{{ $t('settings.provider.links.title') }}</span>
            <span class="pp-row-value pp-link-row">
              <button type="button" class="pp-link" @click="openProviderLink(selectedTemplate.links.homepage)">{{ $t('settings.provider.links.homepage') }}</button>
              <button v-if="selectedTemplate.links.console" type="button" class="pp-link" @click="openProviderLink(selectedTemplate.links.console)">{{ $t('settings.provider.links.console') }}</button>
              <button v-if="selectedTemplate.links.pricing" type="button" class="pp-link" @click="openProviderLink(selectedTemplate.links.pricing)">{{ $t('settings.provider.links.pricing') }}</button>
            </span>
          </div>

          <div class="pp-separator" />

          <div class="pp-row">
            <span class="pp-row-label">{{ $t('settings.provider.templates.verifiedAt') }}</span>
            <span class="pp-row-value">{{ selectedTemplate.verifiedAt }}</span>
          </div>

          <span v-if="statusMsg" class="pp-status">{{ statusMsg }}</span>
        </template>

        <!-- Nothing selected: three-step guide around the recommended template -->
        <div v-else-if="!selectedProvider && !editing" class="pp-guide">
          <h3 class="pp-guide-title">{{ $t('settings.provider.guide.title', { name: recommendedTemplate.name }) }}</h3>
          <ol class="pp-guide-steps">
            <li><span class="pp-guide-step">1</span><span>{{ $t('settings.provider.guide.step1') }}</span></li>
            <li><span class="pp-guide-step">2</span><span>{{ $t('settings.provider.guide.step2') }}</span></li>
            <li><span class="pp-guide-step">3</span><span>{{ $t('settings.provider.guide.step3') }}</span></li>
          </ol>
          <div class="pp-actions">
            <button class="pp-btn-primary" type="button" @click="useTemplate(recommendedTemplate)">{{ $t('settings.provider.guide.useRecommended', { name: recommendedTemplate.name }) }}</button>
            <button class="pp-btn-ghost" type="button" @click="startAdd">{{ $t('settings.provider.customProvider') }}</button>
          </div>
          <p v-if="templateTagline(recommendedTemplate)" class="pp-hint">{{ templateTagline(recommendedTemplate) }}</p>
        </div>

        <template v-else-if="editing && editDraft">
          <h3 class="pp-section-title-main">
            {{ editingProviderLabel }}
            <span v-if="editDraft.templateId" class="pp-template-badge">{{ editDraftTemplate()?.name || editDraft.templateId }}</span>
          </h3>

          <div class="pp-field">
            <label>{{ $t('settings.provider.name') }}</label>
            <input v-model="editDraft.name" type="text" :placeholder="$t('settings.provider.namePlaceholder')" />
          </div>

          <div class="pp-separator" />

          <div class="pp-field">
            <label>{{ $t('settings.provider.apiUrl') }}</label>
            <input v-model="editDraft.baseUrl" type="text" :placeholder="$t('settings.provider.apiUrlPlaceholder')" />
            <span v-if="driftedFromTemplate" class="pp-hint pp-drift">
              {{ $t('settings.provider.driftedFromTemplate') }}
              <button type="button" class="pp-link" @click="restoreTemplateDefaults">{{ $t('settings.provider.restoreTemplate') }}</button>
            </span>
          </div>

          <div class="pp-separator" />

          <div class="pp-field">
            <label>{{ $t('settings.provider.apiProtocol') }}</label>
            <select v-model="editApiProtocol" class="pp-select">
              <option value="">{{ $t('settings.provider.apiProtocolAuto') }}</option>
              <option value="openai-chat">{{ $t('settings.provider.apiProtocolOpenAIChat') }}</option>
              <option value="openai-responses">{{ $t('settings.provider.apiProtocolOpenAIResponses') }}</option>
              <option value="anthropic">{{ $t('settings.provider.apiProtocolAnthropic') }}</option>
            </select>
            <span class="pp-hint">{{ $t('settings.provider.apiProtocolHint') }}</span>
            <div v-if="editApiProtocol === ''" class="pp-protocol-detect">
              <button
                class="pp-btn-ghost pp-btn-small"
                type="button"
                :disabled="detectionBusy"
                @click="runDetection('manual')"
              >
                {{ detectionBusy
                  ? $t('settings.provider.detecting')
                  : (editDraft?.detectedApiProtocol
                      ? $t('settings.provider.redetect')
                      : $t('settings.provider.detectNow')) }}
              </button>
              <span
                v-if="detectionStatusMessage"
                class="pp-detect-status"
                :class="{ 'pp-detect-status-failed': detectionFailed }"
              >{{ detectionStatusMessage }}</span>
              <span v-else-if="!detectionBusy" class="pp-hint">{{ $t('settings.provider.detectHint') }}</span>
            </div>
          </div>

          <div class="pp-separator" />

          <div class="pp-field">
            <label>{{ $t('settings.provider.apiKey') }}</label>
            <div v-if="clipboardKeyCandidate" class="pp-clip-banner" role="status">
              <span>{{ $t('settings.provider.clipboardKeyDetected') }}</span>
              <span class="pp-clip-actions">
                <button type="button" class="pp-btn-primary pp-btn-small" @click="fillClipboardKey">{{ $t('settings.provider.clipboardKeyFill') }}</button>
                <button type="button" class="pp-btn-ghost pp-btn-small" @click="ignoreClipboardKey">{{ $t('settings.provider.clipboardKeyIgnore') }}</button>
              </span>
            </div>
            <input ref="keyInputRef" v-model="editDraft.apiKey" type="password" :placeholder="editKeyPlaceholder" />
            <div v-if="editLinks" class="pp-key-links">
              <button type="button" class="pp-btn-primary pp-btn-small" @click="openKeyPage">{{ $t('settings.provider.getKeyFromWebsite') }}</button>
              <button v-if="editLinks.signup" type="button" class="pp-link" @click="openProviderLink(editLinks.signup)">{{ $t('settings.provider.links.signup') }}</button>
              <button v-if="editLinks.billing" type="button" class="pp-link" @click="openProviderLink(editLinks.billing)">{{ $t('settings.provider.links.billing') }}</button>
              <button v-if="editLinks.pricing" type="button" class="pp-link" @click="openProviderLink(editLinks.pricing)">{{ $t('settings.provider.links.pricing') }}</button>
            </div>
            <span class="pp-hint">{{ $t('settings.provider.apiKeyHint') }}</span>
          </div>

          <div class="pp-separator" />

          <div class="pp-field">
            <MultiSelectDropdown
              v-model="selectedRemoteModels"
              :options="remoteModelOptions"
              :label="$t('settings.provider.remoteModels')"
              :placeholder="remoteModelsPlaceholder"
              :search-placeholder="$t('settings.provider.remoteModelsSearch')"
              :empty-text="remoteModels.length > 0 ? $t('settings.provider.remoteModelsAllAdded') : $t('settings.provider.remoteModelsEmpty')"
              :disabled="remoteModelsLoading || remoteModelOptions.length === 0"
            />
            <div class="pp-remote-model-actions">
              <span v-if="remoteModelsLoading" class="pp-hint">{{ $t('settings.provider.remoteModelsLoading') }}</span>
              <span v-else-if="remoteModelsError" class="pp-remote-model-error">{{ $t('settings.provider.remoteModelsFailed', { message: remoteModelsError }) }}</span>
              <span v-else-if="remoteModels.length > 0" class="pp-hint">{{ $t('settings.provider.remoteModelsLoaded', { count: remoteModels.length, available: remoteModelOptions.length }) }}</span>
              <span v-else class="pp-hint">{{ $t('settings.provider.remoteModelsHint') }}</span>
              <div class="pp-remote-model-buttons">
                <button
                  class="pp-btn-ghost pp-btn-small"
                  type="button"
                  :disabled="remoteModelsLoading || !editDraft.baseUrl.trim() || !editDraft.apiKey.trim()"
                  @click="fetchRemoteModels"
                >
                  {{ $t('settings.provider.remoteModelsRefresh') }}
                </button>
                <button
                  class="pp-btn-primary pp-btn-small"
                  type="button"
                  :disabled="selectedRemoteModels.length === 0"
                  @click="addSelectedRemoteModels"
                >
                  {{ $t('settings.provider.remoteModelsAdd', { count: selectedRemoteModels.length }) }}
                </button>
              </div>
            </div>
          </div>

          <div class="pp-separator" />

          <div class="pp-field">
            <label>{{ $t('settings.provider.modelsAndPricing') }}</label>
            <div v-if="editDraft.models.length > 0" class="pp-model-list">
              <div v-for="(model, index) in editDraft.models" :key="model" class="pp-model-card">
                <div class="pp-model-card-head">
                  <span class="pp-model-name">{{ model }}</span>
                  <button class="pp-model-rm" @click="removeModel(index)">×</button>
                </div>

                <div class="pp-model-fields">
                  <label class="pp-inline-field">
                    <span>{{ $t('settings.provider.contextWindow') }}</span>
                    <input
                      :value="getCtxInK(editDraft, model)"
                      type="number"
                      min="1"
                      step="1"
                      class="pp-inline-input"
                      @input="handleCtxInput(model, $event)"
                    >
                  </label>
                  <label class="pp-inline-field">
                    <span>{{ $t('settings.provider.inputPrice') }}</span>
                    <input
                      :value="getPricing(editDraft, model).inputPerMillion"
                      type="number"
                      min="0"
                      step="0.01"
                      class="pp-inline-input"
                      @input="handlePricingInput(model, 'inputPerMillion', $event)"
                    >
                  </label>
                  <label class="pp-inline-field">
                    <span>{{ $t('settings.provider.outputPrice') }}</span>
                    <input
                      :value="getPricing(editDraft, model).outputPerMillion"
                      type="number"
                      min="0"
                      step="0.01"
                      class="pp-inline-input"
                      @input="handlePricingInput(model, 'outputPerMillion', $event)"
                    >
                  </label>
                  <label class="pp-inline-field">
                    <span>{{ $t('settings.provider.cacheRead') }}</span>
                    <input
                      :value="getPricing(editDraft, model).cacheReadPerMillion"
                      type="number"
                      min="0"
                      step="0.01"
                      class="pp-inline-input"
                      @input="handlePricingInput(model, 'cacheReadPerMillion', $event)"
                    >
                  </label>
                </div>

                <div class="pp-model-capability-row">
                  <button class="pp-capability-chip" type="button" :class="{ on: getModelCapabilities(editDraft, model).imageGeneration }" @click="toggleModelCapability(model, 'imageGeneration')">
                    <span>{{ $t('settings.provider.imageGeneration') }}</span>
                  </button>
                  <button
                    class="pp-capability-chip"
                    type="button"
                    :class="{ on: getModelCapabilities(editDraft, model).imageEditing }"
                    :disabled="!getModelCapabilities(editDraft, model).imageGeneration"
                    @click="toggleModelCapability(model, 'imageEditing')"
                  >
                    <span>{{ $t('settings.provider.imageEditing') }}</span>
                  </button>
                </div>
              </div>
            </div>

            <div class="pp-model-add">
              <input v-model="newModelInput" type="text" :placeholder="$t('settings.provider.modelPlaceholder')" @keydown.enter.prevent="addModel" />
              <button @click="addModel">{{ $t('settings.provider.add') }}</button>
            </div>
          </div>

          <div class="pp-separator" />

          <div class="pp-field" v-if="editDraft.models.length > 0">
            <label>{{ $t('settings.provider.defaultModel') }}</label>
            <select v-model="editDraft.activeModel" class="pp-select">
              <option v-for="model in editDraft.models" :key="model" :value="model">{{ model }}</option>
            </select>
          </div>

          <div class="pp-separator" />

          <div class="pp-field">
            <label>{{ $t('settings.provider.embeddingSectionTitle') }}</label>
            <p class="pp-hint">{{ $t('settings.provider.embeddingSectionHint') }}</p>

            <div v-if="editDraft.embeddingModels && editDraft.embeddingModels.length > 0" class="pp-model-list">
              <div v-for="(row, index) in editDraft.embeddingModels" :key="row.id" class="pp-model-card pp-embedding-card">
                <div class="pp-model-card-head">
                  <span class="pp-model-name">{{ row.id }}</span>
                  <button class="pp-model-rm" @click="removeEmbeddingModel(index)">×</button>
                </div>
                <div class="pp-model-fields">
                  <label class="pp-inline-field">
                    <span>{{ $t('settings.provider.embeddingDimensions') }}</span>
                    <input
                      :value="row.dimensions"
                      type="number"
                      min="1"
                      step="1"
                      class="pp-inline-input"
                      :placeholder="$t('settings.provider.embeddingDimensionsPlaceholder')"
                      @input="handleEmbeddingDimensionsInput(row.id, $event)"
                    >
                  </label>
                  <div class="pp-inline-field pp-embedding-test">
                    <span>{{ $t('settings.provider.embeddingDistance') }}</span>
                    <span class="pp-embedding-distance">{{ row.distance || 'cosine' }}</span>
                  </div>
                </div>
                <div class="pp-embedding-test-row">
                  <button
                    class="pp-btn-ghost pp-btn-small"
                    type="button"
                    :disabled="embeddingTestState[row.id]?.running"
                    @click="testEmbeddingModel(row.id)"
                  >
                    {{ embeddingTestState[row.id]?.running ? $t('settings.provider.embeddingTesting') : $t('settings.provider.embeddingTestButton') }}
                  </button>
                  <span
                    v-if="embeddingTestState[row.id] && !embeddingTestState[row.id].running"
                    :class="['pp-embedding-test-result', embeddingTestState[row.id].ok ? 'ok' : 'error']"
                  >
                    {{ embeddingTestState[row.id].ok
                      ? $t('settings.provider.embeddingTestOk', { dimensions: embeddingTestState[row.id].dimensions, latency: embeddingTestState[row.id].latencyMs })
                      : $t('settings.provider.embeddingTestFailed', { message: embeddingTestState[row.id].error || '' }) }}
                  </span>
                </div>
              </div>
            </div>

            <p v-else class="pp-hint pp-embedding-empty">{{ $t('settings.provider.embeddingEmpty') }}</p>

            <div class="pp-model-add">
              <input v-model="newEmbeddingModelInput" type="text" :placeholder="$t('settings.provider.embeddingAddPlaceholder')" @keydown.enter.prevent="addEmbeddingModel" />
              <input
                v-model="newEmbeddingDimensionsInput"
                type="number"
                min="1"
                step="1"
                class="pp-embedding-dims-input"
                :placeholder="$t('settings.provider.embeddingDimensions')"
                @keydown.enter.prevent="addEmbeddingModel"
              />
              <button @click="addEmbeddingModel">{{ $t('settings.provider.embeddingAddButton') }}</button>
            </div>
          </div>

          <div class="pp-separator" />

          <div class="pp-field pp-toggle-row" @click.prevent="editDraft.enableThinking = !editDraft.enableThinking">
            <label>{{ $t('settings.provider.enableThinking') }}</label>
            <span :class="['pp-toggle', { on: editDraft.enableThinking }]"><span class="pp-toggle-thumb" /></span>
          </div>
          <span class="pp-hint">{{ $t('settings.provider.thinkingHint') }}</span>

          <div class="pp-separator" />

          <div class="pp-field">
            <label>{{ $t('settings.provider.temperature') }}</label>
            <div class="pp-temp-row">
              <input
                class="pp-temp-slider"
                type="range"
                min="0"
                max="2"
                step="0.1"
                :value="editDraft.temperature ?? 0.3"
                @input="handleTemperatureSlider"
              >
              <input
                class="pp-temp-number"
                type="number"
                min="0"
                max="2"
                step="0.1"
                placeholder="0.3"
                :value="editDraft.temperature ?? ''"
                @input="handleTemperatureNumber"
              >
              <button v-if="editDraft.temperature !== undefined" class="pp-temp-reset" type="button" @click="clearTemperature">{{ $t('settings.provider.reset') }}</button>
            </div>
            <span class="pp-hint">{{ $t('settings.provider.temperatureHint') }}</span>
          </div>

          <div class="pp-actions">
            <button class="pp-btn-primary" @click="saveEdit">{{ $t('settings.provider.save') }}</button>
            <button class="pp-btn-ghost" @click="cancelEdit">{{ $t('common.cancel') }}</button>
          </div>

          <span v-if="statusMsg" class="pp-status">{{ statusMsg }}</span>
        </template>

        <template v-else-if="selectedProvider">
          <div class="pp-detail-head">
            <h3 class="pp-section-title-main">
              {{ selectedProvider.name }}
              <span v-if="selectedProvider.templateId" class="pp-template-badge" :title="$t('settings.provider.templates.badgeHint')">{{ $t('settings.provider.templates.badge') }}</span>
            </h3>
            <div class="pp-detail-head-actions">
              <button
                v-if="!isDefault(selectedProvider.id)"
                class="pp-btn-ghost pp-btn-small"
                @click="setDefault(selectedProvider.id)"
              >
                {{ $t('settings.provider.setDefault') }}
              </button>
              <span v-else class="pp-default-badge">{{ $t('settings.provider.default') }}</span>
              <span
                :class="['pp-toggle', { on: isEnabled(selectedProvider.id) }]"
                @click="toggleEnabled(selectedProvider.id)"
                :title="$t('settings.provider.toggleEnabled')"
              ><span class="pp-toggle-thumb" /></span>
            </div>
          </div>

          <div class="pp-separator" />

          <div class="pp-row">
            <span class="pp-row-label">{{ $t('settings.provider.apiKey') }}</span>
            <span class="pp-row-value mono" @click="toggleKey(selectedProvider.id)">
              {{ showKey[selectedProvider.id] ? selectedProvider.apiKey : maskKey(selectedProvider.apiKey) }}
            </span>
          </div>

          <div class="pp-separator" />

          <div class="pp-row">
            <span class="pp-row-label">{{ $t('settings.provider.apiUrl') }}</span>
            <span class="pp-row-value pp-link-row">
              {{ selectedProvider.baseUrl }}
              <template v-if="selectedProvider.links">
                <button type="button" class="pp-link" @click="openProviderLink(selectedProvider.links.homepage)">{{ $t('settings.provider.links.homepage') }}</button>
                <button v-if="selectedProvider.links.console" type="button" class="pp-link" @click="openProviderLink(selectedProvider.links.console)">{{ $t('settings.provider.links.console') }}</button>
              </template>
            </span>
          </div>

          <template v-if="selectedProvider.links && (selectedProvider.links.apiKeys || selectedProvider.links.billing)">
            <div class="pp-separator" />
            <div class="pp-row">
              <span class="pp-row-label">{{ $t('settings.provider.quickActions') }}</span>
              <span class="pp-row-value pp-link-row">
                <button v-if="selectedProvider.links.apiKeys" type="button" class="pp-btn-ghost pp-btn-small" @click="openProviderLink(selectedProvider.links.apiKeys)">{{ $t('settings.provider.links.apiKeys') }}</button>
                <button v-if="selectedProvider.links.billing" type="button" class="pp-btn-ghost pp-btn-small" @click="openProviderLink(selectedProvider.links.billing)">{{ $t('settings.provider.links.billing') }}</button>
              </span>
            </div>
          </template>

          <div class="pp-separator" />

          <div class="pp-row">
            <span class="pp-row-label">{{ $t('settings.provider.apiProtocol') }}</span>
            <span class="pp-row-value">{{ providerProtocolLabel(selectedProvider) }}</span>
          </div>

          <div class="pp-separator" />

          <div class="pp-section-label">{{ $t('settings.provider.models') }} <small>{{ selectedProvider.models.length }}</small></div>
          <div v-for="model in selectedProvider.models" :key="model" class="pp-model-view-row">
            <div class="pp-model-view-main">
              <span class="pp-model-view-name">{{ model }}</span>
              <div class="pp-model-view-meta">
                <span>{{ formatContextWindow(getCtx(selectedProvider, model)) }}</span>
                <span>{{ $t('settings.provider.inputMeta', { price: formatPricing(getPricing(selectedProvider, model).inputPerMillion) }) }}</span>
                <span>{{ $t('settings.provider.outputMeta', { price: formatPricing(getPricing(selectedProvider, model).outputPerMillion) }) }}</span>
                <span>{{ $t('settings.provider.cacheMeta', { price: formatPricing(getPricing(selectedProvider, model).cacheReadPerMillion) }) }}</span>
                <span v-if="getModelCapabilities(selectedProvider, model).imageGeneration">{{ $t('settings.provider.imageGeneration') }}</span>
                <span v-if="getModelCapabilities(selectedProvider, model).imageEditing">{{ $t('settings.provider.imageEditing') }}</span>
              </div>
            </div>
            <span v-if="model === selectedProvider.activeModel" class="pp-default-badge">{{ $t('settings.provider.default') }}</span>
          </div>

          <div class="pp-separator" />

          <div class="pp-row">
            <span class="pp-row-label">{{ $t('settings.provider.thinkingMode') }}</span>
            <span class="pp-row-value">{{ selectedProvider.enableThinking ? $t('settings.provider.enabled') : $t('settings.provider.notEnabled') }}</span>
          </div>

          <div class="pp-separator" />

          <div class="pp-row">
            <span class="pp-row-label">{{ $t('settings.provider.temperature') }}</span>
            <span class="pp-row-value">{{ formatTemperature(selectedProvider.temperature) }}</span>
          </div>

          <div class="pp-actions">
            <button class="pp-btn-primary" @click="startEdit">{{ $t('settings.provider.edit') }}</button>
            <button class="pp-btn-danger" @click="deleteProvider(selectedProvider.id)">{{ $t('common.delete') }}</button>
          </div>

          <span v-if="statusMsg" class="pp-status">{{ statusMsg }}</span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pp-root {
  display: flex;
  height: 100%;
  color: var(--app-text);
}

.pp-list {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--app-border);
}

.pp-list-top {
  padding: 14px 12px 8px;
}

.pp-search,
.pp-field input[type='text'],
.pp-field input[type='password'],
.pp-select,
.pp-model-add input,
.pp-budget-input,
.pp-inline-input {
  width: 100%;
  background: var(--app-input-bg);
  border: 1px solid var(--app-input-border);
  border-radius: 8px;
  color: var(--app-text);
  padding: 8px 12px;
  font-size: 0.86em;
  outline: none;
}

.pp-search:focus,
.pp-field input:focus,
.pp-select:focus,
.pp-model-add input:focus,
.pp-budget-input:focus,
.pp-inline-input:focus {
  border-color: var(--app-accent);
}

.pp-model-capability-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.pp-remote-model-actions,
.pp-remote-model-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pp-remote-model-actions {
  justify-content: space-between;
  flex-wrap: wrap;
}

.pp-remote-model-buttons {
  margin-left: auto;
}

.pp-remote-model-error {
  color: #ef4444;
  font-size: 0.8em;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.pp-protocol-detect {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
}

.pp-detect-status {
  font-size: 0.8em;
  line-height: 1.5;
  color: var(--app-text-muted);
  overflow-wrap: anywhere;
}

.pp-detect-status-failed {
  color: #ef4444;
}

.pp-remote-model-buttons button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.pp-capability-chip {
  border: 1px solid var(--app-input-border);
  background: var(--app-panel);
  color: var(--app-text-muted);
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 0.78em;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s, opacity 0.15s;
}

.pp-capability-chip.on {
  border-color: var(--app-accent);
  background: var(--app-accent-soft);
  color: var(--app-text);
}

.pp-capability-chip:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.pp-temp-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pp-temp-slider {
  flex: 1;
  accent-color: var(--app-accent);
  cursor: pointer;
}

.pp-temp-number {
  width: 76px;
  flex-shrink: 0;
  background: var(--app-input-bg);
  border: 1px solid var(--app-input-border);
  border-radius: 8px;
  color: var(--app-text);
  padding: 8px 10px;
  font-size: 0.86em;
  outline: none;
}

.pp-temp-number:focus {
  border-color: var(--app-accent);
}

.pp-temp-reset {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--app-text-muted);
  font-size: 0.78em;
  cursor: pointer;
  text-decoration: underline;
  padding: 4px 6px;
}

.pp-temp-reset:hover {
  color: var(--app-accent);
}

.pp-providers {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.pp-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 10px 16px;
  border: none;
  background: transparent;
  color: var(--app-text-soft);
  font-size: 0.88em;
  cursor: pointer;
  text-align: left;
}

.pp-item:hover {
  background: var(--app-panel-subtle);
}

.pp-item.active {
  background: var(--app-panel-muted);
  color: var(--app-text-strong);
  font-weight: 600;
}

.pp-item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Template section ────────────────────────────────────────────────── */
.pp-group-label {
  padding: 10px 16px 4px;
  font-size: 0.7em;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--app-text-faint);
}

.pp-group-empty {
  margin: 0;
  padding: 6px 16px 10px;
  font-size: 0.8em;
  color: var(--app-text-faint);
}

.pp-item-template {
  cursor: pointer;
}

.pp-template-badge {
  flex-shrink: 0;
  font-size: 0.68em;
  font-weight: 600;
  color: var(--app-text-muted);
  background: var(--app-panel-subtle);
  border: 1px solid var(--app-border);
  padding: 1px 7px;
  border-radius: 6px;
  white-space: nowrap;
  vertical-align: middle;
}

.pp-section-title-main .pp-template-badge,
.pp-section-title-main .pp-default-badge {
  margin-left: 8px;
  font-size: 0.6em;
  vertical-align: middle;
}

.pp-use-btn {
  flex-shrink: 0;
  padding: 3px 10px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 50%, var(--app-border));
  border-radius: 6px;
  background: transparent;
  color: var(--app-accent);
  font-size: 0.76em;
  cursor: pointer;
}

.pp-use-btn:hover:not(:disabled) {
  background: var(--app-accent-soft);
}

.pp-use-btn:disabled,
.pp-add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pp-link {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--app-accent);
  font-size: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.pp-link-row {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
}

.pp-drift {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  color: #d97706;
}

.pp-key-links {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 8px;
  font-size: 0.8em;
}

.pp-clip-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 45%, var(--app-border));
  border-radius: 8px;
  background: var(--app-accent-soft);
  font-size: 0.82em;
}

.pp-clip-actions {
  display: inline-flex;
  gap: 8px;
}

.pp-guide {
  padding: 20px 4px;
}

.pp-guide-title {
  margin: 0 0 14px;
  font-size: 1.02em;
  color: var(--app-text-strong);
}

.pp-guide-steps {
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pp-guide-steps li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.88em;
  color: var(--app-text-soft);
}

.pp-guide-step {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--app-accent);
  color: #fff;
  font-size: 0.72em;
  font-weight: 700;
}

.pp-item-badges,
.pp-detail-head-actions,
.pp-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.pp-on-badge {
  flex-shrink: 0;
  font-size: 0.68em;
  font-weight: 700;
  color: #fff;
  background: #22c55e;
  padding: 1px 7px;
  border-radius: 6px;
  letter-spacing: 0.04em;
}

.pp-default-badge {
  font-size: 0.68em;
  color: var(--app-accent);
  background: var(--app-accent-soft);
  padding: 1px 7px;
  border-radius: 6px;
  white-space: nowrap;
}

.pp-add-btn,
.pp-btn-primary,
.pp-btn-ghost,
.pp-btn-danger,
.pp-model-add button {
  border-radius: 8px;
  font-size: 0.84em;
  cursor: pointer;
}

.pp-add-btn {
  margin: 8px 12px 12px;
  padding: 8px 0;
  border: 1px dashed var(--app-border);
  background: transparent;
  color: var(--app-text-muted);
}

.pp-add-btn:hover {
  color: var(--app-accent);
  border-color: var(--app-accent);
}

.pp-detail {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.pp-detail-scroll {
  height: 100%;
  overflow-y: auto;
  padding: 20px 28px;
}

.pp-global-card {
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-panel);
  padding: 16px;
  margin-bottom: 18px;
}

.pp-global-header,
.pp-detail-head,
.pp-model-card-head,
.pp-budget-row,
.pp-row,
.pp-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.pp-detail-title,
.pp-section-title-main {
  margin: 0;
  font-size: 1.08em;
  color: var(--app-text-strong);
}

.pp-section-title-main {
  margin-bottom: 4px;
}

.pp-global-hint,
.pp-global-note,
.pp-hint,
.pp-row-label,
.pp-model-view-meta,
.pp-field label,
.pp-section-label {
  color: var(--app-text-muted);
}

.pp-global-hint,
.pp-global-note,
.pp-hint,
.pp-model-view-meta {
  font-size: 0.8em;
  line-height: 1.6;
}

.pp-global-note {
  margin: 10px 0 0;
}

.pp-budget-input-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pp-budget-prefix {
  color: var(--app-text-faint);
  font-size: 0.9em;
}

.pp-budget-input {
  max-width: 140px;
}

.pp-saving,
.pp-status {
  font-size: 0.8em;
  color: var(--app-accent);
}

.pp-empty {
  min-height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--app-text-faint);
  font-size: 0.9em;
}

.pp-separator {
  height: 1px;
  background: var(--app-border);
  margin: 16px 0;
}

.pp-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pp-field label {
  font-size: 0.85em;
}

.pp-model-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 10px;
}

.pp-model-card {
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-panel-subtle);
  padding: 12px;
}

.pp-model-name,
.pp-model-view-name,
.pp-row-value {
  color: var(--app-text);
}

.pp-model-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  margin-top: 10px;
}

.pp-inline-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.78em;
  color: var(--app-text-faint);
}

.pp-model-rm {
  border: none;
  background: none;
  color: var(--app-text-faint);
  font-size: 1.1em;
  cursor: pointer;
}

.pp-model-rm:hover {
  color: #ff453a;
}

.pp-model-add {
  display: flex;
  gap: 8px;
}

.pp-model-add button,
.pp-btn-primary {
  padding: 8px 16px;
  border: none;
  background: var(--app-accent);
  color: #fff;
}

.pp-btn-ghost,
.pp-btn-danger {
  padding: 8px 16px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
  color: var(--app-text);
}

.pp-btn-danger {
  color: #ff453a;
  border-color: rgba(255, 69, 58, 0.28);
}

.pp-btn-small {
  padding: 6px 12px;
  font-size: 0.8em;
}

.pp-row {
  align-items: baseline;
}

.pp-row-label {
  font-size: 0.86em;
  flex-shrink: 0;
}

.pp-row-value {
  font-size: 0.88em;
  text-align: right;
  word-break: break-all;
}

.pp-row-value.mono {
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  cursor: pointer;
}

.pp-section-label {
  font-size: 0.84em;
  margin-bottom: 8px;
}

.pp-section-label small {
  margin-left: 6px;
  color: var(--app-text-faint);
}

.pp-model-view-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--app-border);
}

.pp-model-view-row:last-of-type {
  border-bottom: none;
}

.pp-model-view-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.pp-model-view-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.pp-toggle {
  display: inline-block;
  width: 38px;
  height: 22px;
  background: var(--app-border-strong);
  border-radius: 11px;
  position: relative;
  cursor: pointer;
  flex-shrink: 0;
}

.pp-toggle.on {
  background: var(--app-accent);
}

.pp-toggle-thumb {
  display: block;
  width: 18px;
  height: 18px;
  background: #fff;
  border-radius: 50%;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: transform 0.2s;
}

.pp-toggle.on .pp-toggle-thumb {
  transform: translateX(16px);
}

@media (max-width: 980px) {
  .pp-root {
    flex-direction: column;
  }

  .pp-list {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--app-border);
  }

  .pp-providers {
    max-height: 180px;
  }
}

/* Embedding model catalog */
.pp-embedding-card .pp-embedding-distance {
  color: var(--app-text-soft);
  padding: 6px 0;
}

.pp-embedding-test-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 6px;
}

.pp-embedding-test-result {
  font-size: 0.8rem;
}

.pp-embedding-test-result.ok {
  color: var(--app-success, #2e9e5b);
}

.pp-embedding-test-result.error {
  color: var(--app-danger, #d64545);
  word-break: break-all;
}

.pp-embedding-dims-input {
  max-width: 140px;
}

.pp-embedding-empty {
  color: var(--app-text-soft);
}
</style>
