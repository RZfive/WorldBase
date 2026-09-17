export type ComputerUsePermissionTarget = 'screen' | 'accessibility'
export type ScreenPermissionStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

export interface ComputerUsePermissionStatus {
  platform: string
  screen: ScreenPermissionStatus
  accessibility: boolean
  granted: boolean
  /** Identify the running application, not another copy with the same name. */
  isPackaged: boolean
  appPath: string
}
