import type { Component } from 'vue'

/** A live tab instance rendered inside the right-side workspace panel. */
export interface WorkspaceTabInstance {
  id: string
  kind: string
  /** Kind-specific state carried by generic (non singleton) tab kinds. */
  state?: Record<string, unknown>
  /** Title override shown in the tab strip; falls back to the kind title. */
  title?: string
}

/**
 * Describes one openable workspace capability. The workspace panel is
 * intentionally agnostic about what a tab contains: new abilities (code
 * browser, document viewer, embedded browser, search surface, ...) plug in
 * by registering a definition here, and AI-side openers only need the kind.
 */
export interface WorkspaceTabDefinition {
  kind: string
  /** i18n key resolved for the tab strip label and the add-tab menu. */
  titleKey: string
  /** Inline SVG inner markup (viewBox 0 0 24 24) for the tab icon. */
  icon: string
  /** true → at most one tab of this kind may exist at a time. */
  singleton: boolean
  minWidth: number
  maxWidth: number
  defaultWidth: number
  component: Component
  /**
   * Resolves the reactive prop bag bound to the tab body component. Reading
   * refs/computeds inside keeps the returned object reactive.
   */
  resolveProps?: (tab: WorkspaceTabInstance) => Record<string, unknown>
  /**
   * Identity check for multi-instance kinds: returns true when an existing
   * tab already represents this payload (document by file path, browser by
   * URL). Singleton kinds ignore this and dedupe by kind alone.
   */
  matches?: (tab: WorkspaceTabInstance, payload?: Record<string, unknown>) => boolean
  /**
   * Actions shown in the tab strip's page-actions menu for this kind. Each
   * id maps to a `defineExpose`ed method on the tab body component.
   */
  getActions?: (tab: WorkspaceTabInstance) => Array<{ id: string; labelKey: string }>
}

const definitions = new Map<string, WorkspaceTabDefinition>()
let instanceCounter = 0

export function registerWorkspaceTab (definition: WorkspaceTabDefinition): void {
  definitions.set(definition.kind, definition)
}

export function getWorkspaceTabDefinition (kind: string): WorkspaceTabDefinition | null {
  return definitions.get(kind) || null
}

export function listWorkspaceTabDefinitions (): WorkspaceTabDefinition[] {
  return Array.from(definitions.values())
}

export function createWorkspaceTabId (kind: string): string {
  instanceCounter += 1
  return `${kind}-${Date.now().toString(36)}-${instanceCounter}`
}
