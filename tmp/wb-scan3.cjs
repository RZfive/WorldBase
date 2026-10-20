const fs = require('fs')
const dir = process.env.HOME + '/Library/Application Support/WorldBase/conversations/'
const f = process.argv[2]
const j = JSON.parse(fs.readFileSync(dir + f, 'utf8'))
let idx = 0
const failed = []
for (const m of j.messages) {
  for (const b of (m.blocks || [])) {
    idx++
    if (b.kind !== 'tool') continue
    const r = b.toolRun || {}
    if (r.status === 'failed' || r.status === 'error') failed.push({ idx, r })
  }
}
console.log('total failed', failed.length)
console.log('--- FULL first failed toolRun ---')
console.log(JSON.stringify(failed[0].r, null, 2).slice(0, 4000))
console.log('--- summary of all failed ---')
for (const { idx, r } of failed) {
  console.log(idx, r.name || r.toolName || r.tool, '|', String(r.errorMessage || r.error || r.summary || '').replace(/\s+/g, ' ').slice(0, 200))
}
