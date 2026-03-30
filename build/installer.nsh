; Custom NSIS script for The World installer
; Handles killing running instances before install/uninstall to prevent
; file lock errors and corrupted installations.

!macro customInit
  ; Force close any running instances of the application before installation
  nsExec::ExecToStack 'cmd /c taskkill /f /im "The World.exe" 2>nul'
  ; Wait for the process to fully terminate and release file locks
  Sleep 2000
!macroend

!macro customUnInit
  ; Force close any running instances of the application before uninstallation
  nsExec::ExecToStack 'cmd /c taskkill /f /im "The World.exe" 2>nul'
  ; Wait for the process to fully terminate and release file locks
  Sleep 2000
!macroend
