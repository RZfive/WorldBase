<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type {
  ImageLibraryEntry,
  ImageStudioGenerateRequest,
  ImageStudioMode
} from '../../../shared/image-studio-types'
import type { ProvidersConfig } from '../chat/panel/types'
import ImageLibraryPanel from './ImageLibraryPanel.vue'
import PromptOptimizeDialog from './PromptOptimizeDialog.vue'
import {
  RATIO_PRESETS,
  MIN_DIMENSION,
  MAX_DIMENSION,
  buildModelOptions,
  normalizeCustomSize,
  fileToDataUrl
} from './image-studio-utils'

const MAX_INPUT_IMAGES = 4
const MAX_COUNT = 4

const providersConfig = ref<ProvidersConfig | null>(null)
const mode = ref<ImageStudioMode>('generate')
const selectedValue = ref('')
const prompt = ref('')
const negativePrompt = ref('')
const aspectRatio = ref('1:1')
const sizeMode = ref<'preset' | 'custom'>('preset')
const selectedSize = ref('1024x1024')
const customWidth = ref(1024)
const customHeight = ref(1024)
const count = ref(1)
const inputImages = ref<string[]>([])

const generating = ref(false)
const errorMsg = ref('')
const results = ref<ImageLibraryEntry[]>([])

const libraryEntries = ref<ImageLibraryEntry[]>([])
const libraryLoading = ref(false)

const fileInput = ref<HTMLInputElement | null>(null)

// Prompt optimization dialog state
const showOptimizeDialog = ref(false)
const optimizeIsNegative = ref(false)
const optimizeDialogRef = ref<InstanceType<typeof PromptOptimizeDialog> | null>(null)

const modelOptions = computed(() => buildModelOptions(providersConfig.value, mode.value))
const currentRatio = computed(() => RATIO_PRESETS.find(r => r.label === aspectRatio.value) ?? RATIO_PRESETS[0])

// Get a text-capable model for prompt optimization
const textModelInfo = computed(() => {
  if (!providersConfig.value) return null
  const enabledIds = new Set(
    (providersConfig.value.enabledProviderIds.length > 0
      ? providersConfig.value.enabledProviderIds
      : [providersConfig.value.activeProviderId]).filter(Boolean)
  )
  const enabledProviders = providersConfig.value.providers.filter(p => enabledIds.has(p.id))
  const providers = enabledProviders.length > 0 ? enabledProviders : providersConfig.value.providers

  for (const provider of providers) {
    for (const model of provider.models) {
      const caps = provider.modelCapabilities?.[model]
      // Prefer a model with chat capability (not image-only)
      if (caps && !caps.imageGeneration && !caps.imageEditing) {
        return { providerId: provider.id, model }
      }
    }
  }
  // Fallback: use the first available provider + model
  if (providers.length > 0 && providers[0].models.length > 0) {
    return { providerId: providers[0].id, model: providers[0].activeModel || providers[0].models[0] }
  }
  return null
})

const finalSize = computed<string | null>(() => {
  if (sizeMode.value === 'custom') {
    return normalizeCustomSize(customWidth.value, customHeight.value)
  }
  return selectedSize.value || null
})

const needsInput = computed(() => mode.value === 'edit')

const canGenerate = computed(() => {
  if (generating.value) return false
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
  if (!window.electronAPI?.listImageLibrary) return
  libraryLoading.value = true
  try {
    libraryEntries.value = await window.electronAPI.listImageLibrary()
  } catch {
    // ignore
  } finally {
    libraryLoading.value = false
  }
}

async function runGeneration (req: ImageStudioGenerateRequest) {
  if (!window.electronAPI?.generateStudioImage) {
    errorMsg.value = '当前环境不支持图片生成'
    return
  }
  generating.value = true
  errorMsg.value = ''
  try {
    const response = await window.electronAPI.generateStudioImage(req)
    if (response.ok) {
      results.value = response.entries
      await loadLibrary()
    } else {
      errorMsg.value = response.error
    }
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '图片生成失败'
  } finally {
    generating.value = false
  }
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
  await runGeneration(req)
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
      inputImages.value = [...inputImages.value, await fileToDataUrl(file)]
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

async function handleRegenerate (entry: ImageLibraryEntry) {
  await runGeneration({
    providerId: entry.providerId,
    model: entry.model,
    mode: entry.mode,
    prompt: entry.prompt,
    negativePrompt: entry.mode === 'generate' ? entry.negativePrompt : undefined,
    aspectRatio: entry.aspectRatio,
    size: entry.size,
    n: 1,
    inputImages: entry.mode === 'edit' ? entry.sourceDataUrls : undefined
  })
}

function handleLoadParams (entry: ImageLibraryEntry) {
  mode.value = entry.mode
  // selection set after mode so the mode watcher keeps a valid value
  const candidate = `${entry.providerId}::${entry.model}`
  selectedValue.value = modelOptions.value.some(o => o.value === candidate)
    ? candidate
    : (modelOptions.value[0]?.value ?? '')

  prompt.value = entry.prompt
  negativePrompt.value = entry.negativePrompt ?? ''

  const matchedRatio = entry.aspectRatio && RATIO_PRESETS.some(r => r.label === entry.aspectRatio)
  if (matchedRatio && entry.aspectRatio) {
    aspectRatio.value = entry.aspectRatio
  }

  const ratioForSize = RATIO_PRESETS.find(r => r.label === aspectRatio.value) ?? RATIO_PRESETS[0]
  if (ratioForSize.sizes.includes(entry.size)) {
    sizeMode.value = 'preset'
    selectedSize.value = entry.size
  } else {
    const [w, h] = entry.size.split('x').map(Number)
    if (Number.isFinite(w) && Number.isFinite(h)) {
      sizeMode.value = 'custom'
      customWidth.value = w
      customHeight.value = h
    }
  }

  if (entry.mode === 'edit' && entry.sourceDataUrls?.length) {
    inputImages.value = [...entry.sourceDataUrls].slice(0, MAX_INPUT_IMAGES)
  }
}

function handleUseAsInput (entry: ImageLibraryEntry) {
  mode.value = 'edit'
  ensureValidSelection()
  if (inputImages.value.length < MAX_INPUT_IMAGES) {
    inputImages.value = [...inputImages.value, entry.dataUrl]
  }
}

async function handleSaveToFile (entry: ImageLibraryEntry) {
  if (!window.electronAPI?.saveImageToFile) return
  const stamp = entry.createdAt.replace(/[:.]/g, '-')
  await window.electronAPI.saveImageToFile(entry.dataUrl, `the-world-${stamp}`)
}

async function handleDelete (ids: string[]) {
  if (!window.electronAPI?.deleteImageLibrary || ids.length === 0) return
  await window.electronAPI.deleteImageLibrary(ids)
  results.value = results.value.filter(entry => !ids.includes(entry.id))
  await loadLibrary()
}

/* ---- Folder & Tag actions ---- */

async function handleUpdateFolder (ids: string[], folder: string | undefined) {
  if (!window.electronAPI?.setImageLibraryFolder) return
  await window.electronAPI.setImageLibraryFolder(ids, folder)
  await loadLibrary()
}

async function handleUpdateTags (id: string, tags: string[]) {
  if (!window.electronAPI?.setImageLibraryTags) return
  await window.electronAPI.setImageLibraryTags(id, tags)
  await loadLibrary()
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

onMounted(() => {
  void loadProviders()
  void loadLibrary()
})
</script>

<template>
  <div class="studio">
    <header class="studio-header">
      <div class="studio-title">
        <span class="studio-emoji">🎨</span>
        <div>
          <h2>绘制工作台</h2>
          <p>使用图片生成 / 编辑模型创作并管理图片</p>
        </div>
      </div>
      <div class="studio-mode-toggle">
        <button :class="['mode-btn', { active: mode === 'generate' }]" type="button" @click="mode = 'generate'">文生图</button>
        <button :class="['mode-btn', { active: mode === 'edit' }]" type="button" @click="mode = 'edit'">图片编辑</button>
      </div>
    </header>

    <div class="studio-body">
      <!-- Parameter panel -->
      <aside class="studio-params">
        <div v-if="modelOptions.length === 0" class="param-empty">
          <p>未找到{{ mode === 'edit' ? '图片编辑' : '图片生成' }}类模型</p>
          <span>请到「设置 → 供应商」为模型勾选对应能力</span>
        </div>

        <template v-else>
          <label class="param-field">
            <span class="param-label">模型</span>
            <select v-model="selectedValue" class="param-input">
              <option v-for="option in modelOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>

          <label class="param-field">
            <span class="param-label">提示词</span>
            <textarea v-model="prompt" class="param-textarea" rows="4" placeholder="描述你想要的画面…"></textarea>
            <button
              v-if="textModelInfo"
              class="optimize-btn"
              type="button"
              :disabled="!prompt.trim()"
              @click="openOptimizeDialog(false)"
            >✨ AI 优化</button>
          </label>

          <label v-if="mode === 'generate'" class="param-field">
            <span class="param-label">负向提示词 <span class="param-hint">（部分供应商支持）</span></span>
            <textarea v-model="negativePrompt" class="param-textarea" rows="2" placeholder="不希望出现的内容…"></textarea>
            <button
              v-if="textModelInfo"
              class="optimize-btn"
              type="button"
              :disabled="!negativePrompt.trim()"
              @click="openOptimizeDialog(true)"
            >✨ AI 优化</button>
          </label>

          <!-- Edit mode inputs -->
          <div v-if="mode === 'edit'" class="param-field">
            <span class="param-label">输入图片 <span class="param-hint">（最多 {{ MAX_INPUT_IMAGES }} 张）</span></span>
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
            <span class="param-label">比例</span>
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

          <label class="param-field">
            <span class="param-label">尺寸</span>
            <div class="size-row">
              <select v-model="sizeMode" class="param-input size-mode">
                <option value="preset">预设</option>
                <option value="custom">自定义</option>
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
            <span v-if="sizeMode === 'custom' && !finalSize" class="param-error">尺寸需在 {{ MIN_DIMENSION }}–{{ MAX_DIMENSION }} 之间</span>
          </label>

          <label class="param-field">
            <span class="param-label">数量</span>
            <input v-model.number="count" type="number" class="param-input" min="1" :max="MAX_COUNT" @change="clampCount" />
          </label>

          <button class="generate-btn" type="button" :disabled="!canGenerate" @click="onGenerate">
            <span v-if="generating" class="generate-spinner">⏳</span>
            {{ generating ? '生成中…' : (mode === 'edit' ? '编辑图片' : '生成图片') }}
          </button>

          <p v-if="errorMsg" class="param-error param-error-box">{{ errorMsg }}</p>
        </template>
      </aside>

      <!-- Results + library -->
      <main class="studio-main">
        <section v-if="generating || results.length > 0" class="results">
          <h3 class="results-title">本次生成</h3>
          <div v-if="generating" class="results-loading">
            <span class="generate-spinner">⏳</span>
            <p>正在生成图片，请稍候…</p>
          </div>
          <div v-else class="results-grid">
            <div v-for="entry in results" :key="entry.id" class="result-card">
              <img :src="entry.dataUrl" :alt="entry.prompt" />
              <div class="result-actions">
                <button type="button" @click="handleSaveToFile(entry)">⤓ 保存</button>
                <button type="button" @click="handleUseAsInput(entry)">⇲ 作为输入</button>
              </div>
            </div>
          </div>
        </section>

        <ImageLibraryPanel
          class="studio-library"
          :entries="libraryEntries"
          :loading="libraryLoading"
          @refresh="loadLibrary"
          @delete="handleDelete"
          @regenerate="handleRegenerate"
          @load="handleLoadParams"
          @use-as-input="handleUseAsInput"
          @save-to-file="handleSaveToFile"
          @update-folder="handleUpdateFolder"
          @update-tags="handleUpdateTags"
        />
      </main>
    </div>

    <!-- Prompt Optimization Dialog -->
    <PromptOptimizeDialog
      ref="optimizeDialogRef"
      :visible="showOptimizeDialog"
      :original-prompt="optimizeIsNegative ? negativePrompt : prompt"
      :is-negative="optimizeIsNegative"
      :provider-id="textModelInfo?.providerId ?? ''"
      :model="textModelInfo?.model ?? ''"
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
  padding: 18px 24px;
  border-bottom: 1px solid var(--app-border);
  background: linear-gradient(180deg, var(--app-panel-strong), var(--app-panel));
}

.studio-title { display: flex; align-items: center; gap: 14px; }
.studio-emoji { font-size: 2em; }
.studio-title h2 { margin: 0; font-size: 1.1rem; color: var(--app-text-strong); }
.studio-title p { margin: 2px 0 0; font-size: 0.8rem; color: var(--app-text-muted); }

.studio-mode-toggle {
  display: flex;
  padding: 4px;
  border-radius: 12px;
  background: var(--app-panel-muted);
  border: 1px solid var(--app-border);
}

.mode-btn {
  padding: 8px 18px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--app-text-soft);
  font-size: 0.85em;
  cursor: pointer;
  transition: all 0.14s ease;
}

.mode-btn.active {
  background: var(--app-accent);
  color: #fff;
  box-shadow: 0 4px 12px var(--app-accent-glow);
}

.studio-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.studio-params {
  width: 360px;
  flex-shrink: 0;
  padding: 20px;
  overflow-y: auto;
  border-right: 1px solid var(--app-border);
  display: flex;
  flex-direction: column;
  gap: 16px;
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

.param-field { display: flex; flex-direction: column; gap: 7px; }
.param-label { font-size: 0.82em; font-weight: 600; color: var(--app-text-soft); }
.param-hint { font-weight: 400; color: var(--app-text-faint); font-size: 0.9em; }

.param-input,
.param-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 11px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-subtle);
  color: var(--app-text);
  font-size: 0.86em;
  font-family: inherit;
}

.param-textarea { resize: vertical; }

.param-input:focus,
.param-textarea:focus {
  outline: none;
  border-color: var(--app-accent);
  box-shadow: 0 0 0 2px var(--app-accent-glow);
}

.optimize-btn {
  align-self: flex-end;
  padding: 4px 12px;
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

.ratio-grid { display: flex; flex-wrap: wrap; gap: 6px; }

.ratio-chip {
  padding: 6px 12px;
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

.size-row { display: flex; gap: 8px; }
.size-mode { flex: 0 0 92px; }
.custom-size { display: flex; align-items: center; gap: 6px; flex: 1; }
.custom-x { color: var(--app-text-muted); }

.param-error { font-size: 0.76em; color: var(--app-danger); }
.param-error-box {
  padding: 9px 11px;
  border-radius: 9px;
  background: rgba(220, 38, 38, 0.1);
  border: 1px solid rgba(220, 38, 38, 0.3);
}

.input-images { display: flex; flex-wrap: wrap; gap: 8px; }

.input-thumb {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 10px;
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
  width: 64px;
  height: 64px;
  border-radius: 10px;
  border: 1px dashed var(--app-border-strong);
  background: var(--app-panel-subtle);
  color: var(--app-text-muted);
  font-size: 1.4em;
  cursor: pointer;
  transition: all 0.12s ease;
}

.input-add:hover { border-color: var(--app-accent); color: var(--app-accent); }

.generate-btn {
  margin-top: 4px;
  padding: 12px;
  border: none;
  border-radius: 12px;
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

.generate-spinner { display: inline-block; animation: studio-spin 1.2s linear infinite; }
@keyframes studio-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

.studio-main {
  flex: 1;
  min-width: 0;
  padding: 20px 24px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.results { display: flex; flex-direction: column; gap: 12px; }
.results-title { margin: 0; font-size: 0.92rem; color: var(--app-text-strong); }

.results-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 40px;
  color: var(--app-text-muted);
}

.results-loading p { margin: 0; font-size: 0.86em; }

.results-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 14px;
}

.result-card {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--app-border);
  background: var(--app-panel);
}

.result-card img { width: 100%; display: block; }

.result-actions {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  gap: 8px;
  padding: 10px;
  background: linear-gradient(180deg, transparent, rgba(15, 23, 42, 0.82));
  opacity: 0;
  transition: opacity 0.14s ease;
}

.result-card:hover .result-actions { opacity: 1; }

.result-actions button {
  flex: 1;
  padding: 6px;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  font-size: 0.76em;
  cursor: pointer;
  backdrop-filter: blur(4px);
}

.result-actions button:hover { background: var(--app-accent); }

.studio-library { flex: 1; min-height: 0; }

@media (max-width: 860px) {
  .studio-body { flex-direction: column; }
  .studio-params { width: 100%; border-right: none; border-bottom: 1px solid var(--app-border); }
}
</style>
