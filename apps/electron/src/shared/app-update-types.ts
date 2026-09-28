export type AppUpdateChannel = 'stable' | 'beta'

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'up_to_date'
  | 'unsupported_platform'
  | 'update_available'
  | 'downloading'
  | 'downloaded'
  | 'applying'
  | 'applied'
  | 'installing'
  | 'install_triggered'
  | 'failed'

export type AppUpdateWebsiteKind = 'downloads' | 'updates'

export interface AppUpdateWebsiteLinks {
  baseUrl: string
  downloadsUrl: string
  updatesUrl: string
  configured: boolean
}

export interface AppUpdateConfig {
  websiteBaseUrl: string
  updateApiUrl: string
  downloadsPageUrl: string
  updatesPageUrl: string
}

export interface AppUpdateNotes {
  zh: string[]
  en: string[]
}

export type AppUpdateAssetKind = 'installer' | 'hot_payload'

export interface AppUpdateAssetInfo {
  fileName: string
  downloadUrl: string
  sha512?: string
  sha256?: string
  size: number | null
  kind?: AppUpdateAssetKind
  /** 热更新包专用：Electron 版本必须与运行时严格相等才允许应用。 */
  electronVersion?: string
  minBaseVersion?: string
}

export interface AppUpdateProgress {
  bytesDownloaded: number
  totalBytes: number | null
  percent: number | null
}

export interface AppAboutInfo {
  productName: string
  version: string
  appId: string
  platform: string
  arch: string
  channel: AppUpdateChannel
  website: AppUpdateWebsiteLinks
}

export interface AppUpdateState {
  status: AppUpdateStatus
  currentVersion: string
  latestVersion: string | null
  channel: AppUpdateChannel
  platform: string
  arch: string
  lastCheckedAt: string | null
  publishedAt: string | null
  downloadedFilePath: string | null
  progress: AppUpdateProgress | null
  error: string | null
  notes: AppUpdateNotes | null
  asset: AppUpdateAssetInfo | null
  /** 热更新失败时回退用的完整安装包（/api/app-update/latest 的 asset 字段）。 */
  installerAsset: AppUpdateAssetInfo | null
  website: AppUpdateWebsiteLinks
}