<script setup lang="ts">
import { computed, nextTick, onActivated, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  ImageLibraryEntry,
  ImageLibraryItem,
  ImageLibraryFolderCard,
  ImageLibraryData,
  ImageStudioGenerateRequest,
  ImageStudioMode,
  ImageStudioTask
} from '../../../shared/image-studio-types'
import type { ProvidersConfig } from '../chat/panel/types'
import ImageLibraryPanel from './ImageLibraryPanel.vue'
import PromptOptimizeDialog from './PromptOptimizeDialog.vue'
import StudioTaskQueue from './StudioTaskQueue.vue'
import StudioTaskDetail from './StudioTaskDetail.vue'
import ImagePreview from './ImagePreview.vue'
import {
  RATIO_PRESETS,
  MIN_DIMENSION,
  MAX_DIMENSION,
  buildModelOptions,
  buildTextModelOptions,
  normalizeCustomSize,
  fileToDataUrl
} from './image-studio-utils'

const { t } = useI18n()

const MAX_INPUT_IMAGES = 4
const MAX_COUNT = 4
// How many generation/edit jobs may run at the same time. Adjustable from the studio
// header (beside the task queue) and persisted; multiple tasks can be queued while
// others are still in flight, so editing several images runs concurrently.
const MIN_CONCURRENT_TASKS = 1
const MAX_CONCURRENT_TASKS_LIMIT = 8
const DEFAULT_CONCURRENT_TASKS = 2
const CONCURRENCY_STORAGE_KEY = 'studio:maxConcurrentTasks'

type StudioTab = 'workbench' | 'library'

const providersConfig = ref<ProvidersConfig | null>(null)
const mode = ref<ImageStudioMode>('generate')
const studioTab = ref<StudioTab>('workbench')
const selectedValue = ref('')
const prompt = ref('')
const negativePrompt = ref('')
const aspectRatio = ref('1:1')
const sizeMode = ref<'preset' | 'custom'>('preset')
const selectedSize = ref(RATIO_PRESETS[0]?.defaultSize ?? '1080x1080')
const customWidth = ref(1080)
const customHeight = ref(1080)
const count = ref(1)
const inputImages = ref<string[]>([])

const errorMsg = ref('')
const tasks = ref<ImageStudioTask[]>([])

/** User-adjustable cap on concurrent generation/edit jobs (persisted to localStorage). */
function loadInitialConcurrency (): number {
  try {
    const raw = Number(window.localStorage.getItem(CONCURRENCY_STORAGE_KEY))
    if (Number.isFinite(raw) && raw >= MIN_CONCURRENT_TASKS && raw <= MAX_CONCURRENT_TASKS_LIMIT) {
      return Math.round(raw)
    }
  } catch {
    // storage unavailable — fall back to default
  }
  return DEFAULT_CONCURRENT_TASKS
}

const maxConcurrentTasks = ref(loadInitialConcurrency())

function setConcurrency (next: number) {
  const clamped = Math.min(MAX_CONCURRENT_TASKS_LIMIT, Math.max(MIN_CONCURRENT_TASKS, Math.round(next)))
  if (clamped === maxConcurrentTasks.value) return
  maxConcurrentTasks.value = clamped
  try {
    window.localStorage.setItem(CONCURRENCY_STORAGE_KEY, String(clamped))
  } catch {
    // storage unavailable — keep the in-memory value
  }
  // Raising the limit should immediately start more queued tasks.
  runScheduler()
}

// Task-queue dropdown + open task detail
const showTaskDropdown = ref(false)
const activeTaskId = ref<string | null>(null)

// Library items are immutable display data replaced wholesale on each load, so a
// shallowRef avoids Vue deep-converting thousands of objects into reactive proxies.
const libraryEntries = shallowRef<ImageLibraryItem[]>([])
const libraryLoading = ref(false)
const folders = ref<ImageLibraryFolderCard[]>([])

const fileInput = ref<HTMLInputElement | null>(null)

// Prompt optimization dialog state
const showOptimizeDialog = ref(false)
const optimizeIsNegative = ref(false)
const optimizeDialogRef = ref<InstanceType<typeof PromptOptimizeDialog> | null>(null)

const modelOptions = computed(() => buildModelOptions(providersConfig.value, mode.value))
const currentRatio = computed(() => RATIO_PRESETS.find(r => r.label === aspectRatio.value) ?? RATIO_PRESETS[0])

const textModelOptions = computed(() => buildTextModelOptions(providersConfig.value))
const defaultTextModelValue = computed(() => textModelOptions.value[0]?.value ?? '')

const activeTaskCount = computed(() => tasks.value.filter(t => t.status === 'queued' || t.status === 'running').length)
const folderNames = computed(() => folders.value.map(f => f.name))
const activeTaskDetail = computed(() => tasks.value.find(t => t.id === activeTaskId.value) ?? null)

// Most recent successful task that produced at least one image. Tasks are stored
// newest-first, so find() returns the latest. We keep the whole task (not just its
// first entry) so the workbench can switch between all generated images.
const latestSuccessTask = computed<ImageStudioTask | null>(() => {
  return tasks.value.find(t => t.status === 'success' && t.entries.length > 0) ?? null
})
const latestSuccessEntries = computed<ImageLibraryEntry[]>(() => latestSuccessTask.value?.entries ?? [])

// Which of the latest task's images is shown in the large preview.
const workbenchResultIndex = ref(0)
const latestSuccessEntry = computed<ImageLibraryEntry | null>(() => {
  const entries = latestSuccessEntries.value
  return entries[workbenchResultIndex.value] ?? entries[0] ?? null
})

// Reset the selection when a different task becomes the latest result, or when the
// current selection falls out of range (e.g. an image was deleted).
watch(() => latestSuccessTask.value?.id, () => {
  workbenchResultIndex.value = 0
})
watch(() => latestSuccessEntries.value.length, (len) => {
  if (workbenchResultIndex.value >= len) workbenchResultIndex.value = 0
})

const finalSize = computed<string | null>(() => {
  if (sizeMode.value === 'custom') {
    return normalizeCustomSize(customWidth.value, customHeight.value)
  }
  return selectedSize.value || null
})

const needsInput = computed(() => mode.value === 'edit')

const canGenerate = computed(() => {
  if (!selectedValue.value) return false
  if (!prompt.value.trim()) return false
  if (!finalSize.value) return false
  if (needsInput.value && inputImages.value.length === 0) return false
  return true
})

function ensureValidSelection () {
  if (!modelOptions.value.some(option => option.value === selectedValue.value)) {
    selectedValue.value = modelOptions.value[0]?.value ?? ''
  }
}

watch(mode, () => {
  ensureValidSelection()
})

watch(aspectRatio, () => {
  if (!currentRatio.value.sizes.includes(selectedSize.value)) {
    selectedSize.value = currentRatio.value.defaultSize
  }
})

async function loadProviders () {
  if (!window.electronAPI?.getProviders) return
  try {
    const config = await window.electronAPI.getProviders()
    providersConfig.value = config as unknown as ProvidersConfig
    ensureValidSelection()
  } catch {
    // ignore — empty model list will show the empty state
  }
}

async function loadLibrary () {
  if (!window.electronAPI?.queryImageLibrary) return
  libraryLoading.value = true
  try {
    // Fetch all library metadata (lightweight: no base64). Images themselves
    // stream from disk via the studio-img:// protocol only when rendered.
    const collected: ImageLibraryItem[] = []
    let offset = 0
    for (;;) {
      const page = await window.electronAPI.queryImageLibrary({ folder: '*', limit: 200, offset })
      collected.push(...page.items)
      if (page.nextOffset === null) break
      offset = page.nextOffset
    }
    libraryEntries.value = collected
  } catch {
    // ignore
  } finally {
    libraryLoading.value = false
  }
}

async function loadFolders () {
  if (!window.electronAPI?.listImageLibraryFolders) return
  try {
    folders.value = await window.electronAPI.listImageLibraryFolders()
  } catch {
    // ignore
  }
}

/* ---- Task queue ---- */

function findNextQueuedTask (): ImageStudioTask | null {
  // Schedule oldest-first (FIFO) even though the list renders newest-first.
  for (let i = tasks.value.length - 1; i >= 0; i--) {
    if (tasks.value[i].status === 'queued') return tasks.value[i]
  }
  return null
}

function runScheduler () {
  let running = tasks.value.filter(t => t.status === 'running').length
  while (running < maxConcurrentTasks.value) {
    const next = findNextQueuedTask()
    if (!next) break
    running += 1
    void executeTask(next)
  }
}

async function executeTask (task: ImageStudioTask) {
  task.status = 'running'
  try {
    // task.request is a Vue reactive proxy (it lives inside the reactive tasks array);
    // proxies can't be structured-cloned across IPC, so send a plain deep copy.
    const payload = JSON.parse(JSON.stringify(task.request)) as ImageStudioGenerateRequest
    const response = await window.electronAPI!.generateStudioImage(payload)
    if (response.ok) {
      task.status = 'success'
      task.entries = response.entries
      await loadLibrary()
    } else {
      task.status = 'error'
      task.error = response.error
    }
  } catch (error) {
    task.status = 'error'
    task.error = error instanceof Error ? error.message : t('studioUi.imageGenerationFailed')
  } finally {
    runScheduler()
  }
}

function enqueueTask (req: ImageStudioGenerateRequest, opts?: { createdByAgent?: boolean }) {
  if (!window.electronAPI?.generateStudioImage) {
    errorMsg.value = t('studioUi.imageGenerationUnsupported')
    return
  }
  errorMsg.value = ''
  const task: ImageStudioTask = {
    id: crypto.randomUUID(),
    status: 'queued',
    createdAt: Date.now(),
    request: req,
    label: req.prompt,
    createdByAgent: opts?.createdByAgent || undefined,
    inputPreview: req.mode === 'edit' ? req.inputImages?.[0] : undefined,
    entries: []
  }
  // Newest task on top of the queue panel.
  tasks.value = [task, ...tasks.value]
  runScheduler()
}

/**
 * Pull any image tasks the AI agent handed to the studio and add them to the queue.
 * Idempotent across callers: the main process clears its buffer atomically on drain,
 * so invoking this from both the activation hook and the live "tasks added" event
 * never double-enqueues.
 */
async function drainAgentTasks () {
  if (!window.electronAPI?.drainPendingStudioImageTasks) return
  try {
    const pending = await window.electronAPI.drainPendingStudioImageTasks()
    for (const req of pending) {
      enqueueTask(req, { createdByAgent: true })
    }
  } catch {
    // ignore — tasks stay buffered in main for the next drain
  }
}

function removeTask (id: string) {
  tasks.value = tasks.value.filter(t => t.id !== id || t.status === 'running')
}

function retryTask (id: string) {
  const task = tasks.value.find(t => t.id === id)
  if (!task || task.status === 'running') return
  task.status = 'queued'
  task.error = undefined
  task.entries = []
  runScheduler()
}

function clearFinishedTasks () {
  tasks.value = tasks.value.filter(t => t.status === 'queued' || t.status === 'running')
}

function buildRequestFromForm (): ImageStudioGenerateRequest | null {
  const [providerId, model] = selectedValue.value.split('::')
  if (!providerId || !model || !finalSize.value) return null

  return {
    providerId,
    model,
    mode: mode.value,
    prompt: prompt.value.trim(),
    negativePrompt: mode.value === 'generate' && negativePrompt.value.trim() ? negativePrompt.value.trim() : undefined,
    aspectRatio: sizeMode.value === 'preset' ? aspectRatio.value : undefined,
    size: finalSize.value,
    n: count.value,
    inputImages: mode.value === 'edit' ? [...inputImages.value] : undefined
  }
}

async function onGenerate () {
  if (!canGenerate.value) return
  const req = buildRequestFromForm()
  if (!req) return
  enqueueTask(req)
}

function triggerFilePicker () {
  fileInput.value?.click()
}

async function onFilesSelected (event: Event) {
  const target = event.target as HTMLInputElement
  const files = Array.from(target.files ?? [])
  for (const file of files) {
    if (inputImages.value.length >= MAX_INPUT_IMAGES) break
    if (!file.type.startsWith('image/')) continue
    try {
      inputImages.value = [...inputImages.value, await fileToDataUrl(file, t('studioUi.readFileFailed'))]
    } catch {
      // skip unreadable file
    }
  }
  target.value = ''
}

function removeInput (index: number) {
  inputImages.value = inputImages.value.filter((_, i) => i !== index)
}

function clampCount () {
  if (!Number.isFinite(count.value)) count.value = 1
  count.value = Math.min(MAX_COUNT, Math.max(1, Math.round(count.value)))
}

function clampCustomDimensions () {
  const clamp = (value: number) => Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.round(Number.isFinite(value) ? value : MIN_DIMENSION)))
  customWidth.value = clamp(customWidth.value)
  customHeight.value = clamp(customHeight.value)
}

/* ---- Library actions ---- */

/**
 * Resolve full image bytes. Task entries already carry the data URL (just
 * generated); library items are metadata-only, so fetch bytes on demand.
 */
async function resolveImageData (source: ImageLibraryItem | ImageLibraryEntry): Promise<ImageLibraryData | null> {
  if ('dataUrl' in source && source.dataUrl) {
    return { dataUrl: source.dataUrl, sourceDataUrls: 'sourceDataUrls' in source ? source.sourceDataUrls : undefined }
  }
  if (!window.electronAPI?.getImageLibraryData) return null
  return window.electronAPI.getImageLibraryData(source.id)
}

async function handleRegenerate (item: ImageLibraryItem) {
  let inputImages: string[] | undefined
  if (item.mode === 'edit') {
    const data = window.electronAPI?.getImageLibraryData ? await window.electronAPI.getImageLibraryData(item.id) : null
    inputImages = data?.sourceDataUrls
  }
  enqueueTask({
    providerId: item.providerId,
    model: item.model,
    mode: item.mode,
    prompt: item.prompt,
    negativePrompt: item.mode === 'generate' ? item.negativePrompt : undefined,
    aspectRatio: item.aspectRatio,
    size: item.size,
    n: 1,
    inputImages
  })
}

async function handleLoadParams (item: ImageLibraryItem) {
  studioTab.value = 'workbench'
  mode.value = item.mode
  // selection set after mode so the mode watcher keeps a valid value
  const candidate = `${item.providerId}::${item.model}`
  selectedValue.value = modelOptions.value.some(o => o.value === candidate)
    ? candidate
    : (modelOptions.value[0]?.value ?? '')

  prompt.value = item.prompt
  negativePrompt.value = item.negativePrompt ?? ''

  const matchedRatio = item.aspectRatio && RATIO_PRESETS.some(r => r.label === item.aspectRatio)
  if (matchedRatio && item.aspectRatio) {
    aspectRatio.value = item.aspectRatio
  }

  const ratioForSize = RATIO_PRESETS.find(r => r.label === aspectRatio.value) ?? RATIO_PRESETS[0]
  if (ratioForSize.sizes.includes(item.size)) {
    sizeMode.value = 'preset'
    selectedSize.value = item.size
  } else {
    const [w, h] = item.size.split('x').map(Number)
    if (Number.isFinite(w) && Number.isFinite(h)) {
      sizeMode.value = 'custom'
      customWidth.value = w
      customHeight.value = h
    }
  }

  if (item.mode === 'edit') {
    const data = window.electronAPI?.getImageLibraryData ? await window.electronAPI.getImageLibraryData(item.id) : null
    if (data?.sourceDataUrls?.length) {
      inputImages.value = [...data.sourceDataUrls].slice(0, MAX_INPUT_IMAGES)
    }
  }
}

async function handleUseAsInput (source: ImageLibraryItem | ImageLibraryEntry) {
  mode.value = 'edit'
  studioTab.value = 'workbench'
  ensureValidSelection()
  if (inputImages.value.length >= MAX_INPUT_IMAGES) return
  const data = await resolveImageData(source)
  if (data?.dataUrl) {
    inputImages.value = [...inputImages.value, data.dataUrl]
  }
}

async function handleSaveToFile (source: ImageLibraryItem | ImageLibraryEntry) {
  if (!window.electronAPI?.saveImageToFile) return
  const data = await resolveImageData(source)
  if (!data?.dataUrl) return
  const stamp = source.createdAt.replace(/[:.]/g, '-')
  await window.electronAPI.saveImageToFile(data.dataUrl, `the-world-${stamp}`)
}

async function handleDelete (ids: string[]) {
  if (!window.electronAPI?.deleteImageLibrary || ids.length === 0) return
  await window.electronAPI.deleteImageLibrary(ids)
  // Drop any deleted entries that are still shown inside completed task results.
  const removed = new Set(ids)
  for (const task of tasks.value) {
    if (task.entries.length) {
      task.entries = task.entries.filter(entry => !removed.has(entry.id))
    }
  }
  await loadLibrary()
}

/* ---- Folder & Tag actions ---- */

async function handleUpdateFolder (ids: string[], folder: string | undefined) {
  if (!window.electronAPI?.setImageLibraryFolder) return
  await window.electronAPI.setImageLibraryFolder(ids, folder)
  await loadLibrary()
  await loadFolders()
}

async function handleUpdateTags (id: string, tags: string[]) {
  if (!window.electronAPI?.setImageLibraryTags) return
  await window.electronAPI.setImageLibraryTags(id, tags)
  await loadLibrary()
}

async function handleCreateFolder (name: string) {
  if (!window.electronAPI?.createImageLibraryFolder) return
  folders.value = await window.electronAPI.createImageLibraryFolder(name)
}

async function handleExportFolder (name: string) {
  if (!window.electronAPI?.exportImageLibraryFolder) return
  const result = await window.electronAPI.exportImageLibraryFolder(name)
  if (result?.error) {
    errorMsg.value = result.error
  }
}

async function handleRenameFolder (oldName: string, newName: string) {
  if (!window.electronAPI?.renameImageLibraryFolder) return
  await window.electronAPI.renameImageLibraryFolder(oldName, newName)
  await loadLibrary()
  await loadFolders()
}

async function handleDeleteFolder (name: string) {
  if (!window.electronAPI?.deleteImageLibraryFolder) return
  await window.electronAPI.deleteImageLibraryFolder(name)
  await loadLibrary()
  await loadFolders()
}

async function handleLibraryRefresh () {
  await loadLibrary()
  await loadFolders()
}

/* ---- Task dropdown & detail ---- */

function toggleTaskDropdown () {
  showTaskDropdown.value = !showTaskDropdown.value
}

function openTaskDetail (task: ImageStudioTask) {
  activeTaskId.value = task.id
  showTaskDropdown.value = false
}

function closeTaskDetail () {
  activeTaskId.value = null
}

/* ---- Prompt optimization ---- */

function openOptimizeDialog (isNegative: boolean) {
  optimizeIsNegative.value = isNegative
  showOptimizeDialog.value = true
  nextTick(() => {
    optimizeDialogRef.value?.onOpen()
  })
}

function applyOptimizedPrompt (optimized: string) {
  if (optimizeIsNegative.value) {
    negativePrompt.value = optimized
  } else {
    prompt.value = optimized
  }
}

function onDocumentClick () {
  showTaskDropdown.value = false
}

// This component is cached by <KeepAlive> in App.vue, so its in-memory state — the
// task queue, in-flight generations, and the form — survives switching to a chat or
// another view and is only discarded when the app closes. onActivated fires on the
// initial mount *and* every time the studio is reopened, so external data (providers,
// library, folders) stays fresh while the cached task queue is preserved.
onActivated(() => {
  void loadProviders()
  void loadLibrary()
  void loadFolders()
  // Catch any agent-queued tasks buffered while the studio was closed/unmounted.
  void drainAgentTasks()
})

let unsubscribeAgentTasks: (() => void) | null = null

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  // Live drain when the agent queues tasks while the studio is already open.
  unsubscribeAgentTasks = window.electronAPI?.onStudioImageTasksAdded?.(() => { void drainAgentTasks() }) ?? null
})

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
  unsubscribeAgentTasks?.()
  unsubscribeAgentTasks = null
})
</script>

<template>
  <div class="studio">
    <header class="studio-header">
      <div class="studio-header-left">
        <!-- Task queue dropdown -->
        <div class="task-dropdown" @click.stop>
          <button
            type="button"
            class="task-trigger"
            :class="{ active: showTaskDropdown }"
            @click="toggleTaskDropdown"
          >
            📋 {{ $t('studioUi.taskQueue') }}
            <span v-if="activeTaskCount > 0" class="task-trigger-badge">{{ activeTaskCount }}</span>
          </button>
          <div v-if="showTaskDropdown" class="task-panel">
            <StudioTaskQueue
              :tasks="tasks"
              @open="openTaskDetail"
              @remove="removeTask"
              @retry="retryTask"
              @clear-finished="clearFinishedTasks"
            />
          </div>
        </div>

        <!-- Concurrency control: how many queue jobs run at once -->
        <div class="task-concurrency" :title="$t('studioUi.concurrencyTitle')">
          <span class="task-concurrency-label">{{ $t('studioUi.concurrency') }}</span>
          <div class="task-concurrency-stepper">
            <button
              type="button"
              class="task-concurrency-btn"
              :disabled="maxConcurrentTasks <= MIN_CONCURRENT_TASKS"
              :title="$t('studioUi.decreaseConcurrency')"
              @click="setConcurrency(maxConcurrentTasks - 1)"
            >−</button>
            <span class="task-concurrency-value">{{ maxConcurrentTasks }}</span>
            <button
              type="button"
              class="task-concurrency-btn"
              :disabled="maxConcurrentTasks >= MAX_CONCURRENT_TASKS_LIMIT"
              :title="$t('studioUi.increaseConcurrency')"
              @click="setConcurrency(maxConcurrentTasks + 1)"
            >＋</button>
          </div>
        </div>

        <div class="studio-title">
          <span class="studio-emoji">🎨</span>
          <div>
            <h2>{{ $t('studioUi.workbenchTitle') }}</h2>
          </div>
        </div>
      </div>

      <div class="studio-tabs">
        <button
          :class="['tab-btn', { active: studioTab === 'workbench' && mode === 'generate' }]"
          type="button"
          @click="studioTab = 'workbench'; mode = 'generate'"
        >{{ $t('studioUi.textToImage') }}</button>
        <button
          :class="['tab-btn', { active: studioTab === 'workbench' && mode === 'edit' }]"
          type="button"
          @click="studioTab = 'workbench'; mode = 'edit'"
        >{{ $t('studioUi.imageEdit') }}</button>
        <button
          :class="['tab-btn', { active: studioTab === 'library' }]"
          type="button"
          @click="studioTab = 'library'"
        >{{ $t('studioUi.imageLibrary') }}</button>
      </div>
    </header>

    <div class="studio-body">
      <!-- Workbench tab: parameters + latest result -->
      <template v-if="studioTab === 'workbench'">
        <!-- Parameter panel -->
        <aside class="studio-params">
          <div v-if="modelOptions.length === 0" class="param-empty">
            <p>{{ $t('studioUi.noImageModels', { mode: mode === 'edit' ? $t('studioUi.imageEdit') : $t('studioUi.imageGeneration') }) }}</p>
            <span>{{ $t('studioUi.noImageModelsHint') }}</span>
          </div>

        <template v-else>
          <label class="param-field">
            <span class="param-label">{{ $t('studioUi.model') }}</span>
            <select v-model="selectedValue" class="param-input">
              <option v-for="option in modelOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>

          <div class="param-field">
            <div class="param-field-head">
              <label class="param-label" for="studio-prompt">{{ $t('studioUi.prompt') }}</label>
              <button
                v-if="textModelOptions.length > 0"
                class="optimize-btn"
                type="button"
                :disabled="!prompt.trim()"
                @click="openOptimizeDialog(false)"
              >✨ {{ $t('studioUi.aiOptimize') }}</button>
            </div>
            <textarea id="studio-prompt" v-model="prompt" class="param-textarea" rows="3" :placeholder="$t('studioUi.promptPlaceholder')"></textarea>
          </div>

          <div v-if="mode === 'generate'" class="param-field">
            <div class="param-field-head">
              <label class="param-label" for="studio-negative-prompt">{{ $t('studioUi.negativePrompt') }} <span class="param-hint">{{ $t('studioUi.partialProviderSupport') }}</span></label>
              <button
                v-if="textModelOptions.length > 0"
                class="optimize-btn"
                type="button"
                :disabled="!negativePrompt.trim()"
                @click="openOptimizeDialog(true)"
              >✨ {{ $t('studioUi.aiOptimize') }}</button>
            </div>
            <textarea id="studio-negative-prompt" v-model="negativePrompt" class="param-textarea" rows="2" :placeholder="$t('studioUi.negativePromptPlaceholder')"></textarea>
          </div>

          <!-- Edit mode inputs -->
          <div v-if="mode === 'edit'" class="param-field">
            <span class="param-label">{{ $t('studioUi.inputImages') }} <span class="param-hint">{{ $t('studioUi.maxImagesHint', { count: MAX_INPUT_IMAGES }) }}</span></span>
            <div class="input-images">
              <div v-for="(img, index) in inputImages" :key="index" class="input-thumb">
                <img :src="img" alt="" />
                <button type="button" class="input-thumb-remove" @click="removeInput(index)">✕</button>
              </div>
              <button
                v-if="inputImages.length < MAX_INPUT_IMAGES"
                type="button"
                class="input-add"
                @click="triggerFilePicker"
              >＋</button>
            </div>
            <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onFilesSelected" />
          </div>

          <label class="param-field">
            <span class="param-label">{{ $t('studioUi.aspectRatio') }}</span>
            <div class="ratio-grid">
              <button
                v-for="ratio in RATIO_PRESETS"
                :key="ratio.label"
                type="button"
                :class="['ratio-chip', { active: aspectRatio === ratio.label }]"
                @click="aspectRatio = ratio.label"
              >{{ ratio.label }}</button>
            </div>
          </label>

          <div class="param-row size-count-row">
            <label class="param-field">
              <span class="param-label">{{ $t('studioUi.size') }}</span>
              <div class="size-row">
                <select v-model="sizeMode" class="param-input size-mode">
                  <option value="preset">{{ $t('studioUi.preset') }}</option>
                  <option value="custom">{{ $t('studioUi.custom') }}</option>
                </select>
                <select v-if="sizeMode === 'preset'" v-model="selectedSize" class="param-input">
                  <option v-for="size in currentRatio.sizes" :key="size" :value="size">{{ size }}</option>
                </select>
                <div v-else class="custom-size">
                  <input v-model.number="customWidth" type="number" class="param-input" :min="MIN_DIMENSION" :max="MAX_DIMENSION" @change="clampCustomDimensions" />
                  <span class="custom-x">×</span>
                  <input v-model.number="customHeight" type="number" class="param-input" :min="MIN_DIMENSION" :max="MAX_DIMENSION" @change="clampCustomDimensions" />
                </div>
              </div>
              <span v-if="sizeMode === 'custom' && !finalSize" class="param-error">{{ $t('studioUi.sizeRangeError', { min: MIN_DIMENSION, max: MAX_DIMENSION }) }}</span>
            </label>

            <label class="param-field">
              <span class="param-label">{{ $t('studioUi.count') }}</span>
              <input v-model.number="count" type="number" class="param-input count-input" min="1" :max="MAX_COUNT" @change="clampCount" />
            </label>
          </div>

          <button class="generate-btn" type="button" :disabled="!canGenerate" @click="onGenerate">
            ＋ {{ $t('studioUi.addToQueue', { mode: mode === 'edit' ? $t('studioUi.editModeParenthetical') : $t('studioUi.generateModeParenthetical') }) }}
          </button>

          <p v-if="errorMsg" class="param-error param-error-box">{{ errorMsg }}</p>
          </template>
        </aside>

        <!-- Latest result preview -->
        <main class="studio-main studio-main-workbench">
          <div v-if="latestSuccessEntry" class="workbench-result">
            <div class="workbench-result-head">
              <h3>{{ $t('studioUi.recentlyFinished') }}<span v-if="latestSuccessEntries.length > 1" class="workbench-result-count">{{ workbenchResultIndex + 1 }} / {{ latestSuccessEntries.length }}</span></h3>
              <div class="workbench-result-actions">
                <button class="lib-like-btn" type="button" @click="handleSaveToFile(latestSuccessEntry!)">⤓ {{ $t('studioUi.saveToFile') }}</button>
                <button class="lib-like-btn" type="button" @click="handleUseAsInput(latestSuccessEntry!)">⇲ {{ $t('studioUi.useAsInput') }}</button>
              </div>
            </div>
            <ImagePreview class="workbench-preview" :src="latestSuccessEntry.dataUrl" :alt="latestSuccessEntry.prompt" />
            <!-- Thumbnail strip to switch between multiple generated images -->
            <div v-if="latestSuccessEntries.length > 1" class="workbench-thumbs">
              <button
                v-for="(entry, i) in latestSuccessEntries"
                :key="entry.id"
                type="button"
                class="workbench-thumb"
                :class="{ active: i === workbenchResultIndex }"
                :title="$t('studioUi.imageIndexTitle', { index: i + 1 })"
                @click="workbenchResultIndex = i"
              >
                <img :src="entry.dataUrl" alt="" />
              </button>
            </div>
          </div>
          <div v-else class="workbench-empty">
            <span class="workbench-empty-emoji">🖼️</span>
            <p>{{ activeTaskCount > 0 ? $t('studioUi.tasksRunningPreview') : $t('studioUi.workbenchEmpty') }}</p>
            <span class="workbench-empty-hint">{{ $t('studioUi.workbenchEmptyHint') }}</span>
          </div>
        </main>
      </template>

      <!-- Library tab: full-width image library -->
      <main v-else class="studio-main studio-main-library">
        <ImageLibraryPanel
          class="studio-library"
          :entries="libraryEntries"
          :loading="libraryLoading"
          :folder-names="folderNames"
          @refresh="handleLibraryRefresh"
          @delete="handleDelete"
          @regenerate="handleRegenerate"
          @load="handleLoadParams"
          @use-as-input="handleUseAsInput"
          @save-to-file="handleSaveToFile"
          @update-folder="handleUpdateFolder"
          @update-tags="handleUpdateTags"
          @create-folder="handleCreateFolder"
          @export-folder="handleExportFolder"
          @rename-folder="handleRenameFolder"
          @delete-folder="handleDeleteFolder"
        />
      </main>
    </div>

    <!-- Task detail modal -->
    <StudioTaskDetail
      :task="activeTaskDetail"
      @close="closeTaskDetail"
      @save-to-file="handleSaveToFile"
      @use-as-input="(entry) => { handleUseAsInput(entry); closeTaskDetail() }"
      @retry="retryTask"
    />

    <!-- Prompt Optimization Dialog -->
    <PromptOptimizeDialog
      ref="optimizeDialogRef"
      :visible="showOptimizeDialog"
      :original-prompt="optimizeIsNegative ? negativePrompt : prompt"
      :is-negative="optimizeIsNegative"
      :model-options="textModelOptions"
      :default-model-value="defaultTextModelValue"
      @close="showOptimizeDialog = false"
      @apply="applyOptimizedPrompt"
    />
  </div>
</template>

<style scoped>
.studio {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--app-main-surface);
  color: var(--app-text);
}

.studio-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 24px;
  border-bottom: 1px solid var(--app-border);
  background: linear-gradient(180deg, var(--app-panel-strong), var(--app-panel));
}

.studio-header-left { display: flex; align-items: center; gap: 16px; min-width: 0; }

/* Task queue dropdown */
.task-dropdown { position: relative; }

.task-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  font-size: 0.84em;
  cursor: pointer;
  transition: all 0.12s ease;
}

.task-trigger:hover,
.task-trigger.active { background: var(--app-accent-soft); border-color: var(--app-accent-glow); color: var(--app-text-strong); }

.task-trigger-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--app-accent);
  color: #fff;
  font-size: 0.72em;
  display: flex;
  align-items: center;
  justify-content: center;
}

.task-panel {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 10250;
  width: 360px;
  max-width: calc(100vw - 48px);
  padding: 12px;
  border-radius: 14px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  box-shadow: var(--app-shadow);
}

/* Concurrency stepper (beside the task queue) */
.task-concurrency { display: flex; align-items: center; gap: 6px; }

.task-concurrency-label { font-size: 0.78em; color: var(--app-text-muted); white-space: nowrap; }

.task-concurrency-stepper {
  display: flex;
  align-items: center;
  border: 1px solid var(--app-border-strong);
  border-radius: 9px;
  background: var(--app-panel-muted);
  overflow: hidden;
}

.task-concurrency-btn {
  width: 26px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--app-text-soft);
  font-size: 0.95em;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s ease;
}

.task-concurrency-btn:hover:not(:disabled) { background: var(--app-accent-soft); color: var(--app-text-strong); }
.task-concurrency-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.task-concurrency-value {
  min-width: 20px;
  text-align: center;
  font-size: 0.84em;
  font-weight: 600;
  color: var(--app-text-strong);
}

.studio-tabs {
  display: flex;
  flex-shrink: 0;
  padding: 4px;
  border-radius: 12px;
  background: var(--app-panel-muted);
  border: 1px solid var(--app-border);
}

.tab-btn {
  padding: 8px 20px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--app-text-soft);
  font-size: 0.85em;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.14s ease;
}

.tab-btn.active {
  background: var(--app-accent);
  color: #fff;
  box-shadow: 0 4px 12px var(--app-accent-glow);
}

.studio-title { display: flex; align-items: center; gap: 10px; }
.studio-emoji { font-size: 1.65em; }
.studio-title h2 { margin: 0; font-size: 1.1rem; color: var(--app-text-strong); }

.studio-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.studio-params {
  width: 360px;
  flex-shrink: 0;
  padding: 16px 18px;
  overflow-y: auto;
  border-right: 1px solid var(--app-border);
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--app-panel);
}

.param-empty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 30px 12px;
  text-align: center;
  color: var(--app-text-faint);
}

.param-empty p { margin: 0; color: var(--app-text-muted); }
.param-empty span { font-size: 0.8em; }

.param-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.param-field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 26px;
}
.param-label { font-size: 0.82em; font-weight: 600; color: var(--app-text-soft); }
.param-hint { font-weight: 400; color: var(--app-text-faint); font-size: 0.9em; }

.param-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 82px;
  gap: 10px;
  align-items: start;
}

.size-count-row {
  grid-template-columns: minmax(0, 1fr);
}

.param-input,
.param-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-subtle);
  color: var(--app-text);
  font-size: 0.86em;
  font-family: inherit;
  line-height: 1.35;
}

.param-textarea { resize: vertical; }

.param-input:focus,
.param-textarea:focus {
  outline: none;
  border-color: var(--app-accent);
  box-shadow: 0 0 0 2px var(--app-accent-glow);
}

.optimize-btn {
  flex-shrink: 0;
  padding: 4px 10px;
  border-radius: 8px;
  border: 1px solid var(--app-accent-glow);
  background: var(--app-accent-soft);
  color: var(--app-text-strong);
  font-size: 0.76em;
  cursor: pointer;
  transition: all 0.12s ease;
}

.optimize-btn:hover:not(:disabled) {
  background: var(--app-accent);
  color: #fff;
}

.optimize-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.ratio-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 5px;
}

.ratio-chip {
  min-width: 0;
  padding: 5px 0;
  border-radius: 999px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-subtle);
  color: var(--app-text-soft);
  font-size: 0.8em;
  cursor: pointer;
  transition: all 0.12s ease;
}

.ratio-chip.active {
  background: var(--app-accent-soft);
  border-color: var(--app-accent-glow);
  color: var(--app-text-strong);
}

.size-row { display: flex; gap: 7px; min-width: 0; }
.size-row > .param-input:not(.size-mode) { min-width: 0; }
.size-mode { flex: 0 0 78px; }
.custom-size { display: flex; align-items: center; gap: 6px; flex: 1; }
.custom-size .param-input { min-width: 0; }
.custom-x { color: var(--app-text-muted); }
.count-input { text-align: center; }

.param-error { font-size: 0.76em; color: var(--app-danger); }
.param-error-box {
  padding: 9px 11px;
  border-radius: 9px;
  background: rgba(220, 38, 38, 0.1);
  border: 1px solid rgba(220, 38, 38, 0.3);
}

.input-images { display: flex; flex-wrap: wrap; gap: 7px; }

.input-thumb {
  position: relative;
  width: 52px;
  height: 52px;
  border-radius: 9px;
  overflow: hidden;
  border: 1px solid var(--app-border-strong);
}

.input-thumb img { width: 100%; height: 100%; object-fit: cover; }

.input-thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.78);
  color: #fff;
  font-size: 0.66em;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.input-add {
  width: 52px;
  height: 52px;
  border-radius: 9px;
  border: 1px dashed var(--app-border-strong);
  background: var(--app-panel-subtle);
  color: var(--app-text-muted);
  font-size: 1.4em;
  cursor: pointer;
  transition: all 0.12s ease;
}

.input-add:hover { border-color: var(--app-accent); color: var(--app-accent); }

.generate-btn {
  margin-top: 2px;
  padding: 10px 12px;
  border: none;
  border-radius: 10px;
  background: var(--app-accent);
  color: #fff;
  font-size: 0.92em;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: all 0.14s ease;
}

.generate-btn:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
.generate-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.studio-main {
  flex: 1;
  min-width: 0;
  padding: 20px 24px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.studio-main-workbench { overflow: hidden; }

.studio-library { flex: 1; min-height: 0; }

/* Workbench latest-result preview */
.workbench-result {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.workbench-result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.workbench-result-head h3 { margin: 0; font-size: 0.92rem; color: var(--app-text-strong); }
.workbench-result-count {
  margin-left: 8px;
  font-size: 0.8em;
  font-weight: 500;
  color: var(--app-text-muted);
}
.workbench-result-actions { display: flex; gap: 8px; }

.lib-like-btn {
  padding: 6px 12px;
  border-radius: 9px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-muted);
  color: var(--app-text-soft);
  font-size: 0.8em;
  cursor: pointer;
  transition: all 0.12s ease;
}

.lib-like-btn:hover { background: var(--app-accent-soft); color: var(--app-text-strong); }

.workbench-preview { flex: 1; min-height: 0; }

/* Thumbnail strip below the preview for switching between multiple generated images */
.workbench-thumbs {
  flex-shrink: 0;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 2px;
}

.workbench-thumb {
  width: 60px;
  height: 60px;
  padding: 0;
  border-radius: 10px;
  overflow: hidden;
  border: 2px solid transparent;
  background: var(--app-panel-subtle);
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.workbench-thumb:hover { border-color: var(--app-accent-glow); }
.workbench-thumb.active { border-color: var(--app-accent); }
.workbench-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }

.workbench-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--app-text-muted);
  text-align: center;
}

.workbench-empty-emoji { font-size: 2.4em; opacity: 0.6; }
.workbench-empty p { margin: 0; font-size: 0.9em; }
.workbench-empty-hint { font-size: 0.78em; color: var(--app-text-faint); }

@media (max-width: 860px) {
  .studio-body { flex-direction: column; }
  .studio-params { width: 100%; border-right: none; border-bottom: 1px solid var(--app-border); }
}
</style>
