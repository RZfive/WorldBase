import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { createRenderer } from 'vue'

// Execute the actual SFC setup/watchers in a Vue renderer with no browser or
// expensive child views. This is intentionally a logic/layout-state test, not
// a screenshot test or a claim about native browser paint timing.
export async function loadSetupComponent (url) {
  const source = await readFile(url, 'utf8')
  const { descriptor } = parse(source, { filename: url.pathname })
  const script = compileScript(descriptor, { id: url.pathname })
  const { outputText } = ts.transpileModule(script.content, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  })
  const code = outputText.replace(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g, (_match, bindings, specifier) => {
    if (specifier.endsWith('.vue')) return `const ${bindings.trim()} = {};`
    const resolved = specifier.startsWith('.')
      ? new URL(existsSync(new URL(specifier, url)) ? specifier : `${specifier}.ts`, url).href
      : import.meta.resolve(specifier)
    return `import ${bindings} from ${JSON.stringify(resolved)};`
  })
  const { default: component } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  return { ...component, render: () => null }
}

function eventHub () {
  const listeners = new Map()
  return {
    addEventListener (type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener (type, listener) { listeners.get(type)?.delete(listener) },
    dispatchEvent (event) { for (const listener of [...(listeners.get(event.type) || [])]) listener(event) },
    listenerCount () { return [...listeners.values()].reduce((count, set) => count + set.size, 0) }
  }
}

export function rendererFixture (t, { idle = true } = {}) {
  const originals = { window: globalThis.window, document: globalThis.document }
  const apps = new Set()
  const idleCallbacks = new Map()
  const frames = new Map()
  let nextId = 0
  const window = {
    ...eventHub(),
    getComputedStyle: () => ({ paddingTop: '0', paddingBottom: '0', paddingLeft: '0', paddingRight: '0' }),
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: id => clearTimeout(id),
    requestAnimationFrame: callback => { frames.set(++nextId, callback); return nextId },
    cancelAnimationFrame: id => frames.delete(id),
    ...(idle ? {
      requestIdleCallback: callback => { idleCallbacks.set(++nextId, callback); return nextId },
      cancelIdleCallback: id => idleCallbacks.delete(id)
    } : {})
  }
  const document = { ...eventHub(), visibilityState: 'visible' }
  Object.assign(globalThis, { window, document })
  const renderer = createRenderer({
    createElement: () => ({}),
    createText: text => ({ text }),
    createComment: text => ({ text }),
    insert: () => {}, remove: () => {}, setText: () => {}, setElementText: () => {},
    parentNode: () => null, nextSibling: () => null, patchProp: () => {}
  })
  t.after(() => {
    for (const app of apps) app.unmount()
    Object.assign(globalThis, originals)
  })
  return {
    window, document, idleCallbacks, frames,
    mount (component, props, plugins = []) {
      const app = renderer.createApp(component, props)
      for (const plugin of plugins) app.use(plugin)
      const vm = app.mount({})
      apps.add(app)
      const unmount = app.unmount.bind(app)
      app.unmount = () => { apps.delete(app); unmount() }
      return { app, state: vm.$.setupState, props: vm.$.props }
    }
  }
}

export async function flush () {
  await new Promise(resolve => setImmediate(resolve))
}
