const ELECTRON_STUB_URL = 'data:text/javascript,' + encodeURIComponent([
  'export const app = { getLocale: () => "en-US", getPath: () => "/tmp" }',
  'export const dialog = {}',
  'export const BrowserWindow = class {}',
  'export const ipcMain = { handle: () => {} }',
  'export default null'
].join('\n'))

export async function resolve (specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: ELECTRON_STUB_URL, shortCircuit: true }
  }

  if (specifier.startsWith('.')) {
    try {
      return await nextResolve(specifier, context)
    } catch (error) {
      const candidates = specifier.endsWith('.js')
        ? [specifier.slice(0, -'.js'.length) + '.ts']
        : [`${specifier}.ts`, `${specifier}.js`]
      for (const candidate of candidates) {
        try {
          return await nextResolve(candidate, context)
        } catch {
          // try the next candidate
        }
      }
      throw error
    }
  }

  return nextResolve(specifier, context)
}
