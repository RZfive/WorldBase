<script setup lang="ts">
import type { ChatMessageBlock } from '../types'

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
  <div class="message-event-card web-search-card">
    <div class="web-search-header">
      <div class="web-search-header-main">
        <span class="web-search-label">{{ $t('chatUi.webSearch') }}</span>
        <span class="web-search-engine">{{ props.block.engine }}</span>
      </div>
      <span class="web-search-count">{{ $t('chatUi.webResultCount', { count: props.block.results.length }) }}</span>
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
  </div>
</template>

<style scoped>
.message-event-card {
  width: min(100%, var(--chat-event-card-max, 1080px));
  border: 1px solid var(--app-border-strong);
  border-radius: 18px;
  background: linear-gradient(180deg, var(--app-panel), var(--app-panel-subtle));
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);
  overflow: hidden;
}

.web-search-card {
  padding: 14px 16px 16px;
}

.web-search-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.web-search-header-main {
  display: flex;
  align-items: center;
  gap: 8px;
}

.web-search-label {
  font-size: 0.84rem;
  font-weight: 700;
  color: var(--app-text-strong);
}

.web-search-engine,
.web-search-count {
  font-size: 0.74rem;
  color: var(--app-text-muted);
}

.web-search-query {
  margin-top: 10px;
  padding: 9px 11px;
  border-radius: 12px;
  background: var(--app-panel-strong);
  color: var(--app-text);
  font-size: 0.82rem;
  word-break: break-word;
}

.web-search-list {
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.web-search-item {
  padding: 12px 0 0;
  border-top: 1px solid var(--app-border);
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
}

.web-search-rank {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--app-panel-strong);
  border: 1px solid var(--app-border-strong);
  color: var(--app-text-muted);
  font-size: 0.72rem;
  font-weight: 700;
}

.web-search-source {
  font-size: 0.74rem;
  color: var(--app-text-muted);
}

.web-search-link {
  color: var(--app-accent-strong);
  text-decoration: none;
  font-size: 0.88rem;
  font-weight: 600;
  line-height: 1.45;
}

.web-search-link:hover {
  text-decoration: underline;
}

.web-search-snippet {
  margin: 6px 0 0;
  color: var(--app-text-soft);
  font-size: 0.8rem;
  line-height: 1.55;
}

.web-search-empty {
  margin-top: 12px;
  color: var(--app-text-muted);
  font-size: 0.8rem;
}
</style>
