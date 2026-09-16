<script setup lang="ts">
import { computed } from 'vue'

/**
 * Unified stroke icon set for the conversation sidebar (design doc v1.7:
 * chrome icons are SVG-only — emoji icons are retired from list chrome).
 * Raw inner-SVG strings keep the map flat; every glyph draws with
 * currentColor so theme/hover states flow through.
 */
const ICONS: Record<string, string> = {
  // sidebar panel — collapse/expand the list
  panel: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6.2 3v10"/>',
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.3 10.3l3.2 3.2"/>',
  close: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
  chevron: '<path d="M4.5 6.25L8 9.75l3.5-3.5"/>',
  chevronLeft: '<path d="M10 4.5L6 8l4 3.5"/>',
  folderPlus: '<path d="M2.25 4.75A1.5 1.5 0 0 1 3.75 3.25H6.2a1 1 0 0 1 .77.36l.57.7a1 1 0 0 0 .77.36h3.94a1.5 1.5 0 0 1 1.5 1.5v4.08a1.5 1.5 0 0 1-1.5 1.5H3.75a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M8 6.15v3.7M6.15 8h3.7"/>',
  folder: '<path d="M2.25 5A1.5 1.5 0 0 1 3.75 3.5H6.2a1 1 0 0 1 .77.36l.57.7a1 1 0 0 0 .77.36h3.94a1.5 1.5 0 0 1 1.5 1.5v4.33a1.5 1.5 0 0 1-1.5 1.5H3.75a1.5 1.5 0 0 1-1.5-1.5z"/>',
  pin: '<path d="M9.5 2.5L13.5 6.5L10.5 7.5L8.5 11.5L7 10L4.5 12.5L6 8.5L4.5 7L8.5 5L9.5 2.5Z"/>',
  fork: '<path d="M5.5 3.2v2.6a2.5 2.5 0 0 0 2.5 2.5h0a2.5 2.5 0 0 0 2.5-2.5V3.2"/><circle cx="5.5" cy="3" r="0.01"/><circle cx="10.5" cy="3" r="0.01"/><path d="M8 8.3v4"/>',
  // identity glyphs
  robot: '<rect x="3" y="4" width="10" height="8.5" rx="2"/><path d="M8 1.6V4M6.4 8.2h.01M9.6 8.2h.01"/>',
  people: '<circle cx="5.6" cy="5.8" r="2.1"/><path d="M2.2 13c.5-2.3 1.8-3.4 3.4-3.4s2.9 1.1 3.4 3.4"/><path d="M10.3 4.1a2.1 2.1 0 1 1 .9 4M10.9 9.7c1.5.3 2.5 1.4 2.9 3.3"/>',
  bubble: '<path d="M2.5 3.5h11v7h-6L4 13.5v-3H2.5z"/>',
  target: '<circle cx="8" cy="8" r="5.2"/><circle cx="8" cy="8" r="1.9"/>'
}

const props = withDefaults(defineProps<{
  name: string
  size?: number
}>(), {
  size: 16
})

const inner = computed(() => ICONS[props.name] ?? '')
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.3"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="inner"
  />
</template>
