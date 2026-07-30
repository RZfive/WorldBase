import type { Ref } from 'vue'
import type { ComposerTranslation } from 'vue-i18n'
import {
  MAX_IMAGE_ATTACHMENT_SIZE_BYTES,
  formatFileSize,
  getElectronFilePath,
  isImageAttachment,
  readFileAsDataUrl,
  readUploadedAttachment,
  trimPreviewText
} from './attachment-utils'
import { generateId } from './message-blocks'
import type { PendingAttachment, PendingImage } from './types'

interface ChatAttachmentStateOptions {
  t: ComposerTranslation
  inputText: Ref<string>
  pendingImages: Ref<PendingImage[]>
  pendingFiles: Ref<PendingAttachment[]>
  isUploadingFiles: Ref<boolean>
  uploadFeedback: Ref<string>
}

export function createChatAttachmentState (options: ChatAttachmentStateOptions) {
  const {
    t,
    inputText,
    pendingImages,
    pendingFiles,
    isUploadingFiles,
    uploadFeedback
  } = options

  async function addAttachments (files: File[]): Promise<void> {
    if (files.length === 0) return

    isUploadingFiles.value = true
    uploadFeedback.value = ''

    try {
      for (const file of files) {
        if (isImageAttachment(file)) {
          if (file.size > MAX_IMAGE_ATTACHMENT_SIZE_BYTES) {
            uploadFeedback.value = t('chatUi.uploadImageTooLarge', { name: file.name })
            continue
          }

          try {
            const base64 = await readFileAsDataUrl(file, t('chatUi.readFileFailed', { name: file.name }))
            pendingImages.value.push({
              base64,
              mimeType: file.type || 'image/png'
            })
            uploadFeedback.value = ''
          } catch (error) {
            uploadFeedback.value = t('chatUi.uploadAddFailed', {
              name: file.name,
              message: (error as Error).message
            })
          }
          continue
        }

        try {
          const uploaded = await readUploadedAttachment(file, t('chatUi.readAttachmentUnsupported', { name: file.name }))
          pendingFiles.value.push({
            id: generateId(),
            name: uploaded.fileName,
            filePath: uploaded.filePath || getElectronFilePath(file) || file.name,
            fileType: uploaded.fileType,
            fileSizeLabel: formatFileSize(uploaded.size),
            promptContent: uploaded.content,
            previewText: trimPreviewText(uploaded.content)
          })
          uploadFeedback.value = ''
        } catch (error) {
          uploadFeedback.value = t('chatUi.uploadAddFailed', {
            name: file.name,
            message: (error as Error).message
          })
        }
      }
    } finally {
      isUploadingFiles.value = false
    }
  }

  function removeImage (index: number): void {
    pendingImages.value.splice(index, 1)
  }

  function removeFile (id: string): void {
    pendingFiles.value = pendingFiles.value.filter(file => file.id !== id)
    if (pendingFiles.value.length === 0) uploadFeedback.value = ''
  }

  function insertDocumentTag (tag: string): void {
    const spacer = inputText.value.length > 0 && !/\s$/.test(inputText.value) ? ' ' : ''
    inputText.value = `${inputText.value}${spacer}${tag} `
  }

  return {
    addAttachments,
    insertDocumentTag,
    removeFile,
    removeImage
  }
}
