<script setup lang="ts">
import type { LaunchFolder, Project } from './types'
import { getProjectIcon } from '../../utils/project-icon'

const props = defineProps<{
  openFolderData: LaunchFolder | null
  openFolderProjects: Project[]
  folderPopupAnchor: { x: number; y: number }
  renamingId: string | null
  renameInput: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'dragoverOverlay', event: DragEvent): void
  (e: 'dropOverlay', event: DragEvent): void
  (e: 'dragstart', payload: { event: DragEvent; projectId: string }): void
  (e: 'dragend'): void
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
          <div class="folder-bubble-body">
            <div v-if="openFolderProjects.length === 0" class="folder-empty">
              文件夹为空，拖拽应用到此文件夹
            </div>
            <div v-else class="folder-bubble-grid">
              <div
                v-for="project in openFolderProjects"
                :key="project.id"
                class="lp-cell lp-cell-app"
                draggable="true"
                @dragstart="emit('dragstart', { event: $event, projectId: project.id })"
                @dragend="emit('dragend')"
                @click="emit('selectProject', project)"
                @contextmenu="emit('showMenu', { event: $event, target: project, kind: 'project' })"
              >
                <div class="lp-app-icon">
                  <span class="lp-app-emoji">{{ getProjectIcon(project.type) }}</span>
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
