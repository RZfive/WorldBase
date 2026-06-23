<script setup lang="ts">
import type { LaunchFolder, LaunchpadDropTarget, Project } from './types'
import { resolveProjectIcon } from '../../utils/project-icon'

const props = defineProps<{
  openFolderData: LaunchFolder | null
  openFolderProjects: Project[]
  folderPopupAnchor: { x: number; y: number }
  dropTarget: LaunchpadDropTarget | null
  renamingId: string | null
  renameInput: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'dragoverOverlay', event: DragEvent): void
  (e: 'dropOverlay', event: DragEvent): void
  (e: 'dragstart', payload: { event: DragEvent; itemId: string; itemType: 'project'; source: 'folder'; folderId: string }): void
  (e: 'dragend'): void
  (e: 'dragoverProject', payload: { event: DragEvent; targetProjectId: string; folderId: string }): void
  (e: 'dropProject', payload: { event: DragEvent; targetProjectId: string; folderId: string }): void
  (e: 'dragoverBody', event: DragEvent): void
  (e: 'dropBody', event: DragEvent): void
  (e: 'selectProject', project: Project): void
  (e: 'showMenu', payload: { event: MouseEvent; target: Project; kind: 'project' }): void
  (e: 'update:renameInput', value: string): void
  (e: 'commitRename', folderId: string): void
  (e: 'cancelRename'): void
  (e: 'startRename', folder: LaunchFolder): void
}>()

function updateRenameInput (event: Event) {
  emit('update:renameInput', (event.target as HTMLInputElement).value)
}

function dropClass (projectId: string): string | null {
  if (!props.dropTarget || props.dropTarget.id !== projectId) return null
  return `drop-${props.dropTarget.action}`
}

function resolveIcon (project: Project) {
  return resolveProjectIcon(project.type, project.icon)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="folder-pop">
      <div
        v-if="openFolderData"
        class="folder-bubble-overlay"
        @click.self="emit('close')"
        @dragover="emit('dragoverOverlay', $event)"
        @drop="emit('dropOverlay', $event)"
      >
        <div
          class="folder-bubble"
          :style="{
            '--anchor-x': folderPopupAnchor.x + 'px',
            '--anchor-y': folderPopupAnchor.y + 'px'
          }"
        >
          <div class="folder-bubble-arrow"></div>
          <div class="folder-bubble-header">
            <input
              v-if="renamingId === openFolderData.id"
              :value="renameInput"
              class="folder-rename-input"
              autofocus
              @input="updateRenameInput"
              @keydown.enter.prevent="emit('commitRename', openFolderData.id)"
              @keydown.escape="emit('cancelRename')"
              @blur="emit('commitRename', openFolderData.id)"
            />
            <h3
              v-else
              class="folder-bubble-title"
              @dblclick="emit('startRename', openFolderData)"
            >
              {{ openFolderData.name }}
            </h3>
          </div>
          <div class="folder-bubble-body" @dragover="emit('dragoverBody', $event)" @drop="emit('dropBody', $event)">
            <div v-if="openFolderProjects.length === 0" class="folder-empty">
              {{ $t('launchpad.folderEmptyDropHint') }}
            </div>
            <div v-else class="folder-bubble-grid">
              <div
                v-for="project in openFolderProjects"
                :key="project.id"
                :class="['lp-cell', 'lp-cell-app', dropClass(project.id)]"
                draggable="true"
                @dragstart="emit('dragstart', { event: $event, itemId: project.id, itemType: 'project', source: 'folder', folderId: openFolderData.id })"
                @dragover="emit('dragoverProject', { event: $event, targetProjectId: project.id, folderId: openFolderData.id })"
                @drop="emit('dropProject', { event: $event, targetProjectId: project.id, folderId: openFolderData.id })"
                @dragend="emit('dragend')"
                @click="emit('selectProject', project)"
                @contextmenu="emit('showMenu', { event: $event, target: project, kind: 'project' })"
              >
                <div class="lp-app-icon">
                  <img v-if="resolveIcon(project).kind === 'image'" :src="resolveIcon(project).value" alt="" class="lp-app-image" />
                  <span v-else class="lp-app-emoji">{{ resolveIcon(project).value }}</span>
                  <span v-if="project.runtime?.status === 'running'" class="lp-running-badge"></span>
                </div>
                <span class="lp-cell-name">{{ project.name || project.id }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.lp-app-image {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: inherit;
}
</style>
