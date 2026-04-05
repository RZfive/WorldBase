<script setup lang="ts">
import type { LaunchFolder, LaunchpadDropTarget, LaunchpadGridItem, Project } from './types'
import { getProjectIcon } from '../../utils/project-icon'

const props = defineProps<{
  gridItems: LaunchpadGridItem[]
  projects: Project[]
  dropTarget: LaunchpadDropTarget | null
  renamingId: string | null
  renameInput: string
}>()

const emit = defineEmits<{
  (e: 'dragstart', payload: { event: DragEvent; itemId: string; itemType: 'project' | 'folder' }): void
  (e: 'dragover', payload: { event: DragEvent; targetId: string; targetType: 'project' | 'folder' }): void
  (e: 'dragleave'): void
  (e: 'drop', payload: { event: DragEvent; targetId: string; targetType: 'project' | 'folder' }): void
  (e: 'dragend'): void
  (e: 'openFolder', payload: { folder: LaunchFolder; event: MouseEvent }): void
  (e: 'selectProject', project: Project): void
  (e: 'showMenu', payload: { event: MouseEvent; target: Project | LaunchFolder; kind: 'project' | 'folder' }): void
  (e: 'update:renameInput', value: string): void
  (e: 'commitRename', folderId: string): void
  (e: 'cancelRename'): void
}>()

function asFolder (item: LaunchpadGridItem): LaunchFolder {
  return item.data as LaunchFolder
}

function asProject (item: LaunchpadGridItem): Project {
  return item.data as Project
}

function updateRenameInput (event: Event) {
  emit('update:renameInput', (event.target as HTMLInputElement).value)
}

function dropClass (item: LaunchpadGridItem): string | null {
  if (!props.dropTarget || props.dropTarget.id !== item.data.id) return null
  return `drop-${props.dropTarget.action}`
}
</script>

<template>
  <div class="lp-grid">
    <div
      v-for="item in gridItems"
      :key="item.kind + '-' + item.data.id"
      :class="[
        'lp-cell',
        item.kind === 'folder' ? 'lp-cell-folder' : 'lp-cell-app',
        dropClass(item)
      ]"
      draggable="true"
      @dragstart="emit('dragstart', { event: $event, itemId: item.data.id, itemType: item.kind === 'folder' ? 'folder' : 'project' })"
      @dragover="emit('dragover', { event: $event, targetId: item.data.id, targetType: item.kind === 'folder' ? 'folder' : 'project' })"
      @dragleave="emit('dragleave')"
      @drop="emit('drop', { event: $event, targetId: item.data.id, targetType: item.kind === 'folder' ? 'folder' : 'project' })"
      @dragend="emit('dragend')"
      @click="item.kind === 'folder' ? emit('openFolder', { folder: asFolder(item), event: $event }) : emit('selectProject', asProject(item))"
      @contextmenu="emit('showMenu', { event: $event, target: item.data, kind: item.kind === 'folder' ? 'folder' : 'project' })"
    >
      <template v-if="item.kind === 'folder'">
        <div class="lp-folder-icon">
          <div class="folder-mini-grid">
            <span
              v-for="projectId in asFolder(item).projectIds.slice(0, 9)"
              :key="projectId"
              class="folder-mini"
            >{{ getProjectIcon(props.projects.find(project => project.id === projectId)?.type, props.projects.find(project => project.id === projectId)?.icon as string | undefined) }}</span>
            <span
              v-for="n in Math.max(0, 4 - Math.min(asFolder(item).projectIds.length, 9))"
              :key="'empty-' + n"
              class="folder-mini empty"
            ></span>
          </div>
        </div>
        <input
          v-if="renamingId === asFolder(item).id"
          :value="renameInput"
          class="lp-rename-input"
          autofocus
          @input="updateRenameInput"
          @keydown.enter.prevent="emit('commitRename', asFolder(item).id)"
          @keydown.escape="emit('cancelRename')"
          @blur="emit('commitRename', asFolder(item).id)"
          @click.stop
        />
        <span v-else class="lp-cell-name">{{ asFolder(item).name }}</span>
      </template>

      <template v-else>
        <div class="lp-app-icon">
          <span class="lp-app-emoji">{{ getProjectIcon(asProject(item).type, asProject(item).icon) }}</span>
          <span v-if="asProject(item).runtime?.status === 'running'" class="lp-running-badge"></span>
        </div>
        <span class="lp-cell-name">{{ asProject(item).name || asProject(item).id }}</span>
      </template>
    </div>
  </div>
</template>
