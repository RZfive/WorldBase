export interface NormalizedDocumentRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DocumentEditImagePayload {
  fileName: string
  mimeType: 'image/png' | 'image/jpeg'
  bytes: Uint8Array
  width: number
  height: number
}

interface BaseDocumentEditOperation {
  id: string
  createdAt: string
}

export interface PdfReplaceTextOperation extends BaseDocumentEditOperation {
  type: 'pdf_replace_text'
  pageIndex: number
  rect: NormalizedDocumentRect
  beforeText: string
  afterText: string
  fontSize: number
  color: string
  backgroundColor: string
}

export interface PdfInsertImageOperation extends BaseDocumentEditOperation {
  type: 'pdf_insert_image'
  pageIndex: number
  rect: NormalizedDocumentRect
  image: DocumentEditImagePayload
}

export interface DocxReplaceTextOperation extends BaseDocumentEditOperation {
  type: 'docx_replace_text'
  nodeId: string
  paragraphIndex: number
  beforeText: string
  afterText: string
}

export interface DocxInsertImageOperation extends BaseDocumentEditOperation {
  type: 'docx_insert_image'
  afterNodeId: string | null
  paragraphIndex: number
  widthInches: number
  image: DocumentEditImagePayload
}

export type DocumentEditOperation =
  | PdfReplaceTextOperation
  | PdfInsertImageOperation
  | DocxReplaceTextOperation
  | DocxInsertImageOperation

export interface DocumentEditSourceState {
  sha256: string
  size: number
  mtimeMs: number
}

export interface DocumentEditExportRequest {
  artifactId: string
  sourceSha256: string
  operations: DocumentEditOperation[]
}

export interface DocumentEditExportResult {
  canceled: boolean
  filePath?: string
  artifact?: unknown
}

export interface DocumentEditImagePickResult {
  canceled: boolean
  image?: DocumentEditImagePayload
}
