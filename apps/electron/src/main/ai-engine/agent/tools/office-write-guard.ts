/**
 * Office 直写守卫（主进程侧）。
 *
 * AI 的写入工具（local_write_file / write_file / edit_file / patch_file）若
 * 直接覆写已存在的 Office 文档，会走"全文重建"路径，丢失原文件中的图片、
 * 表格与样式。此类目标一律拒绝，引导模型改走 `doc_draft` 草稿流（草稿由
 * Rust harness 生成，保真编辑走 ops 操作列表）。
 */
import fs from 'node:fs/promises'

const OFFICE_EXTENSIONS = new Set(['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls'])

export function isOfficeDocumentPath (filePath: string): boolean {
  const extension = filePath.split('.').pop()?.toLowerCase() || ''
  return OFFICE_EXTENSIONS.has(extension)
}

/**
 * Throws when `filePath` points at an existing Office document. New files and
 * plain-text targets pass through untouched.
 */
export async function assertOfficeWriteAllowed (filePath: string): Promise<void> {
  if (!isOfficeDocumentPath(filePath)) return
  try {
    await fs.access(filePath)
  } catch {
    // 目标不存在：新建文档语义，放行。
    return
  }
  const fileName = filePath.split(/[\\/]/).filter(Boolean).pop() || 'document'
  throw new Error(
    `「${fileName}」是已存在的 Office 文档，直接覆写会丢失图片与样式；请改用 doc_draft 生成修改草稿`
  )
}

/**
 * 纯文本写入工具（write/edit/patch_project_file）的更强守卫：无论目标是否
 * 存在，文本写入 Office 二进制包都会损坏文件，直接拒绝。
 */
export function assertTextToolNotOfficeTarget (filePath: string): void {
  if (!isOfficeDocumentPath(filePath)) return
  const fileName = filePath.split(/[\\/]/).filter(Boolean).pop() || 'document'
  throw new Error(
    `「${fileName}」是 Office 文档，文本写入工具无法处理（会损坏文件）。修改已有文档请使用 doc_draft 生成草稿；新建 Office 文档请使用 local_write_file 的 office_data 参数。`
  )
}

