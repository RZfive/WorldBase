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

function formatFileSize (bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getTotalSize (skill: SkillInfo): number {
  return skill.files.reduce((sum, f) => sum + f.size, 0)
}

function getFileTypeSummary (skill: SkillInfo): string {
  const types: Record<string, number> = {}
  for (const f of skill.files) {
    types[f.type] = (types[f.type] || 0) + 1
  }
  const labels: Record<string, string> = {
    markdown: '文档',
    script: '脚本',
    config: '配置',
    code: '代码',
    other: '其它'
  }
  return Object.entries(types)
    .map(([type, count]) => `${labels[type] || type} ${count}`)
    .join('、')
}

onMounted(loadSkills)
</script>

<template>
  <div class="sm-root">
    <div class="sm-header">
      <div>
        <h3 class="sm-title">Skill 管理</h3>
        <p class="sm-desc">导入 Skill 文件、zip 技能包或文件夹让 AI 掌握专业技能，在聊天中选择激活</p>
      </div>
      <button class="sm-import" @click="importSkill">📥 导入 Skill</button>
    </div>

    <div class="sm-separator" />

    <div v-if="loading" class="sm-empty">加载中...</div>

    <div v-else-if="skills.length === 0" class="sm-empty">
      <p>还没有导入任何 Skill</p>
      <p class="sm-empty-hint">点击「导入 Skill」添加 .md、.txt、.zip 格式的技能文件或整个文件夹</p>
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
            <span v-if="skill.description && expandedSkillId !== skill.id" class="sm-item-brief">{{ skill.description }}</span>
            <span class="sm-item-meta">
              {{ formatDate(skill.createdAt) }}
              <template v-if="skill.fileCount > 0"> · {{ skill.fileCount }} 个文件</template>
              <template v-if="skill.tools.length > 0"> · {{ skill.tools.length }} 个工具</template>
            </span>
          </div>
          <div class="sm-item-actions">
            <button class="sm-del" @click.stop="deleteSkill(skill.id)" title="删除">×</button>
            <span class="sm-arrow">{{ expandedSkillId === skill.id ? '▾' : '▸' }}</span>
          </div>
        </div>
        <div v-if="expandedSkillId === skill.id" class="sm-item-detail">
          <div v-if="skill.description" class="sm-item-desc-inner">{{ skill.description }}</div>

          <!-- Stats overview -->
          <div class="sm-stats">
            <div class="sm-stat-row">
              <span class="sm-stat-label">📁 文件</span>
              <span class="sm-stat-value">{{ skill.fileCount }} 个 ({{ formatFileSize(getTotalSize(skill)) }})</span>
            </div>
            <div v-if="skill.fileCount > 0" class="sm-stat-row">
              <span class="sm-stat-label">📄 组成</span>
              <span class="sm-stat-value">{{ getFileTypeSummary(skill) }}</span>
            </div>
            <div v-if="skill.tools.length > 0" class="sm-stat-row">
              <span class="sm-stat-label">🔧 提供工具</span>
              <span class="sm-stat-value">{{ skill.tools.join('、') }}</span>
            </div>
            <div v-if="skill.scripts.length > 0" class="sm-stat-row">
              <span class="sm-stat-label">⚡ 可执行脚本</span>
              <span class="sm-stat-value">{{ skill.scripts.length }} 个</span>
            </div>
          </div>

          <!-- Scripts list -->
          <div v-if="skill.scripts.length > 0" class="sm-scripts">
            <div v-for="script in skill.scripts" :key="script.relativePath" class="sm-script-item">
              <span class="sm-script-lang">{{ script.language }}</span>
              <span class="sm-script-path">{{ script.relativePath }}</span>
            </div>
          </div>

          <!-- File list -->
          <div v-if="skill.fileCount > 0" class="sm-files">
            <div class="sm-files-title">文件列表</div>
            <div class="sm-files-scroll">
              <div v-for="file in skill.files" :key="file.relativePath" class="sm-file-item">
                <span class="sm-file-path">{{ file.relativePath }}</span>
                <span class="sm-file-size">{{ formatFileSize(file.size) }}</span>
              </div>
            </div>
          </div>
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
  overflow: hidden;
}

.sm-item-name {
  font-size: 0.92em;
  font-weight: 500;
  color: var(--app-text);
}

.sm-item-brief {
  font-size: 0.8em;
  color: var(--app-text-soft);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sm-item-meta {
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

.sm-item-detail {
  padding: 0 0 12px;
}

.sm-item-desc-inner {
  font-size: 0.82em;
  color: var(--app-text-soft);
  line-height: 1.4;
  margin-bottom: 8px;
}

.sm-stats {
  background: var(--app-panel-muted);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 10px;
}

.sm-stat-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 0.82em;
}

.sm-stat-label {
  color: var(--app-text-muted);
  min-width: 90px;
  flex-shrink: 0;
}

.sm-stat-value {
  color: var(--app-text);
}

.sm-scripts {
  margin-bottom: 10px;
}

.sm-script-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 0.8em;
}

.sm-script-lang {
  background: var(--app-accent);
  color: #fff;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 0.85em;
  font-weight: 500;
}

.sm-script-path {
  color: var(--app-text-soft);
  font-family: 'SF Mono', 'Menlo', monospace;
}

.sm-files {
  border-top: 1px solid var(--app-border);
  padding-top: 8px;
}

.sm-files-title {
  font-size: 0.8em;
  color: var(--app-text-muted);
  margin-bottom: 6px;
}

.sm-files-scroll {
  max-height: 200px;
  overflow-y: auto;
}

.sm-file-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 3px 0;
  font-size: 0.78em;
}

.sm-file-path {
  color: var(--app-text-soft);
  font-family: 'SF Mono', 'Menlo', monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sm-file-size {
  color: var(--app-text-faint);
  flex-shrink: 0;
  margin-left: 8px;
}
</style>
