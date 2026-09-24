export const APP_DISPLAY_NAME = 'WorldBase'
export const LEGACY_USER_DATA_DIR_NAMES = ['The World', 'the-world']
export const CRITICAL_USER_DATA_DIR_NAMES = [
  'conversations',
  'projects',
  'snapshots',
  'skills',
  'agents',
  'agent-groups',
  'im',
  'agent-memory',
  'image-library',
  'ai-logs'
]
export const CRITICAL_USER_DATA_FILE_NAMES = [
  'settings.json',
  'scheduled-tasks.json',
  'long-term-goals.json',
  'studio-tasks.json',
  'usage-records.json'
]
export const DEFAULT_MAIN_WINDOW_MIN_WIDTH = 800
export const DEFAULT_MAIN_WINDOW_MIN_HEIGHT = 500
export const DEFAULT_WINDOW_EXPAND_ANIMATION_DURATION_MS = 240
// Keep batches small: the plan output for a batch scales with its entry count,
// and an output-token truncation mid-JSON makes the whole batch unparseable.
export const MEMORY_AI_COMPACTION_CHUNK_SIZE = 40
export const MEMORY_AI_COMPACTION_TIMEOUT_MS = 180000

export const LOCAL_APP_HOSTS = new Set(['localhost', '127.0.0.1'])
export const ALLOWED_WEBVIEW_POPUP_PROTOCOLS = new Set(['http:', 'https:'])
export const MAX_CHAT_UPLOADED_OFFICE_FILE_SIZE_BYTES = 10 * 1024 * 1024
export const MAX_DOCUMENT_WORKBENCH_FILE_SIZE_BYTES = 100 * 1024 * 1024
export const MAX_UPLOADED_OFFICE_CONTENT_LENGTH = 100000
export const PAGE_AUTOMATION_REQUEST_TIMEOUT_MS = 15000
export const VIRTUAL_INTERFACE_NAME_PATTERN = /(loopback|virtual|vmware|vbox|virtualbox|docker|podman|wsl|hyper-v|vethernet|tailscale|zerotier|utun|tun|tap|bridge)/i
export const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.mdx', '.markdown',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.csv', '.tsv', '.log', '.sql', '.graphql', '.gql', '.xml',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue',
  '.css', '.scss', '.sass', '.less', '.html', '.htm',
  '.py', '.rb', '.php', '.java', '.kt', '.go', '.rs', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.env', '.properties', '.gitignore', '.editorconfig', '.npmrc', '.pnpmfile', '.npmignore'
])
export const TEXT_ATTACHMENT_FILE_NAMES = new Set([
  '.env', '.gitignore', '.npmrc', '.npmignore', '.editorconfig',
  'dockerfile', 'makefile', 'readme', 'license', 'procfile'
])
export const TEXT_ATTACHMENT_MIME_PATTERN = /^(text\/|application\/(json|ld\+json|xml|yaml|x-yaml|javascript|x-javascript|typescript|x-typescript|csv|toml|sql|graphql))/i
