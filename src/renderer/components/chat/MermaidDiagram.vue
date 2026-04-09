<script setup lang="ts">
import { ref, watch } from "vue";
import { renderMermaidSvg } from "./mermaid";

const props = withDefaults(
  defineProps<{
    code: string;
    mode?: "inline" | "preview";
    previewable?: boolean;
  }>(),
  {
    mode: "inline",
    previewable: false,
  },
);

const emit = defineEmits<{
  (e: "openPreview"): void;
}>();

const svgMarkup = ref("");
const renderError = ref("");
const isRendering = ref(false);

async function renderDiagram() {
  const code = props.code.trim();
  svgMarkup.value = "";
  renderError.value = "";

  if (!code) {
    renderError.value = "Mermaid 内容为空";
    return;
  }

  isRendering.value = true;
  try {
    svgMarkup.value = await renderMermaidSvg(code);
  } catch (error) {
    renderError.value =
      error instanceof Error ? error.message : "Mermaid 图表渲染失败";
  } finally {
    isRendering.value = false;
  }
}

watch(
  () => props.code,
  () => {
    void renderDiagram();
  },
  { immediate: true },
);
</script>

<template>
  <div class="mermaid-diagram" :class="props.mode">
    <div class="mermaid-diagram-header" v-if="props.mode === 'inline'">
      <div class="mermaid-diagram-meta">
        <span class="mermaid-diagram-badge">Mermaid</span>
        <span class="mermaid-diagram-hint">点击展开查看大图</span>
      </div>
      <button
        v-if="props.previewable && props.mode === 'inline'"
        class="mermaid-diagram-action"
        type="button"
        @click="emit('openPreview')"
      >
        展开放大
      </button>
    </div>

    <div
      class="mermaid-diagram-canvas"
      :class="{ preview: props.mode === 'preview' }"
    >
      <div
        v-if="svgMarkup"
        class="mermaid-diagram-svg"
        v-html="svgMarkup"
      ></div>
      <div v-else-if="isRendering" class="mermaid-diagram-placeholder">
        正在生成图表…
      </div>
      <div v-else class="mermaid-diagram-error">
        <strong>图表渲染失败</strong>
        <span>{{ renderError }}</span>
        <pre>{{ props.code }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mermaid-diagram {
  width: 100%;
  border-radius: 18px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel);
  overflow: hidden;
}

.mermaid-diagram.preview {
  min-width: min(960px, calc(100vw - 220px));
  width: max-content;
  max-width: none;
}

.mermaid-diagram-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--app-border);
  background: linear-gradient(
    180deg,
    var(--app-panel),
    var(--app-panel-subtle)
  );
}

.mermaid-diagram-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.mermaid-diagram-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--app-accent-soft);
  border: 1px solid var(--app-accent-glow);
  color: var(--app-text-strong);
  font-size: 0.76rem;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.mermaid-diagram-hint {
  font-size: 0.78rem;
  color: var(--app-text-muted);
}

.mermaid-diagram-action {
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--app-border-strong);
  background: transparent;
  color: var(--app-text-strong);
  cursor: pointer;
  transition:
    border-color 0.16s ease,
    background 0.16s ease;
}

.mermaid-diagram-action:hover {
  border-color: var(--app-accent);
  background: var(--app-panel-muted);
}

.mermaid-diagram-canvas {
  padding: 16px;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.72),
    rgba(244, 247, 255, 0.96)
  );
  overflow-x: auto;
}

.mermaid-diagram-canvas.preview {
  overflow: visible;
  min-width: 0;
}

.mermaid-diagram-placeholder,
.mermaid-diagram-error {
  min-height: 180px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--app-text-muted);
  text-align: center;
}

.mermaid-diagram-error strong {
  color: var(--app-text-strong);
}

.mermaid-diagram-error pre {
  margin: 0;
  width: 100%;
  max-width: 100%;
  overflow: auto;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  color: var(--app-text);
  text-align: left;
  font-size: 0.8rem;
  line-height: 1.55;
}

.mermaid-diagram-svg {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  min-width: fit-content;
}

.mermaid-diagram.inline .mermaid-diagram-svg :deep(svg) {
  display: block;
  width: min(100%, 960px);
  height: auto;
}

.mermaid-diagram.preview .mermaid-diagram-svg :deep(svg) {
  display: block;
  width: auto;
  height: auto;
  max-width: none;
}

@media (max-width: 860px) {
  .mermaid-diagram.preview {
    min-width: min(720px, calc(100vw - 72px));
  }

  .mermaid-diagram-header {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
