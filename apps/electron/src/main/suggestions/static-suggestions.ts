import type { SuggestionFeatureTag, SuggestionScene, SuggestionSendMode, SuggestionType, WorkSuggestion } from '../../shared/daily-suggestion-types.js'

/**
 * Static "capability exploration" pool. Titles, descriptions and prompts are
 * i18n keys under `chatUi.suggestions.static.<id>` so the renderer localizes
 * them; the main process only decides *which* items to show.
 */
export interface StaticSuggestionDefinition {
  id: string
  featureTag: SuggestionFeatureTag
  scene?: SuggestionScene
  sendMode: SuggestionSendMode
  /** Types this item may stand in for when an LLM batch comes up short. */
  fallbackFor: SuggestionType[]
}

export const STATIC_SUGGESTIONS: readonly StaticSuggestionDefinition[] = [
  { id: 'plan-first', featureTag: 'plan-mode', scene: { planMode: true }, sendMode: 'fill', fallbackFor: ['improve-project', 'feature-tip'] },
  { id: 'new-web-app', featureTag: 'project', sendMode: 'fill', fallbackFor: ['new-idea'] },
  { id: 'debug-running-api', featureTag: 'project', sendMode: 'fill', fallbackFor: ['improve-project'] },
  { id: 'folder-workspace', featureTag: 'folder-workspace', sendMode: 'fill', fallbackFor: ['feature-tip'] },
  { id: 'schedule-daily-report', featureTag: 'scheduled-tasks', sendMode: 'fill', fallbackFor: ['automation'] },
  { id: 'long-term-goal', featureTag: 'long-term-goals', sendMode: 'fill', fallbackFor: ['automation', 'learn-question'] },
  { id: 'agent-group-review', featureTag: 'agent-groups', sendMode: 'fill', fallbackFor: ['automation', 'feature-tip'] },
  { id: 'auto-mode-batch-fix', featureTag: 'plan-mode', scene: { authMode: 'auto' }, sendMode: 'fill', fallbackFor: ['improve-project', 'automation'] },
  { id: 'document-workspace', featureTag: 'document-workspace', sendMode: 'fill', fallbackFor: ['feature-tip', 'learn-question'] },
  { id: 'web-research', featureTag: 'web-search', sendMode: 'fill', fallbackFor: ['learn-question', 'new-idea'] },
  { id: 'analyze-project-data', featureTag: 'data-analysis', sendMode: 'fill', fallbackFor: ['data-insight'] },
  { id: 'skills-intro', featureTag: 'skills', sendMode: 'fill', fallbackFor: ['feature-tip'] },
  { id: 'mcp-connect', featureTag: 'mcp', sendMode: 'fill', fallbackFor: ['feature-tip', 'automation'] },
  { id: 'computer-use-screenshot', featureTag: 'computer-use', scene: { computerUse: true }, sendMode: 'fill', fallbackFor: ['feature-tip'] },
  { id: 'image-studio', featureTag: 'image-studio', sendMode: 'fill', fallbackFor: ['new-idea'] },
  { id: 'data-growth-trend', featureTag: 'data-analysis', sendMode: 'fill', fallbackFor: ['data-insight'] }
] as const

/** Weekly themes. The renderer localizes `chatUi.suggestions.themes.<id>`. */
export const WEEKLY_THEMES: ReadonlyArray<{ id: string; itemIds: string[] }> = [
  { id: 'build', itemIds: ['new-web-app', 'plan-first', 'folder-workspace', 'debug-running-api'] },
  { id: 'automation', itemIds: ['schedule-daily-report', 'long-term-goal', 'agent-group-review', 'auto-mode-batch-fix'] },
  { id: 'knowledge', itemIds: ['document-workspace', 'web-research', 'analyze-project-data', 'skills-intro'] },
  { id: 'extend', itemIds: ['mcp-connect', 'computer-use-screenshot', 'image-studio', 'data-growth-trend'] }
]

const STATIC_BY_ID = new Map(STATIC_SUGGESTIONS.map(item => [item.id, item]))

/** ISO-8601 week number, so the theme flips on Monday everywhere. */
export function isoWeekNumber (date: Date): number {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNumber = target.getUTCDay() || 7
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber)
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1))
  return Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
}

export function resolveWeeklyTheme (date: Date = new Date()): { id: string; itemIds: string[] } {
  const index = (isoWeekNumber(date) + date.getFullYear()) % WEEKLY_THEMES.length
  return WEEKLY_THEMES[index]
}

function endOfLocalWeekIso (date: Date): string {
  const end = new Date(date)
  const day = end.getDay() || 7
  end.setDate(end.getDate() + (7 - day))
  end.setHours(23, 59, 59, 999)
  return end.toISOString()
}

export function buildStaticSuggestion (definition: StaticSuggestionDefinition, now: Date, layer: 'explore' | 'daily', type: SuggestionType | 'weekly-theme'): WorkSuggestion {
  const prefix = `chatUi.suggestions.static.${definition.id}`
  return {
    id: layer === 'explore' ? `static:${definition.id}` : `static:${definition.id}:${type}`,
    layer,
    type,
    title: `${prefix}.title`,
    description: `${prefix}.description`,
    prompt: `${prefix}.prompt`,
    scene: definition.scene ? { ...definition.scene } : undefined,
    sendMode: definition.sendMode,
    source: 'static',
    featureTag: definition.featureTag,
    generatedAt: now.toISOString(),
    validUntil: endOfLocalWeekIso(now)
  }
}

/** This week's theme items followed by the remaining pool, so dismissals never empty the list. */
export function buildExploreSuggestions (now: Date = new Date()): { theme: string; items: WorkSuggestion[] } {
  const theme = resolveWeeklyTheme(now)
  const ordered: StaticSuggestionDefinition[] = []
  for (const id of theme.itemIds) {
    const definition = STATIC_BY_ID.get(id)
    if (definition) ordered.push(definition)
  }
  for (const definition of STATIC_SUGGESTIONS) {
    if (!theme.itemIds.includes(definition.id)) ordered.push(definition)
  }
  return {
    theme: theme.id,
    items: ordered.map(definition => buildStaticSuggestion(definition, now, 'explore', 'weekly-theme'))
  }
}

/** Static stand-ins for a suggestion type, used to top up a short LLM batch. */
export function staticFallbacksForType (type: SuggestionType, now: Date, exclude: Set<string>): WorkSuggestion[] {
  return STATIC_SUGGESTIONS
    .filter(definition => definition.fallbackFor.includes(type) && !exclude.has(definition.id))
    .map(definition => buildStaticSuggestion(definition, now, 'daily', type))
}
