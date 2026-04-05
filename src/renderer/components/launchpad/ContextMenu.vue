<script setup lang="ts">
interface Project {
  id: string
  name?: string
  type?: string
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
  (e: 'openInWindow', project: Project): void
  (e: 'startProject', project: Project): void
  (e: 'stopProject', project: Project): void
  (e: 'optimizeInChat', project: Project): void
  (e: 'moveToFolder', projectId: string, folderId: string): void
  (e: 'removeFromFolder', projectId: string): void
  (e: 'deleteProject', project: Project): void
  (e: 'renameFolder', folder: LaunchFolder): void
  (e: 'deleteFolder', folderId: string): void
  (e: 'createFolder'): void
  (e: 'refresh'): void
}>()

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
      class="lp-ctx-menu"
      :style="{ left: props.x + 'px', top: props.y + 'px' }"
      @click.stop
    >
      <template v-if="props.kind === 'project' && props.target">
        <div class="ctx-item" @click="emit('openProject', asProject(props.target)); emit('hide')">🪄 打开应用</div>
        <div class="ctx-item" @click="emit('editProject', asProject(props.target)); emit('hide')">✏️ 修改名称与图标</div>
        <div class="ctx-item" @click="emit('viewSource', asProject(props.target)); emit('hide')">💻 查看源码</div>
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

      <template v-if="props.kind === 'folder' && props.target">
        <div class="ctx-item" @click="emit('renameFolder', asFolder(props.target)); emit('hide')">✏️ 重命名</div>
        <div class="ctx-item ctx-danger" @click="emit('deleteFolder', asFolder(props.target).id); emit('hide')">🗑️ 删除文件夹</div>
      </template>

      <template v-if="props.kind === 'blank'">
        <div class="ctx-item" @click="emit('createFolder'); emit('hide')">📁 新建文件夹</div>
        <div class="ctx-item" @click="emit('refresh'); emit('hide')">🔄 刷新</div>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.lp-ctx-menu {
  --lp-accent-soft: rgba(56, 189, 248, 0.16);
  position: fixed;
  z-index: 10000;
  background: rgba(15, 23, 42, 0.96);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(148, 163, 184, 0.14);
  border-radius: 14px;
  padding: 4px 0;
  min-width: 180px;
  box-shadow: 0 18px 46px rgba(0, 0, 0, 0.42);
}

.ctx-item {
  padding: 8px 16px;
  font-size: 0.85em;
  color: #e4e4e7;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.1s;
}

.ctx-item:hover { background: var(--lp-accent-soft); color: white; }
.ctx-item.ctx-danger { color: #f87171; }
.ctx-item.ctx-danger:hover { background: #dc2626; color: #fff; }
.ctx-divider { height: 1px; background: rgba(255, 255, 255, 0.06); margin: 4px 0; }
</style>
