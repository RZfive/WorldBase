const { execFile } = require('node:child_process')
const path = require('node:path')
const { promisify } = require('node:util')

// electron-builder afterSign hook: inspect the final app rather than inferring
// its identity from appId or the presence of Info.plist usage descriptions.
module.exports = async function checkMacPermissionSigning (context, {
  run = promisify(execFile),
  warn = console.warn
} = {}) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  let details
  try {
    const result = await run('/usr/bin/codesign', ['-d', '--verbose=4', '-r-', appPath])
    details = `${result.stdout || ''}\n${result.stderr || ''}`
  } catch (error) {
    if (context.packager.forceCodeSigning) throw error
    warn(`[macOS permissions] Could not inspect the signature of ${appPath}: ${error.message}`)
    return
  }
  if (/^TeamIdentifier=(?!not set\s*$)\S+$/m.test(details) && !/^Signature=adhoc$/m.test(details)) return

  const message = `[macOS permissions] ${appPath} has no team-backed signing identity. ` +
    'Ad-hoc builds can invalidate Screen Recording/Accessibility grants when replaced; ' +
    'development Electron grants do not authorize the installed app. ' +
    'After installing in /Applications, remove stale WorldBase entries from both System Settings permission lists, ' +
    'add the installed app again, then fully quit (Cmd+Q) and reopen it. ' +
    'For releases, configure a Developer ID Application certificate and use electron:build:mac:arm64:signed.'
  if (context.packager.forceCodeSigning) throw new Error(message)
  warn(message)
}
