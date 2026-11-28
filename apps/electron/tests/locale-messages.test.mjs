import assert from 'node:assert/strict'
import test from 'node:test'
import { createI18n } from 'vue-i18n'
import './register-ts-hooks.mjs'
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, messages } from '../src/locales/index.ts'
import { getMainLocale, setMainLocaleResolved, t as mainT } from '../src/main/i18n/main-i18n.ts'

// The renderer translates with vue-i18n, whose message syntax gives `@` a
// meaning: it starts a linked message. A bare `@` in a catalog entry fails to
// compile and, in the packaged app, `t()` then throws from inside the render
// function, so the component renders as nothing at all. One such hint made the
// local group settings dialog unopenable. A literal at-sign must be written
// `{'@'}`; the main process undoes that when it reads the same catalog.
const ESCAPED_AT = "{'@'}"

// Every leaf of a catalog, as `[dotted.key, text]`.
function leaves (node, prefix = '') {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return value && typeof value === 'object' ? leaves(value, path) : [[path, value]]
  })
}

// Built the way `src/renderer/i18n.ts` builds the app's own instance.
function translator (locale) {
  return createI18n({ legacy: false, locale, fallbackLocale: DEFAULT_LOCALE, messages }).global.t
}

// Translate one key and return everything vue-i18n reports about it. Under
// node vue-i18n runs its development build, which reports a message it cannot
// compile on console.error; the packaged renderer runs the production build,
// where the same error is thrown out of `t()`. Either one is a failure.
function translate (t, key, params) {
  const reports = []
  const original = console.error
  console.error = (...args) => {
    reports.push(args.map(arg => (arg instanceof Error ? arg.message : String(arg))).join(' '))
  }
  try {
    t(key, params)
  } catch (error) {
    reports.push(`${error.name}: ${error.message}`)
  } finally {
    console.error = original
  }
  return reports
}

test('the compile check does fail a message with a bare at-sign', () => {
  // Guards the guard: should vue-i18n ever stop reporting (or throwing on) a
  // message it cannot compile, the test below would pass without checking.
  const { t } = createI18n({ legacy: false, locale: 'test', messages: { test: { hint: '通过 @ 名称派工。' } } })
  assert.notEqual(translate(t, 'hint').length, 0, 'vue-i18n no longer reports a message it cannot compile; update translate() in this file')
})

test('vue-i18n can compile every message of both locales', () => {
  const broken = []
  for (const locale of SUPPORTED_LOCALES) {
    const t = translator(locale)
    for (const [key, text] of leaves(messages[locale])) {
      const reports = translate(t, key)
      if (typeof text !== 'string') reports.unshift(`not a string (${typeof text})`)
      if (reports.length > 0) broken.push(`${locale} ${key} ${JSON.stringify(text)}\n      ${reports.join('\n      ')}`)
    }
  }
  assert.equal(
    broken.length,
    0,
    `vue-i18n cannot compile these messages; a component that renders one shows nothing (a literal at-sign is written {'@'}):\n      ${broken.join('\n      ')}`
  )
})

test('a literal at-sign renders as an at-sign in the renderer and in the main process', (context) => {
  const previousLocale = getMainLocale()
  context.after(() => setMainLocaleResolved(previousLocale))
  let checked = 0
  for (const locale of SUPPORTED_LOCALES) {
    const t = translator(locale)
    setMainLocaleResolved(locale)
    for (const [key, text] of leaves(messages[locale])) {
      if (typeof text !== 'string' || !text.includes(ESCAPED_AT)) continue
      checked += 1
      // Fill `{name}` placeholders so both paths are read with and without them.
      const fill = (_match, name) => `<${name}>`
      const params = Object.fromEntries([...text.matchAll(/\{(\w+)\}/g)].map(([, name]) => [name, `<${name}>`]))
      const expected = text.replaceAll(ESCAPED_AT, '@').replace(/\{(\w+)\}/g, fill)
      assert.equal(t(key, params), expected, `${locale} ${key} through vue-i18n`)
      assert.equal(mainT(key, params), expected, `${locale} ${key} through the main-process t()`)
    }
  }
  assert.ok(checked > 0, 'no message contains the escape any more; this test checks nothing')
})
