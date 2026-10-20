const fs = require('fs')
const dir = process.env.HOME + '/Library/Application Support/WorldBase/conversations/'
const files = process.argv.slice(2)
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(dir + f, 'utf8'))
  console.log('==', f, '|', j.title)
  const kinds = {}
  for (const m of j.messages) for (const b of (m.blocks || [])) kinds[b.kind] = (kinds[b.kind] || 0) + 1
  console.log('msgs', j.messages.length, JSON.stringify(kinds))
  for (const m of j.messages) {
    for (const b of (m.blocks || [])) {
      if (b.kind === 'tool_call' || b.kind === 'tool' || b.kind === 'tool_use' || b.kind === 'tool_result') {
        console.log(' sample tool block keys:', Object.keys(b).join(','))
        break
      }
    }
  }
}
