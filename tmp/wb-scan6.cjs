const fs = require('fs')
const path = require('path')
const dir = process.env.HOME + '/Library/Application Support/WorldBase/conversations/'
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
  .slice(0, 15)

for (const { f, t } of files) {
  let j
  try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { continue }
  const msgs = j.messages || []
  const summary = { file: f, at: new Date(t).toISOString(), msgs: msgs.length, failed: 0, suspicious: 0, msgErrors: 0 }
  const suspicious = []
  const msgErrors = []
  msgs.forEach((m, i) => {
    const runs = []
    for (const b of (m.blocks || [])) {
      if (b.kind === 'tool' && b.toolRun) runs.push(b.toolRun)
    }
    const failed = runs.filter(r => r.status === 'failed')
    summary.failed += failed.length
    const msgErrKeys = Object.keys(m).filter(k => /error|stopped|failed/i.test(k) && m[k])
    if (msgErrKeys.length) {
      summary.msgErrors++
      msgErrors.push({ i, keys: msgErrKeys, err: String(m.error || m.errorMessage || '').slice(0, 160) })
    }
    for (const r of failed) {
      const detail = (r.progress || []).map(p => p.detail).filter(Boolean).join('\n')
      const looksSuccess = /"exitCode"\s*:\s*0/.test(detail) || /"success"\s*:\s*true/.test(detail) || /"status"\s*:\s*"completed"/.test(detail)
      const laterSame = runs.slice(runs.indexOf(r) + 1).some(x => x.name === r.name && x.status === 'completed')
      if (looksSuccess || laterSame) {
        summary.suspicious++
        suspicious.push({ i, name: r.name, looksSuccess, laterSame, detail: detail.slice(0, 300) })
      }
    }
  })
  console.log(JSON.stringify(summary))
  for (const s of suspicious.slice(0, 6)) console.log('  SUSP', JSON.stringify(s))
  for (const e of msgErrors.slice(0, 4)) console.log('  MSGERR', JSON.stringify(e))
}
