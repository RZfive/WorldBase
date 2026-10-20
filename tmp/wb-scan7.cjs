const fs = require('fs')
const path = require('path')
const dir = process.env.HOME + '/Library/Application Support/WorldBase/conversations/'
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
  .slice(0, 15)

const byName = {}
let totalFailed = 0
const errorNullExamples = []

for (const { f } of files) {
  let j
  try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { continue }
  for (const m of (j.messages || [])) {
    for (const b of (m.blocks || [])) {
      if (b.kind !== 'tool' || !b.toolRun) continue
      const r = b.toolRun
      if (r.status !== 'failed') continue
      totalFailed++
      byName[r.name] = byName[r.name] || { failed: 0, nullError: 0, hasErrField: 0 }
      byName[r.name].failed++
      const detail = (r.progress || []).map(p => p.detail).filter(Boolean).join('\n')
      let parsed = null
      try { parsed = JSON.parse(detail) } catch {}
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        byName[r.name].hasErrField++
        if (parsed.error === null || parsed.error === undefined || parsed.error === '') {
          byName[r.name].nullError++
          if (errorNullExamples.length < 8) errorNullExamples.push({ file: f, name: r.name, keys: Object.keys(parsed).slice(0, 12), errorVal: parsed.error })
        }
      }
    }
  }
}

console.log('totalFailed', totalFailed)
for (const [k, v] of Object.entries(byName).sort((a, b) => b[1].failed - a[1].failed)) {
  console.log(k.padEnd(28), JSON.stringify(v))
}
console.log('--- null-error examples')
for (const e of errorNullExamples) console.log(JSON.stringify(e))
