const fs = require('fs')
const path = require('path')
const dir = process.env.HOME + '/Library/Application Support/WorldBase/conversations/'
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
  .slice(0, 15)

const rows = []
for (const { f } of files) {
  let j
  try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { continue }
  for (const m of (j.messages || [])) {
    for (const b of (m.blocks || [])) {
      if (b.kind !== 'tool' || !b.toolRun) continue
      const r = b.toolRun
      if (r.status !== 'failed') continue
      const detail = (r.progress || []).map(p => p.detail).filter(Boolean).join('\n')
      let p = null
      try { p = JSON.parse(detail) } catch {}
      rows.push({
        name: r.name,
        err: p && typeof p === 'object' ? (p.error === null ? 'NULL' : String(p.error).slice(0, 70)) : null,
        exitCode: p && typeof p === 'object' ? p.exitCode : undefined,
        status: p && typeof p === 'object' ? p.status : undefined,
        success: p && typeof p === 'object' ? p.success : undefined,
        firstLine: !p ? detail.split('\n')[0].slice(0, 90) : null,
        file: f.slice(0, 8)
      })
    }
  }
}

const grouped = {}
for (const r of rows) {
  const k = r.name + ' | ' + (r.err === null ? 'non-json:' + (r.firstLine || '').slice(0, 40) : r.err)
  grouped[k] = grouped[k] || { n: 0, exitCodes: {}, statuses: {}, success: {} }
  const g = grouped[k]
  g.n++
  if (r.exitCode !== undefined) g.exitCodes[r.exitCode] = (g.exitCodes[r.exitCode] || 0) + 1
  if (r.status !== undefined) g.statuses[r.status] = (g.statuses[r.status] || 0) + 1
  if (r.success !== undefined) g.success[r.success] = (g.success[r.success] || 0) + 1
}
for (const [k, v] of Object.entries(grouped).sort((a, b) => b[1].n - a[1].n)) {
  console.log(String(v.n).padStart(3), k, JSON.stringify({ exitCodes: v.exitCodes, statuses: v.statuses, success: v.success }))
}
