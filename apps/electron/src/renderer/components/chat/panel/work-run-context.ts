import { detectWorkIntent } from '../../../../shared/coding-task-detection.js'
import {
  classifyWorkFile,
  getWorkFileExtension,
  type WorkFileKind
} from '../../../../shared/work-file-kind.js'

export interface WorkRunTarget {
  filePath: string
  kind: WorkFileKind
  source: 'text' | 'active-document' | 'active-folder-file' | 'attachment' | 'document-tab'
}

export interface WorkRunContext {
  intent: 'coding' | 'document' | 'normal'
  coding: {
    enabled: boolean
    root: string | null
    reason: string
  }
  folderRoot: string | null
  documents: Array<{ filePath: string; fileName?: string; fileType?: string }>
  targets: WorkRunTarget[]
}

const TEXT_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/]|\.{1,2}[\\/])?(?:[\w.@+-]+[\\/])*[\w.@+-]+\.[A-Za-z][A-Za-z0-9]{0,9}/g

function normalizeWorkFilePath (filePath?: string | null): string | null {
  let normalized = typeof filePath === 'string' ? filePath.trim() : ''
  if (!normalized) return null
  normalized = normalized.replace(/^[`"']+/, '').replace(/[`"']+$/, '')
  normalized = normalized.replace(/\\/g, '/')
  const isUncPath = normalized.startsWith('//')
  normalized = normalized.replace(/\/{2,}/g, '/')
  if (isUncPath) normalized = `/${normalized}`
  if (normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.replace(/\/+$/, '')
  }
  return normalized || null
}

function getParentDirectory (filePath: string): string | null {
  const normalized = normalizeWorkFilePath(filePath)
  if (!normalized) return null
  const trimmed = normalized.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  if (slash < 0) return null
  if (slash === 0) return '/'
  const parent = trimmed.slice(0, slash)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent
}

function pathsReferToSameFile (candidate: string, existing: string): boolean {
  const candidateKey = candidate.toLowerCase()
  const existingKey = existing.toLowerCase()
  if (candidateKey === existingKey) return true
  return !candidateKey.includes('/') && existingKey.endsWith(`/${candidateKey}`)
}

function looksLikeUrlFragment (text: string, index: number): boolean {
  if (index <= 0) return false
  const prefix = text.slice(Math.max(0, index - 24), index)
  return /(?:\/\/)\S*$/.test(prefix) || /@[\w.-]+$/.test(prefix)
}

function extractExplicitFilePaths (text: string): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  const pattern = new RegExp(TEXT_PATH_PATTERN.source, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (looksLikeUrlFragment(text, match.index)) continue
    const normalized = normalizeWorkFilePath(match[0].replace(/[.,;:!?]+$/, ''))
    if (!normalized || !getWorkFileExtension(normalized)) continue
    const kind = classifyWorkFile(normalized)
    if (kind !== 'document' && kind !== 'code') continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    paths.push(normalized)
  }
  return paths
}

export function resolveWorkRunContext (input: {
  text: string
  targetProjectId?: string | null
  folderRoot?: string | null
  activeFolderFilePath?: string | null
  activeTabKind?: string | null
  documentTabs?: Array<{ filePath: string; fileName?: string; fileType?: string }>
  attachmentPaths?: string[]
}): WorkRunContext {
  const text = typeof input.text === 'string' ? input.text : ''
  const folderRoot = normalizeWorkFilePath(input.folderRoot)
  const detection = detectWorkIntent(text)
  const targets: WorkRunTarget[] = []
  const targetKeys = new Set<string>()
  const explicitPaths = extractExplicitFilePaths(text)

  const addTarget = (filePath: string | null | undefined, kind: WorkFileKind, source: WorkRunTarget['source']): void => {
    const normalized = normalizeWorkFilePath(filePath)
    if (!normalized) return
    const key = normalized.toLowerCase()
    if (targetKeys.has(key)) return
    if (targets.some(target => pathsReferToSameFile(normalized, target.filePath))) return
    targetKeys.add(key)
    targets.push({ filePath: normalized, kind, source })
  }

  const documentTabEntries: Array<{ filePath: string; fileName?: string; fileType?: string }> = []
  const documentTabPaths = new Set<string>()
  for (const tab of input.documentTabs || []) {
    const normalized = normalizeWorkFilePath(tab?.filePath)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (documentTabPaths.has(key)) continue
    documentTabPaths.add(key)
    documentTabEntries.push({
      filePath: normalized,
      ...(tab.fileName ? { fileName: tab.fileName } : {}),
      ...(tab.fileType ? { fileType: tab.fileType } : {})
    })
  }

  const isOpenDocumentPath = (filePath: string): boolean => (
    documentTabEntries.some(entry => pathsReferToSameFile(filePath, entry.filePath))
  )
  // Prefer the absolute path from an open document tab when the user typed a
  // bare file name; otherwise a relative mention cannot resolve its parent.
  const resolveExplicitPath = (filePath: string): string => (
    documentTabEntries.find(entry => pathsReferToSameFile(filePath, entry.filePath))?.filePath || filePath
  )
  const resolvedExplicitPaths = explicitPaths.map(resolveExplicitPath)
  const classifyExplicitPath = (filePath: string): WorkFileKind => (
    classifyWorkFile(filePath, { documentSurface: isOpenDocumentPath(filePath) })
  )

  // A generic "修改这个文件/这份文档" with an active document tab is document
  // work, even though the word 文件 also matches the coding heuristic. Do not
  // apply this to real code context such as "修复登录接口报错".
  let intent = detection.intent
  const genericDocumentReference = /(?:这个|这份|该|当前)\s*(?:文件|文档)|(?:this|the)\s+(?:file|document)/i.test(text)
  const hasExplicitCodePath = resolvedExplicitPaths.some(filePath => classifyExplicitPath(filePath) === 'code')
  if (
    intent === 'coding' &&
    detection.reason === 'action with code context' &&
    input.activeTabKind === 'document' &&
    documentTabEntries.length > 0 &&
    genericDocumentReference &&
    !hasExplicitCodePath
  ) {
    intent = 'document'
  }

  // Open document tabs are context, not automatically the edit target. Only
  // the active document tab (reordered to the front by the caller) targets a
  // document change; otherwise a code request in a mixed folder would be
  // misread as a document request just because a document tab is open.
  if (intent === 'document' && input.activeTabKind === 'document' && documentTabEntries[0]) {
    addTarget(
      documentTabEntries[0].filePath,
      classifyWorkFile(documentTabEntries[0].filePath, { documentSurface: true }),
      'active-document'
    )
  }

  // The active folder file is context for a coding turn, not for casual chat.
  if (intent === 'coding') {
    addTarget(
      input.activeFolderFilePath,
      classifyWorkFile(input.activeFolderFilePath || ''),
      'active-folder-file'
    )
  }

  for (const filePath of resolvedExplicitPaths) {
    addTarget(filePath, classifyExplicitPath(filePath), 'text')
  }

  for (const attachmentPath of input.attachmentPaths || []) {
    addTarget(attachmentPath, classifyWorkFile(attachmentPath), 'attachment')
  }

  const hasCodeTarget = targets.some(target => target.kind === 'code')
  const hasDocumentTarget = targets.some(target => target.kind === 'document')
  const codingIntent = intent === 'coding'

  const documents: WorkRunContext['documents'] = []
  const documentKeys = new Set<string>()
  const addDocument = (entry: { filePath: string; fileName?: string; fileType?: string }): void => {
    const key = entry.filePath.toLowerCase()
    if (documentKeys.has(key)) return
    if (documents.some(document => pathsReferToSameFile(entry.filePath, document.filePath))) return
    documentKeys.add(key)
    documents.push(entry)
  }
  for (const entry of documentTabEntries) addDocument(entry)
  for (const target of targets) {
    if (target.source === 'text' && target.kind === 'document') {
      addDocument({ filePath: target.filePath })
    }
  }

  // `targetProjectId` is a managed-project id, not a filesystem path. When it
  // exists the harness already resolves the project root, so do not pass a
  // competing folder/document root. Otherwise use the folder root or the
  // active document's parent for a document-project coding run.
  const requestedProjectId = typeof input.targetProjectId === 'string' ? input.targetProjectId.trim() : ''
  let codingRoot: string | null = requestedProjectId ? null : folderRoot
  if (!requestedProjectId && !codingRoot) {
    const documentTarget =
      targets.find(target => target.source === 'active-document' && target.kind === 'document') ||
      targets.find(target => target.source === 'text' && target.kind === 'document') ||
      documentTabEntries[0]
    codingRoot = documentTarget ? getParentDirectory(documentTarget.filePath) : null
  }

  const codingEnabled = hasCodeTarget || (codingIntent && !hasDocumentTarget)
  const reason = codingEnabled
    ? hasCodeTarget ? 'code target' : 'coding intent'
    : hasDocumentTarget ? 'document-only request' : 'no coding signals'

  return {
    intent,
    coding: {
      enabled: codingEnabled,
      root: codingRoot,
      reason
    },
    folderRoot,
    documents,
    targets
  }
}
