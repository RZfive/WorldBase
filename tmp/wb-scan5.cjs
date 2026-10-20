const fs = require('fs')
const dir = process.env.HOME + '/Library/Application Support/WorldBase/conversations/'
const files = ['01464817-e963-45c2-a63f-e5aa81cfe70f.json', '475884e9-f2df-486d-8786-8d4e8957ed44.json', 'affbfe66-29c9-4c91-8e7b-5f77431f3dec.json']
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(dir + f, 'utf8'))
  for (const m of j.messages) {
    for (const b of (m.blocks || [])) {
      if (b.kind !== 'tool') continue
      const r = b.toolRun || {}
      if (r.status !== 'failed') continue
      const d = (r.progress || []).map(p => p.detail).filter(Boolean).join('\n')
      if (!d.trim().startsWith('{')) continue
      console.log('\n=====', f, r.name)
      console.log('progress keys:', Object.keys(r).join(','))
      console.log('detail:', d.slice(0, 1200))
      console.log('block other keys:', Object.keys(b).join(','))
      console.log('block result/preview:', JSON.stringify(b.result).slice(0, 600))
      process.exit ? null : null
      console.log('exitCode in detail:', /"exitCode":(-?\d+)/.exec(d) ? /"exitCode":(-?\d+)/.exec(d)[1] : 'n/a')
      break
    }
  }
}
