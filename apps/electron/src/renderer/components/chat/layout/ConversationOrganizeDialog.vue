<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

export interface OrganizeConversationRow {
  id: string
  title: string
}

export interface OrganizeGroup {
  name: string
  isNew: boolean
  conversations: OrganizeConversationRow[]
}

const props = defineProps<{
  open: boolean
  loading: boolean
  stage: string
  /** 0..1 when the shell knows the batch position; null = indeterminate. */
  progress: number | null
  error: string
  groups: OrganizeGroup[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm', groups: OrganizeGroup[]): void
}>()

const { t } = useI18n()

// Local copy so ✕ exclusions never mutate the shell's proposal in place.
const localGroups = ref<OrganizeGroup[]>([])
watch(() => props.groups, (groups) => {
  localGroups.value = groups.map(group => ({ ...group, conversations: [...group.conversations] }))
}, { immediate: true })

function removeConversation (groupName: string, conversationId: string): void {
  localGroups.value = localGroups.value
    .map(group => group.name === groupName
      ? { ...group, conversations: group.conversations.filter(row => row.id !== conversationId) }
      : group)
    .filter(group => group.conversations.length > 0)
}

const totalCount = computed(() => localGroups.value.reduce((sum, group) => sum + group.conversations.length, 0))

function confirm (): void {
  if (props.loading || totalCount.value === 0) return
  emit('confirm', localGroups.value)
}
</script>

<template>
  <teleport to="body">
    <div v-if="open" class="org-overlay" @click.self="emit('close')">
      <div class="org-dialog" role="dialog" aria-modal="true" :aria-label="$t('chatUi.organizeDialogTitle')">
        <div class="org-head">
          <span class="org-title">{{ $t('chatUi.organizeDialogTitle') }}</span>
          <button class="org-close" type="button" :aria-label="$t('common.close')" @click="emit('close')">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <div v-if="loading" class="org-progress-block">
          <div class="org-progress" role="progressbar" :aria-label="$t('chatUi.organizeProgress')">
            <div
              class="org-progress-bar"
              :class="{ indeterminate: progress == null }"
              :style="progress != null ? { width: `${Math.round(progress * 100)}%` } : {}"
            ></div>
          </div>
          <p class="org-stage">{{ stage || $t('chatUi.organizeStageModel') }}</p>
        </div>

        <template v-else>
          <div v-if="error" class="org-error" role="alert">{{ error }}</div>

          <div v-if="localGroups.length === 0 && !error" class="org-empty">{{ $t('chatUi.organizeNothingToSort') }}</div>

          <div v-if="localGroups.length > 0" class="org-body">
            <p class="org-hint">
              {{ $t('chatUi.organizeGroupsTitle', { groups: localGroups.length, count: totalCount }) }}
              · {{ $t('chatUi.organizeRemoveHint') }}
            </p>
            <section v-for="group in localGroups" :key="group.name" class="org-group">
              <div class="org-group-head">
                <span class="org-group-name" :title="group.name">{{ group.name }}</span>
                <span v-if="group.isNew" class="org-group-new">{{ $t('chatUi.organizeNewFolder') }}</span>
                <span class="org-group-count">{{ group.conversations.length }}</span>
              </div>
              <div class="org-group-rows">
                <div v-for="row in group.conversations" :key="row.id" class="org-row">
                  <span class="org-row-title" :title="row.title">{{ row.title }}</span>
                  <button
                    class="org-row-remove"
                    type="button"
                    :aria-label="$t('chatUi.organizeExclude')"
                    @click="removeConversation(group.name, row.id)"
                  >
                    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                    </svg>
                  </button>
                </div>
              </div>
            </section>
          </div>
        </template>

        <div class="org-foot">
          <span class="org-foot-hint">{{ $t('chatUi.organizeDefaultProviderHint') }}</span>
          <div class="org-foot-actions">
            <button class="org-btn" type="button" @click="emit('close')">{{ $t('common.cancel') }}</button>
            <button
              v-if="!loading && localGroups.length > 0"
              class="org-btn org-btn-primary"
              type="button"
              :disabled="totalCount === 0"
              @click="confirm"
            >
              {{ $t('chatUi.organizeApply') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.org-overlay {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, #000 42%, transparent);
}

.org-dialog {
  width: min(460px, calc(100vw - 48px));
  max-height: min(560px, calc(100vh - 80px));
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-md);
  border: 1px solid var(--app-border-strong);
  background: var(--app-panel-strong);
  box-shadow: var(--shadow-3);
  overflow: hidden;
}

.org-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--app-border);
}

.org-title {
  flex: 1;
  font-size: 0.86rem;
  font-weight: 650;
  color: var(--app-text-strong);
}

.org-close {
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text-faint);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.org-close:hover {
  background: var(--app-panel-muted);
  color: var(--app-text);
}

.org-close svg {
  width: 12px;
  height: 12px;
}

.org-progress-block {
  padding: 22px 16px 26px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}

.org-progress {
  width: 200px;
  height: 6px;
  border-radius: 999px;
  background: var(--app-panel-muted);
  overflow: hidden;
}

.org-progress-bar {
  height: 100%;
  border-radius: 999px;
  background: var(--app-sig);
  transition: width 0.25s ease;
}

.org-progress-bar.indeterminate {
  width: 40%;
  animation: org-slide 1.15s ease-in-out infinite;
}

@keyframes org-slide {
  0% { transform: translateX(-110%); }
  100% { transform: translateX(300%); }
}

@media (prefers-reduced-motion: reduce) {
  .org-progress-bar { animation: none; width: 100%; opacity: 0.6; }
}

.org-stage {
  margin: 0;
  font-size: 0.76rem;
  color: var(--app-text-muted);
  text-align: center;
}

.org-error {
  margin: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--app-danger-soft);
  color: var(--app-danger);
  font-size: 0.78rem;
}

.org-empty {
  padding: 26px 16px;
  text-align: center;
  color: var(--app-text-faint);
  font-size: 0.8rem;
}

.org-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.org-hint {
  margin: 0;
  font-size: 0.72rem;
  color: var(--app-text-faint);
}

.org-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.org-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.org-group-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.78rem;
  font-weight: 650;
  color: var(--app-text);
}

.org-group-new {
  flex-shrink: 0;
  font-size: 0.6rem;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--app-accent-soft);
  color: var(--app-accent-strong);
}

.org-group-count {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 0.66rem;
  color: var(--app-text-faint);
  font-variant-numeric: tabular-nums;
}

.org-group-rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 10px;
  border-left: 1px solid var(--app-border);
}

.org-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 2px 6px;
  border-radius: 6px;
}

.org-row:hover {
  background: var(--app-panel-muted);
}

.org-row-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.74rem;
  color: var(--app-text-soft);
}

.org-row-remove {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--app-text-faint);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
}

.org-row:hover .org-row-remove,
.org-row-remove:focus-visible {
  opacity: 1;
}

.org-row-remove:hover {
  background: var(--app-danger-soft);
  color: var(--app-danger);
}

.org-row-remove svg {
  width: 9px;
  height: 9px;
}

.org-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid var(--app-border);
}

.org-foot-hint {
  flex: 1;
  min-width: 0;
  font-size: 0.68rem;
  color: var(--app-text-faint);
}

.org-foot-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.org-btn {
  padding: 5px 14px;
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: var(--app-input-bg);
  color: var(--app-text);
  font-size: 0.76rem;
  cursor: pointer;
}

.org-btn:hover {
  border-color: var(--app-border-strong);
}

.org-btn-primary {
  border: none;
  background: var(--app-accent);
  color: var(--app-on-accent);
}

.org-btn-primary:hover {
  background: var(--app-accent-strong);
}

.org-btn-primary:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
