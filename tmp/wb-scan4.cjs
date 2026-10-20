const fs = require('fs')
const dir = process.env.HOME + '/Library/Application Support/WorldBase/conversations/'
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
const out = []
for (const f of files) {
  let j
  try { j = JSON.parse(fs.readFileSync(dir + f, 'utf8')) } catch { continue }
  const failed = []
  for (const m of j.messages || []) {
    for (const b of (m.blocks || [])) {
      if (b.kind !== 'tool') continue
      const r = b.toolRun || {}
      if (r.status !== 'failed' && r.status !== 'error') continue
      const detail = (r.progress || []).map(p => p.detail).filter(Boolean).join(' | ')
      failed.push({ name: r.name, detail: String(detail).replace(/\s+/g, ' ').slice(0, 160) })
    }
  }
  if (failed.length) out.push({ f, title: j.title, updatedAt: j.updatedAt, n: failed.length, failed })
}
out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
for (const o of out.slice(0, 8)) {
  console.log('\n===', o.f, '|', o.title, '| failed', o.n, '|', new Date(o.updatedAt).toISOString())
  const seen = new Map()
  for (const e of o.failed) seen.set(e.name + ' :: ' + e.detail, (seen.get(e.name + ' :: ' + e.detail) || 0) + 1)
  for (const [k, v] of seen) console.log('  x' + v, k)
}
