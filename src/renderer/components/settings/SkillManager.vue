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
  <div class="skill-manager">
    <header class="skill-header">
      <h2>🧠 Skill 管理</h2>
      <p class="skill-desc">导入 Skill 文件让 AI 掌握专业技能，在聊天中选择激活</p>
      <button class="import-btn" @click="importSkill">
        <span>📥</span> 导入 Skill
      </button>
    </header>

    <div v-if="loading" class="skill-loading">加载中...</div>

    <div v-else-if="skills.length === 0" class="skill-empty">
      <div class="empty-icon">🧩</div>
      <p>还没有导入任何 Skill</p>
      <p class="empty-hint">点击「导入 Skill」添加 .md 或 .txt 格式的技能文件</p>
    </div>

    <div v-else class="skill-list">
      <div
        v-for="skill in skills"
        :key="skill.id"
        :class="['skill-card', { expanded: expandedSkillId === skill.id }]"
      >
        <div class="skill-card-header" @click="toggleExpand(skill.id)">
          <div class="skill-info">
            <span class="skill-name">{{ skill.name }}</span>
            <span class="skill-date">{{ formatDate(skill.createdAt) }}</span>
          </div>
          <div class="skill-actions">
            <button class="action-btn delete-btn" @click.stop="deleteSkill(skill.id)" title="删除">🗑️</button>
            <span class="expand-arrow">{{ expandedSkillId === skill.id ? '▾' : '▸' }}</span>
          </div>
        </div>
        <div v-if="skill.description" class="skill-description">{{ skill.description }}</div>
        <div v-if="expandedSkillId === skill.id" class="skill-content">
          <pre>{{ skill.content }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.skill-manager {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 24px;
  overflow-y: auto;
}

.skill-header {
  margin-bottom: 24px;
}

.skill-header h2 {
  font-size: 1.3em;
  font-weight: 600;
  color: #f4f4f5;
  margin: 0 0 6px 0;
}

.skill-desc {
  color: #71717a;
  font-size: 0.85em;
  margin: 0 0 16px 0;
}

.import-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  background: #6366f1;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 0.88em;
  cursor: pointer;
  transition: background 0.15s;
}

.import-btn:hover {
  background: #4f46e5;
}

.skill-loading {
  color: #71717a;
  text-align: center;
  padding: 40px 0;
}

.skill-empty {
  text-align: center;
  padding: 60px 20px;
  color: #71717a;
}

.empty-icon {
  font-size: 2.5em;
  margin-bottom: 12px;
}

.empty-hint {
  font-size: 0.82em;
  color: #52525b;
  margin-top: 8px;
}

.skill-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.skill-card {
  background: #1e1e22;
  border: 1px solid #27272a;
  border-radius: 10px;
  overflow: hidden;
  transition: border-color 0.15s;
}

.skill-card:hover {
  border-color: #3f3f46;
}

.skill-card.expanded {
  border-color: #6366f180;
}

.skill-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  cursor: pointer;
  user-select: none;
}

.skill-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.skill-name {
  font-size: 0.95em;
  font-weight: 500;
  color: #e4e4e7;
}

.skill-date {
  font-size: 0.75em;
  color: #52525b;
}

.skill-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.action-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.85em;
  padding: 4px;
  border-radius: 4px;
  transition: background 0.12s;
}

.delete-btn:hover {
  background: #3f3f46;
}

.expand-arrow {
  color: #52525b;
  font-size: 0.8em;
}

.skill-description {
  padding: 0 16px 10px;
  font-size: 0.82em;
  color: #a1a1aa;
  line-height: 1.4;
}

.skill-content {
  border-top: 1px solid #27272a;
  padding: 12px 16px;
  max-height: 400px;
  overflow-y: auto;
}

.skill-content pre {
  margin: 0;
  font-size: 0.82em;
  color: #a1a1aa;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'SF Mono', 'Menlo', monospace;
  line-height: 1.5;
}
</style>
