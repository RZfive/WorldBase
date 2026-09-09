<script setup lang="ts">
import type { ChatMessageBlock } from '../types'
import ExecutionDisclosure from './ExecutionDisclosure.vue'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'web_search' }>
}>()

function getHostLabel (url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
</script>

<template>
  <ExecutionDisclosure
    :title="$t('chatUi.webSearch')"
    :meta="$t('chatUi.webResultCount', { count: props.block.results.length })"
    :detail="props.block.query"
    status="completed"
  >
    <div class="web-search-meta">
      <span>{{ props.block.engine }}</span>
      <span>{{ $t('chatUi.webResultCount', { count: props.block.results.length }) }}</span>
    </div>
    <div class="web-search-query">{{ props.block.query }}</div>

    <ol v-if="props.block.results.length > 0" class="web-search-list">
      <li v-for="item in props.block.results" :key="`${props.block.id}-${item.rank}-${item.url}`" class="web-search-item">
        <div class="web-search-item-meta">
          <span class="web-search-rank">{{ item.rank }}</span>
          <span class="web-search-source">{{ getHostLabel(item.url) }}</span>
        </div>
        <a class="web-search-link" :href="item.url" data-chat-external="true">{{ item.title }}</a>
        <p v-if="item.snippet" class="web-search-snippet">{{ item.snippet }}</p>
      </li>
    </ol>

    <div v-else class="web-search-empty">{{ $t('chatUi.noPublicWebResults') }}</div>
  </ExecutionDisclosure>
</template>

<style scoped>
.web-search-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 0.74em;
  color: var(--app-text-muted);
}

.web-search-query {
  margin-top: 8px;
  padding: 8px 0;
  border-top: 1px solid var(--app-border);
  border-bottom: 1px solid var(--app-border);
  color: var(--app-text);
  font-size: 0.8em;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.web-search-list {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.web-search-item {
  min-width: 0;
  padding: 10px 0 0;
  border-top: 1px solid var(--app-border);
  overflow-wrap: anywhere;
}

.web-search-item:first-child {
  padding-top: 0;
  border-top: none;
}

.web-search-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  min-width: 0;
}

.web-search-rank {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--app-border);
  color: var(--app-text-muted);
  font-size: 0.68em;
  font-weight: 700;
}

.web-search-source {
  min-width: 0;
  font-size: 0.74em;
  color: var(--app-text-muted);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.web-search-link {
  display: block;
  color: var(--app-accent-strong);
  text-decoration: none;
  font-size: 0.84em;
  font-weight: 600;
  line-height: 1.45;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.web-search-link:hover {
  text-decoration: underline;
}

.web-search-snippet {
  margin: 6px 0 0;
  color: var(--app-text-soft);
  font-size: 0.78em;
  line-height: 1.55;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.web-search-empty {
  margin-top: 12px;
  color: var(--app-text-muted);
  font-size: 0.78em;
}
</style>
