const fs = require('fs')
const dir = process.env.HOME + '/Library/Application Support/WorldBase/conversations/'
const files = process.argv.slice(2)
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(dir + f, 'utf8'))
  console.log('\n==', f, '|', j.title)
  const counts = {}
  const errs = []
  let idx = 0
  for (const m of j.messages) {
    for (const b of (m.blocks || [])) {
      idx++
      if (b.kind !== 'tool') continue
      const r = b.toolRun || {}
      const key = r.status + (r.isError ? '/isError' : '')
      counts[key] = (counts[key] || 0) + 1
      if (r.status === 'error' || r.isError) {
        errs.push({
          idx,
          name: r.name || r.toolName,
          status: r.status,
          isError: r.isError,
          error: String(r.error || r.result || '').slice(0, 220)
        })
      }
    }
  }
  console.log('statuses', JSON.stringify(counts))
  console.log('errors', errs.length)
  for (const e of errs.slice(0, 40)) console.log(JSON.stringify(e))
}
