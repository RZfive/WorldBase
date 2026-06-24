<script setup lang="ts">
import type { ChatMessageBlock } from '../types'
import ExecutionDisclosure from './ExecutionDisclosure.vue'

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
  <ExecutionDisclosure
    :title="props.block.result.ok ? $t('chatUi.webReference') : $t('chatUi.webFetchFailed')"
    :meta="props.block.result.status ? `${props.block.result.status}` : $t('chatUi.error')"
    :detail="props.block.result.title || getHostLabel()"
    :status="props.block.result.ok ? 'completed' : 'failed'"
    :default-expanded="!props.block.result.ok"
  >
    <div class="web-fetch-topline">
      <span v-if="props.block.query" class="web-fetch-query">{{ props.block.query }}</span>
      <span>{{ getHostLabel() }}</span>
      <span v-if="props.block.result.content_type">{{ props.block.result.content_type }}</span>
      <span v-if="props.block.result.truncated">{{ $t('chatUi.contentTruncated') }}</span>
    </div>
    <a class="web-fetch-link" :href="getDisplayUrl()" data-chat-external="true">
      {{ props.block.result.title || getDisplayUrl() }}
    </a>

    <div v-if="!props.block.result.ok" class="web-fetch-error">
      {{ props.block.result.error || $t('chatUi.webFetchFailed') }}
    </div>

    <template v-else>
      <p v-if="getSummaryText()" class="web-fetch-summary">{{ getSummaryText() }}</p>

      <div v-if="getQuoteSnippets().length > 0" class="web-fetch-quotes">
        <blockquote v-for="snippet in getQuoteSnippets()" :key="snippet" class="web-fetch-quote">{{ snippet }}</blockquote>
      </div>
    </template>
  </ExecutionDisclosure>
</template>

<style scoped>
.web-fetch-topline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--app-text-muted);
  font-size: 0.74em;
}

.web-fetch-query {
  color: var(--app-accent-strong);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.web-fetch-link {
  display: inline-block;
  margin-top: 8px;
  color: var(--app-accent-strong);
  text-decoration: none;
  font-size: 0.86em;
  font-weight: 600;
  line-height: 1.45;
}

.web-fetch-link:hover {
  text-decoration: underline;
}

.web-fetch-summary,
.web-fetch-error {
  margin: 8px 0 0;
  color: var(--app-text-soft);
  font-size: 0.8em;
  line-height: 1.58;
}

.web-fetch-error {
  color: #dc2626;
}

.web-fetch-quotes {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.web-fetch-quote {
  margin: 0;
  padding: 8px 10px;
  border-left: 2px solid var(--app-border-strong);
  background: transparent;
  color: var(--app-text);
  font-size: 0.78em;
  line-height: 1.58;
}
</style>
