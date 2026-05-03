<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

interface Project {
  id: string
  name?: string
  type?: string
  kind?: 'project' | 'web'
  url?: string
  icon?: string
  runtime?: { status?: string; port?: number }
  [key: string]: unknown
}

interface LaunchFolder {
  id: string
  name: string
  projectIds: string[]
}

const props = defineProps<{
  visible: boolean
  x: number
  y: number
  target: Project | LaunchFolder | null
  kind: 'project' | 'folder' | 'blank'
  folders: LaunchFolder[]
  folderedIds: Set<string>
}>()

const emit = defineEmits<{
  (e: 'hide'): void
  (e: 'editProject', project: Project): void
  (e: 'openProject', project: Project): void
  (e: 'viewSource', project: Project): void
  (e: 'exportProject', project: Project): void
  (e: 'openInWindow', project: Project): void
  (e: 'startProject', project: Project): void
  (e: 'stopProject', project: Project): void
  (e: 'optimizeInChat', project: Project): void
  (e: 'deleteWebApp', appId: string): void
  (e: 'moveToFolder', projectId: string, folderId: string): void
  (e: 'removeFromFolder', projectId: string): void
  (e: 'deleteProject', project: Project): void
  (e: 'renameFolder', folder: LaunchFolder): void
  (e: 'deleteFolder', folderId: string): void
  (e: 'createFolder'): void
  (e: 'importPackage'): void
  (e: 'refresh'): void
}>()

const menuRef = ref<HTMLElement | null>(null)
const menuPosition = ref({ x: 0, y: 0 })

function clampMenuPosition () {
  if (!props.visible) return

  const margin = 12
  const menuWidth = menuRef.value?.offsetWidth ?? 0
  const menuHeight = menuRef.value?.offsetHeight ?? 0
  const maxX = Math.max(margin, window.innerWidth - menuWidth - margin)
  const maxY = Math.max(margin, window.innerHeight - menuHeight - margin)

  menuPosition.value = {
    x: Math.min(Math.max(props.x, margin), maxX),
    y: Math.min(Math.max(props.y, margin), maxY)
  }
}

watch(
  () => [props.visible, props.x, props.y, props.kind, props.target],
  async ([visible]) => {
    if (!visible) return
    await nextTick()
    clampMenuPosition()
  },
  { immediate: true }
)

onMounted(() => {
  window.addEventListener('resize', clampMenuPosition)
})

onUnmounted(() => {
  window.removeEventListener('resize', clampMenuPosition)
})

function asProject (target: Project | LaunchFolder | null): Project {
  return target as Project
}

function asFolder (target: Project | LaunchFolder | null): LaunchFolder {
  return target as LaunchFolder
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="props.visible"
      ref="menuRef"
      class="lp-ctx-menu"
      :style="{ left: menuPosition.x + 'px', top: menuPosition.y + 'px' }"
      @click.stop
    >
      <template v-if="props.kind === 'project' && props.target">
        <template v-if="asProject(props.target).kind === 'web'">
          <div class="ctx-item" @click="emit('openProject', asProject(props.target)); emit('hide')">🌐 打开网页</div>
          <div v-if="props.folders.length > 0" class="ctx-divider"></div>
          <div v-for="folder in props.folders" :key="folder.id" class="ctx-item" @click="emit('moveToFolder', asProject(props.target).id, folder.id); emit('hide')">
            📁 移入「{{ folder.name }}」
          </div>
          <div v-if="props.folderedIds.has(asProject(props.target).id)" class="ctx-item" @click="emit('removeFromFolder', asProject(props.target).id); emit('hide')">📤 移出文件夹</div>
          <div class="ctx-divider"></div>
          <div class="ctx-item ctx-danger" @click="emit('deleteWebApp', asProject(props.target).id); emit('hide')">🗑️ 从启动台移除</div>
        </template>

        <template v-else>
          <div class="ctx-item" @click="emit('openProject', asProject(props.target)); emit('hide')">🪄 打开应用</div>
          <div class="ctx-item" @click="emit('editProject', asProject(props.target)); emit('hide')">✏️ 修改名称与图标</div>
          <div class="ctx-item" @click="emit('viewSource', asProject(props.target)); emit('hide')">💻 查看源码</div>
          <div class="ctx-item" @click="emit('exportProject', asProject(props.target)); emit('hide')">📦 导出应用</div>
          <div class="ctx-item" @click="emit('openInWindow', asProject(props.target)); emit('hide')">↗️ 独立窗口运行</div>
          <div class="ctx-divider"></div>
          <div v-if="asProject(props.target).runtime?.status !== 'running'" class="ctx-item" @click="emit('startProject', asProject(props.target)); emit('hide')">▶️ 启动</div>
          <div v-if="asProject(props.target).runtime?.status === 'running'" class="ctx-item" @click="emit('stopProject', asProject(props.target)); emit('hide')">⏹️ 停止</div>
          <div class="ctx-divider"></div>
          <div class="ctx-item" @click="emit('optimizeInChat', asProject(props.target)); emit('hide')">💬 继续优化</div>
          <div v-if="props.folders.length > 0" class="ctx-divider"></div>
          <div v-for="folder in props.folders" :key="folder.id" class="ctx-item" @click="emit('moveToFolder', asProject(props.target).id, folder.id); emit('hide')">
            📁 移入「{{ folder.name }}」
          </div>
          <div v-if="props.folderedIds.has(asProject(props.target).id)" class="ctx-item" @click="emit('removeFromFolder', asProject(props.target).id); emit('hide')">📤 移出文件夹</div>
          <div class="ctx-divider"></div>
          <div class="ctx-item ctx-danger" @click="emit('deleteProject', asProject(props.target)); emit('hide')">🗑️ 删除项目</div>
        </template>
      </template>

      <template v-if="props.kind === 'folder' && props.target">
        <div class="ctx-item" @click="emit('renameFolder', asFolder(props.target)); emit('hide')">✏️ 重命名</div>
        <div class="ctx-item ctx-danger" @click="emit('deleteFolder', asFolder(props.target).id); emit('hide')">🗑️ 删除文件夹</div>
      </template>

      <template v-if="props.kind === 'blank'">
        <div class="ctx-item" @click="emit('createFolder'); emit('hide')">📁 新建文件夹</div>
        <div class="ctx-item" @click="emit('importPackage'); emit('hide')">📥 导入应用</div>
        <div class="ctx-item" @click="emit('refresh'); emit('hide')">🔄 刷新</div>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.lp-ctx-menu {
  position: fixed;
  z-index: 10000;
  background: var(--app-panel-strong);
  backdrop-filter: blur(20px);
  border: 1px solid var(--app-border-strong);
  border-radius: 14px;
  padding: 4px 0;
  min-width: 180px;
  box-shadow: var(--app-shadow);
}

.ctx-item {
  padding: 8px 16px;
  font-size: 0.85em;
  color: var(--app-text);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.1s ease, color 0.1s ease;
}

.ctx-item:hover {
  background: var(--app-accent-soft);
  color: var(--app-text-strong);
}

.ctx-item.ctx-danger {
  color: var(--app-danger);
}

.ctx-item.ctx-danger:hover {
  background: color-mix(in srgb, var(--app-danger) 18%, transparent);
  color: var(--app-danger);
}

.ctx-divider {
  height: 1px;
  background: var(--app-border);
  margin: 4px 0;
}
</style>
