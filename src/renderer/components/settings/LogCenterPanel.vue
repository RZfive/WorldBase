<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import VirtualJsonTree from './VirtualJsonTree.vue'
import { loadAIExecutionPreferences, persistAIExecutionPreferences } from '../../utils/ai-execution-preferences'

const FEEDBACK_DISPLAY_DURATION_MS = 1800
const loading = ref(false)
const deleting = ref(false)
const savingPreferences = ref(false)
const feedback = ref('')
const executionPreferences = ref<AIExecutionPreferences>({
  notifyOnTaskComplete: true,
  enableAiLogging: false
})
const conversations = ref<AILogConversationSummary[]>([])
const activeConversationId = ref<string | null>(null)
const activeConversation = ref<AILogConversation | null>(null)

const activeSessions = computed(() => {
  if (!activeConversation.value) return []
  return [...activeConversation.value.sessions].sort((left, right) => right.startedAt.localeCompare(left.startedAt))
})

function formatTime (value?: string): string {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function setFeedback (message: string) {
  feedback.value = message
  window.setTimeout(() => {
    if (feedback.value === message) {
      feedback.value = ''
    }
  }, FEEDBACK_DISPLAY_DURATION_MS)
}

async function loadPreferences () {
  try {
    executionPreferences.value = await loadAIExecutionPreferences()
  } catch {
    executionPreferences.value = {
      notifyOnTaskComplete: true,
      enableAiLogging: false
    }
  }
}

async function savePreferences (enableAiLogging: boolean) {
  if (savingPreferences.value) return

  const previousValue = executionPreferences.value.enableAiLogging
  executionPreferences.value = {
    ...executionPreferences.value,
    enableAiLogging
  }

  savingPreferences.value = true
  feedback.value = ''

  try {
    await persistAIExecutionPreferences(executionPreferences.value)
    setFeedback(enableAiLogging ? '日志记录已开启' : '日志记录已关闭')
  } catch (error) {
    executionPreferences.value = {
      ...executionPreferences.value,
      enableAiLogging: previousValue
    }
    setFeedback(`保存失败：${(error as Error).message}`)
  } finally {
    savingPreferences.value = false
  }
}

async function loadConversations () {
  if (!window.electronAPI?.listAILogConversations) return
  loading.value = true
  try {
    conversations.value = await window.electronAPI.listAILogConversations()
    if (!activeConversationId.value && conversations.value.length > 0) {
      activeConversationId.value = conversations.value[0].id
    }
    if (activeConversationId.value) {
      await loadConversation(activeConversationId.value)
    } else {
      activeConversation.value = null
    }
  } finally {
    loading.value = false
  }
}

async function loadConversation (conversationId: string) {
  activeConversationId.value = conversationId
  if (!window.electronAPI?.getAILogConversation) return
  activeConversation.value = await window.electronAPI.getAILogConversation(conversationId)
}

async function deleteConversationLog () {
  if (!activeConversationId.value || !window.electronAPI?.deleteAILogConversation || deleting.value) return
  deleting.value = true
  feedback.value = ''
  try {
    await window.electronAPI.deleteAILogConversation(activeConversationId.value)
    feedback.value = '日志已删除'
    activeConversationId.value = null
    activeConversation.value = null
    await loadConversations()
  } catch (error) {
    feedback.value = `删除失败：${(error as Error).message}`
  } finally {
    deleting.value = false
  }
}

onMounted(async () => {
  await loadPreferences()
  await loadConversations()
})
</script>

<template>
  <div class="lc-root">
    <aside class="lc-sidebar">
      <div class="lc-sidebar-header">
        <div>
          <h3 class="lc-title">日志中心</h3>
          <p class="lc-desc">查看已记录的 AI 对话、请求内容、工具执行和错误信息。</p>
        </div>
        <button class="lc-refresh" :disabled="loading" @click="loadConversations">
          刷新
        </button>
      </div>

      <div class="lc-status" :class="{ disabled: !executionPreferences.enableAiLogging }">
        <div class="lc-status-header">
          <div class="lc-status-copy">
            <strong>{{ executionPreferences.enableAiLogging ? '日志记录已开启' : '日志记录未开启' }}</strong>
            <span>{{ executionPreferences.enableAiLogging ? '新对话会持续写入日志，便于排查模型请求、工具调用和错误。' : '关闭后不会再写入新的 AI 日志，历史记录仍可继续查看。' }}</span>
          </div>
          <input
            type="checkbox"
            class="lc-toggle-input"
            :checked="executionPreferences.enableAiLogging"
            :disabled="savingPreferences"
            @change="savePreferences(($event.target as HTMLInputElement).checked)"
          >
        </div>
        <span class="lc-status-tip">开关只影响新的对话会话，当前已生成的日志不会被删除。</span>
      </div>

      <p v-if="feedback" class="lc-feedback">{{ feedback }}</p>

      <div v-if="conversations.length === 0" class="lc-empty">
        暂无日志记录
      </div>

      <button
        v-for="conversation in conversations"
        :key="conversation.id"
        :class="['lc-item', { active: conversation.id === activeConversationId }]"
        @click="loadConversation(conversation.id)"
      >
        <div class="lc-item-title-row">
          <span class="lc-item-title">{{ conversation.title }}</span>
          <span class="lc-item-status" :data-status="conversation.lastStatus || 'completed'">{{ conversation.lastStatus || 'completed' }}</span>
        </div>
        <div class="lc-item-meta">
          <span>{{ formatTime(conversation.updatedAt) }}</span>
          <span>{{ conversation.sessionCount }} 次会话</span>
          <span>{{ conversation.errorCount }} 条错误</span>
        </div>
      </button>
    </aside>

    <section class="lc-detail">
      <template v-if="activeConversation">
        <header class="lc-detail-header">
          <div>
            <h3 class="lc-detail-title">{{ activeConversation.title }}</h3>
            <p class="lc-detail-meta">
              创建于 {{ formatTime(activeConversation.createdAt) }} · 更新于 {{ formatTime(activeConversation.updatedAt) }}
            </p>
          </div>
          <button class="lc-delete" :disabled="deleting" @click="deleteConversationLog">
            删除此日志
          </button>
        </header>

        <div class="lc-session-list">
          <article v-for="session in activeSessions" :key="session.id" class="lc-session-card">
            <div class="lc-session-header">
              <div>
                <div class="lc-session-title">会话 {{ session.id }}</div>
                <div class="lc-session-meta">
                  <span>状态：{{ session.status }}</span>
                  <span>开始：{{ formatTime(session.startedAt) }}</span>
                  <span>结束：{{ formatTime(session.finishedAt) }}</span>
                </div>
              </div>
              <div class="lc-session-tags">
                <span v-if="session.providerId" class="lc-tag">Provider: {{ session.providerId }}</span>
                <span v-if="session.modelId" class="lc-tag">Model: {{ session.modelId }}</span>
                <span v-if="session.authMode" class="lc-tag">Auth: {{ session.authMode }}</span>
                <span v-if="session.targetProjectId" class="lc-tag">Project: {{ session.targetProjectId }}</span>
              </div>
            </div>

            <details open class="lc-section">
              <summary>上传给 AI 的消息 ({{ session.uploadedMessages.length }})</summary>
              <div class="lc-section-body">
                <VirtualJsonTree :value="session.uploadedMessages" :max-height="360" />
              </div>
            </details>

            <details class="lc-section">
              <summary>模型请求 / 响应 ({{ session.providerCalls.length }})</summary>
              <div class="lc-section-body">
                <VirtualJsonTree :value="session.providerCalls" :max-height="360" />
              </div>
            </details>

            <details class="lc-section">
              <summary>工具调用 ({{ session.toolExecutions.length }})</summary>
              <div class="lc-section-body">
                <VirtualJsonTree :value="session.toolExecutions" :max-height="360" />
              </div>
            </details>

            <details class="lc-section" :open="session.errors.length > 0">
              <summary>错误记录 ({{ session.errors.length }})</summary>
              <div class="lc-section-body">
                <VirtualJsonTree :value="session.errors" :max-height="300" />
              </div>
            </details>

            <details v-if="session.finalAssistantMessage" class="lc-section">
              <summary>最终回复</summary>
              <div class="lc-section-body">
                <VirtualJsonTree :value="session.finalAssistantMessage" :max-height="280" />
              </div>
            </details>
          </article>
        </div>
      </template>

      <div v-else class="lc-detail-empty">
        请选择左侧一条日志记录查看详情。
      </div>
    </section>
  </div>
</template>

<style scoped>
.lc-root {
  display: flex;
  height: 100%;
  color: var(--app-text);
}

.lc-sidebar {
  width: 320px;
  flex-shrink: 0;
  border-right: 1px solid var(--app-border);
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}

.lc-sidebar-header,
.lc-detail-header,
.lc-session-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.lc-title,
.lc-detail-title {
  margin: 0;
  font-size: 1.05em;
  color: var(--app-text-strong);
}

.lc-desc,
.lc-detail-meta,
.lc-item-meta,
.lc-session-meta {
  margin: 4px 0 0;
  font-size: 0.8em;
  color: var(--app-text-muted);
  line-height: 1.5;
}

.lc-refresh,
.lc-delete {
  border: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
  color: var(--app-text);
  border-radius: 8px;
  padding: 8px 12px;
  cursor: pointer;
}

.lc-status {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 12px;
  background: var(--app-accent-soft);
  color: var(--app-accent);
  font-size: 0.82em;
}

.lc-status-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.lc-status-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.lc-status.disabled {
  background: var(--app-panel-subtle);
  color: var(--app-text-muted);
}

.lc-toggle-input {
  width: 18px;
  height: 18px;
  accent-color: var(--app-accent);
  flex-shrink: 0;
}

.lc-status-tip {
  color: inherit;
  opacity: 0.82;
}

.lc-feedback {
  margin: 0;
  font-size: 0.8em;
  color: var(--app-accent);
}

.lc-empty,
.lc-detail-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--app-text-muted);
  font-size: 0.86em;
  min-height: 120px;
}

.lc-item {
  width: 100%;
  border: 1px solid var(--app-border);
  background: var(--app-panel-subtle);
  border-radius: 12px;
  padding: 12px;
  text-align: left;
  cursor: pointer;
}

.lc-item.active {
  border-color: var(--app-accent);
  background: var(--app-accent-soft);
}

.lc-item-title-row,
.lc-item-meta,
.lc-session-meta,
.lc-session-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.lc-item-title,
.lc-session-title {
  font-weight: 600;
  color: var(--app-text-strong);
}

.lc-item-status {
  font-size: 0.75em;
  text-transform: uppercase;
  color: var(--app-text-muted);
}

.lc-item-status[data-status='failed'] {
  color: #d9534f;
}

.lc-item-status[data-status='completed'] {
  color: #2f855a;
}

.lc-item-status[data-status='running'] {
  color: var(--app-accent);
}

.lc-detail {
  flex: 1;
  min-width: 0;
  padding: 20px 24px;
  overflow-y: auto;
}

.lc-session-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 16px;
}

.lc-session-card {
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-panel-subtle);
  padding: 16px;
}

.lc-session-tags {
  justify-content: flex-end;
}

.lc-tag {
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--app-main-surface);
  font-size: 0.75em;
  color: var(--app-text-muted);
}

.lc-section {
  margin-top: 12px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-main-surface);
  overflow: hidden;
}

.lc-section summary {
  cursor: pointer;
  padding: 10px 12px;
  font-size: 0.82em;
  font-weight: 600;
  color: var(--app-text-soft);
}

.lc-section-body {
  padding: 0 12px 12px;
}
</style>
