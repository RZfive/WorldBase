<script setup lang="ts">
import type { ChatMessageBlock } from '../types'

const props = defineProps<{
  block: Extract<ChatMessageBlock, { kind: 'web_fetch' }>
}>()

function getDisplayUrl (): string {
  return props.block.result.final_url || props.block.result.url
}

function getHostLabel (): string {
  try {
    return new URL(getDisplayUrl()).hostname.replace(/^www\./, '')
  } catch {
    return getDisplayUrl()
  }
}

function getSummaryText (): string {
  if (props.block.result.description) return props.block.result.description
  const normalized = props.block.result.content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 320) return normalized
  return `${normalized.slice(0, 320).trimEnd()}…`
}

function getQuoteSnippets (): string[] {
  return (props.block.result.query_snippets || []).slice(0, 3)
}
</script>

<template>
  <div class="message-event-card web-fetch-card" :class="{ failed: !props.block.result.ok }">
    <div class="web-fetch-header">
      <div class="web-fetch-header-main">
        <span class="web-fetch-label">{{ props.block.result.ok ? $t('chatUi.webReference') : $t('chatUi.webFetchFailed') }}</span>
        <span v-if="props.block.query" class="web-fetch-query">{{ props.block.query }}</span>
      </div>
      <span class="web-fetch-status">{{ props.block.result.status ? `${props.block.result.status}` : $t('chatUi.error') }}</span>
    </div>

    <a class="web-fetch-link" :href="getDisplayUrl()" data-chat-external="true">
      {{ props.block.result.title || getDisplayUrl() }}
    </a>

    <div class="web-fetch-meta">
      <span>{{ getHostLabel() }}</span>
      <span v-if="props.block.result.content_type">{{ props.block.result.content_type }}</span>
      <span v-if="props.block.result.truncated">{{ $t('chatUi.contentTruncated') }}</span>
    </div>

    <div v-if="!props.block.result.ok" class="web-fetch-error">
      {{ props.block.result.error || $t('chatUi.webFetchFailed') }}
    </div>

    <template v-else>
      <p v-if="getSummaryText()" class="web-fetch-summary">{{ getSummaryText() }}</p>

      <div v-if="getQuoteSnippets().length > 0" class="web-fetch-quotes">
        <blockquote v-for="snippet in getQuoteSnippets()" :key="snippet" class="web-fetch-quote">{{ snippet }}</blockquote>
      </div>
    </template>
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

.web-fetch-card {
  padding: 14px 16px 16px;
}

.web-fetch-card.failed {
  border-color: rgba(239, 68, 68, 0.22);
}

.web-fetch-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.web-fetch-header-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.web-fetch-label {
  font-size: 0.84em;
  font-weight: 700;
  color: var(--app-text-strong);
}

.web-fetch-query {
  font-size: 0.74em;
  color: var(--app-accent-strong);
  background: var(--app-accent-soft);
  border: 1px solid var(--app-accent-glow);
  border-radius: 999px;
  padding: 3px 8px;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.web-fetch-status {
  font-size: 0.74em;
  color: var(--app-text-muted);
}

.web-fetch-link {
  display: inline-block;
  margin-top: 10px;
  color: var(--app-accent-strong);
  text-decoration: none;
  font-size: 0.92em;
  font-weight: 600;
  line-height: 1.45;
}

.web-fetch-link:hover {
  text-decoration: underline;
}

.web-fetch-meta {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  color: var(--app-text-muted);
  font-size: 0.75em;
}

.web-fetch-summary,
.web-fetch-error {
  margin: 10px 0 0;
  color: var(--app-text-soft);
  font-size: 0.82em;
  line-height: 1.58;
}

.web-fetch-error {
  color: #dc2626;
}

.web-fetch-quotes {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.web-fetch-quote {
  margin: 0;
  padding: 10px 12px;
  border-left: 3px solid var(--app-accent);
  border-radius: 0 12px 12px 0;
  background: var(--app-panel-strong);
  color: var(--app-text);
  font-size: 0.8em;
  line-height: 1.58;
}
</style>
