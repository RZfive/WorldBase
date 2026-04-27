import type { PendingAttachment, UploadedAttachmentResult } from './types'

export const MAX_ATTACHMENT_PREVIEW_TEXT_LENGTH = 180
export const MAX_IMAGE_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024

export function formatFileSize (size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function getElectronFilePath (file: File): string | null {
  const candidate = (file as File & { path?: string }).path
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : null
}

export function isImageAttachment (file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name)
}

export async function readFileAsDataUrl (file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error || new Error(`无法读取文件：${file.name}`))
    reader.readAsDataURL(file)
  })
}

async function readFileAsUint8Array (file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}

export async function readUploadedAttachment (file: File): Promise<UploadedAttachmentResult> {
  if (window.electronAPI?.readUploadedAttachmentBuffer) {
    const bytes = await readFileAsUint8Array(file)
    return window.electronAPI.readUploadedAttachmentBuffer({
      fileName: file.name,
      fileType: file.type || undefined,
      bytes
    })
  }

  const filePath = getElectronFilePath(file)
  if (filePath && window.electronAPI?.readUploadedAttachmentFile) {
    return window.electronAPI.readUploadedAttachmentFile(filePath)
  }

  throw new Error(`当前环境不支持读取附件：${file.name}`)
}

export function trimPreviewText (content: string, maxLength = MAX_ATTACHMENT_PREVIEW_TEXT_LENGTH): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength)}…`
}

export function buildUploadedFilesPrompt (files: PendingAttachment[]): string {
  return files
    .map(file => `【用户附件：${file.name}】\n文件类型：${file.fileType.toUpperCase()}\n文件内容如下：\n${file.promptContent}\n【附件结束】`)
    .join('\n\n')
}

export function extractDocumentTagRefs (text: string, pattern: RegExp): { regionIds: string[]; normalizedText: string } {
  const regionIds = new Set<string>()
  const normalizedText = text.replace(pattern, (_match, regionId: string, rawLabel?: string) => {
    regionIds.add(regionId)
    const label = rawLabel?.trim() || '文档标签'
    return `文档标签「${label}」`
  })

  return {
    regionIds: Array.from(regionIds),
    normalizedText
  }
}

export function extractProjectTagRefs (text: string, pattern: RegExp): { projectId: string | null; normalizedText: string } {
  let projectId: string | null = null
  const normalizedText = text.replace(pattern, (_match, id: string) => {
    if (!projectId) projectId = id
    return ''
  }).replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n')
  return { projectId, normalizedText }
}