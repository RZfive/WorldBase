import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  FolderWorkspaceFileEntry,
  FolderWorkspaceFileKind,
  FolderWorkspaceListResult,
  FolderWorkspaceReadResult
} from '../../shared/folder-workspace-types.js'

const MAX_TREE_ENTRIES = 5000
const MAX_TREE_DEPTH = 12
const MAX_PREVIEW_BYTES = 1024 * 1024

const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.turbo',
  '.output',
  '__pycache__',
  '.venv',
  'venv'
])

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx'])

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.bz2', '.rar', '.7z',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.exe', '.dll', '.so', '.dylib', '.o',
  '.sqlite', '.db'
])

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.vue': 'vue',
  '.html': 'xml',
  '.htm': 'xml',
  '.svelte': 'svelte',
  '.astro': 'astro',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'scss',
  '.less': 'less',
  '.styl': 'stylus',
  '.json': 'json',
  '.jsonc': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.env': 'properties',
  '.py': 'python',
  '.rb': 'ruby',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.fish': 'bash',
  '.ps1': 'powershell',
  '.sql': 'sql',
  '.xml': 'xml',
  '.svg': 'xml',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.hbs': 'handlebars',
  '.handlebars': 'handlebars',
  '.mustache': 'mustache',
  '.ejs': 'ejs',
  '.eta': 'ejs',
  '.twig': 'twig',
  '.njk': 'nunjucks',
  '.nunjucks': 'nunjucks',
  '.jinja': 'jinja',
  '.jinja2': 'jinja2',
  '.j2': 'jinja2',
  '.liquid': 'liquid',
  '.pug': 'pug',
  '.jade': 'pug',
  '.haml': 'haml',
  '.erb': 'erb',
  '.eex': 'eex',
  '.heex': 'heex',
  '.gohtml': 'gohtml',
  '.gotmpl': 'gotmpl',
  '.tmpl': 'tmpl',
  '.tpl': 'tmpl',
  '.cshtml': 'cshtml',
  '.razor': 'razor',
  '.jsp': 'jsp',
  '.ftl': 'ftl',
  '.vm': 'velocity',
  '.phtml': 'php-template',
  '.aspx': 'vbscript-html',
  '.asp': 'vbscript-html',
  '.dockerfile': 'dockerfile',
  'dockerfile': 'dockerfile'
}

const LANGUAGE_BY_FILENAME_SUFFIX: Array<[string, string]> = [
  ['.blade.php', 'blade'],
  ['.component.html', 'xml'],
  ['.module.css', 'css'],
  ['.module.scss', 'scss'],
  ['.module.sass', 'scss'],
  ['.module.less', 'less'],
  ['.stories.jsx', 'javascript'],
  ['.stories.tsx', 'typescript'],
  ['.stories.js', 'javascript'],
  ['.stories.ts', 'typescript']
]

const TEXT_EXTENSIONS = new Set([
  '.txt', '.log', '.csv', '.tsv', '.gitignore', '.npmrc', '.editorconfig',
  '.prettierrc', '.eslintrc', '.babelrc', '.browserslistrc'
])

export function getFolderWorkspaceRootName (rootPath: string): string {
  const resolved = path.resolve(rootPath)
  return path.basename(resolved) || resolved
}

export function normalizeWorkspaceRelativePath (relativePath?: string | null): string {
  return (relativePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
}

export function resolveFolderWorkspacePath (rootPath: string, relativePath = ''): string {
  const root = path.resolve(rootPath)
  const normalizedRelativePath = normalizeWorkspaceRelativePath(relativePath)
  const resolved = path.resolve(root, normalizedRelativePath)
  const relativeToRoot = path.relative(root, resolved)

  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error(`Path traversal detected: ${relativePath}`)
  }

  return resolved
}

function getWorkspaceLanguage (filePath: string): string | undefined {
  const normalizedPath = normalizeWorkspaceRelativePath(filePath).toLowerCase()
  const baseName = path.basename(normalizedPath)
  for (const [suffix, language] of LANGUAGE_BY_FILENAME_SUFFIX) {
    if (baseName.endsWith(suffix)) return language
  }
  const ext = path.extname(baseName)
  return LANGUAGE_BY_EXTENSION[ext] || LANGUAGE_BY_EXTENSION[baseName]
}

export function classifyWorkspaceFile (filePath: string, size = 0): { kind: FolderWorkspaceFileKind; language?: string; isMarkdown: boolean } {
  const baseName = path.basename(filePath).toLowerCase()
  const ext = path.extname(baseName)

  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return { kind: 'markdown', language: 'markdown', isMarkdown: true }
  }

  if (BINARY_EXTENSIONS.has(ext)) {
    return { kind: 'binary', isMarkdown: false }
  }

  if (size > MAX_PREVIEW_BYTES) {
    return { kind: 'large', language: getWorkspaceLanguage(filePath), isMarkdown: false }
  }

  const language = getWorkspaceLanguage(filePath)
  if (language) {
    return { kind: 'code', language, isMarkdown: false }
  }

  if (TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(baseName)) {
    return { kind: 'text', isMarkdown: false }
  }

  return { kind: 'unknown', isMarkdown: false }
}

export async function assertFolderWorkspaceRoot (rootPath: string): Promise<string> {
  const resolvedRoot = path.resolve(rootPath)
  const stat = await fs.stat(resolvedRoot)
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a folder: ${resolvedRoot}`)
  }
  return resolvedRoot
}

export async function listFolderWorkspaceFiles (rootPath: string): Promise<FolderWorkspaceListResult> {
  const resolvedRoot = await assertFolderWorkspaceRoot(rootPath)
  let totalEntries = 0
  let truncated = false

  async function walk (dirRelativePath: string, depth: number): Promise<FolderWorkspaceFileEntry[]> {
    if (truncated || depth > MAX_TREE_DEPTH) return []

    const fullDir = resolveFolderWorkspacePath(resolvedRoot, dirRelativePath)
    let dirEntries: import('node:fs').Dirent[]
    try {
      dirEntries = await fs.readdir(fullDir, { withFileTypes: true })
    } catch {
      return []
    }

    dirEntries.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    })

    const entries: FolderWorkspaceFileEntry[] = []
    const directoriesToWalk: Array<{ index: number; relativePath: string }> = []
    for (const entry of dirEntries) {
      if (truncated) break
      if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.gitignore') {
        if (entry.isDirectory()) continue
      }
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue

      totalEntries += 1
      if (totalEntries > MAX_TREE_ENTRIES) {
        truncated = true
        break
      }

      const relativePath = dirRelativePath ? `${dirRelativePath}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        entries.push({
          name: entry.name,
          path: relativePath,
          type: 'directory',
          children: []
        })
        directoriesToWalk.push({ index: entries.length - 1, relativePath })
        continue
      }

      let size = 0
      try {
        size = (await fs.stat(resolveFolderWorkspacePath(resolvedRoot, relativePath))).size
      } catch {
        size = 0
      }
      const classification = classifyWorkspaceFile(relativePath, size)
      entries.push({
        name: entry.name,
        path: relativePath,
        type: 'file',
        size,
        kind: classification.kind,
        language: classification.language
      })
    }

    if (!truncated && depth < MAX_TREE_DEPTH) {
      for (const directory of directoriesToWalk) {
        if (truncated) break
        entries[directory.index].children = await walk(directory.relativePath, depth + 1)
      }
    }

    return entries
  }

  return {
    rootPath: resolvedRoot,
    rootName: getFolderWorkspaceRootName(resolvedRoot),
    entries: await walk('', 0),
    totalEntries,
    truncated
  }
}

function bufferLooksBinary (buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 4096)
  for (let i = 0; i < sampleLength; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

async function readFileHead (filePath: string, size: number): Promise<{ buffer: Buffer; truncated: boolean }> {
  const readSize = Math.min(size, MAX_PREVIEW_BYTES)
  if (readSize === 0) return { buffer: Buffer.alloc(0), truncated: false }

  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(readSize)
    const result = await handle.read(buffer, 0, readSize, 0)
    return {
      buffer: result.bytesRead === readSize ? buffer : buffer.subarray(0, result.bytesRead),
      truncated: size > readSize
    }
  } finally {
    await handle.close()
  }
}

export async function readFolderWorkspaceFile (rootPath: string, relativePath: string): Promise<FolderWorkspaceReadResult> {
  const resolvedRoot = await assertFolderWorkspaceRoot(rootPath)
  const normalizedRelativePath = normalizeWorkspaceRelativePath(relativePath)
  if (!normalizedRelativePath) {
    throw new Error('file_path is required')
  }

  const fullPath = resolveFolderWorkspacePath(resolvedRoot, normalizedRelativePath)
  const stat = await fs.stat(fullPath)
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${normalizedRelativePath}`)
  }

  const classification = classifyWorkspaceFile(normalizedRelativePath, stat.size)
  if (classification.kind === 'binary') {
    throw new Error(`Cannot preview binary file: ${normalizedRelativePath}`)
  }

  const { buffer, truncated } = await readFileHead(fullPath, stat.size)
  if (bufferLooksBinary(buffer)) {
    throw new Error(`Cannot preview binary file: ${normalizedRelativePath}`)
  }

  const content = buffer.toString('utf-8')
  const lineCount = content === '' ? 0 : content.split('\n').length

  return {
    rootPath: resolvedRoot,
    filePath: normalizedRelativePath,
    fileName: path.basename(normalizedRelativePath),
    size: stat.size,
    content,
    kind: classification.kind === 'unknown' ? 'text' : classification.kind,
    language: classification.language,
    isMarkdown: classification.isMarkdown,
    lineCount,
    truncated
  }
}

export async function writeFolderWorkspaceFile (rootPath: string, relativePath: string, content: string): Promise<void> {
  const resolvedRoot = await assertFolderWorkspaceRoot(rootPath)
  const normalizedRelativePath = normalizeWorkspaceRelativePath(relativePath)
  if (!normalizedRelativePath) {
    throw new Error('file_path is required')
  }

  const fullPath = resolveFolderWorkspacePath(resolvedRoot, normalizedRelativePath)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  const tempPath = path.join(path.dirname(fullPath), `.${path.basename(fullPath)}.the-world-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
  await fs.writeFile(tempPath, content, 'utf-8')
  await fs.rename(tempPath, fullPath)
}

export async function deleteFolderWorkspaceFile (rootPath: string, relativePath: string): Promise<void> {
  const resolvedRoot = await assertFolderWorkspaceRoot(rootPath)
  const normalizedRelativePath = normalizeWorkspaceRelativePath(relativePath)
  if (!normalizedRelativePath) {
    throw new Error('file_path is required')
  }

  const fullPath = resolveFolderWorkspacePath(resolvedRoot, normalizedRelativePath)
  const stat = await fs.stat(fullPath)
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${normalizedRelativePath}`)
  }
  await fs.unlink(fullPath)
}
