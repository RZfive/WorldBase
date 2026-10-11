import { registerWorkspaceTab } from './tab-registry'
import { normalizeDocumentFileKey, workspaceStore } from './workspace-store'
import FolderWorkspaceTab from './tabs/FolderWorkspaceTab.vue'
import DocumentFileTab from './tabs/DocumentFileTab.vue'
import BrowserWorkspaceTab from './tabs/BrowserWorkspaceTab.vue'

/**
 * Built-in workspace tab kinds. Folder keeps its conversation binding in the
 * workspace store (singleton by design); documents are one tab per file;
 * browser tabs embed the shared webview and are one tab per URL. New
 * capabilities register the same way — nothing in the panel is hardcoded.
 */

const FOLDER_ICON = `
  <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4l2 2h6A2.5 2.5 0 0 1 20.5 8.5v8A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-10Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
  <path d="m10 12-2 2 2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="m14 12 2 2-2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
`

const DOCUMENT_ICON = `
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="14 2 14 8 20 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
`

const BROWSER_ICON = `
  <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/>
  <path d="M2.5 12h19" fill="none" stroke="currentColor" stroke-width="2"/>
  <path d="M12 2.5c-2.7 2.6-4.2 6-4.2 9.5s1.5 6.9 4.2 9.5c2.7-2.6 4.2-6 4.2-9.5s-1.5-6.9-4.2-9.5Z" fill="none" stroke="currentColor" stroke-width="2"/>
`

function normalizeUrlKey (value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    // Strip trailing slash so `a.com/` and `a.com` land on the same tab.
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`
  } catch {
    return value.trim().replace(/\/+$/, '')
  }
}

let registered = false

/** Idempotent so any entry point (panel mount, store access) can ensure built-ins. */
export function ensureBuiltinWorkspaceTabsRegistered (): void {
  if (registered) return
  registered = true

  registerWorkspaceTab({
    kind: 'folder',
    titleKey: 'chatUi.workspaceTabFolder',
    icon: FOLDER_ICON,
    singleton: true,
    minWidth: 280 + 420 + 12,
    maxWidth: 1320,
    defaultWidth: 980,
    component: FolderWorkspaceTab,
    resolveProps: () => ({
      rootPath: workspaceStore.folderRootPath.value,
      rootName: workspaceStore.folderRootName.value,
      activeFilePath: workspaceStore.folderActiveFilePath.value
    }),
    getActions: () => [
      { id: 'chooseFolder', labelKey: 'chatUi.chooseFolder' },
      { id: 'refreshWorkspace', labelKey: 'chatUi.refresh' },
      { id: 'copyRootPath', labelKey: 'chatUi.workspaceActionCopyPath' }
    ]
  })

  registerWorkspaceTab({
    kind: 'document',
    titleKey: 'chatUi.workspaceTabDocument',
    icon: DOCUMENT_ICON,
    singleton: false,
    minWidth: 420,
    maxWidth: 1280,
    defaultWidth: 900,
    component: DocumentFileTab,
    matches: (tab, payload) => normalizeDocumentFileKey(tab.state?.filePath as string | undefined)
      === normalizeDocumentFileKey(payload?.filePath as string | undefined),
    getActions: () => [
      { id: 'openOriginalFile', labelKey: 'chatUi.openOriginalFile' },
      { id: 'copyFilePath', labelKey: 'chatUi.workspaceActionCopyPath' }
    ]
  })

  registerWorkspaceTab({
    kind: 'browser',
    titleKey: 'chatUi.workspaceTabBrowser',
    icon: BROWSER_ICON,
    singleton: false,
    minWidth: 520,
    maxWidth: 1800,
    defaultWidth: 1100,
    component: BrowserWorkspaceTab,
    matches: (tab, payload) => normalizeUrlKey(tab.state?.url) === normalizeUrlKey(payload?.url),
    getActions: () => [
      { id: 'reload', labelKey: 'chatUi.workspaceActionReload' },
      { id: 'copyUrl', labelKey: 'chatUi.workspaceActionCopyUrl' },
      { id: 'aiOperate', labelKey: 'chatUi.workspaceActionAiOperate' }
    ]
  })
}

ensureBuiltinWorkspaceTabsRegistered()
