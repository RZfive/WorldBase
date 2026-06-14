import fs from 'node:fs/promises'
import path from 'node:path'
import { parseDocument, parseDocumentBuffer, isSupportedDocument } from '../../../src/main/ai-engine/agent/tools/document-parser.js'
import {
  MAX_CHAT_UPLOADED_OFFICE_FILE_SIZE_BYTES,
  MAX_UPLOADED_OFFICE_CONTENT_LENGTH,
  TEXT_ATTACHMENT_EXTENSIONS,
  TEXT_ATTACHMENT_FILE_NAMES,
  TEXT_ATTACHMENT_MIME_PATTERN
} from '../constants.js'

export interface UploadedAttachmentBufferPayload {
  fileName: string
  fileType?: string
  bytes: Uint8Array
}

export interface UploadedAttachmentResult {
  filePath: string
  fileName: string
  size: number
  fileType: string
  content: string
}

export function isSupportedTextAttachment (fileName: string): boolean {
  const normalizedName = path.basename(fileName).toLowerCase()
  return TEXT_ATTACHMENT_FILE_NAMES.has(normalizedName) || TEXT_ATTACHMENT_EXTENSIONS.has(path.extname(normalizedName))
}

export function isLikelyTextAttachmentMimeType (fileType?: string): boolean {
  return typeof fileType === 'string' && TEXT_ATTACHMENT_MIME_PATTERN.test(fileType.trim())
}

export function looksLikeTextBuffer (buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  if (sample.length === 0) return true

  let suspiciousByteCount = 0
  for (const byte of sample) {
    if (byte === 0) return false
    const isControl = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13
    if (isControl) suspiciousByteCount++
  }

  return suspiciousByteCount / sample.length < 0.05
}

export function detectTextAttachmentType (fileName: string, fileType?: string): string {
  const normalizedName = path.basename(fileName).toLowerCase()
  if (TEXT_ATTACHMENT_FILE_NAMES.has(normalizedName)) {
    return normalizedName.replace(/^\./, '') || 'text'
  }

  const extension = path.extname(normalizedName).replace(/^\./, '')
  if (extension) return extension

  const normalizedMimeType = fileType?.trim().toLowerCase() || ''
  if (normalizedMimeType.includes('json')) return 'json'
  if (normalizedMimeType.includes('xml')) return 'xml'
  if (normalizedMimeType.includes('yaml')) return 'yaml'
  if (normalizedMimeType.includes('markdown')) return 'md'
  return 'text'
}

export function trimAttachmentContent (content: string): string {
  return content.replace(/^\uFEFF/, '').substring(0, MAX_UPLOADED_OFFICE_CONTENT_LENGTH)
}

export async function readUploadedAttachmentFromBuffer (
  buffer: Buffer,
  options: { fileName: string; fileType?: string; filePath?: string }
): Promise<UploadedAttachmentResult> {
  const fileName = path.basename(options.fileName || '').trim()
  if (!fileName) {
    throw new Error('附件缺少文件名')
  }

  if (buffer.byteLength > MAX_CHAT_UPLOADED_OFFICE_FILE_SIZE_BYTES) {
    throw new Error(`文件过大 (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)，最大支持 10 MB`)
  }

  if (isSupportedDocument(fileName)) {
    const artifact = options.filePath
      ? await parseDocument(options.filePath)
      : await parseDocumentBuffer(buffer, { fileName, fileSize: buffer.byteLength })

    return {
      filePath: options.filePath || '',
      fileName,
      size: buffer.byteLength,
      fileType: artifact.fileType,
      content: trimAttachmentContent(artifact.plainText)
    }
  }

  if (!isSupportedTextAttachment(fileName) && !isLikelyTextAttachmentMimeType(options.fileType) && !looksLikeTextBuffer(buffer)) {
    throw new Error(`暂不支持的附件格式: ${path.extname(fileName) || 'unknown'}`)
  }

  return {
    filePath: options.filePath || '',
    fileName,
    size: buffer.byteLength,
    fileType: detectTextAttachmentType(fileName, options.fileType),
    content: trimAttachmentContent(buffer.toString('utf8'))
  }
}

export async function readUploadedAttachmentFromPath (filePath: string): Promise<UploadedAttachmentResult> {
  const resolvedPath = path.resolve(filePath)
  const stat = await fs.stat(resolvedPath)

  if (!stat.isFile()) {
    throw new Error(`路径不是一个文件: ${resolvedPath}`)
  }

  if (isSupportedDocument(resolvedPath)) {
    const artifact = await parseDocument(resolvedPath)
    return {
      filePath: resolvedPath,
      fileName: path.basename(resolvedPath),
      size: stat.size,
      fileType: artifact.fileType,
      content: trimAttachmentContent(artifact.plainText)
    }
  }

  const buffer = await fs.readFile(resolvedPath)
  return readUploadedAttachmentFromBuffer(buffer, {
    fileName: path.basename(resolvedPath),
    filePath: resolvedPath
  })
}
