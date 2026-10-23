<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  text: string
  active?: boolean
}>(), {
  active: false
})

const MIN_SCROLL_DURATION_SECONDS = 8
const SCROLL_PIXELS_PER_SECOND = 40

const containerRef = ref<HTMLElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)
const isScrolling = ref(false)
const isOverflowing = ref(false)

let resizeObserver: ResizeObserver | null = null
let reduceMotionQuery: MediaQueryList | null = null
let reducedMotion = false
let measureFrame = 0
let pendingForceRestart = false
let disposed = false

// A token append extends the current text. Only a genuinely different
// activity (neither string is a prefix of the other) restarts the marquee.
function isUnrelatedTextChange (previous: string, next: string): boolean {
  if (!previous || !next) return false
  return !previous.startsWith(next) && !next.startsWith(previous)
}

function cancelMeasureFrame (): void {
  if (measureFrame === 0) return
  cancelAnimationFrame(measureFrame)
  measureFrame = 0
}

// Streaming can append several tokens between paints. Coalesce every layout
// read into one rAF so measurement runs at most once per frame; a real activity
// switch is latched until that frame runs.
function scheduleMeasure (forceRestart = false): void {
  if (disposed) return
  if (forceRestart) pendingForceRestart = true
  if (measureFrame !== 0) return
  measureFrame = requestAnimationFrame(() => {
    measureFrame = 0
    const force = pendingForceRestart
    pendingForceRestart = false
    measure(force)
  })
}

function restartAnimation (): void {
  const content = contentRef.value
  if (!content) return
  content.style.animation = 'none'
  // Force the browser to commit the cleared animation before restarting it.
  void content.offsetWidth
  content.style.animation = ''
}

function resetMarquee (): void {
  cancelMeasureFrame()
  pendingForceRestart = false
  isScrolling.value = false
  isOverflowing.value = false
  const content = contentRef.value
  if (!content) return
  content.style.removeProperty('--work-ticker-distance')
  content.style.removeProperty('--work-ticker-duration')
  content.style.removeProperty('animation')
}

function measure (forceRestart = false): void {
  const container = containerRef.value
  const content = contentRef.value
  if (!container || !content) return

  const distance = Math.max(0, content.scrollWidth - container.clientWidth)
  const overflowing = distance > 1
  isOverflowing.value = overflowing

  // Settled groups keep a static, clipped activity line. Only the live turn
  // marquees; historical rows must not animate forever.
  if (!overflowing || !props.active) {
    isScrolling.value = false
    content.style.removeProperty('--work-ticker-distance')
    content.style.removeProperty('--work-ticker-duration')
    return
  }

  const wasScrolling = isScrolling.value
  const duration = Math.max(MIN_SCROLL_DURATION_SECONDS, distance / SCROLL_PIXELS_PER_SECOND)

  content.style.setProperty('--work-ticker-distance', `-${distance}px`)
  // Keep the duration stable while text grows so the marquee keeps its
  // position; only a fresh start recalculates it from the new width.
  if (!wasScrolling || forceRestart) {
    content.style.setProperty('--work-ticker-duration', `${duration}s`)
  }

  if (reducedMotion) {
    isScrolling.value = false
    return
  }

  isScrolling.value = true
  if (wasScrolling && forceRestart) {
    restartAnimation()
  }
}

function handleWindowResize (): void {
  scheduleMeasure()
}

function handleReducedMotionChange (event: MediaQueryListEvent): void {
  reducedMotion = event.matches
  scheduleMeasure()
}

watch(() => props.text, (next, previous) => {
  if (!next) {
    resetMarquee()
    return
  }
  scheduleMeasure(isUnrelatedTextChange(previous || '', next || ''))
})

watch(() => props.active, () => {
  scheduleMeasure()
})

onMounted(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotion = reduceMotionQuery.matches
    reduceMotionQuery.addEventListener('change', handleReducedMotionChange)
  }

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => scheduleMeasure())
    if (containerRef.value) resizeObserver.observe(containerRef.value)
    if (contentRef.value) resizeObserver.observe(contentRef.value)
  } else if (typeof window !== 'undefined') {
    window.addEventListener('resize', handleWindowResize)
  }

  scheduleMeasure()
})

onBeforeUnmount(() => {
  disposed = true
  cancelMeasureFrame()
  pendingForceRestart = false
  resizeObserver?.disconnect()
  resizeObserver = null
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', handleWindowResize)
  }
  reduceMotionQuery?.removeEventListener('change', handleReducedMotionChange)
  reduceMotionQuery = null
})
</script>

<template>
  <span
    v-show="Boolean(props.text)"
    ref="containerRef"
    class="work-activity-ticker"
    :class="{
      'is-active': props.active,
      'is-overflowing': isOverflowing,
      'is-scrolling': isScrolling
    }"
    :title="props.text"
  >
    <span class="work-activity-ticker-accessible">{{ props.text }}</span>
    <span
      ref="contentRef"
      class="work-activity-ticker-content"
      aria-hidden="true"
    >{{ props.text }}</span>
  </span>
</template>

<style scoped>
.work-activity-ticker {
  --work-ticker-fade-left: 0px;
  --work-ticker-fade-right: 0px;
  position: relative;
  display: block;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  color: var(--app-text-muted);
}

.work-activity-ticker.is-active {
  color: var(--app-text);
}

/* Fade the trailing clip edge while the text rests at its start, and both
   edges only while the marquee runs, so the first characters stay legible
   whenever the row is at rest. Pure alpha mask: theme agnostic. */
.work-activity-ticker.is-overflowing {
  --work-ticker-fade-right: 12px;
  -webkit-mask-image: linear-gradient(
    to right,
    transparent 0,
    #000 var(--work-ticker-fade-left),
    #000 calc(100% - var(--work-ticker-fade-right)),
    transparent 100%
  );
  mask-image: linear-gradient(
    to right,
    transparent 0,
    #000 var(--work-ticker-fade-left),
    #000 calc(100% - var(--work-ticker-fade-right)),
    transparent 100%
  );
}

.work-activity-ticker.is-overflowing.is-scrolling {
  --work-ticker-fade-left: 12px;
}

.work-activity-ticker-content {
  display: inline-block;
  white-space: nowrap;
  color: inherit;
}

.work-activity-ticker.is-scrolling .work-activity-ticker-content {
  will-change: transform;
  animation: work-activity-ticker-marquee var(--work-ticker-duration, 8s) linear infinite;
}

/* Give readers a way to stop the motion while inspecting the row. */
.work-activity-ticker:hover .work-activity-ticker-content {
  animation-play-state: paused;
}

.work-activity-ticker-accessible {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

@keyframes work-activity-ticker-marquee {
  from { transform: translateX(0); }
  to { transform: translateX(var(--work-ticker-distance, 0px)); }
}

@media (prefers-reduced-motion: reduce) {
  .work-activity-ticker.is-overflowing.is-scrolling {
    --work-ticker-fade-left: 0px;
  }

  .work-activity-ticker.is-scrolling .work-activity-ticker-content {
    animation: none;
    transform: none;
  }
}
</style>
