<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

/** 模型行 = 后端 UsageSummary.models 元素 + 前端补算的 cacheHitRate。 */
interface ModelRow {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  callCount: number
  cacheHitRate: number
}
interface ProviderGroup {
  providerId: string
  providerName: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  callCount: number
  cacheHitRate: number
  models: ModelRow[]
}
/** 单日用量（用于时段图表）。 */
interface DailyRecord {
  date: string
  providerId: string
  providerName: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  callCount: number
}

const { t, locale } = useI18n()

const summaries = ref<ProviderGroup[]>([])
const daily = ref<DailyRecord[]>([])
const loading = ref(false)
const error = ref('')
const expandedProviders = ref<Set<string>>(new Set())

type RangePreset = '7' | '30' | '90' | 'all'
const rangePreset = ref<RangePreset>('7')

/** 图表筛选：选中的供应商 id 集合，空集合=全部。 */
const chartSelectedProviders = ref<Set<string>>(new Set())

function rangeFrom (): string | undefined {
  if (rangePreset.value === 'all') return undefined
  const days = Number(rangePreset.value)
  const d = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000)
  return formatDateKey(d)
}
function rangeTo (): string | undefined {
  return undefined
}
function formatDateKey (d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
/** 短日期标签（M/D）。 */
function shortDate (dateKey: string): string {
  const d = new Date(dateKey + 'T00:00:00')
  return `${d.getMonth() + 1}/${d.getDate()}`
}

async function loadUsage () {
  loading.value = true
  error.value = ''
  try {
    const [summaryRaw, dailyRaw] = await Promise.all([
      window.electronAPI?.getUsageSummary?.(rangeFrom(), rangeTo()),
      window.electronAPI?.getUsageDaily?.(rangeFrom(), rangeTo())
    ])
    summaries.value = (summaryRaw ?? []).map(normalizeSummary)
    daily.value = dailyRaw ?? []
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    summaries.value = []
    daily.value = []
  } finally {
    loading.value = false
  }
}

/** 后端 UsageSummary 已含 provider 级 cacheHitRate；模型级在前端补算。 */
function normalizeSummary (s: UsageSummary): ProviderGroup {
  const cacheHitRate = s.inputTokens > 0 ? s.cacheReadTokens / s.inputTokens : 0
  return {
    providerId: s.providerId,
    providerName: s.providerName,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheCreationTokens: s.cacheCreationTokens,
    callCount: s.callCount,
    cacheHitRate: s.cacheHitRate ?? cacheHitRate,
    models: s.models.map<ModelRow>(m => ({
      model: m.model,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheReadTokens: m.cacheReadTokens,
      cacheCreationTokens: m.cacheCreationTokens,
      callCount: m.callCount,
      cacheHitRate: m.inputTokens > 0 ? m.cacheReadTokens / m.inputTokens : 0
    }))
  }
}

function toggleProvider (providerId: string) {
  const next = new Set(expandedProviders.value)
  if (next.has(providerId)) next.delete(providerId)
  else next.add(providerId)
  expandedProviders.value = next
}

/** 图表供应商多选切换。 */
function toggleChartProvider (providerId: string) {
  const next = new Set(chartSelectedProviders.value)
  if (next.has(providerId)) next.delete(providerId)
  else next.add(providerId)
  chartSelectedProviders.value = next
}
function selectAllChartProviders () {
  chartSelectedProviders.value = new Set()
}

function fmtTokens (n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
function fmtPercent (rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

const totals = computed(() => {
  const acc = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, calls: 0 }
  for (const s of summaries.value) {
    acc.input += s.inputTokens
    acc.output += s.outputTokens
    acc.cacheRead += s.cacheReadTokens
    acc.cacheCreation += s.cacheCreationTokens
    acc.calls += s.callCount
  }
  return { ...acc, cacheHitRate: acc.input > 0 ? acc.cacheRead / acc.input : 0 }
})

const rangeLabel = computed(() => {
  if (rangePreset.value === 'all') return t('settings.usage.rangeAll')
  return t('settings.usage.rangeDays', { days: rangePreset.value })
})

/** 图表筛选后生效的 daily 记录（供应商未选=全部）。 */
const filteredDaily = computed(() => {
  if (chartSelectedProviders.value.size === 0) return daily.value
  return daily.value.filter(r => chartSelectedProviders.value.has(r.providerId))
})

/** 按日期聚合的多系列数据（输入/输出/缓存同图，不同色）。 */
const dailyChartData = computed(() => {
  const byDate = new Map<string, { input: number; output: number; cache: number }>()
  for (const r of filteredDaily.value) {
    let bucket = byDate.get(r.date)
    if (!bucket) {
      bucket = { input: 0, output: 0, cache: 0 }
      byDate.set(r.date, bucket)
    }
    bucket.input += r.inputTokens
    bucket.output += r.outputTokens
    bucket.cache += r.cacheReadTokens
  }
  return [...byDate.entries()]
    .map(([date, v]) => ({ date, input: v.input, output: v.output, cache: v.cache }))
    .sort((a, b) => a.date.localeCompare(b.date))
})

/** 缓存率对比图数据（按供应商，筛选后）。 */
const cacheRateChartData = computed(() => {
  return summaries.value
    .filter(s => chartSelectedProviders.value.size === 0 || chartSelectedProviders.value.has(s.providerId))
    .map(s => ({
      providerId: s.providerId,
      providerName: s.providerName,
      cacheHitRate: s.cacheHitRate,
      inputTokens: s.inputTokens,
      cacheReadTokens: s.cacheReadTokens
    }))
    .sort((a, b) => b.cacheHitRate - a.cacheHitRate)
})

/** 多系列折线图：输入/输出/缓存三条线同图不同色。 */
const LINE_CHART = { width: 720, height: 220, pad: { l: 44, r: 16, t: 16, b: 28 } }
const lineChartInnerW = computed(() => LINE_CHART.width - LINE_CHART.pad.l - LINE_CHART.pad.r)
const lineChartInnerH = computed(() => LINE_CHART.height - LINE_CHART.pad.t - LINE_CHART.pad.b)

interface LineSeries {
  key: 'input' | 'output' | 'cache'
  label: string
  color: string
  /** 每个数据点对应的 y 值序列（与 dailyChartData 同序）。 */
  values: number[]
}

/** 三条系列的配置（颜色 + 标签 + 取值）。 */
const lineSeries = computed<LineSeries[]>(() => {
  const data = dailyChartData.value
  return [
    { key: 'input', label: t('settings.usage.colInput'), color: 'var(--app-accent, #4f7cff)', values: data.map(d => d.input) },
    { key: 'output', label: t('settings.usage.colOutput'), color: 'var(--app-success, #2faa5e)', values: data.map(d => d.output) },
    { key: 'cache', label: t('settings.usage.colCacheRead'), color: '#f59e0b', values: data.map(d => d.cache) }
  ]
})

const lineChartMax = computed(() => {
  const all = lineSeries.value.flatMap(s => s.values)
  const max = Math.max(1, ...all)
  const mag = Math.pow(10, Math.floor(Math.log10(max)))
  return Math.max(mag, Math.ceil(max / mag) * mag)
})
/** 数据点 X 坐标（点数=1 时居中，否则均分）。 */
function pointX (index: number): number {
  const n = dailyChartData.value.length
  if (n <= 1) return LINE_CHART.pad.l + lineChartInnerW.value / 2
  return LINE_CHART.pad.l + (lineChartInnerW.value * index) / (n - 1)
}
function pointY (value: number): number {
  return LINE_CHART.pad.t + lineChartInnerH.value * (1 - value / lineChartMax.value)
}
/** 平滑折线 path（Catmull-Rom → cubic bezier），单点时退化为空。 */
function buildSmoothPath (values: number[]): string {
  const n = values.length
  if (n < 2) return ''
  const pts = values.map((v, i) => ({ x: pointX(i), y: pointY(v) }))
  let path = `M ${pts[0].x} ${pts[0].y}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] || p2
    // 张力系数 0.16，曲线平滑但不过度。
    const c1x = p1.x + (p2.x - p0.x) * 0.16
    const c1y = p1.y + (p2.y - p0.y) * 0.16
    const c2x = p2.x - (p3.x - p1.x) * 0.16
    const c2y = p2.y - (p3.y - p1.y) * 0.16
    path += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`
  }
  return path
}
/** 各系列的平滑 path（按 key 索引，模板里按 key 取用）。 */
const linePaths = computed(() => {
  const map: Record<string, string> = {}
  for (const s of lineSeries.value) {
    map[s.key] = buildSmoothPath(s.values)
  }
  return map
})
/** X 轴标签：点数多时间隔显示，避免拥挤。 */
function shouldShowPointLabel (index: number): boolean {
  const n = dailyChartData.value.length
  if (n <= 8) return true
  const step = Math.ceil(n / 8)
  return index % step === 0 || index === n - 1
}

/** 缓存率横向条形图常量。 */
const RATE_CHART = { width: 720, barH: 24, gap: 10, pad: { l: 130, r: 56, t: 8, b: 8 } }
const rateChartHeight = computed(() =>
  Math.max(RATE_CHART.pad.t + RATE_CHART.pad.b + 40,
    RATE_CHART.pad.t + RATE_CHART.pad.b + cacheRateChartData.value.length * (RATE_CHART.barH + RATE_CHART.gap))
)
function rateBarY (index: number): number {
  return RATE_CHART.pad.t + index * (RATE_CHART.barH + RATE_CHART.gap)
}
function rateBarW (rate: number): number {
  return (RATE_CHART.width - RATE_CHART.pad.l - RATE_CHART.pad.r) * rate
}

const providerFilterLabel = computed(() => {
  if (chartSelectedProviders.value.size === 0) return t('settings.usage.filterAll')
  return `${chartSelectedProviders.value.size} / ${summaries.value.length}`
})

async function clearAll () {
  if (!window.confirm(t('settings.usage.clearConfirm'))) return
  try {
    await window.electronAPI?.clearUsage?.()
    await loadUsage()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

// 切换时间范围时重置图表筛选并重新加载。
watch(rangePreset, () => {
  chartSelectedProviders.value = new Set()
  void loadUsage()
})

onMounted(() => {
  void loadUsage()
})
</script>

<template>
  <section class="usage-panel">
    <header class="usage-head">
      <div>
        <h3 class="usage-title">{{ $t('settings.usage.title') }}</h3>
        <p class="usage-desc">{{ $t('settings.usage.description') }}</p>
      </div>
      <div class="usage-actions">
        <select v-model="rangePreset" class="usage-select">
          <option value="7">{{ $t('settings.usage.range7') }}</option>
          <option value="30">{{ $t('settings.usage.range30') }}</option>
          <option value="90">{{ $t('settings.usage.range90') }}</option>
          <option value="all">{{ $t('settings.usage.rangeAll') }}</option>
        </select>
        <button class="usage-btn" :disabled="loading" @click="loadUsage">↻ {{ $t('settings.usage.refresh') }}</button>
        <button class="usage-btn usage-btn-danger" @click="clearAll">{{ $t('settings.usage.clear') }}</button>
      </div>
    </header>

    <div v-if="error" class="usage-error">{{ error }}</div>

    <div v-if="loading" class="usage-empty">{{ $t('settings.usage.loading') }}</div>

    <div v-else-if="summaries.length === 0" class="usage-empty">{{ $t('settings.usage.empty') }}</div>

    <template v-else>
      <!-- Totals summary card -->
      <div class="usage-totals">
        <div class="totals-item"><span class="totals-label">{{ $t('settings.usage.totalCalls') }}</span><span class="totals-value">{{ totals.calls.toLocaleString(locale) }}</span></div>
        <div class="totals-item"><span class="totals-label">{{ $t('settings.usage.totalInput') }}</span><span class="totals-value">{{ fmtTokens(totals.input) }}</span></div>
        <div class="totals-item"><span class="totals-label">{{ $t('settings.usage.totalOutput') }}</span><span class="totals-value">{{ fmtTokens(totals.output) }}</span></div>
        <div class="totals-item"><span class="totals-label">{{ $t('settings.usage.totalCacheRead') }}</span><span class="totals-value">{{ fmtTokens(totals.cacheRead) }}</span></div>
        <div class="totals-item totals-highlight"><span class="totals-label">{{ $t('settings.usage.cacheHitRate') }}</span><span class="totals-value">{{ fmtPercent(totals.cacheHitRate) }}</span></div>
      </div>

      <!-- Charts section -->
      <div class="chart-section">
        <div class="chart-toolbar">
          <div class="chart-filter-group">
            <span class="chart-filter-label">{{ $t('settings.usage.chartFilterProvider') }}</span>
            <button
              class="chart-chip"
              :class="{ active: chartSelectedProviders.size === 0 }"
              @click="selectAllChartProviders"
            >{{ $t('settings.usage.filterAll') }}</button>
            <button
              v-for="s in summaries"
              :key="s.providerId"
              class="chart-chip"
              :class="{ active: chartSelectedProviders.has(s.providerId) }"
              @click="toggleChartProvider(s.providerId)"
            >{{ s.providerName }}</button>
            <span class="chart-filter-count">{{ providerFilterLabel }}</span>
          </div>
        </div>

        <!-- Daily usage line chart (multi-series: input / output / cache) -->
        <div class="chart-card">
          <div class="chart-card-head">
            <h4 class="chart-title">{{ $t('settings.usage.chartDaily') }}</h4>
            <!-- Legend doubles as series key — color swatch + label per series. -->
            <div class="chart-legend">
              <span v-for="s in lineSeries" :key="s.key" class="legend-item">
                <span class="legend-swatch" :style="{ background: s.color }"></span>
                <span class="legend-label">{{ s.label }}</span>
              </span>
            </div>
          </div>
          <div v-if="dailyChartData.length === 0" class="chart-empty">{{ $t('settings.usage.chartEmpty') }}</div>
          <svg v-else class="line-chart" :viewBox="`0 0 ${LINE_CHART.width} ${LINE_CHART.height}`" preserveAspectRatio="xMidYMid meet" role="img" :aria-label="$t('settings.usage.chartDaily')">
            <!-- Y axis gridlines -->
            <line v-for="i in 4" :key="`grid-${i}`" :x1="LINE_CHART.pad.l" :x2="LINE_CHART.width - LINE_CHART.pad.r" :y1="LINE_CHART.pad.t + (lineChartInnerH * i) / 4" :y2="LINE_CHART.pad.t + (lineChartInnerH * i) / 4" class="chart-grid" />
            <!-- Y axis labels -->
            <text v-for="i in 5" :key="`ylabel-${i}`" :x="LINE_CHART.pad.l - 6" :y="LINE_CHART.pad.t + (lineChartInnerH * (i - 1)) / 4 + 4" class="chart-axis-label" text-anchor="end">{{ fmtTokens(lineChartMax * (i - 1) / 4) }}</text>
            <!-- One smooth line per series, colored by series.color -->
            <path
              v-for="s in lineSeries"
              :key="`line-${s.key}`"
              :d="linePaths[s.key]"
              class="chart-line"
              :style="{ stroke: s.color }"
              fill="none"
            />
            <!-- Data points per series (hover shows value) -->
            <template v-for="s in lineSeries" :key="`pts-${s.key}`">
              <circle
                v-for="(v, i) in s.values"
                :key="`pt-${s.key}-${i}`"
                :cx="pointX(i)"
                :cy="pointY(v)"
                r="2.5"
                class="chart-point"
                :style="{ fill: s.color }"
              >
                <title>{{ shortDate(dailyChartData[i].date) }} · {{ s.label }}: {{ fmtTokens(v) }}</title>
              </circle>
            </template>
            <!-- X axis date labels (shared, derived from first series) -->
            <text v-for="(d, i) in dailyChartData" :key="`xlabel-${d.date}`" v-show="shouldShowPointLabel(i)" :x="pointX(i)" :y="LINE_CHART.height - LINE_CHART.pad.b + 14" class="chart-axis-label" text-anchor="middle">{{ shortDate(d.date) }}</text>
          </svg>
          <p class="chart-range-label">{{ rangeLabel }}</p>
        </div>

        <!-- Cache hit rate chart -->
        <div class="chart-card">
          <h4 class="chart-title">{{ $t('settings.usage.chartCacheRate') }}</h4>
          <div v-if="cacheRateChartData.length === 0" class="chart-empty">{{ $t('settings.usage.chartEmpty') }}</div>
          <svg v-else class="rate-chart" :viewBox="`0 0 ${RATE_CHART.width} ${rateChartHeight}`" preserveAspectRatio="xMidYMid meet" role="img" :aria-label="$t('settings.usage.chartCacheRate')">
            <!-- Track background -->
            <rect
              v-for="(d, i) in cacheRateChartData" :key="`track-${d.providerId}`"
              :x="RATE_CHART.pad.l" :y="rateBarY(i)"
              :width="RATE_CHART.width - RATE_CHART.pad.l - RATE_CHART.pad.r" :height="RATE_CHART.barH"
              class="rate-track" rx="4"
            />
            <!-- Rate bar -->
            <rect
              v-for="(d, i) in cacheRateChartData" :key="`rate-${d.providerId}`"
              :x="RATE_CHART.pad.l" :y="rateBarY(i)"
              :width="rateBarW(d.cacheHitRate)" :height="RATE_CHART.barH"
              class="rate-bar" :class="{ 'rate-low': d.cacheHitRate < 0.1 }" rx="4"
            >
              <title>{{ d.providerName }} · {{ fmtPercent(d.cacheHitRate) }} ({{ fmtTokens(d.cacheReadTokens) }}/{{ fmtTokens(d.inputTokens) }})</title>
            </rect>
            <!-- Provider name labels -->
            <text
              v-for="(d, i) in cacheRateChartData" :key="`label-${d.providerId}`"
              :x="RATE_CHART.pad.l - 8" :y="rateBarY(i) + RATE_CHART.barH / 2 + 4"
              class="rate-label" text-anchor="end"
            >{{ d.providerName }}</text>
            <!-- Rate % labels -->
            <text
              v-for="(d, i) in cacheRateChartData" :key="`pct-${d.providerId}`"
              :x="RATE_CHART.pad.l + rateBarW(d.cacheHitRate) + 6" :y="rateBarY(i) + RATE_CHART.barH / 2 + 4"
              class="rate-pct" :class="{ 'pct-low': d.cacheHitRate < 0.05 }"
            >{{ fmtPercent(d.cacheHitRate) }}</text>
          </svg>
          <p class="chart-hint">{{ $t('settings.usage.cacheRateHint') }}</p>
        </div>
      </div>

      <!-- Grouped table -->
      <p class="usage-range-label">{{ rangeLabel }}</p>
      <div class="usage-table">
        <div class="usage-row usage-row-header">
          <span class="col-provider">{{ $t('settings.usage.colProvider') }}</span>
          <span class="col-num">{{ $t('settings.usage.colCalls') }}</span>
          <span class="col-num">{{ $t('settings.usage.colInput') }}</span>
          <span class="col-num">{{ $t('settings.usage.colOutput') }}</span>
          <span class="col-num">{{ $t('settings.usage.colCacheRead') }}</span>
          <span class="col-num">{{ $t('settings.usage.colCacheRate') }}</span>
        </div>

        <template v-for="group in summaries" :key="group.providerId">
          <div
            class="usage-row usage-row-provider"
            :class="{ expanded: expandedProviders.has(group.providerId) }"
            @click="toggleProvider(group.providerId)"
          >
            <span class="col-provider">
              <span class="provider-chevron" :class="{ expanded: expandedProviders.has(group.providerId) }">▶</span>
              <span class="provider-name">{{ group.providerName }}</span>
              <span class="provider-model-count">{{ $t('settings.usage.modelCount', { count: group.models.length }) }}</span>
            </span>
            <span class="col-num">{{ group.callCount.toLocaleString(locale) }}</span>
            <span class="col-num">{{ fmtTokens(group.inputTokens) }}</span>
            <span class="col-num">{{ fmtTokens(group.outputTokens) }}</span>
            <span class="col-num">{{ fmtTokens(group.cacheReadTokens) }}</span>
            <span class="col-num col-rate" :class="{ 'rate-good': group.cacheHitRate > 0 }">{{ fmtPercent(group.cacheHitRate) }}</span>
          </div>

          <template v-if="expandedProviders.has(group.providerId)">
            <div
              v-for="m in group.models"
              :key="`${group.providerId}:${m.model}`"
              class="usage-row usage-row-model"
            >
              <span class="col-provider col-model-name">
                <span class="model-bullet">·</span>
                <span :title="m.model">{{ m.model }}</span>
              </span>
              <span class="col-num">{{ m.callCount.toLocaleString(locale) }}</span>
              <span class="col-num">{{ fmtTokens(m.inputTokens) }}</span>
              <span class="col-num">{{ fmtTokens(m.outputTokens) }}</span>
              <span class="col-num">{{ fmtTokens(m.cacheReadTokens) }}</span>
              <span class="col-num col-rate" :class="{ 'rate-good': m.cacheHitRate > 0 }">{{ fmtPercent(m.cacheHitRate) }}</span>
            </div>
          </template>
        </template>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* 20px 28px padding matches sibling panels (CostSettingsPanel etc.) so the
   panel sits inside the content area instead of touching the edges. */
.usage-panel {
  /* Mirrors CostSettingsPanel: height:100% + overflow-y:auto is the verified
     scroll pattern inside .cat-content. box-sizing ensures padding doesn't
     inflate past the 100% height. */
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px 28px;
  overflow-y: auto;
  color: var(--app-text);
}

/* Flex column children default to flex-shrink:1 + min-height:auto, which makes
   them refuse to shrink and prevents the container from scrolling even when
   content overflows (the chart cards + table get clipped by .cat-content's
   overflow:hidden instead). Pin shrink to 0 so each child keeps its natural
   height and the container scrolls as a whole. */
.usage-panel > * { flex-shrink: 0; }

.usage-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.usage-title { margin: 0; font-size: 1.02rem; }
.usage-desc { margin: 4px 0 0; color: var(--app-text-muted); font-size: 0.84rem; }

.usage-actions { display: flex; gap: 8px; flex-shrink: 0; }
.usage-select, .usage-btn {
  padding: 6px 12px;
  border: 1px solid var(--app-border-strong);
  border-radius: 8px;
  background: var(--app-panel-muted);
  color: var(--app-text);
  font-size: 0.82em;
  cursor: pointer;
}
.usage-btn:disabled { opacity: 0.5; cursor: default; }
.usage-btn-danger:hover { background: rgba(220, 38, 38, 0.12); border-color: rgba(220, 38, 38, 0.4); }

.usage-error, .usage-empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--app-text-muted);
  font-size: 0.88em;
}
.usage-error { color: var(--app-danger); }

.usage-totals {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
}
.totals-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel);
}
.totals-highlight { border-color: var(--app-accent-glow, var(--app-accent)); background: var(--app-accent-soft, var(--app-panel-muted)); }
.totals-label { font-size: 0.74em; color: var(--app-text-muted); }
.totals-value { font-size: 1.06em; font-weight: 600; color: var(--app-text-strong); }

/* ── Charts ── */
.chart-section { display: flex; flex-direction: column; gap: 14px; }

.chart-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel);
}
.chart-filter-group { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.chart-filter-label { font-size: 0.78em; color: var(--app-text-muted); margin-right: 2px; }
.chart-chip {
  padding: 4px 10px;
  border: 1px solid var(--app-border-strong);
  border-radius: 999px;
  background: var(--app-panel-subtle);
  color: var(--app-text-soft);
  font-size: 0.78em;
  cursor: pointer;
  transition: all 0.12s ease;
}
.chart-chip:hover { border-color: var(--app-accent); color: var(--app-text); }
.chart-chip.active { background: var(--app-accent); border-color: var(--app-accent); color: #fff; }
.chart-filter-count { margin-left: 6px; font-size: 0.74em; color: var(--app-text-faint); }

.chart-card {
  padding: 14px 16px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-panel);
}
.chart-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.chart-title { margin: 0; font-size: 0.9rem; font-weight: 600; color: var(--app-text-strong); }
.chart-legend { display: flex; flex-wrap: wrap; gap: 10px; }
.legend-item { display: flex; align-items: center; gap: 5px; font-size: 0.76em; color: var(--app-text-soft); }
.legend-swatch { width: 12px; height: 3px; border-radius: 2px; flex-shrink: 0; }
.legend-label { white-space: nowrap; }

.line-chart, .rate-chart { width: 100%; height: auto; display: block; }
.line-chart { max-height: 220px; }
.rate-chart { max-height: 320px; }

.chart-grid { stroke: var(--app-border); stroke-width: 1; stroke-dasharray: 2 3; opacity: 0.6; }
.chart-axis-label { font-size: 9px; fill: var(--app-text-faint); }
/* stroke/fill come from inline style (per-series color); base sets geometry only. */
.chart-line { stroke-width: 2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.chart-point { stroke: var(--app-panel, #fff); stroke-width: 1.5; transition: r 0.12s ease; }
.chart-point:hover { r: 4.5; }

.rate-track { fill: var(--app-panel-subtle); }
.rate-bar { fill: var(--app-success, #2faa5e); transition: fill 0.12s ease; }
.rate-bar.rate-low { fill: var(--app-text-faint, #9aa3b2); }
.rate-label { font-size: 11px; fill: var(--app-text-soft); }
.rate-pct { font-size: 11px; font-weight: 600; fill: var(--app-success, #2faa5e); }
.rate-pct.pct-low { fill: var(--app-text-muted); }

.chart-empty { padding: 28px 12px; text-align: center; color: var(--app-text-muted); font-size: 0.84em; }
.chart-range-label, .chart-hint { margin: 6px 0 0; font-size: 0.76em; color: var(--app-text-faint); }

.usage-range-label { margin: 0; color: var(--app-text-muted); font-size: 0.8em; }

.usage-table { border: 1px solid var(--app-border); border-radius: 10px; overflow: hidden; }
.usage-row {
  display: grid;
  grid-template-columns: minmax(0, 2fr) repeat(5, minmax(0, 1fr));
  gap: 8px;
  padding: 9px 12px;
  align-items: center;
  font-size: 0.83em;
}
.usage-row-header {
  background: var(--app-panel-muted);
  color: var(--app-text-muted);
  font-weight: 600;
  font-size: 0.78em;
}
.usage-row-provider {
  border-top: 1px solid var(--app-border);
  cursor: pointer;
  font-weight: 500;
}
.usage-row-provider:hover { background: var(--app-panel-muted); }
.usage-row-provider.expanded { background: var(--app-panel-muted); }
.usage-row-model {
  border-top: 1px solid var(--app-border);
  padding-left: 32px;
  color: var(--app-text-soft);
  font-size: 0.8em;
}

.col-provider { display: flex; align-items: center; gap: 6px; min-width: 0; }
.provider-chevron {
  font-size: 0.7em;
  color: var(--app-text-faint);
  transition: transform 140ms ease;
  flex-shrink: 0;
}
.provider-chevron.expanded { transform: rotate(90deg); }
.provider-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.provider-model-count {
  margin-left: 4px;
  font-size: 0.88em;
  color: var(--app-text-faint);
  flex-shrink: 0;
}
.col-model-name { color: var(--app-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-bullet { color: var(--app-text-faint); }

.col-num { text-align: right; font-variant-numeric: tabular-nums; }
.col-rate { font-weight: 500; }
.rate-good { color: var(--app-success); }

@media (max-width: 720px) {
  .usage-panel { padding: 14px 16px; }
  .usage-head { flex-direction: column; }
  .usage-row { grid-template-columns: minmax(0, 1.6fr) repeat(5, minmax(0, 1fr)); font-size: 0.76em; }
  .line-chart { max-height: 180px; }
}
</style>
