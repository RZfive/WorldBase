<script setup lang="ts">
import { ref, onMounted } from 'vue'

const skills = ref<SkillInfo[]>([])
const expandedSkillId = ref<string | null>(null)
const loading = ref(false)

async function loadSkills () {
  if (!window.electronAPI) return
  loading.value = true
  try {
    skills.value = await window.electronAPI.listSkills() as SkillInfo[]
  } finally {
    loading.value = false
  }
}

async function importSkill () {
  if (!window.electronAPI) return
  const result = await window.electronAPI.importSkills()
  if (result) {
    await loadSkills()
  }
}

async function deleteSkill (id: string) {
  if (!window.electronAPI) return
  await window.electronAPI.deleteSkill(id)
  if (expandedSkillId.value === id) expandedSkillId.value = null
  await loadSkills()
}

function toggleExpand (id: string) {
  expandedSkillId.value = expandedSkillId.value === id ? null : id
}

function formatDate (ts: string | number) {
  return new Date(ts).toLocaleDateString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  })
}

onMounted(loadSkills)
</script>

<template>
  <div class="sm-root">
    <div class="sm-header">
      <div>
        <h3 class="sm-title">Skill 管理</h3>
        <p class="sm-desc">导入 Skill 文件或 zip 技能包让 AI 掌握专业技能，在聊天中选择激活</p>
      </div>
      <button class="sm-import" @click="importSkill">📥 导入 Skill</button>
    </div>

    <div class="sm-separator" />

    <div v-if="loading" class="sm-empty">加载中...</div>

    <div v-else-if="skills.length === 0" class="sm-empty">
      <p>还没有导入任何 Skill</p>
      <p class="sm-empty-hint">点击「导入 Skill」添加 .md、.txt 或 .zip 格式的技能文件</p>
    </div>

    <div v-else class="sm-list">
      <div
        v-for="skill in skills"
        :key="skill.id"
        class="sm-item"
      >
        <div class="sm-item-row" @click="toggleExpand(skill.id)">
          <div class="sm-item-info">
            <span class="sm-item-name">{{ skill.name }}</span>
            <span class="sm-item-date">{{ formatDate(skill.createdAt) }}</span>
          </div>
          <div class="sm-item-actions">
            <button class="sm-del" @click.stop="deleteSkill(skill.id)" title="删除">×</button>
            <span class="sm-arrow">{{ expandedSkillId === skill.id ? '▾' : '▸' }}</span>
          </div>
        </div>
        <div v-if="skill.description && expandedSkillId !== skill.id" class="sm-item-desc">{{ skill.description }}</div>
        <div v-if="expandedSkillId === skill.id" class="sm-item-content">
          <div v-if="skill.description" class="sm-item-desc-inner">{{ skill.description }}</div>
          <pre>{{ skill.content }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sm-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 20px 28px;
  overflow-y: auto;
  color: var(--app-text);
}

.sm-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.sm-title {
  margin: 0 0 4px;
  font-size: 1.1em;
  color: var(--app-text-strong);
}

.sm-desc {
  margin: 0;
  font-size: 0.85em;
  color: var(--app-text-muted);
}

.sm-import {
  flex-shrink: 0;
  padding: 7px 16px;
  background: var(--app-accent);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 0.85em;
  cursor: pointer;
}
.sm-import:hover { background: var(--app-accent-strong); }

.sm-separator {
  height: 1px;
  background: var(--app-border);
  margin: 16px 0;
}

.sm-empty {
  text-align: center;
  padding: 40px 20px;
  color: var(--app-text-muted);
  font-size: 0.9em;
}
.sm-empty-hint {
  font-size: 0.82em;
  color: var(--app-text-faint);
  margin-top: 6px;
}

.sm-list {
  display: flex;
  flex-direction: column;
}

.sm-item {
  border-bottom: 1px solid var(--app-border);
}
.sm-item:last-child { border-bottom: none; }

.sm-item-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  cursor: pointer;
  user-select: none;
}

.sm-item-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sm-item-name {
  font-size: 0.92em;
  font-weight: 500;
  color: var(--app-text);
}

.sm-item-date {
  font-size: 0.75em;
  color: var(--app-text-faint);
}

.sm-item-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sm-del {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1.1em;
  color: var(--app-text-faint);
  padding: 2px 4px;
}
.sm-del:hover { color: var(--app-danger, #ef4444); }

.sm-arrow {
  color: var(--app-text-faint);
  font-size: 0.8em;
}

.sm-item-desc {
  padding: 0 0 10px;
  font-size: 0.82em;
  color: var(--app-text-soft);
  line-height: 1.4;
}

.sm-item-content {
  padding: 0 0 12px;
}

.sm-item-desc-inner {
  font-size: 0.82em;
  color: var(--app-text-soft);
  line-height: 1.4;
  margin-bottom: 8px;
}

.sm-item-content pre {
  margin: 0;
  padding: 12px;
  background: var(--app-panel-muted);
  border-radius: 8px;
  font-size: 0.82em;
  color: var(--app-text-soft);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'SF Mono', 'Menlo', monospace;
  line-height: 1.5;
  max-height: 400px;
  overflow-y: auto;
}
</style>
