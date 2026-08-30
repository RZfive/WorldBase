const STORAGE_KEY = 'the-world:ai-execution-preferences'

const DEFAULT_AI_EXECUTION_PREFERENCES: AIExecutionPreferences = {
  notifyOnTaskComplete: true,
  enableAiLogging: false,
  harnessBackend: 'ts'
}

function normalizeAIExecutionPreferences (value: unknown): AIExecutionPreferences {
  const input = (value && typeof value === 'object') ? value as Record<string, unknown> : {}

  return {
    notifyOnTaskComplete: typeof input.notifyOnTaskComplete === 'boolean'
      ? input.notifyOnTaskComplete
      : DEFAULT_AI_EXECUTION_PREFERENCES.notifyOnTaskComplete,
    enableAiLogging: typeof input.enableAiLogging === 'boolean'
      ? input.enableAiLogging
      : DEFAULT_AI_EXECUTION_PREFERENCES.enableAiLogging,
    harnessBackend: input.harnessBackend === 'rust' ? 'rust' : 'ts'
  }
}

function readLocalExecutionPreferences (): AIExecutionPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_AI_EXECUTION_PREFERENCES
    return normalizeAIExecutionPreferences(JSON.parse(raw))
  } catch {
    return DEFAULT_AI_EXECUTION_PREFERENCES
  }
}

function writeLocalExecutionPreferences (preferences: AIExecutionPreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Ignore local persistence failures so Electron-backed saves still succeed.
  }
}

export async function loadAIExecutionPreferences (): Promise<AIExecutionPreferences> {
  if (!window.electronAPI?.getAIExecutionPreferences) {
    return readLocalExecutionPreferences()
  }

  try {
    const preferences = normalizeAIExecutionPreferences(await window.electronAPI.getAIExecutionPreferences())
    writeLocalExecutionPreferences(preferences)
    return preferences
  } catch {
    return readLocalExecutionPreferences()
  }
}

export async function persistAIExecutionPreferences (preferences: AIExecutionPreferences): Promise<void> {
  const normalized = normalizeAIExecutionPreferences(preferences)

  if (window.electronAPI?.saveAIExecutionPreferences) {
    await window.electronAPI.saveAIExecutionPreferences(normalized)
  }

  writeLocalExecutionPreferences(normalized)
}
