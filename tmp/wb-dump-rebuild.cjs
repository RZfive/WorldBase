const fs = require('fs')
const dir = process.env.HOME + '/Library/Application Support/WorldBase/conversations/'
const f = 'e53d2ffd-c9dd-4dd9-ae90-0249c96a2814.json'
const j = JSON.parse(fs.readFileSync(dir + f, 'utf8'))
j.messages.forEach((m, i) => {
  const runs = (m.blocks || []).filter(b => b.kind === 'tool' && b.toolRun).map(b => b.toolRun)
  console.log('--- message', i, 'runs', runs.length, 'keys', Object.keys(m).join(','))
  runs.forEach((r, n) => {
    let detailHead = ''
    const last = (r.progress || []).slice(-1)[0]
    if (last) {
      const d = String(last.detail || '')
      try {
        const o = JSON.parse(d)
        detailHead = JSON.stringify({ stage: last.stage, buildStatus: o.buildStatus, err: o.error, keys: Object.keys(o).slice(0, 10) })
      } catch { detailHead = JSON.stringify({ stage: last.stage, raw: d.slice(0, 90) }) }
    }
    console.log(String(n).padStart(2), r.name, r.status, 'progress', (r.progress || []).length, 'started', r.startedAt, 'ended', r.endedAt, detailHead)
  })
})
